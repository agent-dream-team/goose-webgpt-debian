import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright-core";
import {
  chatGptPromptEquivalentPrefixLength,
  chatGptPromptTextEquivalent,
  insertPlainTextIntoComposer,
  readChatGptComposerPlainText,
} from "./chatgpt-composer";
import {
  clearRebuildChatGptConnectorComposer,
  rebuildChatGptActiveComposer,
  type RebuildChatGptConnectorOptions,
} from "./rebuild-chatgpt-connector";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  assertAuthenticatedChatGptPage,
} from "./chatgpt-session";
import { setChatGptThinkMode } from "./chatgpt-think-mode";
import { ChatGptUpstreamTerminalError, detectChatGptTerminalError } from "./chatgpt-terminal-state";
import { ChatGptCompletionTracker } from "./chatgpt-turn-state";
import {
  CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
  chatGptExternalProgressIsRecent,
} from "./adapters/chatgpt-web/turn-progress";
import {
  connectLauncherBrowserHost,
  LAUNCHER_BROWSER_IDLE_URL,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
  type LauncherBrowserConnection,
} from "./launcher-browser-host";
import {
  acceptedUserTurnIdentity,
  assistantTurnForAcceptedUser,
  canonicalChatGptConversationUrl,
  capturePersistentChatTurnSnapshot,
  classifyChatGptConversationUrl,
  normalizeCanonicalChatGptConversationId,
  PersistentChatSurfaceController,
  validatePersistentChatTurnIdentity,
  type PersistentChatBinding,
  type PersistentChatSurfaceObservation,
  type PersistentChatTurnSnapshot,
} from "./persistent-chat-surface";
import type {
  RebuildBrowserFinalEvidence,
  RebuildPersistentBrowserDriver,
  RebuildPersistentBrowserTurnInput,
} from "./rebuild-provider-runtime";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_BOUNDARY_SETTLE_MS = 250;
const DEFAULT_CONFIRM_SETTLE_MS = 250;
const DEFAULT_STALE_OBSERVATION_FIRST_REFRESH_MS = 15_000;
const DEFAULT_STALE_OBSERVATION_SUBSEQUENT_REFRESH_MS = 5 * 60_000;
const SEND_ENABLE_GRACE_MS = 10_000;
const GCW_RECOVERY_CONTINUATION_PROMPT = "You seem to have stopped mid-turn. Work out where you got to and continue from there.";

export interface RebuildAnswerProjection {
  assistantTurnId: string;
  text: string;
  html: string;
  completionActionVisible: boolean;
}

export interface RebuildFreshProjectPreparation {
  /** Prepare exactly one new empty chat inside the configured dedicated Project. Never submit. */
  (page: Page, input: RebuildPersistentBrowserTurnInput): Promise<void>;
}

type NotifyTurn = typeof notifyLauncherTurn;
type ConnectSurface = typeof connectLauncherBrowserHost;
type SnapshotCapture = (page: Page) => Promise<PersistentChatTurnSnapshot>;
type AnswerCapture = (page: Page, assistantTurnId: string) => Promise<RebuildAnswerProjection>;
type PageVerifier = (page: Page, timeoutMs: number, signal: AbortSignal) => Promise<void>;
type Sleep = (ms: number) => Promise<void>;
type ConnectorCleaner = typeof clearRebuildChatGptConnectorComposer;
type ThinkModeSetter = typeof setChatGptThinkMode;
type TerminalErrorAsserter = (page: Page, assistantTurnId: string) => Promise<void>;
type ApprovalFenceCheck = (page: Page) => Promise<boolean>;
type ReopenBinding = (binding: PersistentChatBinding) => Promise<PersistentChatSurfaceObservation>;
type StaleObservationKind = "running" | "stopped-no-final" | "missing-completion-action" | "stale-tool";

export interface RebuildPersistentBrowserDriverOptions {
  descriptorPath: string;
  projectId: string;
  connectorName: string;
  connectorMentionQuery: string;
  prepareFreshProjectChat: RebuildFreshProjectPreparation;
  timeoutMs?: number;
  pollMs?: number;
  boundarySettleMs?: number;
  confirmationSettleMs?: number;
  completionSettleMs?: number;
  postToolAnswerGraceMs?: number;
  staleObservationFirstRefreshMs?: number;
  staleObservationSubsequentRefreshMs?: number;
  semanticObservationRefreshMs?: number;
  dependencies?: {
    notifyTurn?: NotifyTurn;
    connectSurface?: ConnectSurface;
    captureSnapshot?: SnapshotCapture;
    captureAnswer?: AnswerCapture;
    verifyAuthenticated?: PageVerifier;
    clearConnectorComposer?: ConnectorCleaner;
    setThinkMode?: ThinkModeSetter;
    assertNoTerminalError?: TerminalErrorAsserter;
    approvalFenceVisible?: ApprovalFenceCheck;
    reopenBinding?: ReopenBinding;
    sleep?: Sleep;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function rebuildConversationKey(projectId: string, gooseSessionId: string, epoch: number): string {
  if (!projectId || !gooseSessionId || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("Persistent browser conversation key inputs are invalid");
  }
  return sha256(`goose-chatgpt-web-rebuild\0${projectId}\0${gooseSessionId}\0${epoch}`);
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Persistent browser turn aborted", "AbortError");
}

function isTargetClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Playwright's public API wrapper exposes target closure as name="Error" while preserving this
  // canonical server message (for example: "evaluate: Target page, context or browser has been closed").
  // Match only that Playwright-owned terminal plus the internal name used before API wrapping.
  return error.name === "TargetClosedError"
    || error.message.includes("Target page, context or browser has been closed");
}

async function verifyPageAuthenticated(page: Page, timeoutMs: number, signal: AbortSignal): Promise<void> {
  await rebuildChatGptActiveComposer(page, timeoutMs, signal);
  await assertAuthenticatedChatGptPage(page);
}

async function attachExactPrompt(
  page: Page,
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal,
  preparedComposer?: Locator,
  preserveConnector = false,
  thinkMode: ThinkModeSetter = setChatGptThinkMode,
): Promise<Locator> {
  abortIfRequested(signal);
  const composer = preparedComposer ?? await rebuildChatGptActiveComposer(page, timeoutMs, signal);
  if (!preserveConnector) await composer.fill("", { signal, timeout: timeoutMs });
  await composer.focus({ signal, timeout: timeoutMs });
  await thinkMode(composer.locator("xpath=ancestor::form[1]"), true, undefined, signal);
  if (preserveConnector) {
    const documentEndKey = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
    await composer.press(documentEndKey, { signal, timeout: timeoutMs });
  }
  const inserted = await composer.evaluate(insertPlainTextIntoComposer, preserveConnector ? ` ${prompt}` : prompt, { timeout: timeoutMs, signal });
  if (!inserted) throw new Error("ChatGPT persistent composer rejected the plain-text editing command");
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  let observed = "";
  while (Date.now() < deadline) {
    abortIfRequested(signal);
    observed = await composer.evaluate(readChatGptComposerPlainText, undefined, { timeout: timeoutMs, signal });
    if (chatGptPromptTextEquivalent(prompt, observed)) return composer;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const prefix = chatGptPromptEquivalentPrefixLength(prompt, observed);
  throw new Error(
    `ChatGPT persistent composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${prefix})`,
  );
}

async function defaultCaptureAnswer(page: Page, assistantTurnId: string): Promise<RebuildAnswerProjection> {
  validatePersistentChatTurnIdentity(assistantTurnId, "assistant turn");
  const turn = page.locator(`[data-turn-id=${JSON.stringify(assistantTurnId)}]`);
  if (await turn.count() !== 1) throw new Error("Anchored ChatGPT assistant turn is missing or duplicated");
  const snapshot = await turn.evaluate((element, completionActionSelector) => {
    const root = element as HTMLElement;
    const rendered = (candidate: HTMLElement): boolean => {
      const style = getComputedStyle(candidate);
      return candidate.isConnected && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const markdownRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]
      .filter(candidate => !candidate.parentElement?.closest(".markdown"))
      .filter(rendered);
    const statusContainers = [...root.querySelectorAll<HTMLElement>("[data-streaming-response-status]")].filter(rendered);
    const firstStatus = statusContainers[0];
    const commentary = markdownRoots.filter(candidate => (
      candidate.closest("[data-streaming-response-status]") !== null
      || candidate.closest('[data-testid^="cot-v5"]') !== null
      || (firstStatus !== undefined && Boolean(candidate.compareDocumentPosition(firstStatus) & Node.DOCUMENT_POSITION_FOLLOWING))
    ));
    const answerRoots = markdownRoots.filter(candidate => !commentary.includes(candidate));
    const sanitized = answerRoots.map(candidate => {
      const clone = candidate.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(
        ".chart-widget-container, [data-code-block-preview-pane], button, script, style, svg, img, picture, source",
      ).forEach(part => part.remove());
      return clone;
    });
    const last = answerRoots.at(-1);
    const completionAction = last
      ? [...root.querySelectorAll<HTMLElement>(completionActionSelector)]
        .filter(rendered)
        .find(candidate => !last.contains(candidate)
          && Boolean(last.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
      : undefined;
    return {
      text: answerRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n"),
      html: sanitized.map(candidate => candidate.innerHTML).join(""),
      completionActionVisible: completionAction !== undefined,
    };
  }, CHATGPT_COMPLETION_ACTION_SELECTOR);
  return { assistantTurnId, ...snapshot };
}

function projectionSignature(projection: RebuildAnswerProjection): string {
  return sha256(`${projection.assistantTurnId}\0${projection.text}\0${projection.html}`);
}

async function assertNoChatGptTerminalError(page: Page, assistantTurnId: string): Promise<void> {
  validatePersistentChatTurnIdentity(assistantTurnId, "assistant turn");
  const turn = page.locator(`[data-turn-id=${JSON.stringify(assistantTurnId)}]`);
  if (await turn.count() !== 1) throw new Error("Anchored ChatGPT assistant turn is missing or duplicated");
  const terminal = await detectChatGptTerminalError(turn);
  if (!terminal) return;
  throw new ChatGptUpstreamTerminalError(terminal);
}

async function chatGptApprovalFenceVisible(page: Page): Promise<boolean> {
  return await page.locator('[data-testid="tool-approval-card"], [role="dialog"]')
    .filter({ visible: true }).count().catch(() => 0) > 0;
}

function boundaryJson(input: {
  opRef: string;
  conversationId: string;
  acceptedUserTurnId: string;
  projection: RebuildAnswerProjection;
}): string {
  return JSON.stringify({
    version: 1,
    opRef: input.opRef,
    conversationId: input.conversationId,
    acceptedUserTurnId: input.acceptedUserTurnId,
    assistantTurnId: input.projection.assistantTurnId,
    answerTextSha256: sha256(input.projection.text),
    answerProjectionSha256: projectionSignature(input.projection),
  });
}

export function createRebuildPersistentBrowserDriver(
  options: RebuildPersistentBrowserDriverOptions,
): RebuildPersistentBrowserDriver {
  if (!options.descriptorPath) throw new Error("Persistent browser driver requires a launcher descriptor path");
  if (!options.projectId) throw new Error("Persistent browser driver requires the dedicated Project identity");
  if (!options.connectorName.trim() || !options.connectorMentionQuery.startsWith("@")) {
    throw new Error("Persistent browser driver requires an exact connector identity and mention query");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectorOptions: RebuildChatGptConnectorOptions = {
    connectorName: options.connectorName,
    mentionQuery: options.connectorMentionQuery,
    timeoutMs,
  };
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const boundarySettleMs = options.boundarySettleMs ?? DEFAULT_BOUNDARY_SETTLE_MS;
  const confirmationSettleMs = options.confirmationSettleMs ?? DEFAULT_CONFIRM_SETTLE_MS;
  const staleObservationFirstRefreshMs = options.staleObservationFirstRefreshMs ?? DEFAULT_STALE_OBSERVATION_FIRST_REFRESH_MS;
  const staleObservationSubsequentRefreshMs = options.staleObservationSubsequentRefreshMs ?? DEFAULT_STALE_OBSERVATION_SUBSEQUENT_REFRESH_MS;
  const semanticObservationRefreshMs = options.semanticObservationRefreshMs ?? CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS;
  if (!Number.isFinite(semanticObservationRefreshMs) || semanticObservationRefreshMs < 0) {
    throw new Error("Persistent browser semantic-observation refresh threshold is invalid");
  }
  const notifyTurn = options.dependencies?.notifyTurn ?? notifyLauncherTurn;
  const connectSurface = options.dependencies?.connectSurface ?? connectLauncherBrowserHost;
  const captureSnapshot = options.dependencies?.captureSnapshot ?? capturePersistentChatTurnSnapshot;
  const captureAnswer = options.dependencies?.captureAnswer ?? defaultCaptureAnswer;
  const assertNoTerminalError = options.dependencies?.assertNoTerminalError ?? assertNoChatGptTerminalError;
  const verifyAuthenticated = options.dependencies?.verifyAuthenticated ?? verifyPageAuthenticated;
  const clearConnectorComposer = options.dependencies?.clearConnectorComposer ?? clearRebuildChatGptConnectorComposer;
  const thinkMode = options.dependencies?.setThinkMode ?? setChatGptThinkMode;
  const approvalFenceVisible = options.dependencies?.approvalFenceVisible ?? chatGptApprovalFenceVisible;
  const sleep = options.dependencies?.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); });

  return {
    createTurn(input) {
      const conversationKey = rebuildConversationKey(options.projectId, input.gooseSessionId, input.epoch);
      const traceId = input.turnRef;
      let connection: LauncherBrowserConnection | undefined;
      let page: Page | undefined;
      let leasedSurfaceId: string | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let sendActivated = false;
      let acceptedConversationId: string | undefined;
      let acceptedUserTurnId: string | undefined;
      let observationUserTurnId: string | undefined;
      let assistantTurnId: string | undefined;
      let baseline: PersistentChatTurnSnapshot | undefined;
      let completionTracker = new ChatGptCompletionTracker(
        options.completionSettleMs, options.postToolAnswerGraceMs,
      );
      let staleObservation: {
        kind: StaleObservationKind;
        signature: string;
        progressRevision: number;
        since: number;
      } | undefined;
      let staleObservationRecoveryStage: "initial" | "refreshed" = "initial";
      let boundaryRevision = 0;
      let lastBoundaryText: string | undefined;
      let boundaryCaptureInFlight = false;
      let launcherEnded = false;
      let connectorBound = false;
      let surfaceRecreated = false;
      let executionDetached: Error | undefined;

      const closeConnection = async () => {
        if (!connection) return;
        const current = connection;
        connection = undefined;
        page = undefined;
        await current.browser.close().catch(() => {});
      };
      const stopHeartbeat = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
      };
      const endLauncher = async (status: "completed" | "failed", retain = false, bound = false) => {
        if (launcherEnded) return;
        launcherEnded = true;
        await notifyTurn(options.descriptorPath, {
          phase: "end",
          traceId,
          helperPid: process.pid,
          status,
          ...(retain ? { retain: true, connectorBound: bound } : {}),
        });
      };
      const detachWithoutTerminalMutation = async () => {
        stopHeartbeat();
        await closeConnection();
      };
      const failBeforeSend = async () => {
        stopHeartbeat();
        await closeConnection();
        await endLauncher("failed").catch(() => {});
      };
      const startHeartbeat = () => {
        const beat = () => {
          void notifyTurn(options.descriptorPath, {
            phase: "heartbeat", traceId, helperPid: process.pid,
          }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(() => {});
        };
        heartbeat = setInterval(beat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
        heartbeat.unref?.();
      };
      const requireLiveSurface = (): Page => {
        if (executionDetached) throw executionDetached;
        if (!page || page.isClosed()) throw new Error("Persistent ChatGPT browser surface is unavailable");
        return page;
      };
      const assertExactExistingConversation = (surfacePage: Page, expected: string, context: string): void => {
        const location = classifyChatGptConversationUrl(surfacePage.url());
        if (location.kind !== "canonical" || location.conversationId !== expected) {
          throw new Error(`${context} did not resolve to the exact durable ChatGPT conversation`);
        }
      };
      const prepareOrdinaryComposer = async (surfacePage: Page): Promise<Locator> => {
        // Connector discovery surfaces are not execution authority. Normalize any stale draft/pill,
        // then let ChatGPT route the installed connector implicitly if the turn actually needs it.
        await clearConnectorComposer(surfacePage, connectorOptions, input.preSendAbortSignal);
        return await rebuildChatGptActiveComposer(surfacePage, timeoutMs, input.preSendAbortSignal);
      };
      const reopenBinding: ReopenBinding = options.dependencies?.reopenBinding ?? (async binding => {
        const controller = new PersistentChatSurfaceController(
          options.descriptorPath,
          connectSurface,
          timeoutMs,
          async (surfacePage, surfaceTimeout) => {
            await verifyAuthenticated(surfacePage, surfaceTimeout, input.preSendAbortSignal);
          },
        );
        return await controller.reopen(binding, input.preSendAbortSignal);
      });
      const observationBinding = (): PersistentChatBinding => {
        if (!leasedSurfaceId || !acceptedConversationId || !observationUserTurnId) {
          throw new Error("Persistent ChatGPT observation binding is incomplete");
        }
        return {
          surfaceId: leasedSurfaceId,
          conversationId: acceptedConversationId,
          // Recovery continuations are private GCW artifacts. This anchor may advance while the
          // broker-visible acceptedUserTurnId remains the original Goose user turn.
          acceptedUserTurnId: observationUserTurnId,
        };
      };
      const viewRecoveryAllowed = async (): Promise<boolean> => {
        if (await approvalFenceVisible(requireLiveSurface())) {
          throw new Error("HUMAN_REQUIRED: ChatGPT approval or permission UI blocks stale-observation recovery");
        }
        return true;
      };
      const resetCompletionTracker = () => {
        completionTracker = new ChatGptCompletionTracker(
          options.completionSettleMs, options.postToolAnswerGraceMs,
        );
        if (boundaryRevision > 0 && lastBoundaryText !== undefined) {
          completionTracker.observeToolBatch(boundaryRevision, lastBoundaryText);
        }
      };
      const acceptedUserAnchorPresent = (snapshot: PersistentChatTurnSnapshot, acceptedUserTurnId: string): boolean => {
        // A newly opened conversation can hydrate the accepted user container before its assistant.
        // Once the user anchor is present, reuse the normal ordering/role validator before observing.
        if (!snapshot.userIdentities.includes(acceptedUserTurnId)) return false;
        assistantTurnForAcceptedUser(snapshot, acceptedUserTurnId);
        return true;
      };
      const recoverLostAcceptedSurface = async (cause: unknown): Promise<boolean> => {
        if (!sendActivated || !acceptedConversationId || !observationUserTurnId) return false;
        const currentPage = page;
        if (!currentPage || (!currentPage.isClosed() && !isTargetClosedError(cause))) return false;
        stopHeartbeat();
        await closeConnection();
        const lease = await notifyTurn(options.descriptorPath, {
          phase: "start",
          traceId,
          helperPid: process.pid,
          conversationKey,
          connectorIdentity: options.connectorName,
          requireRetainedConversation: true,
        });
        if (!lease.surfaceId || lease.reused !== false || lease.connectorBound !== false || lease.surfaceRecreated !== true) {
          throw new Error("Launcher did not reconstruct one clean observer surface for the accepted ChatGPT turn");
        }
        leasedSurfaceId = lease.surfaceId;
        connection = await connectSurface(
          options.descriptorPath, timeoutMs, lease.surfaceId, input.preSendAbortSignal,
        );
        page = connection.page;
        const recoveredPage = requireLiveSurface();
        const target = canonicalChatGptConversationUrl(acceptedConversationId);
        if (recoveredPage.url() === LAUNCHER_BROWSER_IDLE_URL) {
          await recoveredPage.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        } else {
          assertExactExistingConversation(recoveredPage, acceptedConversationId, "Reconstructed accepted-turn surface");
          await recoveredPage.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
        }
        await verifyAuthenticated(recoveredPage, timeoutMs, input.preSendAbortSignal);
        assertExactExistingConversation(recoveredPage, acceptedConversationId, "Reconstructed accepted-turn surface");
        const deadline = Date.now() + timeoutMs;
        let anchorRecovered = false;
        while (Date.now() < deadline) {
          const snapshot = await captureSnapshot(recoveredPage);
          if (acceptedUserAnchorPresent(snapshot, observationUserTurnId)) { anchorRecovered = true; break; }
          await sleep(pollMs);
        }
        if (!anchorRecovered) throw new Error("Reconstructed ChatGPT surface did not recover the accepted user-turn anchor");
        // This new view has not been connector-qualified for a future prompt. Let terminal cleanup
        // release it; the next Goose turn will reconstruct/requalify from the durable conversation id.
        connectorBound = false;
        surfaceRecreated = true;
        resetCompletionTracker();
        startHeartbeat();
        return true;
      };
      const adoptBoundConnection = async (binding: PersistentChatBinding) => {
        connection = await connectSurface(
          options.descriptorPath, timeoutMs, binding.surfaceId, input.preSendAbortSignal,
        );
        page = connection.page;
        const reboundPage = requireLiveSurface();
        await verifyAuthenticated(reboundPage, timeoutMs, input.preSendAbortSignal);
        const location = classifyChatGptConversationUrl(reboundPage.url());
        if (location.kind !== "canonical" || location.conversationId !== binding.conversationId) {
          throw new Error("Persistent ChatGPT stale-observation refresh reached a different conversation");
        }
        const snapshot = await captureSnapshot(reboundPage);
        const derivedAssistant = assistantTurnForAcceptedUser(snapshot, binding.acceptedUserTurnId);
        if (!derivedAssistant) {
          throw new Error("Persistent ChatGPT stale-observation refresh lost the accepted user-turn anchor");
        }
        assistantTurnId = derivedAssistant;
        resetCompletionTracker();
      };
      const reopenAcceptedSurface = async (): Promise<boolean> => {
        if (!await viewRecoveryAllowed()) return false;
        const binding = observationBinding();
        // Elapsed time only authorizes the next observation tier; it never proves completion or resend safety.
        await closeConnection();
        const reopened = await reopenBinding(binding);
        if (reopened.binding.surfaceId !== binding.surfaceId
          || reopened.binding.conversationId !== binding.conversationId
          || reopened.binding.acceptedUserTurnId !== binding.acceptedUserTurnId
          || !reopened.assistantTurnId) {
          throw new Error("Persistent ChatGPT stale-observation reopen did not preserve the durable turn binding");
        }
        await adoptBoundConnection(binding);
        return true;
      };
      const pressComposerSend = async (composer: Locator): Promise<void> => {
        const sendButton = composer.locator("xpath=ancestor::form[1]").getByTestId("send-button");
        await sendButton.waitFor({ state: "visible", timeout: timeoutMs });
        const sendDeadline = Date.now() + Math.min(timeoutMs, SEND_ENABLE_GRACE_MS);
        while (!await sendButton.isEnabled()) {
          abortIfRequested(input.preSendAbortSignal);
          if (Date.now() >= sendDeadline) throw new Error("ChatGPT persistent send button remained disabled");
          await sleep(pollMs);
        }
        abortIfRequested(input.preSendAbortSignal);
        await sendButton.press("Enter", { noWaitAfter: true, timeout: 0 });
      };
      const sendRecoveryContinuation = async (): Promise<boolean> => {
        if (input.gooseWork.snapshot().activeToolCalls > 0) return false;
        if (!await viewRecoveryAllowed()) return false;
        if (!acceptedConversationId) throw new Error("Persistent ChatGPT recovery continuation has no durable conversation");
        const currentPage = requireLiveSurface();
        assertExactExistingConversation(currentPage, acceptedConversationId, "Recovery continuation surface");
        const running = await currentPage.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
        if (running) return false;
        const before = await captureSnapshot(currentPage);
        const preparedComposer = await prepareOrdinaryComposer(currentPage);
        const composer = await attachExactPrompt(
          currentPage, GCW_RECOVERY_CONTINUATION_PROMPT, timeoutMs, input.preSendAbortSignal, preparedComposer,
          false, thinkMode,
        );
        await pressComposerSend(composer);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const snapshot = await captureSnapshot(currentPage);
          const continuationUserTurnId = acceptedUserTurnIdentity(before.turnIdentities, snapshot);
          if (continuationUserTurnId) {
            assertExactExistingConversation(currentPage, acceptedConversationId, "Recovery continuation acceptance");
            observationUserTurnId = continuationUserTurnId;
            assistantTurnId = undefined;
            resetCompletionTracker();
            staleObservation = undefined;
            staleObservationRecoveryStage = "initial";
            return true;
          }
          await sleep(pollMs);
        }
        throw new Error("Persistent ChatGPT recovery continuation was not accepted into the same conversation");
      };
      const observeAnchoredProjection = async (): Promise<RebuildAnswerProjection> => {
        const currentPage = requireLiveSurface();
        if (!observationUserTurnId) throw new Error("Persistent ChatGPT observation anchor is not accepted yet");
        const snapshot = await captureSnapshot(currentPage);
        const derivedAssistant = assistantTurnForAcceptedUser(snapshot, observationUserTurnId);
        if (!derivedAssistant) throw new Error("Persistent ChatGPT assistant turn has not materialized yet");
        assistantTurnId = derivedAssistant;
        await assertNoTerminalError(currentPage, derivedAssistant);
        return await captureAnswer(currentPage, derivedAssistant);
      };
      const observeStableBoundary = async (opRef: string): Promise<string> => {
        if (!acceptedConversationId || !acceptedUserTurnId) {
          throw new Error("Persistent ChatGPT turn identity is not durable enough for an answer boundary");
        }
        boundaryCaptureInFlight = true;
        try {
          let stableSignature: string | undefined;
          let stableSince = 0;
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const current = await observeAnchoredProjection();
            const signature = projectionSignature(current);
            const now = Date.now();
            if (stableSignature === signature) {
              if (now - stableSince >= boundarySettleMs) {
                boundaryRevision += 1;
                completionTracker.observeToolBatch(boundaryRevision, current.text);
                lastBoundaryText = current.text;
                return boundaryJson({
                  opRef,
                  conversationId: acceptedConversationId,
                  acceptedUserTurnId,
                  projection: current,
                });
              }
            } else {
              stableSignature = signature;
              stableSince = now;
            }
            await sleep(Math.min(pollMs, Math.max(1, boundarySettleMs)));
          }
          throw new Error("Persistent ChatGPT answer boundary did not stabilize");
        } finally {
          boundaryCaptureInFlight = false;
        }
      };
      const waitForAcceptedIdentity = async (): Promise<void> => {
        if (!baseline) throw new Error("Persistent ChatGPT submission baseline is missing");
        // Once the durable send fence is armed, elapsed time cannot prove non-acceptance. Keep the
        // owned observer alive until remote identity appears or an actual abort/browser failure occurs.
        for (;;) {
          abortIfRequested(input.preSendAbortSignal);
          const currentPage = requireLiveSurface();
          const snapshot = await captureSnapshot(currentPage);
          // The snapshot already reduces nested data-turn-id-container duplicates to one logical
          // outer turn identity. Do not classify error UI before broker identity is durable: once the
          // accepted Goose user anchor is recorded, same-chat recovery owns terminal/error handling.
          const userTurn = acceptedUserTurnIdentity(baseline.turnIdentities, snapshot);
          let conversationId: string | undefined;
          try {
            const location = classifyChatGptConversationUrl(currentPage.url());
            if (location.kind === "canonical") conversationId = location.conversationId;
          } catch {
            // Fresh Project chat may not expose /c/<uuid> until the accepted send canonicalizes.
          }
          if (userTurn && conversationId) {
            if (input.existingConversationId
              && conversationId !== normalizeCanonicalChatGptConversationId(input.existingConversationId)) {
              throw new Error("Persistent ChatGPT continuation canonicalized onto a different conversation");
            }
            acceptedConversationId = conversationId;
            acceptedUserTurnId = userTurn;
            observationUserTurnId = userTurn;
            await input.lifecycle.onAccepted({ canonicalConversationId: conversationId, acceptedUserTurnId: userTurn });
            return;
          }
          await sleep(pollMs);
        }
      };
      const waitForFinalCandidate = async (): Promise<RebuildBrowserFinalEvidence> => {
        let terminalViewRefreshed = false;
        // Once ChatGPT has accepted the remote user turn, elapsed time is not terminal evidence.
        // Keep the exact launcher-owned observer alive until authoritative DOM/tool/browser state
        // proves completion. If only the disposable observer disappears, reconstruct that view
        // from the durable canonical conversation/user anchor as often as needed; never replay the accepted prompt.
        for (;;) {
          try {
            if (boundaryCaptureInFlight) { await sleep(pollMs); continue; }
            const currentPage = requireLiveSurface();
            const snapshot = await captureSnapshot(currentPage);
          if (!acceptedUserTurnId || !acceptedConversationId) throw new Error("Persistent ChatGPT accepted identity disappeared");
          if (!observationUserTurnId) throw new Error("Persistent ChatGPT observation anchor disappeared");
          const derivedAssistant = assistantTurnForAcceptedUser(snapshot, observationUserTurnId);
          if (!derivedAssistant) { await sleep(pollMs); continue; }
          assistantTurnId = derivedAssistant;
          try {
            await assertNoTerminalError(currentPage, derivedAssistant);
            terminalViewRefreshed = false;
          } catch (error) {
            if (!(error instanceof ChatGptUpstreamTerminalError)) throw error;
            if (!terminalViewRefreshed) {
              if (!await reopenAcceptedSurface()) { await sleep(pollMs); continue; }
              terminalViewRefreshed = true;
              staleObservation = undefined;
              staleObservationRecoveryStage = "refreshed";
            } else {
              if (!await sendRecoveryContinuation()) { await sleep(pollMs); continue; }
              terminalViewRefreshed = false;
            }
            continue;
          }
          const projection = await captureAnswer(currentPage, derivedAssistant);
          const running = await currentPage.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
          const semanticProgress = input.gooseWork.snapshot();
          const toolWorkInFlight = semanticProgress.activeToolCalls > 0;
          const toolProgressLive = toolWorkInFlight
            && chatGptExternalProgressIsRecent(semanticProgress, Date.now(), semanticObservationRefreshMs);
          const stoppedWithoutIntendedFinal = !running && (
            projection.text.trim().length === 0
            || (boundaryRevision > 0 && projection.text === lastBoundaryText)
          );
          const ready = !stoppedWithoutIntendedFinal && completionTracker.update({
            responsePresent: true,
            running,
            currentText: projection.text,
            currentHtml: projection.html,
            completionActionVisible: projection.completionActionVisible,
            externalToolCallsInFlight: toolWorkInFlight,
          });
          if (ready) {
            return {
              canonicalConversationId: acceptedConversationId,
              acceptedUserTurnId,
              text: projection.text,
              remoteNonRunning: true,
              ...(boundaryRevision > 0 ? { contentAdvancedAfterLastTool: projection.text !== lastBoundaryText } : {}),
            };
          }
          const staleObservationKind: StaleObservationKind | undefined = toolProgressLive
              ? undefined
              : running
                ? "running"
                : stoppedWithoutIntendedFinal
                  ? "stopped-no-final"
                  : !projection.completionActionVisible
                    ? "missing-completion-action"
                    : toolWorkInFlight
                      ? "stale-tool"
                      : undefined;
          if (!staleObservationKind) {
            staleObservation = undefined;
            staleObservationRecoveryStage = "initial";
          } else {
            const signature = projectionSignature(projection);
            const now = Date.now();
            if (!staleObservation || staleObservation.kind !== staleObservationKind) {
              staleObservation = { kind: staleObservationKind, signature, progressRevision: semanticProgress.revision, since: now };
              staleObservationRecoveryStage = "initial";
            } else if (staleObservation.signature !== signature
              || staleObservation.progressRevision !== semanticProgress.revision) {
              // Content progress restarts only the settle clock. It does not erase a refresh already
              // performed for this same stale-observation episode.
              staleObservation = { kind: staleObservationKind, signature, progressRevision: semanticProgress.revision, since: now };
            } else {
              // A visible running state is positive work evidence; only the long watchdog may
              // refresh that disposable view while generation is still active.
              const recoveryThresholdMs = staleObservationKind === "running"
                ? staleObservationSubsequentRefreshMs
                : staleObservationRecoveryStage === "initial"
                  ? staleObservationFirstRefreshMs
                  : staleObservationSubsequentRefreshMs;
              if (now - staleObservation.since >= recoveryThresholdMs) {
                if ((staleObservationKind === "missing-completion-action" || staleObservationKind === "stopped-no-final")
                  && staleObservationRecoveryStage === "refreshed") {
                  if (!await sendRecoveryContinuation()) {
                    staleObservation = undefined;
                    continue;
                  }
                  terminalViewRefreshed = false;
                } else {
                  // Browser state is only a view. Reconstruct that view in the same canonical
                  // conversation, settle it, then reassess instead of retiring the provider chat.
                  if (!await reopenAcceptedSurface()) {
                    staleObservation = undefined;
                    continue;
                  }
                  staleObservationRecoveryStage = "refreshed";
                }
                staleObservation = staleObservationRecoveryStage === "refreshed"
                  ? {
                      kind: staleObservationKind,
                      signature: "",
                      progressRevision: input.gooseWork.snapshot().revision,
                      since: Date.now(),
                    }
                  : undefined;
                continue;
              }
            }
          }
            await sleep(pollMs);
          } catch (error) {
            if (await recoverLostAcceptedSurface(error)) continue;
            throw error;
          }
        }
      };
      const confirmFreshFinal = async (candidate: RebuildBrowserFinalEvidence): Promise<RebuildBrowserFinalEvidence> => {
        if (input.gooseWork.snapshot().activeToolCalls > 0) throw new Error("Goose tool work became active during final confirmation");
        const first = await observeAnchoredProjection();
        const currentPage = requireLiveSurface();
        const firstRunning = await currentPage.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
        if (firstRunning || !first.completionActionVisible) throw new Error("ChatGPT final confirmation is not terminal");
        await sleep(confirmationSettleMs);
        if (input.gooseWork.snapshot().activeToolCalls > 0) throw new Error("Goose tool work became active during final confirmation");
        const second = await observeAnchoredProjection();
        const secondRunning = await currentPage.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
        if (secondRunning || !second.completionActionVisible
          || projectionSignature(first) !== projectionSignature(second)
          || second.text !== candidate.text) {
          throw new Error("ChatGPT final confirmation changed after the completion claim");
        }
        if (!acceptedConversationId || !acceptedUserTurnId) throw new Error("Persistent ChatGPT final identity is missing");
        const confirmed: RebuildBrowserFinalEvidence = {
          canonicalConversationId: acceptedConversationId,
          acceptedUserTurnId,
          text: second.text,
          remoteNonRunning: true,
          ...(boundaryRevision > 0 ? { contentAdvancedAfterLastTool: second.text !== lastBoundaryText } : {}),
        };
        stopHeartbeat();
        await closeConnection();
        await endLauncher("completed", true, connectorBound);
        return confirmed;
      };

      return {
        captureAnswerBoundary: observeStableBoundary,
        detachExecution: async reason => {
          if (executionDetached) return;
          executionDetached = new Error(`Persistent browser execution attachment detached: ${reason}`);
          stopHeartbeat();
          await closeConnection();
          await endLauncher("failed").catch(() => {});
        },
        confirmFinal: async candidate => {
          try {
            return await confirmFreshFinal(candidate);
          } catch (error) {
            await detachWithoutTerminalMutation();
            throw error;
          }
        },
        run: async () => {
          try {
            abortIfRequested(input.preSendAbortSignal);
            const lease = await notifyTurn(options.descriptorPath, {
              phase: "start",
              traceId,
              helperPid: process.pid,
              conversationKey,
              connectorIdentity: options.connectorName,
              ...(input.existingConversationId ? { requireRetainedConversation: true } : {}),
            });
            if (!lease.surfaceId) throw new Error("Launcher did not return an owned surface for the persistent turn");
            leasedSurfaceId = lease.surfaceId;
            if (input.existingConversationId) {
              if (lease.surfaceRecreated === true) {
                if (lease.reused !== false || lease.connectorBound !== false) {
                  throw new Error("Launcher replacement surface returned contradictory retained-conversation state");
                }
                surfaceRecreated = true;
              } else {
                // A surviving BrowserHost view may carry only the exact connector assignment that was
                // established by a qualified completed turn. The durable remote identity still comes
                // from the broker's canonical ChatGPT conversation id, not from this tab lease.
                if (lease.connectorBound !== true) {
                  throw new Error("Launcher did not prove the exact retained connector-assigned conversation");
                }
                connectorBound = true;
              }
            } else if (lease.reused === true || lease.connectorBound === true || lease.surfaceRecreated === true) {
              throw new Error("Fresh persistent turn unexpectedly reused or reconstructed a retained surface");
            }
            startHeartbeat();
            connection = await connectSurface(
              options.descriptorPath, timeoutMs, lease.surfaceId, input.preSendAbortSignal,
            );
            page = connection.page;
            const currentPage = requireLiveSurface();
            let expectedExistingConversation: string | undefined;
            if (input.existingConversationId) {
              expectedExistingConversation = normalizeCanonicalChatGptConversationId(input.existingConversationId);
              const target = canonicalChatGptConversationUrl(expectedExistingConversation);
              if (currentPage.url() === LAUNCHER_BROWSER_IDLE_URL) {
                await currentPage.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
              } else {
                assertExactExistingConversation(currentPage, expectedExistingConversation, "Launcher retained surface");
                await currentPage.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
              }
            } else {
              await options.prepareFreshProjectChat(currentPage, input);
              try {
                const location = classifyChatGptConversationUrl(currentPage.url());
                if (location.kind === "canonical") {
                  throw new Error("Fresh Project preparation returned an existing canonical conversation");
                }
              } catch (error) {
                if (error instanceof Error && error.message.includes("Fresh Project preparation")) throw error;
              }
            }
            await verifyAuthenticated(currentPage, timeoutMs, input.preSendAbortSignal);
            if (expectedExistingConversation) {
              assertExactExistingConversation(
                currentPage, expectedExistingConversation,
                surfaceRecreated ? "Recreated BrowserHost surface" : "Retained BrowserHost surface",
              );
            }
            if (input.resumeAccepted) {
              if (!expectedExistingConversation) {
                throw new Error("Persistent browser reattach requires an existing canonical conversation");
              }
              const resumeConversationId = normalizeCanonicalChatGptConversationId(input.resumeAccepted.canonicalConversationId);
              const resumeUserTurnId = validatePersistentChatTurnIdentity(
                input.resumeAccepted.acceptedUserTurnId,
                "reattached accepted user turn",
              );
              if (resumeConversationId !== expectedExistingConversation) {
                throw new Error("Persistent browser reattach conversation does not match the durable epoch");
              }
              acceptedConversationId = resumeConversationId;
              acceptedUserTurnId = resumeUserTurnId;
              observationUserTurnId = resumeUserTurnId;
              sendActivated = true;
              const rebindDeadline = Date.now() + timeoutMs;
              let rebound = false;
              while (Date.now() < rebindDeadline) {
                const snapshot = await captureSnapshot(currentPage);
                if (acceptedUserAnchorPresent(snapshot, resumeUserTurnId)) {
                  rebound = true;
                  break;
                }
                await sleep(pollMs);
              }
              if (!rebound) {
                throw new Error("Persistent browser reattach could not prove the durable accepted user-turn anchor");
              }
              await input.lifecycle.onRebound?.({
                canonicalConversationId: resumeConversationId,
                acceptedUserTurnId: resumeUserTurnId,
              });
              return await waitForFinalCandidate();
            }
            let preparedComposer: Locator | undefined;
            if (!input.existingConversationId || surfaceRecreated) {
              // Fresh/recreated views may carry stale draft or connector-pill UI state. Clearing that
              // UI state is cleanup only; authenticated canonical conversation identity is the send gate.
              preparedComposer = await prepareOrdinaryComposer(currentPage);
              connectorBound = true;
            }
            baseline = await captureSnapshot(currentPage);
            if (!input.prompt) throw new Error("Persistent browser turn is missing its provider-rendered prompt");
            const composer = await attachExactPrompt(
              currentPage, input.prompt, timeoutMs, input.preSendAbortSignal, preparedComposer,
              false, thinkMode,
            );
            await input.lifecycle.onSendActivated();
            sendActivated = true;
            await pressComposerSend(composer);
            await waitForAcceptedIdentity();
            return await waitForFinalCandidate();
          } catch (error) {
            if (sendActivated) await detachWithoutTerminalMutation();
            else await failBeforeSend();
            throw error;
          }
        },
      };
    },
  };
}
