import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dreamBookInstalledWrapper,
  installedBundleDirectoryName,
  verifyInstalledRuntimeFile,
} from "../scripts/install-dreambook-rebuild-launcher";

test("installed rebuild wrapper has no source-tree dependency and enters the package-owned lease/headless chain", () => {
  const wrapper = dreamBookInstalledWrapper({
    stableWrapper: "/home/example/.local/bin/goose-chatgpt-web",
    bundleRoot: "/home/example/.local/lib/goose-chatgpt-web/5.0.6-linux-x64-bundle",
  });
  expect(wrapper).toContain("GOOSE_CHATGPT_WEB_APPLIANCE=persistent-rebuild");
  expect(wrapper).toContain("CODEX_WEB_GPT_LAUNCHER_SOURCE_PROFILE=production");
  expect(wrapper).toContain("CODEX_WEB_GPT_LAUNCHER_EXECUTABLE='/home/example/.local/bin/goose-chatgpt-web'");
  expect(wrapper).toContain("dreambook-account-browser-lease.js");
  expect(wrapper).toContain("dreambook-headless-xvfb-runner.js");
  expect(wrapper).toContain("run-appimage");
  expect(wrapper).toContain("Goose ChatGPT Web.AppImage");
  expect(wrapper).toContain("dreambook-account-browser-lease.js' --owner rebuild-launcher --");
  expect(wrapper).toMatch(/^exec /m);
  expect(wrapper).not.toContain("/repos/");
  expect(wrapper).not.toContain("/usr/bin/xvfb-run");
});

test("installed bundle directory is immutable across runtime or AppImage changes", () => {
  const manifest = {
    appVersion: "5.0.6", platform: "linux", arch: "x64", bundleId: "a".repeat(64),
  } as const;
  const one = installedBundleDirectoryName(manifest, "1".repeat(64));
  const changedRuntime = installedBundleDirectoryName(
    { ...manifest, bundleId: "b".repeat(64) },
    "1".repeat(64),
  );
  const changedAppImage = installedBundleDirectoryName(manifest, "2".repeat(64));
  expect(one).not.toBe(changedRuntime);
  expect(one).not.toBe(changedAppImage);
  expect(one).toContain("5.0.6-linux-x64-");
  expect(one).toEndWith(`-${"1".repeat(64)}`);
});

test("installed bundle directory rejects an invalid AppImage digest", () => {
  expect(() => installedBundleDirectoryName({
    appVersion: "5.0.6", platform: "linux", arch: "x64", bundleId: "a".repeat(64),
  }, "not-a-sha256")).toThrow("AppImage SHA-256 is invalid");
});

test("installed runtime support is verified against manifest size and SHA-256", () => {
  const root = mkdtempSync(join(tmpdir(), "dreambook-install-verify-"));
  try {
    const file = join(root, "runtime", "bun");
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(file, "package-owned");
    const body = Buffer.from("package-owned");
    const record = {
      path: "runtime/bun",
      size: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    expect(() => verifyInstalledRuntimeFile(file, record)).not.toThrow();
    writeFileSync(file, "changed");
    expect(() => verifyInstalledRuntimeFile(file, record)).toThrow("failed verification");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
