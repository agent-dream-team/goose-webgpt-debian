const STOCK_GOOSE_SESSION_NAME_SYSTEM_PROMPT = "Generate a short title (four words or less) that describes the topic of the user's messages.";

const STOCK_GOOSE_SESSION_NAME_MESSAGES_BEGIN = "---BEGIN USER MESSAGES---";
const STOCK_GOOSE_SESSION_NAME_MESSAGES_END = "---END USER MESSAGES---";
const STOCK_GOOSE_SESSION_NAME_INSTRUCTION = "Generate a short title for the above messages.";

/** Longest locally derived title before an ellipsis is appended. */
export const STOCK_GOOSE_SESSION_NAME_MAX_TITLE_CHARS = 48;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactInputTextMessage(value: unknown, role: "system" | "user"): string | undefined {
  const message = record(value);
  if (!message || (message.type !== undefined && message.type !== "message") || message.role !== role || !Array.isArray(message.content)) {
    return undefined;
  }
  if (message.content.length !== 1) return undefined;
  const block = record(message.content[0]);
  return block?.type === "input_text" && typeof block.text === "string" ? block.text : undefined;
}

/**
 * Recognize stock Goose's session-name request ("session_name.md", fired via `complete_fast()`).
 *
 * Current Goose serializes it as exactly two input items — one fixed system message holding the
 * short-title instruction and one user message wrapping the collected user messages in explicit
 * BEGIN/END markers — with `store: false`, a streaming request, and no tools. The same compound
 * shape check as {@link isStockGooseCompactionRequestBody} applies: ordinary no-tool lightweight
 * completions must remain ordinary, so require every marker, not just the leading sentence.
 */
export function isStockGooseSessionNameRequestBody(value: unknown): boolean {
  const body = record(value);
  if (!body || body.stream !== true || body.store !== false || body.previous_response_id !== undefined) return false;
  if (body.tool_choice !== undefined || body.parallel_tool_calls !== undefined) return false;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) return false;

  if (!Array.isArray(body.input) || body.input.length !== 2) return false;
  const system = exactInputTextMessage(body.input[0], "system");
  const user = exactInputTextMessage(body.input[1], "user");
  if (system === undefined || user === undefined) return false;
  return system.startsWith(STOCK_GOOSE_SESSION_NAME_SYSTEM_PROMPT)
    && user.startsWith(`${STOCK_GOOSE_SESSION_NAME_MESSAGES_BEGIN}\n`)
    && user.trimEnd().endsWith(`${STOCK_GOOSE_SESSION_NAME_MESSAGES_END}\n\n${STOCK_GOOSE_SESSION_NAME_INSTRUCTION}`);
}

/**
 * Deterministic local answer for a recognized session-name request.
 *
 * Session naming is optional, cosmetic Goose bookkeeping: its entire input is already present in
 * the request body, and Goose tolerates its failure ("Failed to publish generated session name").
 * Serving it from the request contents keeps the provider contract intact without spending one of
 * the few concurrent authenticated ChatGPT browser turns on it, and without leaving aborted
 * auxiliary BrowserHost traces in unattended diagnostics. The derived title is the collapsed first
 * line of the wrapped user messages, truncated on a word boundary when needed.
 */
export function stockGooseSessionNameAnswer(value: unknown): string | undefined {
  if (!isStockGooseSessionNameRequestBody(value)) return undefined;
  const input = record(value)?.input;
  if (!Array.isArray(input)) return undefined;
  const user = exactInputTextMessage(input[1], "user");
  if (user === undefined) return undefined;
  const start = STOCK_GOOSE_SESSION_NAME_MESSAGES_BEGIN.length + 1;
  const end = user.indexOf(`\n${STOCK_GOOSE_SESSION_NAME_MESSAGES_END}`);
  const inner = user.slice(start, end === -1 ? undefined : end);
  const line = inner.split("\n").map(candidate => candidate.trim()).find(Boolean);
  if (!line) return "Goose session";
  const collapsed = line.replace(/\s+/g, " ");
  if (collapsed.length <= STOCK_GOOSE_SESSION_NAME_MAX_TITLE_CHARS) return collapsed;
  const truncated = collapsed.slice(0, STOCK_GOOSE_SESSION_NAME_MAX_TITLE_CHARS + 1);
  const cut = truncated.lastIndexOf(" ");
  return `${(cut > 0 ? truncated.slice(0, cut) : truncated.slice(0, STOCK_GOOSE_SESSION_NAME_MAX_TITLE_CHARS)).trimEnd()}…`;
}
