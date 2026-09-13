import { expect, test } from "bun:test";
import type { Locator, Page } from "playwright-core";
import { CHATGPT_COMPOSER_SELECTOR } from "../src/chatgpt-session";
import {
  RebuildChatGptConnectorCatalogStaleError,
  rebuildChatGptConnectorIsSelected,
  selectRebuildChatGptConnector,
} from "../src/rebuild-chatgpt-connector";

const NAME = "Goose Native 2nd Shift";
const MENTION = "@Goose Native";

function fixture(options: { menuTitles?: string[]; selected?: boolean; staleMenu?: boolean } = {}) {
  let selected = options.selected ?? false;
  let draft = "";
  const keys: string[] = [];
  const mentions: string[] = [];
  const selectedControl = {
    waitFor: async () => {},
    evaluateAll: async () => selected ? [NAME] : [],
  } as unknown as Locator;
  const composer = {
    fill: async (value: string) => { draft = value; },
    focus: async () => {},
    pressSequentially: async (value: string) => { mentions.push(value); draft = value; },
    press: async (key: string) => {
      keys.push(key);
      if (key === "Backspace") draft = "";
      if (key === "Enter") { selected = true; draft = ""; }
    },
    evaluate: async () => draft,
    locator: (selector: string) => {
      expect(selector).toBe('[data-id^="plugin:"][data-keyword]');
      return { filter: () => selectedControl };
    },
  } as unknown as Locator;
  const composers = {
    filter: () => composers,
    count: async () => 1,
    first: () => composer,
  };
  const timeout = new Error("menu timeout");
  timeout.name = "TimeoutError";
  const exactRow = {
    waitFor: async () => { if (options.staleMenu) throw timeout; },
    count: async () => options.staleMenu ? 0 : 1,
    getAttribute: async () => "",
  } as unknown as Locator;
  const menuRows = {
    filter: (input: { has?: unknown; visible?: boolean }) => input.visible
      ? { allInnerTexts: async () => options.menuTitles ?? [NAME], count: async () => (options.menuTitles ?? [NAME]).length }
      : exactRow,
  };
  const page = {
    getByText: (text: string, config: { exact: boolean }) => {
      expect(text).toBe(NAME);
      expect(config.exact).toBeTrue();
      return { exactLabel: true };
    },
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composers;
      if (selector === '.__menu-item[tabindex="0"]') return menuRows;
      throw new Error(`Unexpected locator: ${selector}`);
    },
  } as unknown as Page;
  return {
    page,
    composer,
    keys,
    mentions,
    selected: () => selected,
    draft: () => draft,
  };
}

const options = { connectorName: NAME, mentionQuery: MENTION, timeoutMs: 200, menuWaitMs: 10, maxTriggerAttempts: 2 };

test("fresh selection types the configured mention, activates the exact row, and proves the exact connector pill", async () => {
  const f = fixture();
  const selectedComposer = await selectRebuildChatGptConnector(f.page, options, new AbortController().signal);
  expect(selectedComposer).toBe(f.composer);
  expect(f.mentions).toEqual([MENTION]);
  expect(f.keys).toContain("Enter");
  expect(f.selected()).toBeTrue();
  expect(await rebuildChatGptConnectorIsSelected(f.composer, NAME, new AbortController().signal)).toBeTrue();
});

test("visible non-matching catalog fails as stale and cleanup removes the typed mention", async () => {
  const f = fixture({ staleMenu: true, menuTitles: ["Some Other Connector"] });
  await expect(selectRebuildChatGptConnector(
    f.page, options, new AbortController().signal, true,
  )).rejects.toBeInstanceOf(RebuildChatGptConnectorCatalogStaleError);
  expect(f.mentions).toEqual([MENTION]);
  expect(f.draft()).toBe("");
  expect(f.selected()).toBeFalse();
  expect(f.keys).toContain("Backspace");
});

test("duplicate exact connector pills fail closed", async () => {
  const composer = {
    locator: () => ({ filter: () => ({ evaluateAll: async () => [NAME, NAME] }) }),
  } as unknown as Locator;
  await expect(rebuildChatGptConnectorIsSelected(
    composer, NAME, new AbortController().signal,
  )).rejects.toThrow("duplicate");
});
