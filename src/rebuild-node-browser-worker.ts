import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { createChatGptProjectNavigationEntry } from "./rebuild-project-entry";
import { createRebuildPersistentBrowserDriver } from "./rebuild-persistent-browser-driver";
import {
  assertChatGptTurnProgressSnapshot,
  type ChatGptExternalTurnProgressSnapshot,
} from "./adapters/chatgpt-web/turn-progress";
import type {
  RebuildBrowserAcceptedEvidence,
  RebuildBrowserFinalEvidence,
  RebuildPersistentBrowserTurnExecution,
} from "./rebuild-provider-runtime";

type StartMessage = {
  type: "start";
  config: {
    descriptorPath: string;
    projectId: string;
    projectName: string;
    connectorName: string;
    connectorMentionQuery: string;
    timeoutMs?: number;
  };
  input: {
    turnRef: string;
    gooseSessionId: string;
    epoch: number;
    initialOpRef: string;
    submitNonce: string;
    prompt: string;
    existingConversationId: string | null;
  };
};

type InputMessage = StartMessage
  | { type: "lifecycle_ack"; event: "send_activated" | "accepted"; ok: boolean; message?: string }
  | { type: "tool_progress"; snapshot: ChatGptExternalTurnProgressSnapshot }
  | { type: "quarantine_tool_ack"; requestId: number; quarantined: boolean; snapshot: ChatGptExternalTurnProgressSnapshot }
  | { type: "terminate_owner"; reason: string }
  | { type: "abort" }
  | { type: "boundary"; requestId: number; opRef: string }
  | { type: "confirm"; candidate: RebuildBrowserFinalEvidence }
  | { type: "shutdown" };

interface Deferred<T = void> {
  resolve(value: T): void;
  reject(error: Error): void;
}

let execution: RebuildPersistentBrowserTurnExecution | undefined;
let abortController: AbortController | undefined;
let toolProgress: ChatGptExternalTurnProgressSnapshot = {
  revision: 0,
  lastToolBatchRevision: 0,
  activeToolCalls: 0,
};
let quarantineRequestId = 0;
let started = false;
let candidate: RebuildBrowserFinalEvidence | undefined;
let confirmed = false;
let ownerTerminating = false;
const lifecycleWaiters = new Map<"send_activated" | "accepted", Deferred>();
const quarantineWaiters = new Map<number, Deferred<boolean>>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function write(message: unknown): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function waitForLifecycleAck(
  event: "send_activated" | "accepted",
  evidence?: RebuildBrowserAcceptedEvidence,
): Promise<void> {
  if (lifecycleWaiters.has(event)) {
    return Promise.reject(new Error(`Node browser worker already awaits ${event} acknowledgement`));
  }
  return new Promise<void>((resolve, reject) => {
    lifecycleWaiters.set(event, { resolve, reject });
    write({ type: "lifecycle", event, ...(evidence ? { evidence } : {}) });
  });
}

function start(message: StartMessage): void {
  if (started) throw new Error("Node browser worker already owns a turn");
  const { config, input } = message;
  if (!config.descriptorPath || !config.projectId || !config.projectName
    || !config.connectorName || !config.connectorMentionQuery
    || !input.turnRef || !input.gooseSessionId || !input.initialOpRef || !input.submitNonce
    || typeof input.prompt !== "string" || !Number.isSafeInteger(input.epoch) || input.epoch < 1) {
    throw new Error("Node browser worker start message is invalid");
  }
  started = true;
  abortController = new AbortController();
  const driver = createRebuildPersistentBrowserDriver({
    descriptorPath: config.descriptorPath,
    projectId: config.projectId,
    connectorName: config.connectorName,
    connectorMentionQuery: config.connectorMentionQuery,
    prepareFreshProjectChat: createChatGptProjectNavigationEntry({
      projectId: config.projectId,
      projectName: config.projectName,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  });
  execution = driver.createTurn({
    ...input,
    preSendAbortSignal: abortController.signal,
    gooseWork: {
      snapshot: () => ({ ...toolProgress }),
      quarantineStalledToolWork: expectedRevision => new Promise<boolean>((resolve, reject) => {
        quarantineRequestId += 1;
        quarantineWaiters.set(quarantineRequestId, { resolve, reject });
        write({ type: "quarantine_tool", requestId: quarantineRequestId, expectedRevision });
      }),
    },
    lifecycle: {
      onSendActivated: () => waitForLifecycleAck("send_activated"),
      onAccepted: evidence => waitForLifecycleAck("accepted", evidence),
    },
  });
  void execution.run().then(evidence => {
    candidate = evidence;
    write({ type: "candidate", evidence });
  }).catch(error => {
    // Authoritative owner termination deliberately tears down the disposable browser observer.
    // Its explicit owner_terminated frame is the parent protocol fence; do not race that
    // acknowledgement with the expected run() rejection caused by closing the surface.
    if (!ownerTerminating) write({ type: "error", message: errorMessage(error) });
  });
}

async function handle(message: InputMessage): Promise<void> {
  if (message.type === "start") {
    start(message);
    return;
  }
  if (message.type === "lifecycle_ack") {
    const waiter = lifecycleWaiters.get(message.event);
    if (!waiter) throw new Error(`Node browser worker has no pending ${message.event} acknowledgement`);
    lifecycleWaiters.delete(message.event);
    if (message.ok) waiter.resolve();
    else waiter.reject(new Error(message.message || `Parent rejected ${message.event}`));
    return;
  }
  if (message.type === "tool_progress") {
    assertChatGptTurnProgressSnapshot(message.snapshot);
    if (message.snapshot.revision >= toolProgress.revision) toolProgress = { ...message.snapshot };
    return;
  }
  if (message.type === "quarantine_tool_ack") {
    const waiter = quarantineWaiters.get(message.requestId);
    if (!waiter) throw new Error("Node browser worker received an unknown quarantine acknowledgement");
    quarantineWaiters.delete(message.requestId);
    assertChatGptTurnProgressSnapshot(message.snapshot);
    if (message.snapshot.revision >= toolProgress.revision) toolProgress = { ...message.snapshot };
    waiter.resolve(message.quarantined);
    return;
  }
  if (message.type === "terminate_owner") {
    if (!execution?.terminateOwner) throw new Error("Node browser worker cannot detach its owner");
    ownerTerminating = true;
    await execution.terminateOwner(message.reason);
    write({ type: "owner_terminated" });
    return;
  }
  if (message.type === "abort") {
    abortController?.abort(new DOMException("Parent aborted browser execution", "AbortError"));
    return;
  }
  if (message.type === "boundary") {
    try {
      if (!execution) throw new Error("Node browser worker has no active execution for answer-boundary capture");
      const boundaryJson = await execution.captureAnswerBoundary(message.opRef);
      write({ type: "boundary", requestId: message.requestId, boundaryJson });
    } catch (error) {
      // Boundary observation is pre-side-effect work. A transient identity/DOM failure belongs only
      // to this boundary request; the parent connector will return BOUNDARY_REQUIRED and may retry.
      // Do not turn that local refusal into a global browser-turn failure.
      write({ type: "boundary", requestId: message.requestId, error: errorMessage(error) });
    }
    return;
  }
  if (message.type === "confirm") {
    if (!execution || !candidate) throw new Error("Node browser worker cannot confirm before a run candidate");
    if (confirmed) throw new Error("Node browser worker final confirmation already completed");
    const evidence = await execution.confirmFinal(message.candidate);
    confirmed = true;
    write({ type: "confirmed", evidence });
    setImmediate(() => process.exit(0));
    return;
  }
  abortController?.abort(new DOMException("Node browser worker shutdown", "AbortError"));
  process.exit(0);
}

const lines = createInterface({ input: stdin, crlfDelay: Infinity });
lines.on("line", line => {
  void Promise.resolve().then(async () => {
    const message = JSON.parse(line) as InputMessage;
    await handle(message);
  }).catch(error => {
    write({ type: "error", message: errorMessage(error) });
  });
});

process.once("SIGINT", () => abortController?.abort(new DOMException("Node browser worker interrupted", "AbortError")));
process.once("SIGTERM", () => abortController?.abort(new DOMException("Node browser worker terminated", "AbortError")));
write({ type: "ready", version: 1 });
