#!/usr/bin/env bun
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRunning } from "../src/process";

const XVFB = "/usr/bin/Xvfb";
const XAUTH = "/usr/bin/xauth";
const MCOOKIE = "/usr/bin/mcookie";
const FIRST_DISPLAY = 99;
const LAST_DISPLAY = 199;
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

function requireExecutable(path: string, label: string): void {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}

function commandAfterSeparator(argv: string[]): string[] {
  // Bun consumes the conventional `--` separator before exposing process.argv when a script is
  // invoked as `bun script.js -- COMMAND`. Keep accepting an explicit separator as well so the
  // bundled runner has one stable command contract under either invocation form.
  const separator = argv.indexOf("--");
  const command = separator >= 0 ? argv.slice(separator + 1) : argv;
  if (command.length === 0) {
    throw new Error("Usage: dreambook-headless-xvfb-runner -- COMMAND [ARG...]");
  }
  return command;
}

function displayAvailable(display: number): boolean {
  return !existsSync(`/tmp/.X${display}-lock`) && !existsSync(`/tmp/.X11-unix/X${display}`);
}

function cookie(): string {
  const result = Bun.spawnSync([MCOOKIE], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`mcookie failed: ${result.stderr.toString("utf8").trim()}`);
  const value = result.stdout.toString("utf8").trim();
  if (!/^[A-Fa-f0-9]{16,}$/.test(value)) throw new Error("mcookie returned an invalid cookie");
  return value;
}

function authorize(authFile: string, display: number, value: string): void {
  const result = Bun.spawnSync([XAUTH, "-f", authFile, "add", `:${display}`, ".", value], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`xauth failed: ${result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim()}`);
  }
}

async function waitForDisplaySocket(process: ReturnType<typeof Bun.spawn>, display: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const socket = `/tmp/.X11-unix/X${display}`;
  while (Date.now() < deadline) {
    if (!processRunning(process.pid)) throw new Error(`Xvfb :${display} exited before becoming ready`);
    if (existsSync(socket)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Xvfb :${display} did not become ready within ${READY_TIMEOUT_MS} ms`);
}

async function stopProcess(child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!processRunning(child.pid)) return;
  child.kill(signal);
  const stopped = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!stopped && processRunning(child.pid)) {
    child.kill("SIGKILL");
    await child.exited.catch(() => {});
  }
}

export async function runDreamBookHeadless(command: string[]): Promise<number> {
  if (process.platform !== "linux") throw new Error("DreamBook headless launcher is Linux-only");
  if (command.length === 0) throw new Error("DreamBook headless launcher requires a command");
  requireExecutable(XVFB, "Xvfb");
  requireExecutable(XAUTH, "xauth");
  requireExecutable(MCOOKIE, "mcookie");

  const scratch = mkdtempSync(join(process.env.XDG_RUNTIME_DIR?.trim() || tmpdir(), "goose-chatgpt-web-xvfb-"));
  chmodSync(scratch, 0o700);
  const authFile = join(scratch, "Xauthority");
  writeFileSync(authFile, "", { mode: 0o600 });

  let xvfb: ReturnType<typeof Bun.spawn> | undefined;
  let display = 0;
  try {
    for (let candidate = FIRST_DISPLAY; candidate <= LAST_DISPLAY; candidate += 1) {
      if (!displayAvailable(candidate)) continue;
      authorize(authFile, candidate, cookie());
      const candidateProcess = Bun.spawn([
        XVFB,
        `:${candidate}`,
        "-screen", "0", "1280x1024x24",
        "-nolisten", "tcp",
        "-auth", authFile,
      ], { stdin: "ignore", stdout: "ignore", stderr: "inherit", env: process.env });
      try {
        await waitForDisplaySocket(candidateProcess, candidate);
        xvfb = candidateProcess;
        display = candidate;
        break;
      } catch {
        await stopProcess(candidateProcess).catch(() => {});
      }
    }
    if (!xvfb || display === 0) throw new Error("No available Xvfb display could be started");

    let child: ReturnType<typeof Bun.spawn> | undefined;
    let pendingSignal: NodeJS.Signals | undefined;
    const forward = (signal: NodeJS.Signals) => {
      pendingSignal = signal;
      if (child && processRunning(child.pid)) child.kill(signal);
    };
    const onTerm = () => forward("SIGTERM");
    const onInt = () => forward("SIGINT");
    const onHup = () => forward("SIGHUP");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    process.on("SIGHUP", onHup);
    try {
      child = Bun.spawn(command, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, DISPLAY: `:${display}`, XAUTHORITY: authFile },
      });
      if (pendingSignal && processRunning(child.pid)) child.kill(pendingSignal);
      const outcome = await Promise.race([
        child.exited.then(code => ({ kind: "child" as const, code })),
        xvfb.exited.then(code => ({ kind: "xvfb" as const, code })),
      ]);
      if (outcome.kind === "xvfb") {
        await stopProcess(child).catch(() => {});
        throw new Error(`Xvfb :${display} exited before the launcher (code ${outcome.code})`);
      }
      return outcome.code;
    } finally {
      if (child && processRunning(child.pid)) await stopProcess(child).catch(() => {});
      // Keep our signal handlers installed until Xvfb is also gone. A late TERM/INT/HUP during
      // cleanup must not restore the default process termination path and strand the X server.
      if (xvfb) {
        await stopProcess(xvfb).catch(() => {});
        xvfb = undefined;
      }
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      process.off("SIGHUP", onHup);
    }
  } finally {
    if (xvfb) await stopProcess(xvfb).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runDreamBookHeadless(commandAfterSeparator(process.argv.slice(2)))
    .then(code => { process.exitCode = code; })
    .catch(error => {
      process.stderr.write(`dreambook-headless-xvfb-runner: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
