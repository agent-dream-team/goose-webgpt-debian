import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const helperOutput = resolve(process.argv[2] ?? join(root, ".launcher-runtime", "browser-helper.cjs"));
const workerOutput = resolve(process.argv[3] ?? join(dirname(helperOutput), "rebuild-node-browser-worker.mjs"));
mkdirSync(dirname(helperOutput), { recursive: true });
mkdirSync(dirname(workerOutput), { recursive: true });
for (const output of [helperOutput, workerOutput]) rmSync(output, { force: true });

const helperBuild = await Bun.build({
  entrypoints: [join(root, "src", "adapters", "chatgpt-web", "browser-helper-main.ts")],
  target: "node",
  format: "cjs",
  minify: true,
  packages: "external",
  external: ["playwright-core"],
  outdir: dirname(helperOutput),
  naming: basename(helperOutput),
});
if (!helperBuild.success) throw new Error(`Browser helper build failed: ${helperBuild.logs.map(log => log.message).join("; ")}`);

const workerBuild = await Bun.build({
  entrypoints: [join(root, "src", "rebuild-node-browser-worker.ts")],
  target: "node",
  format: "esm",
  minify: true,
  packages: "external",
  external: ["playwright-core"],
  outdir: dirname(workerOutput),
  naming: basename(workerOutput),
});
if (!workerBuild.success) throw new Error(`Rebuild browser worker build failed: ${workerBuild.logs.map(log => log.message).join("; ")}`);

if (process.platform !== "win32") {
  chmodSync(helperOutput, 0o755);
  chmodSync(workerOutput, 0o755);
}
process.stdout.write(`${helperOutput}\n${workerOutput}\n`);
