import { createChatGptWebAdapter } from "./adapters/chatgpt-web";
import { closeChatGptBrowserWorkers } from "./adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers, TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { timingSafeEqual } from "node:crypto";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import { standaloneRetryCircuit } from "./adapters/chatgpt-web/retry-circuit";
import { stripVolatileTurnContextParts } from "./adapters/chatgpt-web/environment";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { providerConfig } from "./config";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import { httpStatusFromTerminalError } from "./lib/errors";
import { createHash } from "node:crypto";
import { augmentNativeModelCatalog } from "./model-catalog";
import { readCodexModelContextOverride, type CodexModelContextOverride } from "./codex-integration";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import { forwardNativeCodexRequest, type NativeFetch } from "./native-passthrough";
import {
  buildCompactV1Output,
  COMPACT_PROMPT,
  decodeCompactionSummary,
  extractCompactUserMessages,
} from "./responses/compaction";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "./types";
import type { CodexProviderConfig } from "./types";
import type { ProviderAdapter } from "./adapters/base";
import { VERSION } from "./version";

export class HttpTurnCounter {
  private active = 0;

  count(): number {
    return this.active;
  }

  async track(
    run: () => Promise<Response>,
    signal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
  ): Promise<Response> {
    this.active += 1;
    let released = false;
    let abortListener: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };

    try {
      const response = await run();
      if (!response.body) {
        release();
        return response;
      }
      if (signal?.aborted) {
        void response.body.cancel(signal.reason).catch(() => {});
        release();
        return response;
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. On Darwin/Linux, preserve the direct
        // pull chain: it keeps HTTP backpressure native and lets a client body cancellation reach
        // the original SSE reader without an eagerly drained tee branch racing the socket writer.
        const reader = response.body.getReader();
        abortListener = () => {
          void reader.cancel(signal?.reason).catch(() => {}).finally(release);
        };
        signal?.addEventListener("abort", abortListener, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
            } catch (error) {
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // OpenCodex's Windows-safe Bun#32111 shape: the client gets a native tee branch,
      // never a JS ReadableStream with async pull(). The second branch is consumed only
      // to observe completion. The request signal releases lifecycle ownership immediately
      // when the client disconnects and cancels the observer branch.
      const [clientBody, lifecycleBody] = response.body.tee();
      const reader = lifecycleBody.getReader();
      abortListener = () => {
        void reader.cancel(signal?.reason).catch(() => {});
        void clientBody.cancel(signal?.reason).catch(() => {});
        release();
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      void (async () => {
        try {
          while (!(await reader.read()).done) {
            // Consume eagerly so the lifecycle branch never backpressures the client branch.
          }
        } catch {
          // Stream failure is delivered to the client branch; lifecycle cleanup stays best-effort.
        } finally {
          release();
        }
      })();
      return new Response(clientBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

type ChatGptWebAdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export function routeChatGptWebRequest(parsed: CodexParsedRequest, config: AppConfig): ChatGptWebModelRoute {
  const route = requireChatGptWebModelRoute(parsed.modelId, config.proAvailable);
  parsed.modelId = CHATGPT_WEB_BACKEND_MODEL;
  parsed.options.reasoning = route.adapterEffort;
  return route;
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) return upstream;
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  const body = JSON.stringify(catalog);
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function nativeSearchRequest(
  req: Request,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  try {
    return await forwardNativeCodexRequest(req, "alpha/search", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function standaloneTextContent(value: unknown): boolean {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.every(part => {
    const block = plainObject(part);
    return (block?.type === "input_text" || block?.type === "text") && typeof block.text === "string";
  });
}

/** Same text-only shape as standaloneTextContent, but for an assistant reply's output blocks. */
function standaloneAssistantTextContent(value: unknown): boolean {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.every(part => {
    const block = plainObject(part);
    return (block?.type === "output_text" || block?.type === "text") && typeof block.text === "string";
  });
}

/**
 * Give an isolated standalone text request the replay identity required by the browser adapter.
 * Native Codex requests, continuations, and every tool-bearing/non-text shape remain untouched.
 *
 * Goose resends the complete conversation on every turn (no previous_response_id, no thread/turn
 * metadata of its own), so a second or later turn arrives with plain-text `assistant` history
 * already interleaved with the `system`/`user` items a first turn has. That shape is accepted here
 * too — text-only, no tool calls, no reasoning items — so ordinary multi-turn conversations keep
 * getting a replay identity instead of silently falling through to the native-Codex path (which
 * requires Codex's own turn/thread metadata and fails closed for a plain Goose request).
 *
 * Identity defaults to a deterministic digest of the input prefix ending at the latest user
 * message, not a fresh random value. Because Goose resends full history, a byte-identical retry of
 * the same logical turn — or a duplicate HTTP POST from a client-side retry — collapses onto the
 * same execution key instead of opening a second browser tab for work that is already in flight or
 * already answered. A genuinely new user message changes the prefix and therefore always gets a
 * fresh identity, i.e. a fresh browser turn.
 */
/**
 * Tag the input item at `latestUserIndex` with deterministic synthetic thread/turn identity so the
 * adapter's execution-key derivation (which requires native-Codex-shaped turn_id metadata) accepts
 * a standalone request. Identity defaults to a digest of the input prefix ending at that item, not a
 * fresh random value: a byte-identical retry — or, for a tool-bearing round, the follow-up request
 * carrying the tool result — collapses onto the same execution key instead of opening a second
 * browser tab for work that is already in flight or already answered.
 */
/**
 * The prefix used for standalone-identity hashing, with the latest user message's content
 * normalized to strip a volatile re-stamped `<turn-context>` block. Without this, a same-turn tool
 * round trip that crosses a wall-clock tick (Goose re-stamps live current-time into the resent user
 * message on every provider round) would hash differently and spuriously open a second browser tab.
 */
function standaloneIdentityPrefix(input: unknown[], latestUserIndex: number): unknown[] {
  return input.slice(0, latestUserIndex + 1).map((item, index) => {
    if (index !== latestUserIndex) return item;
    const obj = plainObject(item);
    if (!obj) return item;
    return { ...obj, content: stripVolatileTurnContextParts(obj.content) };
  });
}

function tagStandaloneIdentity(
  body: Record<string, unknown>,
  input: unknown[],
  latestUserIndex: number,
  identity: string | undefined,
): unknown {
  const resolvedIdentity = identity ?? createHash("sha256")
    .update(JSON.stringify(standaloneIdentityPrefix(input, latestUserIndex)))
    .digest("hex")
    .slice(0, 32);
  const turnId = `standalone_${resolvedIdentity}`;
  const taggedInput = input.map((item, index) => index === latestUserIndex ? {
    ...plainObject(item),
    type: "message",
    id: `msg_${resolvedIdentity}`,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  } : item);
  return {
    ...body,
    input: taggedInput,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: turnId,
        turn_id: turnId,
      }),
    },
  };
}

export function prepareStandaloneTextRequest(
  raw: unknown,
  config: AppConfig,
  identity?: string,
): unknown {
  if (!config.standalone || config.mode !== "browser-only") return raw;
  const body = plainObject(raw);
  if (!body || body.client_metadata !== undefined || body.previous_response_id !== undefined) return raw;
  if (Array.isArray(body.tools) ? body.tools.length > 0 : body.tools !== undefined) return raw;
  if (body.tool_choice !== undefined && body.tool_choice !== "none") return raw;
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false) return raw;

  const input = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : Array.isArray(body.input) ? body.input : undefined;
  if (!input) return raw;

  let latestUserIndex = -1;
  for (let index = 0; index < input.length; index += 1) {
    const item = plainObject(input[index]);
    const type = item?.type ?? "message";
    if (!item || type !== "message") return raw;
    if (item.role === "assistant") {
      if (!standaloneAssistantTextContent(item.content)) return raw;
      continue;
    }
    if ((item.role !== "system" && item.role !== "developer" && item.role !== "user")
      || !standaloneTextContent(item.content)) return raw;
    if (item.role === "user") latestUserIndex = index;
  }
  if (latestUserIndex < 0) return raw;
  return tagStandaloneIdentity(body, input, latestUserIndex, identity);
}

function standaloneAllowedToolItem(item: Record<string, unknown>): boolean {
  if (item.type === "function_call") return typeof item.call_id === "string" && typeof item.name === "string";
  if (item.type === "function_call_output") return typeof item.call_id === "string";
  return false;
}

/**
 * Same deterministic replay identity as {@link prepareStandaloneTextRequest}, but for a standalone
 * Goose round that advertises tools and may carry a `function_call`/`function_call_output` pair.
 * Goose resends its full canonical conversation on every provider round and only ever appends
 * function_call/function_call_output items after the latest real user message — it never edits or
 * removes that message — so hashing the input prefix ending at that message gives the tool-request
 * round and its later tool-result round the identical identity, letting them resolve to the same
 * `ChatGptTurnSession` through the existing, unmodified session registry. A genuinely new user
 * message always shifts that prefix and therefore always gets a fresh identity.
 */
export function prepareStandaloneToolRequest(
  raw: unknown,
  config: AppConfig,
  identity?: string,
): unknown {
  if (!config.standalone || config.mode !== "full") return raw;
  const body = plainObject(raw);
  if (!body || body.client_metadata !== undefined || body.previous_response_id !== undefined) return raw;

  const input = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : Array.isArray(body.input) ? body.input : undefined;
  if (!input) return raw;

  let latestUserIndex = -1;
  for (let index = 0; index < input.length; index += 1) {
    const item = plainObject(input[index]);
    if (!item) return raw;
    const type = item.type ?? "message";
    if (type !== "message") {
      if (!standaloneAllowedToolItem(item)) return raw;
      continue;
    }
    if (item.role === "assistant") {
      if (!standaloneAssistantTextContent(item.content)) return raw;
      continue;
    }
    if ((item.role !== "system" && item.role !== "developer" && item.role !== "user")
      || !standaloneTextContent(item.content)) return raw;
    if (item.role === "user") latestUserIndex = index;
  }
  if (latestUserIndex < 0) return raw;
  return tagStandaloneIdentity(body, input, latestUserIndex, identity);
}

export async function responseRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { previous_response_id?: unknown }).previous_response_id
    : undefined;
  const standalonePrepared = prepareStandaloneToolRequest(prepareStandaloneTextRequest(raw, config), config);
  const expanded = expandPreviousResponseInput(standalonePrepared);
  let parsed: CodexParsedRequest;
  let route: ChatGptWebModelRoute;
  try {
    parsed = parseRequest(expanded);
    route = routeChatGptWebRequest(parsed, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable; refusing to run ChatGPT Web with partial Codex context. Compact the Codex task or start a new task before retrying.",
    );
  }

  const compaction = parsed._compactionRequest === true;
  if (compaction) {
    // History compaction is a dedicated summarization turn. It must never bind the active Codex
    // tool bridge or continue an in-flight MCP round; the returned summary becomes the next turn's
    // replacement history through the Responses compaction contract.
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const adapter = adapterFactory(providerConfig(config));
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    try {
      await adapter.runTurn!(parsed, { headers: req.headers, abortSignal: abort.signal }, event => queue.push(event));
    } catch (error) {
      queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = route.slug;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(compaction ? { compaction: true } : {
          onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, { force: true }),
        }),
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compaction ? { compaction: true } : {}),
  });
  if (!compaction) rememberResponseState(parsed._rawBody, json, { force: true });
  return Response.json(json);
}

export async function compactRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
  if (headerTurnMetadata) {
    const existingMetadata = raw.client_metadata;
    const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? existingMetadata as Record<string, unknown>
      : {};
    raw = {
      ...raw,
      client_metadata: {
        ...clientMetadata,
        // `/responses/compact` carries native turn authority in this canonical Codex header,
        // unlike ordinary `/responses` payloads where the same value also appears in the body.
        "x-codex-turn-metadata": headerTurnMetadata,
      },
    };
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isChatGptWebModelSlug(raw.model)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses/compact", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  try {
    requireChatGptWebModelRoute(raw.model, config.proAvailable);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const input = Array.isArray(raw.input) ? raw.input : [];
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory);
  if (!response.ok) return response;
  let body: {
    output?: unknown[];
    status?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown } | null;
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error) {
    const error = {
      message: typeof body.error.message === "string" ? body.error.message : "Compaction turn failed",
      type: typeof body.error.type === "string" ? body.error.type : "upstream_error",
      code: typeof body.error.code === "string" ? body.error.code : null,
    };
    return Response.json(
      { error },
      { status: httpStatusFromTerminalError(error) },
    );
  }
  if (body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  }
  return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(input), summary) });
}

export function startServer(
  config: AppConfig,
  dependencies: { fetchUpstream?: NativeFetch } = {},
): ReturnType<typeof Bun.serve> {
  const startedAt = Date.now();
  if (config.mode === "full") {
    void TurnBroker.forSocket(config.brokerSocketPath).listen().catch(error => {
      console.error(
        `[chatgpt-web] turn broker endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;
  let successfulModelCatalogRequests = 0;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  const httpTurns = new HttpTurnCounter();
  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount(),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: "codex-chatgpt-web",
          version: VERSION,
          mode: config.mode,
          pid: process.pid,
          port: config.port,
          uptime: (Date.now() - startedAt) / 1_000,
          accepting_turns: !draining,
          successful_model_catalog_requests: successfulModelCatalogRequests,
          last_successful_model_catalog_request_at: lastSuccessfulModelCatalogRequestAt,
          ...activity(),
        });
      }
      if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        draining = url.pathname === "/admin/drain";
        return Response.json({ status: "ok", accepting_turns: !draining, ...activity() });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-browser-turns") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        // Open the retry circuit before deleting the sessions: a still-generating standalone Goose
        // client may immediately resubmit the cancelled logical turn after this response.
        standaloneRetryCircuit.cancelOutstanding();
        const cancelled = chatGptTurnSessions.clear();
        return Response.json({ status: "ok", cancelled_browser_turns: cancelled, ...activity() });
      }
      if (req.method === "POST" && url.pathname === "/admin/shutdown") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const current = activity();
        if (!draining || current.active_http_turns > 0 || current.active_browser_turns > 0) {
          return Response.json(
            {
              status: "refused",
              accepting_turns: !draining,
              ...current,
            },
            { status: 409 },
          );
        }
        setTimeout(shutdown, 0);
        return Response.json({ status: "ok", accepting_turns: false, ...current });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (draining) {
          return formatErrorResponse(
            503,
            "server_error",
            "codex-chatgpt-web is draining for a requested service operation",
          );
        }
        return httpTurns.track(async () => {
          const response = await modelsRequest(
            req,
            config,
            dependencies.fetchUpstream,
            readCodexModelContextOverride,
          );
          if (response.ok) {
            successfulModelCatalogRequests += 1;
            lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
          }
          return response;
        }, req.signal);
      }
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled on this local route", {
          status: 426,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(() => responseRequest(req, config), req.signal);
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(() => compactRequest(req, config), req.signal);
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(() => nativeSearchRequest(req, dependencies.fetchUpstream), req.signal);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  function shutdown(): void {
    if (shutdownPromise) return;
    draining = true;
    chatGptTurnSessions.clear();
    flushResponseState();
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        closeChatGptBrowserWorkers(),
        closeTurnBrokers(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        process.exitCode = 1;
        for (const failure of failures) {
          console.error(`[codex-chatgpt-web] shutdown cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      await server.stop(true);
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[codex-chatgpt-web] server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
