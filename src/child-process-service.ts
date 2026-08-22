import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "./config";
import { processRunning } from "./process";

/**
 * Direct child-process service primitives for platforms without launchd (Linux today).
 *
 * These helpers replicate exactly the process contract the macOS launchd definitions
 * encode — same entry points, same environment, detached supervision with logs under
 * the runtime home — without introducing a second orchestration architecture. The
 * macOS launchd paths remain authoritative on Darwin and do not call into this module.
 */

export function childServicePidPath(name: string, configDir = getConfigDir()): string {
  return join(configDir, "run", `${name}.pid`);
}

export function readChildServicePid(pidPath: string): number | undefined {
  if (!existsSync(pidPath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(pidPath, "utf8").trim();
  } catch {
    return undefined;
  }
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Reads the recorded PID and drops the pidfile when the process is already gone. */
export function liveChildServicePid(name: string, configDir = getConfigDir()): number | undefined {
  const pidPath = childServicePidPath(name, configDir);
  const pid = readChildServicePid(pidPath);
  if (pid === undefined || !processRunning(pid)) {
    removePidFileIfUnchanged(pidPath, pid);
    return undefined;
  }
  return pid;
}

/**
 * Removes a stale pidfile only while it still records the observed dead/invalid PID,
 * so a concurrent start that just wrote a fresh record can never be race-deleted.
 */
function removePidFileIfUnchanged(pidPath: string, pid: number | undefined): void {
  if (readChildServicePid(pidPath) === pid) rmSync(pidPath, { force: true });
}

const START_LOCK_STALE_MS = 30_000;
const START_LOCK_ATTEMPTS = 3;

/**
 * Serializes check-spawn-record sequences per service name so two concurrent starts
 * can never both spawn: the loser fails fast with a deterministic error instead of
 * creating an unowned daemon. Crashed holders are taken over once the lock is stale.
 */
export function acquireChildServiceStartLock(name: string, configDir = getConfigDir()): () => void {
  const runDir = join(configDir, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const lockPath = join(runDir, `${name}.start.lock`);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > START_LOCK_STALE_MS;
      } catch { /* vanished between EEXIST and stat; retry immediately */ }
      if (!stale || attempt >= START_LOCK_ATTEMPTS - 1) {
        throw new Error(`${name} service start is already in progress (lock: ${lockPath})`);
      }
      if (stale) rmSync(lockPath, { force: true });
    }
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // ESRCH proves the group is gone; EPERM still proves it exists.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // ESRCH means the group is already gone; anything else is a real failure.
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
  }
}

async function waitGroupExit(pid: number, graceMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (groupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolveWait => setTimeout(resolveWait, pollMs));
  }
  return true;
}

function openLog(path: string): number {
  return openSync(path, "a", 0o600);
}

export interface StartChildServiceOptions {
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  configDir?: string;
}

/**
 * Spawns a detached service child (own process group, pgid == pid), appending
 * stdout/stderr to per-service log files under `<runtime home>/logs/`, and records
 * its PID atomically. Returns the child PID.
 *
 * Failure containment: if anything fails after the spawn succeeded (notably the
 * pidfile write), the just-spawned process group is killed so this function can never
 * return normally-or-throw while leaving an unowned running service behind.
 */
export function startChildService({ name, command, args, env, configDir = getConfigDir() }: StartChildServiceOptions): number {
  const releaseStartLock = acquireChildServiceStartLock(name, configDir);
  try {
    return startChildServiceLocked({ name, command, args, env, configDir });
  } finally {
    releaseStartLock();
  }
}

function startChildServiceLocked({ name, command, args, env, configDir }: StartChildServiceOptions & { configDir: string }): number {
  // Refuse a double start up front: the pidfile is the ownership record, and a second
  // spawn would overwrite it and orphan the first daemon.
  const existingPidPath = childServicePidPath(name, configDir);
  const existingPid = readChildServicePid(existingPidPath);
  if (existingPid !== undefined && processRunning(existingPid)) {
    throw new Error(`${name} service is already running as pid ${existingPid}`);
  }
  removePidFileIfUnchanged(existingPidPath, existingPid);

  const logDir = join(configDir, "logs");
  // The launchd installers create the logs directory up front; the direct child path
  // must not depend on that having happened.
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const out = openLog(join(logDir, `${name}.stdout.log`));
  let error = -1;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    error = openLog(join(logDir, `${name}.stderr.log`));
    child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", out, error],
      env,
    });
    // POSIX ENOENT-style spawn failures arrive asynchronously; without a listener the
    // process would crash on the unhandled 'error' event. Liveness-based readiness
    // checks are the authoritative failure evidence, so the event itself is inert here.
    child.on("error", () => {});
    child.unref();
    // detached:true makes the child a POSIX process-group leader, so the recorded
    // PID is also the group ID used by stopChildService.
    const pid = child.pid ?? -1;
    if (pid <= 0) {
      throw new Error(`Failed to start ${name} child process`);
    }
    try {
      atomicWriteFile(childServicePidPath(name, configDir), `${pid}\n`);
    } catch (writeError) {
      // Never leave a running service without its ownership record.
      try {
        process.kill(-pid, "SIGKILL");
      } catch { /* group may have died already; ESRCH is fine */ }
      const detail = writeError instanceof Error ? writeError.message : String(writeError);
      throw new Error(`Failed to record ${name} service pidfile; killed the spawned process group ${pid}: ${detail}`);
    }
    return pid;
  } finally {
    closeSync(out);
    if (error !== -1) closeSync(error);
  }
}

export interface StopChildServiceOptions {
  configDir?: string;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Terminates a started child service by killing its whole process group:
 * SIGTERM first, then SIGKILL after a bounded grace period, then removes the
 * pidfile. Throws if the group survives past the kill deadline so callers never
 * silently orphan a service child.
 */
export async function stopChildService(
  name: string,
  { configDir = getConfigDir(), timeoutMs = 15_000, pollMs = 50 }: StopChildServiceOptions = {},
): Promise<void> {
  const pidPath = childServicePidPath(name, configDir);
  const pid = readChildServicePid(pidPath);
  if (pid === undefined) {
    removePidFileIfUnchanged(pidPath, pid);
    return;
  }

  signalGroup(pid, "SIGTERM");
  // Half the budget for SIGTERM so SIGKILL always gets a bounded window too.
  let exited = await waitGroupExit(pid, Math.max(1_000, Math.floor(timeoutMs / 2)), pollMs);
  if (!exited) {
    signalGroup(pid, "SIGKILL");
    exited = await waitGroupExit(pid, Math.max(500, timeoutMs), pollMs);
  }
  if (!exited) {
    throw new Error(`${name} service process group ${pid} did not exit after SIGTERM and SIGKILL within ${timeoutMs}ms`);
  }
  rmSync(pidPath, { force: true });
}

/** Last human-readable lines of a service log, for deterministic failure messages. */
export function tailChildServiceLog(name: string, which: "stdout" | "stderr" = "stderr", maxChars = 500, configDir = getConfigDir()): string {
  const path = join(configDir, "logs", `${name}.${which}.log`);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trimEnd().slice(-maxChars);
  } catch {
    return "";
  }
}
