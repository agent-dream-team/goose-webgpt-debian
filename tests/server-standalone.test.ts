import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { prepareStandaloneTextRequest, responseRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

const model = "chatgpt-web/high";

test("standalone browser-only Responses requests receive internal replay identity", async () => {
  const config = { ...defaultConfig("browser-only"), standalone: true };
  let seen: CodexParsedRequest | undefined;
  const adapter: ProviderAdapter = {
    name: "standalone-text-check",
    async runTurn(parsed, _incoming, emit) {
      seen = parsed;
      expect(extractChatGptTurnIdentity(parsed)).toEqual({
        threadId: "standalone_proof-turn",
        turnId: "standalone_proof-turn",
      });
      expect(() => chatGptTurnExecutionKey(parsed)).not.toThrow();
      emit({ type: "text_delta", text: "GOOSE_CHATGPT_WEB_OK", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  };
  const raw = {
    model,
    stream: false,
    input: [
      { role: "system", content: [{ type: "input_text", text: "Be precise." }] },
      { role: "user", content: [{ type: "input_text", text: "Reply exactly." }] },
    ],
  };
  const prepared = prepareStandaloneTextRequest(raw, config, "proof-turn");
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prepared),
  }), { ...config, standalone: false }, () => adapter);

  expect(response.status).toBe(200);
  expect(seen).toBeDefined();
  const body = await response.json() as {
    output: Array<{ type: string; content?: Array<{ text: string }> }>;
  };
  expect(body.output.find(item => item.type === "message")?.content?.[0]?.text)
    .toBe("GOOSE_CHATGPT_WEB_OK");
});

test("normal and tool-bearing requests do not receive standalone identity", () => {
  const raw = {
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: "Use a tool." }] }],
    tools: [{ type: "function", name: "example" }],
  };
  const normal = defaultConfig("browser-only");
  const standalone = { ...normal, standalone: true };

  expect(prepareStandaloneTextRequest(raw, normal, "normal")).toBe(raw);
  expect(prepareStandaloneTextRequest(raw, standalone, "tool-request")).toBe(raw);
});

function turnIdOf(prepared: unknown): string {
  const body = prepared as { client_metadata?: { "x-codex-turn-metadata"?: string } };
  const raw = body.client_metadata?.["x-codex-turn-metadata"];
  expect(typeof raw).toBe("string");
  return (JSON.parse(raw as string) as { turn_id: string }).turn_id;
}

test("default standalone identity is deterministic: a byte-identical retry reuses the same turn_id", () => {
  const config = { ...defaultConfig("browser-only"), standalone: true };
  const raw = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: "Be precise." }] },
      { role: "user", content: [{ type: "input_text", text: "Remember the token ORANGE-731. Reply only READY." }] },
    ],
  };
  // No explicit identity: two calls with the identical raw request (e.g. a client-side HTTP
  // retry after a dropped connection) must collapse onto the same execution key instead of
  // opening a second browser tab for work that may already be in flight or already answered.
  const first = turnIdOf(prepareStandaloneTextRequest(raw, config));
  const second = turnIdOf(prepareStandaloneTextRequest(structuredClone(raw), config));
  expect(first).toBe(second);
});

test("default standalone identity changes once a new user message is appended", () => {
  const config = { ...defaultConfig("browser-only"), standalone: true };
  const turnOne = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: "Be precise." }] },
      { role: "user", content: [{ type: "input_text", text: "Remember the token ORANGE-731. Reply only READY." }] },
    ],
  };
  const turnTwo = {
    model,
    input: [
      ...turnOne.input,
      { role: "assistant", content: [{ type: "output_text", text: "READY" }] },
      { role: "user", content: [{ type: "input_text", text: "What token did I ask you to remember?" }] },
    ],
  };
  const firstTurnId = turnIdOf(prepareStandaloneTextRequest(turnOne, config));
  const secondTurnId = turnIdOf(prepareStandaloneTextRequest(turnTwo, config));
  expect(firstTurnId).not.toBe(secondTurnId);
});

test("a second Goose turn with plain-text assistant history still receives standalone identity", () => {
  // Matches the exact shape a real Goose CLI turn 2 sends: [system, user, assistant, user], no
  // previous_response_id, no client_metadata of its own — captured via a live Goose run against a
  // diagnostic capture server pointed at the openai provider with OPENAI_BASE_PATH=v1/responses.
  const config = { ...defaultConfig("browser-only"), standalone: true };
  const raw = {
    model,
    stream: true,
    input: [
      { role: "system", content: [{ type: "input_text", text: "You are a general-purpose AI agent called goose." }] },
      { role: "user", content: [{ type: "input_text", text: "Remember the token ORANGE-731. Reply only READY." }] },
      { role: "assistant", content: [{ type: "output_text", text: "READY" }] },
      { role: "user", content: [{ type: "input_text", text: "What token did I ask you to remember? Reply only with the token." }] },
    ],
  };
  const prepared = prepareStandaloneTextRequest(raw, config) as { client_metadata?: unknown; input: unknown[] };
  expect(prepared).not.toBe(raw);
  expect(prepared.client_metadata).toBeDefined();
  expect(turnIdOf(prepared)).toStartWith("standalone_");
});

test("assistant history carrying a tool call still falls through to the native-Codex path", () => {
  const config = { ...defaultConfig("browser-only"), standalone: true };
  const raw = {
    model,
    input: [
      { role: "user", content: [{ type: "input_text", text: "Do something." }] },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { role: "user", content: [{ type: "input_text", text: "Now what?" }] },
    ],
  };
  expect(prepareStandaloneTextRequest(raw, config)).toBe(raw);
});
