import { expect, test } from "bun:test";
import {
  CONVERSATION_BUDGET_ESTIMATOR_VERSION,
  DEFAULT_CONVERSATION_BUDGET_POLICY,
  conversationBudgetPolicyJson,
  estimatePersistentToolResultTokens,
  parseConversationBudgetPolicyJson,
  requiredPersistentFinalReserveTokens,
  resolveConversationBudgetPolicy,
} from "../src/conversation-budget";
import { prepareConnectorTerminalResult } from "../src/rebuild-connector-http";

test("default conversation budget is conservative policy rather than a claimed hard maximum", () => {
  const policy = DEFAULT_CONVERSATION_BUDGET_POLICY;
  expect(policy.estimatorVersion).toBe(CONVERSATION_BUDGET_ESTIMATOR_VERSION);
  expect(policy.softLimitTokens).toBe(512_000);
  expect(policy.baseAllowanceTokens).toBeGreaterThan(0);
  expect(policy.recoveryReserveTokens).toBeGreaterThan(0);
  expect(policy.finalResponseReserveTokens).toBe(requiredPersistentFinalReserveTokens(32_768));
  expect(policy.turnGrowthReserveTokens).toBeGreaterThan(
    policy.toolOperationReserveTokens + policy.finalResponseReserveTokens + policy.budgetFailureReserveTokens,
  );
  expect(policy.softLimitTokens).toBeGreaterThan(
    policy.baseAllowanceTokens + policy.recoveryReserveTokens + policy.turnGrowthReserveTokens,
  );
});

test("persisted policy is canonical/versioned and rejects unsafe reserve combinations", () => {
  const policy = resolveConversationBudgetPolicy({ softLimitTokens: 600_000 });
  const encoded = conversationBudgetPolicyJson(policy);
  expect(parseConversationBudgetPolicyJson(encoded)).toEqual(policy);
  expect(() => parseConversationBudgetPolicyJson(JSON.stringify({ ...policy, estimatorVersion: 99 })))
    .toThrow("estimator version is unsupported");
  expect(() => resolveConversationBudgetPolicy({ turnGrowthReserveTokens: 100_000 }))
    .toThrow("cannot bound one maximum tool result");
  expect(() => resolveConversationBudgetPolicy({ softLimitTokens: 100_000 }))
    .toThrow("must leave positive room");
});

test("maximum durable tool-result escaping stays below the pre-side-effect operation reserve", () => {
  for (const content of [
    '"'.repeat(32 * 1024),
    "\\".repeat(32 * 1024),
    "\n".repeat(32 * 1024),
    "x".repeat(32 * 1024),
  ]) {
    const prepared = prepareConnectorTerminalResult({ outcome: "SUCCESS", dataClass: "task", content });
    expect(estimatePersistentToolResultTokens(prepared.resultJson))
      .toBeLessThanOrEqual(DEFAULT_CONVERSATION_BUDGET_POLICY.toolOperationReserveTokens);
  }
});
