const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertLegacyCodexAction,
  resolveApplianceKind,
} = require("../electron/appliance-kind.cjs");

const persistent = { configured: true, config: { runtimeKind: "persistent-rebuild" } };
const legacy = { configured: true, config: { mode: "full" } };
const unconfigured = { configured: false };

test("configured runtime is authoritative and matching declarations are accepted", () => {
  assert.equal(resolveApplianceKind({ declared: undefined, runtimeSnapshot: persistent }), "persistent-rebuild");
  assert.equal(resolveApplianceKind({ declared: "persistent-rebuild", runtimeSnapshot: persistent }), "persistent-rebuild");
  assert.equal(resolveApplianceKind({ declared: undefined, runtimeSnapshot: legacy }), "legacy-codex");
  assert.equal(resolveApplianceKind({ declared: "legacy-codex", runtimeSnapshot: legacy }), "legacy-codex");
});

test("a declared appliance is only a cold-start fallback when no runtime is configured", () => {
  assert.equal(resolveApplianceKind({ declared: "persistent-rebuild", runtimeSnapshot: unconfigured }), "persistent-rebuild");
  assert.equal(resolveApplianceKind({ declared: "legacy-codex", runtimeSnapshot: unconfigured }), "legacy-codex");
  assert.equal(resolveApplianceKind({ declared: undefined, runtimeSnapshot: unconfigured }), "legacy-codex");
});

test("environment and persisted configuration disagreement fails closed in both directions", () => {
  assert.throws(
    () => resolveApplianceKind({ declared: "legacy-codex", runtimeSnapshot: persistent }),
    /disagrees with configured appliance persistent-rebuild/,
  );
  assert.throws(
    () => resolveApplianceKind({ declared: "persistent-rebuild", runtimeSnapshot: legacy }),
    /disagrees with configured appliance legacy-codex/,
  );
});

test("unknown appliance declarations fail closed", () => {
  assert.throws(
    () => resolveApplianceKind({ declared: "something-else", runtimeSnapshot: unconfigured }),
    /Unsupported GOOSE_CHATGPT_WEB_APPLIANCE/,
  );
});

test("inherited Codex mutations are behaviorally rejected for the persistent rebuild", () => {
  for (const action of [
    "Browser smoke setup",
    "Codex core setup",
    "Codex MCP setup",
    "Codex Bigger Context setup",
    "Zero Risk setup",
    "Codex integration removal",
  ]) {
    assert.throws(
      () => assertLegacyCodexAction("persistent-rebuild", action),
      /disabled for the persistent Goose rebuild/,
    );
    assert.doesNotThrow(() => assertLegacyCodexAction("legacy-codex", action));
  }
});
