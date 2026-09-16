import { expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
} from "../src/chatgpt-session";
import { LAUNCHER_BROWSER_IDLE_URL, type LauncherBrowserConnection } from "../src/launcher-browser-host";
import {
  createRebuildPersistentBrowserDriver,
  rebuildConversationKey,
  type RebuildAnswerProjection,
} from "../src/rebuild-persistent-browser-driver";
import type { PersistentChatTurnSnapshot } from "../src/persistent-chat-surface";
import type { RebuildPersistentBrowserTurnInput } from "../src/rebuild-provider-runtime";
import { ChatGptUpstreamTerminalError } from "../src/chatgpt-terminal-state";

const CONVERSATION = "aaaaaaaa-bbbb-4ccc-8ddd-000000000111";
const SURFACE = "s".repeat(32);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface FakeSurface {
  page: Page;
  setUrl(value: string): void;
  setRunning(value: boolean): void;
  setClosed(value: boolean): void;
  setTerminalError(turnId: string, value: boolean): void;
  setTurnContainerCount(turnId: string, value: number): void;
  composerText(): string;
  gotos: string[];
  reloads: number;
  browserCloses(): number;
}

function fakeSurface(onSend: () => void, initialUrl = LAUNCHER_BROWSER_IDLE_URL): FakeSurface {
  let url = initialUrl;
  let text = "";
  let closes = 0;
  let running = false;
  let closed = false;
  const terminalErrorTurnIds = new Set<string>();
  const turnContainerCounts = new Map<string, number>();
  const gotos: string[] = [];
  let reloads = 0;

  const sendButton = {
    waitFor: async () => {},
    isEnabled: async () => true,
    press: async () => { onSend(); },
  };
  const composer = {
    fill: async (value: string) => { text = value; },
    focus: async () => {},
    press: async () => {},
    evaluate: async (_fn: unknown, arg: unknown) => {
      if (typeof arg === "string") { text = arg.startsWith(" ") ? arg.slice(1) : arg; return true; }
      return text;
    },
    locator: () => ({ getByTestId: () => sendButton }),
  };
  const composers = {
    filter: () => composers,
    count: async () => 1,
    first: () => composer,
  };
  const stop = { isVisible: async () => running };
  const hidden = { last: () => hidden, isVisible: async () => false };
  const turnScope = (turnId: string) => {
    const regenerate = { last: () => regenerate, isVisible: async () => terminalErrorTurnIds.has(turnId) };
    const scope = {
      first: () => scope,
      count: async () => 1,
      getByTestId: (id: string) => id === "regenerate-thread-error-button" ? regenerate : hidden,
      getByText: () => hidden,
    };
    return scope;
  };
  const page = {
    url: () => url,
    isClosed: () => closed,
    getByTestId: () => hidden,
    getByText: () => hidden,
    goto: async (target: string) => { gotos.push(target); url = target; return null; },
    reload: async () => { reloads += 1; return null; },
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composers;
      if (selector === CHATGPT_STOP_BUTTON_SELECTOR) return { last: () => stop };
      const turnMatch = /^\[data-turn-id-container=(?:"([^"]+)"|'([^']+)')\]$/.exec(selector);
      if (turnMatch) {
        const turnId = turnMatch[1] ?? turnMatch[2]!;
        const first = turnScope(turnId);
        return {
          ...first,
          count: async () => turnContainerCounts.get(turnId) ?? 1,
          first: () => first,
        };
      }
      throw new Error(`Unexpected locator: ${selector}`);
    },
  } as unknown as Page;
  const browser = { close: async () => { closes += 1; } } as unknown as Browser;
  return {
    page,
    setUrl: value => { url = value; },
    setRunning: value => { running = value; },
    setClosed: value => { closed = value; },
    setTerminalError: (turnId, value) => {
      if (value) terminalErrorTurnIds.add(turnId);
      else terminalErrorTurnIds.delete(turnId);
    },
    setTurnContainerCount: (turnId, value) => { turnContainerCounts.set(turnId, value); },
    composerText: () => text,
    gotos,
    get reloads() { return reloads; },
    browserCloses: () => closes,
  };
}

function browserConnection(surface: FakeSurface): LauncherBrowserConnection {
  return {
    descriptor: {} as LauncherBrowserConnection["descriptor"],
    browser: { close: async () => { await (surface.page as any); } } as unknown as Browser,
    context: {} as BrowserContext,
    page: surface.page,
  };
}

function snapshotsAfterSend(sent: () => boolean): PersistentChatTurnSnapshot {
  return sent()
    ? { turnIdentities: ["user-1", "assistant-1"], userIdentities: ["user-1"], assistantIdentities: ["assistant-1"] }
    : { turnIdentities: [], userIdentities: [], assistantIdentities: [] };
}

function projection(text: string): RebuildAnswerProjection {
  return { assistantTurnId: "assistant-1", text, html: `<p>${text}</p>`, completionActionVisible: true };
}

function makeInput(options: {
  existingConversationId?: string | null;
  resumeAccepted?: RebuildPersistentBrowserTurnInput["resumeAccepted"];
  prompt?: string;
  toolInFlight?: () => boolean;
  gooseWork?: RebuildPersistentBrowserTurnInput["gooseWork"];
  onSendActivated?: () => void;
  onAccepted?: (conversationId: string, userTurnId: string) => void;
  onRebound?: (conversationId: string, userTurnId: string) => void;
  abortController?: AbortController;
} = {}): RebuildPersistentBrowserTurnInput {
  const controller = options.abortController ?? new AbortController();
  let priorToolState = false;
  let progressRevision = 0;
  let lastToolBatchRevision = 0;
  let lastProgressAt: number | undefined;
  const gooseWork = options.gooseWork ?? {
    snapshot: () => {
      const active = options.toolInFlight?.() ?? false;
      if (active !== priorToolState) {
        progressRevision += 1;
        if (active) lastToolBatchRevision = progressRevision;
        lastProgressAt = Date.now();
        priorToolState = active;
      }
      return {
        revision: progressRevision,
        lastToolBatchRevision,
        activeToolCalls: active ? 1 : 0,
        ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
      };
    },
  };
  return {
    turnRef: "turn_browser_driver_test",
    gooseSessionId: "goose-browser-driver",
    epoch: 1,
    initialOpRef: "op_browser_driver_1",
    submitNonce: "submit_browser_driver_1",
    prompt: options.prompt ?? "submit_browser_driver_1:op_browser_driver_1",
    existingConversationId: options.existingConversationId ?? null,
    ...(options.resumeAccepted ? { resumeAccepted: options.resumeAccepted } : {}),
    preSendAbortSignal: controller.signal,
    gooseWork,
    lifecycle: {
      onSendActivated: options.onSendActivated ?? (() => {}),
      onAccepted: evidence => options.onAccepted?.(evidence.canonicalConversationId, evidence.acceptedUserTurnId),
      onRebound: evidence => options.onRebound?.(evidence.canonicalConversationId, evidence.acceptedUserTurnId),
    },
  };
}

function createHarness(options: {
  surface: FakeSurface;
  captureSnapshot: (page?: Page) => Promise<PersistentChatTurnSnapshot>;
  captureAnswer?: (page?: Page) => Promise<RebuildAnswerProjection>;
  prepareFresh?: (page: Page, input: RebuildPersistentBrowserTurnInput) => Promise<void>;
  clearConnectorComposer?: (...args: any[]) => Promise<void>;
  setThinkMode?: (...args: any[]) => Promise<void>;
  assertNoTerminalError?: (page: Page, assistantTurnId: string) => Promise<void>;
  connectSurface?: (...args: any[]) => Promise<LauncherBrowserConnection>;
  approvalFenceVisible?: (page: Page) => Promise<boolean>;
  reopenBinding?: (...args: any[]) => Promise<any>;
  timeoutMs?: number;
  staleObservationFirstRefreshMs?: number;
  staleObservationSubsequentRefreshMs?: number;
  semanticObservationRefreshMs?: number;
  startLease?: {
    surfaceId: string;
    reused: boolean;
    connectorBound: boolean;
    surfaceRecreated?: boolean;
  };
  recoveryStartLease?: {
    surfaceId: string;
    reused: boolean;
    connectorBound: boolean;
    surfaceRecreated?: boolean;
  };
}) {
  const activities: any[] = [];
  let closes = 0;
  let startCalls = 0;
  const connection = browserConnection(options.surface);
  connection.browser = { close: async () => { closes += 1; } } as unknown as Browser;
  const driver = createRebuildPersistentBrowserDriver({
    descriptorPath: "/fake/descriptor.json",
    projectId: "g-p-test",
    connectorName: "Goose Native 2nd Shift",
    connectorMentionQuery: "@Goose Native",
    timeoutMs: options.timeoutMs ?? 500,
    pollMs: 0,
    boundarySettleMs: 0,
    confirmationSettleMs: 0,
    completionSettleMs: 0,
    postToolAnswerGraceMs: 50,
    staleObservationFirstRefreshMs: options.staleObservationFirstRefreshMs,
    staleObservationSubsequentRefreshMs: options.staleObservationSubsequentRefreshMs,
    semanticObservationRefreshMs: options.semanticObservationRefreshMs,
    prepareFreshProjectChat: options.prepareFresh ?? (async () => {}),
    dependencies: {
      notifyTurn: (async (_path: string, activity: any) => {
        activities.push(activity);
        if (activity.phase === "start") {
          startCalls += 1;
          if (startCalls > 1 && options.recoveryStartLease) return options.recoveryStartLease;
          return options.startLease ?? {
            surfaceId: SURFACE,
            reused: activity.requireRetainedConversation === true,
            connectorBound: activity.requireRetainedConversation === true,
          };
        }
        if (activity.phase === "end") return { cancelledByUser: false };
        return {};
      }) as any,
      connectSurface: options.connectSurface ?? (async () => connection) as any,
      captureSnapshot: async page => await options.captureSnapshot(page),
      captureAnswer: async page => options.captureAnswer ? await options.captureAnswer(page) : projection("final answer"),
      verifyAuthenticated: async () => {},
      clearConnectorComposer: options.clearConnectorComposer ?? (async () => {}),
      setThinkMode: options.setThinkMode ?? (async () => {}),
      assertNoTerminalError: options.assertNoTerminalError ?? (async () => {}),
      approvalFenceVisible: options.approvalFenceVisible ?? (async () => false),
      reopenBinding: options.reopenBinding,
      sleep: async () => { await Bun.sleep(1); },
    },
  });
  return { driver, activities, closes: () => closes };
}

test("existing persistent conversation reopens exact canonical chat, fences send, then retains after fresh final confirmation", async () => {
  let sent = false;
  const order: string[] = [];
  let accepted: [string, string] | undefined;
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    order.push("press-enter");
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const harness = createHarness({ surface, captureSnapshot: async () => snapshotsAfterSend(() => sent) });
  const input = makeInput({
    existingConversationId: CONVERSATION,
    onSendActivated: () => { order.push("durable-send-fence"); },
    onAccepted: (conversationId, userTurnId) => { accepted = [conversationId, userTurnId]; },
  });
  const execution = harness.driver.createTurn(input);
  const candidate = await execution.run();

  expect(order).toEqual(["durable-send-fence", "press-enter"]);
  expect(surface.gotos).toEqual([`https://chatgpt.com/c/${CONVERSATION}`]);
  expect(surface.composerText()).toBe(`${input.submitNonce}:${input.initialOpRef}`);
  expect(accepted).toEqual([CONVERSATION, "user-1"]);
  expect(candidate).toMatchObject({ text: "final answer", remoteNonRunning: true });
  expect(harness.activities.some(activity => activity.phase === "end")).toBeFalse();

  const confirmed = await execution.confirmFinal(candidate);
  expect(confirmed.text).toBe("final answer");
  expect(harness.activities.at(-1)).toMatchObject({
    phase: "end", status: "completed", retain: true, connectorBound: true,
  });
  expect(harness.closes()).toBe(1);
  expect(harness.activities[0]).toMatchObject({
    phase: "start",
    conversationKey: rebuildConversationKey("g-p-test", input.gooseSessionId, input.epoch),
    connectorIdentity: "Goose Native 2nd Shift",
    requireRetainedConversation: true,
  });
});

test("recreated BrowserHost surface reopens the same durable conversation and sends without connector discovery", async () => {
  let sent = false;
  let sendFence = 0;
  const order: string[] = [];
  let surface!: FakeSurface;
  surface = fakeSurface(() => { sent = true; });
  const harness = createHarness({
    surface,
    startLease: {
      surfaceId: SURFACE, reused: false, connectorBound: false, surfaceRecreated: true,
    },
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    clearConnectorComposer: async () => { order.push("clear"); },
    setThinkMode: async () => { order.push("think"); },
  });
  const execution = harness.driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    onSendActivated: () => { sendFence += 1; },
  }));

  const candidate = await execution.run();
  await execution.confirmFinal(candidate);

  expect(sendFence).toBe(1);
  expect(surface.gotos).toEqual([`https://chatgpt.com/c/${CONVERSATION}`]);
  expect(order.slice(0, 2)).toEqual(["clear", "think"]);
  expect(harness.activities.at(-1)).toMatchObject({
    phase: "end", status: "completed", retain: true, connectorBound: true,
  });
});

test("recreated BrowserHost surface refuses a different canonical conversation before send", async () => {
  let sent = false;
  let sendFence = 0;
  const surface = fakeSurface(() => { sent = true; });
  (surface.page as any).goto = async (target: string) => {
    surface.gotos.push(target);
    surface.setUrl("https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-000000000222");
    return null;
  };
  const harness = createHarness({
    surface,
    startLease: {
      surfaceId: SURFACE, reused: false, connectorBound: false, surfaceRecreated: true,
    },
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
  });
  const execution = harness.driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    onSendActivated: () => { sendFence += 1; },
  }));

  await expect(execution.run()).rejects.toThrow("exact durable ChatGPT conversation");
  expect(sent).toBeFalse();
  expect(sendFence).toBe(0);
  expect(harness.activities.at(-1)).toMatchObject({ phase: "end", status: "failed" });
});

test("fresh epoch delegates Project entry to the injected preparer and never guesses a canonical/project route", async () => {
  let sent = false;
  let prepared = 0;
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const harness = createHarness({
    surface,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    prepareFresh: async page => {
      prepared += 1;
      surface.setUrl("https://chatgpt.com/project/g-p-test/new");
      expect(page).toBe(surface.page);
    },
  });
  const execution = harness.driver.createTurn(makeInput());
  const candidate = await execution.run();
  await execution.confirmFinal(candidate);
  expect(prepared).toBe(1);
  expect(surface.gotos).toEqual([]);
});

test("fresh completion assigns connector identity locally while retained turns reuse only that exact assignment", async () => {
  let freshSent = false;
  const freshOrder: string[] = [];
  let freshThink = 0;
  let freshSurface!: FakeSurface;
  freshSurface = fakeSurface(() => {
    freshSent = true;
    freshSurface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const fresh = createHarness({
    surface: freshSurface,
    captureSnapshot: async () => snapshotsAfterSend(() => freshSent),
    prepareFresh: async () => { freshSurface.setUrl("https://chatgpt.com/g/g-p-test-project/project"); },
    clearConnectorComposer: async () => { freshOrder.push("clear"); },
    setThinkMode: async (_form, enabled: boolean) => { expect(enabled).toBeTrue(); freshOrder.push("think"); freshThink += 1; },
  });
  const freshExecution = fresh.driver.createTurn(makeInput());
  const freshCandidate = await freshExecution.run();
  await freshExecution.confirmFinal(freshCandidate);
  expect(freshOrder.slice(0, 2)).toEqual(["clear", "think"]);
  expect(freshThink).toBe(1);
  expect(fresh.activities[0]).toMatchObject({
    phase: "start", connectorIdentity: "Goose Native 2nd Shift",
  });
  expect(fresh.activities[0].requireRetainedConversation).toBeUndefined();
  expect(fresh.activities.at(-1)).toMatchObject({
    phase: "end", retain: true, connectorBound: true,
  });

  let retainedSent = false;
  let retainedClears = 0;
  let retainedThink = 0;
  let retainedSurface!: FakeSurface;
  retainedSurface = fakeSurface(() => {
    retainedSent = true;
    retainedSurface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const retained = createHarness({
    surface: retainedSurface,
    captureSnapshot: async () => snapshotsAfterSend(() => retainedSent),
    clearConnectorComposer: async () => { retainedClears += 1; },
    setThinkMode: async (_form, enabled: boolean) => { expect(enabled).toBeTrue(); retainedThink += 1; },
  });
  const retainedExecution = retained.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  const retainedCandidate = await retainedExecution.run();
  await retainedExecution.confirmFinal(retainedCandidate);
  expect(retainedClears).toBe(0);
  expect(retainedThink).toBe(1);
  expect(retained.activities[0]).toMatchObject({
    phase: "start",
    connectorIdentity: "Goose Native 2nd Shift",
    requireRetainedConversation: true,
  });
  expect(retained.activities.at(-1)).toMatchObject({
    phase: "end", retain: true, connectorBound: true,
  });
});

test("retained epoch fails before send when launcher cannot prove the connector-assigned lease", async () => {
  let sent = false;
  let sendFence = 0;
  const surface = fakeSurface(() => { sent = true; });
  const activities: any[] = [];
  const connection = browserConnection(surface);
  const driver = createRebuildPersistentBrowserDriver({
    descriptorPath: "/fake/descriptor.json",
    projectId: "g-p-test",
    connectorName: "Goose Native 2nd Shift",
    connectorMentionQuery: "@Goose Native",
    timeoutMs: 500,
    pollMs: 0,
    completionSettleMs: 0,
    prepareFreshProjectChat: async () => {},
    dependencies: {
      notifyTurn: (async (_path: string, activity: any) => {
        activities.push(activity);
        if (activity.phase === "start") return { surfaceId: SURFACE, reused: true, connectorBound: false };
        if (activity.phase === "end") return { cancelledByUser: false };
        return {};
      }) as any,
      connectSurface: (async () => connection) as any,
      captureSnapshot: async () => snapshotsAfterSend(() => sent),
      captureAnswer: async () => projection("final answer"),
      verifyAuthenticated: async () => {},
      sleep: async () => {},
    },
  });
  const execution = driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    onSendActivated: () => { sendFence += 1; },
  }));
  await expect(execution.run()).rejects.toThrow("exact retained connector-assigned conversation");
  expect(sent).toBeFalse();
  expect(sendFence).toBe(0);
  expect(activities.at(-1)).toMatchObject({ phase: "end", status: "failed" });
});

test("fresh epoch clears restored Project draft then uses ordinary connected-app routing", async () => {
  let sent = false;
  const order: string[] = [];
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const harness = createHarness({
    surface,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    prepareFresh: async () => { surface.setUrl("https://chatgpt.com/g/g-p-test-project/project"); },
    clearConnectorComposer: async () => { order.push("clear"); },
    setThinkMode: async () => { order.push("think"); },
  });
  const execution = harness.driver.createTurn(makeInput());
  const candidate = await execution.run();
  expect(order.slice(0, 2)).toEqual(["clear", "think"]);
  expect(candidate.text).toBe("final answer");
});

test("Think preparation failure stays before the durable send fence and never persists connector binding", async () => {
  let sent = false;
  let sendFence = 0;
  let surface!: FakeSurface;
  surface = fakeSurface(() => { sent = true; });
  const harness = createHarness({
    surface,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    prepareFresh: async () => { surface.setUrl("https://chatgpt.com/g/g-p-test-project/project"); },
    setThinkMode: async () => { throw new Error("synthetic Think unavailable"); },
  });
  const execution = harness.driver.createTurn(makeInput({ onSendActivated: () => { sendFence += 1; } }));
  await expect(execution.run()).rejects.toThrow("Think unavailable");
  expect(sent).toBeFalse();
  expect(sendFence).toBe(0);
  expect(harness.activities.at(-1)).toMatchObject({ phase: "end", status: "failed" });
  expect(harness.activities.at(-1).connectorBound).toBeUndefined();
});

test("pre-send preparation failure cleans up its launcher tab and remains safely retryable", async () => {
  let sent = false;
  const surface = fakeSurface(() => { sent = true; });
  const harness = createHarness({
    surface,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    prepareFresh: async () => { surface.setUrl("https://chatgpt.com/project/g-p-test/new"); },
  });
  const execution = harness.driver.createTurn(makeInput({ prompt: "" }));
  await expect(execution.run()).rejects.toThrow("missing its provider-rendered prompt");
  expect(sent).toBeFalse();
  expect(harness.activities.at(-1)).toMatchObject({ phase: "end", status: "failed" });
  expect(harness.closes()).toBe(1);
});

test("accepted turn reconstructs one lost disposable surface and continues observation without resend", async () => {
  let sent = false;
  let sends = 0;
  let snapshotCalls = 0;
  const first = fakeSurface(() => {
    sent = true;
    sends += 1;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const recovered = fakeSurface(() => { throw new Error("recovered observer must never resend"); });
  const connections = [browserConnection(first), browserConnection(recovered)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    prepareFresh: async () => { first.setUrl("https://chatgpt.com/project/g-p-test/new"); },
    recoveryStartLease: {
      surfaceId: "r".repeat(32), reused: false, connectorBound: false, surfaceRecreated: true,
    },
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async page => {
      snapshotCalls += 1;
      if (page === first.page && snapshotCalls === 1) return snapshotsAfterSend(() => false);
      if (page === first.page && snapshotCalls === 2) return snapshotsAfterSend(() => true);
      if (page === first.page) {
        // Real Playwright public API shape: Error name, canonical target-closed message, while the
        // close event may not yet have updated Page.isClosed().
        throw new Error("evaluate: Target page, context or browser has been closed");
      }
      return snapshotsAfterSend(() => true);
    },
  });
  const execution = harness.driver.createTurn(makeInput());
  const candidate = await execution.run();
  expect(candidate.text).toBe("final answer");
  expect(sent).toBeTrue();
  expect(sends).toBe(1);
  expect(recovered.gotos).toEqual([`https://chatgpt.com/c/${CONVERSATION}`]);
  expect(harness.activities.filter(activity => activity.phase === "start")).toHaveLength(2);
  expect(harness.activities.filter(activity => activity.phase === "end")).toEqual([]);
  const confirmed = await execution.confirmFinal(candidate);
  expect(confirmed.text).toBe("final answer");
  expect(harness.activities.at(-1)).toMatchObject({
    phase: "end", status: "completed", retain: true, connectorBound: false,
  });
});

test("accepted turn does not reconstruct on a generic post-send browser error", async () => {
  let sent = false;
  let snapshotCalls = 0;
  const first = fakeSurface(() => { sent = true; first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`); });
  const harness = createHarness({
    surface: first,
    prepareFresh: async () => { first.setUrl("https://chatgpt.com/project/g-p-test/new"); },
    recoveryStartLease: {
      surfaceId: "r".repeat(32), reused: false, connectorBound: false, surfaceRecreated: true,
    },
    captureSnapshot: async page => {
      snapshotCalls += 1;
      if (page === first.page && snapshotCalls === 1) return snapshotsAfterSend(() => false);
      if (page === first.page && snapshotCalls === 2) return snapshotsAfterSend(() => true);
      throw new Error("synthetic generic DOM observation failure");
    },
  });
  const execution = harness.driver.createTurn(makeInput());
  await expect(execution.run()).rejects.toThrow("generic DOM observation failure");
  expect(sent).toBeTrue();
  expect(harness.activities.filter(activity => activity.phase === "start")).toHaveLength(1);
  expect(harness.activities.filter(activity => activity.phase === "end")).toEqual([]);
});

test("accepted turn can reconstruct disposable browser views repeatedly without resending the Goose prompt", async () => {
  let sent = false;
  let sends = 0;
  let snapshotCalls = 0;
  const first = fakeSurface(() => { sent = true; sends += 1; first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`); });
  const recovered1 = fakeSurface(() => { throw new Error("recovered observer must never resend"); });
  const recovered2 = fakeSurface(() => { throw new Error("second recovered observer must never resend"); });
  const connections = [browserConnection(first), browserConnection(recovered1), browserConnection(recovered2)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    prepareFresh: async () => { first.setUrl("https://chatgpt.com/project/g-p-test/new"); },
    recoveryStartLease: {
      surfaceId: "r".repeat(32), reused: false, connectorBound: false, surfaceRecreated: true,
    },
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async page => {
      snapshotCalls += 1;
      if (page === first.page && snapshotCalls === 1) return snapshotsAfterSend(() => false);
      if (page === first.page && snapshotCalls === 2) return snapshotsAfterSend(() => true);
      if (page === first.page) { first.setClosed(true); throw new Error("first observer lost"); }
      if (page === recovered1.page && snapshotCalls === 4) return snapshotsAfterSend(() => true);
      if (page === recovered1.page) { recovered1.setClosed(true); throw new Error("second observer lost"); }
      return snapshotsAfterSend(() => true);
    },
  });
  const execution = harness.driver.createTurn(makeInput());
  const candidate = await execution.run();
  expect(candidate.text).toBe("final answer");
  expect(sent).toBeTrue();
  expect(sends).toBe(1);
  expect(harness.activities.filter(activity => activity.phase === "start")).toHaveLength(3);
  expect(harness.activities.filter(activity => activity.phase === "end")).toEqual([]);
});

test("tool liveness plus a fresh answer boundary blocks the pre-tool completion until anchored content advances", async () => {
  let sent = false;
  let toolInFlight = true;
  let answer = "before tool";
  const accepted = deferred<void>();
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const harness = createHarness({
    surface,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async () => projection(answer),
  });
  const input = makeInput({
    existingConversationId: CONVERSATION,
    toolInFlight: () => toolInFlight,
    onAccepted: () => accepted.resolve(),
  });
  const execution = harness.driver.createTurn(input);
  let settled = false;
  const running = execution.run().then(value => { settled = true; return value; });
  await accepted.promise;
  await Bun.sleep(5);
  expect(settled).toBeFalse();

  const boundary = JSON.parse(await execution.captureAnswerBoundary(input.initialOpRef));
  expect(boundary).toMatchObject({
    version: 1,
    opRef: input.initialOpRef,
    conversationId: CONVERSATION,
    acceptedUserTurnId: "user-1",
    assistantTurnId: "assistant-1",
  });
  expect(boundary.answerTextSha256).toMatch(/^[a-f0-9]{64}$/);

  toolInFlight = false;
  await Bun.sleep(5);
  expect(settled).toBeFalse();
  answer = "after tool";
  const candidate = await running;
  expect(candidate.contentAdvancedAfterLastTool).toBeTrue();
  expect(candidate.text).toBe("after tool");
  const confirmed = await execution.confirmFinal(candidate);
  expect(confirmed.contentAdvancedAfterLastTool).toBeTrue();
});

test("repeated hard refresh preserves the post-tool answer boundary until fresh content advances", async () => {
  let sent = false;
  let toolInFlight = true;
  let sends = 0;
  let reopenCalls = 0;
  let freshObservations = 0;
  const accepted = deferred<void>();
  const first = fakeSurface(() => {
    sent = true;
    sends += 1;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const rebound = fakeSurface(() => { throw new Error("rebound surface must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  rebound.setRunning(true);
  const fresh = fakeSurface(() => { throw new Error("reopened surface must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(rebound), browserConnection(fresh)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 5,
    staleObservationSubsequentRefreshMs: 0,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async page => {
      if (page === first.page || page === rebound.page) {
        return { ...projection("before tool"), completionActionVisible: false };
      }
      freshObservations += 1;
      return projection(freshObservations <= 2 ? "before tool" : "after tool");
    },
    reopenBinding: async binding => {
      reopenCalls += 1;
      return { binding, assistantTurnId: "assistant-1", snapshot: snapshotsAfterSend(() => true) };
    },
  });
  const input = makeInput({
    existingConversationId: CONVERSATION,
    toolInFlight: () => toolInFlight,
    onAccepted: () => accepted.resolve(),
  });
  const execution = harness.driver.createTurn(input);
  const running = execution.run();
  await accepted.promise;
  await execution.captureAnswerBoundary(input.initialOpRef);
  toolInFlight = false;

  const candidate = await running;
  expect(candidate.text).toBe("after tool");
  expect(candidate.contentAdvancedAfterLastTool).toBeTrue();
  expect(freshObservations).toBeGreaterThan(2);
  expect(connects).toBe(3);
  expect(reopenCalls).toBe(2);
  expect(sends).toBe(1);
  const confirmed = await execution.confirmFinal(candidate);
  expect(confirmed.contentAdvancedAfterLastTool).toBeTrue();
});

test("send-activated identity acquisition outlives the pre-send timeout without resend", async () => {
  let sent = false;
  let sends = 0;
  let postSendSnapshots = 0;
  let accepted = 0;
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    sends += 1;
  });
  const harness = createHarness({
    surface,
    timeoutMs: 5,
    prepareFresh: async () => { surface.setUrl("https://chatgpt.com/project/g-p-test/new"); },
    captureSnapshot: async () => {
      if (!sent) return snapshotsAfterSend(() => false);
      postSendSnapshots += 1;
      await Bun.sleep(2);
      if (postSendSnapshots < 6) return snapshotsAfterSend(() => false);
      surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
      return snapshotsAfterSend(() => true);
    },
  });
  const execution = harness.driver.createTurn(makeInput({
    onAccepted: () => { accepted += 1; },
  }));
  const candidate = await execution.run();
  expect(postSendSnapshots).toBeGreaterThanOrEqual(6);
  expect(sends).toBe(1);
  expect(accepted).toBe(1);
  expect(candidate.canonicalConversationId).toBe(CONVERSATION);
  expect(candidate.acceptedUserTurnId).toBe("user-1");
  await execution.confirmFinal(candidate);
});

test("send-activated identity acquisition ignores terminal error UI from baseline turns", async () => {
  let sent = false;
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  }, `https://chatgpt.com/c/${CONVERSATION}`);
  surface.setTerminalError("assistant-old", true);
  const baseline = {
    turnIdentities: ["user-old", "assistant-old"],
    userIdentities: ["user-old"],
    assistantIdentities: ["assistant-old"],
  };
  const accepted = {
    turnIdentities: ["user-old", "assistant-old", "user-1", "assistant-1"],
    userIdentities: ["user-old", "user-1"],
    assistantIdentities: ["assistant-old", "assistant-1"],
  };
  const harness = createHarness({
    surface,
    captureSnapshot: async () => sent ? accepted : baseline,
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  const candidate = await execution.run();
  expect(candidate.acceptedUserTurnId).toBe("user-1");
  expect(candidate.text).toBe("final answer");
  await execution.confirmFinal(candidate);
});

test("post-send identity observation relies on the deduplicated outer logical turn snapshot", async () => {
  let sent = false;
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
    surface.setTurnContainerCount("user-1", 2);
    surface.setTurnContainerCount("assistant-1", 2);
  });
  const harness = createHarness({
    surface,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
  });
  const execution = harness.driver.createTurn(makeInput());
  const candidate = await execution.run();
  expect(candidate.text).toBe("final answer");
});

test("pre-acceptance terminal UI does not retire an uncertain accepted send", async () => {
  let sent = false;
  let postSendSnapshots = 0;
  const controller = new AbortController();
  let surface!: FakeSurface;
  surface = fakeSurface(() => { sent = true; });
  const harness = createHarness({
    surface,
    prepareFresh: async () => { surface.setUrl("https://chatgpt.com/project/g-p-test/new"); },
    captureSnapshot: async () => {
      if (!sent) return snapshotsAfterSend(() => false);
      postSendSnapshots += 1;
      surface.setTerminalError("assistant-1", true);
      if (postSendSnapshots >= 3) controller.abort();
      return { turnIdentities: ["assistant-1"], userIdentities: [], assistantIdentities: ["assistant-1"] };
    },
  });
  const execution = harness.driver.createTurn(makeInput({ abortController: controller }));
  await expect(execution.run()).rejects.toThrow("aborted");
  expect(sent).toBeTrue();
  expect(postSendSnapshots).toBeGreaterThanOrEqual(3);
  expect(harness.activities.filter(activity => activity.phase === "end")).toEqual([]);
});

test("send-activated identity acquisition fails promptly when its browser surface closes", async () => {
  let sent = false;
  let postSendSnapshots = 0;
  let surface!: FakeSurface;
  surface = fakeSurface(() => { sent = true; });
  const harness = createHarness({
    surface,
    timeoutMs: 5,
    prepareFresh: async () => { surface.setUrl("https://chatgpt.com/project/g-p-test/new"); },
    captureSnapshot: async () => {
      if (!sent) return snapshotsAfterSend(() => false);
      postSendSnapshots += 1;
      if (postSendSnapshots === 2) surface.setClosed(true);
      return snapshotsAfterSend(() => false);
    },
  });
  const execution = harness.driver.createTurn(makeInput());
  await expect(execution.run()).rejects.toThrow("Persistent ChatGPT browser surface is unavailable");
  expect(sent).toBeTrue();
  expect(harness.activities.filter(activity => activity.phase === "end")).toEqual([]);
  expect(harness.closes()).toBe(1);
});

test("send-activated identity acquisition still stops on an explicit observer abort", async () => {
  let sent = false;
  const abortController = new AbortController();
  let postSendSnapshots = 0;
  const surface = fakeSurface(() => { sent = true; });
  const harness = createHarness({
    surface,
    timeoutMs: 5,
    prepareFresh: async () => { surface.setUrl("https://chatgpt.com/project/g-p-test/new"); },
    captureSnapshot: async () => {
      if (!sent) return snapshotsAfterSend(() => false);
      postSendSnapshots += 1;
      if (postSendSnapshots === 2) abortController.abort();
      return snapshotsAfterSend(() => false);
    },
  });
  const execution = harness.driver.createTurn(makeInput({ abortController }));
  await expect(execution.run()).rejects.toThrow("Persistent browser turn aborted");
  expect(sent).toBeTrue();
  expect(harness.activities.filter(activity => activity.phase === "end")).toEqual([]);
  expect(harness.closes()).toBe(1);
});

test("accepted final observation outlives the pre-send timeout until authoritative completion appears", async () => {
  let sent = false;
  let observations = 0;
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const harness = createHarness({
    surface,
    timeoutMs: 5,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async () => {
      observations += 1;
      return {
        ...projection("eventual answer"),
        completionActionVisible: observations >= 12,
      };
    },
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  const candidate = await execution.run();
  expect(observations).toBeGreaterThanOrEqual(12);
  expect(candidate.text).toBe("eventual answer");
  const confirmed = await execution.confirmFinal(candidate);
  expect(confirmed.text).toBe("eventual answer");
});

test("persistent missing completion action hard-refreshes the same conversation before completion", async () => {
  let sent = false;
  let sends = 0;
  let reopenCalls = 0;
  const first = fakeSurface(() => {
    sent = true;
    sends += 1;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const rebound = fakeSurface(() => { throw new Error("rebound surface must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(rebound)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 0,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async page => page === first.page
      ? { ...projection("final after refresh"), completionActionVisible: false }
      : projection("final after refresh"),
    reopenBinding: async binding => {
      reopenCalls += 1;
      return { binding, assistantTurnId: "assistant-1", snapshot: snapshotsAfterSend(() => true) };
    },
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  const candidate = await execution.run();
  expect(candidate.text).toBe("final after refresh");
  expect(connects).toBe(2);
  expect(reopenCalls).toBe(1);
  expect(sends).toBe(1);
  await execution.confirmFinal(candidate);
  expect(sends).toBe(1);
});

test("persistent stale observation may hard-refresh repeatedly and never resend the Goose prompt", async () => {
  let sent = false;
  let sends = 0;
  let reopenCalls = 0;
  const first = fakeSurface(() => {
    sent = true;
    sends += 1;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const rebound = fakeSurface(() => { throw new Error("rebound surface must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  rebound.setRunning(true);
  const fresh = fakeSurface(() => { throw new Error("reopened surface must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(rebound), browserConnection(fresh)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 0,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async page => page === fresh.page
      ? projection("final after reopen")
      : { ...projection("final after reopen"), completionActionVisible: false },
    reopenBinding: async binding => {
      reopenCalls += 1;
      expect(binding).toEqual({
        surfaceId: SURFACE,
        conversationId: CONVERSATION,
        acceptedUserTurnId: "user-1",
      });
      return { binding, assistantTurnId: "assistant-1", snapshot: snapshotsAfterSend(() => true) };
    },
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  const candidate = await execution.run();
  expect(candidate.text).toBe("final after reopen");
  expect(connects).toBe(3);
  expect(reopenCalls).toBe(2);
  expect(sends).toBe(1);
  await execution.confirmFinal(candidate);
  expect(sends).toBe(1);
});

test("running turn ignores the short refresh threshold and refreshes only at the long watchdog", async () => {
  let sent = false;
  let sends = 0;
  let reopenCalls = 0;
  let runningObservations = 0;
  const first = fakeSurface(() => {
    sent = true;
    sends += 1;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  first.setRunning(true);
  const refreshed = fakeSurface(
    () => { throw new Error("refreshed surface must never resend"); },
    `https://chatgpt.com/c/${CONVERSATION}`,
  );
  const connections = [browserConnection(first), browserConnection(refreshed)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 20,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async page => {
      if (page === first.page) {
        runningObservations += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { ...projection("still running"), completionActionVisible: false };
      }
      return projection("final after long running watchdog refresh");
    },
    reopenBinding: async binding => {
      reopenCalls += 1;
      // With the short threshold incorrectly applied to running turns, refresh happens on the
      // second stable observation. The long watchdog must leave several observations untouched.
      expect(runningObservations).toBeGreaterThanOrEqual(3);
      return { binding, assistantTurnId: "assistant-1", snapshot: snapshotsAfterSend(() => true) };
    },
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  const candidate = await execution.run();
  expect(candidate.text).toBe("final after long running watchdog refresh");
  expect(connects).toBe(2);
  expect(reopenCalls).toBe(1);
  expect(runningObservations).toBeGreaterThanOrEqual(3);
  expect(sends).toBe(1);
  await execution.confirmFinal(candidate);
  expect(sends).toBe(1);
});

test("changing stale-observation kind starts a new refresh episode", async () => {
  let sent = false;
  let sends = 0;
  let reopenCalls = 0;
  const first = fakeSurface(() => {
    sent = true;
    sends += 1;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  first.setRunning(true);
  const rebound = fakeSurface(() => { throw new Error("rebound surface must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  const fresh = fakeSurface(() => { throw new Error("second rebound must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(rebound), browserConnection(fresh)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 0,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async page => page === fresh.page
      ? projection("terminal after kind change")
      : { ...projection("terminal after kind change"), completionActionVisible: false },
    reopenBinding: async binding => {
      reopenCalls += 1;
      return { binding, assistantTurnId: "assistant-1", snapshot: snapshotsAfterSend(() => true) };
    },
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  const candidate = await execution.run();
  expect(candidate.text).toBe("terminal after kind change");
  expect(connects).toBe(3);
  expect(reopenCalls).toBe(2);
  expect(sends).toBe(1);
  await execution.confirmFinal(candidate);
});

test("tool activity clears a stale episode so later staleness starts with refresh again", async () => {
  let sent = false;
  let toolInFlight = false;
  let reboundObservations = 0;
  let reopenCalls = 0;
  const first = fakeSurface(() => {
    sent = true;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const rebound = fakeSurface(() => { throw new Error("rebound surface must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  const fresh = fakeSurface(() => { throw new Error("second rebound must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(rebound), browserConnection(fresh)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 0,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async page => {
      if (page === rebound.page) {
        reboundObservations += 1;
        toolInFlight = reboundObservations === 1;
      }
      return page === fresh.page
        ? projection("terminal after tool activity")
        : { ...projection("terminal after tool activity"), completionActionVisible: false };
    },
    reopenBinding: async binding => {
      reopenCalls += 1;
      return { binding, assistantTurnId: "assistant-1", snapshot: snapshotsAfterSend(() => true) };
    },
  });
  const execution = harness.driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    toolInFlight: () => toolInFlight,
  }));
  const candidate = await execution.run();
  expect(candidate.text).toBe("terminal after tool activity");
  expect(connects).toBe(3);
  expect(reopenCalls).toBe(2);
  await execution.confirmFinal(candidate);
});

test("reattach mode proves the same accepted pair and observes final without sending another Goose prompt", async () => {
  let sends = 0;
  let acceptedCalls = 0;
  let reboundCalls = 0;
  const surface = fakeSurface(() => { sends += 1; }, `https://chatgpt.com/c/${CONVERSATION}`);
  surface.setRunning(false);
  const harness = createHarness({
    surface,
    captureSnapshot: async () => snapshotsAfterSend(() => true),
    captureAnswer: async () => projection("reattached final"),
  });
  const execution = harness.driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    resumeAccepted: {
      canonicalConversationId: CONVERSATION,
      acceptedUserTurnId: "user-1",
    },
    prompt: "",
    onSendActivated: () => { throw new Error("reattach must not arm another send"); },
    onAccepted: () => { acceptedCalls += 1; },
    onRebound: (conversationId, userTurnId) => {
      expect(conversationId).toBe(CONVERSATION);
      expect(userTurnId).toBe("user-1");
      reboundCalls += 1;
    },
  }));

  const candidate = await execution.run();
  expect(candidate.text).toBe("reattached final");
  expect(sends).toBe(0);
  expect(acceptedCalls).toBe(0);
  expect(reboundCalls).toBe(1);
  expect(surface.reloads).toBe(1);
  await execution.confirmFinal(candidate);
});

test("reattached stopped turn refreshes the view then continues privately in the same ChatGPT conversation", async () => {
  let continuationSends = 0;
  let continuationAccepted = false;
  const first = fakeSurface(
    () => { throw new Error("reattach must never resend the original Goose prompt"); },
    `https://chatgpt.com/c/${CONVERSATION}`,
  );
  first.setRunning(false);
  const refreshed = fakeSurface(() => {
    continuationSends += 1;
    continuationAccepted = true;
  }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(refreshed)];
  let connects = 0;
  const continuedSnapshot: PersistentChatTurnSnapshot = {
    turnIdentities: ["user-1", "assistant-1", "user-2", "assistant-2"],
    userIdentities: ["user-1", "user-2"],
    assistantIdentities: ["assistant-1", "assistant-2"],
  };
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 0,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => continuationAccepted
      ? continuedSnapshot
      : snapshotsAfterSend(() => true),
    captureAnswer: async () => continuationAccepted
      ? { ...projection("continued after rebind"), assistantTurnId: "assistant-2" }
      : projection(""),
    reopenBinding: async binding => ({
      binding,
      assistantTurnId: "assistant-1",
      snapshot: snapshotsAfterSend(() => true),
    }),
  });
  const execution = harness.driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    resumeAccepted: {
      canonicalConversationId: CONVERSATION,
      acceptedUserTurnId: "user-1",
    },
    prompt: "",
  }));

  const candidate = await execution.run();
  expect(candidate.text).toBe("continued after rebind");
  expect(continuationSends).toBe(1);
  expect(connects).toBe(2);
  expect(refreshed.composerText()).toContain("continue from there");
});

test("stale-tool observation uses the long watchdog before refreshing and preserves tool authority", async () => {
  let sent = false;
  let originalSends = 0;
  let progress = { revision: 1, lastToolBatchRevision: 1, activeToolCalls: 1, lastProgressAt: 0 };
  let staleToolObservations = 0;
  let refreshedObservations = 0;
  const first = fakeSurface(() => {
    sent = true;
    originalSends += 1;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const refreshed = fakeSurface(
    () => { throw new Error("view recovery must not resend or continue while Goose tool work is active"); },
    `https://chatgpt.com/c/${CONVERSATION}`,
  );
  const connections = [browserConnection(first), browserConnection(refreshed)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    semanticObservationRefreshMs: 1,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 20,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async page => {
      if (page === first.page) {
        staleToolObservations += 1;
        await Bun.sleep(5);
        return projection("tool still pending");
      }
      refreshedObservations += 1;
      if (refreshedObservations < 3) return projection("tool still pending");
      progress = { ...progress, revision: 2, activeToolCalls: 0, lastProgressAt: Date.now() };
      return projection("recovered final");
    },
    reopenBinding: async binding => {
      // The zero short threshold must not make stale-tool recovery aggressive.
      expect(staleToolObservations).toBeGreaterThanOrEqual(3);
      return { binding, assistantTurnId: "assistant-1", snapshot: snapshotsAfterSend(() => true) };
    },
  });
  const execution = harness.driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    gooseWork: { snapshot: () => ({ ...progress }) },
  }));

  const candidate = await execution.run();
  expect(candidate.text).toBe("recovered final");
  expect(progress.activeToolCalls).toBe(0);
  expect(connects).toBe(2);
  expect(staleToolObservations).toBeGreaterThanOrEqual(3);
  expect(originalSends).toBe(1);
  await execution.confirmFinal(candidate);
});

test("fresh semantic tool progress continues to suppress recovery without treating lease heartbeats as progress", async () => {
  let sent = false;
  let observations = 0;
  let active = true;
  const semanticProgressAt = Date.now();
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  surface.setRunning(true);
  const harness = createHarness({
    surface,
    semanticObservationRefreshMs: 10_000,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 0,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async () => {
      observations += 1;
      if (observations >= 4) {
        active = false;
        surface.setRunning(false);
        return projection("long tool completed");
      }
      return { ...projection("waiting for tool"), completionActionVisible: false };
    },
  });
  const execution = harness.driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    gooseWork: {
      snapshot: () => active
        ? { revision: 1, lastToolBatchRevision: 1, activeToolCalls: 1, lastProgressAt: semanticProgressAt }
        : { revision: 2, lastToolBatchRevision: 1, activeToolCalls: 0, lastProgressAt: semanticProgressAt },
    },
  }));

  const candidate = await execution.run();
  expect(candidate.text).toBe("long tool completed");
  expect(observations).toBeGreaterThanOrEqual(4);
  expect(harness.activities.filter(activity => activity.phase === "start")).toHaveLength(1);
  await execution.confirmFinal(candidate);
});

test("empty stopped assistant projection refreshes once then continues on the short settle cadence", async () => {
  let sent = false;
  let originalSends = 0;
  let continuationSends = 0;
  let continuationAccepted = false;
  let reopenCalls = 0;
  const first = fakeSurface(() => {
    sent = true;
    originalSends += 1;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const refreshed = fakeSurface(() => {
    continuationSends += 1;
    continuationAccepted = true;
  }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(refreshed)];
  let connects = 0;
  const continuedSnapshot: PersistentChatTurnSnapshot = {
    turnIdentities: ["user-1", "assistant-1", "user-2", "assistant-2"],
    userIdentities: ["user-1", "user-2"],
    assistantIdentities: ["assistant-1", "assistant-2"],
  };
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 5,
    staleObservationSubsequentRefreshMs: 60_000,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => continuationAccepted
      ? continuedSnapshot
      : snapshotsAfterSend(() => sent),
    captureAnswer: async () => continuationAccepted
      ? { ...projection("continued after empty stop"), assistantTurnId: "assistant-2" }
      : projection(""),
    reopenBinding: async binding => {
      reopenCalls += 1;
      return { binding, assistantTurnId: "assistant-1", snapshot: snapshotsAfterSend(() => true) };
    },
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));

  const candidate = await execution.run();
  expect(candidate.text).toBe("continued after empty stop");
  expect(originalSends).toBe(1);
  expect(continuationSends).toBe(1);
  expect(reopenCalls).toBe(1);
  expect(connects).toBe(2);
  expect(refreshed.composerText()).toContain("continue from there");
});

test("process-local execution detach ends launcher heartbeat ownership without mutating either persistent chat", async () => {
  let sent = false;
  const accepted = deferred<void>();
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  surface.setRunning(true);
  const harness = createHarness({
    surface,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async () => ({ ...projection("still running"), completionActionVisible: false }),
  });
  const execution = harness.driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    onAccepted: () => accepted.resolve(),
  }));
  const running = execution.run();
  await accepted.promise;
  const rejection = running.then(
    () => new Error("browser execution unexpectedly completed"),
    error => error as Error,
  );

  await execution.detachExecution?.("transport_lost");
  expect((await rejection).message).toContain("execution attachment detached");
  expect(harness.activities.at(-1)).toMatchObject({ phase: "end", status: "failed" });
  expect(harness.activities.filter(activity => activity.phase === "start")).toHaveLength(1);
});

test("visible approval fence blocks stale-observation recovery before refresh", async () => {
  let sent = false;
  let sends = 0;
  let reopenCalls = 0;
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    sends += 1;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const harness = createHarness({
    surface,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 0,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async () => ({ ...projection("awaiting approval"), completionActionVisible: false }),
    approvalFenceVisible: async () => true,
    reopenBinding: async binding => {
      reopenCalls += 1;
      return { binding, assistantTurnId: "assistant-1", snapshot: snapshotsAfterSend(() => true) };
    },
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  await expect(execution.run()).rejects.toThrow("HUMAN_REQUIRED");
  expect(reopenCalls).toBe(0);
  expect(sends).toBe(1);
  expect(harness.activities.filter(activity => activity.phase === "end")).toEqual([]);
});

test("stale-observation refresh fails closed if the durable binding changes", async () => {
  let sent = false;
  const first = fakeSurface(() => {
    sent = true;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const rebound = fakeSurface(() => { throw new Error("rebound surface must never resend"); }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(rebound)];
  let connects = 0;
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 0,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async () => ({ ...projection("stale"), completionActionVisible: false }),
    reopenBinding: async binding => ({
      binding: { ...binding, acceptedUserTurnId: "wrong-user" },
      assistantTurnId: "assistant-1",
      snapshot: snapshotsAfterSend(() => true),
    }),
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  await expect(execution.run()).rejects.toThrow("did not preserve the durable turn binding");
  expect(connects).toBe(1);
  expect(harness.activities.filter(activity => activity.phase === "end")).toEqual([]);
});

test("settled stopped view sends a private same-chat continuation and keeps the original Goose acceptance identity", async () => {
  let sent = false;
  let originalSends = 0;
  let continuationSends = 0;
  let continuationAccepted = false;
  let acceptedCallbacks = 0;
  const first = fakeSurface(() => {
    sent = true;
    originalSends += 1;
    first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const refreshed = fakeSurface(() => {
    continuationSends += 1;
    continuationAccepted = true;
  }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(refreshed)];
  let connects = 0;
  const originalSnapshot = () => snapshotsAfterSend(() => sent);
  const continuedSnapshot: PersistentChatTurnSnapshot = {
    turnIdentities: ["user-1", "assistant-1", "user-2", "assistant-2"],
    userIdentities: ["user-1", "user-2"],
    assistantIdentities: ["assistant-1", "assistant-2"],
  };
  const harness = createHarness({
    surface: first,
    staleObservationFirstRefreshMs: 0,
    staleObservationSubsequentRefreshMs: 0,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => continuationAccepted ? continuedSnapshot : originalSnapshot(),
    captureAnswer: async (_page) => continuationAccepted
      ? { ...projection("continued final"), assistantTurnId: "assistant-2" }
      : { ...projection("partial"), completionActionVisible: false },
    reopenBinding: async binding => ({ binding, assistantTurnId: "assistant-1", snapshot: originalSnapshot() }),
  });
  const execution = harness.driver.createTurn(makeInput({
    existingConversationId: CONVERSATION,
    onAccepted: () => { acceptedCallbacks += 1; },
  }));
  const candidate = await execution.run();
  expect(candidate.text).toBe("continued final");
  expect(candidate.acceptedUserTurnId).toBe("user-1");
  expect(originalSends).toBe(1);
  expect(continuationSends).toBe(1);
  expect(acceptedCallbacks).toBe(1);
  expect(refreshed.composerText()).toContain("continue from there");
});

test("explicit terminal error hard-refreshes then uses a same-chat continuation instead of failing the provider chat", async () => {
  let sent = false;
  let continuationAccepted = false;
  let terminalChecks = 0;
  const first = fakeSurface(() => { sent = true; first.setUrl(`https://chatgpt.com/c/${CONVERSATION}`); });
  const refreshed = fakeSurface(() => { continuationAccepted = true; }, `https://chatgpt.com/c/${CONVERSATION}`);
  const connections = [browserConnection(first), browserConnection(refreshed)];
  let connects = 0;
  const originalSnapshot = () => snapshotsAfterSend(() => sent);
  const continuedSnapshot: PersistentChatTurnSnapshot = {
    turnIdentities: ["user-1", "assistant-1", "user-2", "assistant-2"],
    userIdentities: ["user-1", "user-2"],
    assistantIdentities: ["assistant-1", "assistant-2"],
  };
  const harness = createHarness({
    surface: first,
    connectSurface: async () => connections[connects++]!,
    captureSnapshot: async () => continuationAccepted ? continuedSnapshot : originalSnapshot(),
    captureAnswer: async () => continuationAccepted
      ? { ...projection("terminal recovered"), assistantTurnId: "assistant-2" }
      : projection("partial"),
    assertNoTerminalError: async (_page, assistantTurnId) => {
      if (assistantTurnId === "assistant-1") { terminalChecks += 1; throw new ChatGptUpstreamTerminalError("regenerate-error"); }
    },
    reopenBinding: async binding => ({ binding, assistantTurnId: "assistant-1", snapshot: originalSnapshot() }),
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  const candidate = await execution.run();
  expect(candidate.text).toBe("terminal recovered");
  expect(candidate.acceptedUserTurnId).toBe("user-1");
  expect(terminalChecks).toBe(2);
  expect(connects).toBe(2);
});

test("fresh final confirmation fails closed if the anchored answer changes after the completion claim", async () => {
  let sent = false;
  let answer = "candidate";
  let surface!: FakeSurface;
  surface = fakeSurface(() => {
    sent = true;
    surface.setUrl(`https://chatgpt.com/c/${CONVERSATION}`);
  });
  const harness = createHarness({
    surface,
    captureSnapshot: async () => snapshotsAfterSend(() => sent),
    captureAnswer: async () => projection(answer),
  });
  const execution = harness.driver.createTurn(makeInput({ existingConversationId: CONVERSATION }));
  const candidate = await execution.run();
  expect(candidate.text).toBe("candidate");
  answer = "changed-after-claim";
  await expect(execution.confirmFinal(candidate)).rejects.toThrow("changed after the completion claim");
  expect(harness.activities.filter(activity => activity.phase === "end")).toEqual([]);
  expect(harness.closes()).toBe(1);
});
