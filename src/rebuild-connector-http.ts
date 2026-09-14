import { timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";
import { canonicalJsonSha256 } from "./canonical-json";
import {
  preparePersistentRemoteToolResult,
  type PersistentRemoteDataClass,
} from "./persistent-remote-data";

const AUTH_FAILURE_BODY = '{"error":"unauthorized"}\n';
const SERVICE_FAILURE_BODY = '{"error":"connector_unavailable"}\n';
const MCP_PATH = "/mcp";
const authorityBrand: unique symbol = Symbol("connector-operation-authority");

export type ConnectorOperationClaimDecision =
  | { kind: "EXECUTE"; opRef: string; seq: number }
  | { kind: "ATTACH"; opRef: string; seq: number }
  | { kind: "REPLAY"; opRef: string; seq: number; outcome: "SUCCESS" | "FAILURE"; resultJson: string; nextOpRef: string }
  | { kind: "UNCERTAIN" | "CONFLICT" | "STALE" | "WRONG_TURN" | "UNKNOWN" | "OUT_OF_ORDER" | "BOUNDARY_REQUIRED" | "PROTOCOL_VIOLATION"; opRef: string; seq: number | null };

export type ConnectorMissingOperationDecision =
  | { kind: "UNCERTAIN"; matchingOpRefs: string[] }
  | { kind: "INVALID" | "PROTOCOL_VIOLATION" };

export interface ConnectorOperationAuthority {
  readonly [authorityBrand]: true;
  claimOperation(input: { turnRef: string; opRef: string; inputHash: string }): ConnectorOperationClaimDecision;
  classifyMissingOperationRef(turnRef: string, inputHash: string): ConnectorMissingOperationDecision;
  /** Return the already-bound durable input hash for replay/uncertainty reconciliation; never binds MINTED work. */
  boundOperationInputHash?: (turnRef: string, opRef: string) => string | null;
  /** Durably quarantine the remote turn after execution may have happened but terminal commit did not. */
  markUnreconciled(turnRef: string, reason: string): void;
  completeOperation(input: {
    turnRef: string;
    opRef: string;
    inputHash: string;
    outcome: "SUCCESS" | "FAILURE";
    resultJson: string;
    progressCheckpointJson?: string;
  }): { nextOpRef: string };
}

export function createConnectorOperationAuthority(methods: Omit<ConnectorOperationAuthority, typeof authorityBrand>): ConnectorOperationAuthority {
  return Object.freeze({ [authorityBrand]: true as const, ...methods });
}

export interface ConnectorRendezvousRequest {
  turnRef: string;
  opRef: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ConnectorRendezvousProgress {
  /** Proposed Goose projection progress, committed atomically with the operation terminal result. */
  checkpointJson: string;
  /** Make the already-observed next Goose stage usable only after durable atomic commit succeeds. */
  onCommitted(): void;
  /** Quarantine/reject that stage when durable atomic commit fails after local execution. */
  onCommitFailed(): void;
}

export interface ConnectorRendezvousResult {
  outcome: "SUCCESS" | "FAILURE";
  dataClass: PersistentRemoteDataClass;
  content: unknown;
  progress?: ConnectorRendezvousProgress;
}

export type ConnectorToolNameResolution =
  | { kind: "RESOLVED"; toolName: string }
  | { kind: "REJECT"; code: "TOOL_UNAVAILABLE" | "STAGE_UNAVAILABLE" | "TURN_UNCERTAIN" };

export interface RebuildConnectorGatewayOptions {
  authorizationFile: string;
  authority: ConnectorOperationAuthority;
  /** Resolve model-facing aliases against the exact live Goose function registry before broker claim. */
  resolveToolName?: (turnRef: string, requestedToolName: string) => ConnectorToolNameResolution;
  /** Capture the exact pre-tool assistant boundary and durably record it before any claim. */
  prepareAnswerBoundary?: (request: ConnectorRendezvousRequest) => Promise<void>;
  rendezvous: (request: ConnectorRendezvousRequest) => Promise<ConnectorRendezvousResult>;
}

export interface RebuildConnectorHttpServer {
  readonly hostname: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
  stop(): Promise<void>;
}

type StoredConnectorResult =
  | { ok: true; output: string }
  | { ok: false; code: "GOOSE_TOOL_FAILURE"; output: string }
  | { ok: false; code: "PERSISTENT_REMOTE_DATA_BLOCKED" };

type ConnectorToolResponse = StoredConnectorResult & {
  turn_ref: string;
  op_ref: string;
  next_op_ref?: string;
};

export function connectorOperationInputHash(toolName: string, args: Record<string, unknown>): string {
  return canonicalJsonSha256({ toolName, arguments: args });
}

function connectorToolNameCandidates(requestedToolName: string): string[] {
  const candidates = [requestedToolName];
  const separator = requestedToolName.lastIndexOf("__");
  if (separator > 0) {
    const unqualified = requestedToolName.slice(separator + 2);
    if (unqualified && unqualified !== requestedToolName) candidates.push(unqualified);
  }
  return candidates;
}

export function prepareConnectorTerminalResult(input: {
  outcome: "SUCCESS" | "FAILURE";
  dataClass: PersistentRemoteDataClass;
  content: unknown;
}): { outcome: "SUCCESS" | "FAILURE"; resultJson: string } {
  const remote = preparePersistentRemoteToolResult({ dataClass: input.dataClass, content: input.content });
  const stored: StoredConnectorResult = remote.decision === "block"
    ? { ok: false, code: "PERSISTENT_REMOTE_DATA_BLOCKED" }
    : input.outcome === "SUCCESS"
      ? { ok: true, output: remote.text }
      : { ok: false, code: "GOOSE_TOOL_FAILURE", output: remote.text };
  return { outcome: stored.ok ? "SUCCESS" : "FAILURE", resultJson: JSON.stringify(stored) };
}

function secureAuthorizationValue(path: string): string {
  if (!isAbsolute(path)) throw new Error("Connector authorization file must be absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Connector authorization file must be a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("Connector authorization file permissions are unsafe");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Connector authorization file is not owned by the current user");
  }
  const value = readFileSync(realpathSync(path), "utf8").trim();
  if (value.length < 32 || value.length > 4_096 || !/^Bearer\s+\S+$/.test(value)) {
    throw new Error("Connector authorization file has invalid content");
  }
  return value;
}

function authorized(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonResponse(body: string, status: number, extraHeaders: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function mcpResult(value: ConnectorToolResponse, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export function parseStoredResult(value: string): StoredConnectorResult {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Connector journal contains invalid terminal JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Connector journal contains invalid terminal result");
  }
  const result = parsed as Record<string, unknown>;
  if (result.ok === true && typeof result.output === "string") return { ok: true, output: result.output };
  if (result.ok === false && result.code === "GOOSE_TOOL_FAILURE" && typeof result.output === "string") {
    return { ok: false, code: "GOOSE_TOOL_FAILURE", output: result.output };
  }
  if (result.ok === false && result.code === "PERSISTENT_REMOTE_DATA_BLOCKED" && result.output === undefined) {
    return { ok: false, code: "PERSISTENT_REMOTE_DATA_BLOCKED" };
  }
  throw new Error("Connector journal contains an unsupported terminal result");
}


export function connectorStoredResultOutput(value: string): string {
  const result = parseStoredResult(value);
  return "output" in result ? result.output : "PERSISTENT_REMOTE_DATA_BLOCKED";
}

function claimError(turnRef: string, opRef: string, code: string): ReturnType<typeof mcpResult> {
  return mcpResult({
    ok: false,
    code: "GOOSE_TOOL_FAILURE",
    output: code,
    turn_ref: turnRef,
    op_ref: opRef,
  }, true);
}

export class RebuildConnectorGateway {
  private readonly boundaryPreparations = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<string, Promise<ReturnType<typeof mcpResult>>>();

  constructor(private readonly options: Omit<RebuildConnectorGatewayOptions, "authorizationFile">) {}

  async callTool(input: {
    turnRef: string;
    opRef?: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<ReturnType<typeof mcpResult>> {
    let toolName: string | null = null;
    if (input.opRef && this.options.authority.boundOperationInputHash) {
      const boundHash = this.options.authority.boundOperationInputHash(input.turnRef, input.opRef);
      if (boundHash) {
        const matches = connectorToolNameCandidates(input.toolName)
          .filter(candidate => connectorOperationInputHash(candidate, input.arguments) === boundHash);
        if (matches.length === 1) toolName = matches[0]!;
      }
    }
    if (!toolName && this.options.resolveToolName) {
      const resolution = this.options.resolveToolName(input.turnRef, input.toolName);
      if (resolution.kind === "REJECT") return claimError(input.turnRef, input.opRef ?? "", resolution.code);
      toolName = resolution.toolName;
    }
    toolName ??= input.toolName;
    const inputHash = connectorOperationInputHash(toolName, input.arguments);
    if (!input.opRef) {
      const missing = this.options.authority.classifyMissingOperationRef(input.turnRef, inputHash);
      return claimError(input.turnRef, "", missing.kind === "UNCERTAIN" ? "UNCERTAIN" : missing.kind);
    }

    let claim = this.options.authority.claimOperation({ turnRef: input.turnRef, opRef: input.opRef, inputHash });
    if (claim.kind === "BOUNDARY_REQUIRED") {
      if (!this.options.prepareAnswerBoundary) return claimError(input.turnRef, input.opRef, "BOUNDARY_REQUIRED");
      const request: ConnectorRendezvousRequest = {
        turnRef: input.turnRef,
        opRef: input.opRef,
        toolName,
        arguments: input.arguments,
      };
      let preparation = this.boundaryPreparations.get(input.opRef);
      if (!preparation) {
        preparation = this.options.prepareAnswerBoundary(request);
        this.boundaryPreparations.set(input.opRef, preparation);
        void preparation.finally(() => {
          if (this.boundaryPreparations.get(input.opRef!) === preparation) this.boundaryPreparations.delete(input.opRef!);
        }).catch(() => {});
      }
      try {
        await preparation;
      } catch {
        // Boundary observation/recording is pre-side-effect work. Failure never authorizes a claim;
        // a later redelivery may retry observation or find a boundary that was already committed.
        return claimError(input.turnRef, input.opRef, "BOUNDARY_REQUIRED");
      }
      claim = this.options.authority.claimOperation({ turnRef: input.turnRef, opRef: input.opRef, inputHash });
    }
    if (claim.kind === "REPLAY") {
      const stored = parseStoredResult(claim.resultJson);
      return mcpResult({ ...stored, turn_ref: input.turnRef, op_ref: input.opRef, next_op_ref: claim.nextOpRef }, claim.outcome === "FAILURE");
    }
    if (claim.kind === "ATTACH") {
      const existing = this.inFlight.get(input.opRef);
      // A live broker claim without a process-local promise is never permission to synthesize a
      // new execution. Treat the missing attachment as ambiguous and fail closed.
      return existing ?? claimError(input.turnRef, input.opRef, "UNCERTAIN");
    }
    if (claim.kind !== "EXECUTE") return claimError(input.turnRef, input.opRef, claim.kind);

    const execution = this.executeClaimed({
      turnRef: input.turnRef,
      opRef: input.opRef,
      toolName,
      arguments: input.arguments,
    }, inputHash);
    const response = execution.then(value => value.response);
    this.inFlight.set(input.opRef, response);
    void execution.then(value => {
      // A nonterminal execution remains attached in memory. The broker still owns a live CLAIMED
      // row, so same-process redelivery must converge on this same safe UNCERTAIN response rather
      // than fabricate a second execution or an ATTACH_UNAVAILABLE pseudo-state. Restart converts
      // the durable stale claim to UNCERTAIN and clears this process-local single-flight cache.
      if (value.terminalCommitted && this.inFlight.get(input.opRef!) === response) this.inFlight.delete(input.opRef!);
    }).catch(() => {});
    return response;
  }

  private async executeClaimed(request: ConnectorRendezvousRequest, inputHash: string): Promise<{
    response: ReturnType<typeof mcpResult>;
    terminalCommitted: boolean;
  }> {
    let result: ConnectorRendezvousResult;
    try {
      // Deliberately no HTTP-request AbortSignal: once CLAIMED is durable, client disconnect is
      // not permission to cancel or redispatch a possibly side-effecting Goose operation.
      result = await this.options.rendezvous(request);
    } catch {
      // Leave CLAIMED durable. Broker restart converts it to UNCERTAIN; never invent FAILURE for
      // an execution whose terminal side-effect status is unknown.
      return { response: claimError(request.turnRef, request.opRef, "UNCERTAIN"), terminalCommitted: false };
    }

    const prepared = prepareConnectorTerminalResult(result);
    const stored = parseStoredResult(prepared.resultJson);
    const outcome = prepared.outcome;
    let terminal: { nextOpRef: string };
    try {
      terminal = this.options.authority.completeOperation({
        turnRef: request.turnRef,
        opRef: request.opRef,
        inputHash,
        outcome,
        resultJson: prepared.resultJson,
        ...(result.progress ? { progressCheckpointJson: result.progress.checkpointJson } : {}),
      });
    } catch {
      // The rendezvous may already have caused a side effect. Preserve the old checkpoint + CLAIMED
      // liability, and make the turn-level quarantine durable before dropping the process-local stage.
      // If persistence itself is unavailable this still fails closed in memory; restart recovery is
      // the next authority and will sweep any stale CLAIMED operation to UNCERTAIN.
      try { this.options.authority.markUnreconciled(request.turnRef, "connector_terminal_commit_failed_after_execution"); } catch {}
      try { result.progress?.onCommitFailed(); } catch { /* preserve the stronger UNCERTAIN outcome */ }
      return { response: claimError(request.turnRef, request.opRef, "UNCERTAIN"), terminalCommitted: false };
    }

    try {
      // Durable truth is already committed. Activate the observed next HTTP stage before returning
      // success; if this in-memory step unexpectedly fails, redelivery must replay the terminal
      // broker result rather than pretending the durable commit failed.
      result.progress?.onCommitted();
    } catch {
      return { response: claimError(request.turnRef, request.opRef, "UNCERTAIN"), terminalCommitted: true };
    }
    return {
      response: mcpResult({ ...stored, turn_ref: request.turnRef, op_ref: request.opRef, next_op_ref: terminal.nextOpRef }, outcome === "FAILURE"),
      terminalCommitted: true,
    };
  }
}

function createMcpServer(gateway: RebuildConnectorGateway): McpServer {
  const server = new McpServer({ name: "goose-chatgpt-web-rebuild", version: "0.1.0" });
  server.registerTool("goose_tool", {
    title: "Run one Goose tool",
    description: "Dispatch exactly one broker-authorized Goose tool operation. Use the current turn_ref and op_ref exactly as provided by the provider, and set tool_name to one exact name from that provider turn's available_tool_names; never invent a tool name or reuse a newer op_ref.",
    inputSchema: {
      turn_ref: z.string().min(1).max(160),
      op_ref: z.string().min(1).max(160).optional(),
      tool_name: z.string().min(1).max(200),
      arguments: z.record(z.string(), z.unknown()),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ turn_ref, op_ref, tool_name, arguments: args }) => gateway.callTool({
    turnRef: turn_ref,
    ...(op_ref ? { opRef: op_ref } : {}),
    toolName: tool_name,
    arguments: args,
  }));
  return server;
}

export function createRebuildConnectorHttpHandler(options: RebuildConnectorGatewayOptions): (request: Request) => Promise<Response> {
  const gateway = new RebuildConnectorGateway({
    authority: options.authority,
    ...(options.resolveToolName ? { resolveToolName: options.resolveToolName } : {}),
    ...(options.prepareAnswerBoundary ? { prepareAnswerBoundary: options.prepareAnswerBoundary } : {}),
    rendezvous: options.rendezvous,
  });
  return async (request: Request): Promise<Response> => {
    let expected: string;
    try { expected = secureAuthorizationValue(options.authorizationFile); }
    catch { return jsonResponse(SERVICE_FAILURE_BODY, 503); }
    if (!authorized(request.headers.get("authorization"), expected)) return jsonResponse(AUTH_FAILURE_BODY, 401);

    const url = new URL(request.url);
    if (url.pathname !== MCP_PATH) return jsonResponse('{"error":"not_found"}\n', 404);
    if (request.method !== "POST") {
      return jsonResponse('{"error":"method_not_allowed"}\n', 405, { allow: "POST" });
    }

    const server = createMcpServer(gateway);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch {
      return jsonResponse(SERVICE_FAILURE_BODY, 500);
    } finally {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    }
  };
}

export function startRebuildConnectorHttpServer(options: RebuildConnectorGatewayOptions & { port: number }): RebuildConnectorHttpServer {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("Connector MCP port is invalid");
  }
  // Validate the secret before opening a listener. Request-time revalidation makes host-side
  // deletion/rotation fail closed without sharing the provider admin control token.
  secureAuthorizationValue(options.authorizationFile);
  const handler = createRebuildConnectorHttpHandler(options);
  const server = Bun.serve({ hostname: "127.0.0.1", port: options.port, idleTimeout: 0, fetch: handler });
  const port = server.port;
  if (typeof port !== "number") {
    server.stop(true);
    throw new Error("Connector MCP listener did not expose a numeric port");
  }
  return {
    hostname: "127.0.0.1",
    port,
    origin: `http://127.0.0.1:${port}`,
    stop: async () => { await server.stop(true); },
  };
}
