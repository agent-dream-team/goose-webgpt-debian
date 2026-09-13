import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOTS: string[] = [];
const SCRIPT = join(import.meta.dir, "..", "scripts", "dreambook-account-browser-lease.ts");
const BUN = process.execPath;
const TEST_ENV = { ...process.env, CGW_DREAMBOOK_ACCOUNT_LEASE_TESTING: "1" };

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "cgw-account-lease-test-"));
  ROOTS.push(path);
  return path;
}

afterEach(() => {
  while (ROOTS.length > 0) rmSync(ROOTS.pop()!, { recursive: true, force: true });
});

function descriptor(path: string, pid: number): void {
  writeFileSync(path, `${JSON.stringify({ version: 3, kind: "codex-web-gpt-launcher", pid })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function args(base: string, owner: string, guards: string[] = [], command: string[] = [BUN, "-e", "process.exit(0)"]): string[] {
  return [
    BUN, SCRIPT,
    "--owner", `test-${owner}`,
    "--test-overrides",
    "--lock", join(base, "account.lock"),
    "--marker", join(base, "account.owner.json"),
    ...guards.flatMap(path => ["--guard-descriptor", path]),
    "--",
    ...command,
  ];
}

function checkArgs(base: string, owner: string, guards: string[] = []): string[] {
  return [
    BUN, SCRIPT,
    "--owner", `test-${owner}`,
    "--test-overrides",
    "--lock", join(base, "account.lock"),
    "--marker", join(base, "account.owner.json"),
    ...guards.flatMap(path => ["--guard-descriptor", path]),
    "--check",
  ];
}

function reconcileArgs(base: string, owner: string, guards: string[] = []): string[] {
  return [
    BUN, SCRIPT,
    "--owner", `test-${owner}`,
    "--test-overrides",
    "--lock", join(base, "account.lock"),
    "--marker", join(base, "account.owner.json"),
    ...guards.flatMap(path => ["--guard-descriptor", path]),
    "--reconcile",
  ];
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: TEST_ENV });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(20);
  }
  throw new Error(`file did not appear: ${path}`);
}

test("internal held mode cannot be invoked without owning the exact kernel lease", async () => {
  const base = root();
  const argv = args(base, "rebuild");
  argv.splice(2, 0, "--held");
  const result = await run(argv);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("requires this process to own the exact account execution lease");
});

test("testing environment alone cannot silently weaken a normal owner invocation", async () => {
  const base = root();
  const argv = [BUN, SCRIPT, "--owner", "rebuild", "--test-overrides", "--lock", join(base, "account.lock"), "--", BUN, "-e", "process.exit(0)"];
  const result = await run(argv);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("requires CGW_DREAMBOOK_ACCOUNT_LEASE_TESTING=1 and a test-* owner");
});

test("only one routed BrowserHost owner may hold the account lease", async () => {
  const base = root();
  const marker = join(base, "account.owner.json");
  const first = Bun.spawn(args(base, "rebuild", [], [BUN, "-e", "setTimeout(()=>{}, 10000)"]), {
    stdout: "pipe", stderr: "pipe", env: TEST_ENV,
  });
  await waitForFile(marker);
  const second = await run(args(base, "legacy"));
  expect(second.code).toBe(1);
  expect(second.stderr).toContain("already held by another routed BrowserHost owner");
  first.kill("SIGTERM");
  await first.exited;
  expect((await run(args(base, "legacy"))).code).toBe(0);
});

test("a live peer BrowserHost descriptor blocks before the command executes", async () => {
  const base = root();
  const peer = join(base, "peer.json");
  const sideEffect = join(base, "ran.txt");
  descriptor(peer, process.pid);
  const result = await run(args(base, "rebuild", [peer], [BUN, "-e", `require('fs').writeFileSync(${JSON.stringify(sideEffect)},'ran')`]));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("live BrowserHost descriptor");
  expect(await Bun.file(sideEffect).exists()).toBe(false);
  expect(await Bun.file(join(base, "account.owner.json")).exists()).toBe(false);
});

test("a well-formed stale peer descriptor does not block routed execution", async () => {
  const base = root();
  const peer = join(base, "peer.json");
  descriptor(peer, 2_000_000_000);
  const result = await run(args(base, "rebuild", [peer]));
  expect(result.code).toBe(0);
});

test("a malformed or permission-unsafe peer descriptor fails closed", async () => {
  const base = root();
  const malformed = join(base, "malformed.json");
  writeFileSync(malformed, "not-json\n", { mode: 0o600 });
  const badJson = await run(args(base, "rebuild", [malformed]));
  expect(badJson.code).toBe(1);
  expect(badJson.stderr).toContain("invalid JSON");

  const unsafe = join(base, "unsafe.json");
  descriptor(unsafe, 2_000_000_000);
  chmodSync(unsafe, 0o644);
  const badMode = await run(args(base, "rebuild", [unsafe]));
  expect(badMode.code).toBe(1);
  expect(badMode.stderr).toContain("permissions are unsafe");
});

test("check mode uses the same lease and reports only positively quiescent guards", async () => {
  const base = root();
  const stale = join(base, "stale.json");
  descriptor(stale, 2_000_000_000);
  const available = await run(checkArgs(base, "rebuild", [stale]));
  expect(available.code).toBe(0);
  expect(JSON.parse(available.stdout)).toMatchObject({
    status: "available",
    owner: "test-rebuild",
    guards: [{ path: stale, state: "stale" }],
  });

  const marker = join(base, "account.owner.json");
  const first = Bun.spawn(args(base, "rebuild", [], [BUN, "-e", "setTimeout(()=>{}, 10000)"]), {
    stdout: "pipe", stderr: "pipe", env: TEST_ENV,
  });
  await waitForFile(marker);
  const blocked = await run(checkArgs(base, "legacy"));
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toContain("already held by another routed BrowserHost owner");
  first.kill("SIGTERM");
  await first.exited;
});

test("normal command exit releases the kernel lease and clears the marker", async () => {
  const base = root();
  expect((await run(args(base, "rebuild"))).code).toBe(0);
  expect(await Bun.file(join(base, "account.owner.json")).exists()).toBe(false);
  expect((await run(args(base, "legacy"))).code).toBe(0);
});

test("SIGTERM to the outer route propagates through held mode to the command and clears state", async () => {
  const base = root();
  const marker = join(base, "account.owner.json");
  const childPidPath = join(base, "outer-term-child.pid");
  const observed = join(base, "outer-term-observed.txt");
  const command = ["/bin/sh", "-c", `echo $$ > ${JSON.stringify(childPidPath)}; trap 'echo TERM > ${observed}; exit 0' TERM; while :; do sleep 1; done`];
  const outer = Bun.spawn(args(base, "rebuild", [], command), { stdout: "pipe", stderr: "pipe", env: TEST_ENV });
  await waitForFile(marker);
  await waitForFile(childPidPath);
  outer.kill("SIGTERM");
  expect(await outer.exited).toBe(0);
  await waitForFile(observed);
  expect((await Bun.file(observed).text()).trim()).toBe("TERM");
  expect(await Bun.file(marker).exists()).toBe(false);
  expect((await run(args(base, "legacy"))).code).toBe(0);
});

test("terminating the leased command releases enough state for the next routed owner", async () => {
  const base = root();
  const childPid = join(base, "child.pid");
  const marker = join(base, "account.owner.json");
  const command = ["/bin/sh", "-c", `echo $$ > ${JSON.stringify(childPid)}; trap 'exit 0' TERM INT; while :; do sleep 1; done`];
  const routed = Bun.spawn(args(base, "rebuild", [], command), { stdout: "pipe", stderr: "pipe", env: TEST_ENV });
  await waitForFile(marker);
  await waitForFile(childPid);
  const pid = Number((await Bun.file(childPid).text()).trim());
  process.kill(pid, "SIGTERM");
  expect(await routed.exited).toBe(0);
  expect(await Bun.file(marker).exists()).toBe(false);
  expect((await run(args(base, "legacy"))).code).toBe(0);
});

test("owner-neutral lease serializes two routed appliance labels", async () => {
  const base = root();
  const order = join(base, "order.txt");
  const write = (name: string) => ["/bin/sh", "-c", `printf '%s\\n' ${JSON.stringify(name)} >> ${JSON.stringify(order)}`];
  expect((await run(args(base, "rebuild", [], write("rebuild")))).code).toBe(0);
  expect((await run(args(base, "legacy", [], write("legacy")))).code).toBe(0);
  expect(await Bun.file(order).text()).toBe("rebuild\nlegacy\n");
});

test("hard loss of the outer route never authorizes a second owner", async () => {
  const base = root();
  const childPidPath = join(base, "hard-loss-child.pid");
  const marker = join(base, "account.owner.json");
  const command = ["/bin/sh", "-c", `echo $$ > ${JSON.stringify(childPidPath)}; trap 'exit 0' TERM INT; while :; do sleep 1; done`];
  const outer = Bun.spawn(args(base, "rebuild", [], command), { stdout: "pipe", stderr: "pipe", env: TEST_ENV });
  await waitForFile(marker);
  await waitForFile(childPidPath);
  const childPid = Number((await Bun.file(childPidPath).text()).trim());
  outer.kill("SIGKILL");
  await outer.exited;

  const blocked = await run(args(base, "legacy"));
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toMatch(/already held|quarantined by unresolved lease marker/);

  process.kill(childPid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && await Bun.file(marker).exists()) await Bun.sleep(20);
  expect(await Bun.file(marker).exists()).toBe(false);
  expect((await run(args(base, "legacy"))).code).toBe(0);
});

test("hard loss of the lock-owning held process quarantines a surviving command until explicit reconciliation", async () => {
  const base = root();
  const markerPath = join(base, "account.owner.json");
  const command = ["/bin/sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done"];
  const outer = Bun.spawn(args(base, "rebuild", [], command), { stdout: "pipe", stderr: "pipe", env: TEST_ENV });
  await waitForFile(markerPath);
  let marker = JSON.parse(await Bun.file(markerPath).text()) as { state: string; routePid: number; commandPid?: number };
  const deadline = Date.now() + 2_000;
  while (marker.state !== "running" && Date.now() < deadline) {
    await Bun.sleep(20);
    marker = JSON.parse(await Bun.file(markerPath).text());
  }
  expect(marker.state).toBe("running");
  expect(marker.commandPid).toBeGreaterThan(0);

  process.kill(marker.routePid, "SIGKILL");
  await outer.exited;
  expect(process.kill(marker.commandPid!, 0)).toBe(true);
  const blocked = await run(args(base, "legacy"));
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toContain("quarantined by unresolved lease marker");

  process.kill(marker.commandPid!, "SIGTERM");
  const deadDeadline = Date.now() + 3_000;
  while (Date.now() < deadDeadline) {
    try { process.kill(marker.commandPid!, 0); await Bun.sleep(20); }
    catch { break; }
  }
  expect(await Bun.file(markerPath).exists()).toBe(true);
  const reconciled = await run(reconcileArgs(base, "legacy"));
  expect(reconciled.code).toBe(0);
  expect(JSON.parse(reconciled.stdout).status).toBe("reconciled");
  expect((await run(args(base, "legacy"))).code).toBe(0);
});

test("unresolved quarantine clears only through locked positive peer reconciliation", async () => {
  const base = root();
  const marker = join(base, "account.owner.json");
  const peer = join(base, "peer.json");
  writeFileSync(marker, `${JSON.stringify({
    version: 1, state: "running", owner: "test-rebuild", routePid: 2_000_000_000, commandPid: 2_000_000_001,
    startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const blocked = await run(args(base, "legacy", [peer]));
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toContain("quarantined by unresolved lease marker");

  writeFileSync(marker, `${JSON.stringify({
    version: 1, state: "starting", owner: "test-rebuild", routePid: 2_000_000_000, startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const startingReconcile = await run(reconcileArgs(base, "legacy", [peer]));
  expect(startingReconcile.code).toBe(1);
  expect(startingReconcile.stderr).toContain("automatic reconciliation is unsafe");
  expect(await Bun.file(marker).exists()).toBe(true);

  writeFileSync(marker, `${JSON.stringify({
    version: 1, state: "running", owner: "test-rebuild", routePid: 2_000_000_000, commandPid: process.pid,
    startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const commandLiveReconcile = await run(reconcileArgs(base, "legacy", [peer]));
  expect(commandLiveReconcile.code).toBe(1);
  expect(commandLiveReconcile.stderr).toContain("process is still running");
  expect(await Bun.file(marker).exists()).toBe(true);

  writeFileSync(marker, `${JSON.stringify({
    version: 1, state: "running", owner: "test-rebuild", routePid: 2_000_000_000, commandPid: 2_000_000_001,
    startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  descriptor(peer, process.pid);
  const liveReconcile = await run(reconcileArgs(base, "legacy", [peer]));
  expect(liveReconcile.code).toBe(1);
  expect(liveReconcile.stderr).toContain("live BrowserHost descriptor");
  expect(await Bun.file(marker).exists()).toBe(true);

  descriptor(peer, 2_000_000_000);
  const reconciled = await run(reconcileArgs(base, "legacy", [peer]));
  expect(reconciled.code).toBe(0);
  expect(JSON.parse(reconciled.stdout)).toMatchObject({
    status: "reconciled", owner: "test-legacy", previousOwner: "test-rebuild",
    guards: [{ path: peer, state: "stale" }],
  });
  expect(await Bun.file(marker).exists()).toBe(false);
  expect((await run(args(base, "legacy", [peer]))).code).toBe(0);
});
