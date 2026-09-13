import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REBUILD_UPSTREAM_BASELINE = "e85e3693fdb4e3e033348c08df0298c20fcdb612";
export const REBUILD_GATE_B_BASELINE = "f4924261ce6ef187a9086096471271fafb169371";
export const REBUILD_BRANCH = "rebuild/persistent-chat-provider";

export interface RebuildBaselineManifest {
  schemaVersion: 1;
  upstream: { commit: string; tree: string };
  rebuildBaseline: { commit: string; tree: string; branch: string };
  trackedDeltaFromUpstream: Array<{ status: string; path: string }>;
  evidenceBoundary: {
    source: "git-tracked-objects-only";
    excludesMutableWorkingTree: true;
    excludesUntrackedFiles: true;
    excludesBrowserProfilesAndRuntimeData: true;
    claimsWholeBrowserProfileEquality: false;
  };
}

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed`);
  return result.stdout.trim();
}

export function buildRebuildBaselineManifest(
  repoRoot: string,
  upstreamRef = REBUILD_UPSTREAM_BASELINE,
  rebuildRef = REBUILD_GATE_B_BASELINE,
  branch = REBUILD_BRANCH,
): RebuildBaselineManifest {
  const upstreamCommit = git(repoRoot, ["rev-parse", `${upstreamRef}^{commit}`]);
  const rebuildCommit = git(repoRoot, ["rev-parse", `${rebuildRef}^{commit}`]);
  const upstreamTree = git(repoRoot, ["rev-parse", `${upstreamCommit}^{tree}`]);
  const rebuildTree = git(repoRoot, ["rev-parse", `${rebuildCommit}^{tree}`]);
  const delta = git(repoRoot, ["diff", "--name-status", "--no-renames", `${upstreamCommit}..${rebuildCommit}`]);
  const trackedDeltaFromUpstream = delta ? delta.split("\n").map(line => {
    const [status, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!status || !path) throw new Error("Unexpected git name-status record");
    return { status, path };
  }) : [];
  return {
    schemaVersion: 1,
    upstream: { commit: upstreamCommit, tree: upstreamTree },
    rebuildBaseline: { commit: rebuildCommit, tree: rebuildTree, branch },
    trackedDeltaFromUpstream,
    evidenceBoundary: {
      source: "git-tracked-objects-only",
      excludesMutableWorkingTree: true,
      excludesUntrackedFiles: true,
      excludesBrowserProfilesAndRuntimeData: true,
      claimsWholeBrowserProfileEquality: false,
    },
  };
}

export function encodeRebuildBaselineManifest(manifest: RebuildBaselineManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const root = resolve(import.meta.dirname, "..");
  const output = resolve(root, "docs/rebuild-baseline-manifest.json");
  const encoded = encodeRebuildBaselineManifest(buildRebuildBaselineManifest(root));
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== encoded) throw new Error("Rebuild baseline manifest is stale");
    process.stdout.write("REBUILD_BASELINE_MANIFEST_OK\n");
  } else {
    writeFileSync(output, encoded, { mode: 0o644 });
    process.stdout.write(`WROTE ${output}\n`);
  }
}
