import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import { stripVolatileTurnContextParts } from "./environment";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BROWSER_ATTEMPTS = 2;
const CANCEL_MARKER = "ChatGPT web turn aborted";
const RETRY_CIRCUIT_CODE = "chatgpt_retry_circuit_open";
const RETRY_CIRCUIT_MESSAGE = "ChatGPT Web retry circuit is open for this failed standalone Goose turn; no new browser tab was opened. Stop the currently generating Goose turn and start a new user turn before retrying.";

type CircuitState = "active" | "retryable-failed" | "open";

interface RetryCircuitEntry {
  id: string;
  scope: string;
  exactKeys: Set<string>;
  attempts: number;
  state: CircuitState;
  lastSnapshot: unknown[];
  failureMarkers: string[];
  lastTouchedAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stripStandaloneServerIdentity(item: Record<string, unknown>): Record<string, unknown> {
  const metadata = record(item.internal_chat_message_metadata_passthrough);
  const turnId = typeof metadata?.turn_id === "string" ? metadata.turn_id : undefined;
  if (!turnId?.startsWith("standalone_")) return item;
  const identity = turnId.slice("standalone_".length);
  const copy = { ...item };
  delete copy.internal_chat_message_metadata_passthrough;
  if (copy.id === `msg_${identity}`) delete copy.id;
  return copy;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = record(value);
  if (!obj) return value;
  return Object.fromEntries(Object.keys(obj).sort().map(key => [key, canonicalize(obj[key])]));
}

function normalizeInputItem(value: unknown): unknown {
  const raw = record(value);
  if (!raw) return canonicalize(value);
  const item = stripStandaloneServerIdentity(raw);
  const normalized = item.type === "message" || item.type === undefined
    ? { ...item, type: "message", content: stripVolatileTurnContextParts(item.content) }
    : item;
  return canonicalize(normalized);
}

function itemFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function isStructuralPrefix(prefix: unknown[], candidate: unknown[]): boolean {
  if (candidate.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (itemFingerprint(prefix[index]) !== itemFingerprint(candidate[index])) return false;
  }
  return true;
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some(item => containsString(item, needle));
  const obj = record(value);
  return obj ? Object.values(obj).some(item => containsString(item, needle)) : false;
}

function descendantCarriesFailure(entry: RetryCircuitEntry, snapshot: unknown[]): boolean {
  if (entry.failureMarkers.length === 0 || !isStructuralPrefix(entry.lastSnapshot, snapshot)) return false;
  const suffix = snapshot.slice(entry.lastSnapshot.length);
  // A changed standalone execution key implies a new latest user message. Treat it as failure
  // lineage only when that newest appended user message itself carries the exact bridge failure.
  // A real user can therefore stop the runaway turn and send a fresh instruction even if older
  // failed-response history remains in the canonical conversation.
  for (let index = suffix.length - 1; index >= 0; index -= 1) {
    const item = record(suffix[index]);
    if (item?.role !== "user") continue;
    return entry.failureMarkers.some(marker => containsString(item, marker));
  }
  return false;
}

function retryCircuitError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    RETRY_CIRCUIT_MESSAGE,
    {
      status: 409,
      errorType: "invalid_request_error",
      code: RETRY_CIRCUIT_CODE,
      retryable: false,
    },
  );
}

function rememberFailureMarker(entry: RetryCircuitEntry, marker: string | undefined): void {
  if (marker && !entry.failureMarkers.includes(marker)) entry.failureMarkers.push(marker);
}

function rememberCircuitFailure(entry: RetryCircuitEntry): void {
  rememberFailureMarker(entry, RETRY_CIRCUIT_MESSAGE);
  rememberFailureMarker(entry, RETRY_CIRCUIT_CODE);
}

/**
 * Canonical standalone Goose input used only for retry-lineage containment.
 *
 * It deliberately strips the bridge-owned synthetic standalone identity and Goose's volatile
 * `<turn-context>` wrapper. Everything else remains structural, so a genuinely new user message
 * does not become a retry descendant merely because it follows the same conversation history.
 */
export function standaloneRetrySnapshot(parsed: CodexParsedRequest): unknown[] {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.map(normalizeInputItem);
}

/**
 * Bounded browser-start circuit for standalone Goose.
 *
 * Exact retries share the initial execution key. A changed request joins that same failure lineage
 * only when it structurally extends the last failed input and the appended suffix carries the exact
 * bridge error emitted by that failure. This narrowly contains Goose-style failure-history
 * resubmission without guessing which arbitrary user text is "really" a retry.
 */
export class StandaloneRetryCircuit {
  private readonly entries = new Map<string, RetryCircuitEntry>();
  private readonly exactToEntry = new Map<string, string>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxBrowserAttempts = DEFAULT_MAX_BROWSER_ATTEMPTS,
    private readonly now: () => number = Date.now,
  ) {}

  reserve(scope: string, exactKey: string, snapshot: unknown[]): void {
    this.prune();
    const now = this.now();
    let entry = this.entryForExact(exactKey);
    if (!entry) {
      entry = this.findFailureAncestor(scope, snapshot);
      if (entry) {
        entry.exactKeys.add(exactKey);
        this.exactToEntry.set(exactKey, entry.id);
      }
    }

    if (entry) {
      entry.lastTouchedAt = now;
      if (entry.state === "open") {
        rememberCircuitFailure(entry);
        throw retryCircuitError();
      }
      // A different descendant cannot consume the one bounded recovery slot while that slot is
      // already active. Exact duplicate HTTP requests never reach this callback because the turn
      // session registry coalesces them first.
      if (entry.state === "active") {
        rememberCircuitFailure(entry);
        throw retryCircuitError();
      }
      if (entry.attempts >= this.maxBrowserAttempts) {
        entry.state = "open";
        rememberCircuitFailure(entry);
        throw retryCircuitError();
      }
      entry.attempts += 1;
      entry.state = "active";
      return;
    }

    if (this.entries.size >= this.maxEntries) {
      throw new ChatGptWebAdapterError(
        "ChatGPT Web standalone retry registry is full; refusing to open another browser tab.",
        { status: 503, errorType: "server_error", code: "chatgpt_retry_registry_full", retryable: false },
      );
    }
    const id = createHash("sha256").update(`${scope}\0${exactKey}`).digest("hex");
    const created: RetryCircuitEntry = {
      id,
      scope,
      exactKeys: new Set([exactKey]),
      attempts: 1,
      state: "active",
      lastSnapshot: snapshot,
      failureMarkers: [],
      lastTouchedAt: now,
    };
    this.entries.set(id, created);
    this.exactToEntry.set(exactKey, id);
  }

  noteFailure(exactKey: string, snapshot: unknown[], error: unknown): void {
    const entry = this.entryForExact(exactKey);
    if (!entry) return;
    entry.lastTouchedAt = this.now();
    entry.lastSnapshot = snapshot;
    const message = error instanceof Error ? error.message : String(error);
    rememberFailureMarker(entry, message);
    if (error instanceof ChatGptWebAdapterError) rememberFailureMarker(entry, error.code);

    // Terminal entries are monotonic. In particular, cancelOutstanding() opens every retained
    // lineage before aborting its browser session; a failure callback from that already-reserved
    // browser attempt may arrive afterward. Keep its failure markers for descendant containment,
    // but never let that stale callback restore retry capacity.
    if (entry.state === "open") return;

    const retryable = error instanceof ChatGptWebAdapterError && error.retryable;
    const rateLimited = error instanceof ChatGptWebAdapterError && error.status === 429;
    entry.state = retryable && !rateLimited && entry.attempts < this.maxBrowserAttempts
      ? "retryable-failed"
      : "open";
  }

  noteSuccess(exactKey: string): void {
    const entry = this.entryForExact(exactKey);
    if (!entry) return;
    // A success callback can race cancellation after its browser attempt was already reserved.
    // Once cancellation has made the lineage terminal, that stale success must not delete it.
    if (entry.state === "open") return;
    this.deleteEntry(entry);
  }

  /** Mark every retained standalone failure lineage terminal before browser sessions are aborted. */
  cancelOutstanding(): number {
    this.prune();
    let opened = 0;
    for (const entry of this.entries.values()) {
      if (entry.state !== "open") opened += 1;
      entry.state = "open";
      rememberFailureMarker(entry, CANCEL_MARKER);
      rememberCircuitFailure(entry);
      entry.lastTouchedAt = this.now();
    }
    return opened;
  }

  clear(): void {
    this.entries.clear();
    this.exactToEntry.clear();
  }

  private entryForExact(exactKey: string): RetryCircuitEntry | undefined {
    const id = this.exactToEntry.get(exactKey);
    if (!id) return undefined;
    const entry = this.entries.get(id);
    if (!entry) this.exactToEntry.delete(exactKey);
    return entry;
  }

  private findFailureAncestor(scope: string, snapshot: unknown[]): RetryCircuitEntry | undefined {
    let match: RetryCircuitEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.scope !== scope || !descendantCarriesFailure(entry, snapshot)) continue;
      if (!match || entry.lastSnapshot.length > match.lastSnapshot.length) match = entry;
    }
    return match;
  }

  private deleteEntry(entry: RetryCircuitEntry): void {
    this.entries.delete(entry.id);
    for (const key of entry.exactKeys) {
      if (this.exactToEntry.get(key) === entry.id) this.exactToEntry.delete(key);
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const entry of this.entries.values()) {
      if (entry.state === "active" || entry.lastTouchedAt >= cutoff) continue;
      this.deleteEntry(entry);
    }
  }
}

export const standaloneRetryCircuit = new StandaloneRetryCircuit();
