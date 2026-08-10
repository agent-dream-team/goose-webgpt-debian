const STOCK_GOOSE_COMPACTION_USER_PROMPT = "Please summarize the conversation history provided in the system prompt.";

export const STOCK_GOOSE_COMPACTION_SYSTEM_PREFIX = `## Task Context
- An llm context limit was reached when a user was in a working session with an agent (you)
- Distill the conversation below into a structured summary with only the most verbose parts removed
- Include user requests, your responses, all technical content, and as much of the original context as possible
- This will be used to let the user continue the working session
- The summary will be read by an agent (you) on a next exchange to allow for continuation of the session

**Conversation History:**
`;

export const STOCK_GOOSE_COMPACTION_SYSTEM_TAIL = `

Wrap reasoning in \`<analysis>\` tags:
- Review conversation chronologically: user goals, your methods, key decisions, files, errors, fixes
- Keep this brief - the analysis is discarded, so it is a checklist of what to include, not the place for detail

After the closing \`</analysis>\` tag, output exactly one \`\`\`json code block and nothing else, matching this schema:

\`\`\`json
{
  "user_intent": ["every user goal and request, most important first"],
  "technical_concepts": ["all discussed tools, methods, and concepts"],
  "files": [
    {
      "path": "path of a file that was viewed or edited",
      "summary": "what was done to it and why",
      "key_code": "important code, signatures, or diffs from this file (omit if none)"
    }
  ],
  "errors_and_fixes": ["bugs hit, their resolutions, and user-driven changes"],
  "problem_solving": ["issues solved or in progress, and key decisions: what was chosen, what was rejected, and why"],
  "user_messages": ["all user messages, truncating long tool call arguments or results"],
  "pending_tasks": ["all unresolved user requests, most important first"],
  "current_work": "active work at summary request time: filenames, code, alignment to latest instruction",
  "next_step": "include only if it directly continues a user instruction, otherwise omit"
}
\`\`\`

Rules for the JSON:
- The \`<analysis>\` block is a discarded scratchpad: only the JSON survives, so it must be self-contained and repeat every detail from the analysis that matters for continuing
- Order every list from most to least important
- Every list entry must be a plain string, not a nested object - except \`files\`, whose entries are objects shaped as shown above
- Quote error messages, panic text, and failing test output verbatim in \`errors_and_fixes\` - exact strings including numbers, identifiers, and paths, not paraphrases
- This summary will only be read by you, so it is ok to make it much longer than a normal summary you would show to a human: spend your entire length budget on the JSON fields, and quote liberally - full output blocks, complete code snippets, exact user wording
- Do not exclude any information that might be important to continuing a session working with you
- Omit a field rather than inventing content for it
- No new ideas unless user confirmed`;

export { STOCK_GOOSE_COMPACTION_USER_PROMPT };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactInputTextMessage(value: unknown, role: "user"): string | undefined {
  const message = record(value);
  if (!message || (message.type !== undefined && message.type !== "message") || message.role !== role || !Array.isArray(message.content)) {
    return undefined;
  }
  if (message.content.length !== 1) return undefined;
  const block = record(message.content[0]);
  return block?.type === "input_text" && typeof block.text === "string" ? block.text : undefined;
}

/**
 * Recognize the current stock Goose `do_compact()` request after its ChatGPT Codex Responses
 * serialization. `complete_fast()` is shared by session naming and other lightweight tasks, so
 * absence of tools or low reasoning effort alone is not a discriminator.
 *
 * Current Goose serializes the rendered `compaction.md` as `instructions`, exactly one fixed user
 * message in `input`, `store: false`, a streaming request, no tools, and complete_fast's off/low
 * reasoning effort. Require that compound shape so ordinary no-tool lightweight completions remain
 * ordinary. Customized compaction templates intentionally do not match.
 */
export function isStockGooseCompactionRequestBody(value: unknown): boolean {
  const body = record(value);
  if (!body || body.stream !== true || body.store !== false || body.previous_response_id !== undefined) return false;
  if (body.tool_choice !== undefined || body.parallel_tool_calls !== undefined) return false;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) return false;

  if (body.reasoning !== undefined) {
    const reasoning = record(body.reasoning);
    if (!reasoning || (reasoning.effort !== "none" && reasoning.effort !== "low")) return false;
  }

  if (!Array.isArray(body.input) || body.input.length !== 1) return false;
  const user = exactInputTextMessage(body.input[0], "user");
  const system = body.instructions;
  return user === STOCK_GOOSE_COMPACTION_USER_PROMPT
    && typeof system === "string"
    && system.startsWith(STOCK_GOOSE_COMPACTION_SYSTEM_PREFIX)
    && system.trimEnd().endsWith(STOCK_GOOSE_COMPACTION_SYSTEM_TAIL.trimEnd())
    && system.length >= STOCK_GOOSE_COMPACTION_SYSTEM_PREFIX.length + STOCK_GOOSE_COMPACTION_SYSTEM_TAIL.length;
}
