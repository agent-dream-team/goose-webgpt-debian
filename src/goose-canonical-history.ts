import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import {
  gooseResponsesProjectionCheckpoint,
  type GooseResponsesProjectionCheckpoint,
} from "./goose-responses-projection";

const HASH = /^[a-f0-9]{64}$/;

export interface GooseCanonicalHistoryWatermark {
  version: 1;
  nonInputHash: string;
  representedInputHash: string;
  representedInputItemHashes: string[];
  finalAssistantTextHash: string;
}

export type GooseCanonicalHistoryDecision =
  | { kind: "SEED"; items: unknown[] }
  | { kind: "APPEND"; items: unknown[] }
  | { kind: "ROLLOVER"; reason: string; items: unknown[] };

export interface GoosePersistentPromptContext {
  turnRef: string;
  submitNonce: string;
  opRef: string;
  mode: "seed" | "append";
  connectorIdentity: string;
  availableToolNames: readonly string[];
  items: unknown[];
  resolveDurableToolResult(opRef: string): string;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requestInput(body: unknown): unknown[] {
  const request = record(body, "Responses request");
  if (!Array.isArray(request.input)) throw new Error("Responses request input must be an array");
  return request.input;
}

function messageText(item: unknown, role: string): string {
  const message = record(item, `${role} message`);
  if (message.type !== "message" || message.role !== role || !Array.isArray(message.content)) {
    throw new Error(`Canonical ${role} history item has an unsupported shape`);
  }
  const expectedContentType = role === "assistant" ? "output_text" : "input_text";
  const parts = message.content.map(part => {
    const content = record(part, `${role} message content`);
    if (content.type !== expectedContentType || typeof content.text !== "string") {
      throw new Error(`Canonical ${role} history item contains unsupported non-text content`);
    }
    return content.text;
  });
  return parts.join("");
}

function isSingleUserMessage(items: readonly unknown[]): boolean {
  if (items.length !== 1) return false;
  try {
    messageText(items[0], "user");
    return true;
  } catch {
    return false;
  }
}

export function encodeGooseCanonicalHistoryWatermark(input: {
  checkpoint: GooseResponsesProjectionCheckpoint;
  finalAssistantText: string;
}): string {
  if (!input.finalAssistantText) throw new Error("Canonical history watermark requires non-empty provider final text");
  return canonicalJson({
    gooseCanonicalHistory: {
      version: 1,
      nonInputHash: input.checkpoint.nonInputHash,
      representedInputHash: input.checkpoint.inputHash,
      representedInputItemHashes: input.checkpoint.inputItemHashes,
      finalAssistantTextHash: hashText(input.finalAssistantText),
    },
  });
}

export function decodeGooseCanonicalHistoryWatermark(value: string): GooseCanonicalHistoryWatermark {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Canonical history watermark is invalid JSON"); }
  const root = record(parsed, "Canonical history watermark envelope");
  const watermark = record(root.gooseCanonicalHistory, "Canonical history watermark");
  if (watermark.version !== 1
    || typeof watermark.nonInputHash !== "string" || !HASH.test(watermark.nonInputHash)
    || typeof watermark.representedInputHash !== "string" || !HASH.test(watermark.representedInputHash)
    || !Array.isArray(watermark.representedInputItemHashes)
    || watermark.representedInputItemHashes.some(hash => typeof hash !== "string" || !HASH.test(hash))
    || typeof watermark.finalAssistantTextHash !== "string" || !HASH.test(watermark.finalAssistantTextHash)) {
    throw new Error("Canonical history watermark has invalid fields");
  }
  return watermark as unknown as GooseCanonicalHistoryWatermark;
}

export function classifyGooseCanonicalHistory(body: unknown, historyWatermark: string | null): GooseCanonicalHistoryDecision {
  const items = requestInput(body);
  if (!historyWatermark) return { kind: "SEED", items };

  let watermark: GooseCanonicalHistoryWatermark;
  try { watermark = decodeGooseCanonicalHistoryWatermark(historyWatermark); }
  catch { return { kind: "ROLLOVER", reason: "history_watermark_invalid", items }; }
  const checkpoint = gooseResponsesProjectionCheckpoint(body);
  if (checkpoint.nonInputHash !== watermark.nonInputHash) {
    return { kind: "ROLLOVER", reason: "non_input_projection_changed", items };
  }
  const prefixLength = watermark.representedInputItemHashes.length;
  if (checkpoint.inputItemHashes.length <= prefixLength) {
    return { kind: "ROLLOVER", reason: "canonical_history_not_extended", items };
  }
  if (watermark.representedInputItemHashes.some((hash, index) => checkpoint.inputItemHashes[index] !== hash)) {
    return { kind: "ROLLOVER", reason: "canonical_history_prefix_changed", items };
  }

  const priorAssistant = items[prefixLength];
  let assistantText: string;
  try { assistantText = messageText(priorAssistant, "assistant"); }
  catch { return { kind: "ROLLOVER", reason: "prior_provider_answer_missing", items }; }
  if (hashText(assistantText) !== watermark.finalAssistantTextHash) {
    return { kind: "ROLLOVER", reason: "prior_provider_answer_changed", items };
  }

  const suffix = items.slice(prefixLength + 1);
  if (!isSingleUserMessage(suffix)) {
    return { kind: "ROLLOVER", reason: "new_turn_suffix_not_single_user_message", items };
  }
  return { kind: "APPEND", items: suffix };
}

function historyPromptItem(item: unknown, resolveDurableToolResult: (opRef: string) => string): unknown {
  const entry = record(item, "Canonical history item");
  if (entry.type === "message") {
    if (entry.role !== "system" && entry.role !== "user" && entry.role !== "assistant") {
      throw new Error("Canonical history contains an unsupported message role");
    }
    // Validate that only plain text will be made durable by this initial renderer.
    messageText(entry, entry.role);
    return entry;
  }
  if (entry.type === "function_call") {
    if (typeof entry.call_id !== "string" || !entry.call_id
      || typeof entry.name !== "string" || !entry.name
      || typeof entry.arguments !== "string") {
      throw new Error("Canonical history contains an invalid function_call");
    }
    return entry;
  }
  if (entry.type === "function_call_output") {
    if (typeof entry.call_id !== "string" || !entry.call_id) {
      throw new Error("Canonical history contains an invalid function_call_output");
    }
    // Never replay raw Goose tool output into persistent ChatGPT history. Resolve only the
    // already-authorized/redacted connector-journal representation for this exact op_ref.
    return {
      type: "function_call_output",
      call_id: entry.call_id,
      output: resolveDurableToolResult(entry.call_id),
    };
  }
  throw new Error("Canonical history contains an unsupported input item type");
}

export function renderGoosePersistentPrompt(input: GoosePersistentPromptContext): string {
  if (!input.turnRef || !input.submitNonce || !input.opRef) {
    throw new Error("Persistent Goose prompt requires turn, submit and operation correlation identities");
  }
  if (input.items.length === 0) throw new Error("Persistent Goose prompt cannot be empty");
  const canonicalInput = input.items.map(item => historyPromptItem(item, input.resolveDurableToolResult));
  const connectorIdentity = input.connectorIdentity.trim();
  if (!connectorIdentity) throw new Error("Persistent Goose prompt requires a connector identity");
  const availableToolNames = [...input.availableToolNames];
  if (availableToolNames.some(name => typeof name !== "string" || !name)) {
    throw new Error("Persistent Goose prompt contains an invalid advertised tool name");
  }
  if (new Set(availableToolNames).size !== availableToolNames.length) {
    throw new Error("Persistent Goose prompt contains duplicate advertised tool names");
  }
  const envelope = canonicalJson({
    protocol: "goose-persistent-provider-v1",
    mode: input.mode,
    turn_ref: input.turnRef,
    submit_nonce: input.submitNonce,
    op_ref: input.opRef,
    connector_identity: connectorIdentity,
    available_tool_names: availableToolNames,
    canonical_input: canonicalInput,
  });
  return [
    "GOOSE PERSISTENT PROVIDER TURN v1",
    "Treat canonical_input as the authoritative Goose model-visible context for this provider turn.",
    "Use the exact turn_ref and current op_ref for any Goose connector call; never invent either value.",
    "When Goose connector access is needed, use the connected app named exactly by connector_identity.",
    "For goose_tool, use a tool_name exactly as listed in available_tool_names; never guess another Goose tool name.",
    "Answer the unresolved user instruction represented by canonical_input. Do not restate the envelope.",
    envelope,
  ].join("\n");
}
