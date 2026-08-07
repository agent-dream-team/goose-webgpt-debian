import { expect, test } from "bun:test";
import { providerConfig } from "../src/config";
import {
  buildSetupConfig,
  installSetupCodexIntegration,
  launcherCapabilityProbeRequired,
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
  expect(() => buildSetupConfig(undefined, {
    mode: "full",
    standalone: true,
    acknowledgedUnofficial: true,
  })).toThrow("Standalone setup requires --browser-only");
});
