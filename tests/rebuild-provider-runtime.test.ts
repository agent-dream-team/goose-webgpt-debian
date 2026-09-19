import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { canonicalJson } from "../src/canonical-json";
import { encodeGooseCanonicalHistoryWatermark } from "../src/goose-canonical-history";
import { decodeGooseResponsesProjectionCheckpoint, encodeGooseResponsesProjectionCheckpoint, gooseResponsesProjectionCheckpoint } from "../src/goose-responses-projection";
import { connectorOperationInputHash, prepareConnectorTerminalResult } from "../src/rebuild-connector-http";
import { ChatGptUpstreamTerminalError } from "../src/chatgpt-terminal-state";
import { SessionBroker } from "../src/session-broker";
import {
  REBUILD_TERMINAL_REPLAY_WINDOW_MS,
  startRebuildProviderRuntime,
  type RebuildPersistentBrowserDriver,
  type RebuildPersistentBrowserTurnInput,
  type RebuildProviderRuntime,
} from "../src/rebuild-provider-runtime";
import { buildRebuildResponsesSse } from "../src/rebuild-responses-sse";

const roots: string[] = [];
const runtimes: RebuildProviderRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop().catch(() => {})));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function requestBody(userText = "hello") {
  return {
    model: "gpt-4.1",
    stream: true,
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    ],
    tools: [{ type: "function", name: "tree", parameters: { type: "object" } }],
  };
}

function continuationBody(previous: ReturnType<typeof requestBody>, opRef: string, output: string) {
  return {
    ...previous,
    input: [
      ...previous.input,
      { type: "function_call", call_id: opRef, name: "tree", arguments: '{"path":"."}' },
      { type: "function_call_output", call_id: opRef, output },
    ],
  };
}

function laterTurnBody(previous: ReturnType<typeof requestBody>, assistantText: string, userText: string) {
  return {
    ...previous,
    input: [
      ...previous.input,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: assistantText, annotations: [] }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    ],
  };
}

function watermark(body: unknown, finalText: string): string {
  return encodeGooseCanonicalHistoryWatermark({
    checkpoint: gooseResponsesProjectionCheckpoint(body),
    finalAssistantText: finalText,
  });
}

function setup(driver: RebuildPersistentBrowserDriver) {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-"));
  roots.push(root);
  const authorizationFile = join(root, "connector-auth.txt");
  const authorization = `Bearer ${"p".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const runtime = startRebuildProviderRuntime({
    port: 0,
    model: "gpt-4.1",
    contextWindow: 200_000,
    controlToken: "control-token",
    projectId: "project-runtime-test",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath: join(root, "broker.sqlite"),
    terminalReplayWindowMs: 60_000,
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: driver,
  });
  runtimes.push(runtime);
  return { root, runtime, authorization };
}

async function post(runtime: RebuildProviderRuntime, body: unknown, session = "goose-session-a", signal?: AbortSignal) {
  return await fetch(`${runtime.origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "agent-session-id": session },
    body: JSON.stringify(body),
    signal,
  });
}

function connectorClient(runtime: RebuildProviderRuntime, authorization: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${runtime.connector.origin}/mcp`), {
    requestInit: { headers: { authorization } },
  });
  const client = new Client({ name: "rebuild-provider-runtime-test", version: "1.0.0" });
  return { client, transport };
}

function responseFunctionCall(sse: string): { callId: string; name: string; argumentsJson: string } {
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: {") || !line.includes('"response.completed"')) continue;
    const event = JSON.parse(line.slice(6)) as any;
    const call = event.response?.output?.[0];
    if (call?.type === "function_call") {
      return { callId: call.call_id, name: call.name, argumentsJson: call.arguments };
    }
  }
  throw new Error(`No function_call in SSE: ${sse}`);
}

test("rebuild terminal replay default spans observed hosted redelivery cadence", () => {
  expect(REBUILD_TERMINAL_REPLAY_WINDOW_MS).toBe(5 * 60_000);
  expect(REBUILD_TERMINAL_REPLAY_WINDOW_MS).toBeGreaterThan(2 * 121_000);
});

test("minimal Responses SSE keeps text and function-call terminals mutually exclusive", () => {
  expect(buildRebuildResponsesSse({ model: "gpt-4.1", text: "ok", id: "resp_test" })).toContain("response.output_text.delta");
  expect(buildRebuildResponsesSse({
    model: "gpt-4.1",
    toolCall: { callId: "op_1", name: "tree", argumentsJson: '{"path":"."}' },
    id: "resp_tool",
  })).toContain('"call_id":"op_1"');
  expect(() => buildRebuildResponsesSse({ model: "gpt-4.1" })).toThrow("Exactly one");
  expect(() => buildRebuildResponsesSse({
    model: "gpt-4.1", text: "x", toolCall: { callId: "op", name: "tree", argumentsJson: "{}" },
  })).toThrow("Exactly one");
});

test("positive Responses output ceilings are not rejected by a local conversation reserve", async () => {
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "99999999-1111-4222-8333-444444444444",
            acceptedUserTurnId: "user-output-uncapped",
          });
          return {
            canonicalConversationId: "99999999-1111-4222-8333-444444444444",
            acceptedUserTurnId: "user-output-uncapped",
            text: "output-uncapped-ok",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const response = await post(runtime, {
    ...requestBody("large positive ceiling"), max_output_tokens: 65_536,
  }, "goose-output-uncapped");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("output-uncapped-ok");
  expect(runtime.broker.getCurrentEpoch("goose-output-uncapped")).toMatchObject({
    epoch: 1, budgetPolicyJson: null, budgetConsumedTokens: null,
  });
});

test("runtime health/control surface and two completed Goose turns reuse one persistent epoch", async () => {
  const starts: RebuildPersistentBrowserTurnInput[] = [];
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts.push(input);
      const ordinal = starts.length;
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool call expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "12345678-1234-4abc-8def-1234567890ab",
            acceptedUserTurnId: `user-${ordinal}`,
          });
          return {
            canonicalConversationId: "12345678-1234-4abc-8def-1234567890ab",
            acceptedUserTurnId: `user-${ordinal}`,
            text: `answer-${ordinal}`,
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const health = await (await fetch(`${runtime.origin}/healthz`)).json() as any;
  expect(health).toMatchObject({ status: "ok", service: "goose-chatgpt-web-rebuild", accepting_turns: true });
  const models = await (await fetch(`${runtime.origin}/v1/models`)).json() as any;
  expect(models.data[0]).toMatchObject({ id: "gpt-4.1", meta: { n_ctx: 200_000 } });

  const firstRequest = requestBody("first");
  const first = await post(runtime, firstRequest);
  expect(first.status).toBe(200);
  const firstBody = await first.text();
  expect(firstBody).toContain("answer-1");
  expect(starts[0]?.prompt).toContain('"connector_identity":"Goose Native 2nd Shift"');
  expect(starts[0]?.prompt).toContain('"available_tool_names":["tree"]');
  expect(starts[0]?.prompt).toContain("a tool_name from available_tool_names");
  expect(starts[0]?.prompt).toContain("wait about 50–55 seconds before checking once; never tight-poll");
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
  expect(runtime.broker.getCurrentEpoch("goose-session-a")).toMatchObject({
    epoch: 1, conversationId: "12345678-1234-4abc-8def-1234567890ab", historyWatermark: watermark(firstRequest, "answer-1"), leaseState: "IDLE",
  });

  const replay = await post(runtime, firstRequest);
  expect(replay.status).toBe(200);
  expect(await replay.text()).toBe(firstBody);
  expect(starts).toHaveLength(1);

  const secondRequest = laterTurnBody(firstRequest, "answer-1", "second");
  const second = await post(runtime, secondRequest);
  expect(second.status).toBe(200);
  expect(await second.text()).toContain("answer-2");
  expect(starts).toHaveLength(2);
  expect(starts[1]?.existingConversationId).toBe("12345678-1234-4abc-8def-1234567890ab");
  expect(starts[1]?.prompt).toContain("second");
  expect(starts[1]?.prompt).not.toContain("answer-1");
  expect(runtime.broker.getCurrentEpoch("goose-session-a")).toMatchObject({
    epoch: 1, historyWatermark: watermark(secondRequest, "answer-2"), leaseState: "IDLE",
  });

  const drain = await fetch(`${runtime.origin}/admin/drain`, {
    method: "POST", headers: { authorization: "Bearer control-token" },
  });
  expect(drain.status).toBe(200);
  expect((await drain.json() as any).accepting_turns).toBe(false);
  expect((await fetch(`${runtime.origin}/v1/models`)).status).toBe(503);
  const resume = await fetch(`${runtime.origin}/admin/resume`, {
    method: "POST", headers: { authorization: "Bearer control-token" },
  });
  expect((await resume.json() as any).accepting_turns).toBe(true);
});

test("canonical divergence preserves the existing pair and requires a paired handoff", async () => {
  const starts: RebuildPersistentBrowserTurnInput[] = [];
  const conversationId = "11111111-2222-4333-8444-555555555555";
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts.push(input);
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: conversationId,
            acceptedUserTurnId: "user-paired-handoff-1",
          });
          return {
            canonicalConversationId: conversationId,
            acceptedUserTurnId: "user-paired-handoff-1",
            text: "paired-handoff-answer-1",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const firstRequest = requestBody("first");
  expect((await post(runtime, firstRequest, "goose-paired-handoff")).status).toBe(200);
  expect(runtime.broker.getCurrentEpoch("goose-paired-handoff")?.epoch).toBe(1);

  const diverged = requestBody("revised-current-projection");
  const second = await post(runtime, diverged, "goose-paired-handoff");
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ error: { code: "paired_handoff_required" } });
  expect(starts).toHaveLength(1);
  expect(runtime.broker.getCurrentEpoch("goose-paired-handoff")).toMatchObject({
    epoch: 1,
    conversationId,
    leaseState: "IDLE",
  });
});

for (const scenario of [
  {
    name: "compaction-like canonical rewrite",
    nextInput: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "COMPACTED SUMMARY OF PRIOR WORK" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue after compaction" }] },
    ],
    expected: ["COMPACTED SUMMARY OF PRIOR WORK", "continue after compaction"],
  },
  {
    name: "canonical truncation",
    nextInput: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continued from truncated history" }] },
    ],
    expected: ["continued from truncated history"],
  },
  {
    name: "prior user revision",
    nextInput: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "revised original task" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "rewrite-answer-1", annotations: [] }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue revised task" }] },
    ],
    expected: ["revised original task", "continue revised task"],
  },
  {
    name: "branch resume divergence",
    nextInput: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "original task" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "rewrite-answer-1", annotations: [] }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "branch point" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "resumed branch instruction" }] },
    ],
    expected: ["branch point", "resumed branch instruction"],
  },
] as const) test(`Gate F ${scenario.name} preserves the pair and requires a paired handoff`, async () => {
  const starts: RebuildPersistentBrowserTurnInput[] = [];
  const conversations = [
    "21111111-2222-4333-8444-555555555555",
    "26666666-7777-4888-8999-aaaaaaaaaaaa",
  ];
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts.push(input);
      const ordinal = starts.length;
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: conversations[ordinal - 1]!,
            acceptedUserTurnId: `user-history-rewrite-${ordinal}`,
          });
          return {
            canonicalConversationId: conversations[ordinal - 1]!,
            acceptedUserTurnId: `user-history-rewrite-${ordinal}`,
            text: `rewrite-answer-${ordinal}`,
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const initial = requestBody("original task");
  expect((await post(runtime, initial, `goose-${scenario.name.replaceAll(" ", "-")}`)).status).toBe(200);
  expect(runtime.broker.getCurrentEpoch(`goose-${scenario.name.replaceAll(" ", "-")}`)?.epoch).toBe(1);

  const rewritten = { ...initial, input: scenario.nextInput };
  const sessionId = `goose-${scenario.name.replaceAll(" ", "-")}`;
  const second = await post(runtime, rewritten, sessionId);
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ error: { code: "paired_handoff_required" } });
  expect(starts).toHaveLength(1);
  expect(runtime.broker.getCurrentEpoch(sessionId)).toMatchObject({
    epoch: 1,
    conversationId: conversations[0],
    leaseState: "IDLE",
  });
});

test("later Goose turn after tool history appends only the new user instruction to the same epoch", async () => {
  const starts: RebuildPersistentBrowserTurnInput[] = [];
  let invokeTool!: (input: RebuildPersistentBrowserTurnInput) => Promise<Record<string, unknown>>;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts.push(input);
      const ordinal = starts.length;
      return {
        captureAnswerBoundary: async opRef => JSON.stringify({ kind: "boundary", opRef }),
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "bbbbbbbb-1111-4222-8333-cccccccccccc",
            acceptedUserTurnId: `user-tool-history-${ordinal}`,
          });
          if (ordinal === 1) {
            const terminal = await invokeTool(input);
            expect(terminal.ok).toBe(true);
            return {
              canonicalConversationId: "bbbbbbbb-1111-4222-8333-cccccccccccc",
              acceptedUserTurnId: "user-tool-history-1",
              text: "tool-history-final",
              remoteNonRunning: true,
              contentAdvancedAfterLastTool: true,
            };
          }
          return {
            canonicalConversationId: "bbbbbbbb-1111-4222-8333-cccccccccccc",
            acceptedUserTurnId: "user-tool-history-2",
            text: "second-after-tool",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime, authorization } = setup(driver);
  const connector = connectorClient(runtime, authorization);
  await connector.client.connect(connector.transport);
  invokeTool = async input => (await connector.client.callTool({ name: "goose_tool", arguments: {
    turn_ref: input.turnRef,
    op_ref: input.initialOpRef,
    tool_name: "tree",
    arguments: { path: "." },
  } })).structuredContent as Record<string, unknown>;

  try {
    const initial = requestBody("tool-first");
    const first = await post(runtime, initial, "goose-tool-history");
    const call = responseFunctionCall(await first.text());
    const progressed = continuationBody(initial, call.callId, "RAW_TOOL_OUTPUT_FROM_GOOSE");
    const firstFinal = await post(runtime, progressed, "goose-tool-history");
    expect(firstFinal.status).toBe(200);
    expect(await firstFinal.text()).toContain("tool-history-final");

    const next = {
      ...progressed,
      input: [
        ...progressed.input,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "tool-history-final", annotations: [] }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "NEW_USER_ONLY" }] },
      ],
    };
    const second = await post(runtime, next, "goose-tool-history");
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("second-after-tool");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.epoch).toBe(1);
    expect(starts[1]?.existingConversationId).toBe("bbbbbbbb-1111-4222-8333-cccccccccccc");
    expect(starts[1]?.prompt).toContain("NEW_USER_ONLY");
    expect(starts[1]?.prompt).toContain('"mode":"append"');
    expect(starts[1]?.prompt).not.toContain("RAW_TOOL_OUTPUT_FROM_GOOSE");
    expect(starts[1]?.prompt).not.toContain("tool-history-final");
  } finally {
    await connector.client.close().catch(() => {});
  }
});

test("dead pre-dispatch HTTP owner releases one stage and exact retry can receive the final response", async () => {
  const accepted = deferred<void>();
  const finish = deferred<void>();
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool call expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            acceptedUserTurnId: "user-transfer",
          });
          accepted.resolve();
          await finish.promise;
          return {
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            acceptedUserTurnId: "user-transfer",
            text: "retry-owner-ok",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const controller = new AbortController();
  const first = post(runtime, requestBody("transfer"), "goose-transfer", controller.signal).catch(error => error);
  await accepted.promise;
  controller.abort();
  await Bun.sleep(30);

  const retryPromise = post(runtime, requestBody("transfer"), "goose-transfer");
  finish.resolve();
  const retry = await retryPromise;
  expect(retry.status).toBe(200);
  expect(await retry.text()).toContain("retry-owner-ok");
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
  await first;
});

test("runtime resolves connector-qualified Goose tool aliases before the exact serial tool round", async () => {
  let invokeTool!: (input: RebuildPersistentBrowserTurnInput) => Promise<Record<string, unknown>>;
  let toolWorkSnapshot!: RebuildPersistentBrowserTurnInput["gooseWork"]["snapshot"];
  let boundaryCaptures = 0;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      toolWorkSnapshot = input.gooseWork.snapshot;
      return {
        captureAnswerBoundary: async opRef => {
          boundaryCaptures += 1;
          return JSON.stringify({ kind: "fake-fresh-boundary", opRef, chars: 12 });
        },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
            acceptedUserTurnId: "user-tool",
          });
          const tool = await invokeTool(input);
          expect(tool).toMatchObject({ ok: true, op_ref: input.initialOpRef });
          return {
            canonicalConversationId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
            acceptedUserTurnId: "user-tool",
            text: "runtime-tool-loop-ok",
            remoteNonRunning: true,
            contentAdvancedAfterLastTool: true,
          };
        },
      };
    },
  };
  const { runtime, authorization } = setup(driver);
  const connector = connectorClient(runtime, authorization);
  await connector.client.connect(connector.transport);
  invokeTool = async input => {
    const result = await connector.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: input.turnRef,
      op_ref: input.initialOpRef,
      tool_name: "developer__tree",
      arguments: { path: "." },
    } });
    return result.structuredContent as Record<string, unknown>;
  };

  try {
    const initial = requestBody("tool-loop");
    const first = await post(runtime, initial, "goose-tool");
    expect(first.status).toBe(200);
    const firstSse = await first.text();
    const call = responseFunctionCall(firstSse);
    expect(call).toMatchObject({ name: "tree", argumentsJson: canonicalJson({ path: "." }) });
    expect(boundaryCaptures).toBe(1);
    expect(runtime.broker.getOperation(call.callId)?.state).toBe("CLAIMED");
    expect(toolWorkSnapshot().activeToolCalls).toBe(1);

    const second = await post(runtime, continuationBody(initial, call.callId, "tool-output"), "goose-tool");
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("runtime-tool-loop-ok");
    expect(runtime.broker.getOperation(call.callId)?.state).toBe("SUCCESS");
    expect(toolWorkSnapshot().activeToolCalls).toBe(0);
    expect(runtime.broker.getAccountSlotHolder()).toBeNull();
    expect(runtime.broker.getCurrentEpoch("goose-tool")).toMatchObject({ leaseState: "IDLE", historyWatermark: watermark(continuationBody(initial, call.callId, "tool-output"), "runtime-tool-loop-ok") });
  } finally {
    await connector.client.close().catch(() => {});
  }
});

test("authenticated execution detach quarantines only genuinely unresolved tool correlation and retains its slot", async () => {
  let invokeTool!: (input: RebuildPersistentBrowserTurnInput) => Promise<any>;
  const toolSettled = deferred<any>();
  const executionDetached = deferred<void>();
  let detachments = 0;
  const conversationId = "bbbbbbbb-cccc-4ddd-8eee-000000000123";
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      return {
        captureAnswerBoundary: async opRef => JSON.stringify({ kind: "owner-terminal-boundary", opRef }),
        confirmFinal: async evidence => evidence,
        detachExecution: async () => {
          detachments += 1;
          executionDetached.resolve();
        },
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({ canonicalConversationId: conversationId, acceptedUserTurnId: "user-owner-terminal" });
          toolSettled.resolve(await invokeTool(input));
          await executionDetached.promise;
          throw new Error("process-local execution detached");
        },
      };
    },
  };
  const { runtime, authorization } = setup(driver);
  const connector = connectorClient(runtime, authorization);
  await connector.client.connect(connector.transport);
  invokeTool = input => connector.client.callTool({ name: "goose_tool", arguments: {
    turn_ref: input.turnRef,
    op_ref: input.initialOpRef,
    tool_name: "tree",
    arguments: { path: "." },
  } });

  try {
    const initial = requestBody("owner-terminal");
    const first = await post(runtime, initial, "goose-owner-terminal");
    const call = responseFunctionCall(await first.text());
    const turn = runtime.broker.getOpenTurnForSession("goose-owner-terminal")!;
    expect(runtime.broker.getOperation(call.callId)?.state).toBe("CLAIMED");

    const wrongIdentity = await fetch(`${runtime.origin}/admin/detach-turn-execution`, {
      method: "POST",
      headers: { authorization: "Bearer control-token", "content-type": "application/json" },
      body: JSON.stringify({
        turn_ref: turn.turnRef, goose_session_id: "wrong-session", reason: "transport_lost",
      }),
    });
    expect(wrongIdentity.status).toBe(409);
    expect(runtime.broker.getOperation(call.callId)?.state).toBe("CLAIMED");

    const terminated = await fetch(`${runtime.origin}/admin/detach-turn-execution`, {
      method: "POST",
      headers: { authorization: "Bearer control-token", "content-type": "application/json" },
      body: JSON.stringify({
        turn_ref: turn.turnRef, goose_session_id: "goose-owner-terminal", reason: "transport_lost",
      }),
    });
    expect(terminated.status).toBe(200);
    expect(await terminated.json()).toMatchObject({
      status: "ok", turn_state: "UNRECONCILED", slot_retained: true,
      unreconciled_reason: "goose_execution_transport_lost",
    });
    expect((await toolSettled.promise).structuredContent).toMatchObject({ ok: false, output: "UNCERTAIN" });
    expect(runtime.broker.getOperation(call.callId)).toMatchObject({ state: "UNCERTAIN", ownerId: null });
    expect(runtime.broker.getAccountSlotHolders().some(holder => holder.turnRef === turn.turnRef)).toBeTrue();
    expect(detachments).toBe(1);

    const repeated = await fetch(`${runtime.origin}/admin/detach-turn-execution`, {
      method: "POST",
      headers: { authorization: "Bearer control-token", "content-type": "application/json" },
      body: JSON.stringify({
        turn_ref: turn.turnRef, goose_session_id: "goose-owner-terminal", reason: "transport_lost",
      }),
    });
    expect(repeated.status).toBe(200);
    expect(detachments).toBe(1);

    const late = await post(runtime, continuationBody(initial, call.callId, "late-tool-output"), "goose-owner-terminal");
    expect(late.status).toBe(409);
    expect(await late.text()).toContain("rebind_request_conflict");

    const reconciled = await fetch(`${runtime.origin}/admin/reconcile-operation`, {
      method: "POST",
      headers: { authorization: "Bearer control-token", "content-type": "application/json" },
      body: JSON.stringify({
        turn_ref: turn.turnRef,
        op_ref: call.callId,
        tool_name: "tree",
        arguments: { path: "." },
        outcome: "SUCCESS",
        data_class: "task",
        content: "known-late-result",
      }),
    });
    expect(reconciled.status).toBe(200);
    expect(runtime.broker.getOperation(call.callId)?.state).toBe("SUCCESS");
    expect(runtime.broker.getAccountSlotHolders().some(holder => holder.turnRef === turn.turnRef)).toBeTrue();

    const released = runtime.broker.releaseSlotAfterPositiveTerminal(turn.turnRef, {
      canonicalConversationId: conversationId,
      acceptedUserTurnId: "user-owner-terminal",
      remoteUiNonRunningAcrossQualifiedSettle: true,
      noUnresolvedGooseWork: true,
      noContradictoryActivity: true,
    });
    expect(released.state).toBe("UNRECONCILED");
    expect(runtime.broker.getAccountSlotHolders().some(holder => holder.turnRef === turn.turnRef)).toBeFalse();
  } finally {
    await connector.client.close().catch(() => {});
  }
});

test("transport loss before send activation frees the slot and exact retry gets a fresh pre-send attempt", async () => {
  const firstStarted = deferred<void>();
  let starts = 0;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts += 1;
      const ordinal = starts;
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          if (ordinal === 1) {
            firstStarted.resolve();
            await new Promise<never>((_, reject) => {
              const rejectAbort = () => reject(new DOMException("pre-send owner gone", "AbortError"));
              if (input.preSendAbortSignal.aborted) rejectAbort();
              else input.preSendAbortSignal.addEventListener("abort", rejectAbort, { once: true });
            });
          }
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "dddddddd-eeee-4fff-8aaa-000000000001",
            acceptedUserTurnId: "user-retry",
          });
          return {
            canonicalConversationId: "dddddddd-eeee-4fff-8aaa-000000000001",
            acceptedUserTurnId: "user-retry",
            text: "fresh-pre-send-retry-ok",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const controller = new AbortController();
  const first = post(runtime, requestBody("pre-send-retry"), "goose-pre-send", controller.signal).catch(error => error);
  await firstStarted.promise;
  controller.abort();
  await first;
  const deadline = Date.now() + 2_000;
  while ((runtime.broker.getAccountSlotHolder() !== null || runtime.broker.getOpenTurnForSession("goose-pre-send") !== null) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
  expect(runtime.broker.getOpenTurnForSession("goose-pre-send")).toBeNull();

  const retry = await post(runtime, requestBody("pre-send-retry"), "goose-pre-send");
  expect(retry.status).toBe(200);
  expect(await retry.text()).toContain("fresh-pre-send-retry-ok");
  expect(starts).toBe(2);
  expect(runtime.broker.getCurrentEpoch("goose-pre-send")).toMatchObject({ epoch: 1, leaseState: "IDLE", historyWatermark: watermark(requestBody("pre-send-retry"), "fresh-pre-send-retry-ok") });
});

test("a queued transport owner disappearing behind two active sessions cannot poison FIFO", async () => {
  const aStarted = deferred<void>();
  const bStarted = deferred<void>();
  const dStarted = deferred<void>();
  const finishA = deferred<void>();
  const finishB = deferred<void>();
  const finishD = deferred<void>();
  const starts: string[] = [];
  const ids: Record<string, string> = {
    "goose-a": "eeeeeeee-ffff-4000-8aaa-000000000001",
    "goose-b": "eeeeeeee-ffff-4000-8aaa-000000000002",
    "goose-d": "eeeeeeee-ffff-4000-8aaa-000000000004",
  };
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts.push(input.gooseSessionId);
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: ids[input.gooseSessionId]!,
            acceptedUserTurnId: `user-${input.gooseSessionId}`,
          });
          if (input.gooseSessionId === "goose-a") { aStarted.resolve(); await finishA.promise; }
          else if (input.gooseSessionId === "goose-b") { bStarted.resolve(); await finishB.promise; }
          else if (input.gooseSessionId === "goose-d") { dStarted.resolve(); await finishD.promise; }
          return {
            canonicalConversationId: ids[input.gooseSessionId]!,
            acceptedUserTurnId: `user-${input.gooseSessionId}`,
            text: `answer-${input.gooseSessionId}`,
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const a = post(runtime, requestBody("a"), "goose-a");
  await aStarted.promise;
  const b = post(runtime, requestBody("b"), "goose-b");
  await bStarted.promise;

  const cAbort = new AbortController();
  const c = post(runtime, requestBody("c"), "goose-c", cAbort.signal).catch(error => error);
  const cQueueDeadline = Date.now() + 2_000;
  while (runtime.broker.getOpenTurnForSession("goose-c")?.state !== "QUEUED" && Date.now() < cQueueDeadline) await Bun.sleep(10);
  expect(runtime.broker.getOpenTurnForSession("goose-c")?.state).toBe("QUEUED");
  cAbort.abort();
  await c;
  const cCancelDeadline = Date.now() + 2_000;
  while (runtime.broker.getOpenTurnForSession("goose-c") !== null && Date.now() < cCancelDeadline) await Bun.sleep(10);
  expect(runtime.broker.getOpenTurnForSession("goose-c")).toBeNull();

  const d = post(runtime, requestBody("d"), "goose-d");
  const dQueueDeadline = Date.now() + 2_000;
  while (runtime.broker.getOpenTurnForSession("goose-d")?.state !== "QUEUED" && Date.now() < dQueueDeadline) await Bun.sleep(10);
  expect(starts).toEqual(["goose-a", "goose-b"]);
  finishA.resolve();
  await dStarted.promise;
  expect((await a).status).toBe(200);
  expect(starts).toEqual(["goose-a", "goose-b", "goose-d"]);

  finishB.resolve();
  finishD.resolve();
  expect((await b).status).toBe(200);
  const dResponse = await d;
  expect(dResponse.status).toBe(200);
  expect(await dResponse.text()).toContain("answer-goose-d");
  expect(runtime.broker.getActiveAccountSlotCount()).toBe(0);
});

test("runtime admits exactly two sessions while health reports active browser turns from zero through two", async () => {
  const started = { a: deferred<void>(), b: deferred<void>(), c: deferred<void>() };
  const finish = { a: deferred<void>(), b: deferred<void>(), c: deferred<void>() };
  const ids: Record<string, string> = {
    "goose-a": "ffffffff-1111-4000-8aaa-000000000001",
    "goose-b": "ffffffff-1111-4000-8aaa-000000000002",
    "goose-c": "ffffffff-1111-4000-8aaa-000000000003",
  };
  const starts: string[] = [];
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts.push(input.gooseSessionId);
      const key = input.gooseSessionId.at(-1) as "a" | "b" | "c";
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: ids[input.gooseSessionId]!,
            acceptedUserTurnId: `user-${input.gooseSessionId}`,
          });
          started[key].resolve();
          await finish[key].promise;
          return {
            canonicalConversationId: ids[input.gooseSessionId]!,
            acceptedUserTurnId: `user-${input.gooseSessionId}`,
            text: `answer-${input.gooseSessionId}`,
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  expect(await (await fetch(`${runtime.origin}/healthz`)).json()).toMatchObject({ active_browser_turns: 0 });

  const a = post(runtime, requestBody("a"), "goose-a");
  await started.a.promise;
  const b = post(runtime, requestBody("b"), "goose-b");
  await started.b.promise;
  expect(starts).toEqual(["goose-a", "goose-b"]);
  expect(await (await fetch(`${runtime.origin}/healthz`)).json()).toMatchObject({ active_browser_turns: 2 });

  const c = post(runtime, requestBody("c"), "goose-c");
  const cQueueDeadline = Date.now() + 2_000;
  while (runtime.broker.getOpenTurnForSession("goose-c")?.state !== "QUEUED" && Date.now() < cQueueDeadline) await Bun.sleep(10);
  expect(runtime.broker.getOpenTurnForSession("goose-c")?.state).toBe("QUEUED");
  expect(starts).toEqual(["goose-a", "goose-b"]);

  finish.a.resolve();
  await started.c.promise;
  expect((await a).status).toBe(200);
  expect(starts).toEqual(["goose-a", "goose-b", "goose-c"]);
  expect(await (await fetch(`${runtime.origin}/healthz`)).json()).toMatchObject({ active_browser_turns: 2 });

  finish.b.resolve();
  expect((await b).status).toBe(200);
  expect(await (await fetch(`${runtime.origin}/healthz`)).json()).toMatchObject({ active_browser_turns: 1 });
  finish.c.resolve();
  expect((await c).status).toBe(200);
  expect(await (await fetch(`${runtime.origin}/healthz`)).json()).toMatchObject({ active_browser_turns: 0 });
});

test("provider restart rebinds the same Goose turn to the same ChatGPT conversation on exact request replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-restart-"));
  roots.push(root);
  const brokerPath = join(root, "broker.sqlite");
  const authorizationFile = join(root, "connector-auth.txt");
  const authorization = `Bearer ${"z".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const body = requestBody("restart");
  const checkpoint = gooseResponsesProjectionCheckpoint(body);
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000777";
  const seed = new SessionBroker(brokerPath, {
    projectId: "project-restart",
    instanceId: "seed",
    terminalReplayWindowMs: 60_000,
    makeTurnRef: () => "turn-restart",
    makeSubmitNonce: () => "nonce-restart",
    makeOpRef: () => "op-restart",
  });
  seed.createEpoch({ gooseSessionId: "goose-restart" });
  const seeded = seed.enqueueTurn({
    gooseSessionId: "goose-restart",
    requestHash: checkpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
  });
  seed.admitNext();
  seed.markSendActivated(seeded.turnRef);
  seed.bindConversation({ gooseSessionId: "goose-restart", epoch: 1, conversationId });
  seed.markAccepted(seeded.turnRef, "user-restart");
  seed.close();

  let browserStarts = 0;
  let rebound = 0;
  let sends = 0;
  const runtime = startRebuildProviderRuntime({
    port: 0,
    model: "gpt-4.1",
    contextWindow: 200_000,
    controlToken: "control-token",
    projectId: "project-restart",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath,
    terminalReplayWindowMs: 60_000,
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: {
      createTurn(input) {
        browserStarts += 1;
        expect(input.prompt).toBe("");
        expect(input.existingConversationId).toBe(conversationId);
        expect(input.resumeAccepted).toEqual({
          canonicalConversationId: conversationId,
          acceptedUserTurnId: "user-restart",
        });
        return {
          captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
          confirmFinal: async evidence => evidence,
          run: async () => {
            sends += 0;
            await input.lifecycle.onRebound?.({
              canonicalConversationId: conversationId,
              acceptedUserTurnId: "user-restart",
            });
            rebound += 1;
            return {
              canonicalConversationId: conversationId,
              acceptedUserTurnId: "user-restart",
              text: "rebound-final",
              remoteNonRunning: true,
            };
          },
        };
      },
    },
  });
  runtimes.push(runtime);
  expect(runtime.broker.getTurn("turn-restart")?.state).toBe("UNRECONCILED");
  expect(runtime.broker.getAccountSlotHolder()).toBe("turn-restart");

  const response = await post(runtime, body, "goose-restart");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("rebound-final");
  expect(browserStarts).toBe(1);
  expect(rebound).toBe(1);
  expect(sends).toBe(0);
  expect(runtime.broker.getTurn("turn-restart")?.state).toBe("COMPLETE");
  expect(runtime.broker.getCurrentEpoch("goose-restart")).toMatchObject({
    conversationId,
    leaseState: "IDLE",
  });
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
});

test("provider restart completes an already-accepted post-tool final without resending or replaying tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-final-recovery-"));
  roots.push(root);
  const brokerPath = join(root, "broker.sqlite");
  const authorizationFile = join(root, "connector-auth.txt");
  const authorization = `Bearer ${"f".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const initial = requestBody("accepted-final-recovery");
  const initialCheckpoint = gooseResponsesProjectionCheckpoint(initial);
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000797";
  const finalText = "accepted-final-before-restart";
  const finalTextDigest = createHash("sha256").update(finalText, "utf8").digest("hex");
  const seed = new SessionBroker(brokerPath, {
    projectId: "project-final-recovery",
    instanceId: "seed",
    terminalReplayWindowMs: 60_000,
    makeTurnRef: () => "turn-final-recovery",
    makeSubmitNonce: () => "nonce-final-recovery",
    makeOpRef: (() => {
      const refs = ["op-final-recovery", "op-final-recovery-next"];
      return () => refs.shift() ?? "op-final-recovery-extra";
    })(),
  });
  seed.createEpoch({ gooseSessionId: "goose-final-recovery" });
  const seeded = seed.enqueueTurn({
    gooseSessionId: "goose-final-recovery",
    requestHash: initialCheckpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(initialCheckpoint),
  });
  const admitted = seed.admitNext()!;
  seed.markSendActivated(seeded.turnRef);
  seed.bindConversation({ gooseSessionId: "goose-final-recovery", epoch: 1, conversationId });
  seed.markAccepted(seeded.turnRef, "user-final-recovery");
  seed.recordAnswerBoundary(seeded.turnRef, admitted.initialOpRef, '{"text":"before-tool"}');
  const toolArguments = { path: "." };
  const inputHash = connectorOperationInputHash("tree", toolArguments);
  seed.claimOperation({ turnRef: seeded.turnRef, opRef: admitted.initialOpRef, inputHash });
  const continuation = continuationBody(initial, admitted.initialOpRef, "known-tool-result");
  const continuationCheckpoint = gooseResponsesProjectionCheckpoint(continuation);
  seed.completeOperationWithProgress({
    turnRef: seeded.turnRef,
    opRef: admitted.initialOpRef,
    inputHash,
    outcome: "SUCCESS",
    resultJson: prepareConnectorTerminalResult({
      outcome: "SUCCESS", dataClass: "task", content: "known-tool-result",
    }).resultJson,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(continuationCheckpoint),
  });
  seed.recordFinalDigest(seeded.turnRef, finalTextDigest);
  seed.close();

  let browserStarts = 0;
  let rebounds = 0;
  let confirmations = 0;
  const runtime = startRebuildProviderRuntime({
    port: 0,
    model: "gpt-4.1",
    contextWindow: 200_000,
    controlToken: "control-token",
    projectId: "project-final-recovery",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath,
    terminalReplayWindowMs: 60_000,
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: {
      createTurn(input) {
        browserStarts += 1;
        expect(input.prompt).toBe("");
        expect(input.existingConversationId).toBe(conversationId);
        expect(input.resumeAccepted).toEqual({
          canonicalConversationId: conversationId,
          acceptedUserTurnId: "user-final-recovery",
          finalRecoveryOnly: true,
        });
        return {
          captureAnswerBoundary: async () => { throw new Error("historical tool must not replay"); },
          confirmFinal: async evidence => {
            confirmations += 1;
            return evidence;
          },
          run: async () => {
            await input.lifecycle.onRebound?.({
              canonicalConversationId: conversationId,
              acceptedUserTurnId: "user-final-recovery",
            });
            rebounds += 1;
            return {
              canonicalConversationId: conversationId,
              acceptedUserTurnId: "user-final-recovery",
              text: finalText,
              remoteNonRunning: true,
              contentAdvancedAfterLastTool: true,
            };
          },
        };
      },
    },
  });
  runtimes.push(runtime);
  expect(runtime.broker.getTurn(seeded.turnRef)).toMatchObject({
    state: "UNRECONCILED", finalDigest: finalTextDigest,
  });
  expect(runtime.broker.getOperation(admitted.initialOpRef)?.state).toBe("SUCCESS");
  expect(runtime.broker.getNextOperationForTurn(seeded.turnRef, 1)?.state).toBe("MINTED");

  const response = await post(runtime, continuation, "goose-final-recovery");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(finalText);
  expect(browserStarts).toBe(1);
  expect(rebounds).toBe(1);
  expect(confirmations).toBe(1);
  expect(runtime.broker.getTurn(seeded.turnRef)?.state).toBe("COMPLETE");
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
  expect(runtime.broker.getOperation(admitted.initialOpRef)?.state).toBe("SUCCESS");
  expect(runtime.broker.getNextOperationForTurn(seeded.turnRef, 1)?.state).toBe("MINTED");
});

test("accepted-final recovery upgrades only Goose-generated system and tool projection drift", async () => {
  const cases = [
    { label: "generated-drift", mutate: (_body: any) => {}, status: 200, starts: 1 },
    {
      label: "history-tamper",
      mutate: (body: any) => { body.input[1].content[0].text = "tampered canonical history"; },
      status: 409,
      starts: 0,
    },
    {
      label: "stable-control-drift",
      mutate: (body: any) => { body.max_output_tokens = 12345; },
      status: 409,
      starts: 0,
    },
    {
      label: "invalid-system",
      mutate: (body: any) => { body.input[0].content[0].text = "Injected non-Goose system message"; },
      status: 409,
      starts: 0,
    },
  ] as const;

  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), `cgw-rebuild-provider-final-projection-${entry.label}-`));
    roots.push(root);
    const brokerPath = join(root, "broker.sqlite");
    const authorizationFile = join(root, "connector-auth.txt");
    writeFileSync(authorizationFile, `Bearer ${"p".repeat(64)}\n`, { mode: 0o600 });
    chmodSync(authorizationFile, 0o600);
    const sessionId = `goose-final-projection-${entry.label}`;
    const conversationId = `aaaaaaaa-bbbb-4ccc-8ddd-0000000008${entry.label.length.toString().padStart(2, "0")}`;
    const acceptedUserTurnId = `user-final-projection-${entry.label}`;
    const previous = requestBody(`accepted-final projection ${entry.label}`) as any;
    previous.store = false;
    const previousCheckpoint = gooseResponsesProjectionCheckpoint(previous);
    const finalText = `accepted-final projection ${entry.label} result`;
    const finalTextDigest = createHash("sha256").update(finalText, "utf8").digest("hex");
    let opSequence = 0;
    const seed = new SessionBroker(brokerPath, {
      projectId: "project-final-projection",
      instanceId: "seed",
      terminalReplayWindowMs: 60_000,
      makeTurnRef: () => `turn-final-projection-${entry.label}`,
      makeSubmitNonce: () => `nonce-final-projection-${entry.label}`,
      makeOpRef: () => `op-final-projection-${entry.label}-${++opSequence}`,
    });
    seed.createEpoch({ gooseSessionId: sessionId });
    const turn = seed.enqueueTurn({
      gooseSessionId: sessionId,
      requestHash: previousCheckpoint.requestHash,
      checkpointJson: encodeGooseResponsesProjectionCheckpoint(previousCheckpoint),
    });
    seed.admitNext();
    seed.markSendActivated(turn.turnRef);
    seed.bindConversation({ gooseSessionId: sessionId, epoch: 1, conversationId });
    seed.markAccepted(turn.turnRef, acceptedUserTurnId);
    seed.recordFinalDigest(turn.turnRef, finalTextDigest);
    seed.close();

    const resumed = structuredClone(previous);
    resumed.input[0].content[0].text = "You are a general-purpose AI agent called goose, created by AAIF. Regenerated by a newer Goose runtime.";
    resumed.tools = [...resumed.tools, { type: "function", name: "shell", parameters: { type: "object" } }];
    entry.mutate(resumed);
    const currentCheckpoint = gooseResponsesProjectionCheckpoint(resumed);
    let browserStarts = 0;
    const runtime = startRebuildProviderRuntime({
      port: 0,
      model: "gpt-4.1",
      contextWindow: 200_000,
      controlToken: "control-token",
      projectId: "project-final-projection",
      connectorIdentity: "Goose Native 2nd Shift",
      brokerPath,
      terminalReplayWindowMs: 60_000,
      connectorPort: 0,
      connectorAuthorizationFile: authorizationFile,
      browserDriver: {
        createTurn(input) {
          browserStarts += 1;
          expect(input.prompt).toBe("");
          expect(input.resumeAccepted?.finalRecoveryOnly).toBeTrue();
          return {
            captureAnswerBoundary: async () => { throw new Error("accepted-final recovery must not replay tools"); },
            confirmFinal: async evidence => evidence,
            run: async () => {
              await input.lifecycle.onRebound?.({ canonicalConversationId: conversationId, acceptedUserTurnId });
              return {
                canonicalConversationId: conversationId,
                acceptedUserTurnId,
                text: finalText,
                remoteNonRunning: true,
              };
            },
          };
        },
      },
    });
    runtimes.push(runtime);

    const response = await post(runtime, resumed, sessionId);
    expect(response.status).toBe(entry.status);
    expect(browserStarts).toBe(entry.starts);
    const recovered = runtime.broker.getTurn(turn.turnRef)!;
    if (entry.status === 200) {
      expect(await response.text()).toContain(finalText);
      expect(recovered.state).toBe("COMPLETE");
      expect(decodeGooseResponsesProjectionCheckpoint(recovered.checkpointJson)).toEqual(currentCheckpoint);
      expect(runtime.broker.getAccountSlotHolder()).toBeNull();
    } else {
      expect((await response.json() as any).error.code).toBe("rebind_request_conflict");
      expect(recovered.state).toBe("UNRECONCILED");
      expect(decodeGooseResponsesProjectionCheckpoint(recovered.checkpointJson)).toEqual(previousCheckpoint);
      expect(runtime.broker.getAccountSlotHolder()).toBe(turn.turnRef);
    }
  }
});

test("accepted-final recovery fails closed when the reopened final no longer matches its durable digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-final-drift-"));
  roots.push(root);
  const brokerPath = join(root, "broker.sqlite");
  const authorizationFile = join(root, "connector-auth.txt");
  const authorization = `Bearer ${"d".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const body = requestBody("accepted-final-drift");
  const checkpoint = gooseResponsesProjectionCheckpoint(body);
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000798";
  const seed = new SessionBroker(brokerPath, {
    projectId: "project-final-drift",
    instanceId: "seed",
    terminalReplayWindowMs: 60_000,
    makeTurnRef: () => "turn-final-drift",
    makeSubmitNonce: () => "nonce-final-drift",
    makeOpRef: () => "op-final-drift",
  });
  seed.createEpoch({ gooseSessionId: "goose-final-drift" });
  const seeded = seed.enqueueTurn({
    gooseSessionId: "goose-final-drift",
    requestHash: checkpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
  });
  seed.admitNext();
  seed.markSendActivated(seeded.turnRef);
  seed.bindConversation({ gooseSessionId: "goose-final-drift", epoch: 1, conversationId });
  seed.markAccepted(seeded.turnRef, "user-final-drift");
  seed.recordFinalDigest(
    seeded.turnRef,
    createHash("sha256").update("durable-final", "utf8").digest("hex"),
  );
  seed.close();

  let sends = 0;
  const runtime = startRebuildProviderRuntime({
    port: 0,
    model: "gpt-4.1",
    contextWindow: 200_000,
    controlToken: "control-token",
    projectId: "project-final-drift",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath,
    terminalReplayWindowMs: 60_000,
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: {
      createTurn(input) {
        return {
          captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
          confirmFinal: async evidence => evidence,
          run: async () => {
            sends += 0;
            await input.lifecycle.onRebound?.({
              canonicalConversationId: conversationId,
              acceptedUserTurnId: "user-final-drift",
            });
            return {
              canonicalConversationId: conversationId,
              acceptedUserTurnId: "user-final-drift",
              text: "different-final",
              remoteNonRunning: true,
            };
          },
        };
      },
    },
  });
  runtimes.push(runtime);
  const response = await post(runtime, body, "goose-final-drift");
  expect(response.status).toBe(409);
  expect(sends).toBe(0);
  expect(runtime.broker.getTurn(seeded.turnRef)?.state).toBe("UNRECONCILED");
  expect(runtime.broker.getAccountSlotHolder()).toBe(seeded.turnRef);
});

test("provider restart rebinds from the latest durable tool-continuation checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-restart-continuation-"));
  roots.push(root);
  const brokerPath = join(root, "broker.sqlite");
  const authorizationFile = join(root, "connector-auth.txt");
  const authorization = `Bearer ${"r".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const initial = requestBody("restart-continuation");
  const initialCheckpoint = gooseResponsesProjectionCheckpoint(initial);
  const continuation = continuationBody(initial, "op-restart-continuation", "known-tool-result");
  const continuationCheckpoint = gooseResponsesProjectionCheckpoint(continuation);
  expect(continuationCheckpoint.requestHash).not.toBe(initialCheckpoint.requestHash);
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000778";
  const seed = new SessionBroker(brokerPath, {
    projectId: "project-restart-continuation",
    instanceId: "seed",
    terminalReplayWindowMs: 60_000,
    makeTurnRef: () => "turn-restart-continuation",
    makeSubmitNonce: () => "nonce-restart-continuation",
    makeOpRef: () => "op-seed-restart-continuation",
  });
  seed.createEpoch({ gooseSessionId: "goose-restart-continuation" });
  const seeded = seed.enqueueTurn({
    gooseSessionId: "goose-restart-continuation",
    requestHash: initialCheckpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(initialCheckpoint),
  });
  seed.admitNext();
  seed.markSendActivated(seeded.turnRef);
  seed.bindConversation({ gooseSessionId: "goose-restart-continuation", epoch: 1, conversationId });
  seed.markAccepted(seeded.turnRef, "user-restart-continuation");
  seed.recordProgress(seeded.turnRef, encodeGooseResponsesProjectionCheckpoint(continuationCheckpoint));
  seed.close();

  let browserStarts = 0;
  const runtime = startRebuildProviderRuntime({
    port: 0,
    model: "gpt-4.1",
    contextWindow: 200_000,
    controlToken: "control-token",
    projectId: "project-restart-continuation",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath,
    terminalReplayWindowMs: 60_000,
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: {
      createTurn(input) {
        browserStarts += 1;
        expect(input.prompt).toBe("");
        expect(input.existingConversationId).toBe(conversationId);
        expect(input.resumeAccepted).toEqual({
          canonicalConversationId: conversationId,
          acceptedUserTurnId: "user-restart-continuation",
        });
        return {
          captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
          confirmFinal: async evidence => evidence,
          run: async () => {
            await input.lifecycle.onRebound?.({
              canonicalConversationId: conversationId,
              acceptedUserTurnId: "user-restart-continuation",
            });
            return {
              canonicalConversationId: conversationId,
              acceptedUserTurnId: "user-restart-continuation",
              text: "rebound-from-continuation",
              remoteNonRunning: true,
            };
          },
        };
      },
    },
  });
  runtimes.push(runtime);
  expect(runtime.broker.getTurn(seeded.turnRef)?.state).toBe("UNRECONCILED");

  const staleInitial = await post(runtime, initial, "goose-restart-continuation");
  expect(staleInitial.status).toBe(409);
  expect(await staleInitial.text()).toContain("rebind_request_conflict");
  expect(browserStarts).toBe(0);

  const response = await post(runtime, continuation, "goose-restart-continuation");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("rebound-from-continuation");
  expect(browserStarts).toBe(1);
  expect(runtime.broker.getTurn(seeded.turnRef)?.state).toBe("COMPLETE");
});


test("provider restart recovers an exact durable terminal-tool continuation without replaying the tool", async () => {
  const cases = [
    { label: "exact", mutate: (_body: ReturnType<typeof continuationBody>) => {}, status: 200, starts: 1, release: true, code: "" },
    {
      label: "tampered-call",
      mutate: (body: ReturnType<typeof continuationBody>) => {
        (body.input.at(-2) as any).arguments = '{"action":"disable","extension_name":"orchestrator"}';
      },
      status: 409,
      starts: 0,
      release: true,
      code: "rebind_request_conflict",
    },
    {
      label: "tampered-output",
      mutate: (body: ReturnType<typeof continuationBody>) => {
        (body.input.at(-1) as any).output = "tampered-result";
      },
      status: 409,
      starts: 0,
      release: true,
      code: "rebind_request_conflict",
    },
    {
      label: "tampered-prefix",
      mutate: (body: ReturnType<typeof continuationBody>) => {
        (body.input[1] as any).content[0].text = "tampered prior user";
      },
      status: 409,
      starts: 0,
      release: true,
      code: "rebind_request_conflict",
    },
    {
      label: "tampered-stable-field",
      mutate: (body: ReturnType<typeof continuationBody>) => {
        (body as any).max_output_tokens = 2048;
      },
      status: 409,
      starts: 0,
      release: true,
      code: "rebind_request_conflict",
    },
    {
      label: "missing-positive-terminal",
      mutate: (_body: ReturnType<typeof continuationBody>) => {},
      status: 409,
      starts: 0,
      release: false,
      code: "rebind_recovery_precondition",
    },
  ] as const;

  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-recovered-terminal-" + entry.label + "-"));
    roots.push(root);
    const brokerPath = join(root, "broker.sqlite");
    const authorizationFile = join(root, "connector-auth.txt");
    const authorization = "Bearer " + "t".repeat(64);
    writeFileSync(authorizationFile, authorization + "\n", { mode: 0o600 });
    chmodSync(authorizationFile, 0o600);

    const sessionId = "goose-recovered-terminal-" + entry.label;
    const conversationId = entry.label === "exact"
      ? "aaaaaaaa-bbbb-4ccc-8ddd-000000000801"
      : entry.label === "tampered-call"
        ? "aaaaaaaa-bbbb-4ccc-8ddd-000000000802"
        : entry.label === "tampered-output"
          ? "aaaaaaaa-bbbb-4ccc-8ddd-000000000803"
          : entry.label === "tampered-prefix"
            ? "aaaaaaaa-bbbb-4ccc-8ddd-000000000804"
            : entry.label === "tampered-stable-field"
              ? "aaaaaaaa-bbbb-4ccc-8ddd-000000000805"
              : "aaaaaaaa-bbbb-4ccc-8ddd-000000000806";
    const acceptedUserTurnId = "user-recovered-terminal-" + entry.label;
    const previous = requestBody("recovered-terminal-" + entry.label);
    (previous as any).store = false;
    (previous as any).max_output_tokens = 1024;
    const previousCheckpoint = gooseResponsesProjectionCheckpoint(previous);
    let opSequence = 0;
    const seed = new SessionBroker(brokerPath, {
      projectId: "project-recovered-terminal",
      instanceId: "seed",
      terminalReplayWindowMs: 60_000,
      makeTurnRef: () => "turn-recovered-terminal-" + entry.label,
      makeSubmitNonce: () => "nonce-recovered-terminal-" + entry.label,
      makeOpRef: () => "op-recovered-terminal-" + entry.label + "-" + String(++opSequence),
    });
    seed.createEpoch({ gooseSessionId: sessionId });
    const turn = seed.enqueueTurn({
      gooseSessionId: sessionId,
      requestHash: previousCheckpoint.requestHash,
      checkpointJson: encodeGooseResponsesProjectionCheckpoint(previousCheckpoint),
    });
    const admitted = seed.admitNext()!;
    seed.markSendActivated(turn.turnRef);
    seed.bindConversation({ gooseSessionId: sessionId, epoch: 1, conversationId });
    seed.markAccepted(turn.turnRef, acceptedUserTurnId);
    seed.recordAnswerBoundary(turn.turnRef, admitted.initialOpRef, '{"chars":1}');
    const extensionArgs = { action: "enable", extension_name: "orchestrator" };
    const inputHash = connectorOperationInputHash("extensionmanager__manage_extensions", extensionArgs);
    expect(seed.claimOperation({
      turnRef: turn.turnRef,
      opRef: admitted.initialOpRef,
      inputHash,
    }).kind).toBe("EXECUTE");
    const terminal = prepareConnectorTerminalResult({
      outcome: "SUCCESS",
      dataClass: "task",
      content: "known-tool-result",
    });
    seed.completeOperation({
      opRef: admitted.initialOpRef,
      inputHash,
      outcome: terminal.outcome,
      resultJson: terminal.resultJson,
    });
    // Model the crash window Pair A hit: the connector result is durable, but the next
    // Responses continuation never atomically advanced checkpoint_json before restart.
    seed.markUnreconciled(turn.turnRef, "restart_after_terminal_tool_before_progress_checkpoint");
    if (entry.release) {
      seed.releaseSlotAfterPositiveTerminal(turn.turnRef, {
        canonicalConversationId: conversationId,
        acceptedUserTurnId,
        remoteUiNonRunningAcrossQualifiedSettle: true,
        noUnresolvedGooseWork: true,
        noContradictoryActivity: true,
      });
    }
    seed.close();

    const continuation = continuationBody(previous, admitted.initialOpRef, "known-tool-result");
    const recoveredCall = continuation.input.at(-2) as any;
    recoveredCall.name = "extensionmanager__manage_extensions";
    recoveredCall.arguments = '{"action":"enable","extension_name":"orchestrator"}';
    // Enabling an extension can legitimately change both the system projection and advertised
    // tool registry before Goose sends the already-durable tool continuation.
    (continuation.input[0] as any).content[0].text = "system after extension change";
    continuation.tools = [
      ...continuation.tools,
      { type: "function", name: "orchestrator", parameters: { type: "object" } },
    ];
    entry.mutate(continuation);

    let browserStarts = 0;
    const runtime = startRebuildProviderRuntime({
      port: 0,
      model: "gpt-4.1",
      contextWindow: 200_000,
      controlToken: "control-token",
      projectId: "project-recovered-terminal",
      connectorIdentity: "Goose Native 2nd Shift",
      brokerPath,
      terminalReplayWindowMs: 60_000,
      connectorPort: 0,
      connectorAuthorizationFile: authorizationFile,
      browserDriver: {
        createTurn(input) {
          browserStarts += 1;
          expect(input.prompt).toBe("");
          expect(input.existingConversationId).toBe(conversationId);
          expect(input.resumeAccepted).toEqual({
            canonicalConversationId: conversationId,
            acceptedUserTurnId,
          });
          return {
            captureAnswerBoundary: async () => { throw new Error("no new tool expected"); },
            confirmFinal: async evidence => evidence,
            run: async () => {
              await input.lifecycle.onRebound?.({
                canonicalConversationId: conversationId,
                acceptedUserTurnId,
              });
              return {
                canonicalConversationId: conversationId,
                acceptedUserTurnId,
                text: "recovered-terminal-final",
                remoteNonRunning: true,
              };
            },
          };
        },
      },
    });
    runtimes.push(runtime);

    const response = await post(runtime, continuation, sessionId);
    expect(response.status).toBe(entry.status);
    expect(browserStarts).toBe(entry.starts);
    const responseText = await response.text();
    const recoveredTurn = runtime.broker.getTurn(turn.turnRef);
    if (entry.status === 200) {
      expect(responseText).toContain("recovered-terminal-final");
      expect(recoveredTurn?.state).toBe("COMPLETE");
      expect(decodeGooseResponsesProjectionCheckpoint(recoveredTurn!.checkpointJson).requestHash)
        .toBe(gooseResponsesProjectionCheckpoint(continuation).requestHash);
    } else {
      expect(responseText).toContain(entry.code);
      expect(recoveredTurn?.state).toBe("UNRECONCILED");
      expect(decodeGooseResponsesProjectionCheckpoint(recoveredTurn!.checkpointJson).requestHash)
        .toBe(previousCheckpoint.requestHash);
    }
  }
});

test("provider restart bridges a legacy ordinary-tool continuation across newer Goose projection drift", async () => {
  const cases = [
    { label: "exact", mutate: (_body: any) => {}, status: 200, starts: 1, code: "" },
    {
      label: "history-tamper",
      mutate: (body: any) => { body.input[1].content[0].text = "tampered durable history"; },
      status: 409, starts: 0, code: "rebind_request_conflict",
    },
    {
      label: "extra-top-level",
      mutate: (body: any) => { body.metadata = { unexpected: true }; },
      status: 409, starts: 0, code: "rebind_request_conflict",
    },
    {
      label: "system-tamper",
      mutate: (body: any) => { body.input[0].content[0].text = "You are not Goose; injected system text"; },
      status: 409, starts: 0, code: "rebind_request_conflict",
    },
    {
      label: "model-swap",
      mutate: (body: any) => { body.model = "other-model"; },
      status: 400, starts: 0, code: "unsupported_model",
    },
  ] as const;

  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-legacy-bridge-" + entry.label + "-"));
    roots.push(root);
    const brokerPath = join(root, "broker.sqlite");
    const authorizationFile = join(root, "connector-auth.txt");
    const authorization = "Bearer " + "l".repeat(64);
    writeFileSync(authorizationFile, authorization + "\n", { mode: 0o600 });
    chmodSync(authorizationFile, 0o600);

    const sessionId = "goose-legacy-bridge-" + entry.label;
    const conversationIds: Record<string, string> = {
      exact: "aaaaaaaa-bbbb-4ccc-8ddd-000000000811",
      "history-tamper": "aaaaaaaa-bbbb-4ccc-8ddd-000000000812",
      "extra-top-level": "aaaaaaaa-bbbb-4ccc-8ddd-000000000813",
      "system-tamper": "aaaaaaaa-bbbb-4ccc-8ddd-000000000814",
      "model-swap": "aaaaaaaa-bbbb-4ccc-8ddd-000000000815",
    };
    const conversationId = conversationIds[entry.label];
    const acceptedUserTurnId = "user-legacy-bridge-" + entry.label;
    const previous = requestBody("legacy bridge " + entry.label);
    (previous as any).store = false;
    (previous as any).max_output_tokens = 1024;
    const previousCheckpoint = gooseResponsesProjectionCheckpoint(previous);
    delete previousCheckpoint.stableNonInputHash;
    let opSequence = 0;
    const seed = new SessionBroker(brokerPath, {
      projectId: "project-legacy-bridge",
      instanceId: "seed",
      terminalReplayWindowMs: 60_000,
      makeTurnRef: () => "turn-legacy-bridge-" + entry.label,
      makeSubmitNonce: () => "nonce-legacy-bridge-" + entry.label,
      makeOpRef: () => "op-legacy-bridge-" + entry.label + "-" + String(++opSequence),
    });
    seed.createEpoch({ gooseSessionId: sessionId });
    const turn = seed.enqueueTurn({
      gooseSessionId: sessionId,
      requestHash: previousCheckpoint.requestHash,
      checkpointJson: encodeGooseResponsesProjectionCheckpoint(previousCheckpoint),
    });
    const admitted = seed.admitNext()!;
    seed.markSendActivated(turn.turnRef);
    seed.bindConversation({ gooseSessionId: sessionId, epoch: 1, conversationId });
    seed.markAccepted(turn.turnRef, acceptedUserTurnId);
    seed.recordAnswerBoundary(turn.turnRef, admitted.initialOpRef, '{"chars":1}');
    const inputHash = connectorOperationInputHash("tree", { path: "." });
    expect(seed.claimOperation({ turnRef: turn.turnRef, opRef: admitted.initialOpRef, inputHash }).kind).toBe("EXECUTE");
    const terminal = prepareConnectorTerminalResult({ outcome: "SUCCESS", dataClass: "task", content: "known-tool-result" });
    seed.completeOperation({
      opRef: admitted.initialOpRef,
      inputHash,
      outcome: terminal.outcome,
      resultJson: terminal.resultJson,
    });
    seed.markUnreconciled(turn.turnRef, "legacy_restart_after_terminal_tool");
    seed.releaseSlotAfterPositiveTerminal(turn.turnRef, {
      canonicalConversationId: conversationId,
      acceptedUserTurnId,
      remoteUiNonRunningAcrossQualifiedSettle: true,
      noUnresolvedGooseWork: true,
      noContradictoryActivity: true,
    });
    seed.close();

    const continuation = continuationBody(previous, admitted.initialOpRef, "known-tool-result") as any;
    continuation.input[0].content[0].text = "You are a general-purpose AI agent called goose, created by AAIF. Regenerated by a newer Goose runtime.";
    continuation.tools = [
      ...continuation.tools,
      { type: "function", name: "shell", parameters: { type: "object" } },
    ];
    entry.mutate(continuation);

    let browserStarts = 0;
    const runtime = startRebuildProviderRuntime({
      port: 0,
      model: "gpt-4.1",
      contextWindow: 200_000,
      controlToken: "control-token",
      projectId: "project-legacy-bridge",
      connectorIdentity: "Goose Native 2nd Shift",
      brokerPath,
      terminalReplayWindowMs: 60_000,
      connectorPort: 0,
      connectorAuthorizationFile: authorizationFile,
      browserDriver: {
        createTurn(input) {
          browserStarts += 1;
          expect(input.prompt).toBe("");
          expect(input.existingConversationId).toBe(conversationId);
          return {
            captureAnswerBoundary: async () => { throw new Error("no new tool expected"); },
            confirmFinal: async evidence => evidence,
            run: async () => {
              await input.lifecycle.onRebound?.({ canonicalConversationId: conversationId, acceptedUserTurnId });
              return {
                canonicalConversationId: conversationId,
                acceptedUserTurnId,
                text: "legacy-bridge-final",
                remoteNonRunning: true,
              };
            },
          };
        },
      },
    });
    runtimes.push(runtime);

    const response = await post(runtime, continuation, sessionId);
    expect(response.status).toBe(entry.status);
    expect(browserStarts).toBe(entry.starts);
    const responseText = await response.text();
    const recoveredTurn = runtime.broker.getTurn(turn.turnRef)!;
    if (entry.status === 200) {
      expect(responseText).toContain("legacy-bridge-final");
      expect(recoveredTurn.state).toBe("COMPLETE");
      const upgraded = decodeGooseResponsesProjectionCheckpoint(recoveredTurn.checkpointJson);
      expect(upgraded.inputCount).toBe(previousCheckpoint.inputCount + 2);
      expect(upgraded.stableNonInputHash).toMatch(/^[a-f0-9]{64}$/);
    } else {
      expect(responseText).toContain(entry.code);
      expect(recoveredTurn.state).toBe("UNRECONCILED");
      const retained = decodeGooseResponsesProjectionCheckpoint(recoveredTurn.checkpointJson);
      expect(retained.stableNonInputHash).toBeUndefined();
      expect(retained.requestHash).toBe(previousCheckpoint.requestHash);
    }
  }
});

test("overlapping legacy recovery retries share one browser execution and one upgraded checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-legacy-overlap-"));
  roots.push(root);
  const brokerPath = join(root, "broker.sqlite");
  const authorizationFile = join(root, "connector-auth.txt");
  writeFileSync(authorizationFile, "Bearer " + "o".repeat(64) + "\n", { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const sessionId = "goose-legacy-overlap";
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000816";
  const acceptedUserTurnId = "user-legacy-overlap";
  const previous = requestBody("legacy overlap");
  (previous as any).store = false;
  (previous as any).max_output_tokens = 1024;
  const previousCheckpoint = gooseResponsesProjectionCheckpoint(previous);
  delete previousCheckpoint.stableNonInputHash;
  let opSequence = 0;
  const seed = new SessionBroker(brokerPath, {
    projectId: "project-legacy-overlap",
    instanceId: "seed",
    terminalReplayWindowMs: 60_000,
    makeTurnRef: () => "turn-legacy-overlap",
    makeSubmitNonce: () => "nonce-legacy-overlap",
    makeOpRef: () => "op-legacy-overlap-" + String(++opSequence),
  });
  seed.createEpoch({ gooseSessionId: sessionId });
  const turn = seed.enqueueTurn({
    gooseSessionId: sessionId,
    requestHash: previousCheckpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(previousCheckpoint),
  });
  const admitted = seed.admitNext()!;
  seed.markSendActivated(turn.turnRef);
  seed.bindConversation({ gooseSessionId: sessionId, epoch: 1, conversationId });
  seed.markAccepted(turn.turnRef, acceptedUserTurnId);
  seed.recordAnswerBoundary(turn.turnRef, admitted.initialOpRef, '{"chars":1}');
  const inputHash = connectorOperationInputHash("tree", { path: "." });
  expect(seed.claimOperation({ turnRef: turn.turnRef, opRef: admitted.initialOpRef, inputHash }).kind).toBe("EXECUTE");
  const terminal = prepareConnectorTerminalResult({ outcome: "SUCCESS", dataClass: "task", content: "known-tool-result" });
  seed.completeOperation({ opRef: admitted.initialOpRef, inputHash, outcome: terminal.outcome, resultJson: terminal.resultJson });
  seed.markUnreconciled(turn.turnRef, "legacy_overlap_restart");
  seed.releaseSlotAfterPositiveTerminal(turn.turnRef, {
    canonicalConversationId: conversationId,
    acceptedUserTurnId,
    remoteUiNonRunningAcrossQualifiedSettle: true,
    noUnresolvedGooseWork: true,
    noContradictoryActivity: true,
  });
  seed.close();

  const continuation = continuationBody(previous, admitted.initialOpRef, "known-tool-result") as any;
  continuation.input[0].content[0].text = "You are a general-purpose AI agent called goose, created by AAIF. Regenerated by a newer Goose runtime.";
  continuation.tools = [...continuation.tools, { type: "function", name: "shell", parameters: { type: "object" } }];
  const started = deferred<void>();
  const finish = deferred<void>();
  let browserStarts = 0;
  const runtime = startRebuildProviderRuntime({
    port: 0,
    model: "gpt-4.1",
    contextWindow: 200_000,
    controlToken: "control-token",
    projectId: "project-legacy-overlap",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath,
    terminalReplayWindowMs: 60_000,
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: {
      createTurn(input) {
        browserStarts += 1;
        return {
          captureAnswerBoundary: async () => { throw new Error("no new tool expected"); },
          confirmFinal: async evidence => evidence,
          run: async () => {
            await input.lifecycle.onRebound?.({ canonicalConversationId: conversationId, acceptedUserTurnId });
            started.resolve();
            await finish.promise;
            return { canonicalConversationId: conversationId, acceptedUserTurnId, text: "legacy-overlap-final", remoteNonRunning: true };
          },
        };
      },
    },
  });
  runtimes.push(runtime);

  const first = post(runtime, continuation, sessionId);
  await started.promise;
  const duplicate = await post(runtime, continuation, sessionId);
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json() as any).error.code).toBe("STAGE_ALREADY_OPEN");
  expect(browserStarts).toBe(1);
  finish.resolve();
  const completed = await first;
  expect(completed.status).toBe(200);
  expect(await completed.text()).toContain("legacy-overlap-final");
  expect(browserStarts).toBe(1);
  const finalTurn = runtime.broker.getTurn(turn.turnRef)!;
  expect(finalTurn.state).toBe("COMPLETE");
  expect(decodeGooseResponsesProjectionCheckpoint(finalTurn.checkpointJson).stableNonInputHash).toMatch(/^[a-f0-9]{64}$/);
});

test("qualified-terminal recovery does not bless a later new tool boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-qualified-terminal-boundary-"));
  roots.push(root);
  const brokerPath = join(root, "broker.sqlite");
  const authorizationFile = join(root, "connector-auth.txt");
  const authorization = "Bearer " + "q".repeat(64);
  writeFileSync(authorizationFile, authorization + "\n", { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);

  const sessionId = "goose-qualified-terminal-boundary";
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000807";
  const acceptedUserTurnId = "user-qualified-terminal-boundary";
  const previous = requestBody("qualified-terminal-boundary");
  const previousCheckpoint = gooseResponsesProjectionCheckpoint(previous);
  let opSequence = 0;
  const seed = new SessionBroker(brokerPath, {
    projectId: "project-qualified-terminal-boundary",
    instanceId: "seed",
    terminalReplayWindowMs: 60_000,
    makeTurnRef: () => "turn-qualified-terminal-boundary",
    makeSubmitNonce: () => "nonce-qualified-terminal-boundary",
    makeOpRef: () => "op-qualified-terminal-boundary-" + String(++opSequence),
  });
  seed.createEpoch({ gooseSessionId: sessionId });
  const turn = seed.enqueueTurn({
    gooseSessionId: sessionId,
    requestHash: previousCheckpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(previousCheckpoint),
  });
  const admitted = seed.admitNext()!;
  seed.markSendActivated(turn.turnRef);
  seed.bindConversation({ gooseSessionId: sessionId, epoch: 1, conversationId });
  seed.markAccepted(turn.turnRef, acceptedUserTurnId);
  seed.recordAnswerBoundary(turn.turnRef, admitted.initialOpRef, '{"chars":1}');
  const originalArgs = { path: "." };
  const originalInputHash = connectorOperationInputHash("tree", originalArgs);
  expect(seed.claimOperation({
    turnRef: turn.turnRef,
    opRef: admitted.initialOpRef,
    inputHash: originalInputHash,
  }).kind).toBe("EXECUTE");
  const originalTerminal = prepareConnectorTerminalResult({
    outcome: "SUCCESS",
    dataClass: "task",
    content: "known-tool-result",
  });
  const completed = seed.completeOperation({
    opRef: admitted.initialOpRef,
    inputHash: originalInputHash,
    outcome: originalTerminal.outcome,
    resultJson: originalTerminal.resultJson,
  });
  const nextOpRef = completed.nextOpRef;
  seed.markUnreconciled(turn.turnRef, "restart_after_terminal_tool_before_progress_checkpoint");
  seed.releaseSlotAfterPositiveTerminal(turn.turnRef, {
    canonicalConversationId: conversationId,
    acceptedUserTurnId,
    remoteUiNonRunningAcrossQualifiedSettle: true,
    noUnresolvedGooseWork: true,
    noContradictoryActivity: true,
  });
  seed.close();

  const continuation = continuationBody(previous, admitted.initialOpRef, "known-tool-result");
  let invokeNewTool!: () => Promise<Record<string, unknown>>;
  let browserStarts = 0;
  const runtime = startRebuildProviderRuntime({
    port: 0,
    model: "gpt-4.1",
    contextWindow: 200_000,
    controlToken: "control-token",
    projectId: "project-qualified-terminal-boundary",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath,
    terminalReplayWindowMs: 60_000,
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: {
      createTurn(input) {
        browserStarts += 1;
        return {
          captureAnswerBoundary: async opRef => JSON.stringify({ kind: "new-boundary", opRef }),
          confirmFinal: async evidence => evidence,
          run: async () => {
            await input.lifecycle.onRebound?.({ canonicalConversationId: conversationId, acceptedUserTurnId });
            const terminal = await invokeNewTool();
            expect(terminal).toMatchObject({ ok: true, op_ref: nextOpRef });
            return {
              canonicalConversationId: conversationId,
              acceptedUserTurnId,
              text: "final-without-post-new-tool-advance",
              remoteNonRunning: true,
            };
          },
        };
      },
    },
  });
  runtimes.push(runtime);
  const connector = connectorClient(runtime, authorization);
  await connector.client.connect(connector.transport);
  invokeNewTool = async () => (await connector.client.callTool({
    name: "goose_tool",
    arguments: {
      turn_ref: turn.turnRef,
      op_ref: nextOpRef,
      tool_name: "tree",
      arguments: { path: "src" },
    },
  })).structuredContent as Record<string, unknown>;

  try {
    const first = await post(runtime, continuation, sessionId);
    expect(first.status).toBe(200);
    const call = responseFunctionCall(await first.text());
    expect(call).toEqual({
      callId: nextOpRef,
      name: "tree",
      argumentsJson: canonicalJson({ path: "src" }),
    });

    const progressed = {
      ...continuation,
      input: [
        ...continuation.input,
        { type: "function_call", call_id: nextOpRef, name: "tree", arguments: canonicalJson({ path: "src" }) },
        { type: "function_call_output", call_id: nextOpRef, output: "new-tool-output" },
      ],
    };
    const second = await post(runtime, progressed, sessionId);
    expect(second.status).toBe(409);
    expect(await second.text()).toContain("Completion must prove post-tool content or qualified terminal semantics");
    expect(browserStarts).toBe(1);
    expect(runtime.broker.getTurn(turn.turnRef)?.state).toBe("UNRECONCILED");
    expect(runtime.broker.getOperation(nextOpRef)?.state).toBe("SUCCESS");
  } finally {
    await connector.client.close().catch(() => {});
  }
});

test("provider restart fails closed when the durable rebind checkpoint is missing or malformed", async () => {
  for (const [label, checkpointJson] of [["missing", null], ["malformed", "{not-json"]] as const) {
    const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-restart-" + label + "-checkpoint-"));
    roots.push(root);
    const brokerPath = join(root, "broker.sqlite");
    const authorizationFile = join(root, "connector-auth.txt");
    const authorization = "Bearer " + "c".repeat(64);
    writeFileSync(authorizationFile, authorization + "\n", { mode: 0o600 });
    chmodSync(authorizationFile, 0o600);
    const body = requestBody("restart-" + label + "-checkpoint");
    const checkpoint = gooseResponsesProjectionCheckpoint(body);
    const conversationId = label === "missing"
      ? "aaaaaaaa-bbbb-4ccc-8ddd-000000000779"
      : "aaaaaaaa-bbbb-4ccc-8ddd-000000000780";
    const seed = new SessionBroker(brokerPath, {
      projectId: "project-restart-" + label + "-checkpoint",
      instanceId: "seed",
      terminalReplayWindowMs: 60_000,
      makeTurnRef: () => "turn-restart-" + label + "-checkpoint",
      makeSubmitNonce: () => "nonce-restart-" + label + "-checkpoint",
      makeOpRef: () => "op-seed-restart-" + label + "-checkpoint",
    });
    seed.createEpoch({ gooseSessionId: "goose-restart-" + label + "-checkpoint" });
    const seeded = seed.enqueueTurn({
      gooseSessionId: "goose-restart-" + label + "-checkpoint",
      requestHash: checkpoint.requestHash,
      ...(checkpointJson === null ? {} : { checkpointJson }),
    });
    seed.admitNext();
    seed.markSendActivated(seeded.turnRef);
    seed.bindConversation({
      gooseSessionId: "goose-restart-" + label + "-checkpoint",
      epoch: 1,
      conversationId,
    });
    seed.markAccepted(seeded.turnRef, "user-restart-" + label + "-checkpoint");
    if (checkpointJson !== null) seed.recordProgress(seeded.turnRef, checkpointJson);
    seed.close();

    let browserStarts = 0;
    const runtime = startRebuildProviderRuntime({
      port: 0,
      model: "gpt-4.1",
      contextWindow: 200_000,
      controlToken: "control-token",
      projectId: "project-restart-" + label + "-checkpoint",
      connectorIdentity: "Goose Native 2nd Shift",
      brokerPath,
      terminalReplayWindowMs: 60_000,
      connectorPort: 0,
      connectorAuthorizationFile: authorizationFile,
      browserDriver: {
        createTurn() {
          browserStarts += 1;
          throw new Error("invalid durable checkpoint must block before browser start");
        },
      },
    });
    runtimes.push(runtime);
    expect(runtime.broker.getTurn(seeded.turnRef)?.state).toBe("UNRECONCILED");

    const response = await post(runtime, body, "goose-restart-" + label + "-checkpoint");
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("rebind_request_conflict");
    expect(browserStarts).toBe(0);
    expect(runtime.broker.getTurn(seeded.turnRef)?.state).toBe("UNRECONCILED");
  }
});

test("provider restart refuses pair rebind while a prior tool result remains genuinely ambiguous", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-provider-restart-blocked-"));
  roots.push(root);
  const brokerPath = join(root, "broker.sqlite");
  const authorizationFile = join(root, "connector-auth.txt");
  writeFileSync(authorizationFile, `Bearer ${"y".repeat(64)}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const body = requestBody("restart-blocked");
  const checkpoint = gooseResponsesProjectionCheckpoint(body);
  const seed = new SessionBroker(brokerPath, {
    projectId: "project-restart-blocked",
    instanceId: "seed",
    terminalReplayWindowMs: 60_000,
    makeTurnRef: () => "turn-restart-blocked",
    makeSubmitNonce: () => "nonce-restart-blocked",
    makeOpRef: () => "op-restart-blocked",
  });
  seed.createEpoch({ gooseSessionId: "goose-restart-blocked" });
  const turn = seed.enqueueTurn({
    gooseSessionId: "goose-restart-blocked",
    requestHash: checkpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
  });
  const admitted = seed.admitNext()!;
  seed.markSendActivated(turn.turnRef);
  seed.bindConversation({
    gooseSessionId: "goose-restart-blocked", epoch: 1,
    conversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000778",
  });
  seed.markAccepted(turn.turnRef, "user-restart-blocked");
  seed.recordAnswerBoundary(turn.turnRef, admitted.initialOpRef, '{"chars":1}');
  expect(seed.claimOperation({ turnRef: turn.turnRef, opRef: admitted.initialOpRef, inputHash: "input" }).kind).toBe("EXECUTE");
  seed.close();

  let browserStarts = 0;
  const runtime = startRebuildProviderRuntime({
    port: 0,
    model: "gpt-4.1",
    contextWindow: 200_000,
    controlToken: "control-token",
    projectId: "project-restart-blocked",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath,
    terminalReplayWindowMs: 60_000,
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: { createTurn() { browserStarts += 1; throw new Error("must not rebind before reconciliation"); } },
  });
  runtimes.push(runtime);
  expect(runtime.broker.getOperation(admitted.initialOpRef)?.state).toBe("UNCERTAIN");
  const response = await post(runtime, body, "goose-restart-blocked");
  expect(response.status).toBe(409);
  expect((await response.json() as any).error.code).toBe("rebind_blocked");
  expect(browserStarts).toBe(0);
  expect(runtime.broker.getAccountSlotHolder()).toBe("turn-restart-blocked");
});

test("a live initial Responses owner rejects a concurrent duplicate without starting a second browser execution", async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  let browserStarts = 0;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      browserStarts += 1;
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000111",
            acceptedUserTurnId: "user-live-duplicate",
          });
          started.resolve();
          await finish.promise;
          return {
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000111",
            acceptedUserTurnId: "user-live-duplicate",
            text: "live-owner-ok",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const body = requestBody("live-duplicate");
  const first = post(runtime, body, "goose-live-duplicate");
  await started.promise;

  const duplicate = await post(runtime, body, "goose-live-duplicate");
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json() as any).error.code).toBe("STAGE_ALREADY_OPEN");
  expect(browserStarts).toBe(1);

  finish.resolve();
  const firstResponse = await first;
  expect(firstResponse.status).toBe(200);
  expect(await firstResponse.text()).toContain("live-owner-ok");
  expect(browserStarts).toBe(1);
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
});

test("busy drain fails atomically without blocking the active turn or its follow-up traffic", async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000222",
            acceptedUserTurnId: "user-busy-drain",
          });
          started.resolve();
          await finish.promise;
          return {
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000222",
            acceptedUserTurnId: "user-busy-drain",
            text: "busy-drain-ok",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const active = post(runtime, requestBody("busy-drain"), "goose-busy-drain");
  await started.promise;

  const drain = await fetch(`${runtime.origin}/admin/drain`, {
    method: "POST",
    headers: { authorization: "Bearer control-token" },
  });
  expect(drain.status).toBe(409);
  expect(await drain.json()).toMatchObject({
    status: "busy",
    accepting_turns: true,
    active_browser_turns: 1,
  });
  expect((await fetch(`${runtime.origin}/v1/models`)).status).toBe(200);

  finish.resolve();
  const completed = await active;
  expect(completed.status).toBe(200);
  expect(await completed.text()).toContain("busy-drain-ok");

  const idleDrain = await fetch(`${runtime.origin}/admin/drain`, {
    method: "POST",
    headers: { authorization: "Bearer control-token" },
  });
  expect(idleDrain.status).toBe(200);
  expect(await idleDrain.json()).toMatchObject({ status: "ok", accepting_turns: false });
  expect((await fetch(`${runtime.origin}/v1/models`)).status).toBe(503);
  const resume = await fetch(`${runtime.origin}/admin/resume`, {
    method: "POST",
    headers: { authorization: "Bearer control-token" },
  });
  expect(resume.status).toBe(200);
});

test("authenticated recovery reconciles post-owner known operation evidence without retiring the persistent pair", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-recovery-admin-"));
  roots.push(root);
  const authorizationFile = join(root, "connector-auth.txt");
  writeFileSync(authorizationFile, `Bearer ${"r".repeat(64)}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const brokerPath = join(root, "broker.sqlite");
  const driver: RebuildPersistentBrowserDriver = {
    createTurn() { throw new Error("recovery test must not create browser work"); },
  };
  const start = () => startRebuildProviderRuntime({
    port: 0,
    model: "gpt-4.1",
    contextWindow: 200_000,
    controlToken: "control-token",
    projectId: "project-runtime-test",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath,
    terminalReplayWindowMs: 60_000,
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: driver,
  });

  const first = start();
  runtimes.push(first);
  first.broker.createEpoch({ gooseSessionId: "goose-recovery" });
  const queued = first.broker.enqueueTurn({
    gooseSessionId: "goose-recovery",
    requestHash: "request-recovery",
  });
  const admitted = first.broker.admitNext()!;
  expect(admitted.turn.turnRef).toBe(queued.turnRef);
  first.broker.markSendActivated(admitted.turn.turnRef);
  first.broker.markAccepted(admitted.turn.turnRef, "user-recovery");
  first.broker.bindConversation({ gooseSessionId: "goose-recovery", epoch: 1, conversationId: "87654321-4321-4abc-8def-1234567890ab" });
  first.broker.recordAnswerBoundary(admitted.turn.turnRef, admitted.initialOpRef, '{"chars":12}');
  const originalInputHash = connectorOperationInputHash("developer__tree", { path: ".qualification" });
  expect(first.broker.claimOperation({
    turnRef: admitted.turn.turnRef, opRef: admitted.initialOpRef, inputHash: originalInputHash,
  }).kind).toBe("EXECUTE");
  first.broker.markUnreconciled(admitted.turn.turnRef, "known_executed_uncommitted");

  const liveClaim = await fetch(`${first.origin}/admin/reconcile-operation`, {
    method: "POST",
    headers: { authorization: "Bearer control-token", "content-type": "application/json" },
    body: JSON.stringify({
      turn_ref: admitted.turn.turnRef, op_ref: admitted.initialOpRef, tool_name: "developer__tree",
      arguments: { path: ".qualification" }, outcome: "SUCCESS", data_class: "task", content: "password=proof-secret",
    }),
  });
  expect(liveClaim.status).toBe(409);
  expect(await liveClaim.json()).toMatchObject({ status: "rejected", code: "OP_STATE" });

  await first.stop();
  const restarted = start();
  runtimes.push(restarted);
  expect(restarted.broker.getOperation(admitted.initialOpRef)?.state).toBe("UNCERTAIN");

  const wrongIdentity = await fetch(`${restarted.origin}/admin/reconcile-operation`, {
    method: "POST",
    headers: { authorization: "Bearer control-token", "content-type": "application/json" },
    body: JSON.stringify({
      turn_ref: admitted.turn.turnRef, op_ref: admitted.initialOpRef, tool_name: "tree",
      arguments: { path: ".qualification" }, outcome: "SUCCESS", data_class: "task", content: "password=proof-secret",
    }),
  });
  expect(wrongIdentity.status).toBe(409);
  expect(await wrongIdentity.json()).toMatchObject({ status: "rejected", code: "OP_REF_CONFLICT" });

  const reconciled = await fetch(`${restarted.origin}/admin/reconcile-operation`, {
    method: "POST",
    headers: { authorization: "Bearer control-token", "content-type": "application/json" },
    body: JSON.stringify({
      turn_ref: admitted.turn.turnRef, op_ref: admitted.initialOpRef, tool_name: "developer__tree",
      arguments: { path: ".qualification" }, outcome: "SUCCESS", data_class: "task", content: "password=proof-secret",
    }),
  });
  expect(reconciled.status).toBe(200);
  expect(await reconciled.json()).toMatchObject({ status: "ok", operation_state: "SUCCESS" });
  const terminal = restarted.broker.getOperation(admitted.initialOpRef)!;
  expect(terminal.inputHash).toBe(originalInputHash);
  expect(terminal.resultJson).toContain("password=[redacted]");
  expect(terminal.resultJson).not.toContain("proof-secret");
  expect(restarted.broker.getAccountSlotHolder()).toBe(admitted.turn.turnRef);

  expect(restarted.broker.getOpenTurnForSession("goose-recovery")).toMatchObject({
    state: "UNRECONCILED",
    acceptedUserTurnId: "user-recovery",
  });
  expect(restarted.broker.getCurrentEpoch("goose-recovery")).toMatchObject({
    epoch: 1,
    conversationId: "87654321-4321-4abc-8def-1234567890ab",
    leaseState: "UNRECONCILED",
  });
});

test("current runtime exposes no persistent-pair abandonment endpoint", async () => {
  const driver: RebuildPersistentBrowserDriver = {
    createTurn() { throw new Error("endpoint absence test must not create browser work"); },
  };
  const { runtime } = setup(driver);
  const response = await fetch(`${runtime.origin}/admin/abandon-unreconciled`, {
    method: "POST",
    headers: { authorization: "Bearer control-token", "content-type": "application/json" },
    body: JSON.stringify({ turn_ref: "legacy-turn" }),
  });
  expect(response.status).toBe(404);
});

test("connector work cannot claim before canonical conversation and accepted user identity are durable", async () => {
  const earlyChecked = deferred<void>();
  const allowAcceptance = deferred<void>();
  let boundaryCaptures = 0;
  let earlyResult: Awaited<ReturnType<Client["callTool"]>> | undefined;
  let invokeTool!: (input: RebuildPersistentBrowserTurnInput) => Promise<Awaited<ReturnType<Client["callTool"]>>>;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      return {
        captureAnswerBoundary: async opRef => {
          boundaryCaptures += 1;
          return JSON.stringify({ kind: "fresh-boundary", opRef, ordinal: boundaryCaptures });
        },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          earlyResult = await invokeTool(input);
          earlyChecked.resolve();
          await allowAcceptance.promise;
          input.lifecycle.onAccepted({
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000333",
            acceptedUserTurnId: "user-boundary-identity",
          });
          const committed = await invokeTool(input);
          expect(committed.isError).toBeUndefined();
          expect(committed.structuredContent).toMatchObject({ ok: true, op_ref: input.initialOpRef });
          return {
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000333",
            acceptedUserTurnId: "user-boundary-identity",
            text: "identity-fence-ok",
            remoteNonRunning: true,
            contentAdvancedAfterLastTool: true,
          };
        },
      };
    },
  };
  const { runtime, authorization } = setup(driver);
  const connector = connectorClient(runtime, authorization);
  await connector.client.connect(connector.transport);
  invokeTool = input => connector.client.callTool({
    name: "goose_tool",
    arguments: {
      turn_ref: input.turnRef,
      op_ref: input.initialOpRef,
      tool_name: "tree",
      arguments: { path: "." },
    },
  });

  try {
    const initial = requestBody("identity-fence");
    const firstPromise = post(runtime, initial, "goose-boundary-identity");
    await earlyChecked.promise;
    const open = runtime.broker.getOpenTurnForSession("goose-boundary-identity");
    expect(open?.state).toBe("TURN_OUTSTANDING");
    expect(open?.acceptedUserTurnId).toBeNull();
    expect(runtime.broker.getCurrentEpoch("goose-boundary-identity")?.conversationId).toBeNull();
    expect(earlyResult?.isError).toBe(true);
    expect(earlyResult?.structuredContent).toMatchObject({ ok: false, output: "BOUNDARY_REQUIRED" });
    expect(boundaryCaptures).toBe(1);

    allowAcceptance.resolve();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    const call = responseFunctionCall(await first.text());
    expect(runtime.broker.getOperation(call.callId)?.state).toBe("CLAIMED");
    expect(boundaryCaptures).toBe(2);

    const second = await post(runtime, continuationBody(initial, call.callId, "tool-output"), "goose-boundary-identity");
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("identity-fence-ok");
    expect(runtime.broker.getOperation(call.callId)?.state).toBe("SUCCESS");
    expect(runtime.broker.getCurrentEpoch("goose-boundary-identity")).toMatchObject({ leaseState: "IDLE", historyWatermark: watermark(continuationBody(initial, call.callId, "tool-output"), "identity-fence-ok") });
  } finally {
    await connector.client.close().catch(() => {});
  }
});

test("browser construction failure before send is retryable and exact replay creates a fresh execution", async () => {
  let starts = 0;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts += 1;
      if (starts === 1) throw new Error("synthetic construction failure before send");
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000444",
            acceptedUserTurnId: "user-construction-retry",
          });
          return {
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000444",
            acceptedUserTurnId: "user-construction-retry",
            text: "construction-retry-ok",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const first = await post(runtime, requestBody("construction-retry"), "goose-construction-retry");
  expect(first.status).toBe(502);
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
  expect(runtime.broker.getOpenTurnForSession("goose-construction-retry")).toBeNull();

  const retry = await post(runtime, requestBody("construction-retry"), "goose-construction-retry");
  expect(retry.status).toBe(200);
  expect(await retry.text()).toContain("construction-retry-ok");
  expect(starts).toBe(2);
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
});

test("browser run failure before send releases the pre-dispatch stage and remains retryable", async () => {
  let starts = 0;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts += 1;
      const ordinal = starts;
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          if (ordinal === 1) throw new Error("synthetic async preparation failure before send");
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000555",
            acceptedUserTurnId: "user-run-retry",
          });
          return {
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000555",
            acceptedUserTurnId: "user-run-retry",
            text: "run-retry-ok",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const first = await post(runtime, requestBody("run-retry"), "goose-run-retry");
  expect(first.status).toBe(502);
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
  expect(runtime.broker.getOpenTurnForSession("goose-run-retry")).toBeNull();

  const retry = await post(runtime, requestBody("run-retry"), "goose-run-retry");
  expect(retry.status).toBe(200);
  expect(await retry.text()).toContain("run-retry-ok");
  expect(starts).toBe(2);
});

test("browser construction failure after durable send activation quarantines instead of retrying", async () => {
  let starts = 0;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts += 1;
      input.lifecycle.onSendActivated();
      throw new Error("synthetic construction failure after send activation");
    },
  };
  const { runtime } = setup(driver);
  const first = await post(runtime, requestBody("construction-after-send"), "goose-construction-after-send");
  expect(first.status).toBe(502);
  const open = runtime.broker.getOpenTurnForSession("goose-construction-after-send");
  expect(open?.state).toBe("UNRECONCILED");
  expect(open?.unreconciledReason).toBe("persistent_browser_turn_construction_failed_after_send_activation");
  expect(open?.turnRef).toBeTruthy();
  expect(runtime.broker.getAccountSlotHolder()).toBe(open?.turnRef ?? null);

  const retry = await post(runtime, requestBody("construction-after-send"), "goose-construction-after-send");
  expect(retry.status).toBe(409);
  expect((await retry.json() as any).error.code).toBe("RECOVERY_IDENTITY");
  expect(starts).toBe(1);
});

test("accepted browser attachment failure rebinds the same persisted pair on exact replay", async () => {
  let starts = 0;
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000777";
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts += 1;
      const ordinal = starts;
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          if (ordinal === 1) {
            input.lifecycle.onSendActivated();
            input.lifecycle.onAccepted({
              canonicalConversationId: conversationId,
              acceptedUserTurnId: "user-upstream-terminal",
            });
            throw new ChatGptUpstreamTerminalError("regenerate-error");
          }
          expect(input.prompt).toBe("");
          expect(input.resumeAccepted).toEqual({
            canonicalConversationId: conversationId,
            acceptedUserTurnId: "user-upstream-terminal",
          });
          await input.lifecycle.onRebound?.({
            canonicalConversationId: conversationId,
            acceptedUserTurnId: "user-upstream-terminal",
          });
          return {
            canonicalConversationId: conversationId,
            acceptedUserTurnId: "user-upstream-terminal",
            text: "same-pair-rebound-ok",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const body = requestBody("upstream-terminal");
  const first = await post(runtime, body, "goose-upstream-terminal");
  expect(first.status).toBe(502);
  expect((await first.json() as any).error.code).toBe("upstream_server_error");
  const open = runtime.broker.getOpenTurnForSession("goose-upstream-terminal");
  expect(open?.state).toBe("UNRECONCILED");
  expect(open?.unreconciledReason).toBe("persistent_browser_turn_failed");
  expect(runtime.broker.getAccountSlotHolder()).toBe(open?.turnRef ?? null);

  const retry = await post(runtime, body, "goose-upstream-terminal");
  expect(retry.status).toBe(200);
  expect(await retry.text()).toContain("same-pair-rebound-ok");
  expect(starts).toBe(2);
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
});

test("invalid browser acceptance identity cannot partially bind durable remote identity", async () => {
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000666",
            acceptedUserTurnId: "invalid user turn with spaces",
          });
          throw new Error("unreachable");
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const response = await post(runtime, requestBody("invalid-browser-identity"), "goose-invalid-browser-identity");
  expect(response.status).toBe(502);
  const turn = runtime.broker.getOpenTurnForSession("goose-invalid-browser-identity");
  expect(turn?.state).toBe("UNRECONCILED");
  expect(turn?.acceptedUserTurnId).toBeNull();
  expect(runtime.broker.getCurrentEpoch("goose-invalid-browser-identity")?.conversationId).toBeNull();
  expect(runtime.broker.getAccountSlotHolder()).toBe(turn?.turnRef ?? null);
});

test("positive-terminal recovery releases scarce capacity without abandoning the persistent pair", async () => {
  const driver: RebuildPersistentBrowserDriver = {
    createTurn() { throw new Error("slot-release recovery must not create browser work"); },
  };
  const { runtime } = setup(driver);
  const sessionId = "goose-slot-release";
  const body = requestBody("slot-release");
  const checkpoint = gooseResponsesProjectionCheckpoint(body);
  runtime.broker.createEpoch({ gooseSessionId: sessionId });
  const turn = runtime.broker.enqueueTurn({
    gooseSessionId: sessionId,
    requestHash: checkpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
  });
  runtime.broker.admitNext(turn.turnRef);
  runtime.broker.markSendActivated(turn.turnRef);
  runtime.broker.markUnreconciled(turn.turnRef, "browser_lost_before_identity_capture");

  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000901";
  const response = await fetch(`${runtime.origin}/admin/release-unreconciled-slot`, {
    method: "POST",
    headers: { authorization: "Bearer control-token", "content-type": "application/json" },
    body: JSON.stringify({
      turn_ref: turn.turnRef,
      positive_terminal_evidence: {
        canonical_conversation_id: conversationId,
        accepted_user_turn_id: "user-slot-release",
        remote_ui_non_running_across_qualified_settle: true,
        no_unresolved_goose_work: true,
        no_contradictory_activity: true,
      },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "ok",
    turn_ref: turn.turnRef,
    turn_state: "UNRECONCILED",
    pair_retained: true,
    account_slot_holders: [],
  });
  expect(runtime.broker.getTurn(turn.turnRef)).toMatchObject({
    state: "UNRECONCILED", acceptedUserTurnId: "user-slot-release",
  });
  expect(runtime.broker.getCurrentEpoch(sessionId)).toMatchObject({
    epoch: 1,
    conversationId,
    leaseState: "UNRECONCILED",
    leaseTurnRef: turn.turnRef,
    isCurrent: true,
  });
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();

  const legacyAbandon = await fetch(`${runtime.origin}/admin/abandon-unreconciled`, {
    method: "POST",
    headers: { authorization: "Bearer control-token", "content-type": "application/json" },
    body: JSON.stringify({ turn_ref: turn.turnRef }),
  });
  expect(legacyAbandon.status).toBe(404);
});

test("exact replay reacquires a quarantined slot and rebinds the same pair without resending", async () => {
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000902";
  const sessionId = "goose-slot-rebind";
  let starts = 0;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts += 1;
      expect(input.prompt).toBe("");
      expect(input.existingConversationId).toBe(conversationId);
      expect(input.resumeAccepted).toEqual({
        canonicalConversationId: conversationId,
        acceptedUserTurnId: "user-slot-rebind",
      });
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          await input.lifecycle.onRebound?.({
            canonicalConversationId: conversationId,
            acceptedUserTurnId: "user-slot-rebind",
          });
          return {
            canonicalConversationId: conversationId,
            acceptedUserTurnId: "user-slot-rebind",
            text: "slot-rebind-final",
            remoteNonRunning: true,
          };
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const body = requestBody("slot-rebind");
  const checkpoint = gooseResponsesProjectionCheckpoint(body);
  runtime.broker.createEpoch({ gooseSessionId: sessionId });
  const turn = runtime.broker.enqueueTurn({
    gooseSessionId: sessionId,
    requestHash: checkpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
  });
  runtime.broker.admitNext(turn.turnRef);
  runtime.broker.markSendActivated(turn.turnRef);
  runtime.broker.markUnreconciled(turn.turnRef, "qualified_terminal_slot_quarantine");
  runtime.broker.releaseSlotAfterPositiveTerminal(turn.turnRef, {
    canonicalConversationId: conversationId,
    acceptedUserTurnId: "user-slot-rebind",
    remoteUiNonRunningAcrossQualifiedSettle: true,
    noUnresolvedGooseWork: true,
    noContradictoryActivity: true,
  });
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();

  const response = await post(runtime, body, sessionId);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("slot-rebind-final");
  expect(starts).toBe(1);
  expect(runtime.broker.getTurn(turn.turnRef)?.state).toBe("COMPLETE");
  expect(runtime.broker.getCurrentEpoch(sessionId)).toMatchObject({
    epoch: 1, conversationId, leaseState: "IDLE", isCurrent: true,
  });
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
});

test("failed pre-rebound attachment restores quarantined capacity for a later exact replay", async () => {
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000903";
  const sessionId = "goose-slot-rebind-failure";
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      expect(input.prompt).toBe("");
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => { throw new Error("synthetic rebind attachment failure before identity verification"); },
      };
    },
  };
  const { runtime } = setup(driver);
  const body = requestBody("slot-rebind-failure");
  const checkpoint = gooseResponsesProjectionCheckpoint(body);
  runtime.broker.createEpoch({ gooseSessionId: sessionId });
  const turn = runtime.broker.enqueueTurn({
    gooseSessionId: sessionId,
    requestHash: checkpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
  });
  runtime.broker.admitNext(turn.turnRef);
  runtime.broker.markSendActivated(turn.turnRef);
  runtime.broker.markUnreconciled(turn.turnRef, "qualified_terminal_slot_quarantine");
  runtime.broker.releaseSlotAfterPositiveTerminal(turn.turnRef, {
    canonicalConversationId: conversationId,
    acceptedUserTurnId: "user-slot-rebind-failure",
    remoteUiNonRunningAcrossQualifiedSettle: true,
    noUnresolvedGooseWork: true,
    noContradictoryActivity: true,
  });

  const response = await post(runtime, body, sessionId);
  expect(response.status).toBe(502);
  expect(runtime.broker.getTurn(turn.turnRef)).toMatchObject({
    state: "UNRECONCILED", acceptedUserTurnId: "user-slot-rebind-failure",
  });
  expect(runtime.broker.getAccountSlotHolder()).toBeNull();
  expect(runtime.broker.hasRecordedPositiveTerminalSlotRelease(turn.turnRef)).toBeTrue();
  expect(runtime.broker.getCurrentEpoch(sessionId)).toMatchObject({
    epoch: 1, conversationId, leaseState: "UNRECONCILED", leaseTurnRef: turn.turnRef,
  });
});

test("successful slot-quarantine rebind consumes terminal evidence before later attachment loss", async () => {
  const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000904";
  const sessionId = "goose-slot-evidence-consumed";
  let starts = 0;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      starts += 1;
      const ordinal = starts;
      if (ordinal === 2) throw new Error("synthetic later rebind construction failure");
      return {
        captureAnswerBoundary: async () => { throw new Error("no tool expected"); },
        confirmFinal: async evidence => evidence,
        run: async () => {
          await input.lifecycle.onRebound?.({
            canonicalConversationId: conversationId,
            acceptedUserTurnId: "user-slot-evidence-consumed",
          });
          throw new Error("synthetic post-rebound attachment failure");
        },
      };
    },
  };
  const { runtime } = setup(driver);
  const body = requestBody("slot-evidence-consumed");
  const checkpoint = gooseResponsesProjectionCheckpoint(body);
  runtime.broker.createEpoch({ gooseSessionId: sessionId });
  const turn = runtime.broker.enqueueTurn({
    gooseSessionId: sessionId,
    requestHash: checkpoint.requestHash,
    checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
  });
  runtime.broker.admitNext(turn.turnRef);
  runtime.broker.markSendActivated(turn.turnRef);
  runtime.broker.markUnreconciled(turn.turnRef, "qualified_terminal_slot_quarantine");
  runtime.broker.releaseSlotAfterPositiveTerminal(turn.turnRef, {
    canonicalConversationId: conversationId,
    acceptedUserTurnId: "user-slot-evidence-consumed",
    remoteUiNonRunningAcrossQualifiedSettle: true,
    noUnresolvedGooseWork: true,
    noContradictoryActivity: true,
  });

  const first = await post(runtime, body, sessionId);
  expect(first.status).toBe(502);
  expect(runtime.broker.getTurn(turn.turnRef)?.state).toBe("UNRECONCILED");
  expect(runtime.broker.getAccountSlotHolder()).toBe(turn.turnRef);
  expect(runtime.broker.hasRecordedPositiveTerminalSlotRelease(turn.turnRef)).toBeFalse();

  const second = await post(runtime, body, sessionId);
  expect(second.status).toBe(502);
  expect(starts).toBe(2);
  expect(runtime.broker.getTurn(turn.turnRef)?.state).toBe("UNRECONCILED");
  expect(runtime.broker.getAccountSlotHolder()).toBe(turn.turnRef);
  expect(runtime.broker.hasRecordedPositiveTerminalSlotRelease(turn.turnRef)).toBeFalse();
});
