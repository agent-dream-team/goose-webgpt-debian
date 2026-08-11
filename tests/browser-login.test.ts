import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserLoginStateExists, loginToChatGpt, loginVerificationMarkerPath } from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

test("login uses one normal Chrome on a non-automation loopback port and never launches a verifier browser", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const loginError = await loginToChatGpt(config, { timeoutMs: 1_000 }).then(
      () => undefined,
      error => error,
    );
    if (!existsSync(argsLog)) throw loginError;
    expect(loginError).toBeInstanceOf(Error);
    expect((loginError as Error).message).toContain("closed before its private login session became inspectable");

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain("--remote-debugging-address=127.0.0.1");
    const portMatch = firstLaunch.match(/--remote-debugging-port=(\d+)/);
    expect(portMatch).not.toBeNull();
    expect(Number(portMatch?.[1])).toBeGreaterThan(0);
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches).toHaveLength(1);

    const source = readFileSync(new URL("../src/browser-login.ts", import.meta.url), "utf8");
    const loginSource = source.slice(
      source.indexOf("export async function loginToChatGpt"),
      source.indexOf("export function browserLoginStateExists"),
    );
    expect(source).toContain("chromium.connectOverCDP(transport");
    expect(source).toContain('session.send("Browser.close")');
    expect(source).not.toContain("launchPersistentContext(profileDir");
    expect(source).toContain("browser.newContext({ storageState })");
    expect(loginSource).not.toContain("chromium.launch(");
    expect(loginSource).not.toContain("AutomationControlled");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("stored login accepts legacy verification evidence and the new authenticated-capture marker only", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({
        version: 2,
        authenticated: true,
        source: "authenticated-system-browser",
        capturedAt: "2026-08-10T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 2, authenticated: true, capturedAt: "2026-08-10T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
