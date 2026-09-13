import { expect, test } from "bun:test";
import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
} from "../src/chatgpt-session";
import { createChatGptProjectNavigationEntry } from "../src/rebuild-project-entry";

const PROJECT_ID = "g-p-6aa1ba90edac81919864ef7b26741076";
const PROJECT_NAME = "CGW Provider Sessions";

interface HarnessOptions {
  authenticated?: boolean;
  optionsCount?: number;
  rowCount?: number;
  homeCount?: number;
  projectSegment?: string;
  finalTurns?: number;
}

function locator(shape: Partial<{
  count: () => number;
  visible: () => boolean;
  expanded: () => string | null;
  click: () => void;
  locator: () => Locator;
  getByRole: () => Locator;
}> = {}): Locator {
  const value = {
    filter: () => value,
    first: () => value,
    nth: () => value,
    count: async () => shape.count?.() ?? 1,
    isVisible: async () => shape.visible?.() ?? true,
    waitFor: async () => {
      if (!(shape.visible?.() ?? true)) throw new Error("locator remained hidden");
    },
    getAttribute: async (name: string) => name === "aria-expanded" ? shape.expanded?.() ?? null : null,
    click: async () => { shape.click?.(); },
    locator: () => shape.locator?.() ?? value,
    getByRole: () => shape.getByRole?.() ?? value,
  };
  return value as unknown as Locator;
}

function harness(options: HarnessOptions = {}) {
  let url = "data:text/html,launcher";
  let projectsExpanded = false;
  let projectHomeClicked = false;
  let sent = false;
  const authenticated = options.authenticated ?? true;
  const projectSegment = options.projectSegment ?? `${PROJECT_ID}-cgw-provider-sessions`;
  const finalTurns = options.finalTurns ?? 0;

  const composer = locator({ count: () => authenticated ? 1 : 0, visible: () => authenticated });
  const turns = locator({ count: () => projectHomeClicked ? finalTurns : 0 });
  const home = locator({
    count: () => options.homeCount ?? 1,
    click: () => {
      projectHomeClicked = true;
      url = `https://chatgpt.com/g/${projectSegment}/project`;
    },
  });
  const row = locator({
    count: () => options.rowCount ?? 1,
    getByRole: () => home,
  });
  const projectOptions = locator({
    count: () => projectsExpanded ? options.optionsCount ?? 1 : 0,
    visible: () => projectsExpanded,
    locator: () => row,
  });
  const projectsDisclosure = locator({
    count: () => 1,
    expanded: () => projectsExpanded ? "true" : "false",
    click: () => { projectsExpanded = true; },
  });

  const page = {
    url: () => url,
    goto: async (target: string) => {
      url = target;
      projectsExpanded = false;
      projectHomeClicked = false;
      return null;
    },
    getByRole: (role: string, query: { name?: string | RegExp; exact?: boolean }) => {
      if (role === "button" && query.name instanceof RegExp && query.name.test("Projects")) return projectsDisclosure;
      if (role === "button" && query.name === `Open project options for ${PROJECT_NAME}`) return projectOptions;
      throw new Error(`Unexpected role lookup: ${role} ${String(query.name)}`);
    },
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composer;
      if (selector === CHATGPT_USER_TURN_SELECTOR || selector === CHATGPT_ASSISTANT_TURN_SELECTOR) return turns;
      throw new Error(`Unexpected locator: ${selector}`);
    },
    keyboard: { press: async () => { sent = true; } },
  } as unknown as Page;

  return { page, sent: () => sent, projectHomeClicked: () => projectHomeClicked };
}

function preparer(timeoutMs = 500) {
  return createChatGptProjectNavigationEntry({ projectId: PROJECT_ID, projectName: PROJECT_NAME, timeoutMs });
}

test("uses the exact named Project row's home control and accepts ChatGPT's slugged Project route without submitting", async () => {
  const state = harness();
  await preparer()(state.page, {} as never);
  expect(state.projectHomeClicked()).toBeTrue();
  expect(state.sent()).toBeFalse();
});

test("also accepts an un-slugged Project-home route carrying the exact persisted Project id", async () => {
  const state = harness({ projectSegment: PROJECT_ID });
  await preparer()(state.page, {} as never);
  expect(state.projectHomeClicked()).toBeTrue();
  expect(state.sent()).toBeFalse();
});

test("fails closed when authentication cannot be verified", async () => {
  const state = harness({ authenticated: false });
  await expect(preparer()(state.page, {} as never)).rejects.toThrow();
  expect(state.projectHomeClicked()).toBeFalse();
  expect(state.sent()).toBeFalse();
});

test("fails closed when the named Project row is ambiguous", async () => {
  const state = harness({ optionsCount: 2 });
  await expect(preparer()(state.page, {} as never)).rejects.toThrow("exactly one visible options control");
  expect(state.sent()).toBeFalse();
});

test("fails closed when the target row does not expose one Project-home action", async () => {
  const state = harness({ homeCount: 2 });
  await expect(preparer()(state.page, {} as never)).rejects.toThrow("exactly one Project-home control");
  expect(state.sent()).toBeFalse();
});

test("fails closed when ChatGPT navigates the named row to a different Project identity", async () => {
  const state = harness({ projectSegment: "g-p-different-project" });
  await expect(preparer(500)(state.page, {} as never)).rejects.toThrow("configured dedicated Project identity");
  expect(state.sent()).toBeFalse();
});

test("rejects a Project home that already contains conversation turns", async () => {
  const state = harness({ finalTurns: 1 });
  await expect(preparer()(state.page, {} as never)).rejects.toThrow("already contains conversation turns");
  expect(state.sent()).toBeFalse();
});
