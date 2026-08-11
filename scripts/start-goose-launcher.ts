import { resolve } from "node:path";
import { installedBunExecutable } from "../src/config";
import { gooseLauncherBootstrapEnv } from "../src/goose-launcher-bootstrap";

const root = resolve(import.meta.dir, "..");
const launcher = resolve(root, "launcher");
const bunExecutable = installedBunExecutable();
const bootstrapEnv = gooseLauncherBootstrapEnv(process.env);

const result = Bun.spawnSync([bunExecutable, "run", "dev"], {
  cwd: launcher,
  env: {
    ...process.env,
    ...bootstrapEnv,
    CODEX_WEB_GPT_LAUNCHER_BOOTSTRAP_ONLY: "1",
    CODEX_WEB_GPT_BUN: bunExecutable,
    CODEX_CHATGPT_WEB_BUN: bunExecutable,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) process.exit(result.exitCode);
