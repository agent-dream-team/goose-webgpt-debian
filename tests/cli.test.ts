import { expect, test } from "bun:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../src/cli.ts"),
    ...args,
  ], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("setup validates the port before performing runtime work", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-"));
  try {
    const result = await runCli([
      "setup",
      "--browser-only",
      "--port",
      "0",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    const { stderr } = result;
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("--port must be an integer from 1 to 65535");
    expect(stderr).not.toContain("Unknown arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal uninstall refuses to race a launcher-owned runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-uninstall-"));
  const appHome = join(root, "app");
  const configPath = join(appHome, "config.json");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: join(appHome, "runtime", "launcher-browser.json"),
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "launcher-uninstall-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be removed from Codex Web GPT Settings");
    expect(existsSync(configPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorized launcher uninstall does not re-probe an already stopped full runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-launcher-uninstall-"));
  const appHome = join(root, "app");
  const codexHome = join(root, "codex");
  const descriptorPath = join(appHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  const runtimeKeyFile = join(appHome, "secrets", "runtime.key");
  const token = "launcher-uninstall-control-token-0123456789abcdef";
  mkdirSync(join(appHome, "runtime"), { recursive: true });
  mkdirSync(join(appHome, "secrets"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(helperScript, "module.exports = {};\n");
  writeFileSync(runtimeKeyFile, "test-key\n");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: "codex-web-gpt-launcher",
    pid: process.pid,
    endpoint: "http://127.0.0.1:48111",
    control: { endpoint: "http://127.0.0.1:48112", token },
    helper: { executable: process.execPath, script: helperScript },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "a".repeat(32),
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "full",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "runtime-control-token-0123456789abcdef0123456789",
    runtimeCommand: [process.execPath],
    tunnel: {
      binaryPath: join(root, "missing-tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile,
      profileDir: join(appHome, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
      "--launcher-control",
    ], {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CHATGPT_WEB_HOME: appHome,
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: descriptorPath,
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: token,
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Uninstalled and removed private application data");
    expect(existsSync(appHome)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launcher-owned login operates on a genuinely fresh profile without config.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-fresh-login-"));
  try {
    // A fake browser that exits immediately keeps the test at the exact boundary we care
    // about: the command must get past configuration and reach the system-browser stage.
    const fakeChrome = join(root, "fake-chrome.sh");
    writeFileSync(fakeChrome, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeChrome, 0o755);
    const storageStatePath = join(root, "transfer", "storage-state.json");

    const result = await runCli([
      "login",
      "--launcher-owned",
      "--chrome",
      fakeChrome,
      "--storage-state",
      storageStatePath,
    ], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: join(root, "app-home"),
    });
    expect(result.stderr).not.toContain("Configuration is missing");
    expect(result.exitCode).toBe(1);
    // The fake browser quits cleanly (the manual completion signal), then verification of the
    // persisted profile fails because the fake binary cannot open a real authenticated page.
    expect(result.stderr).toMatch(/Failed to launch|Executable doesn.t exist|has been closed|cannot be launched|exited with status/i);

    // Launcher ownership still requires the explicit inputs it promises to pass.
    for (const args of [
      ["login", "--launcher-owned"],
      ["login", "--launcher-owned", "--chrome", fakeChrome],
    ]) {
      const incomplete = await runCli(args, {
        ...process.env,
        CODEX_CHATGPT_WEB_HOME: join(root, "app-home"),
      });
      expect(incomplete.exitCode).toBe(1);
      expect(incomplete.stderr).toContain("--launcher-owned login requires an explicit --");
    }

    // Ordinary logins keep requiring full configuration on a fresh profile.
    const ordinary = await runCli(["login"], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: join(root, "app-home"),
    });
    expect(ordinary.exitCode).toBe(1);
    expect(ordinary.stderr).toContain("Configuration is missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
