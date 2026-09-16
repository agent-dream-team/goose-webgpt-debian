import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  RebuildBrowserAcceptedEvidence,
  RebuildBrowserFinalEvidence,
  RebuildPersistentBrowserDriver,
  RebuildPersistentBrowserTurnExecution,
  RebuildPersistentBrowserTurnInput,
} from "./rebuild-provider-runtime";

const DEFAULT_TOOL_STATE_POLL_MS = 25;

export interface RebuildNodeBrowserDriverOptions {
  nodeExecutable: string;
  workerPath: string;
  descriptorPath: string;
  projectId: string;
  projectName: string;
  connectorName: string;
  connectorMentionQuery: string;
  timeoutMs?: number;
  toolStatePollMs?: number;
  workerEnv?: NodeJS.ProcessEnv;
}

type WorkerMessage =
  | { type: "ready"; version: 1 }
  | { type: "lifecycle"; event: "send_activated" }
  | { type: "lifecycle"; event: "accepted" | "rebound"; evidence: RebuildBrowserAcceptedEvidence }
  | { type: "candidate"; evidence: RebuildBrowserFinalEvidence }
  | { type: "confirmed"; evidence: RebuildBrowserFinalEvidence }
  | { type: "boundary"; requestId: number; boundaryJson?: string; error?: string }
  | { type: "execution_detached" }
  | { type: "error"; message: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // Some protocol branches fail before every exposed operation is awaited; keep those dormant
  // deferreds observed while preserving rejection for the caller that does await the original promise.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseWorkerMessage(line: string): WorkerMessage {
  const decoded = JSON.parse(line) as Partial<WorkerMessage>;
  if (!decoded || typeof decoded !== "object" || typeof decoded.type !== "string") {
    throw new Error("Node browser worker emitted invalid protocol data");
  }
  return decoded as WorkerMessage;
}

export function createRebuildNodeBrowserDriver(
  options: RebuildNodeBrowserDriverOptions,
): RebuildPersistentBrowserDriver {
  if (!options.nodeExecutable || !options.workerPath || !options.descriptorPath
    || !options.projectId || !options.projectName || !options.connectorName || !options.connectorMentionQuery) {
    throw new Error("Node browser driver configuration is incomplete");
  }
  const toolStatePollMs = options.toolStatePollMs ?? DEFAULT_TOOL_STATE_POLL_MS;

  return {
    createTurn(input: RebuildPersistentBrowserTurnInput): RebuildPersistentBrowserTurnExecution {
      let child: ChildProcessWithoutNullStreams | undefined;
      let runStarted = false;
      let candidate: RebuildBrowserFinalEvidence | undefined;
      let terminal = false;
      let latestToolProgressRevision = -1;
      let toolTimer: ReturnType<typeof setInterval> | undefined;
      let boundaryRequestId = 0;
      const ready = deferred<void>();
      const runResult = deferred<RebuildBrowserFinalEvidence>();
      const confirmResult = deferred<RebuildBrowserFinalEvidence>();
      const executionDetachResult = deferred<void>();
      const boundaries = new Map<number, Deferred<string>>();
      let messageChain = Promise.resolve();
      let stderrTail = "";

      const rejectAll = (error: Error) => {
        if (terminal) return;
        terminal = true;
        ready.reject(error);
        runResult.reject(error);
        confirmResult.reject(error);
        executionDetachResult.reject(error);
        for (const pending of boundaries.values()) pending.reject(error);
        boundaries.clear();
        if (toolTimer) clearInterval(toolTimer);
        toolTimer = undefined;
      };

      const send = async (message: unknown): Promise<void> => {
        const current = child;
        if (!current || current.stdin.destroyed || current.stdin.writableEnded
          || current.exitCode !== null || current.signalCode !== null) {
          throw new Error("Node browser worker input is unavailable");
        }
        await new Promise<void>((resolve, reject) => {
          current.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve());
        });
      };

      const stopWorker = () => {
        if (toolTimer) clearInterval(toolTimer);
        toolTimer = undefined;
        const current = child;
        if (!current) return;
        child = undefined;
        if (!current.stdin.destroyed && !current.stdin.writableEnded) current.stdin.end();
        if (current.exitCode === null && current.signalCode === null) current.kill("SIGTERM");
      };

      const fail = (error: unknown) => {
        const detail = stderrTail ? `${errorMessage(error)}; worker stderr: ${stderrTail}` : errorMessage(error);
        rejectAll(new Error(detail));
        stopWorker();
      };

      const handleLifecycle = async (message: Extract<WorkerMessage, { type: "lifecycle" }>) => {
        try {
          if (message.event === "send_activated") await input.lifecycle.onSendActivated();
          else if (message.event === "accepted") await input.lifecycle.onAccepted(message.evidence);
          else {
            if (!input.lifecycle.onRebound) throw new Error("Node browser rebind has no parent lifecycle handler");
            await input.lifecycle.onRebound(message.evidence);
          }
          await send({ type: "lifecycle_ack", event: message.event, ok: true });
        } catch (error) {
          // A parent durability refusal is already authoritative for this turn. Do not send a
          // negative acknowledgement and then tear the child down: the worker would react by
          // writing the same failure back while its pipe is closing, which can race into EPIPE.
          // Throwing here lets the parent preserve the original refusal and terminate the worker.
          throw error;
        }
      };

      const handleMessage = async (message: WorkerMessage) => {
        if (message.type === "ready") {
          if (message.version !== 1) throw new Error("Node browser worker protocol version is unsupported");
          ready.resolve();
          return;
        }
        if (message.type === "lifecycle") {
          await handleLifecycle(message);
          return;
        }
        if (message.type === "candidate") {
          candidate = message.evidence;
          runResult.resolve(message.evidence);
          return;
        }
        if (message.type === "confirmed") {
          terminal = true;
          confirmResult.resolve(message.evidence);
          if (toolTimer) clearInterval(toolTimer);
          toolTimer = undefined;
          return;
        }
        if (message.type === "boundary") {
          const pending = boundaries.get(message.requestId);
          if (!pending) throw new Error("Node browser worker returned an unknown boundary request");
          boundaries.delete(message.requestId);
          if (message.error !== undefined) {
            pending.reject(new Error(message.error));
            return;
          }
          if (typeof message.boundaryJson !== "string") {
            throw new Error("Node browser worker returned an invalid boundary response");
          }
          pending.resolve(message.boundaryJson);
          return;
        }
        if (message.type === "execution_detached") {
          executionDetachResult.resolve();
          if (!terminal) {
            // The acknowledgement is the terminal fence. Settle parent promises here because
            // stopping the disposable child may race with its later diagnostic error frame.
            terminal = true;
            const error = new Error("process-local browser execution detached");
            runResult.reject(error);
            confirmResult.reject(error);
            for (const pending of boundaries.values()) pending.reject(error);
            boundaries.clear();
            if (toolTimer) clearInterval(toolTimer);
            toolTimer = undefined;
          }
          return;
        }
        if (message.type === "error") throw new Error(message.message);
      };

      const startWorker = async () => {
        if (child) return;
        const current = spawn(options.nodeExecutable, [options.workerPath], {
          env: { ...process.env, ...options.workerEnv },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        child = current;
        const output = createInterface({ input: current.stdout, crlfDelay: Infinity });
        const errors = createInterface({ input: current.stderr, crlfDelay: Infinity });
        output.on("line", line => {
          messageChain = messageChain.then(async () => {
            const message = parseWorkerMessage(line);
            await handleMessage(message);
          }).catch(fail);
        });
        errors.on("line", line => {
          stderrTail = `${stderrTail}${stderrTail ? " | " : ""}${line}`.slice(-4_000);
        });
        current.once("error", fail);
        current.once("exit", (code, signal) => {
          if (!terminal) fail(new Error(
            `Node browser worker exited ${signal ? `from signal ${signal}` : `with status ${code ?? 1}`}`,
          ));
        });
        await ready.promise;
        await send({
          type: "start",
          config: {
            descriptorPath: options.descriptorPath,
            projectId: options.projectId,
            projectName: options.projectName,
            connectorName: options.connectorName,
            connectorMentionQuery: options.connectorMentionQuery,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          },
          input: {
            turnRef: input.turnRef,
            gooseSessionId: input.gooseSessionId,
            epoch: input.epoch,
            initialOpRef: input.initialOpRef,
            submitNonce: input.submitNonce,
            prompt: input.prompt,
            existingConversationId: input.existingConversationId,
            ...(input.resumeAccepted ? { resumeAccepted: input.resumeAccepted } : {}),
          },
        });
        const abort = () => { void send({ type: "abort" }).catch(() => {}); };
        input.preSendAbortSignal.addEventListener("abort", abort, { once: true });
        if (input.preSendAbortSignal.aborted) abort();
        const publishToolState = () => {
          const next = input.gooseWork.snapshot();
          if (next.revision === latestToolProgressRevision) return;
          latestToolProgressRevision = next.revision;
          void send({ type: "tool_progress", snapshot: next }).catch(fail);
        };
        publishToolState();
        toolTimer = setInterval(publishToolState, toolStatePollMs);
        toolTimer.unref?.();
      };

      return {
        detachExecution: async reason => {
          if (!runStarted) throw new Error("Node browser execution detach requires an active run");
          await send({ type: "detach_execution", reason });
          try { await executionDetachResult.promise; }
          finally { stopWorker(); }
        },
        run: async () => {
          if (runStarted) throw new Error("Node browser turn run() may be called only once");
          runStarted = true;
          await startWorker();
          try { return await runResult.promise; }
          catch (error) { stopWorker(); throw error; }
        },
        confirmFinal: async evidence => {
          if (!runStarted || !candidate) throw new Error("Node browser final confirmation requires a completed run candidate");
          await send({ type: "confirm", candidate: evidence });
          try { return await confirmResult.promise; }
          finally { stopWorker(); }
        },
        captureAnswerBoundary: async opRef => {
          if (!runStarted) throw new Error("Node browser answer boundary requires an active run");
          boundaryRequestId += 1;
          const pending = deferred<string>();
          boundaries.set(boundaryRequestId, pending);
          try {
            await send({ type: "boundary", requestId: boundaryRequestId, opRef });
            return await pending.promise;
          } catch (error) {
            boundaries.delete(boundaryRequestId);
            throw error;
          }
        },
      };
    },
  };
}
