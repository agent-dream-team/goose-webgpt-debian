import { createHash, timingSafeEqual } from "node:crypto";
import { readJsonRequestBody } from "./http-body";
import {
  conversationBudgetPolicyJson,
  estimatePersistentFinalTokens,
  estimatePersistentPromptTokens,
  estimatePersistentToolResultTokens,
  requiredPersistentFinalReserveTokens,
  resolveConversationBudgetPolicy,
  type ConversationBudgetPolicy,
} from "./conversation-budget";
import {
  advertisedGooseToolNames,
  GooseToolRendezvous,
  GooseToolRendezvousError,
  type GooseResponsesStageHandle,
} from "./goose-tool-rendezvous";
import {
  connectorOperationInputHash,
  connectorStoredResultOutput,
  createConnectorOperationAuthority,
  prepareConnectorTerminalResult,
  startRebuildConnectorHttpServer,
  type RebuildConnectorHttpServer,
} from "./rebuild-connector-http";
import { ChatGptUpstreamTerminalError } from "./chatgpt-terminal-state";
import { decodeGooseResponsesProjectionCheckpoint, encodeGooseResponsesProjectionCheckpoint, gooseResponsesProjectionCheckpoint } from "./goose-responses-projection";
import {
  classifyGooseCanonicalHistory,
  encodeGooseCanonicalHistoryWatermark,
  renderGoosePersistentPrompt,
} from "./goose-canonical-history";
import { buildRebuildResponsesSse, rebuildResponsesSseResponse } from "./rebuild-responses-sse";
import { VERSION } from "./version";
import {
  normalizeCanonicalChatGptConversationId,
  validatePersistentChatTurnIdentity,
} from "./persistent-chat-surface";
import {
  SessionBroker,
  SessionBrokerError,
  type BrokerTurn,
  type PositiveTerminalEvidence,
  type RemoteEpoch,
} from "./session-broker";

export const REBUILD_PROVIDER_SERVICE = "goose-chatgpt-web-rebuild";
// Hosted connector transport-loss redelivery has repeatedly appeared around 121s. Keep exact
// terminal results replayable across two such intervals plus margin; replay never re-executes.
export const REBUILD_TERMINAL_REPLAY_WINDOW_MS = 5 * 60_000;
const SESSION_ID_MAX = 256;
const POLL_MS = 25;
const COMPLETED_RESPONSE_CACHE_LIMIT = 128;

export interface RebuildBrowserAcceptedEvidence {
  canonicalConversationId: string;
  acceptedUserTurnId: string;
}

export interface RebuildBrowserFinalEvidence extends RebuildBrowserAcceptedEvidence {
  text: string;
  remoteNonRunning: true;
  /** Required when the latest connector operation has a durable answer boundary. */
  contentAdvancedAfterLastTool?: boolean;
  qualifiedTerminalAfterLastTool?: boolean;
}

export interface RebuildBrowserTurnLifecycle {
  /** Called immediately before the irreversible browser send; browser execution waits for durable acknowledgement. */
  onSendActivated(): void | Promise<void>;
  /** Called only after semantic submission + canonical conversation/user-turn identity are proven. */
  onAccepted(evidence: RebuildBrowserAcceptedEvidence): void | Promise<void>;
}

export interface RebuildPersistentBrowserTurnInput {
  turnRef: string;
  gooseSessionId: string;
  epoch: number;
  initialOpRef: string;
  submitNonce: string;
  prompt: string;
  existingConversationId: string | null;
  preSendAbortSignal: AbortSignal;
  gooseWork: { isToolWorkInFlight(): boolean };
  lifecycle: RebuildBrowserTurnLifecycle;
}

export interface RebuildPersistentBrowserTurnExecution {
  /** Called after the runtime has registered the execution and Goose Responses stage. */
  run(): Promise<RebuildBrowserFinalEvidence>;
  /** Force a fresh final observation after the broker completion claim is durably established. */
  confirmFinal(candidate: RebuildBrowserFinalEvidence): Promise<RebuildBrowserFinalEvidence>;
  /** Must freshly observe the exact persistent surface after qualified renderer catch-up/quiescence. */
  captureAnswerBoundary(opRef: string): Promise<string>;
}

export interface RebuildPersistentBrowserDriver {
  createTurn(input: RebuildPersistentBrowserTurnInput): RebuildPersistentBrowserTurnExecution;
}

export interface RebuildProviderRuntimeOptions {
  hostname?: "127.0.0.1";
  port: number;
  model: string;
  contextWindow: number;
  controlToken: string;
  projectId: string;
  connectorIdentity: string;
  brokerPath: string;
  terminalReplayWindowMs?: number;
  conversationBudgetPolicy?: Partial<ConversationBudgetPolicy>;
  connectorPort: number;
  connectorAuthorizationFile: string;
  browserDriver: RebuildPersistentBrowserDriver;
  onStopped?: () => void;
}

export interface RebuildProviderRuntime {
  readonly hostname: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
  readonly connector: RebuildConnectorHttpServer;
  readonly broker: SessionBroker;
  stop(): Promise<void>;
}

interface ActiveExecution {
  turnRef: string;
  browser: RebuildPersistentBrowserTurnExecution;
  preSendAbort: AbortController;
  sendActivated: boolean;
  latestBoundaryOpRef: string | null;
  final: Promise<string>;
}

interface CompletedResponse {
  turnRef: string;
  requestHash: string;
  sse: string;
}

function validSessionId(value: string | null): value is string {
  return value !== null
    && value.length > 0
    && value.length <= SESSION_ID_MAX
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeEqualBearer(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && timingSafeEqual(left, right);
}

function finalDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function deterministicResponseId(turnRef: string, stage: string): string {
  return `resp_${createHash("sha256").update(`${turnRef}:${stage}`).digest("hex").slice(0, 32)}`;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { type: "server_error", code, message } }, { status });
}

function abortError(): DOMException {
  return new DOMException("Goose Responses request disconnected", "AbortError");
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done(abortError());
    function done(error?: unknown) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function startRebuildProviderRuntime(options: RebuildProviderRuntimeOptions): RebuildProviderRuntime {
  const hostname = options.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1") throw new Error("Rebuild provider must bind IPv4 loopback only");
  if (!options.controlToken) throw new Error("Rebuild provider control token is required");

  const conversationBudgetPolicy = resolveConversationBudgetPolicy(options.conversationBudgetPolicy);
  const budgetPolicyJson = conversationBudgetPolicyJson(conversationBudgetPolicy);
  const broker = new SessionBroker(options.brokerPath, {
    projectId: options.projectId,
    terminalReplayWindowMs: options.terminalReplayWindowMs ?? REBUILD_TERMINAL_REPLAY_WINDOW_MS,
    conversationBudgetPolicy,
  });
  const baton = new GooseToolRendezvous({ loadCheckpoint: turnRef => broker.getTurn(turnRef)?.checkpointJson ?? null });
  const executions = new Map<string, ActiveExecution>();
  const toolActivityByTurn = new Map<string, number>();
  const beginToolActivity = (turnRef: string) => {
    toolActivityByTurn.set(turnRef, (toolActivityByTurn.get(turnRef) ?? 0) + 1);
  };
  const endToolActivity = (turnRef: string) => {
    const next = (toolActivityByTurn.get(turnRef) ?? 1) - 1;
    if (next <= 0) toolActivityByTurn.delete(turnRef);
    else toolActivityByTurn.set(turnRef, next);
  };
  // Keep only the latest completed transport payload per Goose session. Active executions, raw
  // request bodies, browser closures, and tool literals are released as soon as the turn ends.
  const completedResponses = new Map<string, CompletedResponse>();
  let draining = false;
  let activeHttpTurns = 0;
  let stopped = false;

  const authority = createConnectorOperationAuthority({
    claimOperation: input => broker.claimOperation(input),
    classifyMissingOperationRef: (turnRef, inputHash) => broker.classifyMissingOperationRef(turnRef, inputHash),
    boundOperationInputHash: (turnRef, opRef) => {
      const op = broker.getOperation(opRef);
      return op?.turnRef === turnRef ? op.inputHash : null;
    },
    markUnreconciled: (turnRef, reason) => { broker.markUnreconciled(turnRef, reason); },
    rejectOperationForBudget: input => broker.rejectOperationForBudget(input),
    completeOperation: input => input.progressCheckpointJson === undefined
      ? broker.completeOperation(input)
      : broker.completeOperationWithProgress({ ...input, checkpointJson: input.progressCheckpointJson }),
  });

  const connector = startRebuildConnectorHttpServer({
    port: options.connectorPort,
    authorizationFile: options.connectorAuthorizationFile,
    authority,
    resolveToolName: (turnRef, requestedToolName) => {
      try {
        return { kind: "RESOLVED", toolName: baton.resolveToolName(turnRef, requestedToolName) };
      } catch (error) {
        const code = error instanceof GooseToolRendezvousError ? error.code : "TOOL_UNAVAILABLE";
        // Tool name is safe operational metadata; never log arguments or connector result content.
        // A rejected name happens before broker claim, so this gives deterministic evidence for
        // model/tool-registry mismatches without widening execution authority.
        console.warn(JSON.stringify({
          event: "rebuild.connector_tool_name_rejected",
          turn_ref: turnRef,
          requested_tool_name: requestedToolName,
          code,
          detail: error instanceof Error ? error.message : String(error),
        }));
        if (code === "TURN_UNCERTAIN" || code === "STAGE_UNAVAILABLE") return { kind: "REJECT", code };
        return { kind: "REJECT", code: "TOOL_UNAVAILABLE" };
      }
    },
    prepareAnswerBoundary: async request => {
      const active = executions.get(request.turnRef);
      if (!active) throw new Error("Persistent browser execution is unavailable for answer-boundary preparation");
      const boundaryJson = await active.browser.captureAnswerBoundary(request.opRef);
      broker.recordAnswerBoundary(request.turnRef, request.opRef, boundaryJson);
      active.latestBoundaryOpRef = request.opRef;
    },
    rendezvous: async request => {
      beginToolActivity(request.turnRef);
      let released = false;
      const releaseActivity = () => {
        if (released) return;
        released = true;
        endToolActivity(request.turnRef);
      };
      try {
        const continuation = await baton.dispatchTool(request);
        return {
          outcome: "SUCCESS",
          dataClass: "task",
          content: continuation.output,
          progress: {
            checkpointJson: continuation.checkpointJson,
            onCommitted: () => {
              try { continuation.commit(); } finally { releaseActivity(); }
            },
            onCommitFailed: () => {
              try { continuation.abort(); } finally { releaseActivity(); }
            },
          },
        };
      } catch (error) {
        releaseActivity();
        throw error;
      }
    },
  });

  const ensureEpoch = (sessionId: string): RemoteEpoch => {
    const current = broker.getCurrentEpoch(sessionId);
    if (!current) return broker.createEpoch({ gooseSessionId: sessionId });
    if (current.budgetPolicyJson !== budgetPolicyJson || current.budgetConsumedTokens === null) {
      return broker.createEpoch({ gooseSessionId: sessionId });
    }
    return current;
  };

  const durableToolResult = (opRef: string): string => {
    const operation = broker.getOperation(opRef);
    if (!operation || (operation.state !== "SUCCESS" && operation.state !== "FAILURE") || !operation.resultJson) {
      throw new Error(`Canonical epoch seed cannot resolve durable connector result for ${opRef}`);
    }
    return connectorStoredResultOutput(operation.resultJson);
  };

  const startExecution = (
    turn: BrokerTurn,
    initialOpRef: string,
    body: unknown,
    requestSignal: AbortSignal,
    advertisedToolNames: readonly string[],
  ): ActiveExecution => {
    const existing = executions.get(turn.turnRef);
    if (existing) return existing;
    const epoch = broker.getCurrentEpoch(turn.gooseSessionId);
    if (!epoch || epoch.epoch !== turn.epoch) throw new Error("Broker current epoch does not match admitted turn");
    const history = classifyGooseCanonicalHistory(body, epoch.historyWatermark);
    if (epoch.conversationId && history.kind !== "APPEND") {
      throw new Error("Broker epoch history is not append-compatible with its bound conversation");
    }
    if (!epoch.conversationId && history.kind !== "SEED") {
      throw new Error("Fresh broker epoch did not produce a canonical seed projection");
    }
    const prompt = renderGoosePersistentPrompt({
      turnRef: turn.turnRef,
      submitNonce: turn.submitNonce,
      opRef: initialOpRef,
      mode: history.kind === "APPEND" ? "append" : "seed",
      connectorIdentity: options.connectorIdentity,
      availableToolNames: advertisedToolNames,
      items: history.items,
      resolveDurableToolResult: durableToolResult,
    });
    if (turn.budgetPromptTokens !== null
      && estimatePersistentPromptTokens(prompt, options.model) !== turn.budgetPromptTokens) {
      throw new Error("Durable conversation-budget prompt estimate drifted before browser execution");
    }
    const preSendAbort = new AbortController();
    let sendActivated = false;
    let active!: ActiveExecution;
    const browser = options.browserDriver.createTurn({
      turnRef: turn.turnRef,
      gooseSessionId: turn.gooseSessionId,
      epoch: turn.epoch,
      initialOpRef,
      submitNonce: turn.submitNonce,
      prompt,
      existingConversationId: epoch.conversationId,
      preSendAbortSignal: preSendAbort.signal,
      gooseWork: { isToolWorkInFlight: () => (toolActivityByTurn.get(turn.turnRef) ?? 0) > 0 },
      lifecycle: {
        onSendActivated: () => {
          if (preSendAbort.signal.aborted) throw abortError();
          broker.markSendActivated(turn.turnRef);
          sendActivated = true;
          if (active) active.sendActivated = true;
        },
        onAccepted: evidence => {
          if (!sendActivated) throw new Error("Browser acceptance cannot precede durable send activation");
          const conversationId = normalizeCanonicalChatGptConversationId(evidence.canonicalConversationId);
          const acceptedUserTurnId = validatePersistentChatTurnIdentity(evidence.acceptedUserTurnId, "accepted user turn");
          broker.bindConversation({
            gooseSessionId: turn.gooseSessionId,
            epoch: turn.epoch,
            conversationId,
          });
          broker.markAccepted(turn.turnRef, acceptedUserTurnId);
        },
      },
    });
    active = {
      turnRef: turn.turnRef,
      browser,
      preSendAbort,
      sendActivated,
      latestBoundaryOpRef: null,
      final: Promise.resolve("") as Promise<string>,
    };
    executions.set(turn.turnRef, active);

    const onInitialDisconnect = () => {
      if (!active.sendActivated) preSendAbort.abort(abortError());
    };
    requestSignal.addEventListener("abort", onInitialDisconnect, { once: true });
    if (requestSignal.aborted) onInitialDisconnect();
    active.final = Promise.resolve()
      .then(() => browser.run())
      .then(async evidence => {
        const conversationId = normalizeCanonicalChatGptConversationId(evidence.canonicalConversationId);
        const acceptedUserTurnId = validatePersistentChatTurnIdentity(evidence.acceptedUserTurnId, "accepted user turn");
        const current = broker.getTurn(turn.turnRef);
        if (!current) throw new Error("Broker turn disappeared before browser completion");
        const currentEpoch = broker.getCurrentEpoch(turn.gooseSessionId);
        if (!currentEpoch
          || currentEpoch.epoch !== turn.epoch
          || currentEpoch.conversationId !== conversationId
          || current.acceptedUserTurnId !== acceptedUserTurnId) {
          throw new Error("Browser final identity does not match durable broker identity");
        }
        if (evidence.remoteNonRunning !== true) {
          throw new Error("Browser final evidence is incomplete");
        }
        const digest = finalDigest(evidence.text);
        broker.recordFinalDigest(turn.turnRef, digest);
        const claim = broker.beginCompletion(turn.turnRef);
        const confirmed = await browser.confirmFinal(evidence);
        const confirmedConversationId = normalizeCanonicalChatGptConversationId(confirmed.canonicalConversationId);
        const confirmedUserTurnId = validatePersistentChatTurnIdentity(confirmed.acceptedUserTurnId, "accepted user turn");
        if (confirmedConversationId !== conversationId
          || confirmedUserTurnId !== acceptedUserTurnId
          || confirmed.remoteNonRunning !== true
          || finalDigest(confirmed.text) !== digest) {
          throw new Error("Fresh browser final confirmation does not match the completion candidate");
        }
        const confirmedTurn = broker.getTurn(turn.turnRef);
        if (!confirmedTurn?.checkpointJson) throw new Error("Broker projection checkpoint disappeared before completion");
        broker.commitCompletion(claim, {
          // Gate E has not yet qualified a connector-final digest/summary acknowledgement.
          // The local browser-final digest is durable, but it must not borrow that separate authority.
          connectorFinal: "UNAVAILABLE",
          canonicalConversationId: confirmedConversationId,
          acceptedUserTurnId: confirmedUserTurnId,
          noUnresolvedGooseWork: true,
          remoteNonRunning: true,
          observedFinalDigest: digest,
          canonicalHistoryWatermark: encodeGooseCanonicalHistoryWatermark({
            checkpoint: decodeGooseResponsesProjectionCheckpoint(confirmedTurn.checkpointJson),
            finalAssistantText: confirmed.text,
          }),
          budgetFinalTokens: estimatePersistentFinalTokens(confirmed.text, options.model),
          answerBoundary: active.latestBoundaryOpRef
            ? {
                opRef: active.latestBoundaryOpRef,
                contentAdvanced: confirmed.contentAdvancedAfterLastTool === true,
                ...(confirmed.qualifiedTerminalAfterLastTool === true ? { qualifiedTerminal: true } : {}),
              }
            : null,
        });
        const finalSse = buildRebuildResponsesSse({
          model: options.model,
          text: confirmed.text,
          id: deterministicResponseId(turn.turnRef, "final"),
        });
        completedResponses.delete(turn.gooseSessionId);
        completedResponses.set(turn.gooseSessionId, {
          turnRef: turn.turnRef,
          requestHash: turn.requestHash,
          sse: finalSse,
        });
        while (completedResponses.size > COMPLETED_RESPONSE_CACHE_LIMIT) {
          const oldestSession = completedResponses.keys().next().value as string | undefined;
          if (oldestSession === undefined) break;
          completedResponses.delete(oldestSession);
        }
        return finalSse;
      })
      .catch(error => {
        const current = broker.getTurn(turn.turnRef);
        if (current?.state === "QUEUED") {
          // No irreversible send fence was armed. Local preparation failure or transport-owner
          // loss can therefore free the slot and permit an exact fresh attempt without resend risk.
          try { broker.cancelRetryableBeforeSend(turn.turnRef); } catch {}
        } else if (current?.state === "TURN_OUTSTANDING") {
          try { broker.markUnreconciled(turn.turnRef, "persistent_browser_turn_failed"); } catch {}
        }
        if (executions.get(turn.turnRef) === active) executions.delete(turn.turnRef);
        throw error;
      })
      .finally(() => {
        requestSignal.removeEventListener("abort", onInitialDisconnect);
        if (executions.get(turn.turnRef) === active) executions.delete(turn.turnRef);
      });
    return active;
  };

  const waitForAdmission = async (turnRef: string, signal: AbortSignal) => {
    for (;;) {
      if (signal.aborted) throw abortError();
      const turn = broker.getTurn(turnRef);
      if (!turn) throw new Error("Queued broker turn disappeared");
      if (turn.state === "UNRECONCILED") throw new Error("Broker turn is unreconciled");
      if (turn.state !== "QUEUED") {
        throw new Error(`Broker turn left the admission queue unexpectedly (${turn.state})`);
      }
      // admitNext is globally FIFO. Another request may observe that an older queued turn won the
      // slot; this waiter never executes that other turn and simply waits for its own turn.
      const admitted = broker.admitNext();
      if (admitted?.turn.turnRef === turnRef) return admitted;
      await sleep(POLL_MS, signal);
    }
  };

  const serveStage = async (
    stage: GooseResponsesStageHandle,
    active: ActiveExecution,
    requestSignal: AbortSignal,
  ): Promise<Response> => {
    let abortReject!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { abortReject = reject; });
    const onAbort = () => {
      stage.releaseBeforeDispatch();
      abortReject(abortError());
    };
    requestSignal.addEventListener("abort", onAbort, { once: true });
    if (requestSignal.aborted) onAbort();
    try {
      const outcome = await Promise.race([
        stage.waitForDirective().then(directive => ({ kind: "tool" as const, directive })),
        active.final.then(text => ({ kind: "final" as const, text })),
        aborted,
      ]);
      if (outcome.kind === "tool") {
        return rebuildResponsesSseResponse(buildRebuildResponsesSse({
          model: options.model,
          id: deterministicResponseId(stage.turnRef, `tool:${outcome.directive.opRef}`),
          toolCall: {
            callId: outcome.directive.opRef,
            name: outcome.directive.toolName,
            argumentsJson: outcome.directive.argumentsJson,
          },
        }));
      }
      stage.releaseBeforeDispatch();
      return rebuildResponsesSseResponse(outcome.text);
    } catch (error) {
      stage.releaseBeforeDispatch();
      throw error;
    } finally {
      requestSignal.removeEventListener("abort", onAbort);
    }
  };

  const handleResponses = async (request: Request): Promise<Response> => {
    const sessionId = request.headers.get("agent-session-id");
    if (!validSessionId(sessionId)) return jsonError(400, "invalid_agent_session_id", "One valid agent-session-id header is required");
    const body = await readJsonRequestBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || (body as Record<string, unknown>).stream !== true) {
      return jsonError(400, "invalid_responses_request", "Rebuild provider requires a streamed Responses request object");
    }
    const record = body as Record<string, unknown>;
    if (record.model !== options.model) {
      return jsonError(400, "unsupported_model", "Responses request model does not match this rebuild provider");
    }
    if (record.max_output_tokens !== undefined) {
      if (!Number.isSafeInteger(record.max_output_tokens) || Number(record.max_output_tokens) <= 0) {
        return jsonError(400, "invalid_responses_request", "Responses max_output_tokens must be a positive safe integer");
      }
      if (requiredPersistentFinalReserveTokens(Number(record.max_output_tokens))
        > conversationBudgetPolicy.finalResponseReserveTokens) {
        return jsonError(409, "conversation_budget_output_reserve",
          "Responses max_output_tokens exceeds the configured persistent final-response reserve");
      }
    }
    const checkpoint = gooseResponsesProjectionCheckpoint(body);
    let turn = broker.getOpenTurnForSession(sessionId);

    // A pre-send turn may be safely re-admitted under a newly tightened/calibrated budget policy.
    // Once send activation occurs, its persisted epoch policy remains the accounting authority.
    if (turn?.state === "QUEUED") {
      const queuedEpoch = broker.getCurrentEpoch(sessionId);
      if (!queuedEpoch || queuedEpoch.epoch !== turn.epoch
        || queuedEpoch.budgetPolicyJson !== budgetPolicyJson || queuedEpoch.budgetConsumedTokens === null) {
        broker.cancelRetryableBeforeSend(turn.turnRef);
        turn = null;
      }
    }

    if (turn?.state === "UNRECONCILED") {
      return jsonError(409, "turn_unreconciled", "The persistent remote turn requires explicit recovery before more Goose work");
    }
    if (turn?.state === "TURN_OUTSTANDING") {
      const active = executions.get(turn.turnRef);
      if (!active) return jsonError(409, "turn_execution_unavailable", "Outstanding browser execution is unavailable in this provider process");
      const stage = baton.openStage({ turnRef: turn.turnRef, body });
      return await serveStage(stage, active, request.signal);
    }
    if (turn?.state === "QUEUED" && turn.requestHash !== checkpoint.requestHash) {
      return jsonError(409, "queued_request_conflict", "Queued Goose turn has a different canonical request projection");
    }

    if (!turn) {
      const replayTurn = broker.findInitialRequestReplay(sessionId, checkpoint.requestHash);
      if (replayTurn) {
        if (replayTurn.state === "COMPLETE") {
          const replay = completedResponses.get(sessionId);
          return !replay || replay.turnRef !== replayTurn.turnRef || replay.requestHash !== checkpoint.requestHash
            ? jsonError(409, "completed_response_unavailable", "Completed response body is no longer available in this process")
            : rebuildResponsesSseResponse(replay.sse);
        }
        if (replayTurn.state === "CANCELLED" || replayTurn.state === "ABANDONED") {
          return jsonError(409, "turn_terminal", "This exact logical Responses request is already terminal and cannot be re-executed");
        }
      }

      let epoch = ensureEpoch(sessionId);
      if (epoch.conversationId) {
        const history = epoch.historyWatermark
          ? classifyGooseCanonicalHistory(body, epoch.historyWatermark)
          : { kind: "ROLLOVER" as const, reason: "bound_epoch_missing_history_watermark", items: [] };
        if (history.kind !== "APPEND") epoch = broker.createEpoch({ gooseSessionId: sessionId });
      }
      const admissionToolNames = [...advertisedGooseToolNames(body)];
      const enqueueBudgetedTurn = () => broker.enqueueTurn({
        gooseSessionId: sessionId,
        requestHash: checkpoint.requestHash,
        checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
        budgetPromptTokens: identity => {
          const history = classifyGooseCanonicalHistory(body, identity.epoch.historyWatermark);
          if (identity.epoch.conversationId && history.kind !== "APPEND") {
            throw new Error("Budget admission found a non-append projection on a bound epoch");
          }
          if (!identity.epoch.conversationId && history.kind !== "SEED") {
            throw new Error("Budget admission found a non-seed projection on a fresh epoch");
          }
          const prompt = renderGoosePersistentPrompt({
            turnRef: identity.turnRef,
            submitNonce: identity.submitNonce,
            opRef: identity.initialOpRef,
            mode: history.kind === "APPEND" ? "append" : "seed",
            connectorIdentity: options.connectorIdentity,
            availableToolNames: admissionToolNames,
            items: history.items,
            resolveDurableToolResult: durableToolResult,
          });
          return estimatePersistentPromptTokens(prompt, options.model);
        },
      });
      try {
        turn = enqueueBudgetedTurn();
      } catch (error) {
        if (!(error instanceof SessionBrokerError) || error.code !== "BUDGET_ROLLOVER_REQUIRED"
          || !epoch.conversationId) throw error;
        epoch = broker.createEpoch({ gooseSessionId: sessionId });
        try {
          turn = enqueueBudgetedTurn();
        } catch (freshError) {
          if (freshError instanceof SessionBrokerError && freshError.code === "BUDGET_ROLLOVER_REQUIRED") {
            throw new SessionBrokerError(
              "BUDGET_INPUT_TOO_LARGE",
              "Current canonical Goose projection cannot fit the configured fresh-conversation reserve-first budget",
            );
          }
          throw freshError;
        }
      }
    }

    let admitted: ReturnType<SessionBroker["admitNext"]>;
    try {
      admitted = await waitForAdmission(turn.turnRef, request.signal);
    } catch (error) {
      if (request.signal.aborted && broker.getTurn(turn.turnRef)?.state === "QUEUED") {
        try { broker.cancelRetryableBeforeSend(turn.turnRef); } catch {}
      }
      throw error;
    }
    if (!admitted) throw new Error("Admission returned no turn");
    if (request.signal.aborted) {
      if (broker.getTurn(turn.turnRef)?.state === "QUEUED") {
        try { broker.cancelRetryableBeforeSend(turn.turnRef); } catch {}
      }
      throw abortError();
    }
    const stage = baton.openStage({ turnRef: turn.turnRef, body });
    let active: ActiveExecution;
    try {
      active = startExecution(turn, admitted.initialOpRef, body, request.signal, stage.advertisedToolNames);
    } catch (error) {
      stage.releaseBeforeDispatch();
      const current = broker.getTurn(turn.turnRef);
      if (current?.state === "QUEUED") {
        try { broker.cancelRetryableBeforeSend(turn.turnRef); } catch {}
      } else if (current?.state === "TURN_OUTSTANDING") {
        try { broker.markUnreconciled(turn.turnRef, "persistent_browser_turn_construction_failed_after_send_activation"); } catch {}
      }
      throw error;
    }
    return await serveStage(stage, active, request.signal);
  };

  let server!: ReturnType<typeof Bun.serve>;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    draining = true;
    await connector.stop().catch(() => {});
    broker.close();
    if (server) await server.stop(true);
    options.onStopped?.();
  };

  server = Bun.serve({
    hostname,
    port: options.port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: REBUILD_PROVIDER_SERVICE,
          version: VERSION,
          mode: "full",
          pid: process.pid,
          port: server.port,
          accepting_turns: !draining,
          active_http_turns: activeHttpTurns,
          active_browser_turns: broker.getAccountSlotHolder() ? 1 : 0,
        });
      }
      if (request.method === "POST" && url.pathname === "/admin/reconcile-operation") {
        if (!safeEqualBearer(request.headers.get("authorization") ?? "", options.controlToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
        let body: unknown;
        try { body = await readJsonRequestBody(request); } catch {
          return jsonError(400, "invalid_recovery_request", "Recovery request body must be valid JSON");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonError(400, "invalid_recovery_request", "Recovery request must be an object");
        }
        const recovery = body as Record<string, unknown>;
        const turnRef = recovery.turn_ref;
        const opRef = recovery.op_ref;
        const toolName = recovery.tool_name;
        const args = recovery.arguments;
        const outcome = recovery.outcome;
        const dataClass = recovery.data_class;
        if (typeof turnRef !== "string" || !turnRef || typeof opRef !== "string" || !opRef
          || typeof toolName !== "string" || !toolName || !args || typeof args !== "object" || Array.isArray(args)
          || (outcome !== "SUCCESS" && outcome !== "FAILURE")
          || (dataClass !== "task" && dataClass !== "public" && dataClass !== "sensitive")) {
          return jsonError(400, "invalid_recovery_request", "Recovery request has invalid operation evidence");
        }
        if (executions.has(turnRef) || toolActivityByTurn.has(turnRef)) {
          return jsonError(409, "recovery_owner_active", "Process-local turn/tool ownership must be gone before operator reconciliation");
        }
        const inputHash = connectorOperationInputHash(toolName, args as Record<string, unknown>);
        const prepared = prepareConnectorTerminalResult({ outcome, dataClass, content: recovery.content });
        try {
          const terminal = broker.reconcileKnownOperationTerminal({
            turnRef,
            opRef,
            inputHash,
            outcome: prepared.outcome,
            resultJson: prepared.resultJson,
            budgetChargeTokens: estimatePersistentToolResultTokens(prepared.resultJson, options.model),
          });
          return Response.json({
            status: "ok",
            turn_ref: turnRef,
            op_ref: opRef,
            operation_state: terminal.operation.state,
            next_op_ref: terminal.nextOpRef,
          });
        } catch (error) {
          if (error instanceof SessionBrokerError) {
            return Response.json({ status: "rejected", code: error.code }, { status: 409 });
          }
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/admin/abandon-unreconciled") {
        if (!safeEqualBearer(request.headers.get("authorization") ?? "", options.controlToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
        let body: unknown;
        try { body = await readJsonRequestBody(request); } catch {
          return jsonError(400, "invalid_recovery_request", "Recovery request body must be valid JSON");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonError(400, "invalid_recovery_request", "Recovery request must be an object");
        }
        const recovery = body as Record<string, unknown>;
        const turnRef = recovery.turn_ref;
        const evidenceValue = recovery.positive_terminal_evidence;
        if (typeof turnRef !== "string" || !turnRef || !evidenceValue || typeof evidenceValue !== "object" || Array.isArray(evidenceValue)) {
          return jsonError(400, "invalid_recovery_request", "Abandon request requires turn_ref and positive_terminal_evidence");
        }
        const rawEvidence = evidenceValue as Record<string, unknown>;
        let evidence: PositiveTerminalEvidence;
        try {
          evidence = {
            canonicalConversationId: normalizeCanonicalChatGptConversationId(
              typeof rawEvidence.canonical_conversation_id === "string" ? rawEvidence.canonical_conversation_id : "",
            ),
            acceptedUserTurnId: validatePersistentChatTurnIdentity(
              typeof rawEvidence.accepted_user_turn_id === "string" ? rawEvidence.accepted_user_turn_id : "",
              "accepted user turn",
            ),
            remoteUiNonRunningAcrossQualifiedSettle: rawEvidence.remote_ui_non_running_across_qualified_settle === true,
            noUnresolvedGooseWork: rawEvidence.no_unresolved_goose_work === true,
            noContradictoryActivity: rawEvidence.no_contradictory_activity === true,
          };
        } catch {
          return jsonError(400, "invalid_recovery_request", "Positive-terminal recovery identity is invalid");
        }
        if (executions.has(turnRef) || toolActivityByTurn.has(turnRef)) {
          return jsonError(409, "recovery_owner_active", "Process-local turn/tool ownership must be gone before abandonment");
        }
        try {
          broker.releaseSlotAfterPositiveTerminal(turnRef, evidence);
          const abandoned = broker.abandonUnreconciled(turnRef);
          return Response.json({
            status: "ok",
            turn_ref: turnRef,
            turn_state: abandoned.state,
            account_slot_holder: broker.getAccountSlotHolder(),
          });
        } catch (error) {
          if (error instanceof SessionBrokerError) {
            return Response.json({ status: "rejected", code: error.code }, { status: 409 });
          }
          throw error;
        }
      }
      if (request.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
        if (!safeEqualBearer(request.headers.get("authorization") ?? "", options.controlToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (url.pathname === "/admin/resume") {
          draining = false;
          return Response.json({ status: "ok", accepting_turns: true, active_http_turns: activeHttpTurns, active_browser_turns: broker.getAccountSlotHolder() ? 1 : 0 });
        }
        const activeBrowserTurns = broker.getAccountSlotHolder() ? 1 : 0;
        if (activeHttpTurns !== 0 || activeBrowserTurns !== 0) {
          return Response.json({
            status: "busy",
            accepting_turns: true,
            active_http_turns: activeHttpTurns,
            active_browser_turns: activeBrowserTurns,
          }, { status: 409 });
        }
        draining = true;
        return Response.json({ status: "ok", accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 });
      }
      if (request.method === "POST" && url.pathname === "/admin/shutdown") {
        if (!safeEqualBearer(request.headers.get("authorization") ?? "", options.controlToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (!draining || activeHttpTurns !== 0 || broker.getAccountSlotHolder()) {
          return Response.json({ status: "refused", accepting_turns: !draining }, { status: 409 });
        }
        setTimeout(() => { void stop(); }, 0);
        return Response.json({ status: "ok", accepting_turns: false });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        if (draining) return jsonError(503, "provider_draining", "Rebuild provider is draining");
        return Response.json({
          object: "list",
          data: [{ id: options.model, object: "model", created: 0, owned_by: REBUILD_PROVIDER_SERVICE, meta: { n_ctx: options.contextWindow } }],
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled", { status: 426 });
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        if (draining) return jsonError(503, "provider_draining", "Rebuild provider is draining");
        activeHttpTurns += 1;
        try {
          return await handleResponses(request);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return jsonError(499, "client_disconnected", "Goose Responses request disconnected before a safe terminal stage");
          }
          if (error instanceof SessionBrokerError || error instanceof GooseToolRendezvousError) {
            return jsonError(409, error.code, error.message);
          }
          if (error instanceof ChatGptUpstreamTerminalError) {
            return jsonError(502, "upstream_server_error", error.message);
          }
          return jsonError(502, "rebuild_provider_error", error instanceof Error ? error.message : String(error));
        } finally {
          activeHttpTurns -= 1;
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const providerPort = server.port;
  if (providerPort === undefined) throw new Error("Rebuild provider did not expose a bound port");
  return { hostname, port: providerPort, origin: `http://${hostname}:${providerPort}`, connector, broker, stop };
}
