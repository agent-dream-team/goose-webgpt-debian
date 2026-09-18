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
  expect(checkpoint.stableNonInputHash).toMatch(/^[a-f0-9]{64}$/);
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

test("extension-manager continuation may change system and tools but not stable request fields", () => {
  const previousBody = initial();
  const previous = gooseResponsesProjectionCheckpoint(previousBody);
  const expectedExtension = {
    opRef: "op_ext",
    toolName: "extensionmanager__manage_extensions",
    argumentsJson: '{"action":"enable","extension_name":"orchestrator"}',
  };
  const body = {
    ...continued(),
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "system with orchestrator enabled" }] },
      previousBody.input[1],
      {
        type: "function_call",
        call_id: "op_ext",
        name: "extensionmanager__manage_extensions",
        arguments: expectedExtension.argumentsJson,
      },
      { type: "function_call_output", call_id: "op_ext", output: "enabled" },
    ],
    tools: [
      ...previousBody.tools,
      { type: "function", name: "orchestrator__start_agent", description: "start", parameters: { type: "object" }, strict: false },
    ],
  };
  expect(classifyGooseResponsesContinuation({ body, previous, expectedTool: expectedExtension }).kind).toBe("TOOL_RESULT");

  const stableDrift = { ...body, max_output_tokens: 2048 };
  expect(classifyGooseResponsesContinuation({ body: stableDrift, previous, expectedTool: expectedExtension }).kind).toBe("DIVERGED");

  const historyDrift = structuredClone(body);
  (historyDrift.input[1] as any).content[0].text = "changed prior user";
  expect(classifyGooseResponsesContinuation({ body: historyDrift, previous, expectedTool: expectedExtension }).kind).toBe("DIVERGED");

  const malformedSystem = structuredClone(body);
  (malformedSystem.input[0] as any).role = "user";
  expect(classifyGooseResponsesContinuation({ body: malformedSystem, previous, expectedTool: expectedExtension }).kind).toBe("DIVERGED");

  const ordinaryTool = { opRef: "op_ext", toolName: "tree", argumentsJson: '{"path":"."}' };
  const ordinaryBody = structuredClone(body);
  (ordinaryBody.input[2] as any).name = "tree";
  (ordinaryBody.input[2] as any).arguments = ordinaryTool.argumentsJson;
  expect(classifyGooseResponsesContinuation({ body: ordinaryBody, previous, expectedTool: ordinaryTool }).kind).toBe("DIVERGED");
});

test("legacy checkpoint without stable non-input digest only relaxes for extension mutation", () => {
  const previous = gooseResponsesProjectionCheckpoint(initial());
  delete previous.stableNonInputHash;
  const expectedExtension = {
    opRef: "op_ext",
    toolName: "extensionmanager__manage_extensions",
    argumentsJson: '{"action":"enable","extension_name":"orchestrator"}',
  };
  const body = {
    ...continued(),
    max_output_tokens: 2048,
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "legacy changed system" }] },
      initial().input[1],
      {
        type: "function_call",
        call_id: "op_ext",
        name: "extensionmanager__manage_extensions",
        arguments: expectedExtension.argumentsJson,
      },
      { type: "function_call_output", call_id: "op_ext", output: "enabled" },
    ],
    tools: [
      ...initial().tools,
      { type: "function", name: "orchestrator__start_agent", parameters: { type: "object" } },
    ],
  };
  expect(classifyGooseResponsesContinuation({ body, previous, expectedTool: expectedExtension }).kind).toBe("TOOL_RESULT");

  const ordinaryTool = { opRef: "op_ext", toolName: "tree", argumentsJson: '{"path":"."}' };
  const ordinaryBody = structuredClone(body);
  (ordinaryBody.input[2] as any).name = "tree";
  (ordinaryBody.input[2] as any).arguments = ordinaryTool.argumentsJson;
  expect(classifyGooseResponsesContinuation({ body: ordinaryBody, previous, expectedTool: ordinaryTool }).kind).toBe("DIVERGED");
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
