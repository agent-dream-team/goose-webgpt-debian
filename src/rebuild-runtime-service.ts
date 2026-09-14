import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import { createRebuildNodeBrowserDriver } from "./rebuild-node-browser-driver";
import { startRebuildProviderRuntime, type RebuildProviderRuntime } from "./rebuild-provider-runtime";

export const REBUILD_PROVIDER_MODEL = "gpt-4.1";

export interface PersistentRebuildService {
  runtime: RebuildProviderRuntime;
  stopped: Promise<void>;
  stop(): Promise<void>;
}

function requiredAbsoluteFile(value: string | undefined, label: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  if (!existsSync(value)) throw new Error(`${label} is missing: ${value}`);
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return value;
}

export function startPersistentRebuildService(config: AppConfig): PersistentRebuildService {
  if (config.runtimeKind !== "persistent-rebuild" || !config.rebuild) {
    throw new Error("Persistent rebuild service requires a persistent-rebuild configuration");
  }
  if (config.mode !== "full" || config.browserHost !== "launcher" || config.browserInteractionMode !== "automatic") {
    throw new Error("Persistent rebuild service requires full automatic launcher mode");
  }
  const descriptorPath = requiredAbsoluteFile(config.browserHostDescriptorPath, "Launcher browser descriptor");
  const nodeExecutable = requiredAbsoluteFile(
    process.env.CODEX_CHATGPT_WEB_REBUILD_NODE_EXECUTABLE,
    "Rebuild Node executable",
  );
  const workerPath = requiredAbsoluteFile(
    process.env.CODEX_CHATGPT_WEB_REBUILD_NODE_WORKER,
    "Rebuild Node browser worker",
  );

  const home = getConfigDir();
  const runtimeDir = join(home, "runtime");
  const secretsDir = join(home, "secrets");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const brokerPath = join(runtimeDir, "persistent-rebuild-broker.sqlite");
  const connectorAuthorizationFile = join(secretsDir, "connector-authorization.txt");

  let resolveStopped!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  const browserDriver = createRebuildNodeBrowserDriver({
    nodeExecutable,
    workerPath,
    workerEnv: { ELECTRON_RUN_AS_NODE: "1" },
    descriptorPath,
    projectId: config.rebuild.projectId,
    projectName: config.rebuild.projectName,
    connectorName: config.rebuild.connectorName,
    connectorMentionQuery: config.rebuild.connectorMentionQuery,
  });
  const runtime = startRebuildProviderRuntime({
    port: config.port,
    model: REBUILD_PROVIDER_MODEL,
    contextWindow: config.contextWindow,
    controlToken: config.controlToken,
    projectId: config.rebuild.projectId,
    connectorIdentity: config.rebuild.connectorName,
    brokerPath,
    connectorPort: config.rebuild.connectorPort,
    connectorAuthorizationFile,
    browserDriver,
    onStopped: resolveStopped,
  });
  return { runtime, stopped, stop: runtime.stop };
}
