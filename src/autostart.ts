import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { assertDurableRuntimeCommand, atomicWriteFile, getConfigDir } from "./config";
import { runCommand, runChecked } from "./process";
import {
  SERVICE_LABEL,
  managedServiceDefinitionPath,
  serviceDefinition,
} from "./service";
import {
  TUNNEL_SERVICE_LABEL,
  managedTunnelDefinitionPath,
  tunnelServiceDefinition,
} from "./tunnel-service";

export const AUTOSTART_LABEL = "io.github.codex-chatgpt-web.autostart";

export interface AutostartStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  label: string;
  definitionPath?: string;
}

export interface AutostartFileLayout {
  launchAgentsDir: string;
  managedLaunchdDir: string;
  logDir: string;
  workingDirectory: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchDomain(): string {
  return `gui/${userInfo().uid}`;
}

function autostartTarget(): string {
  return `${launchDomain()}/${AUTOSTART_LABEL}`;
}

function assertMacOs(): void {
  if (process.platform !== "darwin") throw new Error("Ordered login autostart is supported on macOS only");
}

function assertGooseLauncherOwnership(config: AppConfig): void {
  if (config.browserHost !== "launcher" || config.standalone !== true) {
    throw new Error("Ordered login autostart requires standalone Goose ownership with the launcher BrowserHost");
  }
}

export function defaultAutostartFileLayout(
  configDir = getConfigDir(),
  home = homedir(),
  workingDirectory = process.cwd(),
): AutostartFileLayout {
  return {
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    managedLaunchdDir: join(configDir, "launchd"),
    logDir: join(configDir, "logs"),
    workingDirectory: resolve(workingDirectory),
  };
}

export function autostartCoordinatorPath(layout = defaultAutostartFileLayout()): string {
  return join(layout.launchAgentsDir, `${AUTOSTART_LABEL}.plist`);
}

export function autostartDefinition(config: AppConfig, layout = defaultAutostartFileLayout()): string {
  assertDurableRuntimeCommand(config.runtimeCommand);
  const runtimeHome = getConfigDir();
  const args = [...config.runtimeCommand, "--home", runtimeHome, "lifecycle", "start"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_CHATGPT_WEB_HOME</key>
    <string>${xml(runtimeHome)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(layout.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(layout.logDir, "autostart.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(layout.logDir, "autostart.stderr.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function sourceDefinition(legacyPath: string, managedPath: string, fallback: string): string {
  if (existsSync(legacyPath)) return readFileSync(legacyPath, "utf8");
  if (existsSync(managedPath)) return readFileSync(managedPath, "utf8");
  return fallback;
}

export function configureAutostartFiles(
  config: AppConfig,
  layout = defaultAutostartFileLayout(),
): { coordinatorPath: string; servicePath: string; tunnelPath?: string } {
  assertGooseLauncherOwnership(config);
  const serviceLegacy = join(layout.launchAgentsDir, `${SERVICE_LABEL}.plist`);
  const tunnelLegacy = join(layout.launchAgentsDir, `${TUNNEL_SERVICE_LABEL}.plist`);
  const serviceManaged = join(layout.managedLaunchdDir, `${SERVICE_LABEL}.plist`);
  const tunnelManaged = join(layout.managedLaunchdDir, `${TUNNEL_SERVICE_LABEL}.plist`);
  const coordinatorPath = autostartCoordinatorPath(layout);

  mkdirSync(layout.launchAgentsDir, { recursive: true, mode: 0o700 });
  mkdirSync(layout.managedLaunchdDir, { recursive: true, mode: 0o700 });
  mkdirSync(layout.logDir, { recursive: true, mode: 0o700 });

  atomicWriteFile(serviceManaged, sourceDefinition(serviceLegacy, serviceManaged, serviceDefinition(config)));
  if (config.mode === "full") {
    atomicWriteFile(tunnelManaged, sourceDefinition(tunnelLegacy, tunnelManaged, tunnelServiceDefinition(config)));
  }

  // Removing these two auto-discovered definitions is the ownership handoff. Their RunAtLoad and
  // KeepAlive contracts stay intact in the managed copies, but launchd sees them only after the
  // canonical lifecycle explicitly bootstraps them in dependency order.
  rmSync(serviceLegacy, { force: true });
  if (config.mode === "full") rmSync(tunnelLegacy, { force: true });

  // Write the sole login-visible authority last. If an earlier file operation fails, the machine
  // fails closed with no new coordinator rather than leaving two competing login startup paths.
  atomicWriteFile(coordinatorPath, autostartDefinition(config, layout));
  return {
    coordinatorPath,
    servicePath: serviceManaged,
    ...(config.mode === "full" ? { tunnelPath: tunnelManaged } : {}),
  };
}

export function disableAutostartFiles(layout = defaultAutostartFileLayout()): void {
  rmSync(autostartCoordinatorPath(layout), { force: true });
}

export function getAutostartStatus(): AutostartStatus {
  if (process.platform !== "darwin") {
    return { supported: false, installed: false, loaded: false, label: AUTOSTART_LABEL };
  }
  const path = autostartCoordinatorPath();
  const result = runCommand("launchctl", ["print", autostartTarget()]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    label: AUTOSTART_LABEL,
    definitionPath: path,
  };
}

export function installAutostart(config: AppConfig): AutostartStatus {
  assertMacOs();
  assertGooseLauncherOwnership(config);
  const current = getAutostartStatus();
  const layout = defaultAutostartFileLayout();
  const next = autostartDefinition(config, layout);
  if (current.loaded && current.installed && readFileSync(current.definitionPath!, "utf8") !== next) {
    throw new Error("Refusing to replace a loaded ordered-autostart definition; disable it first");
  }

  configureAutostartFiles(config, layout);
  const status = getAutostartStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), status.definitionPath!]);
  return getAutostartStatus();
}

export function triggerAutostart(): AutostartStatus {
  assertMacOs();
  const status = getAutostartStatus();
  if (!status.installed) throw new Error(`Ordered autostart is not installed: ${status.definitionPath}`);
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), status.definitionPath!]);
  else runChecked("launchctl", ["kickstart", autostartTarget()]);
  return getAutostartStatus();
}

export function disableAutostart(): AutostartStatus {
  assertMacOs();
  const status = getAutostartStatus();
  if (status.loaded) runChecked("launchctl", ["bootout", autostartTarget()]);
  disableAutostartFiles();
  return getAutostartStatus();
}

export function autostartManagedDefinitionPaths(): { service: string; tunnel: string } {
  return {
    service: managedServiceDefinitionPath(),
    tunnel: managedTunnelDefinitionPath(),
  };
}
