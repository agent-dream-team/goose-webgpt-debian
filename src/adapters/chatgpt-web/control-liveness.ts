import { ChatGptWebAdapterError } from "./adapter-error";

export const CHATGPT_POST_SEND_CONTROL_PROBE_INTERVAL_MS = 5_000;
export const CHATGPT_POST_SEND_CONTROL_PROBE_TIMEOUT_MS = 3_000;
export const CHATGPT_POST_SEND_CONTROL_MAX_CONSECUTIVE_FAILURES = 2;
export const CHATGPT_BROWSER_CONTROL_CLEANUP_TIMEOUT_MS = 3_000;
export const CHATGPT_BROWSER_DIAGNOSTIC_TIMEOUT_MS = 6_000;

export async function withBrowserControlTimeout<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PostSendBrowserControlLivenessWatch {
  failure: Promise<never>;
  stop(): void;
}

/**
 * Watch only browser-control responsiveness after submission. This has no generation deadline: a
 * responsive browser may generate forever. Each probe is independently bounded, successful probes
 * reset the failure streak, and only repeated control-path failures terminate the turn.
 */
export function startPostSendBrowserControlLiveness(
  probe: () => Promise<unknown>,
  options: {
    intervalMs?: number;
    probeTimeoutMs?: number;
    maxConsecutiveFailures?: number;
  } = {},
): PostSendBrowserControlLivenessWatch {
  const intervalMs = options.intervalMs ?? CHATGPT_POST_SEND_CONTROL_PROBE_INTERVAL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? CHATGPT_POST_SEND_CONTROL_PROBE_TIMEOUT_MS;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? CHATGPT_POST_SEND_CONTROL_MAX_CONSECUTIVE_FAILURES;
  if (intervalMs <= 0 || probeTimeoutMs <= 0 || maxConsecutiveFailures <= 0) {
    throw new Error("ChatGPT browser-control liveness bounds must be positive");
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { void runProbe(); }, intervalMs);
  };
  const runProbe = async () => {
    if (stopped) return;
    let live = true;
    try {
      await withBrowserControlTimeout(
        probe,
        probeTimeoutMs,
        "ChatGPT post-send browser-control liveness probe timed out",
      );
    } catch {
      live = false;
    }
    if (stopped) return;
    if (live) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        stopped = true;
        rejectFailure(new ChatGptWebAdapterError(
          "ChatGPT browser/CDP control path became unresponsive after the message was sent.",
          {
            status: 502,
            errorType: "server_error",
            code: "chatgpt_browser_control_unresponsive",
            retryable: true,
          },
        ));
        return;
      }
    }
    schedule();
  };

  schedule();
  return {
    failure,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
