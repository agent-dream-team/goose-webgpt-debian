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
