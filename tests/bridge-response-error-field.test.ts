import { expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

/**
 * The OpenAI Responses API always includes `error` on the response object, null when there is
 * none. A client-side Responses parser (e.g. ordinary Goose) that deserializes that field as
 * required rather than optional fails to decode ANY response.* event that omits the key — not
 * just response.failed — including response.created/response.completed/response.incomplete that
 * precede a later real failure in the same stream.
 */

function sseEventsByType(body: string): Map<string, Record<string, unknown>[]> {
  const byType = new Map<string, Record<string, unknown>[]>();
  for (const block of body.split("\n\n")) {
    const dataLine = block.split("\n").find(line => line.startsWith("data: "));
    if (!dataLine || dataLine === "data: [DONE]") continue;
    const data = JSON.parse(dataLine.slice("data: ".length)) as { type?: string };
    if (!data.type) continue;
    const list = byType.get(data.type) ?? [];
    list.push(data as Record<string, unknown>);
    byType.set(data.type, list);
  }
  return byType;
}

async function streamBody(events: AsyncIterable<AdapterEvent>): Promise<string> {
  const stream = bridgeToResponsesSSE(events, "chatgpt-web/test");
  return new Response(stream).text();
}

test("response.created and response.completed always carry a present error field (null when there is none)", async () => {
  async function* events(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "hello" };
    yield { type: "done", endTurn: true };
  }
  const body = await streamBody(events());
  const byType = sseEventsByType(body);

  const created = byType.get("response.created");
  const completed = byType.get("response.completed");
  expect(created).toHaveLength(1);
  expect(completed).toHaveLength(1);
  expect((created![0]!.response as Record<string, unknown>).error).toBeNull();
  expect((completed![0]!.response as Record<string, unknown>).error).toBeNull();
});

test("response.incomplete carries a present null error field alongside incomplete_details", async () => {
  async function* events(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "partial" };
    yield { type: "incomplete", reason: "max_output_tokens" };
  }
  const body = await streamBody(events());
  const byType = sseEventsByType(body);

  const incomplete = byType.get("response.incomplete");
  expect(incomplete).toHaveLength(1);
  const response = incomplete![0]!.response as Record<string, unknown>;
  expect(response.error).toBeNull();
  expect(response.incomplete_details).toBeTruthy();
});

test("response.failed carries the real error, overriding the default null", async () => {
  async function* events(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "before the failure" };
    yield { type: "error", message: "upstream exploded", status: 502, errorType: "server_error" };
  }
  const body = await streamBody(events());
  const byType = sseEventsByType(body);

  const failed = byType.get("response.failed");
  expect(failed).toHaveLength(1);
  const response = failed![0]!.response as Record<string, unknown>;
  expect(response.error).not.toBeNull();
  expect((response.error as Record<string, unknown>).message).toBe("upstream exploded");
  expect(response.last_error).toEqual(response.error);
});

test("buildResponseJSON's non-streaming completed/incomplete responses also carry a present null error field", () => {
  const completed = buildResponseJSON([
    { type: "text_delta", text: "hello" },
    { type: "done", endTurn: true },
  ], "chatgpt-web/test");
  expect(completed.status).toBe("completed");
  expect(completed.error).toBeNull();

  const incomplete = buildResponseJSON([
    { type: "text_delta", text: "partial" },
    { type: "incomplete", reason: "max_output_tokens" },
  ], "chatgpt-web/test");
  expect(incomplete.status).toBe("incomplete");
  expect(incomplete.error).toBeNull();
});

test("buildResponseJSON's failed response still carries the real error", () => {
  const failed = buildResponseJSON([
    { type: "text_delta", text: "before the failure" },
    { type: "error", message: "upstream exploded", status: 502, errorType: "server_error" },
  ], "chatgpt-web/test");
  expect(failed.status).toBe("failed");
  expect(failed.error).not.toBeNull();
  expect((failed.error as Record<string, unknown>).message).toBe("upstream exploded");
  expect(failed.last_error).toEqual(failed.error);
});
