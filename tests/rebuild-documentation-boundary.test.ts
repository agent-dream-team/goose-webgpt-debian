import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

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

test("persistent-chat lifecycle authority preserves recovery and paired-handoff invariants", () => {
  const agents = read("AGENTS.md");
  const lifecycle = read("docs/persistent-chat-lifecycle.md");
  const plan = read("docs/persistent-chat-rebuild-plan.md");

  expect(agents).toContain("Read `docs/persistent-chat-lifecycle.md`");
  expect(plan).toContain("**Lifecycle authority:** `docs/persistent-chat-lifecycle.md`");
  for (const invariant of [
    "Persistent provider chats are recovered, not abandoned.",
    "Refresh is an observation/recovery tool, not a retry loop.",
    "GCW continuation prompts are provider-internal recovery artifacts.",
    "One Goose chat and one ChatGPT provider chat remain context partners until handoff.",
    "Provider-chat instructions must promote graceful context rollover.",
    "Timers, heartbeats, and watchers may trigger observation or escalation only.",
  ]) expect(lifecycle).toContain(invariant);
  expect(lifecycle).toContain("do not click ChatGPT Retry");
  expect(lifecycle).toContain("fresh ChatGPT conversation and a fresh Goose session");
  for (const requirement of [
    "Requirement 5 — Recovery navigation interlock",
    "Requirement 7 — Sleep/suspension is load-bearing",
    "Durable recovery counters",
    "Requirement 15 — Per-message browser transport limits remain distinct from conversation context health",
    "Requirement 17 — One-surface FIFO handoff fence",
  ]) expect(plan).toContain(requirement);
  expect(plan).toContain("Gate F — Goose canonical history and paired handoff");
  expect(plan).toContain("Gate H — recovery fault matrix");
  expect(plan).toContain("REOPENED BY LIFECYCLE DECISION");
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
  expect(read("CONTRIBUTING.md")).toContain("DreamBook Goose ChatGPT Web appliance");
  expect(read("SECURITY.md")).toContain("~/.local/share/goose-chatgpt-web-rebuild");
});
