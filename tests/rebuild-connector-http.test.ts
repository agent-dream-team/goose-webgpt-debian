import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SessionBroker } from "../src/session-broker";
import { GooseToolRendezvous } from "../src/goose-tool-rendezvous";
import { encodeGooseResponsesProjectionCheckpoint, gooseResponsesProjectionCheckpoint } from "../src/goose-responses-projection";
import {
  connectorOperationInputHash,
  createConnectorOperationAuthority,
  startRebuildConnectorHttpServer,
  type ConnectorRendezvousResult,
  type ConnectorToolNameResolution,
  type RebuildConnectorHttpServer,
} from "../src/rebuild-connector-http";

const roots: string[] = [];
const servers: RebuildConnectorHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop().catch(() => {})));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-connector-"));
  roots.push(root);
  const authorizationFile = join(root, "connector-authorization.txt");
  const authorization = `Bearer ${"a".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  let op = 0;
  const broker = new SessionBroker(join(root, "broker.sqlite"), {
    projectId: "project",
    instanceId: "connector-proof",
    terminalReplayWindowMs: 60_000,
    now: () => 1_000,
    makeTurnRef: () => "turn-a",
    makeSubmitNonce: () => "nonce-a",
    makeOpRef: () => `op_${++op}`,
  });
  broker.createEpoch({ gooseSessionId: "goose-a" });
  broker.enqueueTurn({ gooseSessionId: "goose-a", requestHash: "request-a" });
  const admitted = broker.admitNext()!;
  broker.markSendActivated(admitted.turn.turnRef);
  broker.markAccepted(admitted.turn.turnRef, "user-a");
  broker.bindConversation({ gooseSessionId: "goose-a", epoch: 1, conversationId: "conversation-a" });
  broker.recordAnswerBoundary(admitted.turn.turnRef, admitted.initialOpRef, '{"chars":1}');
  const authority = createConnectorOperationAuthority({
    claimOperation: input => broker.claimOperation(input),
    classifyMissingOperationRef: (turnRef, inputHash) => broker.classifyMissingOperationRef(turnRef, inputHash),
    boundOperationInputHash: (turnRef, opRef) => {
      const operation = broker.getOperation(opRef);
      return operation?.turnRef === turnRef ? operation.inputHash : null;
    },
    markUnreconciled: (turnRef, reason) => { broker.markUnreconciled(turnRef, reason); },
    completeOperation: input => input.progressCheckpointJson === undefined
      ? broker.completeOperation(input)
      : broker.completeOperationWithProgress({ ...input, checkpointJson: input.progressCheckpointJson }),
  });
  return { root, authorizationFile, authorization, broker, authority, turnRef: admitted.turn.turnRef, opRef: admitted.initialOpRef };
}

function client(server: RebuildConnectorHttpServer, authorization: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`), {
    requestInit: { headers: { authorization } },
  });
  const value = new Client({ name: "rebuild-connector-test", version: "1.0.0" });
  return { client: value, transport };
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  expect(result.structuredContent).toBeTruthy();
  return result.structuredContent as Record<string, unknown>;
}

async function startFixture(
  rendezvous: (request: any) => Promise<ConnectorRendezvousResult>,
  resolveToolName?: (turnRef: string, requestedToolName: string) => ConnectorToolNameResolution,
) {
  const f = fixture();
  const server = startRebuildConnectorHttpServer({
    port: 0,
    authorizationFile: f.authorizationFile,
    authority: f.authority,
    ...(resolveToolName ? { resolveToolName } : {}),
    rendezvous,
  });
  servers.push(server);
  return { ...f, server };
}

test("listener is dedicated loopback and rejects unauthenticated traffic before MCP handling", async () => {
  let calls = 0;
  const f = await startFixture(async () => { calls += 1; return { outcome: "SUCCESS", dataClass: "task", content: "ok" }; });
  expect(f.server.hostname).toBe("127.0.0.1");
  expect(f.server.origin).toBe(`http://127.0.0.1:${f.server.port}`);

  for (const authorization of [undefined, "Bearer wrong"]) {
    const response = await fetch(`${f.server.origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({ error: "unauthorized" });
  }
  const driveBy = await fetch(`${f.server.origin}/mcp`, { method: "OPTIONS", headers: { origin: "https://example.invalid" } });
  expect(driveBy.status).toBe(401);
  expect(driveBy.headers.get("access-control-allow-origin")).toBeNull();
  expect(calls).toBe(0);
  f.broker.close();
});

test("stateless MCP discovery exposes only goose_tool and executes one broker-authorized rendezvous", async () => {
  let calls = 0;
  const f = await startFixture(async request => {
    calls += 1;
    expect(request).toMatchObject({ turnRef: f.turnRef, opRef: f.opRef, toolName: "tree", arguments: { path: "." } });
    return { outcome: "SUCCESS", dataClass: "task", content: "result password=secret-value" };
  });
  const c = client(f.server, f.authorization);
  try {
    await c.client.connect(c.transport);
    expect(c.transport.sessionId).toBeUndefined();
    const listed = await c.client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(["goose_tool"]);
    const result = await c.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "tree", arguments: { path: "." },
    } });
    expect(result.isError).not.toBe(true);
    expect(structured(result)).toMatchObject({
      ok: true, turn_ref: f.turnRef, op_ref: f.opRef, next_op_ref: "op_2",
    });
    expect(String(structured(result).output)).toContain("password=[redacted]");
    expect(String(structured(result).output)).not.toContain("secret-value");
    expect(calls).toBe(1);
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("tool-name resolver canonicalizes before broker claim and durable input hash", async () => {
  let calls = 0;
  const f = await startFixture(async request => {
    calls += 1;
    expect(request.toolName).toBe("tree");
    return { outcome: "SUCCESS", dataClass: "task", content: "resolved" };
  }, (_turnRef, requestedToolName) => requestedToolName === "developer__tree"
    ? { kind: "RESOLVED", toolName: "tree" }
    : { kind: "REJECT", code: "TOOL_UNAVAILABLE" });
  const c = client(f.server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const result = await c.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "developer__tree", arguments: { path: "." },
    } });
    expect(result.isError).not.toBe(true);
    expect(f.broker.getOperation(f.opRef)?.inputHash).toBe(connectorOperationInputHash("tree", { path: "." }));
    expect(calls).toBe(1);
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("durably bound alias redelivery replays after live tool registry is gone", async () => {
  let calls = 0;
  let resolverCalls = 0;
  const f = await startFixture(async () => {
    calls += 1;
    return { outcome: "SUCCESS", dataClass: "task", content: "should-not-run" };
  }, () => {
    resolverCalls += 1;
    return { kind: "REJECT", code: "STAGE_UNAVAILABLE" };
  });
  const canonicalHash = connectorOperationInputHash("tree", { path: "." });
  expect(f.broker.claimOperation({ turnRef: f.turnRef, opRef: f.opRef, inputHash: canonicalHash }).kind).toBe("EXECUTE");
  const terminal = f.broker.completeOperation({
    opRef: f.opRef, inputHash: canonicalHash, outcome: "SUCCESS", resultJson: '{"ok":true,"output":"replayed"}',
  });
  const c = client(f.server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const result = await c.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "developer__tree", arguments: { path: "." },
    } });
    expect(result.isError).not.toBe(true);
    expect(structured(result)).toEqual({
      ok: true, output: "replayed", turn_ref: f.turnRef, op_ref: f.opRef, next_op_ref: terminal.nextOpRef,
    });
    expect(resolverCalls).toBe(0);
    expect(calls).toBe(0);
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("fresh MINTED alias still requires a live registry and is never guessed from its suffix", async () => {
  let calls = 0;
  const f = await startFixture(async () => {
    calls += 1;
    return { outcome: "SUCCESS", dataClass: "task", content: "should-not-run" };
  }, () => ({ kind: "REJECT", code: "STAGE_UNAVAILABLE" }));
  const c = client(f.server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const result = await c.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "developer__tree", arguments: { path: "." },
    } });
    expect(result.isError).toBe(true);
    expect(structured(result).output).toBe("STAGE_UNAVAILABLE");
    expect(f.broker.getOperation(f.opRef)).toMatchObject({ state: "MINTED", inputHash: null });
    expect(calls).toBe(0);
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("unknown tool alias fails before broker claim or rendezvous execution", async () => {
  let calls = 0;
  const f = await startFixture(async () => {
    calls += 1;
    return { outcome: "SUCCESS", dataClass: "task", content: "should-not-run" };
  }, () => ({ kind: "REJECT", code: "TOOL_UNAVAILABLE" }));
  const c = client(f.server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const result = await c.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "developer__shell", arguments: { command: "pwd" },
    } });
    expect(result.isError).toBe(true);
    expect(structured(result).output).toBe("TOOL_UNAVAILABLE");
    expect(f.broker.getOperation(f.opRef)?.state).toBe("MINTED");
    expect(f.broker.getOperation(f.opRef)?.inputHash).toBeNull();
    expect(calls).toBe(0);
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("same op_ref/input concurrent delivery attaches single-flight and terminal replay is exact", async () => {
  let calls = 0;
  const started = deferred<void>();
  const release = deferred<void>();
  const f = await startFixture(async () => {
    calls += 1;
    started.resolve();
    await release.promise;
    return { outcome: "SUCCESS", dataClass: "task", content: "shared" };
  });
  const a = client(f.server, f.authorization);
  const b = client(f.server, f.authorization);
  try {
    await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);
    const args = { turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "tree", arguments: { path: "." } };
    const first = a.client.callTool({ name: "goose_tool", arguments: args });
    await started.promise;
    const second = b.client.callTool({ name: "goose_tool", arguments: args });
    await Bun.sleep(50);
    expect(calls).toBe(1);
    release.resolve();
    const [r1, r2] = await Promise.all([first, second]);
    expect(structured(r1)).toEqual(structured(r2));
    expect(structured(r1).next_op_ref).toBe("op_2");
    const replay = await a.client.callTool({ name: "goose_tool", arguments: args });
    expect(structured(replay)).toEqual(structured(r1));
    expect(calls).toBe(1);
  } finally {
    await Promise.all([a.client.close().catch(() => {}), b.client.close().catch(() => {})]);
    f.broker.close();
  }
});

test("missing or conflicting operation identity never executes", async () => {
  let calls = 0;
  const f = await startFixture(async () => { calls += 1; return { outcome: "SUCCESS", dataClass: "task", content: "no" }; });
  const c = client(f.server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const missing = await c.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: f.turnRef, tool_name: "tree", arguments: { path: "." },
    } });
    expect(missing.isError).toBe(true);
    expect(structured(missing).output).toBe("INVALID");

    const wrong = await c.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: f.turnRef, op_ref: "not-minted", tool_name: "tree", arguments: { path: "." },
    } });
    expect(wrong.isError).toBe(true);
    expect(structured(wrong).output).toBe("UNKNOWN");
    expect(calls).toBe(0);
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("sensitive or non-text rendezvous result is durably safe failure and replays without raw content", async () => {
  const secret = "PRIVATE_NEVER_PERSIST";
  let calls = 0;
  const f = await startFixture(async () => { calls += 1; return { outcome: "SUCCESS", dataClass: "sensitive", content: secret }; });
  const c = client(f.server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const args = { turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "read", arguments: { path: "secret" } };
    const first = await c.client.callTool({ name: "goose_tool", arguments: args });
    expect(first.isError).toBe(true);
    const body = JSON.stringify(structured(first));
    expect(body).toContain("PERSISTENT_REMOTE_DATA_BLOCKED");
    expect(body).not.toContain(secret);
    expect(f.broker.getOperation(f.opRef)?.resultJson).not.toContain(secret);
    const replay = await c.client.callTool({ name: "goose_tool", arguments: args });
    expect(structured(replay)).toEqual(structured(first));
    expect(calls).toBe(1);
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("client disconnect after durable claim does not authorize cancellation or duplicate execution", async () => {
  let calls = 0;
  const started = deferred<void>();
  const release = deferred<void>();
  const f = await startFixture(async () => {
    calls += 1;
    started.resolve();
    await release.promise;
    return { outcome: "SUCCESS", dataClass: "task", content: "after-disconnect" };
  });
  const first = client(f.server, f.authorization);
  await first.client.connect(first.transport);
  const args = { turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "tree", arguments: { path: "." } };
  const pending = first.client.callTool({ name: "goose_tool", arguments: args }).catch(() => undefined);
  await started.promise;
  await first.transport.close();
  release.resolve();
  await pending;

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && f.broker.getOperation(f.opRef)?.state !== "SUCCESS") await Bun.sleep(20);
  expect(f.broker.getOperation(f.opRef)?.state).toBe("SUCCESS");
  expect(calls).toBe(1);

  const replayClient = client(f.server, f.authorization);
  try {
    await replayClient.client.connect(replayClient.transport);
    const replay = await replayClient.client.callTool({ name: "goose_tool", arguments: args });
    expect(structured(replay)).toMatchObject({ ok: true, output: "after-disconnect", next_op_ref: "op_2" });
    expect(calls).toBe(1);
  } finally {
    await replayClient.client.close().catch(() => {});
    f.broker.close();
  }
});

test("same-process redelivery after ambiguous rendezvous converges on the retained UNCERTAIN single-flight", async () => {
  let calls = 0;
  const f = await startFixture(async () => {
    calls += 1;
    throw new Error("synthetic ambiguous rendezvous loss");
  });
  const c = client(f.server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const args = { turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "tree", arguments: { path: "." } };
    const first = await c.client.callTool({ name: "goose_tool", arguments: args });
    expect(first.isError).toBe(true);
    expect(structured(first).output).toBe("UNCERTAIN");
    expect(f.broker.getOperation(f.opRef)?.state).toBe("CLAIMED");

    const replay = await c.client.callTool({ name: "goose_tool", arguments: args });
    expect(replay.isError).toBe(true);
    expect(structured(replay)).toEqual(structured(first));
    expect(calls).toBe(1);
    expect(f.broker.getOperation(f.opRef)?.state).toBe("CLAIMED");
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("live ATTACH without a process-local execution fails closed as UNCERTAIN", async () => {
  let calls = 0;
  const f = await startFixture(async () => { calls += 1; return { outcome: "SUCCESS", dataClass: "task", content: "never" }; });
  const inputHash = (await import("../src/rebuild-connector-http")).connectorOperationInputHash("tree", { path: "." });
  expect(f.broker.claimOperation({ turnRef: f.turnRef, opRef: f.opRef, inputHash }).kind).toBe("EXECUTE");
  const c = client(f.server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const result = await c.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "tree", arguments: { path: "." },
    } });
    expect(result.isError).toBe(true);
    expect(structured(result).output).toBe("UNCERTAIN");
    expect(calls).toBe(0);
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("terminal commit failure after successful rendezvous remains CLAIMED and redelivery stays UNCERTAIN without re-execution", async () => {
  const f = fixture();
  let calls = 0;
  const throwingAuthority = createConnectorOperationAuthority({
    claimOperation: input => f.broker.claimOperation(input),
    classifyMissingOperationRef: (turnRef, inputHash) => f.broker.classifyMissingOperationRef(turnRef, inputHash),
    markUnreconciled: (turnRef, reason) => { f.broker.markUnreconciled(turnRef, reason); },
    completeOperation: () => { throw new Error("synthetic durable terminal commit failure"); },
  });
  const server = startRebuildConnectorHttpServer({
    port: 0,
    authorizationFile: f.authorizationFile,
    authority: throwingAuthority,
    rendezvous: async () => {
      calls += 1;
      return { outcome: "SUCCESS", dataClass: "task", content: "effect-may-have-happened" };
    },
  });
  servers.push(server);
  const c = client(server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const args = { turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "tree", arguments: { path: "." } };
    const first = await c.client.callTool({ name: "goose_tool", arguments: args });
    expect(first.isError).toBe(true);
    expect(structured(first).output).toBe("UNCERTAIN");
    expect(f.broker.getOperation(f.opRef)?.state).toBe("CLAIMED");
    expect(f.broker.getOperation(f.opRef)?.resultJson).toBeNull();
    expect(f.broker.getTurn(f.turnRef)?.state).toBe("UNRECONCILED");
    expect(f.broker.getTurn(f.turnRef)?.unreconciledReason).toBe("connector_terminal_commit_failed_after_execution");

    const replay = await c.client.callTool({ name: "goose_tool", arguments: args });
    expect(replay.isError).toBe(true);
    expect(structured(replay)).toEqual(structured(first));
    expect(calls).toBe(1);
    expect(f.broker.getOperation(f.opRef)?.state).toBe("CLAIMED");
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});

test("BOUNDARY_REQUIRED single-flights exact pre-claim preparation across duplicate connector delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-boundary-"));
  roots.push(root);
  const authorizationFile = join(root, "connector-authorization.txt");
  const authorization = `Bearer ${"b".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  let op = 0;
  const broker = new SessionBroker(join(root, "broker.sqlite"), {
    projectId: "project", instanceId: "boundary-proof", terminalReplayWindowMs: 60_000, now: () => 1_000,
    makeTurnRef: () => "turn-boundary", makeSubmitNonce: () => "nonce-boundary", makeOpRef: () => `op_boundary_${++op}`,
  });
  broker.createEpoch({ gooseSessionId: "goose-boundary" });
  broker.enqueueTurn({ gooseSessionId: "goose-boundary", requestHash: "request-boundary" });
  const admitted = broker.admitNext()!;
  broker.markSendActivated(admitted.turn.turnRef);
  broker.markAccepted(admitted.turn.turnRef, "user-boundary");
  broker.bindConversation({ gooseSessionId: "goose-boundary", epoch: 1, conversationId: "conversation-boundary" });
  const authority = createConnectorOperationAuthority({
    claimOperation: input => broker.claimOperation(input),
    classifyMissingOperationRef: (turnRef, inputHash) => broker.classifyMissingOperationRef(turnRef, inputHash),
    boundOperationInputHash: (turnRef, opRef) => {
      const operation = broker.getOperation(opRef);
      return operation?.turnRef === turnRef ? operation.inputHash : null;
    },
    markUnreconciled: (turnRef, reason) => { broker.markUnreconciled(turnRef, reason); },
    completeOperation: input => input.progressCheckpointJson === undefined
      ? broker.completeOperation(input)
      : broker.completeOperationWithProgress({ ...input, checkpointJson: input.progressCheckpointJson }),
  });
  const prepareStarted = deferred<void>();
  const allowPrepare = deferred<void>();
  let prepares = 0;
  let executions = 0;
  const server = startRebuildConnectorHttpServer({
    port: 0, authorizationFile, authority,
    prepareAnswerBoundary: async request => {
      prepares += 1;
      prepareStarted.resolve();
      await allowPrepare.promise;
      broker.recordAnswerBoundary(request.turnRef, request.opRef, '{"assistant":"stable-pre-tool"}');
    },
    rendezvous: async () => { executions += 1; return { outcome: "SUCCESS", dataClass: "task", content: "ok" }; },
  });
  servers.push(server);
  const a = client(server, authorization);
  const b = client(server, authorization);
  try {
    await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);
    const args = { turn_ref: admitted.turn.turnRef, op_ref: admitted.initialOpRef, tool_name: "tree", arguments: { path: "." } };
    const first = a.client.callTool({ name: "goose_tool", arguments: args });
    await prepareStarted.promise;
    const second = b.client.callTool({ name: "goose_tool", arguments: args });
    await Bun.sleep(40);
    expect(prepares).toBe(1);
    expect(executions).toBe(0);
    expect(broker.getOperation(admitted.initialOpRef)?.state).toBe("MINTED");
    allowPrepare.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(structured(one)).toEqual(structured(two));
    expect(prepares).toBe(1);
    expect(executions).toBe(1);
    expect(broker.getOperation(admitted.initialOpRef)?.answerBoundaryJson).toBe('{"assistant":"stable-pre-tool"}');
    expect(broker.getOperation(admitted.initialOpRef)?.state).toBe("SUCCESS");
  } finally {
    await Promise.all([a.client.close().catch(() => {}), b.client.close().catch(() => {})]);
    broker.close();
  }
});

test("failed boundary preparation leaves MINTED operation unclaimed and never executes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-boundary-fail-"));
  roots.push(root);
  const authorizationFile = join(root, "connector-authorization.txt");
  const authorization = `Bearer ${"c".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  const broker = new SessionBroker(join(root, "broker.sqlite"), {
    projectId: "project", instanceId: "boundary-fail", terminalReplayWindowMs: 60_000, now: () => 1_000,
    makeTurnRef: () => "turn-boundary-fail", makeSubmitNonce: () => "nonce-boundary-fail", makeOpRef: () => "op_boundary_fail",
  });
  broker.createEpoch({ gooseSessionId: "goose-boundary-fail" });
  broker.enqueueTurn({ gooseSessionId: "goose-boundary-fail", requestHash: "request-boundary-fail" });
  const admitted = broker.admitNext()!;
  broker.markSendActivated(admitted.turn.turnRef);
  broker.markAccepted(admitted.turn.turnRef, "user-boundary-fail");
  broker.bindConversation({ gooseSessionId: "goose-boundary-fail", epoch: 1, conversationId: "conversation-boundary-fail" });
  const authority = createConnectorOperationAuthority({
    claimOperation: input => broker.claimOperation(input),
    classifyMissingOperationRef: (turnRef, inputHash) => broker.classifyMissingOperationRef(turnRef, inputHash),
    boundOperationInputHash: (turnRef, opRef) => {
      const operation = broker.getOperation(opRef);
      return operation?.turnRef === turnRef ? operation.inputHash : null;
    },
    markUnreconciled: (turnRef, reason) => { broker.markUnreconciled(turnRef, reason); },
    completeOperation: input => input.progressCheckpointJson === undefined
      ? broker.completeOperation(input)
      : broker.completeOperationWithProgress({ ...input, checkpointJson: input.progressCheckpointJson }),
  });
  let executions = 0;
  const server = startRebuildConnectorHttpServer({
    port: 0, authorizationFile, authority,
    prepareAnswerBoundary: async () => { throw new Error("synthetic boundary observation failure"); },
    rendezvous: async () => { executions += 1; return { outcome: "SUCCESS", dataClass: "task", content: "never" }; },
  });
  servers.push(server);
  const c = client(server, authorization);
  try {
    await c.client.connect(c.transport);
    const result = await c.client.callTool({ name: "goose_tool", arguments: {
      turn_ref: admitted.turn.turnRef, op_ref: admitted.initialOpRef, tool_name: "tree", arguments: { path: "." },
    } });
    expect(result.isError).toBe(true);
    expect(structured(result).output).toBe("BOUNDARY_REQUIRED");
    expect(executions).toBe(0);
    expect(broker.getOperation(admitted.initialOpRef)?.state).toBe("MINTED");
    expect(broker.getOperation(admitted.initialOpRef)?.answerBoundaryJson).toBeNull();
  } finally {
    await c.client.close().catch(() => {});
    broker.close();
  }
});

test("atomic progress-terminal failure through real baton stays CLAIMED, keeps old checkpoint, and never redispatches", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-atomic-baton-fail-"));
  roots.push(root);
  const authorizationFile = join(root, "connector-authorization.txt");
  const authorization = `Bearer ${"d".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  const initialBody = {
    model: "gpt-4.1",
    stream: true,
    input: [
      { role: "system", content: [{ type: "input_text", text: "system" }] },
      { role: "user", content: [{ type: "input_text", text: "user" }] },
    ],
    tools: [{ type: "function", name: "tree", parameters: { type: "object" } }],
  };
  const initialCheckpoint = encodeGooseResponsesProjectionCheckpoint(gooseResponsesProjectionCheckpoint(initialBody));
  let op = 0;
  const broker = new SessionBroker(join(root, "broker.sqlite"), {
    projectId: "project", instanceId: "atomic-baton-fail", terminalReplayWindowMs: 60_000,
    now: () => 1_000, makeTurnRef: () => "turn-atomic-baton", makeSubmitNonce: () => "nonce-atomic-baton",
    makeOpRef: () => `op_atomic_${++op}`,
  });
  broker.createEpoch({ gooseSessionId: "goose-atomic-baton" });
  const turn = broker.enqueueTurn({ gooseSessionId: "goose-atomic-baton", requestHash: "request-atomic-baton", checkpointJson: initialCheckpoint });
  const admitted = broker.admitNext()!;
  broker.markSendActivated(turn.turnRef);
  broker.markAccepted(turn.turnRef, "user-atomic-baton");
  broker.bindConversation({ gooseSessionId: "goose-atomic-baton", epoch: 1, conversationId: "conversation-atomic-baton" });
  broker.recordAnswerBoundary(turn.turnRef, admitted.initialOpRef, '{"boundary":"stable"}');

  const baton = new GooseToolRendezvous({ loadCheckpoint: turnRef => broker.getTurn(turnRef)?.checkpointJson ?? null });
  let dispatches = 0;
  const authority = createConnectorOperationAuthority({
    claimOperation: input => broker.claimOperation(input),
    classifyMissingOperationRef: (turnRef, inputHash) => broker.classifyMissingOperationRef(turnRef, inputHash),
    boundOperationInputHash: (turnRef, opRef) => {
      const operation = broker.getOperation(opRef);
      return operation?.turnRef === turnRef ? operation.inputHash : null;
    },
    markUnreconciled: (turnRef, reason) => { broker.markUnreconciled(turnRef, reason); },
    completeOperation: input => {
      if (input.progressCheckpointJson !== undefined) throw new Error("synthetic atomic durable commit failure");
      return broker.completeOperation(input);
    },
  });
  const server = startRebuildConnectorHttpServer({
    port: 0, authorizationFile, authority,
    rendezvous: async request => {
      dispatches += 1;
      const continuation = await baton.dispatchTool(request);
      return {
        outcome: "SUCCESS",
        dataClass: "task",
        content: continuation.output,
        progress: {
          checkpointJson: continuation.checkpointJson,
          onCommitted: () => continuation.commit(),
          onCommitFailed: () => continuation.abort(),
        },
      };
    },
  });
  servers.push(server);
  const c = client(server, authorization);
  try {
    await c.client.connect(c.transport);
    const stage = baton.openStage({ turnRef: turn.turnRef, body: initialBody });
    const args = { turn_ref: turn.turnRef, op_ref: admitted.initialOpRef, tool_name: "tree", arguments: { path: "." } };
    const connectorCall = c.client.callTool({ name: "goose_tool", arguments: args });
    const directive = await stage.waitForDirective();
    const continuationBody = {
      ...initialBody,
      input: [
        ...initialBody.input,
        { type: "function_call", call_id: directive.opRef, name: directive.toolName, arguments: directive.argumentsJson },
        { type: "function_call_output", call_id: directive.opRef, output: "effect-may-have-happened" },
      ],
    };
    const pending = baton.openStage({ turnRef: turn.turnRef, body: continuationBody });
    const first = await connectorCall;
    expect(first.isError).toBe(true);
    expect(structured(first).output).toBe("UNCERTAIN");
    expect(dispatches).toBe(1);
    expect(broker.getTurn(turn.turnRef)?.checkpointJson).toBe(initialCheckpoint);
    expect(broker.getOperation(admitted.initialOpRef)?.state).toBe("CLAIMED");
    expect(broker.getOperation(admitted.initialOpRef)?.resultJson).toBeNull();
    expect(broker.getTurn(turn.turnRef)?.state).toBe("UNRECONCILED");
    expect(broker.getTurn(turn.turnRef)?.unreconciledReason).toBe("connector_terminal_commit_failed_after_execution");
    expect(broker.getOperation("op_atomic_2")).toBeNull();
    await expect(pending.waitForDirective()).rejects.toMatchObject({ code: "TURN_UNCERTAIN" });

    const replay = await c.client.callTool({ name: "goose_tool", arguments: args });
    expect(replay.isError).toBe(true);
    expect(structured(replay)).toEqual(structured(first));
    expect(dispatches).toBe(1);
  } finally {
    await c.client.close().catch(() => {});
    broker.close();
  }
});

test("post-commit stage activation failure cannot rewrite durable SUCCESS and redelivery replays it", async () => {
  const f = fixture();
  let calls = 0;
  let failedCallbacks = 0;
  const server = startRebuildConnectorHttpServer({
    port: 0,
    authorizationFile: f.authorizationFile,
    authority: f.authority,
    rendezvous: async () => {
      calls += 1;
      return {
        outcome: "SUCCESS",
        dataClass: "task",
        content: "durable-result",
        progress: {
          checkpointJson: '{"projection":"advanced"}',
          onCommitted: () => { throw new Error("synthetic stage activation failure"); },
          onCommitFailed: () => { failedCallbacks += 1; },
        },
      };
    },
  });
  servers.push(server);
  const c = client(server, f.authorization);
  try {
    await c.client.connect(c.transport);
    const args = { turn_ref: f.turnRef, op_ref: f.opRef, tool_name: "tree", arguments: { path: "." } };
    const first = await c.client.callTool({ name: "goose_tool", arguments: args });
    expect(first.isError).toBe(true);
    expect(structured(first).output).toBe("UNCERTAIN");
    expect(failedCallbacks).toBe(0);
    expect(f.broker.getOperation(f.opRef)?.state).toBe("SUCCESS");
    expect(f.broker.getTurn(f.turnRef)?.checkpointJson).toBe('{"projection":"advanced"}');

    const replay = await c.client.callTool({ name: "goose_tool", arguments: args });
    expect(replay.isError).not.toBe(true);
    expect(structured(replay)).toMatchObject({ ok: true, output: "durable-result", op_ref: f.opRef });
    expect(calls).toBe(1);
  } finally {
    await c.client.close().catch(() => {});
    f.broker.close();
  }
});
