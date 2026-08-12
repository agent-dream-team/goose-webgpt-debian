import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the production browser helper heartbeats for the full active run", () => {
  const source = readFileSync(join(import.meta.dir, "../src/adapters/chatgpt-web/browser-helper-main.ts"), "utf8");
  const firstHeartbeat = source.indexOf("emitHeartbeat();");
  const browserRun = source.indexOf("ChatGptBrowserWorker.forProvider(provider).run(turn)");
  expect(source).toContain("const HELPER_HEARTBEAT_INTERVAL_MS = 10_000;");
  expect(source).toContain("const heartbeatTimer = setInterval(emitHeartbeat, HELPER_HEARTBEAT_INTERVAL_MS);");
  expect(source).toContain("clearInterval(heartbeatTimer);");
  expect(firstHeartbeat).toBeGreaterThan(-1);
  expect(firstHeartbeat).toBeLessThan(browserRun);
});

test("Bun daemon streams a prepared browser turn through the persistent Node helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-client-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      send({ type: "event", id: message.id, event: "reasoning", text: "Reading project" });
      send({ type: "event", id: message.id, event: "reasoning", text: " files", continuation: true });
      send({ type: "event", id: message.id, event: "text", text: "done" });
      send({ type: "result", id: message.id, text: "done" });
    });
  `, { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  };
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const deltas: string[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      traceId: "abcdef123456",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, proAvailable: false },
      prepare: async () => ({ text: "inspect", images: [], release: () => { released = true; } }),
      onReasoningSummary: (text, continuation) => reasoning.push({ text, continuation: continuation === true }),
      onTextDelta: text => deltas.push(text),
    });
    expect(result).toBe("done");
    expect(reasoning).toEqual([
      { text: "Reading project", continuation: false },
      { text: " files", continuation: true },
    ]);
    expect(deltas).toEqual(["done"]);
    expect(released).toBe(true);
  } finally {
    await client.close();
  }
});

test("an abort dispatched during run submission cannot overtake the run frame", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    ensureChild(): Promise<void>;
    send(message: { type: string; id?: string }): Promise<void>;
    finishWithError(id: string, error: Error): void;
  };
  internal.ensureChild = async () => {};
  internal.send = async message => {
    messages.push(message.type);
    if (message.type === "run") controller.abort();
    if (message.type === "abort" && message.id) {
      queueMicrotask(() => internal.finishWithError(
        message.id!,
        new DOMException("ChatGPT web turn aborted", "AbortError"),
      ));
    }
  };

  await expect(client.run({
    traceId: "abort-order-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, proAvailable: false },
    abortSignal: controller.signal,
    prepare: async () => ({
      text: "inspect",
      images: [],
      release: () => { released = true; },
    }),
    onTextDelta: () => {},
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(messages).toEqual(["run", "abort"]);
  expect(released).toBe(true);
});

test("invalid helper protocol is cleaned up and the next turn respawns a fresh helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "goose-launcher-helper-protocol-respawn-"));
  roots.push(root);
  const attempts = join(root, "attempts.txt");
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const fs = require("node:fs");
    const readline = require("node:readline").createInterface({ input: process.stdin });
    let attempt = 1;
    try { attempt = Number(fs.readFileSync(${JSON.stringify("ATTEMPTS_PLACEHOLDER")}, "utf8")) + 1; } catch {}
    fs.writeFileSync(${JSON.stringify("ATTEMPTS_PLACEHOLDER")}, String(attempt));
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      if (attempt === 1) {
        process.stdout.write("not-json\\n");
        return;
      }
      send({ type: "result", id: message.id, text: "respawned" });
    });
  `.replaceAll("ATTEMPTS_PLACEHOLDER", attempts), { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: { endpoint: "http://127.0.0.1:9", token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Goose Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const turn = (traceId: string): BrowserTurn => ({
    traceId,
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, proAvailable: false },
    prepare: async () => ({ text: "inspect", images: [], release() {} }),
    onTextDelta() {},
  });
  try {
    await expect(client.run(turn("protocol-failure-1"))).rejects.toThrow("invalid protocol data");
    await expect(client.run(turn("protocol-respawn-2"))).resolves.toBe("respawned");
  } finally {
    await client.close();
  }
});

test("helper process exit is cleaned up and a later turn respawns successfully", async () => {
  const root = mkdtempSync(join(tmpdir(), "goose-launcher-helper-exit-respawn-"));
  roots.push(root);
  const attempts = join(root, "attempts.txt");
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const fs = require("node:fs");
    const readline = require("node:readline").createInterface({ input: process.stdin });
    let attempt = 1;
    try { attempt = Number(fs.readFileSync(${JSON.stringify("ATTEMPTS_PLACEHOLDER")}, "utf8")) + 1; } catch {}
    fs.writeFileSync(${JSON.stringify("ATTEMPTS_PLACEHOLDER")}, String(attempt));
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      if (attempt === 1) process.exit(17);
      send({ type: "result", id: message.id, text: "respawned-after-exit" });
    });
  `.replaceAll("ATTEMPTS_PLACEHOLDER", attempts), { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: { endpoint: "http://127.0.0.1:9", token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Goose Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const turn = (traceId: string): BrowserTurn => ({
    traceId,
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, proAvailable: false },
    prepare: async () => ({ text: "inspect", images: [], release() {} }),
    onTextDelta() {},
  });
  try {
    await expect(client.run(turn("process-failure-1"))).rejects.toThrow("exited with status 17");
    await expect(client.run(turn("process-respawn-2"))).resolves.toBe("respawned-after-exit");
  } finally {
    await client.close();
  }
});

test("a live-but-silent helper is terminated and the next turn respawns a fresh helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "goose-launcher-helper-heartbeat-respawn-"));
  roots.push(root);
  const attempts = join(root, "attempts.txt");
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const fs = require("node:fs");
    const readline = require("node:readline").createInterface({ input: process.stdin });
    let attempt = 1;
    try { attempt = Number(fs.readFileSync(${JSON.stringify("ATTEMPTS_PLACEHOLDER")}, "utf8")) + 1; } catch {}
    fs.writeFileSync(${JSON.stringify("ATTEMPTS_PLACEHOLDER")}, String(attempt));
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      if (attempt === 1) return;
      setTimeout(() => send({ type: "event", id: message.id, event: "heartbeat" }), 80);
      setTimeout(() => send({ type: "result", id: message.id, text: "respawned-after-heartbeat-expiry" }), 240);
    });
  `.replaceAll("ATTEMPTS_PLACEHOLDER", attempts), { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: { endpoint: "http://127.0.0.1:9", token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Goose Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  }, { heartbeatTimeoutMs: 200 });
  const turn = (traceId: string): BrowserTurn => ({
    traceId,
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, proAvailable: false },
    prepare: async () => ({ text: "inspect", images: [], release() {} }),
    onTextDelta() {},
  });
  try {
    await expect(client.run(turn("heartbeat-expiry-1"))).rejects.toThrow("heartbeat expired after 200ms");
    await expect(client.run(turn("heartbeat-respawn-2"))).resolves.toBe("respawned-after-heartbeat-expiry");
  } finally {
    await client.close();
  }
});

test("helper heartbeat expiry releases the launcher turn before respawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "goose-launcher-helper-heartbeat-release-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
    });
  `, { mode: 0o700 });
  const controlRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      controlRequests.push({
        path: new URL(request.url).pathname,
        body: await request.json() as Record<string, unknown>,
      });
      return Response.json({ ok: true });
    },
  });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: `http://127.0.0.1:${control.port}`,
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Goose Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  }, { heartbeatTimeoutMs: 100 });
  try {
    await expect(client.run({
      traceId: "heartbeat-release-1",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, proAvailable: false },
      prepare: async () => ({ text: "inspect", images: [], release() {} }),
      onTextDelta() {},
    })).rejects.toThrow("heartbeat expired after 100ms");
    for (let attempt = 0; attempt < 50 && controlRequests.length === 0; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(controlRequests).toHaveLength(1);
    expect(controlRequests[0]).toMatchObject({
      path: "/v1/turn/end",
      body: {
        phase: "end",
        traceId: "heartbeat-release-1",
        status: "failed",
      },
    });
    expect(controlRequests[0]!.body.helperPid).toEqual(expect.any(Number));
  } finally {
    await client.close();
    control.stop(true);
  }
});

test("structured helper errors preserve the ChatGPT adapter failure contract", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, {
      turn: BrowserTurn;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  const result = new Promise<string>((resolveResult, rejectResult) => {
    internal.pending.set("rate-limit-123", {
      turn: {
        traceId: "rate-limit-123",
        modelId: "chatgpt-web/medium",
        capabilities: { localToolsEnabled: false, proAvailable: false },
        prepare: async () => ({ text: "inspect", images: [], release() {} }),
        onTextDelta() {},
      },
      resolve: resolveResult,
      reject: rejectResult,
    });
  });

  internal.handleLine(child, JSON.stringify({
    type: "error",
    id: "rate-limit-123",
    name: "ChatGptWebAdapterError",
    message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  }));

  const error = await result.then(() => undefined, failure => failure);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
});
