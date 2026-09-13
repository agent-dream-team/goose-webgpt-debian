#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installedBunExecutable } from "../src/config";

export function dreamBookRebuildLauncherEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = join(homedir(), ".local", "share", "goose-chatgpt-web-rebuild");
  return {
    ...base,
    GOOSE_CHATGPT_WEB_APPLIANCE: "persistent-rebuild",
    CODEX_CHATGPT_WEB_HOME: home,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: join(home, "launcher"),
    CODEX_WEB_GPT_LAUNCHER_SOURCE_PROFILE: "production",
  };
}

export function dreamBookRebuildLauncherCommand(root = resolve(import.meta.dir, "..")): string[] {
  const bun = installedBunExecutable();
  const lease = join(root, "scripts", "dreambook-account-browser-lease.ts");
  const xvfbRun = "/usr/bin/xvfb-run";
  if (!existsSync(lease)) throw new Error(`Account lease entrypoint is missing: ${lease}`);
  if (!existsSync(xvfbRun)) throw new Error(`DreamBook Xvfb launcher is missing: ${xvfbRun}`);
  return [
    bun, lease,
    "--owner", "rebuild-launcher",
    "--",
    xvfbRun, "-a",
    bun, "run", join(root, "launcher", "scripts", "dev.cjs"),
  ];
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("DreamBook rebuild launcher is Linux-only");
  const env = dreamBookRebuildLauncherEnvironment();
  const bun = installedBunExecutable();
  env.CODEX_WEB_GPT_BUN = bun;
  env.CODEX_CHATGPT_WEB_BUN = bun;
  const child = Bun.spawn(dreamBookRebuildLauncherCommand(), {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try { process.exitCode = await child.exited; }
  finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`start-dreambook-rebuild-launcher: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
