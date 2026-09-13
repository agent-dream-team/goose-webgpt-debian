import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

// Run this qualification under Node: Bun's node:http shim did not expose reliable client-socket teardown evidence.
export type WireMode = "normal" | "heartbeat" | "delay" | "tool-loop" | "drop-once";

export interface ResponsesRequestSummary {
  keys: string[];
  model: unknown;
  stream: unknown;
  store: unknown;
  previousResponseId: unknown;
  maxOutputTokens: unknown;
  toolCount: number | null;
  tools: Array<{ type: unknown; name: unknown }> | null;
  inputCount: number | null;
  inputShape: Array<{ keys: string[]; type: unknown; role: unknown; callId: unknown; name: unknown; arguments: unknown }> | null;
}

export interface WireEvidenceEvent {
  at: string;
  kind: string;
  ordinal?: number;
  mode?: WireMode;
  delayMs?: number;
  request?: ResponsesRequestSummary;
}

interface StubOptions {
  mode: WireMode;
  delayMs?: number;
}

interface RunningStub {
  origin: string;
  events: WireEvidenceEvent[];
  connectionCount(): Promise<number>;
  stop(): Promise<void>;
}

const MODEL = "gpt-4.1";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function record(events: WireEvidenceEvent[], event: Omit<WireEvidenceEvent, "at">): void {
  events.push({ at: new Date().toISOString(), ...event });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function summarizeResponsesRequest(value: unknown): ResponsesRequestSummary {
  const body = asRecord(value);
  const tools = Array.isArray(body.tools) ? body.tools : null;
  const input = Array.isArray(body.input) ? body.input : null;
  return {
    keys: Object.keys(body).sort(),
    model: body.model ?? null,
    stream: body.stream ?? null,
    store: Object.hasOwn(body, "store") ? body.store : "__ABSENT__",
    previousResponseId: Object.hasOwn(body, "previous_response_id")
      ? body.previous_response_id
      : "__ABSENT__",
    maxOutputTokens: body.max_output_tokens ?? null,
    toolCount: tools?.length ?? null,
    tools: tools?.map(tool => {
      const item = asRecord(tool);
      const fn = asRecord(item.function);
      return { type: item.type ?? null, name: item.name ?? fn.name ?? null };
    }) ?? null,
    inputCount: input?.length ?? null,
    inputShape: input?.map(item => {
      const entry = asRecord(item);
      return {
        keys: Object.keys(entry).sort(),
        type: entry.type ?? null,
        role: entry.role ?? null,
        callId: entry.call_id ?? null,
        name: entry.name ?? null,
        arguments: entry.arguments ?? null,
      };
    }) ?? null,
  };
}

function responseEnvelope(id: string, status: "in_progress" | "completed", output: unknown[]): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 0,
    status,
    model: MODEL,
    output,
    stub_unknown_response_field: "ignored-by-goose",
    ...(status === "completed" ? { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } : {}),
  };
}

export function buildResponsesSse(options: {
  text?: string;
  heartbeat?: boolean;
  toolCall?: { name: string; callId: string; arguments: string };
  responseId?: string;
} = {}): string {
  const responseId = options.responseId ?? "resp_stub";
  const chunks: string[] = [];
  if (options.heartbeat) {
    chunks.push("event: response.heartbeat\ndata: {\"type\":\"response.heartbeat\",\"sequence_number\":0,\"stub_unknown_event_field\":\"ignored\"}\n\n");
  }
  chunks.push(`data: ${JSON.stringify({
    type: "response.created",
    sequence_number: 1,
    response: responseEnvelope(responseId, "in_progress", []),
    stub_unknown_event_field: "ignored",
  })}\n\n`);
  if (options.text) {
    chunks.push(`data: ${JSON.stringify({
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_stub",
      output_index: 0,
      content_index: 0,
      delta: options.text,
      stub_unknown_event_field: "ignored",
    })}\n\n`);
  }
  const output = options.toolCall ? [{
    type: "function_call",
    id: "fc_stub",
    call_id: options.toolCall.callId,
    name: options.toolCall.name,
    arguments: options.toolCall.arguments,
  }] : [];
  chunks.push(`data: ${JSON.stringify({
    type: "response.completed",
    sequence_number: options.text ? 3 : 2,
    response: responseEnvelope(responseId, "completed", output),
    stub_unknown_event_field: "ignored",
  })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) raw += chunk.toString();
  return JSON.parse(raw);
}

function sendSse(response: ServerResponse, body: string): void {
  if (response.destroyed) return;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.end(body);
}

async function startStub(options: StubOptions): Promise<RunningStub> {
  const events: WireEvidenceEvent[] = [];
  let postCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      record(events, { kind: "models_request", mode: options.mode });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        object: "list",
        data: [{
          id: MODEL,
          object: "model",
          created: 0,
          owned_by: "local-wire-qualification",
          meta: { n_ctx: 200_000 },
          stub_unknown_model_field: "ignored-by-goose",
        }],
        stub_unknown_catalog_field: "ignored-by-goose",
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    postCount += 1;
    const ordinal = postCount;
    let terminalSent = false;
    let prematureCloseRecorded = false;
    const recordPrematureClose = () => {
      if (!terminalSent && !prematureCloseRecorded) {
        prematureCloseRecorded = true;
        record(events, { kind: "response_closed_before_terminal", mode: options.mode, ordinal });
      }
    };
    response.on("close", recordPrematureClose);
    request.on("aborted", recordPrematureClose);
    request.socket.on("close", recordPrematureClose);
    const body = await readJsonBody(request);
    record(events, {
      kind: "responses_request",
      mode: options.mode,
      ordinal: postCount,
      request: summarizeResponsesRequest(body),
    });

    if (options.mode === "drop-once" && postCount === 1) {
      record(events, { kind: "socket_destroyed", mode: options.mode, ordinal: postCount });
      request.socket.destroy();
      return;
    }

    if (options.mode === "delay") {
      const delayMs = options.delayMs ?? 750;
      record(events, { kind: "delay_started", mode: options.mode, delayMs, ordinal });
      await sleep(delayMs);
      if (response.destroyed) {
        recordPrematureClose();
        return;
      }
    }

    if (options.mode === "tool-loop" && postCount === 1) {
      terminalSent = true;
      sendSse(response, buildResponsesSse({
        toolCall: { name: "tree", callId: "call_stub", arguments: '{"path":"."}' },
        responseId: "resp_tool_1",
      }));
      record(events, { kind: "tool_call_sent", mode: options.mode, ordinal: postCount });
      return;
    }

    terminalSent = true;
    sendSse(response, buildResponsesSse({
      text: options.mode === "drop-once" ? "RETRY_OK" : options.mode === "tool-loop" ? "WIRE_TOOL_LOOP_OK" : "WIRE_OK",
      heartbeat: options.mode === "heartbeat",
      responseId: `resp_${options.mode}_${postCount}`,
    }));
    if (options.mode === "heartbeat") record(events, { kind: "heartbeat_sent", mode: options.mode, ordinal: postCount });
    record(events, { kind: "terminal_sent", mode: options.mode, ordinal: postCount });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  record(events, { kind: "listening", mode: options.mode });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    events,
    connectionCount: () => new Promise<number>((resolve, reject) => {
      server.getConnections((error, count) => error ? reject(error) : resolve(count));
    }),
    stop: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function gooseEnvironment(origin: string): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of [
    "OPENAI_API_KEY", "OPENAI_HOST", "OPENAI_BASE_URL", "OPENAI_BASE_PATH", "OPENAI_STORE",
    "OPENAI_ORGANIZATION", "OPENAI_PROJECT", "OPENAI_CUSTOM_HEADERS",
  ]) delete env[key];
  return {
    ...env,
    OPENAI_API_KEY: "local-wire-qualification",
    OPENAI_HOST: origin,
    OPENAI_BASE_PATH: "v1/responses",
    OPENAI_STORE: "false",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

function gooseArgs(options: { developer?: boolean; maxTurns?: number; prompt: string }): string[] {
  return [
    "run", "--provider", "openai", "--model", MODEL, "--no-session", "--no-profile",
    ...(options.developer ? ["--with-builtin", "developer"] : []),
    "--max-turns", String(options.maxTurns ?? 1), "--quiet", "--output-format", "text", "-t", options.prompt,
  ];
}

function readText(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", chunk => { text += chunk; });
    stream.once("error", reject);
    stream.once("end", () => resolve(text));
  });
}

function startGoose(gooseBin: string, origin: string, args: string[]) {
  const child = spawn(gooseBin, args, {
    cwd: process.cwd(),
    env: gooseEnvironment(origin),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
  return {
    child,
    exited,
    stdout: readText(child.stdout),
    stderr: readText(child.stderr),
  };
}

async function finishGoose(started: ReturnType<typeof startGoose>, timeoutMs = 15_000) {
  const terminateTimer = setTimeout(() => started.child.kill("SIGTERM"), timeoutMs);
  const forceKillTimer = setTimeout(() => {
    if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill("SIGKILL");
  }, timeoutMs + 2_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([started.exited, started.stdout, started.stderr]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(terminateTimer);
    clearTimeout(forceKillTimer);
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000, label = "qualification evidence"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

function responseRequests(events: WireEvidenceEvent[]): WireEvidenceEvent[] {
  return events.filter(event => event.kind === "responses_request");
}

async function runCase(gooseBin: string, options: StubOptions & { developer?: boolean; maxTurns?: number; prompt: string }) {
  const stub = await startStub(options);
  try {
    const startedAt = Date.now();
    const result = await finishGoose(startGoose(gooseBin, stub.origin, gooseArgs(options)));
    return { ...result, elapsedMs: Date.now() - startedAt, events: stub.events };
  } finally {
    await stub.stop();
  }
}

export async function runQualification(gooseBin = process.env.GOOSE_BIN ?? "goose") {
  const versionResult = spawnSync(gooseBin, ["--version"], { encoding: "utf8" });
  assert.equal(versionResult.status, 0, `Could not execute ${gooseBin}: ${versionResult.stderr}`);
  const gooseVersion = versionResult.stdout.trim();
  const expectedVersion = process.env.GOOSE_EXPECTED_VERSION ?? "1.50.0";
  assert(gooseVersion.includes(expectedVersion), `Expected Goose ${expectedVersion}; got ${gooseVersion}`);

  const normal = await runCase(gooseBin, { mode: "normal", prompt: "Reply exactly WIRE_OK." });
  assert.equal(normal.exitCode, 0);
  assert(normal.stdout.includes("WIRE_OK"));
  const normalRequests = responseRequests(normal.events);
  assert.equal(normalRequests.length, 1);
  assert.deepEqual(normalRequests[0]!.request?.keys, ["input", "max_output_tokens", "model", "store", "stream"]);
  assert.equal(normalRequests[0]!.request?.store, false);
  assert.equal(normalRequests[0]!.request?.previousResponseId, "__ABSENT__");
  assert.equal(normalRequests[0]!.request?.toolCount, null);
  assert(normal.events.some(event => event.kind === "models_request"));

  const heartbeat = await runCase(gooseBin, {
    mode: "heartbeat",
    developer: true,
    prompt: "Reply exactly WIRE_OK and do not use tools.",
  });
  assert.equal(heartbeat.exitCode, 0);
  assert(heartbeat.stdout.includes("WIRE_OK"));
  const heartbeatRequest = responseRequests(heartbeat.events)[0]!;
  assert.equal(heartbeatRequest.request?.previousResponseId, "__ABSENT__");
  assert.deepEqual(heartbeatRequest.request?.tools?.map(tool => tool.name).sort(), ["edit", "read_image", "shell", "tree", "write"]);
  assert(heartbeat.events.some(event => event.kind === "heartbeat_sent"));

  const delayed = await runCase(gooseBin, { mode: "delay", delayMs: 750, prompt: "Reply exactly WIRE_OK." });
  assert.equal(delayed.exitCode, 0);
  assert(delayed.stdout.includes("WIRE_OK"));
  assert(delayed.elapsedMs >= 700, `Silent-delay case returned too early: ${delayed.elapsedMs}ms`);

  const disconnectStub = await startStub({ mode: "delay", delayMs: 5_000 });
  let disconnectResult;
  try {
    const started = startGoose(gooseBin, disconnectStub.origin, gooseArgs({ prompt: "Reply exactly WIRE_OK." }));
    await waitFor(() => disconnectStub.events.some(event => event.kind === "delay_started"), 5_000, "disconnect case to reach delayed response");
    assert((await disconnectStub.connectionCount()) > 0, "Disconnect case never established a provider connection");
    started.child.kill("SIGTERM");
    disconnectResult = await finishGoose(started, 5_000);
    const disconnectDeadline = Date.now() + 5_000;
    while ((await disconnectStub.connectionCount()) !== 0 && Date.now() < disconnectDeadline) {
      await sleep(25);
    }
    assert.equal(await disconnectStub.connectionCount(), 0, "Goose exit left the provider connection open");
    record(disconnectStub.events, { kind: "client_connection_closed", mode: "delay" });
  } finally {
    await disconnectStub.stop();
  }
  assert.notEqual(disconnectResult.exitCode, 0);

  const toolLoop = await runCase(gooseBin, {
    mode: "tool-loop",
    developer: true,
    maxTurns: 3,
    prompt: "Follow the provider response. Do not make any tool call except the one explicitly requested by the provider.",
  });
  assert.equal(toolLoop.exitCode, 0);
  assert(toolLoop.stdout.includes("WIRE_TOOL_LOOP_OK"));
  const toolRequests = responseRequests(toolLoop.events);
  assert.equal(toolRequests.length, 2);
  assert.equal(toolRequests[1]!.request?.previousResponseId, "__ABSENT__");
  assert.deepEqual(toolRequests[1]!.request?.inputShape?.map(item => item.type), ["message", "message", "function_call", "function_call_output"]);
  assert.equal(toolRequests[1]!.request?.inputShape?.[2]?.callId, "call_stub");
  assert.equal(toolRequests[1]!.request?.inputShape?.[3]?.callId, "call_stub");

  const dropped = await runCase(gooseBin, { mode: "drop-once", prompt: "Reply exactly RETRY_OK." });
  assert.equal(dropped.exitCode, 0);
  assert(dropped.stdout.includes("RETRY_OK"));
  const droppedRequests = responseRequests(dropped.events);
  assert.equal(droppedRequests.length, 2);
  assert.deepEqual(droppedRequests[1]!.request, droppedRequests[0]!.request);
  assert(dropped.events.some(event => event.kind === "socket_destroyed"));

  const evidenceRoot = mkdtempSync(join(tmpdir(), "cgw-goose-wire-evidence-"));
  const evidence = {
    gooseVersion,
    qualifiedAt: new Date().toISOString(),
    invariant: "Evidence contains request shape and transport events only; raw prompts and authorization headers are never persisted.",
    cases: {
      normal: normal.events,
      heartbeat: heartbeat.events,
      delay: delayed.events,
      disconnect: disconnectStub.events,
      toolLoop: toolLoop.events,
      dropOnce: dropped.events,
    },
    longDurationCasesRun: false,
  };
  const versionSlug = expectedVersion.replace(/[^0-9A-Za-z._-]/g, "-");
  const evidencePath = join(evidenceRoot, `goose-${versionSlug}-responses-wire.json`);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return { gooseVersion, evidencePath };
}

if (import.meta.main) {
  const result = await runQualification();
  process.stdout.write(`GOOSE_RESPONSES_WIRE_QUALIFICATION_OK ${result.gooseVersion}\nEVIDENCE=${result.evidencePath}\n`);
}
