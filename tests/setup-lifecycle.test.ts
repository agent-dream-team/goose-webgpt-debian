import { expect, test } from "bun:test";
import { CHATGPT_CONNECTOR_NAME, providerConfig } from "../src/config";
import {
  buildSetupConfig,
  installSetupCodexIntegration,
  launcherCapabilityProbeRequired,
  launcherRuntimeOwnershipRequired,
  nextControlToken,
  preflightSetupCodexIntegration,
  setupProxyIsReady,
} from "../src/setup";

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("launcher setup readiness still requires the daemon health contract, not just the restart request", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "full",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, { mode: "full", releaseVersion: "0.2.0" })).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, { mode: "full", releaseVersion: "0.2.0" })).toBe(false);
});

test("repeat launcher setup reuses the previously verified Pro capability", () => {
  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    proAvailable: true,
  } as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    proAvailable: false,
  } as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    browserHost: "managed-chrome",
    proAvailable: true,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(undefined, true)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    browserHost: "managed-chrome",
    proAvailable: true,
  } as never, true)).toBe(false);
});

test("goose standalone launcher setup keeps browser-host ownership separate from runtime ownership", () => {
  const launcherBrowserHost = buildSetupConfig(undefined, {
    mode: "full",
    standalone: true,
    browserHostDescriptorPath: "/tmp/launcher-browser.json",
    acknowledgedUnofficial: true,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    runtimeKeyFile: "/tmp/runtime.key",
  });
  const launcherRuntime = buildSetupConfig(undefined, {
    mode: "full",
    acknowledgedUnofficial: true,
    browserHostDescriptorPath: "/tmp/launcher-browser.json",
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    runtimeKeyFile: "/tmp/runtime.key",
  });

  expect(launcherRuntimeOwnershipRequired(launcherBrowserHost, true)).toBe(false);
  expect(launcherRuntimeOwnershipRequired(launcherRuntime, false)).toBe(true);
  expect(launcherRuntimeOwnershipRequired({
    ...launcherBrowserHost,
    browserHost: "managed-chrome",
  } as never, true)).toBe(false);
});

test("restart-only setup rotates only the new control token", () => {
  const existing = buildSetupConfig(undefined, {
    mode: "browser-only",
    acknowledgedUnofficial: true,
  });

  expect(nextControlToken(existing, true, existing.controlToken, () => "rotated-token")).toBe("rotated-token");
  expect(nextControlToken(existing, false, existing.controlToken, () => "rotated-token")).toBe(existing.controlToken);
  expect(nextControlToken(undefined, true, "stable-token", () => "rotated-token")).toBe("stable-token");
});

test("standalone browser-only setup skips every Codex integration phase", () => {
  const config = buildSetupConfig(undefined, {
    mode: "browser-only",
    standalone: true,
    acknowledgedUnofficial: true,
  });
  let preflightCalls = 0;
  let installCalls = 0;

  expect(preflightSetupCodexIntegration(config, { mode: "browser-only", standalone: true }, () => {
    preflightCalls += 1;
  })).toBe(false);
  expect(installSetupCodexIntegration(config, { mode: "browser-only", standalone: true }, () => {
    installCalls += 1;
    return {} as never;
  })).toBe(false);
  expect({ preflightCalls, installCalls }).toEqual({ preflightCalls: 0, installCalls: 0 });
});

test("setup retains the existing Codex integration phases by default", () => {
  const config = buildSetupConfig(undefined, {
    mode: "browser-only",
    acknowledgedUnofficial: true,
  });
  let preflightCalls = 0;
  let installCalls = 0;

  expect(preflightSetupCodexIntegration(config, { mode: "browser-only" }, () => {
    preflightCalls += 1;
  })).toBe(true);
  expect(installSetupCodexIntegration(config, { mode: "browser-only" }, () => {
    installCalls += 1;
    return {} as never;
  })).toBe(true);
  expect({ preflightCalls, installCalls }).toEqual({ preflightCalls: 1, installCalls: 1 });
});

test("standalone setup produces usable browser-only daemon configuration", () => {
  const config = buildSetupConfig(undefined, {
    mode: "browser-only",
    standalone: true,
    port: 17841,
    acknowledgedUnofficial: true,
  });
  const provider = providerConfig(config);

  expect(config).toMatchObject({
    mode: "browser-only",
    standalone: true,
    host: "127.0.0.1",
    port: 17841,
    headed: true,
  });
  expect(config.tunnel).toBeUndefined();
  expect(provider.chatgptWeb!.localToolsEnabled).toBe(false);
});

test("standalone setup also allows full mode, enabling local tools without touching Codex", () => {
  const config = buildSetupConfig(undefined, {
    mode: "full",
    standalone: true,
    acknowledgedUnofficial: true,
  });
  const provider = providerConfig(config);

  expect(config).toMatchObject({ mode: "full", standalone: true });
  expect(provider.chatgptWeb!.localToolsEnabled).toBe(true);
  expect(provider.chatgptWeb!.standalone).toBe(true);
  expect(preflightSetupCodexIntegration(config, { mode: "full", standalone: true }, () => {
    throw new Error("must not preflight Codex integration for standalone full setup");
  })).toBe(false);
  expect(installSetupCodexIntegration(config, { mode: "full", standalone: true }, () => {
    throw new Error("must not install Codex integration for standalone full setup");
  })).toBe(false);
});

test("a fresh setup defaults the connector name to the current identity", () => {
  const config = buildSetupConfig(undefined, {
    mode: "browser-only",
    acknowledgedUnofficial: true,
  });
  expect(config.appName).toBe(CHATGPT_CONNECTOR_NAME);
});

test("re-running setup over an existing legacy connector name migrates it forward", () => {
  const existing = buildSetupConfig(undefined, {
    mode: "browser-only",
    acknowledgedUnofficial: true,
  });
  existing.appName = "Codex Native";
  const migrated = buildSetupConfig(existing, {
    mode: "browser-only",
    acknowledgedUnofficial: true,
  });
  expect(migrated.appName).toBe(CHATGPT_CONNECTOR_NAME);
});

test("setup refuses an explicit --app-name that reuses the retired connector identity", () => {
  expect(() => buildSetupConfig(undefined, {
    mode: "browser-only",
    acknowledgedUnofficial: true,
    appName: "Codex Native",
  })).toThrow(/newly created connector named/);
});
