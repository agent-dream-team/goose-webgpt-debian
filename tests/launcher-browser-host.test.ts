import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_TURN_END_TIMEOUT_MS,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  LAUNCHER_TURN_START_TIMEOUT_MS,
  LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS,
  LAUNCHER_AUTOMATION_VIEWPORT,
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_MIN_LAYOUT_VIEWPORT,
  ensureLauncherAutomationViewport,
  inspectLauncherBrowserHost,
  launcherAutomationViewportRequired,
  probeLauncherBrowserHost,
  type LauncherViewportSize,
  notifyLauncherTurn,
  readLauncherBrowserHostDescriptor,
  selectLauncherPage,
} from "../src/launcher-browser-host";
import type { Browser, BrowserContext, Page } from "playwright-core";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(
  endpoint = "http://127.0.0.1:39110",
  controlEndpoint = "http://127.0.0.1:39111",
): string {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-descriptor-"));
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

test("launcher descriptor is owner-only, loopback-only, and process-bound", () => {
  const path = descriptorFile();
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    surfaceId: "launcher_surface_id_0123456789AB",
  });
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("unsafe permissions");
  }
});

test("launcher turn control sends authenticated lifecycle events", async () => {
  expect(LAUNCHER_TURN_START_TIMEOUT_MS).toBe(5_000);
  expect(LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS).toBe(10_000);
  expect(LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).toBe(5_000);
  expect(LAUNCHER_TURN_END_TIMEOUT_MS).toBe(15_000);
  let received: { authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/turn/start"
      ? '{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB"}\n'
      : '{"ok":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile("http://127.0.0.1:39110", `http://127.0.0.1:${address.port}`);
    await expect(notifyLauncherTurn(path, {
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
    })).resolves.toEqual({ surfaceId: "launcher_surface_id_0123456789AB" });
    expect(received.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(received.body).toEqual({ phase: "start", traceId: "abc123def456", helperPid: process.pid });
    await notifyLauncherTurn(path, {
      phase: "heartbeat",
      traceId: "abc123def456",
      helperPid: process.pid,
    });
    expect(received.body).toEqual({ phase: "heartbeat", traceId: "abc123def456", helperPid: process.pid });
    await notifyLauncherTurn(path, {
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
    });
    expect(received.body).toEqual({
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification uses the authenticated control channel instead of Bun CDP", async () => {
  expect(LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS).toBe(120_000);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectPro: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile("http://127.0.0.1:39110", `http://127.0.0.1:${address.port}`);
    expect(await inspectLauncherBrowserHost(path, { detectPro: true })).toEqual({
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification reports its own deadline instead of a generic abort", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
    if (!response.destroyed) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"late"}\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile("http://127.0.0.1:39110", `http://127.0.0.1:${address.port}`);
    await expect(inspectLauncherBrowserHost(path, { detectPro: true, timeoutMs: 5 }))
      .rejects.toThrow("session inspection timed out after 5ms");
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher status probe uses only read-only CDP health and rejects stale descriptors", async () => {
  const server = createServer(async (request, response) => {
    expect(request.url).toBe("/json/version");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:39110/devtools/browser/test" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(probeLauncherBrowserHost(path, { timeoutMs: 100 })).resolves.toBeUndefined();
    const stale = readLauncherBrowserHostDescriptor(path);
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.pid = process.pid + 1_000_000;
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("process is not running");
    expect(stale.pid).toBe(process.pid);
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher descriptor rejects non-loopback browser ownership", () => {
  const path = descriptorFile();
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.endpoint = "https://example.com:443";
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("http://127.0.0.1");
});

test("launcher page selection uses the owned surface marker instead of URL order", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const hiddenPage = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    evaluate: async () => "another_surface_id_0123456789ABC",
  } as unknown as Page;
  const ownedPage = {
    url: () => "about:blank#codex-web-gpt-browser-host",
    evaluate: async () => descriptor.surfaceId,
  } as unknown as Page;
  const context = {
    pages: () => [hiddenPage, ownedPage],
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(await selectLauncherPage(browser, descriptor, 20)).toEqual({
    context,
    page: ownedPage,
  });
});

test("launcher page selection rejects duplicated ownership markers", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const page = () => ({
    evaluate: async () => descriptor.surfaceId,
  }) as unknown as Page;
  const context = {
    pages: () => [page(), page()],
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(selectLauncherPage(browser, descriptor, 20)).rejects.toThrow(
    "2 surfaces with the same ownership id",
  );
});

test("an unmeasured launcher surface needs an automation viewport, a measured one does not", () => {
  expect(launcherAutomationViewportRequired({ width: 1, height: 1 })).toBe(true);
  expect(launcherAutomationViewportRequired(undefined)).toBe(true);
  expect(launcherAutomationViewportRequired({ width: Number.NaN, height: 800 })).toBe(true);
  expect(launcherAutomationViewportRequired({
    width: LAUNCHER_MIN_LAYOUT_VIEWPORT.width,
    height: LAUNCHER_MIN_LAYOUT_VIEWPORT.height - 1,
  })).toBe(true);
  expect(launcherAutomationViewportRequired(LAUNCHER_MIN_LAYOUT_VIEWPORT)).toBe(false);
  expect(launcherAutomationViewportRequired({ width: 900, height: 600 })).toBe(false);
});

test("a launcher surface left at the placeholder viewport is resized for automation", async () => {
  const applied: LauncherViewportSize[] = [];
  const page = {
    evaluate: async () => applied.at(-1) ?? { width: 1, height: 1 },
    setViewportSize: async (size: LauncherViewportSize) => { applied.push(size); },
  } as unknown as Page;

  expect(await ensureLauncherAutomationViewport(page)).toEqual(LAUNCHER_AUTOMATION_VIEWPORT);
  expect(applied).toEqual([LAUNCHER_AUTOMATION_VIEWPORT]);
});

test("the launcher automation viewport matches the managed-Chrome Playwright default", () => {
  expect(LAUNCHER_AUTOMATION_VIEWPORT).toEqual({ width: 1280, height: 720 });
});

test("a launcher surface that ignores the resize fails instead of reaching an actionability check", async () => {
  const page = {
    evaluate: async () => ({ width: 1, height: 1 }),
    setViewportSize: async () => {},
  } as unknown as Page;

  expect(ensureLauncherAutomationViewport(page)).rejects.toThrow(
    "kept an unusable layout viewport (1x1) after a 1280x720 automation viewport was applied",
  );
});

test("a launcher surface the UI already measured keeps its real geometry", async () => {
  const applied: unknown[] = [];
  const page = {
    evaluate: async () => ({ width: 900, height: 640 }),
    setViewportSize: async (size: unknown) => { applied.push(size); },
  } as unknown as Page;

  expect(await ensureLauncherAutomationViewport(page)).toBeNull();
  expect(applied).toEqual([]);
});

test("a launcher surface that cannot be resized fails with its measured geometry", async () => {
  const page = {
    evaluate: async () => ({ width: 1, height: 1 }),
    setViewportSize: async () => { throw new Error("viewport emulation unavailable"); },
  } as unknown as Page;

  expect(ensureLauncherAutomationViewport(page)).rejects.toThrow(
    "no usable layout viewport (1x1)",
  );
});

test("launcher page selection stops immediately when acquisition is aborted", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const browser = {
    contexts: () => [],
  } as unknown as Browser;
  const controller = new AbortController();
  controller.abort();

  expect(selectLauncherPage(
    browser,
    descriptor,
    60_000,
    descriptor.surfaceId,
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});
