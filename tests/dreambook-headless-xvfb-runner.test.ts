import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const runner = join(root, "scripts", "dreambook-headless-xvfb-runner.ts");

const liveXvfb = process.platform === "linux"
  && existsSync("/usr/bin/Xvfb")
  && existsSync("/usr/bin/xauth")
  && existsSync("/usr/bin/mcookie");

test("DreamBook headless runner forwards SIGTERM and waits for its command", async () => {
  if (!liveXvfb) return;
  const scratch = mkdtempSync(join(tmpdir(), "dreambook-headless-runner-test-"));
  const marker = join(scratch, "marker.txt");
  try {
    const child = Bun.spawn([
      process.execPath,
      runner,
      "--",
      "/bin/sh",
      "-c",
      `trap 'printf term >> ${JSON.stringify(marker)}; exit 0' TERM; printf ready > ${JSON.stringify(marker)}; while :; do sleep 1; done`,
    ], { stdout: "pipe", stderr: "pipe" });
    const deadline = Date.now() + 10_000;
    while ((!existsSync(marker) || readFileSync(marker, "utf8") !== "ready") && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(existsSync(marker)).toBeTrue();
    expect(readFileSync(marker, "utf8")).toBe("ready");
    child.kill("SIGTERM");
    const exit = await Promise.race([
      child.exited,
      Bun.sleep(10_000).then(() => -999),
    ]);
    expect(exit).not.toBe(-999);
    expect(readFileSync(marker, "utf8")).toContain("term");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 20_000);
