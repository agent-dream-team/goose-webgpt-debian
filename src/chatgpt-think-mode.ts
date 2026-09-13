import type { Locator } from "playwright-core";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  activateChatGptEffortMenu,
  parseChatGptEffortSliderState,
} from "./chatgpt-session";

const CHATGPT_THINK_ACTION_TIMEOUT_MS = 10_000;
const CHATGPT_COMPOSER_DOCUMENT_END_KEY = process.platform === "darwin"
  ? "Meta+ArrowDown"
  : "Control+End";

function throwIfThinkModeAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new DOMException("ChatGPT prompt attachment aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("ChatGPT prompt attachment aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}


async function composerState(
  composerForm: Locator,
  actionOptions: { signal?: AbortSignal; timeout: number },
): Promise<{ text: string; connectors: Array<string | null> }> {
  const composer = composerForm.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
  return await composer.evaluate(element => {
    const copy = element.cloneNode(true) as HTMLElement;
    const pills = [...copy.querySelectorAll('[data-id^="plugin:"][data-keyword]')];
    const connectors = pills.map(pill => pill.getAttribute("data-keyword")).sort();
    for (const pill of pills) pill.remove();
    const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value : copy.textContent ?? "";
    return { text: text.trim(), connectors };
  }, undefined, actionOptions);
}

async function setSemanticThinkingEffort(
  composerForm: Locator,
  enabled: boolean,
  captureDiagnostic: ((checkpoint: string) => Promise<void>) | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<boolean> {
  const effortControls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
  const controlCount = await effortControls.count();
  if (controlCount === 0) return false;
  if (controlCount !== 1) throw new Error(`ChatGPT exposed ${controlCount} visible effort controls`);

  const actionOptions = { signal: abortSignal, timeout: CHATGPT_THINK_ACTION_TIMEOUT_MS };
  const before = await composerState(composerForm, actionOptions);
  if (before.text) throw new Error("ChatGPT thinking-effort selection requires an empty prompt draft");

  const page = composerForm.page();
  let menuOpened = false;
  try {
    const activation = await activateChatGptEffortMenu(page, effortControls.first(), { settleMs: 5_000 });
    menuOpened = true;
    const slider = activation.slider;
    let state = parseChatGptEffortSliderState(
      await slider.getAttribute("aria-valuemin", actionOptions),
      await slider.getAttribute("aria-valuemax", actionOptions),
      await slider.getAttribute("aria-valuenow", actionOptions),
    );
    if (!state) throw new Error("ChatGPT thinking-effort slider exposed an invalid ARIA range");
    const targetValue = enabled ? Math.max(state.value, state.min + 1) : state.min;
    if (targetValue > state.max) {
      throw new Error("ChatGPT thinking-effort slider does not expose Medium effort");
    }
    while (state.value !== targetValue) {
      throwIfThinkModeAborted(abortSignal);
      const direction = state.value < targetValue ? 1 : -1;
      const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
      const previousValue = state.value;
      await slider.press(key, actionOptions);
      const deadline = Date.now() + 5_000;
      do {
        state = parseChatGptEffortSliderState(
          await slider.getAttribute("aria-valuemin", actionOptions),
          await slider.getAttribute("aria-valuemax", actionOptions),
          await slider.getAttribute("aria-valuenow", actionOptions),
        );
        if (!state) throw new Error("ChatGPT thinking-effort slider lost its semantic ARIA state");
        if (state.value !== previousValue) break;
        await sleepWithAbort(50, abortSignal);
      } while (Date.now() < deadline);
      if (state.value !== previousValue + direction) {
        throw new Error(
          `ChatGPT thinking-effort slider did not move exactly one step with ${key}`
          + ` (before=${previousValue}; after=${state.value})`,
        );
      }
    }
    await captureDiagnostic?.(enabled ? "think-effort-medium" : "think-effort-instant");
  } finally {
    if (menuOpened) await page.keyboard.press("Escape").catch(() => {});
  }

  const after = await composerState(composerForm, actionOptions);
  if (after.text || JSON.stringify(after.connectors) !== JSON.stringify(before.connectors)) {
    throw new Error("ChatGPT thinking-effort selection did not preserve the empty draft and selected connectors");
  }
  return true;
}

/** Ensure ChatGPT reasoning is at least Medium (or disable it) without changing draft/connector state. */
export async function setChatGptThinkMode(
  composerForm: Locator,
  enabled: boolean,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<void> {
  throwIfThinkModeAborted(abortSignal);
  if (await setSemanticThinkingEffort(composerForm, enabled, captureDiagnostic, abortSignal)) {
    await captureDiagnostic?.(enabled ? "think-enabled" : "think-disabled");
    return;
  }
  const controls = composerForm
    .getByRole("button", { name: "Think", exact: true })
    .filter({ visible: true });
  const count = await controls.count();
  if (count === 0 && !enabled) {
    await captureDiagnostic?.("luna-default-confirmed");
    return;
  }
  if (count > 1) throw new Error(`ChatGPT exposed ${count} visible Think controls`);
  const control = controls.first();
  const actionOptions = { signal: abortSignal, timeout: CHATGPT_THINK_ACTION_TIMEOUT_MS };
  let pressed = count === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
  if (count === 1 && pressed !== "true" && pressed !== "false") {
    throw new Error("ChatGPT Think control has no semantic pressed state");
  }
  const target = enabled ? "true" : "false";
  if (pressed !== target) {
    const composer = composerForm.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
    const before = await composerState(composerForm, actionOptions);
    if (before.text) throw new Error("ChatGPT Think selection requires an empty prompt draft");
    await composer.focus(actionOptions);
    await composer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, actionOptions);
    await composer.pressSequentially("/think", { ...actionOptions, delay: 25 });
    await captureDiagnostic?.("think-slash-triggered");
    const popup = composerForm.page().locator('.popover[aria-busy="false"]').filter({ visible: true });
    const rows = popup.locator('.__menu-item[tabindex="0"]').filter({ visible: true });
    await rows.first().waitFor({ state: "visible", timeout: 5_000, signal: abortSignal });
    if (await popup.count() !== 1 || await rows.count() !== 1) {
      throw new Error("ChatGPT Think slash menu must expose exactly one command option");
    }
    const row = rows.first();
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      await composer.press("ArrowDown", actionOptions);
    }
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      throw new Error("ChatGPT Think slash option is not highlighted");
    }
    await captureDiagnostic?.("think-slash-menu-ready");
    throwIfThinkModeAborted(abortSignal);
    await composer.press("Enter", actionOptions);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      throwIfThinkModeAborted(abortSignal);
      const currentCount = await controls.count();
      if (currentCount > 1) throw new Error(`ChatGPT exposed ${currentCount} visible Think controls`);
      pressed = currentCount === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
      if (pressed === target) break;
      if (currentCount === 1 && pressed !== "true" && pressed !== "false") {
        throw new Error("ChatGPT Think control lost its semantic pressed state");
      }
      await sleepWithAbort(100, abortSignal);
    }
    if (pressed !== target) {
      throw new Error(`ChatGPT did not ${enabled ? "enable" : "disable"} Think mode`);
    }
    const after = await composerState(composerForm, actionOptions);
    if (after.text || JSON.stringify(after.connectors) !== JSON.stringify(before.connectors)) {
      throw new Error("ChatGPT Think slash selection did not preserve the empty draft and selected connectors");
    }
  }
  await captureDiagnostic?.(enabled ? "think-enabled" : "think-disabled");
}
