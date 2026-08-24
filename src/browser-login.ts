import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  chromium,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import {
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptProCapability,
  isAuthenticatedTemporaryChatPage,
} from "./chatgpt-session";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  proAvailable?: boolean;
}

interface LegacyLoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  proAvailable?: boolean;
}

interface LoginCaptureMarker {
  version: 2;
  authenticated: true;
  source: "authenticated-system-browser";
  capturedAt: string;
  proAvailable?: boolean;
}

type LoginVerificationMarker = LegacyLoginVerificationMarker | LoginCaptureMarker;

interface LoginBrowserExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

const LOGIN_POLL_INTERVAL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function loginBrowserExitError(exit: LoginBrowserExit, phase: string): Error {
  if (exit.error) return new Error(`System Chrome/Chromium ${phase}: ${exit.error.message}`);
  if (exit.signal) return new Error(`System Chrome/Chromium ${phase} after signal ${exit.signal}`);
  return new Error(`System Chrome/Chromium ${phase} with status ${exit.code ?? "unknown"}`);
}

async function waitForAuthenticatedTemporaryChat(
  context: BrowserContext,
  browserExit: Promise<LoginBrowserExit>,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      if (await isAuthenticatedTemporaryChatPage(page)) return page;
    }
    const exited = await Promise.race([
      browserExit,
      delay(Math.min(LOGIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))).then(() => undefined),
    ]);
    if (exited) throw loginBrowserExitError(exited, "closed before ChatGPT authentication was verified");
  }
  throw new Error("Timed out waiting for an authenticated ChatGPT Temporary Chat in system Chrome/Chromium");
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerificationMarker(storageStatePath: string, proAvailable?: boolean): void {
  const marker: LegacyLoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...(typeof proAvailable === "boolean" ? { proAvailable } : {}),
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

function writeLoginCaptureMarker(storageStatePath: string, proAvailable?: boolean): void {
  const marker: LoginCaptureMarker = {
    version: 2,
    authenticated: true,
    source: "authenticated-system-browser",
    capturedAt: new Date().toISOString(),
    ...(typeof proAvailable === "boolean" ? { proAvailable } : {}),
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

export async function tryDetectChatGptProCapability(page: Page): Promise<boolean | undefined> {
  try {
    return await detectChatGptProCapability(page);
  } catch {
    return undefined;
  }
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<{ proAvailable: boolean; url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (!await isAuthenticatedTemporaryChatPage(verifierPage)) {
        throw new Error("Stored ChatGPT login did not produce exactly one visible Temporary Chat composer");
      }
      return { proAvailable: await detectChatGptProCapability(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<{ proAvailable: boolean }> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
  return { proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(config: AppConfig): { proAvailable?: boolean } {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {};
  } catch {
    return {};
  }
}

export async function loginToChatGpt(
  config: Pick<AppConfig, "chromeExecutablePath" | "storageStatePath">,
  options: { timeoutMs?: number; storageStatePath?: string; profileDir?: string } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Chrome/Chromium was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  // The login profile intentionally survives a failed or abandoned attempt so the next sign-in
  // resumes the same browser session (established manual-login contract). It is removed only
  // after its state has been captured and verified.
  const profileDir = options.profileDir ?? join(dirname(config.storageStatePath), "login-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const storageStatePath = options.storageStatePath ?? config.storageStatePath;
  process.stdout.write(
    "A dedicated system Chrome/Chromium window is open. Sign in to ChatGPT, confirm that the Temporary Chat composer is visible,"
    + " then quit this Chromium instance completely; capture continues automatically.\n",
  );
  const loginBrowser = spawn(config.chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_TEMPORARY_CHAT_URL,
  ], {
    env: process.env,
    stdio: "ignore",
  });
  // Quitting the dedicated browser window is the manual completion signal. Automatic composer
  // polling was removed deliberately: it could close the login browser before the human had
  // finished (or while navigation wandered), destroying the session it was trying to capture.
  const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
    loginBrowser.once("error", rejectExit);
    loginBrowser.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`System Chrome/Chromium login window exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (loginExit !== 0) throw new Error(`System Chrome/Chromium login window exited with status ${loginExit}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  let result: BrowserLoginResult | undefined;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? 60_000,
    });
    const verifiedPage = await waitForAuthenticatedTemporaryChat(context, new Promise<LoginBrowserExit>(() => {}), options.timeoutMs ?? 60_000);
    const state = await context.storageState();
    const accountSurfaceUrl = verifiedPage.url();
    const proAvailable = await tryDetectChatGptProCapability(verifiedPage);

    atomicWriteFile(storageStatePath, `${JSON.stringify(state)}\n`);
    writeLoginCaptureMarker(storageStatePath, proAvailable);
    result = {
      storageStatePath,
      accountSurfaceUrl,
      ...(typeof proAvailable === "boolean" ? { proAvailable } : {}),
    };
  } finally {
    await context.close().catch(() => {});
    if (result) rmSync(profileDir, { recursive: true, force: true });
  }
  if (!result) throw new Error("System-browser login completed without authenticated capture evidence");
  return result;
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    if (marker.authenticated !== true) return false;
    if (marker.version === 1) return typeof marker.verifiedAt === "string";
    return marker.version === 2
      && marker.source === "authenticated-system-browser"
      && typeof marker.capturedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Chrome/Chromium was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
