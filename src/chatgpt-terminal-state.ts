import type { Locator } from "playwright-core";

export type ChatGptTerminalErrorKind = "regenerate-error" | "something-went-wrong";

export class ChatGptUpstreamTerminalError extends Error {
  readonly kind: ChatGptTerminalErrorKind;

  constructor(kind: ChatGptTerminalErrorKind) {
    super(kind === "regenerate-error"
      ? "ChatGPT ended the accepted response in an explicit upstream error state"
      : "ChatGPT ended the accepted response with 'Something went wrong'");
    this.name = "ChatGptUpstreamTerminalError";
    this.kind = kind;
  }
}

type ChatGptTextScope = Pick<Locator, "getByText" | "getByTestId">;

const chatGptTerminalErrorAlert = (scope: ChatGptTextScope): Locator => scope
  .getByText(/Something went wrong[\s\S]*help\.openai\.com/i)
  .last();

/** Detects only explicit terminal error UI inside the supplied ChatGPT turn scope. */
export async function detectChatGptTerminalError(scope: ChatGptTextScope): Promise<ChatGptTerminalErrorKind | undefined> {
  if (await scope.getByTestId("regenerate-thread-error-button").last().isVisible().catch(() => false)) {
    return "regenerate-error";
  }
  if (await chatGptTerminalErrorAlert(scope).isVisible().catch(() => false)) {
    return "something-went-wrong";
  }
  return undefined;
}
