/**
 * Insert plain text at the caret of an already-resolved ChatGPT composer.
 *
 * ChatGPT's Lexical editor can interpret CDP typing as Markdown shortcuts. The browser editing
 * command updates the focused contenteditable as plain text; callers must still verify readback.
 */
export function insertPlainTextIntoComposer(element: HTMLElement, value: string): boolean {
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const alreadyPlaced = selection.isCollapsed
    && selection.anchorNode !== null
    && element.contains(selection.anchorNode);
  if (!alreadyPlaced) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (!selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) {
    return false;
  }
  return document.execCommand("insertText", false, value);
}

/** Read only user text from the composer, excluding connector pills/cursor scaffolding. */
export function readChatGptComposerPlainText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(
    '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]',
  ).forEach(part => part.remove());
  return [...clone.childNodes].map(child => child.textContent ?? "").join("\n").trimStart();
}

function promptCodeUnitEquivalent(expected: string, observed: string, index: number): boolean {
  const expectedUnit = expected[index];
  const observedUnit = observed[index];
  if (expectedUnit === observedUnit) return true;
  if (expectedUnit !== " " || observedUnit !== "\u00A0") return false;
  return expected[index - 1] === " " || expected[index + 1] === " ";
}

/**
 * Lexical may expose ASCII spaces inside a multi-space run as NBSP. That DOM representation is
 * equivalent only in that narrow directional case; all other text changes fail closed.
 */
export function chatGptPromptTextEquivalent(expected: string, observed: string): boolean {
  if (expected.length !== observed.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (!promptCodeUnitEquivalent(expected, observed, index)) return false;
  }
  return true;
}

export function chatGptPromptEquivalentPrefixLength(expected: string, observed: string): number {
  const length = Math.min(expected.length, observed.length);
  let index = 0;
  while (index < length && promptCodeUnitEquivalent(expected, observed, index)) index += 1;
  return index;
}
