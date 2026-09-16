import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

test("current DreamBook authority is lean and excludes superseded rebuild diaries", () => {
  const agents = read("AGENTS.md");
  const followUp = read("docs/persistent-chat-follow-up.md");
  expect(agents).toContain("docs/persistent-chat-follow-up.md");
  expect(followUp).toContain("## Current qualified runtime");
  expect(followUp).toContain("## Current architecture boundary");
  expect(followUp).toContain("## Remaining work");
  expect(followUp).toContain("Historical experiments or superseded checkpoints are not operating authority.");
  expect(existsSync("docs/persistent-chat-rebuild-plan.md")).toBe(false);
  expect(existsSync("docs/rebuild-baseline-manifest.json")).toBe(false);
});

test("persistent-chat lifecycle authority preserves recovery and paired-handoff invariants", () => {
  const agents = read("AGENTS.md");
  const lifecycle = read("docs/persistent-chat-lifecycle.md");
  const followUp = read("docs/persistent-chat-follow-up.md");

  expect(agents).toContain("Read `docs/persistent-chat-lifecycle.md`");
  for (const invariant of [
    "The server-side ChatGPT conversation is durable.",
    "The local Goose session is durable too.",
    "One Goose session and one ChatGPT conversation form a persistent context pair.",
    "GCW continuation prompts are provider-internal recovery artifacts.",
    "Timers, heartbeats, and semantic-silence watchers may escalate observation only.",
    "Deliberate handoff is the only normal way to replace the pair.",
    "Provider-chat instructions must promote graceful context rollover.",
  ]) expect(lifecycle).toContain(invariant);
  expect(lifecycle).toContain("do not click ChatGPT Retry");
  expect(lifecycle).toContain("fresh Goose session and a fresh ChatGPT conversation");
  expect(followUp).toContain("### 1. Paired context handoff");
  expect(followUp).toContain("`paired_handoff_required`");
  expect(followUp).toContain("### 2. Persistent-chat recovery fault matrix");
  expect(followUp).toContain("### 6. Reboot reconstruction");
  expect(followUp).toContain("Do not reboot DreamBook for GCW qualification without explicit operator approval.");
});

test("obsolete inherited Codex operator documents are removed from the DreamBook product surface", () => {
  for (const path of [
    "README.zh-CN.md",
    "README.ja.md",
    "TROUBLESHOOTING.md",
    "docs/architecture.md",
    "docs/dev-chat.md",
    "docs/release-validation.md",
    "docs/security-model.md",
  ]) expect(existsSync(path)).toBe(false);

  const readme = read("README.md");
  expect(readme).toContain("agent-dream-team/goose-webgpt-debian");
  expect(readme).toContain("luke-m-selway/goose-chatgpt-web");
  expect(readme).toContain("docs/persistent-chat-lifecycle.md");
  expect(readme).toContain("docs/persistent-chat-follow-up.md");
  expect(read("CONTRIBUTING.md")).toContain("DreamBook Goose ChatGPT Web appliance");
  expect(read("SECURITY.md")).toContain("~/.local/share/goose-chatgpt-web-rebuild");
});
