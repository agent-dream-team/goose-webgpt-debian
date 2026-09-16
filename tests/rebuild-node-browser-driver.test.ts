import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRebuildNodeBrowserDriver } from "../src/rebuild-node-browser-driver";
import type { RebuildPersistentBrowserTurnInput } from "../src/rebuild-provider-runtime";

const ROOTS: string[] = [];
const CONVERSATION = "aaaaaaaa-bbbb-4ccc-8ddd-000000000111";

afterEach(() => {
  while (ROOTS.length > 0) rmSync(ROOTS.pop()!, { recursive: true, force: true });
});

function workerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-node-browser-driver-test-"));
  ROOTS.push(root);
  const path = join(root, "worker.mjs");
  writeFileSync(path, `
import { createInterface } from "node:readline";
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
let started = false;
const accepted = { canonicalConversationId: ${JSON.stringify(CONVERSATION)}, acceptedUserTurnId: "user-fixture" };
const final = { ...accepted, text: "fixture final", remoteNonRunning: true };
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "start") {
    if (started) return out({ type: "error", message: "duplicate start" });
    if (message.config.connectorName !== "Goose Native 2nd Shift" || message.config.connectorMentionQuery !== "@Goose Native") {
      return out({ type: "error", message: "connector config missing" });
    }
    started = true;
    return out({ type: "lifecycle", event: "send_activated" });
  }
  if (message.type === "lifecycle_ack" && message.event === "send_activated") {
    if (!message.ok) return out({ type: "error", message: message.message || "send rejected" });
    return out({ type: "lifecycle", event: "accepted", evidence: accepted });
  }
  if (message.type === "lifecycle_ack" && message.event === "accepted") {
    if (!message.ok) return out({ type: "error", message: message.message || "accept rejected" });
    return out({ type: "candidate", evidence: final });
  }
  if (message.type === "boundary") return out({ type: "boundary", requestId: message.requestId, boundaryJson: "fixture-boundary" });
  if (message.type === "confirm") {
    out({ type: "confirmed", evidence: final });
    return setImmediate(() => process.exit(0));
  }
  if (message.type === "abort") return out({ type: "error", message: "fixture aborted" });
});
out({ type: "ready", version: 1 });
`, { mode: 0o600 });
  return path;
}

function boundaryRetryWorkerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-node-browser-driver-boundary-test-"));
  ROOTS.push(root);
  const path = join(root, "worker.mjs");
  writeFileSync(path, `
import { createInterface } from "node:readline";
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
const accepted = { canonicalConversationId: ${JSON.stringify(CONVERSATION)}, acceptedUserTurnId: "user-fixture" };
const final = { ...accepted, text: "fixture final", remoteNonRunning: true };
let boundaryAttempts = 0;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "start") return out({ type: "lifecycle", event: "send_activated" });
  if (message.type === "lifecycle_ack" && message.event === "send_activated") {
    if (!message.ok) return out({ type: "error", message: message.message || "send rejected" });
    return out({ type: "lifecycle", event: "accepted", evidence: accepted });
  }
  if (message.type === "lifecycle_ack" && message.event === "accepted") {
    if (!message.ok) return out({ type: "error", message: message.message || "accept rejected" });
    return;
  }
  if (message.type === "boundary") {
    boundaryAttempts += 1;
    if (boundaryAttempts === 1) return out({ type: "boundary", requestId: message.requestId, error: "identity not ready" });
    out({ type: "boundary", requestId: message.requestId, boundaryJson: "fixture-boundary" });
    return out({ type: "candidate", evidence: final });
  }
  if (message.type === "confirm") {
    out({ type: "confirmed", evidence: final });
    return setImmediate(() => process.exit(0));
  }
});
out({ type: "ready", version: 1 });
`, { mode: 0o600 });
  return path;
}

function recoveryControlWorkerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-node-browser-driver-recovery-test-"));
  ROOTS.push(root);
  const path = join(root, "worker.mjs");
  writeFileSync(path, `
import { createInterface } from "node:readline";
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
const accepted = { canonicalConversationId: ${JSON.stringify(CONVERSATION)}, acceptedUserTurnId: "user-fixture" };
const final = { ...accepted, text: "recovered fixture final", remoteNonRunning: true };
let latestProgress;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "start") return out({ type: "lifecycle", event: "send_activated" });
  if (message.type === "tool_progress") { latestProgress = message.snapshot; return; }
  if (message.type === "lifecycle_ack" && message.event === "send_activated") {
    return out({ type: "lifecycle", event: "accepted", evidence: accepted });
  }
  if (message.type === "lifecycle_ack" && message.event === "accepted") {
    return out({ type: "quarantine_tool", requestId: 7, expectedRevision: latestProgress.revision });
  }
  if (message.type === "quarantine_tool_ack") {
    if (!message.quarantined || message.snapshot.activeToolCalls !== 0) {
      return out({ type: "error", message: "quarantine acknowledgement invalid" });
    }
    return out({ type: "candidate", evidence: final });
  }
  if (message.type === "terminate_owner") {
    out({ type: "owner_terminated" });
    return out({ type: "error", message: "authoritative owner terminated" });
  }
  if (message.type === "confirm") {
    out({ type: "confirmed", evidence: final });
    return setImmediate(() => process.exit(0));
  }
});
out({ type: "ready", version: 1 });
`, { mode: 0o600 });
  return path;
}

function ownerTerminationWorkerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-node-browser-driver-owner-test-"));
  ROOTS.push(root);
  const path = join(root, "worker.mjs");
  writeFileSync(path, `
import { createInterface } from "node:readline";
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
const accepted = { canonicalConversationId: ${JSON.stringify(CONVERSATION)}, acceptedUserTurnId: "user-fixture" };
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "start") return out({ type: "lifecycle", event: "send_activated" });
  if (message.type === "lifecycle_ack" && message.event === "send_activated") {
    return out({ type: "lifecycle", event: "accepted", evidence: accepted });
  }
  if (message.type === "terminate_owner") {
    out({ type: "owner_terminated" });
    return out({ type: "error", message: "authoritative owner terminated" });
  }
});
out({ type: "ready", version: 1 });
`, { mode: 0o600 });
  return path;
}

function turnInput(overrides: Partial<RebuildPersistentBrowserTurnInput> = {}): RebuildPersistentBrowserTurnInput {
  return {
    turnRef: "turn-fixture",
    gooseSessionId: "goose-fixture",
    epoch: 1,
    initialOpRef: "op-fixture",
    submitNonce: "nonce-fixture",
    prompt: "private prompt sentinel",
    existingConversationId: null,
    preSendAbortSignal: new AbortController().signal,
    gooseWork: {
      snapshot: () => ({ revision: 0, lastToolBatchRevision: 0, activeToolCalls: 0 }),
      quarantineStalledToolWork: async () => false,
    },
    lifecycle: {
      onSendActivated: () => {},
      onAccepted: () => {},
    },
    ...overrides,
  };
}

function driver(workerPath: string) {
  return createRebuildNodeBrowserDriver({
    nodeExecutable: process.execPath,
    workerPath,
    descriptorPath: "/tmp/unused-descriptor.json",
    projectId: "g-p-project",
    projectName: "Project",
    connectorName: "Goose Native 2nd Shift",
    connectorMentionQuery: "@Goose Native",
    toolStatePollMs: 10,
  });
}

test("worker cannot advance past send activation or acceptance before parent durability acknowledgements", async () => {
  const events: string[] = [];
  const execution = driver(workerFixture()).createTurn(turnInput({
    lifecycle: {
      onSendActivated: async () => {
        events.push("send-start");
        await Bun.sleep(30);
        events.push("send-durable");
      },
      onAccepted: async evidence => {
        events.push(`accepted:${evidence.acceptedUserTurnId}`);
        await Bun.sleep(20);
        events.push("accept-durable");
      },
    },
  }));

  const candidate = await execution.run();
  expect(events).toEqual(["send-start", "send-durable", "accepted:user-fixture", "accept-durable"]);
  expect(candidate).toMatchObject({
    canonicalConversationId: CONVERSATION,
    acceptedUserTurnId: "user-fixture",
    text: "fixture final",
    remoteNonRunning: true,
  });
  expect(await execution.captureAnswerBoundary("op-fixture")).toBe("fixture-boundary");
  expect(await execution.confirmFinal(candidate)).toEqual(candidate);
});

test("parent rejection of the send fence fails the worker turn instead of acknowledging irreversible send", async () => {
  const execution = driver(workerFixture()).createTurn(turnInput({
    lifecycle: {
      onSendActivated: async () => { throw new Error("durable send fence failed"); },
      onAccepted: () => { throw new Error("acceptance must not run"); },
    },
  }));
  await expect(execution.run()).rejects.toThrow("durable send fence failed");
});

test("boundary refusal rejects only that request while the browser turn remains live", async () => {
  let acceptedResolve!: () => void;
  const accepted = new Promise<void>(resolve => { acceptedResolve = resolve; });
  const execution = driver(boundaryRetryWorkerFixture()).createTurn(turnInput({
    lifecycle: {
      onSendActivated: () => {},
      onAccepted: () => { acceptedResolve(); },
    },
  }));

  const running = execution.run();
  await accepted;
  await expect(execution.captureAnswerBoundary("op-fixture")).rejects.toThrow("identity not ready");
  expect(await execution.captureAnswerBoundary("op-fixture")).toBe("fixture-boundary");
  const candidate = await running;
  expect(candidate.text).toBe("fixture final");
  expect(await execution.confirmFinal(candidate)).toEqual(candidate);
});

test("worker stale-progress quarantine round-trips through the authoritative parent snapshot", async () => {
  let progress = { revision: 1, lastToolBatchRevision: 1, activeToolCalls: 1, lastProgressAt: 1 };
  let quarantines = 0;
  const execution = driver(recoveryControlWorkerFixture()).createTurn(turnInput({
    gooseWork: {
      snapshot: () => ({ ...progress }),
      quarantineStalledToolWork: async expectedRevision => {
        expect(expectedRevision).toBe(1);
        quarantines += 1;
        progress = { ...progress, revision: 2, activeToolCalls: 0 };
        return true;
      },
    },
  }));

  const candidate = await execution.run();
  expect(candidate.text).toBe("recovered fixture final");
  expect(quarantines).toBe(1);
  expect(await execution.confirmFinal(candidate)).toEqual(candidate);
});

test("authoritative owner termination is acknowledged by the worker before process cleanup", async () => {
  let resolveAccepted!: () => void;
  const accepted = new Promise<void>(resolve => { resolveAccepted = resolve; });
  const execution = driver(ownerTerminationWorkerFixture()).createTurn(turnInput({
    lifecycle: { onSendActivated: () => {}, onAccepted: () => resolveAccepted() },
  }));
  const running = execution.run();
  await accepted;
  const rejection = running.then(
    () => new Error("browser execution unexpectedly completed"),
    error => error as Error,
  );

  await execution.terminateOwner?.("terminal_response");
  expect((await rejection).message).toContain("authoritative owner terminated");
});
