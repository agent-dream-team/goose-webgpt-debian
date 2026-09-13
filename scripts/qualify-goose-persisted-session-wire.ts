import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResponsesSse } from "./qualify-goose-responses-wire";

const MODEL = "gpt-4.1";

type ObservedRequest = {
  sessionId: string;
  input: Array<Record<string, unknown>>;
};

function runGoose(gooseBin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(gooseBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

export async function runGoosePersistedSessionWireQualification(gooseBin = process.env.GOOSE_BIN ?? "goose") {
  const version = spawnSync(gooseBin, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const gooseVersion = version.stdout.trim();
  const expectedVersion = process.env.GOOSE_EXPECTED_VERSION ?? "1.50.0";
  assert(gooseVersion.includes(expectedVersion), `Expected Goose ${expectedVersion}; got ${gooseVersion}`);

  const root = mkdtempSync(join(tmpdir(), "cgw-goose-persisted-wire-"));
  const observed: ObservedRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "cgw-qualification", meta: { n_ctx: 200_000 } }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.statusCode = 404;
      response.end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const body = JSON.parse(raw) as { input?: Array<Record<string, unknown>> };
    const sessionId = request.headers["agent-session-id"];
    if (typeof sessionId !== "string") throw new Error("Goose did not send one scalar agent-session-id");
    assert(Array.isArray(body.input), "Goose Responses request did not include array input");
    observed.push({ sessionId, input: body.input });
    const text = observed.length === 1 ? "PERSISTED_FIRST_OK" : "PERSISTED_SECOND_OK";
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.end(buildResponsesSse({ text, responseId: `resp_persisted_${observed.length}` }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const sessionName = `cgw-persisted-wire-${Date.now()}`;
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_DATA_HOME: join(root, ".local", "share"),
    XDG_STATE_HOME: join(root, ".local", "state"),
    OPENAI_API_KEY: "local-persisted-wire-qualification",
    OPENAI_HOST: origin,
    OPENAI_BASE_PATH: "v1/responses",
    OPENAI_STORE: "false",
    NO_PROXY: "127.0.0.1,localhost",
  };
  const baseArgs = ["run", "--name", sessionName, "--no-profile", "--provider", "openai", "--model", MODEL, "--max-turns", "1", "--quiet"];

  try {
    const first = await runGoose(gooseBin, [...baseArgs, "--text", "Reply exactly PERSISTED_FIRST_OK."], env);
    assert.equal(first.code, 0, first.stderr);
    assert(first.stdout.includes("PERSISTED_FIRST_OK"));
    const second = await runGoose(gooseBin, [...baseArgs, "--resume", "--text", "Reply exactly PERSISTED_SECOND_OK."], env);
    assert.equal(second.code, 0, second.stderr);
    assert(second.stdout.includes("PERSISTED_SECOND_OK"));

    assert.equal(observed.length, 2, `Expected two Responses requests, got ${observed.length}`);
    assert.equal(observed[1]!.sessionId, observed[0]!.sessionId, "Goose changed agent-session-id across persisted resume");
    const firstInput = observed[0]!.input;
    const secondInput = observed[1]!.input;
    assert.equal(firstInput.length, 2, "Fresh persisted session did not begin with exactly system,user input");
    assert(secondInput.length > firstInput.length, "Persisted resume did not extend canonical input");
    assert.deepEqual(secondInput.slice(0, firstInput.length), firstInput, "Persisted resume rewrote the represented input prefix");
    assert.deepEqual(secondInput.map(item => item.type), ["message", "message", "message", "message"]);
    assert.equal(secondInput[2]?.role, "assistant");
    assert.equal(secondInput[3]?.role, "user");

    return {
      gooseVersion,
      sessionIdStable: true,
      firstInputCount: firstInput.length,
      secondInputCount: secondInput.length,
      secondInputTypes: secondInput.map(item => item.type),
      secondInputRoles: secondInput.map(item => item.role ?? null),
    };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runGoosePersistedSessionWireQualification();
  process.stdout.write(`GOOSE_PERSISTED_SESSION_WIRE_QUALIFICATION_OK ${result.gooseVersion}\n${JSON.stringify(result)}\n`);
}
