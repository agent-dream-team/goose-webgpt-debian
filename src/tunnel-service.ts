import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";
import { runCommand, runChecked } from "./process";
import type { TunnelRuntimeStatus } from "./tunnel";

const LABEL = "io.github.codex-chatgpt-web.tunnel";
const TUNNEL_HEALTH_TIMEOUT_MS = 3_000;
const TUNNEL_HEALTH_POLL_INTERVAL_MS = 1_000;

export interface TunnelServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  label: string;
  definitionPath?: string;
}

function tunnelSettings(config: AppConfig) {
  if (config.mode !== "full" || !config.tunnel) throw new Error("Tunnel service requires full mode");
  return config.tunnel;
}

export function tunnelHealthUrlFileFromProfile(profile: string): string | undefined {
  try {
    const parsed = JSON.parse(profile) as { health?: { url_file?: unknown } };
    if (typeof parsed.health?.url_file === "string" && parsed.health.url_file.trim()) {
      return parsed.health.url_file.trim();
    }
  } catch {
    // tunnel-client profiles are YAML; its managed-runtime writer currently emits JSON-shaped YAML.
  }
  const match = profile.match(/(?:^|\n)\s*["']?url_file["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s#,}\r\n]+))/);
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
}

function localHealthBaseUrl(value: string): URL {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" || url.username || url.password || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Tunnel health URL must be an unauthenticated loopback HTTP URL");
  }
  return url;
}

async function probe(url: URL, path: "/healthz" | "/readyz"): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TUNNEL_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, url), { signal: controller.signal });
    const detail = (await response.text()).trim().replace(/[\r\n]+/g, " ").slice(0, 500);
    return { ok: response.ok, status: response.status, ...(detail ? { detail } : {}) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export function tunnelServiceRuntimeStatusFromProbes(
  service: TunnelServiceStatus,
  health: { ok: boolean; status?: number; detail?: string },
  ready: { ok: boolean; status?: number; detail?: string },
): TunnelRuntimeStatus {
  const processRunning = service.running;
  const healthy = processRunning && health.ok;
  const isReady = healthy && ready.ok;
  const state = isReady ? "ready" : processRunning ? "running" : "stopped";
  const detail = isReady
    ? "launchd_running=true healthz=ok readyz=ok"
    : [
        `launchd_running=${processRunning}`,
        `healthz=${health.ok ? "ok" : health.status ?? "failed"}`,
        `readyz=${ready.ok ? "ok" : ready.status ?? "failed"}`,
        ...(health.detail && !health.ok ? [`health_detail=${health.detail}`] : []),
        ...(ready.detail && !ready.ok ? [`ready_detail=${ready.detail}`] : []),
      ].join("; ").slice(0, 2_000);
  return { ok: isReady, processRunning, healthy, ready: isReady, state, detail };
}

export async function getTunnelServiceRuntimeStatus(
  config: AppConfig,
  service = getTunnelServiceStatus(),
): Promise<TunnelRuntimeStatus> {
  const tunnel = tunnelSettings(config);
  if (!service.running) return tunnelServiceRuntimeStatusFromProbes(service, { ok: false }, { ok: false });

  const profilePath = join(tunnel.profileDir, `${tunnel.profileName}.yaml`);
  if (!existsSync(profilePath)) {
    return tunnelServiceRuntimeStatusFromProbes(service, { ok: false, detail: `Missing tunnel profile: ${profilePath}` }, { ok: false });
  }
  const urlFile = tunnelHealthUrlFileFromProfile(readFileSync(profilePath, "utf8"));
  if (!urlFile) {
    return tunnelServiceRuntimeStatusFromProbes(service, { ok: false, detail: "Tunnel profile has no health.url_file" }, { ok: false });
  }
  if (!existsSync(urlFile)) {
    return tunnelServiceRuntimeStatusFromProbes(service, { ok: false, detail: `Missing tunnel health URL file: ${urlFile}` }, { ok: false });
  }

  let baseUrl: URL;
  try {
    baseUrl = localHealthBaseUrl(readFileSync(urlFile, "utf8"));
  } catch (error) {
    return tunnelServiceRuntimeStatusFromProbes(
      service,
      { ok: false, detail: error instanceof Error ? error.message : String(error) },
      { ok: false },
    );
  }
  const health = await probe(baseUrl, "/healthz");
  const ready = health.ok ? await probe(baseUrl, "/readyz") : { ok: false };
  return tunnelServiceRuntimeStatusFromProbes(service, health, ready);
}

export async function waitForTunnelServiceReady(
  config: AppConfig,
  timeoutMs = 120_000,
): Promise<TunnelRuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await getTunnelServiceRuntimeStatus(config);
  while (!status.ok && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, TUNNEL_HEALTH_POLL_INTERVAL_MS));
    status = await getTunnelServiceRuntimeStatus(config);
  }
  return status;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function launchDomain(): string {
  return `gui/${userInfo().uid}`;
}

function serviceTarget(): string {
  return `${launchDomain()}/${LABEL}`;
}

function assertMacOs(): void {
  if (process.platform !== "darwin") {
    throw new Error("Managed tunnel service installation is currently supported on macOS only");
  }
}

export function tunnelServiceDefinition(config: AppConfig): string {
  const tunnel = tunnelSettings(config);
  const logDir = join(getConfigDir(), "logs");
  const args = [tunnel.binaryPath, "run", "--profile-dir", tunnel.profileDir, "--profile", tunnel.profileName];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_CHATGPT_WEB_HOME</key>
    <string>${xml(getConfigDir())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "tunnel.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "tunnel.stderr.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function getTunnelServiceStatus(): TunnelServiceStatus {
  if (process.platform !== "darwin") {
    return { supported: false, installed: false, loaded: false, running: false, label: LABEL };
  }
  const path = plistPath();
  const result = runCommand("launchctl", ["print", serviceTarget()]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    running: result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout),
    label: LABEL,
    definitionPath: path,
  };
}

export function tunnelServiceDefinitionMatches(config: AppConfig): boolean {
  const path = plistPath();
  return existsSync(path) && readFileSync(path, "utf8") === tunnelServiceDefinition(config);
}

export function installTunnelService(config: AppConfig): TunnelServiceStatus {
  assertMacOs();
  const tunnel = tunnelSettings(config);
  const profile = join(tunnel.profileDir, `${tunnel.profileName}.yaml`);
  if (!existsSync(tunnel.binaryPath)) throw new Error(`Tunnel client is missing: ${tunnel.binaryPath}`);
  if (!existsSync(profile)) throw new Error(`Tunnel profile is missing: ${profile}`);
  const current = getTunnelServiceStatus();
  const next = tunnelServiceDefinition(config);
  if (current.loaded && (!current.installed || readFileSync(plistPath(), "utf8") !== next)) {
    throw new Error("Refusing to replace a loaded tunnel service definition; stop it before installing the update");
  }
  mkdirSync(dirname(plistPath()), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  if (!current.installed || readFileSync(plistPath(), "utf8") !== next) atomicWriteFile(plistPath(), next);
  if (!current.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), plistPath()]);
  return getTunnelServiceStatus();
}

export function startTunnelService(): TunnelServiceStatus {
  assertMacOs();
  if (!existsSync(plistPath())) throw new Error("Tunnel service is not installed; rerun full setup");
  if (!getTunnelServiceStatus().loaded) runChecked("launchctl", ["bootstrap", launchDomain(), plistPath()]);
  return getTunnelServiceStatus();
}

async function waitForTunnelServiceUnloaded(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getTunnelServiceStatus().loaded && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (getTunnelServiceStatus().loaded) throw new Error(`launchd did not unload ${LABEL} after ${timeoutMs}ms`);
}

export async function stopTunnelService(): Promise<TunnelServiceStatus> {
  assertMacOs();
  if (getTunnelServiceStatus().loaded) {
    runChecked("launchctl", ["bootout", serviceTarget()]);
    await waitForTunnelServiceUnloaded();
  }
  return getTunnelServiceStatus();
}

export async function restartTunnelService(): Promise<TunnelServiceStatus> {
  await stopTunnelService();
  return startTunnelService();
}

export async function uninstallTunnelService(): Promise<TunnelServiceStatus> {
  assertMacOs();
  await stopTunnelService();
  rmSync(plistPath(), { force: true });
  return getTunnelServiceStatus();
}
