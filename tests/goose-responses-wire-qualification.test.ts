import { expect, test } from "bun:test";
import { buildResponsesSse, summarizeResponsesRequest } from "../scripts/qualify-goose-responses-wire";

test("wire request evidence preserves shape without persisting prompt content", () => {
  const summary = summarizeResponsesRequest({
    model: "gpt-4.1",
    stream: true,
    store: false,
    input: [
      { type: "message", role: "system", content: "PRIVATE_SYSTEM" },
      { type: "message", role: "user", content: "PRIVATE_PROMPT" },
      { type: "function_call", call_id: "call_1", name: "tree", arguments: '{"path":"."}' },
      { type: "function_call_output", call_id: "call_1", output: "PRIVATE_TOOL_OUTPUT" },
    ],
    tools: [{ type: "function", name: "tree", description: "PRIVATE_DESCRIPTION" }],
  });

  expect(summary.store).toBe(false);
  expect(summary.previousResponseId).toBe("__ABSENT__");
  expect(summary.inputShape?.map(item => item.type)).toEqual([
    "message", "message", "function_call", "function_call_output",
  ]);
  expect(summary.tools).toEqual([{ type: "function", name: "tree" }]);
  const persisted = JSON.stringify(summary);
  expect(persisted).not.toContain("PRIVATE_SYSTEM");
  expect(persisted).not.toContain("PRIVATE_PROMPT");
  expect(persisted).not.toContain("PRIVATE_TOOL_OUTPUT");
  expect(persisted).not.toContain("PRIVATE_DESCRIPTION");
});

test("wire SSE fixture includes the unknown heartbeat and tolerable unknown fields", () => {
  const body = buildResponsesSse({ text: "WIRE_OK", heartbeat: true });
  expect(body).toContain("event: response.heartbeat");
  expect(body).toContain('"type":"response.heartbeat"');
  expect(body).toContain('"stub_unknown_event_field":"ignored"');
  expect(body).toContain('"type":"response.output_text.delta"');
  expect(body).toContain('"delta":"WIRE_OK"');
  expect(body).toContain('"type":"response.completed"');
  expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("wire SSE fixture can emit a deterministic function call", () => {
  const body = buildResponsesSse({
    toolCall: { name: "tree", callId: "call_stub", arguments: '{"path":"."}' },
  });
  expect(body).toContain('"type":"function_call"');
  expect(body).toContain('"call_id":"call_stub"');
  expect(body).toContain('"name":"tree"');
  expect(body).toContain('"arguments":"{\\"path\\":\\".\\"}"');
});
