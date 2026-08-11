import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath } from "./config";

export interface GooseLauncherBootstrapEnv {
  CODEX_CHATGPT_WEB_HOME: string;
  CODEX_WEB_GPT_LAUNCHER_DATA_DIR: string;
}

export function defaultGooseRuntimeHome(home = homedir()): string {
  return resolve(join(home, ".goose-chatgpt-web-dev"));
}

export function gooseLauncherBootstrapEnv(env: NodeJS.ProcessEnv = process.env, home = homedir()): GooseLauncherBootstrapEnv {
  const runtimeHome = env.CODEX_CHATGPT_WEB_HOME?.trim()
    ? resolve(expandUserPath(env.CODEX_CHATGPT_WEB_HOME.trim()))
    : defaultGooseRuntimeHome(home);
  const launcherDataDir = env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR?.trim()
    ? resolve(expandUserPath(env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR.trim()))
    : join(runtimeHome, "launcher");
  return {
    CODEX_CHATGPT_WEB_HOME: runtimeHome,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: launcherDataDir,
  };
}
