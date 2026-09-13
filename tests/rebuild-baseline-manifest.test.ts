import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildRebuildBaselineManifest,
  encodeRebuildBaselineManifest,
  REBUILD_GATE_B_BASELINE,
  REBUILD_UPSTREAM_BASELINE,
} from "../scripts/rebuild-baseline-manifest";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

test("committed rebuild manifest matches the exact tracked Git-object baseline", () => {
  const root = resolve(import.meta.dir, "..");
  const manifest = buildRebuildBaselineManifest(root);
  expect(manifest.upstream.commit).toBe(REBUILD_UPSTREAM_BASELINE);
  expect(manifest.rebuildBaseline.commit).toBe(REBUILD_GATE_B_BASELINE);
  expect(manifest.rebuildBaseline.tree).toBe("698c4a57740d244aae007520fab84233c37f4098");
  expect(manifest.evidenceBoundary).toMatchObject({
    source: "git-tracked-objects-only",
    excludesUntrackedFiles: true,
    excludesBrowserProfilesAndRuntimeData: true,
    claimsWholeBrowserProfileEquality: false,
  });
  expect(manifest.trackedDeltaFromUpstream.map(entry => entry.path)).toEqual([
    "AGENTS.md",
    "docs/persistent-chat-rebuild-plan.md",
    "package.json",
    "scripts/qualify-goose-responses-wire.ts",
    "src/session-broker.ts",
    "tests/goose-responses-wire-qualification.test.ts",
    "tests/session-broker.test.ts",
  ]);
  expect(readFileSync(join(root, "docs/rebuild-baseline-manifest.json"), "utf8"))
    .toBe(encodeRebuildBaselineManifest(manifest));
});

test("manifest construction ignores untracked working-tree secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-baseline-manifest-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "tracked.txt"), "baseline\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "baseline");
  const upstream = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "tracked.txt"), "rebuild\n");
  git(root, "commit", "-qam", "rebuild");
  const rebuild = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "UNTRACKED_SECRET.key"), "SECRET_MUST_NOT_APPEAR\n");

  const encoded = encodeRebuildBaselineManifest(buildRebuildBaselineManifest(root, upstream, rebuild, "test"));
  expect(encoded).not.toContain("UNTRACKED_SECRET");
  expect(encoded).not.toContain("SECRET_MUST_NOT_APPEAR");
  expect(encoded).toContain("tracked.txt");
});
