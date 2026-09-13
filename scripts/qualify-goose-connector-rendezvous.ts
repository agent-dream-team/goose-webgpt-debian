import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  decodeGooseResponsesProjectionCheckpoint,
  encodeGooseResponsesProjectionCheckpoint,
  gooseResponsesProjectionCheckpoint,
} from "../src/goose-responses-projection";
import { GooseToolRendezvous } from "../src/goose-tool-rendezvous";
import {
  createConnectorOperationAuthority,
  startRebuildConnectorHttpServer,
} from "../src/rebuild-connector-http";
import { SessionBroker } from "../src/session-broker";
import { buildResponsesSse } from "./qualify-goose-responses-wire";

const MODEL = "gpt-4.1";

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) raw += chunk.toString();
  return JSON.parse(raw);
}

function sendSse(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.end(body);
}

function gooseEnvironment(origin: string): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of [
    "OPENAI_API_KEY", "OPENAI_HOST", "OPENAI_BASE_URL", "OPENAI_BASE_PATH", "OPENAI_STORE",
    "OPENAI_ORGANIZATION", "OPENAI_PROJECT", "OPENAI_CUSTOM_HEADERS",
  ]) delete env[key];
  return {
    ...env,
    OPENAI_API_KEY: "local-rendezvous-qualification",
    OPENAI_HOST: origin,
    OPENAI_BASE_PATH: "v1/responses",
    OPENAI_STORE: "false",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

export async function runGooseConnectorRendezvousQualification(gooseBin = process.env.GOOSE_BIN ?? "goose") {
  const version = spawnSync(gooseBin, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const gooseVersion = version.stdout.trim();
  assert(gooseVersion.includes(process.env.GOOSE_EXPECTED_VERSION ?? "1.50.0"), `Unexpected Goose version: ${gooseVersion}`);

  const root = mkdtempSync(join(tmpdir(), "cgw-goose-connector-rendezvous-"));
  const authorizationFile = join(root, "connector-authorization.txt");
  const authorization = `Bearer ${"r".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);

  let opCounter = 0;
  const broker = new SessionBroker(join(root, "broker.sqlite"), {
    projectId: "local-rendezvous-project",
    terminalReplayWindowMs: 60_000,
    instanceId: "local-rendezvous-broker",
    makeTurnRef: () => "turn_local_rendezvous",
    makeSubmitNonce: () => "submit_local_rendezvous",
    makeOpRef: () => `op_local_${++opCounter}`,
  });
  const authority = createConnectorOperationAuthority({
    claimOperation: input => broker.claimOperation(input),
    classifyMissingOperationRef: (turnRef, inputHash) => broker.classifyMissingOperationRef(turnRef, inputHash),
    markUnreconciled: (turnRef, reason) => { broker.markUnreconciled(turnRef, reason); },
    completeOperation: input => input.progressCheckpointJson === undefined
      ? broker.completeOperation(input)
      : broker.completeOperationWithProgress({ ...input, checkpointJson: input.progressCheckpointJson }),
  });

  const toolRendezvous = new GooseToolRendezvous({
    loadCheckpoint: turnRef => broker.getTurn(turnRef)?.checkpointJson ?? null,
  });
  let boundaryPreparationCount = 0;
  const connector = startRebuildConnectorHttpServer({
    port: 0,
    authorizationFile,
    authority,
    resolveToolName: (turnRef, requestedToolName) => {
      try {
        return { kind: "RESOLVED", toolName: toolRendezvous.resolveToolName(turnRef, requestedToolName) };
      } catch {
        return { kind: "REJECT", code: "TOOL_UNAVAILABLE" };
      }
    },
    prepareAnswerBoundary: async request => {
      boundaryPreparationCount += 1;
      broker.recordAnswerBoundary(request.turnRef, request.opRef, '{"kind":"local-rendezvous-proof"}');
    },
    rendezvous: async request => {
      const continuation = await toolRendezvous.dispatchTool(request);
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
  const connectorTransport = new StreamableHTTPClientTransport(new URL(`${connector.origin}/mcp`), {
    requestInit: { headers: { authorization } },
  });
  const connectorClient = new Client({ name: "local-rendezvous-proof", version: "1.0.0" });
  await connectorClient.connect(connectorTransport);

  let postCount = 0;
  let sessionId: string | undefined;
  let turnRef: string | undefined;
  let opRef: string | undefined;
  let connectorCall: Promise<Awaited<ReturnType<Client["callTool"]>>> | undefined;
  let classifierKind: string | undefined;
  let connectorTerminal: Record<string, unknown> | undefined;

  const provider = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: MODEL, object: "model", created: 0, owned_by: "local-rendezvous", meta: { n_ctx: 200_000 } }],
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    try {
      postCount += 1;
      const body = await readJsonBody(request);
      const rawSessionId = request.headers["agent-session-id"];
      assert.equal(typeof rawSessionId, "string", "Goose did not send one scalar agent-session-id");
      const observedSessionId = rawSessionId as string;
      if (!sessionId) sessionId = observedSessionId;
      else assert.equal(observedSessionId, sessionId, "Goose changed agent-session-id during tool continuation");

      if (postCount === 1) {
        const checkpoint = gooseResponsesProjectionCheckpoint(body);
        const firstSessionId = sessionId;
        assert(firstSessionId);
        broker.createEpoch({ gooseSessionId: firstSessionId });
        const turn = broker.enqueueTurn({
          gooseSessionId: firstSessionId,
          requestHash: checkpoint.requestHash,
          checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
        });
        const admitted = broker.admitNext();
        assert(admitted);
        turnRef = turn.turnRef;
        opRef = admitted.initialOpRef;
        broker.markSendActivated(turnRef);
        broker.markAccepted(turnRef, "user_local_rendezvous");
        broker.bindConversation({
          gooseSessionId: firstSessionId,
          epoch: turn.epoch,
          conversationId: "11111111-2222-4333-8444-555555555555",
        });

        const stage = toolRendezvous.openStage({ turnRef, body });
        const toolArguments = { path: "." };
        connectorCall = connectorClient.callTool({
          name: "goose_tool",
          arguments: { turn_ref: turnRef, op_ref: opRef, tool_name: "developer__tree", arguments: toolArguments },
        });
        const directive = await stage.waitForDirective();
        assert.deepEqual(directive, {
          kind: "FUNCTION_CALL", opRef, toolName: "tree", argumentsJson: '{"path":"."}',
        });
        assert.equal(boundaryPreparationCount, 1);
        assert.equal(broker.getOperation(opRef)?.state, "CLAIMED");
        sendSse(response, buildResponsesSse({
          toolCall: { name: directive.toolName, callId: directive.opRef, arguments: directive.argumentsJson },
          responseId: "resp_local_tool_dispatch",
        }));
        return;
      }

      assert.equal(postCount, 2, "Qualification received an unexpected extra Responses POST");
      assert(turnRef && opRef && connectorCall);
      const nextStage = toolRendezvous.openStage({ turnRef, body });
      classifierKind = "TOOL_RESULT";

      const connectorResponse = await connectorCall;
      assert.equal(connectorResponse.isError, undefined);
      connectorTerminal = connectorResponse.structuredContent as Record<string, unknown>;
      assert.equal(connectorTerminal.ok, true);
      assert.equal(connectorTerminal.turn_ref, turnRef);
      assert.equal(connectorTerminal.op_ref, opRef);
      assert.equal(connectorTerminal.next_op_ref, "op_local_2");
      assert.equal(broker.getOperation(opRef)?.state, "SUCCESS");
      assert.equal(broker.getOperation("op_local_2")?.state, "MINTED");
      assert.equal(nextStage.releaseBeforeDispatch(), true);

      sendSse(response, buildResponsesSse({ text: "RENDEZVOUS_OK", responseId: "resp_local_final" }));
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", () => resolve());
  });
  const address = provider.address();
  assert(address && typeof address !== "string");
  const providerOrigin = `http://127.0.0.1:${address.port}`;

  const child = spawn(gooseBin, [
    "run", "--provider", "openai", "--model", MODEL, "--no-session", "--no-profile",
    "--with-builtin", "developer", "--max-turns", "3", "--quiet", "--output-format", "text",
    "-t", "Follow the provider response. Do not make any tool call except the one explicitly requested by the provider.",
  ], {
    cwd: process.cwd(),
    env: gooseEnvironment(providerOrigin),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });

  let exitCode: number | null = null;
  try {
    exitCode = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Goose rendezvous qualification timed out")), 30_000)),
    ]);
    assert.equal(exitCode, 0, stderr.slice(0, 2_000));
    assert(stdout.includes("RENDEZVOUS_OK"), `Goose stdout did not contain final proof marker: ${stdout.slice(0, 2_000)}`);
    assert.equal(postCount, 2);
    assert.equal(classifierKind, "TOOL_RESULT");
    assert(connectorTerminal?.ok === true);
    assert(sessionId && turnRef && opRef);
    const persisted = decodeGooseResponsesProjectionCheckpoint(broker.getTurn(turnRef)?.checkpointJson ?? null);
    assert.equal(persisted.inputCount, 4);
    assert.equal(broker.getOperation(opRef)?.state, "SUCCESS");
    return {
      gooseVersion,
      postCount,
      sessionIdStable: true,
      classifierKind,
      operationState: broker.getOperation(opRef)?.state,
      nextOperationState: broker.getOperation("op_local_2")?.state,
      persistedInputCount: persisted.inputCount,
      connectorResultOk: connectorTerminal.ok,
      boundaryPreparationCount,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await connectorClient.close().catch(() => {});
    await connector.stop().catch(() => {});
    await new Promise<void>(resolve => provider.close(() => resolve())).catch(() => {});
    broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runGooseConnectorRendezvousQualification();
  process.stdout.write(`GOOSE_CONNECTOR_RENDEZVOUS_QUALIFICATION_OK ${result.gooseVersion}\n${JSON.stringify(result)}\n`);
}
