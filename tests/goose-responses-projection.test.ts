import { expect, test } from "bun:test";
import {
  classifyGooseResponsesContinuation,
  decodeGooseResponsesProjectionCheckpoint,
  encodeGooseResponsesProjectionCheckpoint,
  gooseResponsesProjectionCheckpoint,
} from "../src/goose-responses-projection";

function initial() {
  return {
    model: "gpt-4.1",
    stream: true,
    store: false,
    max_output_tokens: 1024,
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
    ],
    tools: [{ type: "function", name: "tree", description: "tree", parameters: { type: "object" }, strict: false }],
  };
}

const expected = { opRef: "op_1", toolName: "tree", argumentsJson: '{"path":"."}' };

function continued() {
  return {
    ...initial(),
    input: [
      ...initial().input,
      { type: "function_call", call_id: "op_1", name: "tree", arguments: '{"path":"."}' },
      { type: "function_call_output", call_id: "op_1", output: "result" },
    ],
  };
}

test("checkpoint contains only digests/count and round-trips in the provider checkpoint envelope", () => {
  const checkpoint = gooseResponsesProjectionCheckpoint(initial());
  expect(checkpoint.inputCount).toBe(2);
  expect(checkpoint.requestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(checkpoint.nonInputHash).toMatch(/^[a-f0-9]{64}$/);
  expect(checkpoint.inputHash).toMatch(/^[a-f0-9]{64}$/);
  const encoded = encodeGooseResponsesProjectionCheckpoint(checkpoint);
  expect(encoded).not.toContain("system");
  expect(encoded).not.toContain("task");
  expect(decodeGooseResponsesProjectionCheckpoint(encoded)).toEqual(checkpoint);
});

test("identical delivery is transport replay", () => {
  const previous = gooseResponsesProjectionCheckpoint(initial());
  expect(classifyGooseResponsesContinuation({ body: initial(), previous, expectedTool: expected }).kind).toBe("REPLAY");
});

test("exact two-item append is accepted as the expected Goose tool result", () => {
  const previous = gooseResponsesProjectionCheckpoint(initial());
  const decision = classifyGooseResponsesContinuation({ body: continued(), previous, expectedTool: expected });
  expect(decision.kind).toBe("TOOL_RESULT");
  if (decision.kind !== "TOOL_RESULT") throw new Error(`expected TOOL_RESULT, got ${decision.kind}`);
  expect(decision.output).toBe("result");
  expect(decision.checkpoint.inputCount).toBe(4);
  expect(decision.checkpoint.requestHash).not.toBe(previous.requestHash);
});

test("continuation fails closed on prefix, top-level, call identity, argument, output, or extra-item drift", () => {
  const previous = gooseResponsesProjectionCheckpoint(initial());
  const variants: unknown[] = [];
  const prefix = continued(); prefix.input[1] = { type: "message", role: "user", content: [{ type: "input_text", text: "changed" }] }; variants.push(prefix);
  variants.push({ ...continued(), model: "changed" });
  const call = continued(); (call.input[2] as any).call_id = "op_wrong"; variants.push(call);
  const args = continued(); (args.input[2] as any).arguments = '{"path":"elsewhere"}'; variants.push(args);
  const output = continued(); (output.input[3] as any).call_id = "op_wrong"; variants.push(output);
  const extra = continued(); extra.input.push({ type: "message", role: "user", content: [] } as any); variants.push(extra);
  for (const body of variants) {
    expect(classifyGooseResponsesContinuation({ body, previous, expectedTool: expected }).kind).toBe("DIVERGED");
  }
});

test("second serial tool round advances from the prior accepted projection", () => {
  const first = classifyGooseResponsesContinuation({
    body: continued(), previous: gooseResponsesProjectionCheckpoint(initial()), expectedTool: expected,
  });
  if (first.kind !== "TOOL_RESULT") throw new Error("first continuation rejected");
  const secondBody = {
    ...continued(),
    input: [
      ...continued().input,
      { type: "function_call", call_id: "op_2", name: "shell", arguments: '{"command":"pwd"}' },
      { type: "function_call_output", call_id: "op_2", output: "cwd" },
    ],
  };
  const second = classifyGooseResponsesContinuation({
    body: secondBody,
    previous: first.checkpoint,
    expectedTool: { opRef: "op_2", toolName: "shell", argumentsJson: '{"command":"pwd"}' },
  });
  expect(second.kind).toBe("TOOL_RESULT");
  if (second.kind === "TOOL_RESULT") expect(second.checkpoint.inputCount).toBe(6);
});
