import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";

interface ClaimedTurn {
  bindingId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

const turnTokenSchema = z.string()
  .regex(/^turn_[A-Za-z0-9_-]{32}$/, "turn_token must be the exact turn_ value supplied in the current task context");
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
}): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

function exactUniqueTool(environment: ChatGptTurnEnvironment, name: string): CodexTool {
  const matches = environment.tools.filter(tool => !tool.namespace && tool.name === name);
  if (matches.length === 0) throw new Error(`This turn did not advertise the required Goose-native ${name} tool`);
  if (matches.length > 1) throw new Error(`This turn advertised an ambiguous Goose-native ${name} capability`);
  return matches[0]!;
}

function gooseDelegateTool(environment: ChatGptTurnEnvironment): CodexTool {
  const tool = exactUniqueTool(environment, "delegate");
  if (tool.freeform) throw new Error("The Goose-native delegate tool must use a structured function schema");
  const properties = tool.parameters?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("The Goose-native delegate tool did not advertise a structured properties schema");
  }
  for (const field of ["provider", "model", "instructions"] as const) {
    if (!(field in properties)) throw new Error(`The Goose-native delegate tool does not advertise required field: ${field}`);
  }
  return tool;
}

function namedTool(environment: ChatGptTurnEnvironment, requestedWireName: string): CodexTool {
  const tool = environment.tools.find(candidate => wireName(candidate) === requestedWireName);
  if (!tool) throw new Error(`Tool is not available in this turn: ${requestedWireName}`);
  return tool;
}

function invocationTimeout(environment: ChatGptTurnEnvironment & { expiresAt?: number }): number | null {
  return environment.expiresAt === undefined ? null : Math.max(1, environment.expiresAt - Date.now());
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
): string {
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return [
    `const result = await tools[${JSON.stringify(gatewayNestedToolName(nestedToolName))}](${JSON.stringify(nestedInput)});`,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

export async function runChatGptMcpServer(options: { brokerSocketPath: string }): Promise<void> {
  const server = new McpServer({ name: "goose-native", version: "4.0.0" });

  const claimTurn = async (
    toolName: string,
    turnToken: string,
    extra: Parameters<typeof requestScopeSummary>[0],
  ): Promise<ClaimedTurn> => {
    console.error(`[chatgpt-web-mcp] ${toolName} scope=${requestScopeSummary(extra)}`);
    const claimed = await callTurnBroker<ClaimedTurn>(options.brokerSocketPath, { method: "claim", token: turnToken });
    const expiresAt = claimed.environment.expiresAt;
    if (expiresAt !== undefined && expiresAt <= Date.now()) throw new Error("turn binding expired");
    return claimed;
  };

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => {
    const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
      method: "invoke",
      bindingId,
      wireName: wireName(tool),
      freeform: tool.freeform === true,
      ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
    }, invocationTimeout(bound));
    return asMcpResult(response);
  };

  const invokeNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => {
    const gateway = execGateway(bound);
    return gateway && gateway !== tool
      ? invoke(bindingId, bound, gateway, { input: execGatewayProgram(wireName(tool), tool.freeform === true, payload) })
      : invoke(bindingId, bound, tool, payload);
  };

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload),
    });
  };

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native outer-harness command",
      description: "Invoke the command tool advertised by the current outer harness (Codex or Goose). A long-running command returns its native session_id.",
      inputSchema: {
        turn_token: turnTokenSchema,
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, cmd, workdir, yield_time_ms, max_output_tokens, tty }, extra) => {
      const claimed = await claimTurn("codex_exec", turn_token, extra);
      const bound = claimed.environment;
      const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
      const commandName = tool?.name ?? "exec_command";
      const args = commandName === "exec_command"
        ? {
            cmd,
            ...(workdir ? { workdir } : {}),
            ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
            ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
            ...(tty !== undefined ? { tty } : {}),
          }
        : {
            command: cmd,
            ...(workdir ? { workdir } : {}),
            ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
          };
      return tool
        ? invokeNative(claimed.bindingId, bound, tool, { arguments: args })
        : invokeNestedNative(claimed.bindingId, bound, commandName, false, { arguments: args });
    },
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native outer-harness command session",
      description: "Write characters to, or poll, a session_id returned by codex_exec.",
      inputSchema: {
        turn_token: turnTokenSchema,
        session_id: z.number().int().nonnegative(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, session_id, chars, yield_time_ms, max_output_tokens }, extra) => {
      const claimed = await claimTurn("codex_write_stdin", turn_token, extra);
      const bound = claimed.environment;
      const tool = exactTool(bound, "write_stdin");
      const payload = { arguments: {
        session_id,
        ...(chars !== undefined ? { chars } : {}),
        ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
      } };
      return tool
        ? invokeNative(claimed.bindingId, bound, tool, payload)
        : invokeNestedNative(claimed.bindingId, bound, "write_stdin", false, payload);
    },
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native outer-harness patch",
      description: "Invoke the outer harness's apply_patch tool, producing a native file-change item in the task.",
      inputSchema: { turn_token: turnTokenSchema, patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ turn_token, patch }, extra) => {
      const claimed = await claimTurn("codex_apply_patch", turn_token, extra);
      const bound = claimed.environment;
      const tool = exactTool(bound, "apply_patch");
      if (!tool) return invokeNestedNative(claimed.bindingId, bound, "apply_patch", true, { input: patch });
      return tool.freeform
        ? invokeNative(claimed.bindingId, bound, tool, { input: patch })
        : invokeNative(claimed.bindingId, bound, tool, { arguments: { input: patch } });
    },
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through the native outer harness",
      description: "Invoke the outer harness's view_image tool and return its multimodal result to this same ChatGPT response.",
      inputSchema: {
        turn_token: turnTokenSchema,
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token, path, detail }, extra) => {
      const claimed = await claimTurn("codex_view_image", turn_token, extra);
      const bound = claimed.environment;
      const tool = exactTool(bound, "view_image");
      const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
      return tool
        ? invokeNative(claimed.bindingId, bound, tool, payload)
        : invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload);
    },
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current outer harness",
      description: "Search the exact tool registry supplied to the current outer-harness turn, including configured MCP/app tools.",
      inputSchema: {
        turn_token: turnTokenSchema,
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token, query, offset, limit, include_schema }, extra) => {
      const claimed = await claimTurn("codex_tool_inventory", turn_token, extra);
      const bound = claimed.environment;
      const needle = query?.trim().toLowerCase();
      const matches = bound.tools.filter(tool => !needle || [
        wireName(tool),
        tool.name,
        tool.namespace ?? "",
        tool.description,
      ].join("\n").toLowerCase().includes(needle));
      const page = matches.slice(offset, offset + limit).map(tool => ({
        wire_name: wireName(tool),
        name: tool.name,
        namespace: tool.namespace ?? null,
        description: tool.description,
        kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
        ...(include_schema ? { parameters: tool.parameters } : {}),
      }));
      return result({
        tools: page,
        total: matches.length,
        next_offset: offset + page.length < matches.length ? offset + page.length : null,
      });
    },
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current outer harness",
      description: "Invoke an exact wire_name returned by codex_tool_inventory. The outer harness performs the call, approvals, and UI lifecycle.",
      inputSchema: {
        turn_token: turnTokenSchema,
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, wire_name, arguments: args, input }, extra) => {
      const claimed = await claimTurn("codex_tool_call", turn_token, extra);
      const bound = claimed.environment;
      const tool = namedTool(bound, wire_name);
      if (tool.freeform) {
        if (input === undefined) throw new Error(`Freeform tool ${wire_name} requires input`);
        if (args && Object.keys(args).length > 0) throw new Error(`Freeform tool ${wire_name} does not accept arguments`);
        return invokeNative(claimed.bindingId, bound, tool, { input });
      }
      if (input !== undefined) throw new Error(`Function tool ${wire_name} does not accept freeform input`);
      return invokeNative(claimed.bindingId, bound, tool, { arguments: args ?? {} });
    },
  );


  server.registerTool(
    "goose_delegate",
    {
      title: "Delegate through Goose",
      description: "Delegate explicit instructions to the exact Goose-native delegate tool advertised by the current outer turn, forwarding the requested provider and model unchanged. Goose remains responsible for execution, provider access, approvals, and lifecycle.",
      inputSchema: {
        turn_token: turnTokenSchema,
        provider: z.string().min(1).max(1_000),
        model: z.string().min(1).max(4_000),
        instructions: z.string().min(1).max(5_000_000),
      },
      // Delegation can execute model-directed work outside this MCP server and is neither read-only
      // nor inherently idempotent. Keep the annotations truthful rather than weakening them for routing.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, provider, model, instructions }, extra) => {
      const claimed = await claimTurn("goose_delegate", turn_token, extra);
      const bound = claimed.environment;
      const tool = gooseDelegateTool(bound);
      return invoke(claimed.bindingId, bound, tool, {
        arguments: { provider, model, instructions },
      });
    },
  );
  await server.connect(new StdioServerTransport());
}
