import { canonicalJson } from "./canonical-json";
import { estimateTokens } from "./lib/token-estimate";
import { PERSISTENT_REMOTE_TOOL_RESULT_MAX_BYTES } from "./persistent-remote-data";

export const CONVERSATION_BUDGET_ESTIMATOR_VERSION = 1;
export const PERSISTENT_FINAL_RESPONSE_OVERHEAD_TOKENS = 8_192;

export interface ConversationBudgetPolicy {
  estimatorVersion: typeof CONVERSATION_BUDGET_ESTIMATOR_VERSION;
  softLimitTokens: number;
  baseAllowanceTokens: number;
  recoveryReserveTokens: number;
  turnGrowthReserveTokens: number;
  finalResponseReserveTokens: number;
  toolOperationReserveTokens: number;
  budgetFailureReserveTokens: number;
}

// These are deliberately conservative policy defaults, not measured ChatGPT hard limits.
// The soft limit is configurable because the cumulative server-side conversation budget is opaque.
export const DEFAULT_CONVERSATION_BUDGET_POLICY: ConversationBudgetPolicy = {
  estimatorVersion: CONVERSATION_BUDGET_ESTIMATOR_VERSION,
  softLimitTokens: 512_000,
  baseAllowanceTokens: 16_000,
  recoveryReserveTokens: 32_000,
  turnGrowthReserveTokens: 256_000,
  // Goose 1.50 currently requests max_output_tokens=32,768; keep an additional opaque framing reserve.
  finalResponseReserveTokens: 32_768 + PERSISTENT_FINAL_RESPONSE_OVERHEAD_TOKENS,
  // One persisted tool result may appear in both MCP text and structured representations, while
  // JSON escaping can expand the 32 KiB durable result. Reserve pessimistically before execution.
  toolOperationReserveTokens: (PERSISTENT_REMOTE_TOOL_RESULT_MAX_BYTES * 4) + 16_384,
  budgetFailureReserveTokens: 2_048,
};

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function resolveConversationBudgetPolicy(
  overrides: Partial<ConversationBudgetPolicy> = {},
): ConversationBudgetPolicy {
  const policy: ConversationBudgetPolicy = {
    ...DEFAULT_CONVERSATION_BUDGET_POLICY,
    ...overrides,
    estimatorVersion: CONVERSATION_BUDGET_ESTIMATOR_VERSION,
  };
  positiveSafeInteger(policy.softLimitTokens, "conversation budget softLimitTokens");
  positiveSafeInteger(policy.baseAllowanceTokens, "conversation budget baseAllowanceTokens");
  positiveSafeInteger(policy.recoveryReserveTokens, "conversation budget recoveryReserveTokens");
  positiveSafeInteger(policy.turnGrowthReserveTokens, "conversation budget turnGrowthReserveTokens");
  positiveSafeInteger(policy.finalResponseReserveTokens, "conversation budget finalResponseReserveTokens");
  positiveSafeInteger(policy.toolOperationReserveTokens, "conversation budget toolOperationReserveTokens");
  positiveSafeInteger(policy.budgetFailureReserveTokens, "conversation budget budgetFailureReserveTokens");
  if (policy.turnGrowthReserveTokens < policy.finalResponseReserveTokens
      + policy.toolOperationReserveTokens + policy.budgetFailureReserveTokens) {
    throw new Error("conversation budget turn growth reserve cannot bound one maximum tool result plus final/rejection reserves");
  }
  if (policy.softLimitTokens <= policy.baseAllowanceTokens
      + policy.recoveryReserveTokens + policy.turnGrowthReserveTokens) {
    throw new Error("conversation budget soft limit must leave positive room for a rendered prompt");
  }
  return policy;
}

export function conversationBudgetPolicyJson(policy: ConversationBudgetPolicy): string {
  return canonicalJson(policy);
}

export function parseConversationBudgetPolicyJson(value: string): ConversationBudgetPolicy {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("conversation budget policy is invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("conversation budget policy must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.estimatorVersion !== CONVERSATION_BUDGET_ESTIMATOR_VERSION) {
    throw new Error("conversation budget estimator version is unsupported");
  }
  const required = [
    "softLimitTokens",
    "baseAllowanceTokens",
    "recoveryReserveTokens",
    "turnGrowthReserveTokens",
    "finalResponseReserveTokens",
    "toolOperationReserveTokens",
    "budgetFailureReserveTokens",
  ] as const;
  const overrides: Partial<ConversationBudgetPolicy> = {};
  for (const key of required) {
    const candidate = record[key];
    if (typeof candidate !== "number") throw new Error(`conversation budget policy ${key} is invalid`);
    (overrides as Record<string, number>)[key] = candidate;
  }
  const policy = resolveConversationBudgetPolicy(overrides);
  if (conversationBudgetPolicyJson(policy) !== value) {
    throw new Error("conversation budget policy is not canonical");
  }
  return policy;
}

export function estimatePersistentPromptTokens(prompt: string, modelId?: string): number {
  return estimateTokens(prompt, modelId);
}

export function estimatePersistentFinalTokens(text: string, modelId?: string): number {
  return estimateTokens(text, modelId) + PERSISTENT_FINAL_RESPONSE_OVERHEAD_TOKENS;
}

export function requiredPersistentFinalReserveTokens(maxOutputTokens: number): number {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("Responses max_output_tokens must be a positive safe integer");
  }
  const required = maxOutputTokens + PERSISTENT_FINAL_RESPONSE_OVERHEAD_TOKENS;
  if (!Number.isSafeInteger(required)) throw new Error("Responses final-response reserve overflowed");
  return required;
}

export function estimatePersistentToolResultTokens(resultJson: string, modelId?: string): number {
  // Account for both MCP text and structured representations plus opaque connector/platform framing.
  return (estimateTokens(resultJson, modelId) * 2) + 8_192;
}
