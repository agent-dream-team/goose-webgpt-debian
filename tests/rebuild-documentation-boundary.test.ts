import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

test("V1 authority distinguishes production, borrowed, retired legacy, inherited, and qualification-only surfaces", () => {
  const agents = read("AGENTS.md");
  const plan = read("docs/persistent-chat-rebuild-plan.md");
  for (const term of [
    "Rebuild-owned production path",
    "Borrowed development mechanisms",
    "Retired legacy appliance",
    "Inherited upstream surfaces that are not rebuild workflow",
    "Qualification-only scaffolding",
  ]) expect(agents).toContain(term);
  expect(plan).toContain("Current rebuild boundary — operational authority");
  expect(plan).toContain("Codex compatibility is a permanent non-goal");
  expect(plan).toContain("Default upstream production homes `~/.codex-chatgpt-web` and `~/.config/Codex Web GPT`");
});

test("inherited Codex operator documents are visibly marked as heritage/reference", () => {
  const inherited = [
    "README.md",
    "README.zh-CN.md",
    "README.ja.md",
    "CONTRIBUTING.md",
    "TROUBLESHOOTING.md",
    "SECURITY.md",
    "docs/architecture.md",
    "docs/dev-chat.md",
    "docs/release-validation.md",
    "docs/security-model.md",
  ];
  for (const path of inherited) {
    const head = read(path).split("\n").slice(0, 16).join("\n");
    expect(head).toMatch(/HERITAGE DOCUMENT|REBUILD NOTE|CURRENT GOOSE V1/);
  }
});
