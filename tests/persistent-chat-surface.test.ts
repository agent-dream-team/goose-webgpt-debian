import { expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";
import {
  acceptedUserTurnIdentity,
  assistantTurnForAcceptedUser,
  capturePersistentChatTurnSnapshot,
  canonicalChatGptConversationUrl,
  classifyChatGptConversationUrl,
  normalizeCanonicalChatGptConversationId,
  PersistentChatSurfaceController,
  validatePersistentChatTurnIdentity,
  validatePersistentChatTurnSnapshot,
  type PersistentChatBinding,
  type PersistentChatTurnSnapshot,
} from "../src/persistent-chat-surface";
import { LAUNCHER_BROWSER_IDLE_URL, type LauncherBrowserConnection } from "../src/launcher-browser-host";

const CONVERSATION = "12345678-1234-4abc-8def-1234567890ab";
const OTHER_CONVERSATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SURFACE = "surface_id_0123456789ABCDEFGHIJK";

const snapshot = (overrides: Partial<PersistentChatTurnSnapshot> = {}): PersistentChatTurnSnapshot => ({
  turnIdentities: ["user-old", "assistant-old", "user-accepted", "assistant-accepted"],
  userIdentities: ["user-old", "user-accepted"],
  assistantIdentities: ["assistant-old", "assistant-accepted"],
  ...overrides,
});

function fakeConnection(options: {
  url: string;
  snapshot?: PersistentChatTurnSnapshot;
  snapshots?: PersistentChatTurnSnapshot[];
  afterReload?: PersistentChatTurnSnapshot;
  afterGoto?: PersistentChatTurnSnapshot;
}) {
  let currentUrl = options.url;
  let currentSnapshot = options.snapshot ?? options.snapshots?.[0] ?? snapshot();
  let snapshotIndex = 0;
  let reloads = 0;
  const gotos: string[] = [];
  let closes = 0;
  const page = {
    url: () => currentUrl,
    evaluate: async () => {
      if (options.snapshots && snapshotIndex < options.snapshots.length) {
        currentSnapshot = options.snapshots[snapshotIndex++]!;
      }
      return currentSnapshot;
    },
    reload: async () => {
      reloads += 1;
      if (options.afterReload) currentSnapshot = options.afterReload;
      return null;
    },
    goto: async (target: string) => {
      gotos.push(target);
      currentUrl = target;
      if (options.afterGoto) currentSnapshot = options.afterGoto;
      return null;
    },
  } as unknown as Page;
  const browser = { close: async () => { closes += 1; } } as unknown as Browser;
  return {
    connection: { page, browser } as LauncherBrowserConnection,
    state: { get reloads() { return reloads; }, gotos, get closes() { return closes; } },
  };
}

function connectionSequence(...connections: LauncherBrowserConnection[]) {
  let index = 0;
  return async () => {
    const connection = connections[index++];
    if (!connection) throw new Error("unexpected extra surface connection");
    return connection;
  };
}

function binding(overrides: Partial<PersistentChatBinding> = {}): PersistentChatBinding {
  return {
    surfaceId: SURFACE,
    conversationId: CONVERSATION,
    acceptedUserTurnId: "user-accepted",
    ...overrides,
  };
}

test("canonical conversation identity rejects provisional and non-canonical locations", () => {
  expect(classifyChatGptConversationUrl(`https://chatgpt.com/c/${CONVERSATION}`)).toEqual({
    kind: "canonical", conversationId: CONVERSATION,
  });
  expect(classifyChatGptConversationUrl("https://chatgpt.com/c/WEB:provisional-id")).toEqual({ kind: "provisional" });
  expect(classifyChatGptConversationUrl(
    `https://chatgpt.com/g/g-p-project-slug/c/${CONVERSATION}`,
  )).toEqual({ kind: "canonical", conversationId: CONVERSATION });
  expect(classifyChatGptConversationUrl(
    "https://chatgpt.com/g/g-p-project-slug/c/WEB:provisional-id",
  )).toEqual({ kind: "provisional" });
  expect(() => classifyChatGptConversationUrl(`https://chatgpt.com/c/${CONVERSATION}?x=1`)).toThrow("canonical conversation surface");
  expect(() => classifyChatGptConversationUrl(`https://chatgpt.com/c/${CONVERSATION}/`)).toThrow("canonical conversation surface");
  expect(() => classifyChatGptConversationUrl(`https://example.test/c/${CONVERSATION}`)).toThrow("canonical conversation surface");
  expect(() => classifyChatGptConversationUrl("https://chatgpt.com/c/private-conversation")).toThrow("canonical conversation UUID");
  expect(canonicalChatGptConversationUrl(CONVERSATION.toUpperCase())).toBe(`https://chatgpt.com/c/${CONVERSATION}`);
});

test("canonical conversation and opaque turn identity validators normalize or reject browser evidence", () => {
  expect(normalizeCanonicalChatGptConversationId(CONVERSATION.toUpperCase())).toBe(CONVERSATION);
  expect(() => normalizeCanonicalChatGptConversationId("WEB:not-canonical")).toThrow("canonical UUID");
  expect(validatePersistentChatTurnIdentity("user-opaque_123")).toBe("user-opaque_123");
  expect(() => validatePersistentChatTurnIdentity("bad turn id")).toThrow("invalid");
  expect(() => validatePersistentChatTurnIdentity("x".repeat(257))).toThrow("invalid");
});

test("accepted user anchoring is absolute and fails closed on multiple new user turns", () => {
  expect(acceptedUserTurnIdentity(
    ["user-old", "assistant-old"],
    snapshot(),
  )).toBe("user-accepted");
  expect(() => acceptedUserTurnIdentity(
    ["user-old", "assistant-old"],
    snapshot({
      turnIdentities: ["user-old", "assistant-old", "user-a", "user-b"],
      userIdentities: ["user-old", "user-a", "user-b"],
      assistantIdentities: ["assistant-old"],
    }),
  )).toThrow("2 new conversation turns");
});

test("assistant identity is derived from the durable user anchor and fresh document order", () => {
  expect(assistantTurnForAcceptedUser(snapshot(), "user-accepted")).toBe("assistant-accepted");
  expect(assistantTurnForAcceptedUser(snapshot({
    turnIdentities: ["user-old", "assistant-old", "user-accepted"],
    assistantIdentities: ["assistant-old"],
  }), "user-accepted")).toBeUndefined();
  expect(() => assistantTurnForAcceptedUser(snapshot({
    turnIdentities: ["user-old", "assistant-old", "user-accepted", "assistant-accepted", "user-later"],
    userIdentities: ["user-old", "user-accepted", "user-later"],
  }), "user-accepted")).toThrow("advanced to another user turn");
  expect(() => assistantTurnForAcceptedUser(snapshot({
    turnIdentities: ["user-old", "assistant-old", "user-accepted", "assistant-a", "assistant-b"],
    assistantIdentities: ["assistant-old", "assistant-a", "assistant-b"],
  }), "user-accepted")).toThrow("multiple assistant turns");
  expect(assistantTurnForAcceptedUser(snapshot({
    turnIdentities: ["user-old", "assistant-old", "user-accepted", "unknown-later"],
    assistantIdentities: ["assistant-old"],
  }), "user-accepted")).toBeUndefined();
  expect(assistantTurnForAcceptedUser(snapshot({
    turnIdentities: ["user-old", "assistant-old", "user-accepted", "assistant-accepted", "unknown-later"],
  }), "user-accepted")).toBeUndefined();
});

test("DOM capture preserves virtualized outer turn identities and visible role anchors", async () => {
  type Turn = { id: string; role: "user" | "assistant"; mounted: boolean };
  const turns: Turn[] = [
    { id: "user-old", role: "user", mounted: false },
    { id: "assistant-old", role: "assistant", mounted: false },
    { id: "user-accepted", role: "user", mounted: true },
    { id: "assistant-accepted", role: "assistant", mounted: true },
  ];
  const element = (turn: Turn, container: boolean) => ({
    getAttribute: (name: string) => ({
      "data-turn-id": container ? null : turn.id,
      "data-turn-id-container": turn.id,
    } as Record<string, string | null>)[name] ?? null,
    parentElement: { closest: () => container ? null : element(turn, true) },
  });
  const fakeDocument = {
    querySelectorAll: (selector: string) => {
      if (selector === "[data-turn-id-container]") {
        return turns.flatMap(turn => [element(turn, true), ...(turn.mounted ? [element(turn, false)] : [])]);
      }
      const role = selector.includes('="assistant"') ? "assistant" : selector.includes('="user"') ? "user" : undefined;
      return turns.filter(turn => turn.mounted && turn.role === role).map(turn => element(turn, false));
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: fakeDocument, configurable: true });
  try {
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    } as unknown as Page;
    expect(await capturePersistentChatTurnSnapshot(page)).toEqual({
      turnIdentities: ["user-old", "assistant-old", "user-accepted", "assistant-accepted"],
      userIdentities: ["user-accepted"],
      assistantIdentities: ["assistant-accepted"],
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete (globalThis as { document?: unknown }).document;
  }
});

test("snapshot validation rejects duplicate, orphaned, or conflicting role identities", () => {
  expect(() => validatePersistentChatTurnSnapshot(snapshot({
    turnIdentities: ["user-accepted", "user-accepted"],
    userIdentities: ["user-accepted"], assistantIdentities: [],
  }))).toThrow("duplicate turn identities");
  expect(() => validatePersistentChatTurnSnapshot(snapshot({
    turnIdentities: ["user-accepted"], userIdentities: ["user-accepted"], assistantIdentities: ["orphan"],
  }))).toThrow("no matching identity container");
  expect(() => validatePersistentChatTurnSnapshot(snapshot({
    turnIdentities: ["same"], userIdentities: ["same"], assistantIdentities: ["same"],
  }))).toThrow("conflicting user/assistant roles");
});

test("inspect uses the exact durable surface and closes its disposable Playwright connection", async () => {
  const fake = fakeConnection({ url: `https://chatgpt.com/c/${CONVERSATION}` });
  const calls: Array<{ path: string; timeout: number; surface: string }> = [];
  let authChecks = 0;
  const controller = new PersistentChatSurfaceController("/descriptor", async (path, timeout, surface) => {
    calls.push({ path, timeout, surface });
    return fake.connection;
  }, 3210, async () => { authChecks += 1; });
  const result = await controller.inspect(binding());
  expect(calls).toEqual([{ path: "/descriptor", timeout: 3210, surface: SURFACE }]);
  expect(result.assistantTurnId).toBe("assistant-accepted");
  expect(authChecks).toBe(1);
  expect(fake.state.closes).toBe(1);
});

test("inspect waits for the durable user and assistant anchors to hydrate", async () => {
  const empty = snapshot({ turnIdentities: [], userIdentities: [], assistantIdentities: [] });
  const userOnly = snapshot({
    turnIdentities: ["user-old", "assistant-old", "user-accepted"],
    userIdentities: ["user-old", "user-accepted"],
    assistantIdentities: ["assistant-old"],
  });
  const hydrated = snapshot();
  const fake = fakeConnection({
    url: `https://chatgpt.com/c/${CONVERSATION}`,
    snapshots: [empty, userOnly, hydrated],
  });
  const controller = new PersistentChatSurfaceController(
    "/descriptor", async () => fake.connection, 1_000, async () => {},
  );
  const result = await controller.inspect(binding());
  expect(result.assistantTurnId).toBe("assistant-accepted");
  expect(result.snapshot).toEqual(hydrated);
  expect(fake.state.closes).toBe(1);
});

test("reopen navigates an idle owned surface to the canonical conversation and reinitializes from fresh DOM", async () => {
  const rebound = snapshot({
    turnIdentities: ["user-old", "assistant-old", "user-accepted", "assistant-after-reopen"],
    assistantIdentities: ["assistant-old", "assistant-after-reopen"],
  });
  const navigation = fakeConnection({ url: LAUNCHER_BROWSER_IDLE_URL, afterGoto: rebound });
  const reboundConnection = fakeConnection({ url: `https://chatgpt.com/c/${CONVERSATION}`, snapshot: rebound });
  const controller = new PersistentChatSurfaceController(
    "/descriptor", connectionSequence(navigation.connection, reboundConnection.connection), 20_000, async () => {},
  );
  const result = await controller.reopen(binding());
  expect(navigation.state.gotos).toEqual([canonicalChatGptConversationUrl(CONVERSATION)]);
  expect(navigation.state.reloads).toBe(0);
  expect(result.assistantTurnId).toBe("assistant-after-reopen");
  expect(navigation.state.closes).toBe(1);
  expect(reboundConnection.state.closes).toBe(1);
});

test("reopen naturally reloads the same canonical conversation and verifies the durable anchor again", async () => {
  const navigation = fakeConnection({
    url: `https://chatgpt.com/c/${CONVERSATION}`,
    afterReload: snapshot(),
  });
  const reboundConnection = fakeConnection({ url: `https://chatgpt.com/c/${CONVERSATION}` });
  const controller = new PersistentChatSurfaceController(
    "/descriptor", connectionSequence(navigation.connection, reboundConnection.connection), 20_000, async () => {},
  );
  const result = await controller.reopen(binding());
  expect(navigation.state.reloads).toBe(1);
  expect(navigation.state.gotos).toEqual([]);
  expect(result.binding).toEqual(binding());
  expect(result.assistantTurnId).toBe("assistant-accepted");
  expect(navigation.state.closes).toBe(1);
  expect(reboundConnection.state.closes).toBe(1);
});

test("conversation mismatch fails closed while assistant identity is freshly rederived on reopen", async () => {
  const wrongConversation = fakeConnection({ url: `https://chatgpt.com/c/${OTHER_CONVERSATION}` });
  const inspectController = new PersistentChatSurfaceController("/descriptor", async () => wrongConversation.connection, 20_000, async () => {});
  await expect(inspectController.inspect(binding())).rejects.toThrow("different canonical conversation");
  expect(wrongConversation.state.closes).toBe(1);

  const navigation = fakeConnection({ url: `https://chatgpt.com/c/${CONVERSATION}` });
  const reboundAssistant = fakeConnection({
    url: `https://chatgpt.com/c/${CONVERSATION}`,
    snapshot: snapshot({
      turnIdentities: ["user-old", "assistant-old", "user-accepted", "assistant-replaced"],
      assistantIdentities: ["assistant-old", "assistant-replaced"],
    }),
  });
  const reopenController = new PersistentChatSurfaceController(
    "/descriptor", connectionSequence(navigation.connection, reboundAssistant.connection), 20_000, async () => {},
  );
  const rebound = await reopenController.reopen(binding());
  expect(rebound.assistantTurnId).toBe("assistant-replaced");
  expect(navigation.state.closes).toBe(1);
  expect(reboundAssistant.state.closes).toBe(1);
});


test("reopen never silently repoints an owned surface from another conversation", async () => {
  const fake = fakeConnection({ url: `https://chatgpt.com/c/${OTHER_CONVERSATION}` });
  const controller = new PersistentChatSurfaceController("/descriptor", async () => fake.connection, 20_000, async () => {});
  await expect(controller.reopen(binding())).rejects.toThrow("owned surface is bound to a different conversation");
  expect(fake.state.gotos).toEqual([]);
  expect(fake.state.reloads).toBe(0);
  expect(fake.state.closes).toBe(1);
});

test("authentication verification failure blocks durable surface observation", async () => {
  const fake = fakeConnection({ url: `https://chatgpt.com/c/${CONVERSATION}` });
  const controller = new PersistentChatSurfaceController(
    "/descriptor", async () => fake.connection, 20_000, async () => { throw new Error("not authenticated"); },
  );
  await expect(controller.inspect(binding())).rejects.toThrow("not authenticated");
  expect(fake.state.closes).toBe(1);
});
