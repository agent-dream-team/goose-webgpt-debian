import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import {
  STOCK_GOOSE_SESSION_NAME_MAX_TITLE_CHARS,
  isStockGooseSessionNameRequestBody,
  stockGooseSessionNameAnswer,
} from "../src/responses/goose-session-name";
import type { CodexProviderConfig } from "../src/types";

const model = "chatgpt-web/high";

const SESSION_NAME_SYSTEM_PROMPT = `Generate a short title (four words or less) that describes the topic of the user's messages. \nReply with only the title, nothing else. Do not show your reasoning.\n\nExamples:\n- "how do I reverse a list in python?" ... Python list reversal\n- "what's the weather in Tokyo?" ... Tokyo weather\n- "explain how transformers work in ML" ... ML transformers explained`;

function sessionNameBody(userMessage: string, overrides: Record<string, unknown> = {}) {
  return {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: SESSION_NAME_SYSTEM_PROMPT }] },
      {
        role: "user",
        content: [{
          type: "input_text",
          text: `---BEGIN USER MESSAGES---\n${userMessage}\n---END USER MESSAGES---\n\nGenerate a short title for the above messages.`,
        }],
      },
    ],
    store: false,
    stream: true,
    ...overrides,
  };
}

function ordinaryTextBody() {
  return {
    model,
    stream: true,
    input: [
      { role: "system", content: [{ type: "input_text", text: "You are a general-purpose AI agent called goose." }] },
      { role: "user", content: [{ type: "input_text", text: "Reply with exactly this single word and nothing else: CAPTURE-OK" }] },
    ],
  };
}

function countingAdapterFactory(calls: CodexProviderConfig[], reply = "CAPTURE-OK") {
  return (_provider: CodexProviderConfig): ProviderAdapter => {
    calls.push(_provider);    return {
      name: "test-web-session-name",
      async runTurn(_parsed, _incoming, emit) {
        emit({ type: "text_delta", text: reply, phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    };
  };
}

test("recognizes the stock Goose session-name request shape", () => {
  expect(isStockGooseSessionNameRequestBody(sessionNameBody("Inspect the flange"))).toBe(true);
});

test("does not recognize near-miss bodies as session naming", () => {
  expect(isStockGooseSessionNameRequestBody(sessionNameBody("x", { stream: false }))).toBe(false);
  expect(isStockGooseSessionNameRequestBody(sessionNameBody("x", { store: true }))).toBe(false);
  expect(isStockGooseSessionNameRequestBody(sessionNameBody("x", { previous_response_id: "resp_x" }))).toBe(false);
  expect(isStockGooseSessionNameRequestBody(sessionNameBody("x", { tools: [{ type: "function", name: "shell", parameters: {} }] }))).toBe(false);
  expect(isStockGooseSessionNameRequestBody(sessionNameBody("x", { tool_choice: "auto" }))).toBe(false);

  const oneItem = sessionNameBody("x");
  (oneItem.input as unknown[]).pop();
  expect(isStockGooseSessionNameRequestBody(oneItem)).toBe(false);

  const threeItems = sessionNameBody("x");
  (threeItems.input as unknown[]).push(structuredClone(threeItems.input[1]));
  expect(isStockGooseSessionNameRequestBody(threeItems)).toBe(false);

  const alteredSystem = sessionNameBody("x");
  (alteredSystem.input as Array<{ role: string; content: Array<{ text: string }> }>)[0]!.content[0]!.text =
    "Generate a long essay describing the topic of the user's messages.";
  expect(isStockGooseSessionNameRequestBody(alteredSystem)).toBe(false);

  const missingWrapperTail = sessionNameBody("x");
  ((missingWrapperTail.input as Array<{ role: string; content: Array<{ text: string }> }>)[1]!.content[0]!).text =
    "---BEGIN USER MESSAGES---\nx\n---END USER MESSAGES---";
  expect(isStockGooseSessionNameRequestBody(missingWrapperTail)).toBe(false);
});

test("ordinary agent turns are never mistaken for session naming", () => {
  expect(isStockGooseSessionNameRequestBody(ordinaryTextBody())).toBe(false);
});

test("derives a deterministic local title from the wrapped user messages", () => {
  expect(stockGooseSessionNameAnswer(sessionNameBody("Fix the login redirect bug"))).toBe("Fix the login redirect bug");
  expect(stockGooseSessionNameAnswer(sessionNameBody("First line here\n\nSecond line"))).toBe("First line here");

  const longLine = "investigate why the standalone daemon occasionally reports accepting_turns false after a resume";
  const answer = stockGooseSessionNameAnswer(sessionNameBody(longLine))!;
  expect(answer.startsWith("investigate why the standalone")).toBe(true);
  expect(answer.endsWith("…")).toBe(true);
  expect(answer.length).toBeLessThanOrEqual(STOCK_GOOSE_SESSION_NAME_MAX_TITLE_CHARS + 2);

  expect(stockGooseSessionNameAnswer(sessionNameBody("   \n  \n"))).toBe("Goose session");
});

test("a recognized session-name request is answered locally without any browser turn (streaming)", async () => {
  const calls: CodexProviderConfig[] = [];
  const config = { ...defaultConfig("browser-only"), standalone: true };
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionNameBody("Reply with exactly this single word and nothing else: CAPTURE-OK")),
  }), config, countingAdapterFactory(calls));

  expect(response.status).toBe(200);
  // The whole point: zero adapter/browser executions for cosmetic session naming.
  expect(calls).toHaveLength(0);
  const sse = await response.text();
  expect(sse).toContain("response.output_item.added");
  expect(sse).toContain("response.output_text.delta");
  expect(sse).toContain("Reply with exactly this single word");
  expect(sse).toContain("response.completed");
});

test("the recognizer only matches streaming requests, so the local answer always rides the SSE bridge", () => {
  // Stock Goose fires session naming as a streaming complete_fast() call; the non-streaming
  // shape is intentionally not claimed by the recognizer.
  expect(isStockGooseSessionNameRequestBody(sessionNameBody("x", { stream: false }))).toBe(false);
});

test("one ordinary Goose text turn still maps to exactly one browser turn", async () => {
  const calls: CodexProviderConfig[] = [];
  const config = { ...defaultConfig("browser-only"), standalone: true };
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ordinaryTextBody()),
  }), config, countingAdapterFactory(calls));

  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  const sse = await response.text();
  expect(sse).toContain("CAPTURE-OK");
  expect((sse.match(/"type":"message"/g) ?? []).length).toBeGreaterThanOrEqual(1);
});

test("session-name requests still open a browser turn when standalone mode is off", async () => {
  const calls: CodexProviderConfig[] = [];
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionNameBody("Title me")),
  }), defaultConfig("browser-only"), countingAdapterFactory(calls, "TITLE"));

  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
});
