import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";

export interface GooseResponsesProjectionCheckpoint {
  version: 2;
  requestHash: string;
  nonInputHash: string;
  inputHash: string;
  inputItemHashes: string[];
  inputCount: number;
}

export interface ExpectedGooseToolCall {
  opRef: string;
  toolName: string;
  argumentsJson: string;
}

export type GooseResponsesContinuationDecision =
  | { kind: "REPLAY"; checkpoint: GooseResponsesProjectionCheckpoint }
  | { kind: "TOOL_RESULT"; output: string; checkpoint: GooseResponsesProjectionCheckpoint }
  | { kind: "DIVERGED"; reason: string };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function gooseResponsesProjectionCheckpoint(body: unknown): GooseResponsesProjectionCheckpoint {
  const request = record(body, "Responses request");
  if (!Array.isArray(request.input)) throw new Error("Responses request input must be an array");
  const nonInput = { ...request };
  delete nonInput.input;
  return {
    version: 2,
    requestHash: canonicalJsonSha256(request),
    nonInputHash: canonicalJsonSha256(nonInput),
    inputHash: canonicalJsonSha256(request.input),
    inputItemHashes: request.input.map(item => canonicalJsonSha256(item)),
    inputCount: request.input.length,
  };
}

export function encodeGooseResponsesProjectionCheckpoint(checkpoint: GooseResponsesProjectionCheckpoint): string {
  return canonicalJson({ gooseResponsesProjection: checkpoint });
}

export function decodeGooseResponsesProjectionCheckpoint(value: string | null): GooseResponsesProjectionCheckpoint {
  if (!value) throw new Error("Goose Responses projection checkpoint is missing");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Goose Responses projection checkpoint is invalid JSON"); }
  const root = record(parsed, "Provider checkpoint");
  const checkpoint = record(root.gooseResponsesProjection, "Goose Responses projection checkpoint");
  if (checkpoint.version !== 2
    || typeof checkpoint.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.requestHash)
    || typeof checkpoint.nonInputHash !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.nonInputHash)
    || typeof checkpoint.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.inputHash)
    || !Array.isArray(checkpoint.inputItemHashes)
    || checkpoint.inputItemHashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
    || !Number.isSafeInteger(checkpoint.inputCount) || Number(checkpoint.inputCount) < 0
    || checkpoint.inputItemHashes.length !== Number(checkpoint.inputCount)) {
    throw new Error("Goose Responses projection checkpoint has invalid fields");
  }
  return checkpoint as unknown as GooseResponsesProjectionCheckpoint;
}

export function classifyGooseResponsesContinuation(input: {
  body: unknown;
  previous: GooseResponsesProjectionCheckpoint;
  expectedTool: ExpectedGooseToolCall;
}): GooseResponsesContinuationDecision {
  let current: GooseResponsesProjectionCheckpoint;
  let request: Record<string, unknown>;
  try {
    request = record(input.body, "Responses request");
    current = gooseResponsesProjectionCheckpoint(request);
  } catch (error) {
    return { kind: "DIVERGED", reason: error instanceof Error ? error.message : String(error) };
  }
  if (current.requestHash === input.previous.requestHash) return { kind: "REPLAY", checkpoint: current };
  if (current.nonInputHash !== input.previous.nonInputHash) {
    return { kind: "DIVERGED", reason: "non-input Responses projection changed during tool continuation" };
  }
  const items = request.input as unknown[];
  if (items.length !== input.previous.inputCount + 2) {
    return { kind: "DIVERGED", reason: "tool continuation must append exactly two input items" };
  }
  const prefix = items.slice(0, input.previous.inputCount);
  if (canonicalJsonSha256(prefix) !== input.previous.inputHash) {
    return { kind: "DIVERGED", reason: "tool continuation changed the prior canonical input prefix" };
  }

  let call: Record<string, unknown>;
  let output: Record<string, unknown>;
  try {
    call = record(items[input.previous.inputCount], "function_call");
    output = record(items[input.previous.inputCount + 1], "function_call_output");
  } catch (error) {
    return { kind: "DIVERGED", reason: error instanceof Error ? error.message : String(error) };
  }
  const callKeysMatch = exactKeys(call, ["type", "call_id", "name", "arguments"]);
  const callTypeMatch = call.type === "function_call";
  const callIdMatch = call.call_id === input.expectedTool.opRef;
  const callNameMatch = call.name === input.expectedTool.toolName;
  const callArgumentsMatch = call.arguments === input.expectedTool.argumentsJson;
  if (!callKeysMatch || !callTypeMatch || !callIdMatch || !callNameMatch || !callArgumentsMatch) {
    const actualArguments = typeof call.arguments === "string" ? call.arguments : "";
    return {
      kind: "DIVERGED",
      reason: "function_call does not exactly match the provider-issued operation"
        + ` (keys=${callKeysMatch}, type=${callTypeMatch}, call_id=${callIdMatch}, name=${callNameMatch}, arguments=${callArgumentsMatch}`
        + `, expected_arguments_sha256=${canonicalJsonSha256(input.expectedTool.argumentsJson)}`
        + `, actual_arguments_sha256=${canonicalJsonSha256(actualArguments)}`
        + `, expected_arguments_chars=${input.expectedTool.argumentsJson.length}`
        + `, actual_arguments_chars=${actualArguments.length})`,
    };
  }
  if (!exactKeys(output, ["type", "call_id", "output"])
    || output.type !== "function_call_output"
    || output.call_id !== input.expectedTool.opRef
    || typeof output.output !== "string") {
    return { kind: "DIVERGED", reason: "function_call_output does not exactly match the expected operation" };
  }
  return { kind: "TOOL_RESULT", output: output.output, checkpoint: current };
}
