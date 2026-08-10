import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { startPostSendBrowserControlLiveness } from "../src/adapters/chatgpt-web/control-liveness";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { StandaloneRetryCircuit, standaloneRetrySnapshot } from "../src/adapters/chatgpt-web/retry-circuit";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { defaultConfig } from "../src/config";
import {
  isStockGooseCompactionRequestBody,
  STOCK_GOOSE_COMPACTION_SYSTEM_PREFIX,
  STOCK_GOOSE_COMPACTION_SYSTEM_TAIL,
  STOCK_GOOSE_COMPACTION_USER_PROMPT,
} from "../src/responses/goose-compaction";
import { parseRequest } from "../src/responses/parser";
import { prepareStandaloneToolRequest, responseRequest } from "../src/server";

const model = "chatgpt-web/high";
const summary = "checkpoint summary";

function stockSystem(history = "user: inspect the project\nassistant: inspected it"): string {
  return `${STOCK_GOOSE_COMPACTION_SYSTEM_PREFIX}${history}${STOCK_GOOSE_COMPACTION_SYSTEM_TAIL}`;
}

function stockRequest(history?: string): Record<string, unknown> {
  return {
    model,
    stream: true,
    store: false,
    instructions: stockSystem(history),
    reasoning: { effort: "low" },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: STOCK_GOOSE_COMPACTION_USER_PROMPT }],
    }],
  };
}

function request(body: unknown): Request {
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function standaloneConfig() {
  return { ...defaultConfig("full"), standalone: true, proAvailable: true };
}

function countFrames(sse: string, event: string): number {
  return sse.match(new RegExp(`event: ${event.replaceAll(".", "\\.")}`, "g"))?.length ?? 0;
}

test("recognizes only the stock Goose compaction compound Responses shape", () => {
  expect(isStockGooseCompactionRequestBody(stockRequest())).toBeTrue();
  expect(isStockGooseCompactionRequestBody({ ...stockRequest(), tools: [] })).toBeTrue();
  expect(isStockGooseCompactionRequestBody({
    ...stockRequest(),
    reasoning: { effort: "none" },
  })).toBeTrue();

  const ordinaryNoTools = {
    model,
    stream: true,
    store: false,
    instructions: "Generate a short session title.",
    reasoning: { effort: "low" },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Title this conversation" }],
    }],
  };
  expect(isStockGooseCompactionRequestBody(ordinaryNoTools)).toBeFalse();
  expect(isStockGooseCompactionRequestBody({
    ...stockRequest(),
    tools: [{ type: "function", name: "noop", parameters: { type: "object" } }],
  })).toBeFalse();
  expect(isStockGooseCompactionRequestBody({
    ...stockRequest(),
    reasoning: { effort: "medium" },
  })).toBeFalse();
  const changedUser = stockRequest();
  (changedUser.input as Array<Record<string, unknown>>)[0] = {
    type: "message", role: "user", content: [{ type: "input_text", text: "Summarize this" }],
  };
  expect(isStockGooseCompactionRequestBody(changedUser)).toBeFalse();
});

test("stock Goose compaction is read-only, token-free, tool-free, and keeps the normal Responses text stream", async () => {
  let sawGooseCompaction = false;
  const response = await responseRequest(request(stockRequest()), standaloneConfig(), () => ({
    name: "goose-compaction-test",
    async runTurn(parsed, _incoming, emit) {
      sawGooseCompaction = parsed._gooseCompactionRequest === true;
      expect(parsed._compactionRequest).not.toBeTrue();
      expect(parsed.context.tools).toBeUndefined();
      expect(parsed.options.toolChoice).toBeUndefined();
      expect(parsed.options.parallelToolCalls).toBeUndefined();
      const compiled = compileChatGptWebPrompt(
        parsed,
        { localToolsEnabled: false, proAvailable: true },
        undefined,
        "Goose",
      );
      expect(compiled.text).toContain("This is a Goose history-compaction checkpoint");
      expect(compiled.text).toContain("Do not call local or ChatGPT-native tools");
      expect(compiled.text).not.toMatch(/\bturn_[A-Za-z0-9_-]{32}\b/);
      expect(compiled.text).not.toContain("use the attached Goose Native plugin");
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(sawGooseCompaction).toBeTrue();
  expect(response.status).toBe(200);
  const sse = await response.text();
  expect(sse).toContain("response.output_text.delta");
  expect(sse).toContain(summary);
  expect(sse).not.toContain('\\"type\\":\\"compaction\\"');
  expect(sse).toContain("response.completed");
  expect(sse).toEndWith("data: [DONE]\n\n");
});

test("592k-character stock compaction stays a deterministic roughly-160k-token synthetic regression", async () => {
  const emptyLength = stockSystem("").length;
  expect(emptyLength).toBeLessThan(592_000);
  const historyChars = 592_000 - emptyLength;
  const history = " the".repeat(Math.ceil(historyChars / 4)).slice(0, historyChars);
  const system = stockSystem(history);
  expect(system.length).toBe(592_000);
  let estimatedInputTokens = 0;

  const response = await responseRequest(request(stockRequest(history)), standaloneConfig(), () => ({
    name: "synthetic-large-compaction",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed._gooseCompactionRequest).toBeTrue();
      estimatedInputTokens = estimateChatGptWebInputTokens(
        parsed,
        { localToolsEnabled: false, proAvailable: true },
      );
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  await response.text();

  expect(estimatedInputTokens).toBeGreaterThanOrEqual(150_000);
  expect(estimatedInputTokens).toBeLessThanOrEqual(170_000);
});

test("responsive post-send browser control can wait indefinitely without a generation deadline", async () => {
  let probes = 0;
  const watch = startPostSendBrowserControlLiveness(
    async () => { probes += 1; return true; },
    { intervalMs: 2, probeTimeoutMs: 10, maxConsecutiveFailures: 2 },
  );
  try {
    const result = await Promise.race([
      watch.failure.then(() => "failed", () => "failed"),
      Bun.sleep(30).then(() => "still-waiting"),
    ]);
    expect(result).toBe("still-waiting");
    expect(probes).toBeGreaterThanOrEqual(2);
  } finally {
    watch.stop();
  }
});

test("post-send liveness requires repeated control failures and resets after a success", async () => {
  const outcomes = [false, true, false, false];
  let probes = 0;
  const watch = startPostSendBrowserControlLiveness(
    async () => {
      probes += 1;
      if (outcomes.shift() === false) throw new Error("synthetic CDP timeout");
      return true;
    },
    { intervalMs: 2, probeTimeoutMs: 10, maxConsecutiveFailures: 2 },
  );
  const error = await watch.failure.catch(value => value);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({
    status: 502,
    errorType: "server_error",
    code: "chatgpt_browser_control_unresponsive",
    retryable: true,
  });
  expect(probes).toBe(4);
});

test("diagnostic failures are outside the post-send liveness failure counter", async () => {
  let probes = 0;
  const watch = startPostSendBrowserControlLiveness(
    async () => { probes += 1; return true; },
    { intervalMs: 2, probeTimeoutMs: 10, maxConsecutiveFailures: 2 },
  );
  try {
    await Promise.reject(new Error("synthetic screenshot failure")).catch(() => {});
    const result = await Promise.race([
      watch.failure.then(() => "failed", () => "failed"),
      Bun.sleep(20).then(() => "still-waiting"),
    ]);
    expect(result).toBe("still-waiting");
    expect(probes).toBeGreaterThan(1);
  } finally {
    watch.stop();
  }
});

test("SSE client cancellation propagates one abort and never starts a replacement provider turn", async () => {
  let providerRuns = 0;
  let resolveAborted!: () => void;
  const aborted = new Promise<void>(resolve => { resolveAborted = resolve; });
  const response = await responseRequest(request(stockRequest()), standaloneConfig(), () => ({
    name: "disconnect-test",
    async runTurn(_parsed, incoming, emit) {
      providerRuns += 1;
      emit({ type: "heartbeat" });
      if (incoming.abortSignal?.aborted) {
        resolveAborted();
        return;
      }
      await new Promise<void>(resolve => {
        incoming.abortSignal?.addEventListener("abort", () => {
          resolveAborted();
          resolve();
        }, { once: true });
      });
    },
  }));

  const reader = response.body!.getReader();
  await reader.read();
  expect(providerRuns).toBe(1);
  await reader.cancel(new Error("synthetic response body decode failure"));
  await aborted;
  await Bun.sleep(5);
  expect(providerRuns).toBe(1);
});

test("structured browser-control terminal failure emits one response.failed and closes SSE", async () => {
  const response = await responseRequest(request(stockRequest()), standaloneConfig(), () => ({
    name: "structured-browser-control-failure",
    async runTurn(_parsed, _incoming, emit) {
      emit({
        type: "error",
        message: "ChatGPT browser/CDP control path became unresponsive after the message was sent.",
        status: 502,
        errorType: "server_error",
        code: "chatgpt_browser_control_unresponsive",
        retryable: true,
      });
    },
  }));
  const sse = await response.text();
  expect(countFrames(sse, "response.failed")).toBe(1);
  expect(sse).toContain("chatgpt_browser_control_unresponsive");
  expect(sse).toEndWith("data: [DONE]\n\n");
});

test("stock Goose context-length reductions do not spend or erase the browser-failure recovery budget", () => {
  const snapshotFor = (history: string) => {
    const prepared = prepareStandaloneToolRequest(stockRequest(history), standaloneConfig());
    return standaloneRetrySnapshot(parseRequest(prepared));
  };
  const circuit = new StandaloneRetryCircuit(60_000, 16, 2, () => 1);
  const browserFailure = new ChatGptWebAdapterError(
    "ChatGPT browser/CDP control path became unresponsive after the message was sent.",
    { status: 502, errorType: "server_error", code: "chatgpt_browser_control_unresponsive", retryable: true },
  );
  const contextFailure = new ChatGptWebAdapterError(
    "synthetic context preflight failure",
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );

  const first = snapshotFor("history A");
  const reduced = snapshotFor("history B reduced");
  const recovered = snapshotFor("history C recovered");
  const terminal = snapshotFor("history D terminal");

  circuit.reserve("goose-compaction-session", "attempt-a", first, "stock-goose-compaction", 400);
  circuit.noteFailure("attempt-a", first, browserFailure);
  circuit.reserve("goose-compaction-session", "attempt-b", reduced, "stock-goose-compaction", 300);
  circuit.noteFailure("attempt-b", reduced, contextFailure);
  expect(() => circuit.reserve(
    "goose-compaction-session",
    "attempt-c",
    recovered,
    "stock-goose-compaction",
    250,
  )).not.toThrow();
  circuit.noteFailure("attempt-c", recovered, browserFailure);
  expect(() => circuit.reserve(
    "goose-compaction-session",
    "attempt-d",
    terminal,
    "stock-goose-compaction",
    200,
  )).toThrow(/retry circuit is open/i);
});

test("a later larger stock-Goose compaction in the same session starts a fresh lineage", () => {
  const prepared = prepareStandaloneToolRequest(stockRequest(), standaloneConfig());
  const snapshot = standaloneRetrySnapshot(parseRequest(prepared));
  const circuit = new StandaloneRetryCircuit(60_000, 16, 2, () => 1);
  const failure = new ChatGptWebAdapterError(
    "ChatGPT browser/CDP control path became unresponsive after the message was sent.",
    { status: 502, errorType: "server_error", code: "chatgpt_browser_control_unresponsive", retryable: true },
  );

  circuit.reserve("goose-compaction-session", "old-a", snapshot, "stock-goose-compaction", 400);
  circuit.noteFailure("old-a", snapshot, failure);
  circuit.reserve("goose-compaction-session", "old-b", snapshot, "stock-goose-compaction", 300);
  circuit.noteFailure("old-b", snapshot, failure);

  expect(() => circuit.reserve(
    "goose-compaction-session",
    "fresh-a",
    snapshot,
    "stock-goose-compaction",
    500,
  )).not.toThrow();
});

test("stock Goose compaction consumes at most PR18's one recovery browser slot", () => {
  const prepared = prepareStandaloneToolRequest(stockRequest(), standaloneConfig());
  const parsed = parseRequest(prepared);
  const snapshot = standaloneRetrySnapshot(parsed);
  const circuit = new StandaloneRetryCircuit(60_000, 16, 2, () => 1);
  const failure = new ChatGptWebAdapterError(
    "ChatGPT browser/CDP control path became unresponsive after the message was sent.",
    { status: 502, errorType: "server_error", code: "chatgpt_browser_control_unresponsive", retryable: true },
  );

  circuit.reserve("goose-compaction", "same-turn", snapshot);
  circuit.noteFailure("same-turn", snapshot, failure);
  circuit.reserve("goose-compaction", "same-turn", snapshot);
  circuit.noteFailure("same-turn", snapshot, failure);
  let terminal: unknown;
  try {
    circuit.reserve("goose-compaction", "same-turn", snapshot);
  } catch (error) {
    terminal = error;
  }
  expect(terminal).toBeInstanceOf(ChatGptWebAdapterError);
  expect(terminal).toMatchObject({ code: "chatgpt_retry_circuit_open", retryable: false });
});
