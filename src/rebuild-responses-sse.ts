import { createHash, randomUUID } from "node:crypto";

export interface RebuildFunctionCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

function responseId(): string {
  return `resp_${randomUUID().replaceAll("-", "")}`;
}

function itemId(prefix: "msg" | "fc", responseIdValue: string): string {
  return `${prefix}_${createHash("sha256").update(`${prefix}:${responseIdValue}`).digest("hex").slice(0, 32)}`;
}

function envelope(id: string, model: string, status: "in_progress" | "completed", output: unknown[]) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status,
    model,
    output,
    ...(status === "completed" ? { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } : {}),
  };
}

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Minimal Responses SSE subset qualified against unmodified Goose 1.50. */
export function buildRebuildResponsesSse(input: {
  model: string;
  text?: string;
  toolCall?: RebuildFunctionCall;
  id?: string;
}): string {
  if ((input.text === undefined) === (input.toolCall === undefined)) {
    throw new Error("Exactly one rebuild Responses terminal payload is required");
  }
  const id = input.id ?? responseId();
  const chunks = [frame({ type: "response.created", sequence_number: 0, response: envelope(id, input.model, "in_progress", []) })];
  let sequence = 1;
  let output: unknown[] = [];
  if (input.text !== undefined) {
    const itemIdValue = itemId("msg", id);
    chunks.push(frame({
      type: "response.output_text.delta",
      sequence_number: sequence++,
      item_id: itemIdValue,
      output_index: 0,
      content_index: 0,
      delta: input.text,
    }));
  } else if (input.toolCall) {
    output = [{
      type: "function_call",
      id: itemId("fc", id),
      call_id: input.toolCall.callId,
      name: input.toolCall.name,
      arguments: input.toolCall.argumentsJson,
    }];
  }
  chunks.push(frame({ type: "response.completed", sequence_number: sequence, response: envelope(id, input.model, "completed", output) }));
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

export function rebuildResponsesSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
