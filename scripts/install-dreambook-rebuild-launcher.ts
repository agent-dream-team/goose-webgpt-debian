#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface RuntimeManifestFile { path: string; size: number; sha256: string }
interface RuntimeManifest {
  schemaVersion: number;
  appVersion: string;
  bundleId: string;
  bunVersion: string;
  platform: string;
  arch: string;
  files: RuntimeManifestFile[];
}

interface InstallOptions { appImage: string; sha256: string }

const SUPPORT_FILES = [
  "runtime/bun",
  "bin/dreambook-account-browser-lease.js",
  "bin/dreambook-headless-xvfb-runner.js",
] as const;

function usage(): never {
  throw new Error("Usage: install-dreambook-rebuild-launcher --appimage /absolute/path.AppImage --sha256 HEX");
}

function parseArgs(argv: string[]): InstallOptions {
  let appImage = "";
  let sha256 = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--appimage") appImage = argv[++index] ?? "";
    else if (arg === "--sha256") sha256 = (argv[++index] ?? "").toLowerCase();
    else usage();
  }
  if (!isAbsolute(appImage)) throw new Error("--appimage must be an absolute path");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("--sha256 must be one SHA-256 digest");
  return { appImage, sha256 };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function installedBundleDirectoryName(
  manifest: Pick<RuntimeManifest, "appVersion" | "platform" | "arch" | "bundleId">,
  appImageSha256: string,
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(manifest.appVersion)) throw new Error("Runtime manifest appVersion is invalid");
  if (manifest.platform !== "linux" || manifest.arch !== "x64") throw new Error("DreamBook launcher requires a Linux x64 runtime manifest");
  if (!/^[a-f0-9]{64}$/.test(manifest.bundleId)) throw new Error("Runtime manifest bundleId is invalid");
  if (!/^[a-f0-9]{64}$/.test(appImageSha256)) throw new Error("AppImage SHA-256 is invalid");
  return `${manifest.appVersion}-${manifest.platform}-${manifest.arch}-${manifest.bundleId}-${appImageSha256}`;
}

export function dreamBookInstalledWrapper(input: {
  stableWrapper: string;
  bundleRoot: string;
}): string {
  const appImage = join(input.bundleRoot, "Goose ChatGPT Web.AppImage");
  const bun = join(input.bundleRoot, "runtime", "bun");
  const lease = join(input.bundleRoot, "bin", "dreambook-account-browser-lease.js");
  const headless = join(input.bundleRoot, "bin", "dreambook-headless-xvfb-runner.js");
  const appImageRunner = join(input.bundleRoot, "bin", "run-appimage");
  return [
    "#!/bin/sh",
    "set -eu",
    "export GOOSE_CHATGPT_WEB_APPLIANCE=persistent-rebuild",
    `export CODEX_CHATGPT_WEB_HOME=${shellQuote(join(homedir(), ".local", "share", "goose-chatgpt-web-rebuild"))}`,
    `export CODEX_WEB_GPT_LAUNCHER_DATA_DIR=${shellQuote(join(homedir(), ".local", "share", "goose-chatgpt-web-rebuild", "launcher"))}`,
    "export CODEX_WEB_GPT_LAUNCHER_SOURCE_PROFILE=production",
    `export CODEX_WEB_GPT_LAUNCHER_EXECUTABLE=${shellQuote(input.stableWrapper)}`,
    `export CODEX_WEB_GPT_APPIMAGE=${shellQuote(appImage)}`,
    `exec ${shellQuote(bun)} ${shellQuote(lease)} --owner rebuild-launcher -- ${shellQuote(bun)} ${shellQuote(headless)} -- ${shellQuote(appImageRunner)} ${shellQuote(appImage)} "$@"`,
    "",
  ].join("\n");
}

function requireManifestFile(runtimeRoot: string, manifest: RuntimeManifest, relativePath: string): string {
  const record = manifest.files.find(file => file.path === relativePath);
  if (!record || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error(`Runtime manifest does not own ${relativePath}`);
  }
  const absolute = join(runtimeRoot, ...relativePath.split("/"));
  const metadata = statSync(absolute, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.size !== record.size || sha256File(absolute) !== record.sha256) {
    throw new Error(`Packaged runtime file failed manifest verification: ${relativePath}`);
  }
  return absolute;
}

function assertInstallDestinationSafe(path: string, root: string): void {
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Installed bundle path escapes its owned root: ${path}`);
  }
}

function installExecutable(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, 0o755);
}

function atomicSymlink(target: string, link: string, allowedRoot: string): void {
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
    const metadata = lstatSync(link);
    if (!metadata.isSymbolicLink()) throw new Error(`Stable launcher path is not an owned symlink: ${link}`);
    const existing = resolve(dirname(link), readlinkSync(link));
    const allowed = realpathSync(allowedRoot);
    let canonicalExisting: string;
    try { canonicalExisting = realpathSync(existing); }
    catch { canonicalExisting = existing; }
    if (canonicalExisting !== allowed && !canonicalExisting.startsWith(`${allowed}${sep}`)) {
      throw new Error(`Stable launcher symlink points outside the owned install root: ${link}`);
    }
  }
  const next = `${link}.next-${process.pid}`;
  rmSync(next, { force: true });
  symlinkSync(target, next);
  renameSync(next, link);
}

export function verifyInstalledRuntimeFile(path: string, record: RuntimeManifestFile): void {
  const metadata = statSync(path, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.size !== record.size || sha256File(path) !== record.sha256) {
    throw new Error(`Installed runtime file failed verification: ${record.path}`);
  }
}

async function install(options: InstallOptions): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("DreamBook rebuild launcher installation requires Linux x64");
  }
  const appMetadata = statSync(options.appImage, { throwIfNoEntry: false });
  if (!appMetadata?.isFile()) throw new Error(`AppImage is missing: ${options.appImage}`);
  const actualAppImageSha = sha256File(options.appImage);
  if (actualAppImageSha !== options.sha256) throw new Error("AppImage SHA-256 does not match --sha256");

  const scratch = mkdtempSync(join(tmpdir(), "goose-chatgpt-web-install-"));
  try {
    const extraction = Bun.spawnSync([options.appImage, "--appimage-extract"], {
      cwd: scratch,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (extraction.exitCode !== 0) {
      throw new Error(`AppImage extraction failed: ${extraction.stderr.toString("utf8").trim()}`);
    }
    const appRoot = join(scratch, "squashfs-root");
    const runtimeRoot = join(appRoot, "resources", "runtime");
    const manifestPath = join(runtimeRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
    if (manifest.schemaVersion !== 2) throw new Error("Packaged runtime manifest schema is unsupported");
    const bundleName = installedBundleDirectoryName(manifest, actualAppImageSha);
    const verifiedSupport = new Map<string, string>();
    for (const relativePath of SUPPORT_FILES) {
      verifiedSupport.set(relativePath, requireManifestFile(runtimeRoot, manifest, relativePath));
    }
    const appImageRunner = join(appRoot, "resources", "app.asar.unpacked", "assets", "linux-appimage-runner.sh");
    if (!statSync(appImageRunner, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("Packaged Linux AppImage runner is missing");
    }

    const libRoot = join(homedir(), ".local", "lib", "goose-chatgpt-web");
    const finalRoot = join(libRoot, bundleName);
    const stageRoot = `${finalRoot}.staging-${process.pid}`;
    assertInstallDestinationSafe(finalRoot, libRoot);
    if (existsSync(finalRoot)) throw new Error(`Installed bundle already exists: ${finalRoot}`);
    rmSync(stageRoot, { recursive: true, force: true });
    mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
    try {
      const installedAppImage = join(stageRoot, "Goose ChatGPT Web.AppImage");
      installExecutable(options.appImage, installedAppImage);
      for (const [relativePath, source] of verifiedSupport) {
        const target = join(stageRoot, ...relativePath.split("/"));
        installExecutable(source, target);
        const record = manifest.files.find(file => file.path === relativePath)!;
        verifyInstalledRuntimeFile(target, record);
      }
      installExecutable(appImageRunner, join(stageRoot, "bin", "run-appimage"));
      const stableWrapper = join(homedir(), ".local", "bin", "goose-chatgpt-web");
      const versionedWrapper = join(stageRoot, "bin", "goose-chatgpt-web");
      writeFileSync(versionedWrapper, dreamBookInstalledWrapper({
        stableWrapper,
        bundleRoot: finalRoot,
      }), { mode: 0o755 });
      chmodSync(versionedWrapper, 0o755);
      writeFileSync(join(stageRoot, "install.json"), `${JSON.stringify({
        schemaVersion: 1,
        appVersion: manifest.appVersion,
        bundleId: manifest.bundleId,
        bunVersion: manifest.bunVersion,
        appImageSha256: actualAppImageSha,
      }, null, 2)}\n`, { mode: 0o600 });
      renameSync(stageRoot, finalRoot);
      atomicSymlink(join(finalRoot, "bin", "goose-chatgpt-web"), stableWrapper, libRoot);
      process.stdout.write(`${JSON.stringify({
        status: "installed",
        stableWrapper,
        bundleRoot: finalRoot,
        appImage: join(finalRoot, "Goose ChatGPT Web.AppImage"),
        appImageSha256: actualAppImageSha,
        bundleId: manifest.bundleId,
        appVersion: manifest.appVersion,
        bunVersion: manifest.bunVersion,
      }, null, 2)}\n`);
    } catch (error) {
      rmSync(stageRoot, { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  install(parseArgs(process.argv.slice(2))).catch(error => {
    process.stderr.write(`install-dreambook-rebuild-launcher: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
