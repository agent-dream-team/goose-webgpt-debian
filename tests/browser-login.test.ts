import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginStateExists,
  loginToChatGpt,
  loginVerificationMarkerPath,
  tryDetectChatGptProCapability,
} from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

test("login waits for the user to quit the browser, then verifies and captures from the profile", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"\nexit 0\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const loginError = await loginToChatGpt(config, { timeoutMs: 5_000 }).then(
      () => undefined,
      error => error,
    );
    // A clean exit (the manual completion signal) is followed by verification of the profile;
    // a fake browser cannot produce an authenticated page, so verification must fail — but only
    // after the quit signal was honored and never through an automation port or auto-kill timer.
    if (!existsSync(argsLog)) throw loginError;
    expect(loginError).toBeInstanceOf(Error);
    expect((loginError as Error).message).toMatch(/Failed to launch|Executable doesn.t exist|has been closed|cannot be launched/i);

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const loginLaunch = launches[0] ?? "";
    expect(loginLaunch).toContain("--new-window");
    expect(loginLaunch).toContain("--user-data-dir=");
    expect(loginLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(loginLaunch).not.toContain("--remote-debugging-port");
    expect(loginLaunch).not.toContain("--remote-debugging-address");
    expect(loginLaunch).not.toContain("--remote-debugging-pipe");

    const source = readFileSync(new URL("../src/browser-login.ts", import.meta.url), "utf8");
    const loginSource = source.slice(
      source.indexOf("export async function loginToChatGpt"),
      source.indexOf("export function browserLoginStateExists"),
    );
    // Manual completion contract: no same-process CDP attach during sign-in; capture happens
    // from the persisted profile after the user quits the window.
    expect(source).not.toContain("chromium.connectOverCDP(transport");
    expect(source).not.toContain('session.send("Browser.close")');
    expect(loginSource).toContain("launchPersistentContext(profileDir");
    expect(loginSource).toContain("loginBrowser.once(\"exit\"");
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

test("capability probing is optional and inconclusive detection does not become false", async () => {
  const locator = {
    locator: () => locator,
    last: () => locator,
    isVisible: async () => true,
    waitFor: async () => { throw new Error("timeout"); },
    getAttribute: async () => null,
    click: async () => {},
    first: () => locator,
    count: async () => 1,
  };
  const page = {
    locator: () => locator,
    keyboard: { press: async () => {} },
  } as never;

  expect(await tryDetectChatGptProCapability(page)).toBeUndefined();
});
