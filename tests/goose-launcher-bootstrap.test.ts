import { expect, test } from "bun:test";
import { defaultGooseRuntimeHome, gooseLauncherBootstrapEnv } from "../src/goose-launcher-bootstrap";

test("goose launcher bootstrap defaults to the Goose dev runtime home and launcher data dir", () => {
  const env = gooseLauncherBootstrapEnv({}, "/Users/luke");
  expect(env).toEqual({
    CODEX_CHATGPT_WEB_HOME: "/Users/luke/.goose-chatgpt-web-dev",
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "/Users/luke/.goose-chatgpt-web-dev/launcher",
  });
  expect(defaultGooseRuntimeHome("/Users/luke")).toBe("/Users/luke/.goose-chatgpt-web-dev");
});

test("goose launcher bootstrap preserves explicit home and launcher data overrides", () => {
  const env = gooseLauncherBootstrapEnv({
    CODEX_CHATGPT_WEB_HOME: "~/custom-goose",
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "~/custom-launcher-data",
  }, "/Users/luke");
  expect(env).toEqual({
    CODEX_CHATGPT_WEB_HOME: "/Users/luke/custom-goose",
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "/Users/luke/custom-launcher-data",
  });
});
