import type { Locator, Page } from "playwright-core";
import { CHATGPT_COMPOSER_SELECTOR } from "./chatgpt-session";

const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_MENU_WAIT_MS = 2_500;
const DEFAULT_TRIGGER_ATTEMPTS = 3;
const MENU_ROW_SELECTOR = '.__menu-item[tabindex="0"]';
const SELECTED_CONNECTOR_SELECTOR = '[data-id^="plugin:"][data-keyword]';
const COMPOSER_SELECT_ALL_KEY = process.platform === "darwin" ? "Meta+A" : "Control+A";

export class RebuildChatGptConnectorCatalogStaleError extends Error {
  constructor(readonly connectorName: string, readonly attempts: number) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(connectorName)}`);
    this.name = "RebuildChatGptConnectorCatalogStaleError";
  }
}

export interface RebuildChatGptConnectorOptions {
  connectorName: string;
  mentionQuery: string;
  timeoutMs?: number;
  menuWaitMs?: number;
  maxTriggerAttempts?: number;
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("ChatGPT connector selection aborted", "AbortError");
}

function validOptions(options: RebuildChatGptConnectorOptions): void {
  if (!options.connectorName.trim()) throw new Error("ChatGPT connector name is required");
  if (!options.mentionQuery.startsWith("@") || options.mentionQuery.length < 2) {
    throw new Error("ChatGPT connector mention query is invalid");
  }
}

export async function rebuildChatGptActiveComposer(
  page: Page,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Locator> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    abortIfRequested(signal);
    count = await composers.count();
    if (count === 1) return composers.first();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`ChatGPT surface must expose exactly one visible composer (observed ${count})`);
}

export function rebuildSelectedConnectorControl(composer: Locator, connectorName: string): Locator {
  return composer
    .locator(SELECTED_CONNECTOR_SELECTOR)
    .filter({ hasText: connectorName, visible: true });
}

export async function rebuildChatGptConnectorIsSelected(
  composer: Locator,
  connectorName: string,
  signal: AbortSignal,
): Promise<boolean> {
  abortIfRequested(signal);
  const selected = rebuildSelectedConnectorControl(composer, connectorName);
  const keywords = await selected.evaluateAll(elements => (
    elements.map(element => element.getAttribute("data-keyword"))
  )) as Array<string | null>;
  abortIfRequested(signal);
  const exactMatches = keywords.filter(keyword => keyword === connectorName).length;
  if (exactMatches > 1) {
    throw new Error(`ChatGPT composer exposed duplicate ${JSON.stringify(connectorName)} connector selections`);
  }
  return exactMatches === 1;
}

async function visibleMenuTitles(menuRows: Locator, signal: AbortSignal): Promise<string[]> {
  abortIfRequested(signal);
  try {
    const texts = await menuRows.filter({ visible: true }).allInnerTexts();
    return texts
      .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  } catch (error) {
    if (signal.aborted) throw error;
    return [];
  }
}

export async function clearRebuildChatGptConnectorComposer(
  page: Page,
  options: RebuildChatGptConnectorOptions,
  signal: AbortSignal,
): Promise<void> {
  validOptions(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const composer = await rebuildChatGptActiveComposer(page, timeoutMs, signal);
  await composer.focus({ signal, timeout: timeoutMs });
  await composer.press(COMPOSER_SELECT_ALL_KEY, { signal, timeout: timeoutMs });
  await composer.press("Backspace", { signal, timeout: timeoutMs });
  const settled = await rebuildChatGptActiveComposer(page, timeoutMs, signal);
  const text = await settled.evaluate(element => element.textContent?.trim() ?? "", undefined, { timeout: timeoutMs, signal });
  const selected = await rebuildChatGptConnectorIsSelected(settled, options.connectorName, signal);
  if (text || selected) {
    throw new Error(`ChatGPT connector cleanup did not produce an empty composer (visibleCharacters=${text.length}, connectorSelected=${selected})`);
  }
}

export async function selectRebuildChatGptConnector(
  page: Page,
  options: RebuildChatGptConnectorOptions,
  signal: AbortSignal,
  catalogRefreshAvailable = false,
): Promise<Locator> {
  validOptions(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const menuWaitMs = options.menuWaitMs ?? DEFAULT_MENU_WAIT_MS;
  const maxAttempts = options.maxTriggerAttempts ?? DEFAULT_TRIGGER_ATTEMPTS;
  const menuRows = page.locator(MENU_ROW_SELECTOR);
  const exactRow = menuRows.filter({ has: page.getByText(options.connectorName, { exact: true }) });
  let mutationStarted = false;
  try {
    let composer = await rebuildChatGptActiveComposer(page, timeoutMs, signal);
    if (await rebuildChatGptConnectorIsSelected(composer, options.connectorName, signal)) return composer;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      composer = await rebuildChatGptActiveComposer(page, timeoutMs, signal);
      mutationStarted = true;
      await composer.fill("", { signal, timeout: timeoutMs });
      await composer.focus({ signal, timeout: timeoutMs });
      await composer.pressSequentially(options.mentionQuery, { delay: 25, signal, timeout: timeoutMs });
      try {
        await exactRow.waitFor({ state: "visible", timeout: menuWaitMs, signal });
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        const titles = await visibleMenuTitles(menuRows, signal);
        if (catalogRefreshAvailable && titles.length > 0 && !titles.includes(options.connectorName) && attempt < maxAttempts) {
          throw new RebuildChatGptConnectorCatalogStaleError(options.connectorName, attempt);
        }
        if (attempt === maxAttempts) {
          const detail = titles.length > 0 ? `; visible rows=${JSON.stringify(titles)}` : "";
          throw new Error(
            `ChatGPT connector menu exposed no exact ${JSON.stringify(options.connectorName)} row after ${attempt} attempt(s)${detail}`,
          );
        }
      }
    }

    const exactCount = await exactRow.count();
    if (exactCount !== 1) {
      throw new Error(`ChatGPT connector menu must expose exactly one ${JSON.stringify(options.connectorName)} row (observed ${exactCount})`);
    }
    const highlighted = async () => await exactRow.getAttribute("data-highlighted", { signal, timeout: timeoutMs }) !== null;
    if (!await highlighted()) {
      const visibleCount = await menuRows.filter({ visible: true }).count();
      for (let step = 0; step < visibleCount && !await highlighted(); step += 1) {
        await composer.press("ArrowDown", { signal, timeout: timeoutMs });
      }
    }
    if (!await highlighted()) throw new Error(`ChatGPT connector menu could not highlight ${JSON.stringify(options.connectorName)}`);

    await composer.press("Enter", { signal, timeout: timeoutMs });
    const selectedComposer = await rebuildChatGptActiveComposer(page, timeoutMs, signal);
    await rebuildSelectedConnectorControl(selectedComposer, options.connectorName).waitFor({
      state: "visible", timeout: timeoutMs, signal,
    });
    if (!await rebuildChatGptConnectorIsSelected(selectedComposer, options.connectorName, signal)) {
      throw new Error(`ChatGPT composer did not select ${JSON.stringify(options.connectorName)} connector`);
    }
    return selectedComposer;
  } catch (error) {
    if (!mutationStarted) throw error;
    try {
      await clearRebuildChatGptConnectorComposer(page, options, signal);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "ChatGPT connector selection failed and composer cleanup also failed");
    }
    throw error;
  }
}
