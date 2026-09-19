import type { Browser, Page } from "playwright-core";
import {
  assertAuthenticatedChatGptPage,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
} from "./chatgpt-session";
import { chatGptNewTurnIdentity } from "./chatgpt-turn-identity";
import {
  connectLauncherBrowserHost,
  LAUNCHER_BROWSER_IDLE_URL,
  type LauncherBrowserConnection,
} from "./launcher-browser-host";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CANONICAL_CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChatGptConversationLocation =
  | { kind: "canonical"; conversationId: string }
  | { kind: "provisional" };

export interface PersistentChatTurnSnapshot {
  turnIdentities: readonly string[];
  userIdentities: readonly string[];
  assistantIdentities: readonly string[];
}

export interface PersistentChatBinding {
  surfaceId: string;
  conversationId: string;
  acceptedUserTurnId: string;
}

export interface PersistentChatSurfaceObservation {
  binding: PersistentChatBinding;
  assistantTurnId?: string;
  snapshot: PersistentChatTurnSnapshot;
}

type SurfaceConnector = (
  descriptorPath: string,
  timeoutMs: number,
  surfaceId: string,
  abortSignal?: AbortSignal,
) => Promise<LauncherBrowserConnection>;

type PageVerifier = (page: Page, timeoutMs: number) => Promise<void>;

async function waitForAuthenticatedChatGptPage(page: Page, timeoutMs: number): Promise<void> {
  await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).last().waitFor({
    state: "visible", timeout: timeoutMs,
  });
  await assertAuthenticatedChatGptPage(page);
}

export function validatePersistentChatTurnIdentity(value: string, label = "ChatGPT turn identity"): string {
  if (!value || value.length > 256 || /\s|[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function uniqueIdentities(values: readonly string[], label: string): string[] {
  const normalized = values.map(value => validatePersistentChatTurnIdentity(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`ChatGPT exposed duplicate ${label} identities`);
  }
  return normalized;
}


export function normalizeCanonicalChatGptConversationId(value: string): string {
  if (!CANONICAL_CONVERSATION_ID.test(value)) {
    throw new Error("ChatGPT conversation id is not a canonical UUID");
  }
  return value.toLowerCase();
}

export function classifyChatGptConversationUrl(value: string): ChatGptConversationLocation {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("ChatGPT conversation URL is invalid"); }
  if (url.origin !== CHATGPT_ORIGIN || url.search || url.hash) {
    throw new Error("ChatGPT conversation URL is outside the canonical conversation surface");
  }
  const match = /^\/c\/([^/]+)$/.exec(url.pathname)
    ?? /^\/g\/[^/]+\/c\/([^/]+)$/.exec(url.pathname);
  if (!match) throw new Error("ChatGPT conversation URL is outside the canonical conversation surface");
  const id = match[1];
  if (/^WEB:/i.test(id)) return { kind: "provisional" };
  try {
    return { kind: "canonical", conversationId: normalizeCanonicalChatGptConversationId(id) };
  } catch {
    throw new Error("ChatGPT conversation URL does not contain a canonical conversation UUID");
  }
}

export function canonicalChatGptConversationUrl(conversationId: string): string {
  return `${CHATGPT_ORIGIN}/c/${normalizeCanonicalChatGptConversationId(conversationId)}`;
}

export function validatePersistentChatTurnSnapshot(input: PersistentChatTurnSnapshot): PersistentChatTurnSnapshot {
  const turnIdentities = uniqueIdentities(input.turnIdentities, "turn");
  const userIdentities = uniqueIdentities(input.userIdentities, "user-turn");
  const assistantIdentities = uniqueIdentities(input.assistantIdentities, "assistant-turn");
  const known = new Set(turnIdentities);
  for (const id of [...userIdentities, ...assistantIdentities]) {
    if (!known.has(id)) throw new Error("ChatGPT role turn has no matching identity container");
  }
  const users = new Set(userIdentities);
  if (assistantIdentities.some(id => users.has(id))) {
    throw new Error("ChatGPT turn identity has conflicting user/assistant roles");
  }
  return { turnIdentities, userIdentities, assistantIdentities };
}

export function acceptedUserTurnIdentity(
  initialTurnIdentities: readonly string[],
  snapshot: PersistentChatTurnSnapshot,
): string | undefined {
  const state = validatePersistentChatTurnSnapshot(snapshot);
  const identity = chatGptNewTurnIdentity(initialTurnIdentities, state.userIdentities);
  return identity ? validatePersistentChatTurnIdentity(identity, "accepted user turn") : undefined;
}

export function assistantTurnForAcceptedUser(
  snapshot: PersistentChatTurnSnapshot,
  acceptedUserTurnId: string,
): string | undefined {
  const state = validatePersistentChatTurnSnapshot(snapshot);
  validatePersistentChatTurnIdentity(acceptedUserTurnId, "accepted user turn");
  if (!state.userIdentities.includes(acceptedUserTurnId)) {
    throw new Error("ChatGPT accepted user turn is missing or its user role cannot be proven");
  }
  const userIndex = state.turnIdentities.indexOf(acceptedUserTurnId);
  if (userIndex < 0) throw new Error("ChatGPT accepted user turn has no identity container");
  const laterTurnIds = state.turnIdentities.slice(userIndex + 1);
  const laterUsers = state.userIdentities.filter(id => state.turnIdentities.indexOf(id) > userIndex);
  if (laterUsers.length > 0) {
    throw new Error("ChatGPT conversation advanced to another user turn after the accepted anchor");
  }
  const assistants = state.assistantIdentities.filter(id => state.turnIdentities.indexOf(id) > userIndex);
  if (assistants.length > 1) {
    throw new Error("ChatGPT exposed multiple assistant turns after the accepted user anchor");
  }
  const roleBound = new Set([...state.userIdentities, ...state.assistantIdentities]);
  if (laterTurnIds.some(id => !roleBound.has(id))) {
    // ChatGPT can attach the stable outer turn container before the role-bearing section during
    // assistant hydration. Treat that state as pending, never as evidence for completion. If the
    // role never resolves, the caller's bounded observation loop still times out and fails closed.
    return undefined;
  }
  return assistants[0];
}

export async function capturePersistentChatTurnSnapshot(page: Page): Promise<PersistentChatTurnSnapshot> {
  const raw = await page.evaluate(({ userSelector, assistantSelector }) => {
    const identities = (elements: Element[], attribute: string) => elements.map(element => {
      const value = element.getAttribute(attribute);
      if (!value) throw new Error(`ChatGPT turn element is missing ${attribute}`);
      return value;
    });
    const containers = [...document.querySelectorAll("[data-turn-id-container]")].filter(element =>
      element.parentElement?.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container")
        !== element.getAttribute("data-turn-id-container"));
    return {
      turnIdentities: identities(containers, "data-turn-id-container"),
      userIdentities: identities([...document.querySelectorAll(userSelector)], "data-turn-id"),
      assistantIdentities: identities([...document.querySelectorAll(assistantSelector)], "data-turn-id"),
    };
  }, { userSelector: CHATGPT_USER_TURN_SELECTOR, assistantSelector: CHATGPT_ASSISTANT_TURN_SELECTOR });
  return validatePersistentChatTurnSnapshot(raw);
}

async function closeBrowser(browser: Browser): Promise<void> {
  // This Browser came from connectOverCDP: close disconnects the disposable Playwright transport,
  // not the Electron-owned renderer. Keep cleanup failure from replacing stronger observation evidence.
  await browser.close().catch(() => {});
}

export class PersistentChatSurfaceController {
  constructor(
    private readonly descriptorPath: string,
    private readonly connect: SurfaceConnector = connectLauncherBrowserHost,
    private readonly timeoutMs = 20_000,
    private readonly verifyAuthenticated: PageVerifier = waitForAuthenticatedChatGptPage,
  ) {}

  async inspect(binding: PersistentChatBinding, abortSignal?: AbortSignal): Promise<PersistentChatSurfaceObservation> {
    const connection = await this.connect(
      this.descriptorPath, this.timeoutMs, binding.surfaceId, abortSignal,
    );
    try {
      return await this.inspectPage(connection.page, binding);
    } finally {
      await closeBrowser(connection.browser);
    }
  }

  async reopen(binding: PersistentChatBinding, abortSignal?: AbortSignal): Promise<PersistentChatSurfaceObservation> {
    const connection = await this.connect(
      this.descriptorPath, this.timeoutMs, binding.surfaceId, abortSignal,
    );
    try {
      const target = canonicalChatGptConversationUrl(binding.conversationId);
      if (connection.page.url() === LAUNCHER_BROWSER_IDLE_URL) {
        await connection.page.goto(target, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      } else {
        const location = classifyChatGptConversationUrl(connection.page.url());
        if (location.kind !== "canonical"
          || location.conversationId !== binding.conversationId.toLowerCase()) {
          throw new Error("ChatGPT owned surface is bound to a different conversation");
        }
        await connection.page.reload({ waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      }
    } finally {
      await closeBrowser(connection.browser);
    }
    return this.inspect(binding, abortSignal);
  }

  private async inspectPage(page: Page, binding: PersistentChatBinding): Promise<PersistentChatSurfaceObservation> {
    canonicalChatGptConversationUrl(binding.conversationId);
    const location = classifyChatGptConversationUrl(page.url());
    if (location.kind !== "canonical") {
      throw new Error("ChatGPT conversation is still provisional and cannot be durably rebound");
    }
    if (location.conversationId !== binding.conversationId.toLowerCase()) {
      throw new Error("ChatGPT reopened a different canonical conversation");
    }
    await this.verifyAuthenticated(page, this.timeoutMs);
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const snapshot = await capturePersistentChatTurnSnapshot(page);
      if (snapshot.userIdentities.includes(binding.acceptedUserTurnId)) {
        const assistantTurnId = assistantTurnForAcceptedUser(snapshot, binding.acceptedUserTurnId);
        if (assistantTurnId) {
          return {
            binding: { ...binding, conversationId: location.conversationId },
            assistantTurnId,
            snapshot,
          };
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("ChatGPT durable turn binding did not hydrate before the observation timeout");
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
