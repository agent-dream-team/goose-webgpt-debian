import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { TUNNEL_READY_TIMEOUT_MS, createTunnelConfig, mcpCommand, parseTunnelStatus } from "../src/tunnel";
import { getTunnelServiceRuntimeStatus, tunnelHealthUrlFileFromProfile, tunnelServiceDefinition, tunnelServiceRuntimeStatusFromProbes } from "../src/tunnel-service";
import { existingFullSetupCredentials, tunnelWorkerRuntimeChanged } from "../src/setup";

const roots: string[] = [];

// Mirrors the pinned tunnel-client's config parser: backslash escapes the next rune and quotes
// group an argument. This catches Windows command strings that look right but reconstruct the
// wrong executable, script path, or named pipe in the actual tunnel worker.
function parsePinnedTunnelCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let started = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
    } else if (character === "\\") {
      escaped = true;
      started = true;
    } else if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(character) && !quoted) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (escaped || quoted) throw new Error("invalid tunnel command");
  if (started) args.push(current);
  return args;
}

afterEach(() => {
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("tunnel launchd ownership", () => {
  test("runs the pinned client directly and asks launchd to restore it", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-tunnel-service-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const binary = join(root, "bin", "tunnel-client");
    const key = join(root, "secrets", "runtime.key");
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(binary, "binary");
    writeFileSync(key, "secret");
    const config = defaultConfig("full");
    config.tunnel = createTunnelConfig({
      binaryPath: binary,
      runtimeKeyFile: key,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });

    const definition = tunnelServiceDefinition(config);
    expect(definition).toContain("<string>run</string>");
    expect(definition).toContain(`<string>${config.tunnel.profileDir}</string>`);
    expect(definition).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(definition).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(definition).not.toContain("tmux");
    expect(definition).not.toContain("/bin/sh");
    expect(definition).not.toContain(config.tunnel.tunnelId);
    expect(definition).not.toContain(key);
  });

  test("restarts the long-lived MCP worker when the installed release changes", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-tunnel-runtime-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const runtime = join(root, "bin", "codex-chatgpt-web");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(runtime, "runtime");
    const before = defaultConfig("browser-only");
    before.mode = "full";
    before.releaseVersion = "0.1.3";
    before.runtimeCommand = [runtime];
    const after = structuredClone(before);
    after.releaseVersion = "0.1.9";

    expect(tunnelWorkerRuntimeChanged(before, after)).toBe(true);
    after.releaseVersion = before.releaseVersion;
    expect(tunnelWorkerRuntimeChanged(before, after)).toBe(false);
  });

  test("reuses complete full-mode tunnel credentials during setup updates", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-existing-tunnel-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const key = join(root, "secrets", "runtime.key");
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(key, "secret");
    const config = defaultConfig("full");
    config.tunnel = createTunnelConfig({
      binaryPath: process.execPath,
      runtimeKeyFile: key,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });

    expect(existingFullSetupCredentials(config)).toEqual({ tunnelId: true, runtimeKey: true });
    rmSync(key);
    expect(existingFullSetupCredentials(config)).toEqual({ tunnelId: true, runtimeKey: false });
    expect(existingFullSetupCredentials(defaultConfig("browser-only"))).toEqual({ tunnelId: false, runtimeKey: false });
  });

  test("passes the Windows MCP runtime directly to tunnel-client without cmd.exe", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-windows-mcp-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const runtime = join(root, "Program Files", "runtime", "bun.exe");
    mkdirSync(join(root, "Program Files", "runtime"), { recursive: true });
    writeFileSync(runtime, "runtime");
    const config = defaultConfig("browser-only");
    config.runtimeCommand = [runtime, join(root, "Program Files", "app", "cli.js")];
    config.brokerSocketPath = "\\\\.\\pipe\\codex-chatgpt-web-test";

    const command = mcpCommand(config, "win32");
    expect(command).toBe(
      `"${runtime.replaceAll("\\", "\\\\")}" `
      + `"${join(root, "Program Files", "app", "cli.js").replaceAll("\\", "\\\\")}" `
      + '"mcp" "--broker-socket" "\\\\\\\\.\\\\pipe\\\\codex-chatgpt-web-test"',
    );
    expect(command).not.toContain("cmd.exe");
    expect(existsSync(join(root, "bin", "mcp-launcher.cmd"))).toBe(false);
    expect(parsePinnedTunnelCommand(command)).toEqual([
      runtime,
      join(root, "Program Files", "app", "cli.js"),
      "mcp",
      "--broker-socket",
      "\\\\.\\pipe\\codex-chatgpt-web-test",
    ]);
  });

  test("uses a realistic bounded tunnel cold-start budget", () => {
    expect(TUNNEL_READY_TIMEOUT_MS).toBe(120_000);
  });

  test("uses live service health instead of stale managed-runtime bookkeeping", () => {
    const stale = parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: true,
      ready: true,
      runtime_state: "stopped",
    }));
    const live = tunnelServiceRuntimeStatusFromProbes(
      { supported: true, installed: true, loaded: true, running: true, label: "test" },
      { ok: true, status: 200, detail: "live" },
      { ok: true, status: 200, detail: "ready" },
    );

    expect(stale).toMatchObject({ ok: false, state: "stopped" });
    expect(live).toEqual({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "launchd_running=true healthz=ok readyz=ok",
    });
  });

  test("live service health fails closed for readiness and process failures", () => {
    expect(tunnelServiceRuntimeStatusFromProbes(
      { supported: true, installed: true, loaded: true, running: true, label: "test" },
      { ok: true, status: 200 },
      { ok: false, status: 503, detail: "mcp probe failed" },
    )).toMatchObject({ ok: false, processRunning: true, healthy: true, ready: false, state: "running" });

    expect(tunnelServiceRuntimeStatusFromProbes(
      { supported: true, installed: true, loaded: true, running: false, label: "test" },
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    )).toMatchObject({ ok: false, processRunning: false, healthy: false, ready: false, state: "stopped" });
  });

  test("reads the native tunnel-client health URL from generated profiles", () => {
    expect(tunnelHealthUrlFileFromProfile(JSON.stringify({ health: { url_file: "/tmp/runtime.url" } }))).toBe("/tmp/runtime.url");
    expect(tunnelHealthUrlFileFromProfile("health:\n  listen_addr: 127.0.0.1:0\n  url_file: /tmp/runtime.url\n")).toBe("/tmp/runtime.url");
  });

  test("probes the launchd-owned run process through its native health URL file", async () => {
    const root = join(tmpdir(), `codex-chatgpt-web-tunnel-health-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const profileDir = join(root, "tunnel", "profiles");
    const urlFile = join(root, "runtime", "health.url");
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(join(root, "runtime"), { recursive: true });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        return new Response(path === "/healthz" ? "live" : path === "/readyz" ? "ready" : "missing", {
          status: path === "/healthz" || path === "/readyz" ? 200 : 404,
        });
      },
    });
    try {
      writeFileSync(urlFile, `http://127.0.0.1:${server.port}\n`);
      writeFileSync(join(profileDir, "codex-chatgpt-web.yaml"), JSON.stringify({ health: { url_file: urlFile } }));
      const config = defaultConfig("full");
      config.tunnel = createTunnelConfig({
        binaryPath: join(root, "bin", "tunnel-client"),
        runtimeKeyFile: join(root, "secrets", "runtime.key"),
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      });
      const status = await getTunnelServiceRuntimeStatus(config, {
        supported: true,
        installed: true,
        loaded: true,
        running: true,
        label: "test",
      });
      expect(status).toMatchObject({ ok: true, processRunning: true, healthy: true, ready: true, state: "ready" });
    } finally {
      server.stop(true);
    }
  });
});
