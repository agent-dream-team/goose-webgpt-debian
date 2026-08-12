import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  inspectLauncherBrowserHost,
  notifyLauncherTurn,
  probeLauncherBrowserHost,
  readLauncherBrowserHostDescriptor,
} from "./launcher-browser-host";
import { loadConfig } from "./config";
import { installedBunExecutable } from "./config";
import { gooseLauncherBootstrapEnv } from "./goose-launcher-bootstrap";
import { runCommand, spawnDetached } from "./process";
import { getServiceStatus, assertServiceIdle, startService, stopService } from "./service";
import { getTunnelServiceStatus, startTunnelService, stopTunnelService, waitForTunnelServiceReady } from "./tunnel-service";
import { stopTunnel } from "./tunnel";
import { processRunning } from "./process";

const START_LAUNCHER_SCRIPT = join(process.cwd(), "scripts", "start-goose-launcher.ts");

export interface LifecycleStatus {
  service: ReturnType<typeof getServiceStatus>;
  tunnelService: ReturnType<typeof getTunnelServiceStatus>;
  browserHost?: {
    ready: boolean;
    detail?: string;
  };
}

interface LauncherBrowserHostProbeDependencies {
  notify: typeof notifyLauncherTurn;
  runHelperSmoke: typeof runLauncherBrowserHelperSmoke;
}

const DEFAULT_BROWSER_HOST_PROBE_DEPENDENCIES: LauncherBrowserHostProbeDependencies = {
  notify: notifyLauncherTurn,
  runHelperSmoke: runLauncherBrowserHelperSmoke,
};

function launcherDescriptorPath(config = loadConfig()): string | undefined {
  return config.browserHost === "launcher" ? config.browserHostDescriptorPath : undefined;
}

async function startLauncherBootstrapOnly(): Promise<void> {
  const bun = installedBunExecutable();
  spawnDetached(bun, ["run", START_LAUNCHER_SCRIPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...gooseLauncherBootstrapEnv(process.env),
    },
  });
}

export async function waitForLauncherBrowserHostSessionReady(descriptorPath: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastError = "launcher browser host did not become session-ready";
  while (Date.now() < deadline) {
    try {
      await inspectLauncherBrowserHost(descriptorPath, { timeoutMs: 5_000, detectPro: false });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(lastError);
}

export async function proveLauncherBrowserHostSurfaceReady(
  descriptorPath: string,
  dependencies: LauncherBrowserHostProbeDependencies = DEFAULT_BROWSER_HOST_PROBE_DEPENDENCIES,
): Promise<void> {
  const traceId = `lifecycle_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const helperPid = process.pid;
  const lease = await dependencies.notify(descriptorPath, { phase: "start", traceId, helperPid });
  if (!lease.surfaceId) {
    throw new Error("Launcher did not lease a browser tab for the lifecycle readiness probe");
  }
  let probeError: unknown;
  try {
    await dependencies.runHelperSmoke(descriptorPath, traceId, lease.surfaceId);
  } catch (error) {
    probeError = error;
    throw error;
  } finally {
    try {
      await dependencies.notify(descriptorPath, {
        phase: "end",
        traceId,
        helperPid,
        status: probeError ? "failed" : "completed",
        ...(probeError instanceof Error ? { message: probeError.message.slice(0, 500) } : {}),
      });
    } catch (endError) {
      if (!probeError) throw endError;
    }
  }
}

interface LauncherBrowserHelperSmokeDependencies {
  spawnImpl: typeof spawn;
  createInterfaceImpl: typeof createInterface;
}

const DEFAULT_LAUNCHER_BROWSER_HELPER_SMOKE_DEPENDENCIES: LauncherBrowserHelperSmokeDependencies = {
  spawnImpl: spawn,
  createInterfaceImpl: createInterface,
};

async function runLauncherBrowserHelperSmoke(
  descriptorPath: string,
  traceId: string,
  surfaceId: string,
  dependencies: LauncherBrowserHelperSmokeDependencies = DEFAULT_LAUNCHER_BROWSER_HELPER_SMOKE_DEPENDENCIES,
): Promise<void> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const child = dependencies.spawnImpl(descriptor.helper.executable, [descriptor.helper.script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = dependencies.createInterfaceImpl({ input: child.stdout });
  const errors = dependencies.createInterfaceImpl({ input: child.stderr });
  errors.on("line", line => console.info(`[chatgpt-web-helper] ${line}`));
  const messages: string[] = [];
  let settled = false;
  const completion = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) reject(new Error("Launcher browser helper smoke did not complete"));
    }, 60_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    output.on("line", line => {
      messages.push(line);
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.type === "result" && message.id === traceId) {
          finish();
        } else if (message.type === "error" && message.id === traceId) {
          finish(new Error(typeof message.message === "string" ? message.message : "Launcher browser helper smoke failed"));
        }
      } catch {}
    });
    child.once("error", error => finish(error instanceof Error ? error : new Error(String(error))));
    child.once("exit", code => {
      if (settled) return;
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`Launcher browser helper exited with status ${code ?? 1}`));
    });
  });
  child.stdin.write(`${JSON.stringify({
    type: "smoke",
    id: traceId,
    config: {
      appName: "Goose Native",
      browserHostDescriptorPath: descriptorPath,
    },
    surfaceId,
  })}\n`);
  child.stdin.end();
  try {
    await completion;
  } finally {
    output.close();
    errors.close();
    child.kill("SIGTERM");
  }
}

async function waitForBrowserHostShutdown(descriptorPath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(descriptorPath)) return;
    try {
      const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
      if (!processRunning(descriptor.pid)) {
        rmSync(descriptorPath, { force: true });
        return;
      }
    } catch {
      rmSync(descriptorPath, { force: true });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Launcher browser host did not shut down cleanly");
}

export async function getLifecycleStatus(): Promise<LifecycleStatus> {
  const service = getServiceStatus();
  const tunnelService = getTunnelServiceStatus();
  const descriptorPath = launcherDescriptorPath();
  if (!descriptorPath || !existsSync(descriptorPath)) {
    return { service, tunnelService, browserHost: { ready: false, detail: "launcher browser descriptor is missing" } };
  }
  try {
    await probeLauncherBrowserHost(descriptorPath, { timeoutMs: 5_000 });
    return { service, tunnelService, browserHost: { ready: true } };
  } catch (error) {
    return { service, tunnelService, browserHost: { ready: false, detail: error instanceof Error ? error.message : String(error) } };
  }
}

export async function startLifecycle(): Promise<LifecycleStatus> {
  const config = loadConfig();
  let startedLauncherBootstrap = false;
  try {
    if (config.mode === "full") {
      if (!getTunnelServiceStatus().loaded) startTunnelService();
      const tunnel = await waitForTunnelServiceReady(config);
      if (!tunnel.ok) throw new Error(`Tunnel runtime did not become ready: ${tunnel.detail}`);
    }
    if (config.browserHost === "launcher") {
      const descriptorPath = config.browserHostDescriptorPath!;
      if (!existsSync(descriptorPath)) {
        await startLauncherBootstrapOnly();
        startedLauncherBootstrap = true;
      } else {
        try {
          readLauncherBrowserHostDescriptor(descriptorPath);
        } catch {
          rmSync(descriptorPath, { force: true });
          await startLauncherBootstrapOnly();
          startedLauncherBootstrap = true;
        }
      }
      await waitForLauncherBrowserHostSessionReady(descriptorPath);
      await proveLauncherBrowserHostSurfaceReady(descriptorPath);
      await probeLauncherBrowserHost(descriptorPath, { timeoutMs: 5_000 });
    }
    if (config.mode === "browser-only") {
      if (!getServiceStatus().loaded) startService();
    } else {
      if (!getServiceStatus().loaded) startService();
      const tunnel = await waitForTunnelServiceReady(config);
      if (!tunnel.ok) throw new Error(`Tunnel runtime did not become ready: ${tunnel.detail}`);
    }
    return await getLifecycleStatus();
  } catch (error) {
    if (startedLauncherBootstrap && config.browserHost === "launcher") {
      const descriptorPath = config.browserHostDescriptorPath!;
      try {
        if (existsSync(descriptorPath)) {
          const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
          runCommand("kill", ["-TERM", String(descriptor.pid)]);
          await waitForBrowserHostShutdown(descriptorPath);
        }
      } catch {
        rmSync(descriptorPath, { force: true });
      }
    }
    throw error;
  }
}

export async function stopLifecycle(): Promise<LifecycleStatus> {
  const config = loadConfig();
  await assertServiceIdle(config);
  if (getServiceStatus().loaded) await stopService(config);
  if (config.browserHost === "launcher") {
    const descriptorPath = config.browserHostDescriptorPath!;
    if (existsSync(descriptorPath)) {
      try {
        const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
        runCommand("kill", ["-TERM", String(descriptor.pid)]);
      } catch {}
    }
    await waitForBrowserHostShutdown(descriptorPath);
  }
  if (config.mode === "full") {
    await stopTunnelService();
    stopTunnel(config);
  }
  return await getLifecycleStatus();
}

export async function restartLifecycle(): Promise<LifecycleStatus> {
  await stopLifecycle();
  return await startLifecycle();
}
