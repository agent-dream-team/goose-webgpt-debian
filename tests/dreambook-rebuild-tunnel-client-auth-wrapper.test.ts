import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ROOTS: string[] = [];
const WRAPPER = join(import.meta.dir, "..", "scripts", "dreambook-rebuild-tunnel-client-auth-wrapper.sh");
const SECRET = `Bearer ${"qualification-secret-".repeat(3)}`;

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "cgw-tunnel-wrapper-test-"));
  ROOTS.push(path);
  return path;
}

afterEach(() => {
  while (ROOTS.length > 0) rmSync(ROOTS.pop()!, { recursive: true, force: true });
});

function fixture(base: string): { real: string; auth: string; capture: string } {
  const real = join(base, "tunnel-client.real");
  const auth = join(base, "connector-authorization.txt");
  const capture = join(base, "capture.json");
  writeFileSync(auth, `${SECRET}\n`, { mode: 0o600 });
  chmodSync(auth, 0o600);
  writeFileSync(real, `#!/usr/bin/env bash\nset -euo pipefail\npython3 - "$CGW_TEST_CAPTURE" "$@" <<'PY'\nimport hashlib,json,os,sys\nout=sys.argv[1]\nargs=sys.argv[2:]\nvalue=os.environ.get("CGW_REBUILD_CONNECTOR_AUTHORIZATION", "")\nwith open(out,"w") as f:\n    json.dump({"args":args,"authorizationSha256":hashlib.sha256(value.encode()).hexdigest()},f)\nPY\n`, { mode: 0o755 });
  chmodSync(real, 0o755);
  return { real, auth, capture };
}

async function run(input: {
  real?: string;
  auth?: string;
  capture?: string;
  testing?: boolean;
  args?: string[];
  extraEnv?: Record<string, string>;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, ...input.extraEnv } as Record<string, string>;
  if (input.real !== undefined) env.CGW_REBUILD_TUNNEL_CLIENT_REAL = input.real;
  if (input.auth !== undefined) env.CGW_REBUILD_CONNECTOR_AUTHORIZATION_FILE = input.auth;
  if (input.capture !== undefined) env.CGW_TEST_CAPTURE = input.capture;
  if (input.testing) env.CGW_REBUILD_TUNNEL_WRAPPER_TESTING = "1";
  const child = Bun.spawn([WRAPPER, ...(input.args ?? [])], { stdout: "pipe", stderr: "pipe", env });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("forwards caller args and injects request plus discovery auth through environment indirection", async () => {
  const base = root();
  const { real, auth, capture } = fixture(base);
  const callerArgs = ["run", "--profile-dir", "/safe/profile", "--profile", "rebuild"];
  const result = await run({ real, auth, capture, testing: true, args: callerArgs });
  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  const captured = JSON.parse(await Bun.file(capture).text()) as { args: string[]; authorizationSha256: string };
  expect(captured.args).toEqual([
    ...callerArgs,
    "--mcp.extra-headers",
    "Authorization: env:CGW_REBUILD_CONNECTOR_AUTHORIZATION",
    "--mcp.discovery-extra-headers",
    "Authorization: env:CGW_REBUILD_CONNECTOR_AUTHORIZATION",
  ]);
  expect(captured.authorizationSha256).toBe(createHash("sha256").update(SECRET).digest("hex"));
  expect(JSON.stringify(captured.args)).not.toContain(SECRET);
  expect(result.stdout).not.toContain(SECRET);
  expect(result.stderr).not.toContain(SECRET);
});

test("production invocation follows CODEX_CHATGPT_WEB_HOME without test-only path overrides", async () => {
  const base = root();
  const appHome = join(base, "rebuild-home");
  const tunnelDir = join(appHome, "tunnel");
  const secretsDir = join(appHome, "secrets");
  mkdirSync(tunnelDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  const real = join(tunnelDir, "tunnel-client");
  const auth = join(secretsDir, "connector-authorization.txt");
  const capture = join(base, "capture.json");
  writeFileSync(auth, `${SECRET}\n`, { mode: 0o600 });
  chmodSync(auth, 0o600);
  writeFileSync(real, `#!/usr/bin/env bash\nset -euo pipefail\npython3 - "$CGW_TEST_CAPTURE" "$@" <<'PY'\nimport json,os,sys\nwith open(sys.argv[1],"w") as f:\n    json.dump({"args":sys.argv[2:],"authorization":os.environ.get("CGW_REBUILD_CONNECTOR_AUTHORIZATION", "")},f)\nPY\n`, { mode: 0o755 });
  chmodSync(real, 0o755);

  const result = await run({
    capture,
    args: ["run", "--profile", "rebuild"],
    extraEnv: { CODEX_CHATGPT_WEB_HOME: appHome },
  });
  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  const captured = JSON.parse(await Bun.file(capture).text()) as { args: string[]; authorization: string };
  expect(captured.authorization).toBe(SECRET);
  expect(captured.args).toContain("Authorization: env:CGW_REBUILD_CONNECTOR_AUTHORIZATION");
});

test("test path overrides cannot silently alter a normal invocation", async () => {
  const base = root();
  const { real, auth, capture } = fixture(base);
  const result = await run({ real, auth, capture, args: ["--version"] });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("path overrides require CGW_REBUILD_TUNNEL_WRAPPER_TESTING=1");
  expect(await Bun.file(capture).exists()).toBe(false);
  expect(result.stderr).not.toContain(SECRET);
});

test("fails closed for missing or unsafe connector authorization files", async () => {
  const base = root();
  const { real, auth, capture } = fixture(base);

  rmSync(auth);
  const missing = await run({ real, auth, capture, testing: true });
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("authorization file is missing");

  writeFileSync(auth, `${SECRET}\n`, { mode: 0o644 });
  chmodSync(auth, 0o644);
  const unsafe = await run({ real, auth, capture, testing: true });
  expect(unsafe.code).toBe(1);
  expect(unsafe.stderr).toContain("mode 0600");

  const target = join(base, "actual-auth.txt");
  writeFileSync(target, `${SECRET}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  rmSync(auth);
  symlinkSync(target, auth);
  const symlink = await run({ real, auth, capture, testing: true });
  expect(symlink.code).toBe(1);
  expect(symlink.stderr).toContain("symlinked");
  expect(`${missing.stderr}${unsafe.stderr}${symlink.stderr}`).not.toContain(SECRET);
});

test("rejects malformed authorization content before executing tunnel-client", async () => {
  const base = root();
  const { real, auth, capture } = fixture(base);
  writeFileSync(auth, "not-a-bearer\n", { mode: 0o600 });
  chmodSync(auth, 0o600);
  const result = await run({ real, auth, capture, testing: true });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("invalid content");
  expect(await Bun.file(capture).exists()).toBe(false);
});

test("fails closed when the exact tunnel-client binary is missing or symlinked", async () => {
  const base = root();
  const { real, auth, capture } = fixture(base);
  rmSync(real);
  const missing = await run({ real, auth, capture, testing: true });
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("real tunnel-client is missing");

  const target = join(base, "actual-real");
  writeFileSync(target, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(target, 0o755);
  symlinkSync(target, real);
  const symlink = await run({ real, auth, capture, testing: true });
  expect(symlink.code).toBe(1);
  expect(symlink.stderr).toContain("symlinked");
});

test("test overrides must remain absolute", async () => {
  const base = root();
  const { auth, capture } = fixture(base);
  const result = await run({ real: "relative-tunnel-client", auth, capture, testing: true });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("tunnel-client path must be absolute");
});
