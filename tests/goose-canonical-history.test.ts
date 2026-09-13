import { expect, test } from "bun:test";
import {
  classifyGooseCanonicalHistory,
  decodeGooseCanonicalHistoryWatermark,
  encodeGooseCanonicalHistoryWatermark,
  renderGoosePersistentPrompt,
} from "../src/goose-canonical-history";
import { gooseResponsesProjectionCheckpoint } from "../src/goose-responses-projection";

const system = (text = "system") => ({ type: "message", role: "system", content: [{ type: "input_text", text }] });
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const call = (opRef = "op_1") => ({ type: "function_call", call_id: opRef, name: "tree", arguments: '{"path":"."}' });
const output = (opRef = "op_1", value = "RAW_LOCAL_TOOL_OUTPUT") => ({ type: "function_call_output", call_id: opRef, output: value });

function body(input: unknown[], model = "gpt-4.1") {
  return { model, stream: true, store: false, max_output_tokens: 1024, input, tools: [{ type: "function", name: "tree" }] };
}

function watermark(previousBody: unknown, finalText = "prior final") {
  return encodeGooseCanonicalHistoryWatermark({
    checkpoint: gooseResponsesProjectionCheckpoint(previousBody),
    finalAssistantText: finalText,
  });
}

test("watermark is digest-only and binds exact represented item sequence plus provider final", () => {
  const previous = body([system("PRIVATE_SYSTEM"), user("PRIVATE_TASK")]);
  const encoded = watermark(previous, "PRIVATE_FINAL");
  expect(encoded).not.toContain("PRIVATE_SYSTEM");
  expect(encoded).not.toContain("PRIVATE_TASK");
  expect(encoded).not.toContain("PRIVATE_FINAL");
  const decoded = decodeGooseCanonicalHistoryWatermark(encoded);
  expect(decoded.representedInputItemHashes).toHaveLength(2);
  expect(decoded.representedInputHash).toBe(gooseResponsesProjectionCheckpoint(previous).inputHash);
  expect(decoded.finalAssistantTextHash).toMatch(/^[a-f0-9]{64}$/);
});

test("fresh epoch seeds the whole current canonical projection", () => {
  const current = body([system(), user("first")]);
  const decision = classifyGooseCanonicalHistory(current, null);
  expect(decision).toEqual({ kind: "SEED", items: current.input });
});

test("ordinary later turn consumes the already-remote provider assistant and appends only the new user", () => {
  const previous = body([system(), user("first")]);
  const current = body([system(), user("first"), assistant("prior final"), user("second")]);
  const decision = classifyGooseCanonicalHistory(current, watermark(previous));
  expect(decision).toEqual({ kind: "APPEND", items: [user("second")] });
});

test("tool history already represented in the remote conversation is not replayed on ordinary append", () => {
  const previous = body([system(), user("first"), call(), output()]);
  const current = body([system(), user("first"), call(), output(), assistant("prior final"), user("second")]);
  const decision = classifyGooseCanonicalHistory(current, watermark(previous));
  expect(decision).toEqual({ kind: "APPEND", items: [user("second")] });
});

test("history rewrite classes fail closed into explicit rollover reasons", () => {
  const previous = body([system(), user("first")]);
  const history = watermark(previous);
  const variants = [
    {
      label: "non-input drift",
      body: body([system(), user("first"), assistant("prior final"), user("second")], "other-model"),
      reason: "non_input_projection_changed",
    },
    {
      label: "revision/compaction prefix rewrite",
      body: body([system("changed"), user("first"), assistant("prior final"), user("second")]),
      reason: "canonical_history_prefix_changed",
    },
    {
      label: "truncation",
      body: body([system()]),
      reason: "canonical_history_not_extended",
    },
    {
      label: "changed provider answer",
      body: body([system(), user("first"), assistant("changed"), user("second")]),
      reason: "prior_provider_answer_changed",
    },
    {
      label: "branch/resume suffix divergence",
      body: body([system(), user("first"), assistant("prior final"), user("second"), user("third")]),
      reason: "new_turn_suffix_not_single_user_message",
    },
  ];
  for (const variant of variants) {
    expect(classifyGooseCanonicalHistory(variant.body, history)).toMatchObject({
      kind: "ROLLOVER",
      reason: variant.reason,
    });
  }
});

test("seed prompt resolves tool output from durable sanitized authority and never serializes raw Goose output", () => {
  const prompt = renderGoosePersistentPrompt({
    turnRef: "turn_1",
    submitNonce: "submit_1",
    opRef: "op_current",
    mode: "seed",
    connectorIdentity: "Goose Native 2nd Shift",
    availableToolNames: ["tree", "shell"],
    items: [system(), user("first"), call(), output()],
    resolveDurableToolResult: opRef => {
      expect(opRef).toBe("op_1");
      return "SANITIZED_DURABLE_TOOL_OUTPUT";
    },
  });
  expect(prompt).toContain("SANITIZED_DURABLE_TOOL_OUTPUT");
  expect(prompt).not.toContain("RAW_LOCAL_TOOL_OUTPUT");
  expect(prompt).toContain('"turn_ref":"turn_1"');
  expect(prompt).toContain('"op_ref":"op_current"');
  expect(prompt).toContain('"connector_identity":"Goose Native 2nd Shift"');
  expect(prompt).toContain('"available_tool_names":["tree","shell"]');
  expect(prompt).toContain("use a tool_name exactly as listed in available_tool_names");
});

test("append prompt contains only the classified new suffix and active correlation", () => {
  const prompt = renderGoosePersistentPrompt({
    turnRef: "turn_2",
    submitNonce: "submit_2",
    opRef: "op_2",
    mode: "append",
    connectorIdentity: "Goose Native 2nd Shift",
    availableToolNames: ["tree", "shell"],
    items: [user("new only")],
    resolveDurableToolResult: () => { throw new Error("no tool result expected"); },
  });
  expect(prompt).toContain("new only");
  expect(prompt).not.toContain("prior final");
  expect(prompt).toContain('"mode":"append"');
});
