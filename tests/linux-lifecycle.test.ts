import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childServicePidPath,
  liveChildServicePid,
  readChildServicePid,
  startChildService,
  stopChildService,
} from "../src/child-process-service";
import { processRunning } from "../src/process";

const BUN = process.execPath;
const REPO_ROOT = import.meta.dir.replace(/\/tests$/, "");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli.ts");

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-web-linux-lifecycle-"));
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  return home;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function sleeperCommand(tag: string): { command: string; args: string[] } {
  // A group of processes so stopChildService's group kill is actually exercised:
  // the shell stays as leader while the tagged sleeper runs beside it. `exec -a`
  // rewrites argv[0] so pgrep -f can prove the sibling's lifecycle.
  return { command: "/bin/bash", args: ["-c", `exec -a "${tag}" sleep 300 & wait`] };
}

describe("linux direct child-process service primitives", () => {
  test("start records a live pidfile; stop kills the whole group and removes the pidfile without orphans", async () => {
    const home = makeTempHome();
    const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    const tag = `cw-lifecycle-${Date.now()}`;
    try {
      const { command, args } = sleeperCommand(tag);
      const pid = startChildService({
        name: "daemon",
        command,
        args,
        env: { ...process.env },
        configDir: home,
      });
      expect(processRunning(pid)).toBe(true);
      expect(liveChildServicePid("daemon", home)).toBe(pid);

      // Prove the fixture actually produced a tagged group member before asserting
      // that stop reaps it (guards against a vacuous orphan check).
      const before = spawnSync("pgrep", ["-f", tag], { encoding: "utf8" });
      expect(before.status === 0 ? before.stdout.trim() : "").not.toBe("");

      await stopChildService("daemon", { configDir: home, timeoutMs: 5_000 });

      expect(liveChildServicePid("daemon", home)).toBeUndefined();
      expect(readChildServicePid(childServicePidPath("daemon", home))).toBeUndefined();
      // The tagged sibling in the same process group must be reaped too (no orphans).
      const pgrep = spawnSync("pgrep", ["-f", tag], { encoding: "utf8" });
      expect(pgrep.status === 0 ? pgrep.stdout : "").toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
    }
  });

  test("stale pidfiles are dropped instead of reporting a dead service as loaded", () => {
    const home = makeTempHome();
    try {
      writeFileSync(childServicePidPath("daemon", home), "999999999\n");
      expect(liveChildServicePid("daemon", home)).toBeUndefined();
      expect(Bun.file(childServicePidPath("daemon", home)).exists()).resolves.toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("concurrent starts serialize: the second fails deterministically instead of orphaning the first", async () => {
    const { acquireChildServiceStartLock } =
      require("../src/child-process-service") as typeof import("../src/child-process-service");
    const home = makeTempHome();
    const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    const tag = `cw-lifecycle-lock-${Date.now()}`;
    try {
      // Simulate an in-flight start holding the lock; a competing start must fail fast
      // rather than spawn a second daemon that would overwrite the first's pidfile.
      const release = acquireChildServiceStartLock("daemon", home);
      try {
        expect(() =>
          startChildService({ name: "daemon", ...sleeperCommand(tag), env: { ...process.env }, configDir: home }),
        ).toThrow(/daemon service start is already in progress/);
        expect(readChildServicePid(childServicePidPath("daemon", home))).toBeUndefined();
      } finally {
        release();
      }

      // After the lock is released the same start succeeds.
      const pid = startChildService({ name: "daemon", ...sleeperCommand(tag), env: { ...process.env }, configDir: home });
      expect(liveChildServicePid("daemon", home)).toBe(pid);
      await stopChildService("daemon", { configDir: home, timeoutMs: 5_000 });
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
    }
  });
});

describe("linux daemon readiness evidence", () => {
  // Imported lazily so the module under test reads CODEX_CHATGPT_WEB_HOME per call.
  const { waitForDaemonHttpReady } = require("../src/service") as typeof import("../src/service");

  test("reports ready once /healthz answers OK from a real child process", async () => {
    const home = makeTempHome();
    const port = await freePort();
    const serverScript = `
      const http = require("node:http");
      http.createServer((req, res) => { res.end(req.url === "/healthz" ? "ok" : "?"); })
        .listen(${port}, "127.0.0.1");
    `;
    const pid = startChildService({ name: "daemon", command: BUN, args: ["-e", serverScript], env: { ...process.env }, configDir: home });
    try {
      await waitForDaemonHttpReady({ host: "127.0.0.1", port }, pid, { timeoutMs: 10_000, pollMs: 50 });
    } finally {
      await stopChildService("daemon", { configDir: home, timeoutMs: 5_000 });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an exiting daemon fails deterministically with its stderr log tail preserved", async () => {
    const home = makeTempHome();
    const port = await freePort();
    const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    const pid = startChildService({
      name: "daemon",
      command: BUN,
      args: ["-e", "console.error('boom-startup-failure'); process.exit(3);"],
      env: { ...process.env },
      configDir: home,
    });
    try {
      let failure: unknown;
      try {
        await waitForDaemonHttpReady({ host: "127.0.0.1", port }, pid, { timeoutMs: 5_000, pollMs: 50 });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("daemon process exited during startup");
      expect((failure as Error).message).toContain("boom-startup-failure");
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
    }
  });

  test("a healthy but never-listening daemon times out with a bounded readiness error", async () => {
    const home = makeTempHome();
    const port = await freePort();
    const pid = startChildService({ name: "daemon", command: BUN, args: ["-e", "setInterval(()=>{},1<<30)"], env: { ...process.env }, configDir: home });
    try {
      await expect(
        waitForDaemonHttpReady({ host: "127.0.0.1", port }, pid, { timeoutMs: 500, pollMs: 50 }),
      ).rejects.toThrow(/daemon \/healthz was not ready within 500ms/);
    } finally {
      await stopChildService("daemon", { configDir: home, timeoutMs: 5_000 });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("linux service lifecycle branches (real daemon)", () => {
  const { DAEMON_CHILD_SERVICE_NAME, getServiceStatus, startService, stopService } =
    require("../src/service") as typeof import("../src/service");
  const { startTunnelService } = require("../src/tunnel-service") as typeof import("../src/tunnel-service");

  function writeTestConfig(home: string, port: number, overrides: Record<string, unknown> = {}): void {
    const config = {
      version: 3,
      releaseVersion: "2.0.0-test",
      mode: "browser-only",
      standalone: false,
      host: "127.0.0.1",
      port,
      contextWindow: 272_000,
      appName: "debian-groundwork-test",
      browserHost: "managed-chrome",
      chromeExecutablePath: "/usr/bin/chromium",
      storageStatePath: join(home, "state", "storage.json"),
      brokerSocketPath: join(home, "runtime", "turn-broker.sock"),
      headed: false,
      autoApproveToolCalls: true,
      controlToken: "t".repeat(48),
      runtimeCommand: [BUN, CLI_ENTRY],
      ...overrides,
    };
    writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
  }

  test("startService boots the real daemon to /healthz-ready, drains+stops cleanly, and leaves no owned process", async () => {
    const home = makeTempHome();
    const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    const port = await freePort();
    writeTestConfig(home, port);
    try {
      expect(getServiceStatus().loaded).toBe(false);

      const started = await startService();
      expect(started.loaded).toBe(true);
      expect(started.supported).toBe(true);

      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.ok).toBe(true);

      const stopped = await stopService(JSON.parse(await Bun.file(join(home, "config.json")).text()));
      expect(stopped.loaded).toBe(false);

      const pid = readChildServicePid(childServicePidPath(DAEMON_CHILD_SERVICE_NAME, home));
      expect(pid).toBeUndefined();

      // Stopping an already-stopped service stays graceful.
      const stoppedAgain = await stopService(JSON.parse(await Bun.file(join(home, "config.json")).text()));
      expect(stoppedAgain.loaded).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
    }
  }, 60_000);

  test("a daemon that dies during startup propagates the causal failure and cleans its ownership state", async () => {
    const home = makeTempHome();
    const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    const port = await freePort();
    writeTestConfig(home, port, { runtimeCommand: ["/bin/false"] });
    try {
      await expect(startService()).rejects.toThrow(/daemon cleanup|exited during startup/);
      expect(getServiceStatus().loaded).toBe(false);
      expect(readChildServicePid(childServicePidPath(DAEMON_CHILD_SERVICE_NAME, home))).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
    }
  }, 30_000);

  test("tunnel startup fails closed with deterministic errors before any process is owned", async () => {
    const home = makeTempHome();
    const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    const port = await freePort();
    writeTestConfig(home, port, {
      mode: "full",
      tunnel: {
        binaryPath: "/nonexistent/tunnel-client",
        tunnelId: `tunnel_${"0".repeat(32)}`,
        runtimeKeyFile: join(home, "runtime.key"),
        profileDir: join(home, "tunnel-profiles"),
        profileName: "groundwork",
        alias: "groundwork",
      },
    });
    try {
      await expect(startTunnelService()).rejects.toThrow("Tunnel client is missing");
      expect(readChildServicePid(childServicePidPath("tunnel", home))).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
    }
  }, 30_000);
});

describe("darwin launchd contracts remain untouched", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");

  test("macOS service/tunnel functions keep their launchctl implementations behind darwin gates", () => {
    const serviceSource = readFileSync(join(REPO_ROOT, "src", "service.ts"), "utf8");
    const tunnelSource = readFileSync(join(REPO_ROOT, "src", "tunnel-service.ts"), "utf8");
    for (const source of [serviceSource, tunnelSource]) {
      expect(source).toContain('"launchctl"');
      expect(source).toContain('if (process.platform !== "darwin")');
    }
    // The Linux branches are gated additions, not replacements.
    expect(serviceSource).toContain('if (process.platform === "linux")');
    expect(tunnelSource).toContain('if (process.platform === "linux")');
  });
});
