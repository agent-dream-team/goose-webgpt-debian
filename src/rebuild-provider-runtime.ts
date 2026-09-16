import { createHash, timingSafeEqual } from "node:crypto";
import { readJsonRequestBody } from "./http-body";
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
import {
  ChatGptExternalTurnProgress,
  type ChatGptExternalTurnProgressSnapshot,
} from "./adapters/chatgpt-web/turn-progress";
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
  /** Called when recovery reopens the same accepted remote turn without sending anything new. */
  onRebound?(evidence: RebuildBrowserAcceptedEvidence): void | Promise<void>;
}

export interface RebuildPersistentBrowserTurnInput {
  turnRef: string;
  gooseSessionId: string;
  epoch: number;
  initialOpRef: string;
  submitNonce: string;
  prompt: string;
  existingConversationId: string | null;
  /** Reattach to an already accepted remote turn without sending another Goose prompt. */
  resumeAccepted?: {
    canonicalConversationId: string;
    acceptedUserTurnId: string;
  };
  preSendAbortSignal: AbortSignal;
  gooseWork: {
    /** Semantic progress guides observation cadence only; it never authorizes tool retirement. */
    snapshot(): ChatGptExternalTurnProgressSnapshot;
  };
  lifecycle: RebuildBrowserTurnLifecycle;
}

export interface RebuildPersistentBrowserTurnExecution {
  /** Called after the runtime has registered the execution and Goose Responses stage. */
  run(): Promise<RebuildBrowserFinalEvidence>;
  /** Force a fresh final observation after the broker completion claim is durably established. */
  confirmFinal(candidate: RebuildBrowserFinalEvidence): Promise<RebuildBrowserFinalEvidence>;
  /** Must freshly observe the exact persistent surface after qualified renderer catch-up/quiescence. */
  captureAnswerBoundary(opRef: string): Promise<string>;
  /** Detach only the process-local browser/execution attachment; both persistent chats remain durable. */
  detachExecution?(reason: string): Promise<void>;
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
  executionDetach: Promise<void> | null;
}

interface CompletedResponse {
  turnRef: string;
  requestHash: string;
  sse: string;
}

interface TurnToolActivity {
  readonly progress: ChatGptExternalTurnProgress;
  activeOpRef: string | null;
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

  const broker = new SessionBroker(options.brokerPath, {
    projectId: options.projectId,
    terminalReplayWindowMs: options.terminalReplayWindowMs ?? REBUILD_TERMINAL_REPLAY_WINDOW_MS,
  });
  const baton = new GooseToolRendezvous({ loadCheckpoint: turnRef => broker.getTurn(turnRef)?.checkpointJson ?? null });
  const executions = new Map<string, ActiveExecution>();
  const toolActivityByTurn = new Map<string, TurnToolActivity>();
  const toolActivity = (turnRef: string): TurnToolActivity => {
    let activity = toolActivityByTurn.get(turnRef);
    if (!activity) {
      activity = { progress: new ChatGptExternalTurnProgress(), activeOpRef: null };
      toolActivityByTurn.set(turnRef, activity);
    }
    return activity;
  };
  const beginToolActivity = (turnRef: string, opRef: string) => {
    const activity = toolActivity(turnRef);
    if (activity.activeOpRef) throw new Error("Persistent rebuild supports only one serial Goose tool operation per turn");
    activity.activeOpRef = opRef;
    activity.progress.recordToolBatch(1);
  };
  const endToolActivity = (turnRef: string, opRef: string) => {
    const activity = toolActivityByTurn.get(turnRef);
    if (!activity || activity.activeOpRef !== opRef) return;
    activity.activeOpRef = null;
    if (activity.progress.snapshot().activeToolCalls > 0) activity.progress.recordToolResult();
  };
  const quarantineDetachedToolActivity = (
    turnRef: string,
    reason: string,
    expectedRevision?: number,
  ): boolean => {
    const activity = toolActivityByTurn.get(turnRef);
    if (!activity?.activeOpRef) return false;
    const snapshot = activity.progress.snapshot();
    if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) return false;
    const decision = broker.quarantineOwnedOperation({ turnRef, opRef: activity.activeOpRef, reason });
    if (decision.kind === "TERMINAL") return false;
    baton.quarantineTurn(turnRef, "Goose tool outcome is uncertain; explicit reconciliation is required");
    activity.progress.retire(new GooseToolRendezvousError("TURN_UNCERTAIN", reason));
    activity.activeOpRef = null;
    return true;
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
      beginToolActivity(request.turnRef, request.opRef);
      let released = false;
      const releaseActivity = () => {
        if (released) return;
        released = true;
        endToolActivity(request.turnRef, request.opRef);
      };
      try {
        const continuation = await baton.dispatchTool(request);
        toolActivityByTurn.get(request.turnRef)?.progress.recordActivity();
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

  const ensureEpoch = (sessionId: string): RemoteEpoch =>
    broker.getCurrentEpoch(sessionId) ?? broker.createEpoch({ gooseSessionId: sessionId });

  const detachBrowserExecution = (active: ActiveExecution, reason: string): Promise<void> => {
    if (active.executionDetach) return active.executionDetach;
    active.executionDetach = active.browser.detachExecution?.(reason) ?? Promise.resolve();
    return active.executionDetach;
  };

  const durableToolResult = (opRef: string): string => {
    const operation = broker.getOperation(opRef);
    if (!operation || (operation.state !== "SUCCESS" && operation.state !== "FAILURE") || !operation.resultJson) {
      throw new Error(`Canonical epoch seed cannot resolve durable connector result for ${opRef}`);
    }
    return connectorStoredResultOutput(operation.resultJson);
  };

  const toolProgressSnapshot = (turnRef: string): ChatGptExternalTurnProgressSnapshot => {
    const local = toolActivityByTurn.get(turnRef);
    if (local) return local.progress.snapshot();
    // After process/runtime attachment loss, unresolved durable Goose work must continue to block
    // provider-internal continuation even though the process-local activity broadcaster is gone.
    if (broker.hasBlockingOperation(turnRef)) {
      return { revision: 0, lastToolBatchRevision: 0, activeToolCalls: 1 };
    }
    return { revision: 0, lastToolBatchRevision: 0, activeToolCalls: 0 };
  };

  const cacheCompletedResponse = (turn: BrokerTurn, sse: string) => {
    completedResponses.delete(turn.gooseSessionId);
    completedResponses.set(turn.gooseSessionId, {
      turnRef: turn.turnRef,
      requestHash: turn.requestHash,
      sse,
    });
    while (completedResponses.size > COMPLETED_RESPONSE_CACHE_LIMIT) {
      const oldestSession = completedResponses.keys().next().value as string | undefined;
      if (oldestSession === undefined) break;
      completedResponses.delete(oldestSession);
    }
  };

  const finalizeExecutionEvidence = async (
    turn: BrokerTurn,
    active: ActiveExecution,
    evidence: RebuildBrowserFinalEvidence,
  ): Promise<string> => {
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
    if (evidence.remoteNonRunning !== true) throw new Error("Browser final evidence is incomplete");
    const digest = finalDigest(evidence.text);
    broker.recordFinalDigest(turn.turnRef, digest);
    const claim = broker.beginCompletion(turn.turnRef);
    const confirmed = await active.browser.confirmFinal(evidence);
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
    cacheCompletedResponse(turn, finalSse);
    return finalSse;
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
      gooseWork: {
        snapshot: () => toolProgressSnapshot(turn.turnRef),
      },
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
      executionDetach: null,
    };
    executions.set(turn.turnRef, active);

    const onInitialDisconnect = () => {
      if (!active.sendActivated) preSendAbort.abort(abortError());
    };
    requestSignal.addEventListener("abort", onInitialDisconnect, { once: true });
    if (requestSignal.aborted) onInitialDisconnect();
    active.final = Promise.resolve()
      .then(() => browser.run())
      .then(evidence => finalizeExecutionEvidence(turn, active, evidence))
      .catch(async error => {
        const current = broker.getTurn(turn.turnRef);
        if (current?.state === "QUEUED") {
          // No irreversible send fence was armed. Local preparation failure or transport-owner
          // loss can therefore free the slot and permit an exact fresh attempt without resend risk.
          try { broker.cancelRetryableBeforeSend(turn.turnRef); } catch {}
        } else if (current?.state === "TURN_OUTSTANDING") {
          try { broker.markUnreconciled(turn.turnRef, "persistent_browser_turn_failed"); } catch {}
        }
        if (current?.state !== "QUEUED") {
          try { await detachBrowserExecution(active, "runtime_attachment_failed"); } catch {}
        }
        if (executions.get(turn.turnRef) === active) executions.delete(turn.turnRef);
        throw error;
      })
      .finally(() => {
        requestSignal.removeEventListener("abort", onInitialDisconnect);
        if (executions.get(turn.turnRef) === active) executions.delete(turn.turnRef);
        if (toolActivityByTurn.get(turn.turnRef)?.activeOpRef === null) toolActivityByTurn.delete(turn.turnRef);
      });
    void active.final.catch(() => {});
    return active;
  };

  const startRebindExecution = (turn: BrokerTurn): ActiveExecution => {
    const existing = executions.get(turn.turnRef);
    if (existing) return existing;
    if (turn.state !== "UNRECONCILED") {
      throw new SessionBrokerError("TURN_STATE", "Persistent pair rebind requires an unreconciled turn");
    }
    if (broker.hasBlockingOperation(turn.turnRef)) {
      throw new SessionBrokerError("UNRESOLVED_OPERATION", "Persistent pair rebind requires prior tool/result reconciliation");
    }
    const epoch = broker.getCurrentEpoch(turn.gooseSessionId);
    if (!epoch || epoch.epoch !== turn.epoch || !epoch.conversationId || !turn.acceptedUserTurnId) {
      throw new SessionBrokerError("RECOVERY_IDENTITY", "Persistent pair rebind requires durable Goose and ChatGPT identities");
    }
    const initialOperation = broker.getInitialOperationForTurn(turn.turnRef);
    const latestTerminal = broker.getLatestTerminalOperationForTurn(turn.turnRef);
    const preSendAbort = new AbortController();
    const restoreSlotOnPreReboundFailure = broker.hasRecordedPositiveTerminalSlotRelease(turn.turnRef);
    let reboundVerified = false;
    let active!: ActiveExecution;
    let browser: RebuildPersistentBrowserTurnExecution;
    try {
      browser = options.browserDriver.createTurn({
        turnRef: turn.turnRef,
        gooseSessionId: turn.gooseSessionId,
        epoch: turn.epoch,
        initialOpRef: initialOperation.opRef,
        submitNonce: turn.submitNonce,
        prompt: "",
        existingConversationId: epoch.conversationId,
        resumeAccepted: {
          canonicalConversationId: epoch.conversationId,
          acceptedUserTurnId: turn.acceptedUserTurnId,
        },
        preSendAbortSignal: preSendAbort.signal,
        gooseWork: { snapshot: () => toolProgressSnapshot(turn.turnRef) },
        lifecycle: {
          onSendActivated: () => {
            throw new Error("Persistent pair rebind must never resend the original Goose prompt");
          },
          onAccepted: () => {
            throw new Error("Persistent pair rebind must never create a replacement ChatGPT user turn");
          },
          onRebound: evidence => {
            const conversationId = normalizeCanonicalChatGptConversationId(evidence.canonicalConversationId);
            const acceptedUserTurnId = validatePersistentChatTurnIdentity(
              evidence.acceptedUserTurnId, "reattached accepted user turn",
            );
            broker.rebindVerifiedRemoteTurn({
              turnRef: turn.turnRef,
              canonicalConversationId: conversationId,
              acceptedUserTurnId,
              remoteIdentityVerified: true,
            });
            reboundVerified = true;
          },
        },
      });
    } catch (error) {
      if (restoreSlotOnPreReboundFailure) {
        try { broker.restorePositiveTerminalSlotRelease(turn.turnRef); } catch {}
      }
      throw error;
    }
    active = {
      turnRef: turn.turnRef,
      browser,
      preSendAbort,
      sendActivated: true,
      latestBoundaryOpRef: latestTerminal?.answerBoundaryJson ? latestTerminal.opRef : null,
      final: Promise.resolve("") as Promise<string>,
      executionDetach: null,
    };
    executions.set(turn.turnRef, active);
    active.final = Promise.resolve()
      .then(() => browser.run())
      .then(evidence => finalizeExecutionEvidence(turn, active, evidence))
      .catch(async error => {
        const current = broker.getTurn(turn.turnRef);
        if (current?.state === "TURN_OUTSTANDING") {
          try { broker.markUnreconciled(turn.turnRef, "persistent_pair_rebind_failed"); } catch {}
        }
        if (restoreSlotOnPreReboundFailure && !reboundVerified) {
          try { broker.restorePositiveTerminalSlotRelease(turn.turnRef); } catch {}
        }
        try { await detachBrowserExecution(active, "runtime_attachment_failed"); } catch {}
        if (executions.get(turn.turnRef) === active) executions.delete(turn.turnRef);
        throw error;
      })
      .finally(() => {
        if (executions.get(turn.turnRef) === active) executions.delete(turn.turnRef);
        if (toolActivityByTurn.get(turn.turnRef)?.activeOpRef === null) toolActivityByTurn.delete(turn.turnRef);
      });
    void active.final.catch(() => {});
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
      const admitted = broker.admitNext(turnRef);
      if (admitted?.turn.turnRef === turnRef) return admitted;
      await sleep(POLL_MS, signal);
    }
  };

  const waitForRebindAdmission = async (turnRef: string, signal: AbortSignal): Promise<BrokerTurn> => {
    for (;;) {
      if (signal.aborted) throw abortError();
      const turn = broker.getTurn(turnRef);
      if (!turn) throw new Error("Unreconciled broker turn disappeared before pair rebind");
      if (turn.state !== "UNRECONCILED") {
        throw new Error(`Broker turn left unreconciled recovery unexpectedly (${turn.state})`);
      }
      if (broker.getAccountSlotHolders().some(holder => holder.turnRef === turnRef)) return turn;
      const reacquired = broker.reacquireReleasedSlotForRebind(turnRef);
      if (reacquired) return reacquired;
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
    }
    const checkpoint = gooseResponsesProjectionCheckpoint(body);
    let turn = broker.getOpenTurnForSession(sessionId);

    if (turn?.state === "UNRECONCILED") {
      if (turn.requestHash !== checkpoint.requestHash) {
        return jsonError(409, "rebind_request_conflict", "Persistent pair rebind requires the exact original Goose Responses request");
      }
      if (broker.hasBlockingOperation(turn.turnRef)) {
        return jsonError(409, "rebind_blocked", "Persistent pair rebind requires unresolved Goose tool/result state to be reconciled first");
      }
      let active: ActiveExecution;
      try {
        turn = await waitForRebindAdmission(turn.turnRef, request.signal);
        active = startRebindExecution(turn);
      } catch (error) {
        if (error instanceof SessionBrokerError) {
          return Response.json({ error: { type: "invalid_request_error", code: error.code, message: error.message } }, { status: 409 });
        }
        throw error;
      }
      const stage = baton.openStage({ turnRef: turn.turnRef, body });
      return await serveStage(stage, active, request.signal);
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

      const epoch = ensureEpoch(sessionId);
      if (epoch.conversationId) {
        const history = epoch.historyWatermark
          ? classifyGooseCanonicalHistory(body, epoch.historyWatermark)
          : { kind: "ROLLOVER" as const, reason: "bound_epoch_missing_history_watermark", items: [] };
        if (history.kind !== "APPEND") {
          const reason = history.kind === "ROLLOVER" ? history.reason : "bound_epoch_unexpected_seed";
          return jsonError(
            409,
            "paired_handoff_required",
            `Canonical Goose history is no longer append-compatible (${reason}); start a fresh Goose session and ChatGPT conversation together from a deliberate handoff`,
          );
        }
      }
      turn = broker.enqueueTurn({
        gooseSessionId: sessionId,
        requestHash: checkpoint.requestHash,
        checkpointJson: encodeGooseResponsesProjectionCheckpoint(checkpoint),
      });
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

  const detachAuthoritativeExecution = async (input: {
    turnRef: string;
    gooseSessionId: string;
    reason: "controller_detached" | "transport_lost";
  }): Promise<BrokerTurn> => {
    const turn = broker.getTurn(input.turnRef);
    if (!turn || turn.gooseSessionId !== input.gooseSessionId) {
      throw new SessionBrokerError("TURN_IDENTITY", "Execution detach identity does not match the broker turn");
    }
    if (turn.state !== "TURN_OUTSTANDING" && turn.state !== "UNRECONCILED") {
      throw new SessionBrokerError("TURN_STATE", "Execution detach requires a remotely outstanding turn");
    }
    const active = executions.get(input.turnRef);
    if (!active) {
      if (turn.state === "UNRECONCILED") return turn;
      throw new SessionBrokerError("TURN_EXECUTION", "Outstanding process-local execution attachment is unavailable");
    }
    if (!active.browser.detachExecution) {
      throw new SessionBrokerError("TURN_EXECUTION", "Browser driver cannot detach the process-local execution attachment");
    }
    const durableReason = `goose_execution_${input.reason}`;
    quarantineDetachedToolActivity(input.turnRef, durableReason);
    const current = broker.getTurn(input.turnRef);
    if (current?.state === "TURN_OUTSTANDING") broker.markUnreconciled(input.turnRef, durableReason);
    await detachBrowserExecution(active, input.reason);
    await active.final.catch(() => {});
    return broker.getTurn(input.turnRef)!;
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
          active_browser_turns: broker.getActiveAccountSlotCount(),
        });
      }
      if (request.method === "POST" && url.pathname === "/admin/detach-turn-execution") {
        if (!safeEqualBearer(request.headers.get("authorization") ?? "", options.controlToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
        let body: unknown;
        try { body = await readJsonRequestBody(request); } catch {
          return jsonError(400, "invalid_execution_detach", "Execution detach body must be valid JSON");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonError(400, "invalid_execution_detach", "Execution detach must be an object");
        }
        const terminal = body as Record<string, unknown>;
        const turnRef = terminal.turn_ref;
        const gooseSessionId = terminal.goose_session_id;
        const reason = terminal.reason;
        if (typeof turnRef !== "string" || !turnRef
          || typeof gooseSessionId !== "string" || !validSessionId(gooseSessionId)
          || (reason !== "controller_detached" && reason !== "transport_lost")) {
          return jsonError(
            400,
            "invalid_execution_detach",
            "Execution detach requires turn_ref, goose_session_id, and a supported reason",
          );
        }
        try {
          const turn = await detachAuthoritativeExecution({ turnRef, gooseSessionId, reason });
          return Response.json({
            status: "ok",
            turn_ref: turn.turnRef,
            turn_state: turn.state,
            unreconciled_reason: turn.unreconciledReason,
            slot_retained: broker.getAccountSlotHolders().some(holder => holder.turnRef === turn.turnRef),
          });
        } catch (error) {
          if (error instanceof SessionBrokerError) {
            return Response.json({ status: "rejected", code: error.code }, { status: 409 });
          }
          throw error;
        }
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
      if (request.method === "POST" && url.pathname === "/admin/release-unreconciled-slot") {
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
        if (typeof turnRef !== "string" || !turnRef || !evidenceValue
          || typeof evidenceValue !== "object" || Array.isArray(evidenceValue)) {
          return jsonError(400, "invalid_recovery_request",
            "Slot release requires turn_ref and positive_terminal_evidence");
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
            remoteUiNonRunningAcrossQualifiedSettle:
              rawEvidence.remote_ui_non_running_across_qualified_settle === true,
            noUnresolvedGooseWork: rawEvidence.no_unresolved_goose_work === true,
            noContradictoryActivity: rawEvidence.no_contradictory_activity === true,
          };
        } catch {
          return jsonError(400, "invalid_recovery_request", "Positive-terminal recovery identity is invalid");
        }
        if (executions.has(turnRef) || toolActivityByTurn.has(turnRef)) {
          return jsonError(409, "recovery_owner_active",
            "Process-local turn/tool ownership must be gone before account-slot release");
        }
        try {
          const released = broker.releaseSlotAfterPositiveTerminal(turnRef, evidence);
          return Response.json({
            status: "ok",
            turn_ref: turnRef,
            turn_state: released.state,
            pair_retained: true,
            account_slot_holders: broker.getAccountSlotHolders(),
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
          return Response.json({ status: "ok", accepting_turns: true, active_http_turns: activeHttpTurns, active_browser_turns: broker.getActiveAccountSlotCount() });
        }
        const activeBrowserTurns = broker.getActiveAccountSlotCount();
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
        if (!draining || activeHttpTurns !== 0 || broker.getActiveAccountSlotCount() !== 0) {
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
