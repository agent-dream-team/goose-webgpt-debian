import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import { startPersistentRebuildService } from "../src/rebuild-runtime-service";
import { VERSION } from "../src/version";

const roots: string[] = [];
afterEach(() => {
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  delete process.env.CODEX_CHATGPT_WEB_REBUILD_NODE_EXECUTABLE;
  delete process.env.CODEX_CHATGPT_WEB_REBUILD_NODE_WORKER;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("persistent rebuild service owns stable private state and supervisor health identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-rebuild-service-"));
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  const descriptor = join(root, "runtime", "launcher-browser.json");
  const worker = join(root, "runtime", "rebuild-node-browser-worker.mjs");
  const executable = join(root, "runtime", "node-executable");
  const auth = join(root, "secrets", "connector-authorization.txt");
  mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(descriptor, "{}\n", { mode: 0o600 });
  writeFileSync(worker, "// fixture\n", { mode: 0o700 });
  writeFileSync(executable, "fixture\n", { mode: 0o700 });
  writeFileSync(auth, `Bearer ${"r".repeat(64)}\n`, { mode: 0o600 });
  chmodSync(auth, 0o600);
  process.env.CODEX_CHATGPT_WEB_REBUILD_NODE_EXECUTABLE = executable;
  process.env.CODEX_CHATGPT_WEB_REBUILD_NODE_WORKER = worker;

  const config = {
    version: 3,
    runtimeKind: "persistent-rebuild",
    releaseVersion: VERSION,
    mode: "full",
    subagentProtocol: "compatibility-v1",
    host: "127.0.0.1",
    port: 0,
    contextWindow: 256_000,
    appName: "Codex Native2",
    automaticAppName: "Codex Native2",
    manualAppName: "Codex Zero Risk",
    browserHost: "launcher",
    browserInteractionMode: "automatic",
    browserHostDescriptorPath: descriptor,
    chromeExecutablePath: executable,
    storageStatePath: join(root, "storage.json"),
    brokerSocketPath: join(root, "runtime", "turn-broker.sock"),
    headed: true,
    solAvailable: true,
    proAvailable: false,
    zeroRiskProEnabled: false,
    autoApproveToolCalls: false,
    controlToken: "rebuild-service-control-token-0123456789abcdef",
    runtimeCommand: [executable],
    rebuild: {
      projectId: "g-p-0123456789abcdef",
      projectName: "CGW Provider Sessions",
      connectorName: "Goose Native 2nd Shift",
      connectorMentionQuery: "@Goose Native",
      connectorPort: 0,
    },
    tunnel: undefined,
  } satisfies AppConfig;

  const service = startPersistentRebuildService(config);
  try {
    const health = await fetch(`${service.runtime.origin}/healthz`).then(response => response.json()) as Record<string, unknown>;
    expect(health).toMatchObject({
      status: "ok",
      service: "goose-chatgpt-web-rebuild",
      version: VERSION,
      mode: "full",
      accepting_turns: true,
      active_http_turns: 0,
      active_browser_turns: 0,
    });
    expect(existsSync(join(root, "runtime", "persistent-rebuild-broker.sqlite"))).toBe(true);
  } finally {
    await service.stop();
    await service.stopped;
  }
});
