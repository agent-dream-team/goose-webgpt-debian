#!/usr/bin/env bun
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { processRunning } from "../src/process";

const LOCK_CONFLICT_EXIT = 73;
const DESCRIPTOR_KIND = "codex-web-gpt-launcher";
const DEFAULT_FLOCK = "/usr/bin/flock";
const DEFAULT_LSLOCKS = "/usr/bin/lslocks";
const TEST_OVERRIDE_ENV = "CGW_DREAMBOOK_ACCOUNT_LEASE_TESTING";

function canonicalLockPath(): string {
  if (typeof process.getuid !== "function") return "/run/lock/goose-chatgpt-web-account.lock";
  return `/run/lock/goose-chatgpt-web-account-${process.getuid()}.lock`;
}

function canonicalGuardDescriptors(): string[] {
  const home = homedir();
  return [
    join(home, ".goose-chatgpt-web-dev", "runtime", "launcher-browser.json"),
    join(home, ".local", "share", "goose-chatgpt-web-rebuild", "runtime", "launcher-browser.json"),
  ];
}

interface Options {
  held: boolean;
  checkOnly: boolean;
  reconcileOnly: boolean;
  testOverrides: boolean;
  owner: string;
  lockPath: string;
  markerPath: string;
  guardDescriptors: string[];
  command: string[];
}

interface DescriptorObservation {
  path: string;
  state: "absent" | "stale" | "live";
  pid?: number;
}

function usage(): never {
  throw new Error(
    "Usage: dreambook-account-browser-lease --owner NAME [--check|--reconcile]"
      + " [--guard-descriptor /absolute/path]... -- COMMAND [ARG...]",
  );
}

function optionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value === "--") throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(argv: string[]): Options {
  const args = [...argv];
  let held = false;
  let checkOnly = false;
  let reconcileOnly = false;
  let testOverrides = false;
  let owner = "";
  let lockPath = canonicalLockPath();
  let markerPath = "";
  const testing = process.env[TEST_OVERRIDE_ENV] === "1";
  const guardDescriptors: string[] = canonicalGuardDescriptors();
  const separator = args.indexOf("--");
  const options = separator >= 0 ? args.slice(0, separator) : args;
  const command = separator >= 0 ? args.slice(separator + 1) : [];

  for (let index = 0; index < options.length; index += 1) {
    const arg = options[index];
    if (arg === "--held") held = true;
    else if (arg === "--check") checkOnly = true;
    else if (arg === "--reconcile") reconcileOnly = true;
    else if (arg === "--test-overrides") testOverrides = true;
    else if (arg === "--owner") {
      owner = optionValue(options, index, arg);
      index += 1;
    } else if (arg === "--lock") {
      lockPath = optionValue(options, index, arg);
      index += 1;
    } else if (arg === "--marker") {
      markerPath = optionValue(options, index, arg);
      index += 1;
    } else if (arg === "--guard-descriptor") {
      guardDescriptors.push(optionValue(options, index, arg));
      index += 1;
    } else usage();
  }

  if (!/^[A-Za-z0-9._-]{1,64}$/.test(owner)) throw new Error("--owner is invalid");
  if (testOverrides && (!testing || !owner.startsWith("test-"))) {
    throw new Error(`--test-overrides requires ${TEST_OVERRIDE_ENV}=1 and a test-* owner`);
  }
  if (!isAbsolute(lockPath)) throw new Error("--lock must be an absolute path");
  if (!markerPath) markerPath = `${lockPath}.owner.json`;
  if (!isAbsolute(markerPath)) throw new Error("--marker must be an absolute path");
  if (markerPath === lockPath) throw new Error("--marker must differ from --lock");
  if (!testOverrides && (lockPath !== canonicalLockPath() || markerPath !== `${canonicalLockPath()}.owner.json`)) {
    throw new Error("Custom account lease paths require explicit test-only overrides");
  }
  if (testOverrides) guardDescriptors.splice(0, canonicalGuardDescriptors().length);
  if (new Set(guardDescriptors).size !== guardDescriptors.length
    || guardDescriptors.some(path => !isAbsolute(path))) {
    throw new Error("--guard-descriptor paths must be unique and absolute");
  }
  if (checkOnly && reconcileOnly) throw new Error("Choose at most one of --check or --reconcile");
  if ((checkOnly || reconcileOnly) && command.length > 0) {
    throw new Error(`${checkOnly ? "--check" : "--reconcile"} does not accept a command`);
  }
  if (!checkOnly && !reconcileOnly && command.length === 0) usage();
  return { held, checkOnly, reconcileOnly, testOverrides, owner, lockPath, markerPath, guardDescriptors, command };
}

function assertDreamBookLinux(): void {
  if (process.platform !== "linux") {
    throw new Error("DreamBook account BrowserHost lease is Linux-only; use the deployment-specific gate for this host");
  }
  if (!existsSync(DEFAULT_FLOCK)) throw new Error(`Required kernel flock utility is missing: ${DEFAULT_FLOCK}`);
  if (!existsSync(DEFAULT_LSLOCKS)) throw new Error(`Required lock inspection utility is missing: ${DEFAULT_LSLOCKS}`);
  if (typeof process.getuid !== "function") throw new Error("DreamBook lease requires Unix process ownership checks");
}

function assertOwnerOnlyRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions are unsafe: ${path}`);
  if (stat.uid !== process.getuid!()) throw new Error(`${label} is not owned by the current user: ${path}`);
}

function prepareLockFile(path: string): void {
  if (!existsSync(dirname(path))) throw new Error(`Lease directory does not exist: ${dirname(path)}`);
  if (existsSync(path)) {
    assertOwnerOnlyRegularFile(path, "Account lease file");
    return;
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  chmodSync(path, 0o600);
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
  assertOwnerOnlyRegularFile(path, label);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label} is invalid JSON: ${path}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object: ${path}`);
  }
  return value as Record<string, unknown>;
}

export function inspectGuardDescriptor(path: string): DescriptorObservation {
  if (!existsSync(path)) return { path, state: "absent" };
  const descriptor = readJsonObject(path, "Launcher descriptor");
  if (descriptor.version !== 3 || descriptor.kind !== DESCRIPTOR_KIND
    || !Number.isInteger(descriptor.pid) || (descriptor.pid as number) < 1) {
    throw new Error(`Launcher descriptor identity is invalid: ${path}`);
  }
  const pid = descriptor.pid as number;
  return { path, state: processRunning(pid) ? "live" : "stale", pid };
}

type UnresolvedMarker = {
  version: 1;
  owner: string;
  routePid: number;
  startedAt: string;
} & (
  | { state: "starting" }
  | { state: "running"; commandPid: number }
);

function readUnresolvedMarker(path: string): UnresolvedMarker | undefined {
  if (!existsSync(path)) return undefined;
  const marker = readJsonObject(path, "Account lease unresolved marker");
  const baseValid = marker.version === 1
    && typeof marker.owner === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(marker.owner)
    && Number.isInteger(marker.routePid) && (marker.routePid as number) > 0
    && typeof marker.startedAt === "string" && !Number.isNaN(Date.parse(marker.startedAt));
  const stateValid = marker.state === "starting"
    ? marker.commandPid === undefined
    : marker.state === "running"
      && Number.isInteger(marker.commandPid) && (marker.commandPid as number) > 0;
  if (!baseValid || !stateValid) throw new Error(`Account lease unresolved marker has invalid shape: ${path}`);
  return marker as unknown as UnresolvedMarker;
}

function assertNoUnresolvedMarker(path: string): void {
  const marker = readUnresolvedMarker(path);
  if (marker) {
    throw new Error(`Account execution is quarantined by unresolved lease marker for ${marker.owner}; reconcile before retry`);
  }
}

function inspectGuards(paths: string[]): DescriptorObservation[] {
  const observations = paths.map(inspectGuardDescriptor);
  const live = observations.filter(observation => observation.state === "live");
  if (live.length > 0) {
    throw new Error(`Account execution blocked by live BrowserHost descriptor: ${live.map(item => item.path).join(", ")}`);
  }
  return observations;
}

function writeStartingMarker(path: string, owner: string): UnresolvedMarker {
  const marker: UnresolvedMarker = {
    version: 1,
    state: "starting",
    owner,
    routePid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(marker)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return marker;
}

function markCommandRunning(path: string, marker: UnresolvedMarker, commandPid: number): void {
  if (marker.state !== "starting" || !Number.isInteger(commandPid) || commandPid < 1) {
    throw new Error("Account lease command PID is invalid");
  }
  const running: UnresolvedMarker = { ...marker, state: "running", commandPid };
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${JSON.stringify(running)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertCurrentProcessHoldsLease(lockPath: string): void {
  if (!existsSync(lockPath)) {
    throw new Error("Internal held mode requires this process to own the exact account execution lease");
  }
  assertOwnerOnlyRegularFile(lockPath, "Account lease file");
  const result = Bun.spawnSync([
    DEFAULT_LSLOCKS,
    "--json",
    "--pid", String(process.pid),
    "--output", "PID,TYPE,MODE,PATH",
  ], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Could not verify inherited account execution lease");
  let rows: unknown;
  try { rows = JSON.parse(result.stdout.toString("utf8")).locks; }
  catch { throw new Error("Account execution lease inspection returned invalid JSON"); }
  const expected = realpathSync(lockPath);
  const held = Array.isArray(rows) && rows.some(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    if (row.pid !== process.pid || row.type !== "FLOCK" || row.mode !== "WRITE" || typeof row.path !== "string") return false;
    try { return realpathSync(row.path) === expected; } catch { return false; }
  });
  if (!held) throw new Error("Internal held mode requires this process to own the exact account execution lease");
}

async function runHeld(options: Options): Promise<number> {
  assertCurrentProcessHoldsLease(options.lockPath);
  if (options.reconcileOnly) {
    const marker = readUnresolvedMarker(options.markerPath);
    const guards = inspectGuards(options.guardDescriptors);
    if (marker?.state === "starting") {
      throw new Error("Account lease stopped during command start; automatic reconciliation is unsafe");
    }
    if (marker && (processRunning(marker.routePid) || processRunning(marker.commandPid))) {
      throw new Error("Account lease route or command process is still running; reconciliation is unsafe");
    }
    if (marker) rmSync(options.markerPath);
    process.stdout.write(`${JSON.stringify({
      status: marker ? "reconciled" : "already-clear",
      owner: options.owner,
      ...(marker ? { previousOwner: marker.owner } : {}),
      guards,
    })}\n`);
    return 0;
  }
  assertNoUnresolvedMarker(options.markerPath);
  const before = inspectGuards(options.guardDescriptors);
  if (options.checkOnly) {
    process.stdout.write(`${JSON.stringify({ status: "available", owner: options.owner, guards: before })}\n`);
    return 0;
  }

  const marker = writeStartingMarker(options.markerPath, options.owner);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let childExited = false;
  const forward = (signal: NodeJS.Signals) => {
    if (child && !childExited) child.kill(signal);
  };
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    child = Bun.spawn(options.command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
    markCommandRunning(options.markerPath, marker, child.pid);
    const exitCode = await child.exited;
    childExited = true;
    inspectGuards(options.guardDescriptors);
    rmSync(options.markerPath);
    return exitCode;
  } catch (error) {
    // A child may exist before its PID is durably promoted into the marker. Never clear that
    // ambiguity merely because the BrowserHost descriptor has not materialized yet.
    const commandStillLive = child !== undefined && !childExited && processRunning(child.pid);
    if (!commandStillLive) {
      try {
        inspectGuards(options.guardDescriptors);
        rmSync(options.markerPath, { force: true });
      } catch {}
    }
    throw error;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

function heldArgs(options: Options): string[] {
  return [
    "--held",
    "--owner", options.owner,
    "--lock", options.lockPath,
    "--marker", options.markerPath,
    ...(options.testOverrides ? ["--test-overrides"] : []),
    ...options.guardDescriptors
      .filter(path => options.testOverrides || !canonicalGuardDescriptors().includes(path))
      .flatMap(path => ["--guard-descriptor", path]),
    ...(options.checkOnly ? ["--check"]
      : options.reconcileOnly ? ["--reconcile"]
        : ["--", ...options.command]),
  ];
}

async function main(): Promise<void> {
  assertDreamBookLinux();
  const options = parseArgs(process.argv.slice(2));
  if (options.held) {
    process.exitCode = await runHeld(options);
    return;
  }
  prepareLockFile(options.lockPath);
  const flock = Bun.spawn([
    DEFAULT_FLOCK,
    "--nonblock",
    "--no-fork",
    "--conflict-exit-code", String(LOCK_CONFLICT_EXIT),
    options.lockPath,
    process.execPath,
    import.meta.path,
    ...heldArgs(options),
  ], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
  let flockExited = false;
  const forward = (signal: NodeJS.Signals) => {
    if (!flockExited) flock.kill(signal);
  };
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let code: number;
  try {
    code = await flock.exited;
    flockExited = true;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  if (code === LOCK_CONFLICT_EXIT) {
    throw new Error("Account execution lease is already held by another routed BrowserHost owner");
  }
  process.exitCode = code;
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`dreambook-account-browser-lease: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
