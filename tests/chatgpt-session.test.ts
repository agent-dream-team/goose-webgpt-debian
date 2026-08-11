import { expect, test } from "bun:test";
import {
  CHATGPT_COMPOSER_SELECTOR,
  chatGptAuthenticationSurfaceReady,
  isAuthenticatedTemporaryChatPage,
} from "../src/chatgpt-session";

test("login keeps the established turn composer contract", () => {
  const turnSelectors = CHATGPT_COMPOSER_SELECTOR.split(",").map(selector => selector.trim());
  expect(turnSelectors).toContain('[data-testid="prompt-textarea"]');
  expect(turnSelectors).toContain("#prompt-textarea");
  expect(turnSelectors).toContain('[contenteditable="true"][data-lexical-editor="true"]');
  expect(turnSelectors).not.toContain('form [contenteditable="true"]');
  expect(turnSelectors).not.toContain("form textarea[placeholder]");
});

test("login requires one atomic Temporary Chat composer observation", async () => {
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://chatgpt.com/auth/login",
    visibleComposerCount: 1,
  })).toBe(false);
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://chatgpt.com/?temporary-chat=true",
    visibleComposerCount: 0,
  })).toBe(false);
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://chatgpt.com/?temporary-chat=true",
    visibleComposerCount: 2,
  })).toBe(false);
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://example.com/?temporary-chat=true",
    visibleComposerCount: 1,
  })).toBe(false);
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://chatgpt.com/?temporary-chat=true",
    visibleComposerCount: 1,
  })).toBe(true);

  let evaluations = 0;
  let callbackSource = "";
  const page = {
    evaluate: async (callback: unknown, input: { composerSelector: string }) => {
      evaluations += 1;
      callbackSource = String(callback);
      expect(input.composerSelector).toBe(CHATGPT_COMPOSER_SELECTOR);
      return {
        url: "https://chatgpt.com/?temporary-chat=true",
        visibleComposerCount: 1,
      };
    },
  };
  await expect(isAuthenticatedTemporaryChatPage(page as never)).resolves.toBe(true);
  expect(evaluations).toBe(1);
  expect(callbackSource).toContain("location.href");
  expect(callbackSource).toContain("document.querySelectorAll(composerSelector)");
  expect(callbackSource).toContain("bounds.width > 0");
  expect(callbackSource).toContain("bounds.height > 0");

  const navigatingPage = {
    evaluate: async () => { throw new Error("Execution context was destroyed"); },
  };
  await expect(isAuthenticatedTemporaryChatPage(navigatingPage as never)).resolves.toBe(false);
});
