import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  dreamBookRebuildLauncherCommand,
  dreamBookRebuildLauncherEnvironment,
} from "../scripts/start-dreambook-rebuild-launcher";

test("DreamBook rebuild source launcher uses the production profile under the account fence", () => {
  const root = process.cwd();
  const env = dreamBookRebuildLauncherEnvironment({ SAFE_MARKER: "kept" });
  const home = join(homedir(), ".local", "share", "goose-chatgpt-web-rebuild");
  expect(env).toMatchObject({
    SAFE_MARKER: "kept",
    GOOSE_CHATGPT_WEB_APPLIANCE: "persistent-rebuild",
    CODEX_CHATGPT_WEB_HOME: home,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: join(home, "launcher"),
    CODEX_WEB_GPT_LAUNCHER_SOURCE_PROFILE: "production",
  });
  const command = dreamBookRebuildLauncherCommand(root);
  expect(command).toContain(join(root, "scripts", "dreambook-account-browser-lease.ts"));
  expect(command).toContain("rebuild-launcher");
  expect(command).toContain("/usr/bin/xvfb-run");
  expect(command.slice(-2)).toEqual(["run", join(root, "launcher", "scripts", "dev.cjs")]);
});


test("DreamBook package wrapper pins the installed Bun path", () => {
  const wrapper = join(process.cwd(), "scripts", "start-dreambook-rebuild-launcher.sh");
  const text = require("node:fs").readFileSync(wrapper, "utf8");
  expect(text).toContain('BUN="$HOME/.bun/bin/bun"');
  expect(text).toContain('start-dreambook-rebuild-launcher.ts');
});
