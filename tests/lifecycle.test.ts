import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import {
  getLifecycleStatus,
  proveLauncherBrowserHostSurfaceReady,
  waitForLauncherBrowserHostSessionReady,
} from "../src/lifecycle";
import { LAUNCHER_BROWSER_HOST_KIND, probeLauncherBrowserHost } from "../src/launcher-browser-host";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(
  endpoint = "http://127.0.0.1:39110",
  controlEndpoint = "http://127.0.0.1:39111",
): string {
  const root = mkdtempSync(join(tmpdir(), "codex-lifecycle-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint,
    control: {
      endpoint: controlEndpoint,
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: {
      executable: process.execPath,
      script: import.meta.path,
    },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

test("failed disposable surface connection always sends phase=end and preserves the connect error", async () => {
  const calls: string[] = [];
  await expect(proveLauncherBrowserHostSurfaceReady("/tmp/unused", {
    notify: async (_path, activity) => {
      calls.push(`${activity.phase}:${"status" in activity ? activity.status : ""}`);
      if (activity.phase === "start") return { surfaceId: "launcher_surface_id_0123456789AB" };
      return {};
    },
    runHelperSmoke: async () => {
      throw new Error("synthetic connect failure");
    },
  })).rejects.toThrow("synthetic connect failure");
  expect(calls).toEqual(["start:", "end:failed"]);
});

test("the lifecycle probe does not retry session inspection while the lease is active", async () => {
  const calls: string[] = [];
  const surfaces: string[] = [];
  await expect(proveLauncherBrowserHostSurfaceReady("/tmp/unused", {
    notify: async (_path, activity) => {
      calls.push(activity.phase);
      if (activity.phase === "start") return { surfaceId: "launcher_surface_id_0123456789AB" };
      return {};
    },
    runHelperSmoke: async (_path, _traceId, surfaceId) => {
      surfaces.push(surfaceId);
    },
  })).resolves.toBeUndefined();
  expect(calls).toEqual(["start", "end"]);
  expect(surfaces).toEqual(["launcher_surface_id_0123456789AB"]);
});

test("launcher status uses a read-only CDP health probe instead of exclusive session inspection", async () => {
  const server = createServer(async (request, response) => {
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:39110/devtools/browser/test" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const root = mkdtempSync(join(tmpdir(), "codex-lifecycle-home-"));
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    saveConfig({
      ...defaultConfig("browser-only"),
      browserHost: "launcher",
      browserHostDescriptorPath: path,
    });
    const status = await getLifecycleStatus();
    expect(status.browserHost).toEqual({ ready: true });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
