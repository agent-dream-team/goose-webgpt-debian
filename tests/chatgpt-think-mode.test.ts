import { expect, test } from "bun:test";
import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
} from "../src/chatgpt-session";
import { setChatGptThinkMode } from "../src/chatgpt-think-mode";

function effortFixture(input: { value?: number; min?: number; max?: number; draft?: string } = {}) {
  const state = {
    min: input.min ?? 0,
    max: input.max ?? 3,
    value: input.value ?? 2,
    draft: input.draft ?? "",
    connectors: ["Goose Native 2nd Shift"],
    menuOpen: true,
    sliderKeys: [] as string[],
    escapes: 0,
    legacyThinkLookups: 0,
  };

  const slider = {
    getAttribute: async (name: string) => {
      if (name === "aria-valuemin") return String(state.min);
      if (name === "aria-valuemax") return String(state.max);
      if (name === "aria-valuenow") return String(state.value);
      return null;
    },
    press: async (key: string) => {
      state.sliderKeys.push(key);
      if (key === "ArrowLeft") state.value = Math.max(state.min, state.value - 1);
      if (key === "ArrowRight") state.value = Math.min(state.max, state.value + 1);
    },
  } as unknown as Locator;

  const sliderContainer = {
    isVisible: async () => state.menuOpen,
    locator: (selector: string) => {
      expect(selector).toBe('[role="slider"]');
      return slider;
    },
  } as unknown as Locator;
  const sliderContainers = {
    filter: () => sliderContainers,
    last: () => sliderContainer,
  } as unknown as Locator;
  const menu = { isVisible: async () => state.menuOpen } as unknown as Locator;
  const menus = { filter: () => menus, last: () => menu } as unknown as Locator;

  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-expanded") return state.menuOpen ? "true" : "false";
      if (name === "data-state") return state.menuOpen ? "open" : "closed";
      if (name === "aria-controls") return null;
      return null;
    },
  } as unknown as Locator;
  const controls = {
    filter: () => controls,
    count: async () => 1,
    first: () => control,
  } as unknown as Locator;

  const composer = {
    evaluate: async () => ({ text: state.draft.trim(), connectors: [...state.connectors].sort() }),
  } as unknown as Locator;
  const composers = { filter: () => composers, first: () => composer } as unknown as Locator;

  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return sliderContainers;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menus;
      throw new Error(`Unexpected page locator ${selector}`);
    },
    keyboard: {
      press: async (key: string) => {
        expect(key).toBe("Escape");
        state.escapes += 1;
        state.menuOpen = false;
      },
    },
  } as unknown as Page;

  const form = {
    locator: (selector: string) => {
      if (selector === CHATGPT_EFFORT_CONTROL_SELECTOR) return controls;
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composers;
      throw new Error(`Unexpected form locator ${selector}`);
    },
    page: () => page,
    getByRole: () => {
      state.legacyThinkLookups += 1;
      throw new Error("legacy Think path must not run when semantic effort exists");
    },
  } as unknown as Locator;

  return { form, state };
}

test("semantic Sol effort preserves an already-High effort and connector/draft", async () => {
  const f = effortFixture({ value: 2 });
  const diagnostics: string[] = [];
  await setChatGptThinkMode(f.form, true, async checkpoint => { diagnostics.push(checkpoint); });
  expect(f.state.value).toBe(2);
  expect(f.state.sliderKeys).toEqual([]);
  expect(f.state.draft).toBe("");
  expect(f.state.connectors).toEqual(["Goose Native 2nd Shift"]);
  expect(f.state.escapes).toBe(1);
  expect(f.state.legacyThinkLookups).toBe(0);
  expect(diagnostics).toEqual(["think-effort-medium", "think-enabled"]);
});

test("semantic Sol effort raises Instant to Medium", async () => {
  const f = effortFixture({ value: 0 });
  await setChatGptThinkMode(f.form, true);
  expect(f.state.value).toBe(1);
  expect(f.state.sliderKeys).toEqual(["ArrowRight"]);
  expect(f.state.legacyThinkLookups).toBe(0);
});

test("semantic Sol effort no-ops when already Medium", async () => {
  const f = effortFixture({ value: 1 });
  await setChatGptThinkMode(f.form, true);
  expect(f.state.value).toBe(1);
  expect(f.state.sliderKeys).toEqual([]);
  expect(f.state.legacyThinkLookups).toBe(0);
});

test("semantic effort fails closed instead of falling back when Medium is unavailable", async () => {
  const f = effortFixture({ value: 0, min: 0, max: 0 });
  await expect(setChatGptThinkMode(f.form, true)).rejects.toThrow("does not expose Medium effort");
  expect(f.state.legacyThinkLookups).toBe(0);
  expect(f.state.escapes).toBe(1);
});

test("semantic effort refuses a non-empty draft before changing state", async () => {
  const f = effortFixture({ value: 2, draft: "leftover" });
  await expect(setChatGptThinkMode(f.form, true)).rejects.toThrow("requires an empty prompt draft");
  expect(f.state.value).toBe(2);
  expect(f.state.sliderKeys).toEqual([]);
  expect(f.state.legacyThinkLookups).toBe(0);
});
