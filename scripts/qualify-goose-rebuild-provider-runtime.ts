import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decodeGooseCanonicalHistoryWatermark } from "../src/goose-canonical-history";
import { decodeGooseResponsesProjectionCheckpoint } from "../src/goose-responses-projection";
import {
  startRebuildProviderRuntime,
  type RebuildPersistentBrowserDriver,
  type RebuildPersistentBrowserTurnInput,
} from "../src/rebuild-provider-runtime";

const MODEL = "gpt-4.1";
const FINAL = "REBUILD_RUNTIME_GOOSE_OK";
const CONVERSATION = "cccccccc-dddd-4eee-8fff-000000000001";

function gooseEnvironment(origin: string): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of [
    "OPENAI_API_KEY", "OPENAI_HOST", "OPENAI_BASE_URL", "OPENAI_BASE_PATH", "OPENAI_STORE",
    "OPENAI_ORGANIZATION", "OPENAI_PROJECT", "OPENAI_CUSTOM_HEADERS",
  ]) delete env[key];
  return {
    ...env,
    OPENAI_API_KEY: "local-rebuild-runtime-qualification",
    OPENAI_HOST: origin,
    OPENAI_BASE_PATH: "v1/responses",
    OPENAI_STORE: "false",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

export async function runGooseRebuildProviderRuntimeQualification(gooseBin = process.env.GOOSE_BIN ?? "goose") {
  const version = spawnSync(gooseBin, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const gooseVersion = version.stdout.trim();
  assert(gooseVersion.includes(process.env.GOOSE_EXPECTED_VERSION ?? "1.50.0"), `Unexpected Goose version: ${gooseVersion}`);

  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-runtime-goose-"));
  const authorizationFile = join(root, "connector-auth.txt");
  const authorization = `Bearer ${"q".repeat(64)}`;
  writeFileSync(authorizationFile, `${authorization}\n`, { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);

  let invokeTool!: (input: RebuildPersistentBrowserTurnInput) => Promise<Record<string, unknown>>;
  let browserStarts = 0;
  let boundaryCaptures = 0;
  let observedSessionId = "";
  let observedTurnRef = "";
  let observedOpRef = "";
  let connectorTerminal: Record<string, unknown> | undefined;
  const driver: RebuildPersistentBrowserDriver = {
    createTurn(input) {
      browserStarts += 1;
      observedSessionId = input.gooseSessionId;
      observedTurnRef = input.turnRef;
      observedOpRef = input.initialOpRef;
      return {
        captureAnswerBoundary: async opRef => {
          boundaryCaptures += 1;
          assert.equal(opRef, input.initialOpRef);
          return JSON.stringify({ kind: "local-runtime-fresh-boundary", chars: 0 });
        },
        confirmFinal: async evidence => evidence,
        run: async () => {
          input.lifecycle.onSendActivated();
          input.lifecycle.onAccepted({
            canonicalConversationId: CONVERSATION,
            acceptedUserTurnId: "user_local_runtime_goose",
          });
          connectorTerminal = await invokeTool(input);
          assert.equal(connectorTerminal.ok, true);
          assert.equal(connectorTerminal.op_ref, input.initialOpRef);
          assert.equal(typeof connectorTerminal.next_op_ref, "string");
          return {
            canonicalConversationId: CONVERSATION,
            acceptedUserTurnId: "user_local_runtime_goose",
            text: FINAL,
            remoteNonRunning: true,
            contentAdvancedAfterLastTool: true,
          };
        },
      };
    },
  };

  const runtime = startRebuildProviderRuntime({
    port: 0,
    model: MODEL,
    contextWindow: 200_000,
    controlToken: "local-control-token",
    projectId: "local-rebuild-runtime-project",
    connectorIdentity: "Goose Native 2nd Shift",
    brokerPath: join(root, "broker.sqlite"),
    connectorPort: 0,
    connectorAuthorizationFile: authorizationFile,
    browserDriver: driver,
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${runtime.connector.origin}/mcp`), {
    requestInit: { headers: { authorization } },
  });
  const connector = new Client({ name: "local-rebuild-runtime-qualification", version: "1.0.0" });
  await connector.connect(transport);
  invokeTool = async input => {
    const result = await connector.callTool({ name: "goose_tool", arguments: {
      turn_ref: input.turnRef,
      op_ref: input.initialOpRef,
      tool_name: "tree",
      arguments: { path: "." },
    } });
    return result.structuredContent as Record<string, unknown>;
  };

  const child = spawn(gooseBin, [
    "run", "--provider", "openai", "--model", MODEL, "--no-session", "--no-profile",
    "--with-builtin", "developer", "--max-turns", "3", "--quiet", "--output-format", "text",
    "-t", "Follow the provider response. Execute only the provider-issued tool call and then return the provider's final text.",
  ], {
    cwd: process.cwd(),
    env: gooseEnvironment(runtime.origin),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });

  try {
    const exitCode = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Goose rebuild runtime qualification timed out")), 30_000)),
    ]);
    assert.equal(exitCode, 0, stderr.slice(0, 2_000));
    assert(stdout.includes(FINAL), `Goose stdout did not contain ${FINAL}: ${stdout.slice(0, 2_000)}`);
    assert.equal(browserStarts, 1);
    assert.equal(boundaryCaptures, 1);
    assert(observedSessionId.length > 0);
    assert(observedTurnRef.length > 0);
    assert(observedOpRef.length > 0);
    assert.equal(runtime.broker.getOperation(observedOpRef)?.state, "SUCCESS");
    assert.equal(runtime.broker.getTurn(observedTurnRef)?.state, "COMPLETE");
    assert.equal(runtime.broker.getActiveAccountSlotCount(), 0);
    const epoch = runtime.broker.getCurrentEpoch(observedSessionId);
    assert(epoch);
    assert.equal(epoch.epoch, 1);
    assert.equal(epoch.conversationId, CONVERSATION);
    const completedTurn = runtime.broker.getTurn(observedTurnRef);
    assert(completedTurn?.checkpointJson);
    assert(epoch.historyWatermark);
    const history = decodeGooseCanonicalHistoryWatermark(epoch.historyWatermark);
    const projection = decodeGooseResponsesProjectionCheckpoint(completedTurn.checkpointJson);
    assert.equal(history.representedInputHash, projection.inputHash);
    assert.deepEqual(history.representedInputItemHashes, projection.inputItemHashes);
    assert.equal(epoch.leaseState, "IDLE");
    assert.equal(connectorTerminal?.next_op_ref, runtime.broker.getOperation(connectorTerminal?.next_op_ref as string)?.opRef);
    return {
      gooseVersion,
      browserStarts,
      boundaryCaptures,
      operationState: runtime.broker.getOperation(observedOpRef)?.state,
      turnState: runtime.broker.getTurn(observedTurnRef)?.state,
      epoch: epoch.epoch,
      leaseState: epoch.leaseState,
      finalObserved: true,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await connector.close().catch(() => {});
    await runtime.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runGooseRebuildProviderRuntimeQualification();
  process.stdout.write(`GOOSE_REBUILD_PROVIDER_RUNTIME_QUALIFICATION_OK ${result.gooseVersion}\n${JSON.stringify(result)}\n`);
}
