import { describe, expect, test } from "bun:test";
import { defaultConfig, type AppConfig } from "../src/config";
import { restartLinuxService } from "../src/service";

// Regression coverage for the Linux `restartService()` portability fix: setup's
// supported `--restart-service` path must cycle the daemon through the managed
// child-process lifecycle on Linux (never throwing the macOS-only assertion),
// drain against the credentials the RUNNING daemon still accepts, let the fresh
// child load the committed configuration, and fail closed with compensation.
//
// The contract is exercised through the `restartLinuxService` operation seam so
// these tests cannot contaminate other files' module registries.

function harness(loaded: boolean) {
  const calls: string[] = [];
  let drainedWith: AppConfig | undefined;
  let released = false;
  return {
    calls,
    drainedWithConfig: () => drainedWith,
    leaseReleased: () => released,
    loaded: () => loaded,
    drain: async (cfg: AppConfig) => {
      calls.push("drain");
      drainedWith = cfg;
      return { release: async () => { calls.push("resume"); released = true; } };
    },
    stop: async () => { calls.push("stop"); },
    start: async () => { calls.push("start"); return { supported: true, installed: true, loaded: true, label: "test" }; },
    status: () => ({ supported: true, installed: true, loaded: true, label: "test" }),
  };
}

describe("restartLinuxService contract", () => {
  test("cycles drain→managed stop→start with pre-restart credentials while loaded", async () => {
    const ops = harness(true);
    const committed = defaultConfig("browser-only");
    committed.controlToken = "committed-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const running = { ...committed, controlToken: "running-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    const status = await restartLinuxService(committed, running, ops);
    // Success replaces the daemon: no resume against the old process (macOS parity).
    expect(ops.calls).toEqual(["drain", "stop", "start"]);
    expect(ops.drainedWithConfig()?.controlToken).toBe(running.controlToken);
    expect(status.loaded).toBe(true);
  });

  test("starts directly without draining when no daemon is loaded", async () => {
    const ops = harness(false);
    const config = defaultConfig("browser-only");
    await restartLinuxService(config, config, ops);
    expect(ops.calls).toEqual(["start"]);
    expect(ops.drainedWithConfig()).toBeUndefined();
  });

  test("fails closed with compensating resume when the fresh daemon cannot start", async () => {
    const ops = harness(true);
    const running = defaultConfig("browser-only");
    running.controlToken = "running-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const failing = {
      ...ops,
      stop: async (): Promise<void> => { ops.calls.push("stop"); throw new Error("simulated group kill failure"); },
    };
    await expect(restartLinuxService(running, running, failing)).rejects.toThrow(/simulated group kill failure/);
    expect(ops.calls).toEqual(["drain", "stop", "resume"]);
    expect(ops.leaseReleased()).toBe(true);
  });
});
