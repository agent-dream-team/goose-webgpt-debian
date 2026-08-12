import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AUTOSTART_LABEL,
  autostartDefinition,
  configureAutostartFiles,
  defaultAutostartFileLayout,
  disableAutostartFiles,
} from "../src/autostart";
import { defaultConfig } from "../src/config";
import { SERVICE_LABEL } from "../src/service";
import { TUNNEL_SERVICE_LABEL } from "../src/tunnel-service";
import { createTunnelConfig } from "../src/tunnel";

const roots: string[] = [];
const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testConfig(root: string) {
  const appHome = join(root, "goose-home");
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  const config = defaultConfig("full");
  config.standalone = true;
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = join(appHome, "runtime", "launcher-browser.json");
  config.runtimeCommand = [process.execPath, resolve(import.meta.dir, "../src/cli.ts")];
  config.tunnel = createTunnelConfig({
    binaryPath: join(appHome, "bin", "tunnel-client"),
    runtimeKeyFile: join(appHome, "secrets", "runtime.key"),
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
  });
  return { appHome, config };
}

function testLayout(root: string, appHome: string) {
  return defaultAutostartFileLayout(appHome, join(root, "user"), resolve(import.meta.dir, ".."));
}

test("ordered autostart invokes only the canonical lifecycle entrypoint with the Goose home", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-autostart-definition-"));
  roots.push(root);
  const { appHome, config } = testConfig(root);
  const layout = testLayout(root, appHome);

  const definition = autostartDefinition(config, layout);
  expect(definition).toContain(`<string>${AUTOSTART_LABEL}</string>`);
  expect(definition).toContain(`<string>${process.execPath}</string>`);
  expect(definition).toContain(`<string>${resolve(import.meta.dir, "../src/cli.ts")}</string>`);
  expect(definition).toContain(`<string>--home</string>\n    <string>${appHome}</string>\n    <string>lifecycle</string>\n    <string>start</string>`);
  expect(definition).toContain(`<key>CODEX_CHATGPT_WEB_HOME</key>\n    <string>${appHome}</string>`);
  expect(definition).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(definition).toContain("<key>KeepAlive</key>\n  <false/>");
  expect(definition).not.toContain("<string>service</string>");
  expect(definition).not.toContain("<string>tunnel</string>");
  expect(definition).not.toContain("sleep ");
});

test("installation leaves exactly one login startup authority and preserves launchd supervision definitions", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-autostart-files-"));
  roots.push(root);
  const { appHome, config } = testConfig(root);
  const layout = testLayout(root, appHome);
  mkdirSync(layout.launchAgentsDir, { recursive: true });
  const legacyService = join(layout.launchAgentsDir, `${SERVICE_LABEL}.plist`);
  const legacyTunnel = join(layout.launchAgentsDir, `${TUNNEL_SERVICE_LABEL}.plist`);
  writeFileSync(legacyService, "known-good-daemon-definition\n");
  writeFileSync(legacyTunnel, "known-good-tunnel-definition\n");

  const installed = configureAutostartFiles(config, layout);

  expect(readdirSync(layout.launchAgentsDir).sort()).toEqual([`${AUTOSTART_LABEL}.plist`]);
  expect(readFileSync(installed.servicePath, "utf8")).toBe("known-good-daemon-definition\n");
  expect(readFileSync(installed.tunnelPath!, "utf8")).toBe("known-good-tunnel-definition\n");
  expect(installed.servicePath.startsWith(layout.managedLaunchdDir)).toBe(true);
  expect(installed.tunnelPath!.startsWith(layout.managedLaunchdDir)).toBe(true);
  expect(readFileSync(installed.coordinatorPath, "utf8")).toContain("<string>lifecycle</string>\n    <string>start</string>");
});

test("disabling ordered autostart removes only the coordinator", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-autostart-disable-"));
  roots.push(root);
  const { appHome, config } = testConfig(root);
  const layout = testLayout(root, appHome);
  const installed = configureAutostartFiles(config, layout);
  const unrelatedAgent = join(layout.launchAgentsDir, "com.example.unrelated.plist");
  const unrelatedManaged = join(layout.managedLaunchdDir, "unrelated-state.txt");
  writeFileSync(unrelatedAgent, "unrelated\n");
  writeFileSync(unrelatedManaged, "unrelated\n");

  disableAutostartFiles(layout);

  expect(existsSync(installed.coordinatorPath)).toBe(false);
  expect(readFileSync(installed.servicePath, "utf8").length).toBeGreaterThan(0);
  expect(readFileSync(installed.tunnelPath!, "utf8").length).toBeGreaterThan(0);
  expect(readFileSync(unrelatedAgent, "utf8")).toBe("unrelated\n");
  expect(readFileSync(unrelatedManaged, "utf8")).toBe("unrelated\n");
});

test("Goose launcher bootstrap-only mode cannot restore upstream Electron login ownership", () => {
  const root = resolve(import.meta.dir, "..");
  const startScript = readFileSync(join(root, "scripts", "start-goose-launcher.ts"), "utf8");
  const electronMain = readFileSync(join(root, "launcher", "electron", "main.cjs"), "utf8");

  expect(startScript).toContain('CODEX_WEB_GPT_LAUNCHER_BOOTSTRAP_ONLY: "1"');
  expect(electronMain).toContain("current.autoStart && !launcherBootstrapOnly");
  expect(electronMain).toContain("launcherBootstrapOnly ? { supported: false, enabled: false } : getAutostart(app)");
  expect(electronMain).toContain("Goose bootstrap-only autostart is owned by the canonical lifecycle");
});
