import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  SessionBroker,
  SessionBrokerError,
  type CompletionEvidence,
  type PositiveTerminalEvidence,
  isStrictPrefixDigest,
} from "../src/session-broker";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(instanceId = "broker-a", now = () => 1_000) {
  const root = mkdtempSync(join(tmpdir(), "cgw-session-broker-"));
  roots.push(root);
  const path = join(root, "broker.sqlite");
  let op = 0;
  let turn = 0;
  const broker = new SessionBroker(path, {
    projectId: "project",
    terminalReplayWindowMs: 60_000,
    instanceId,
    now,
    makeTurnRef: () => `turn-${String.fromCharCode(97 + turn++)}`,
    makeSubmitNonce: () => `nonce-turn-${String.fromCharCode(96 + turn)}`,
    makeOpRef: () => `op_${++op}`,
  });
  return { broker, path };
}

function open(path: string, instanceId: string, now = () => 1_000) {
  let op = 100;
  return new SessionBroker(path, {
    projectId: "project",
    terminalReplayWindowMs: 60_000,
    instanceId,
    now,
    makeOpRef: () => `op_${++op}`,
  });
}

function createSession(broker: SessionBroker, session = "goose-a") {
  return broker.createEpoch({ gooseSessionId: session });
}

function enqueue(broker: SessionBroker, session = "goose-a", expectedTurn = "turn-a", requestHash = "req-a") {
  const turn = broker.enqueueTurn({ gooseSessionId: session, requestHash });
  expect(turn.turnRef).toBe(expectedTurn);
  return turn;
}

function accept(broker: SessionBroker, turn = "turn-a") {
  broker.markSendActivated(turn);
  return broker.markAccepted(turn, `user-${turn}`);
}

function bindConversation(broker: SessionBroker, session = "goose-a", conversation = "conversation-a") {
  return broker.bindConversation({ gooseSessionId: session, epoch: 1, conversationId: conversation });
}

const positiveTerminal: PositiveTerminalEvidence = {
  canonicalConversationId: "conversation-a",
  acceptedUserTurnId: "user-turn-a",
  remoteUiNonRunningAcrossQualifiedSettle: true,
  noUnresolvedGooseWork: true,
  noContradictoryActivity: true,
};

function completionEvidence(opRef: string | null, digest = "digest", watermark = "wm-a"): CompletionEvidence {
  return {
    connectorFinal: "ACKNOWLEDGED",
    canonicalConversationId: "conversation-a",
    acceptedUserTurnId: "user-turn-a",
    noUnresolvedGooseWork: true,
    remoteNonRunning: true,
    observedFinalDigest: digest,
    canonicalHistoryWatermark: watermark,
    answerBoundary: opRef ? { opRef, contentAdvanced: true } : null,
  };
}

test("duplicate logical Responses delivery reuses one broker-owned turn and a different request cannot bypass the live lease", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    const first = enqueue(broker);
    const replay = enqueue(broker);
    expect(replay.turnRef).toBe(first.turnRef);
    const admitted = broker.admitNext();
    expect(admitted?.turn.turnRef).toBe("turn-a");
    expect(broker.admitNext()).toEqual(admitted);

    expect(() => enqueue(broker, "goose-a", "turn-b", "different-request"))
      .toThrow(SessionBrokerError);
  } finally {
    broker.close();
  }
});

test("broker restart retryable-cancels pre-send queue ownership before another session can capture it", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("CANCELLED");
    expect(restarted.getAccountSlotHolder()).toBeNull();
    expect(restarted.admitNext()).toBeNull();

    restarted.createEpoch({ gooseSessionId: "goose-b" });
    const fresh = restarted.enqueueTurn({ gooseSessionId: "goose-b", requestHash: "req-b" });
    expect(restarted.admitNext()?.turn.turnRef).toBe(fresh.turnRef);
    restarted.cancelBeforeSend(fresh.turnRef);

    const retry = restarted.enqueueTurn({ gooseSessionId: "goose-a", requestHash: "req-a" });
    expect(retry.turnRef).not.toBe("turn-a");
    expect(retry.state).toBe("QUEUED");
  } finally {
    restarted.close();
  }
});

test("durable send activation closes the blind-resend window before irreversible submission", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  expect(broker.markSendActivated("turn-a").state).toBe("TURN_OUTSTANDING");
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(restarted.getCurrentEpoch("goose-a")?.leaseState).toBe("UNRECONCILED");
    expect(restarted.getAccountSlotHolder()).toBe("turn-a");
    expect(() => restarted.cancelBeforeSend("turn-a")).toThrow(SessionBrokerError);
  } finally {
    restarted.close();
  }
});

test("accepted remote turn becomes unreconciled on broker restart without releasing lease or slot", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(restarted.getCurrentEpoch("goose-a")?.leaseState).toBe("UNRECONCILED");
    expect(restarted.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    restarted.close();
  }
});

test("restart preserves both post-send slot owners while demoting both turns to unreconciled", () => {
  const { broker, path } = fixture();
  createSession(broker, "goose-a");
  createSession(broker, "goose-b");
  enqueue(broker, "goose-a", "turn-a", "req-a");
  enqueue(broker, "goose-b", "turn-b", "req-b");
  expect(broker.admitNext("turn-a")?.turn.turnRef).toBe("turn-a");
  accept(broker, "turn-a");
  expect(broker.admitNext("turn-b")?.turn.turnRef).toBe("turn-b");
  accept(broker, "turn-b");
  expect(broker.getAccountSlotHolders()).toEqual([
    { slotId: 1, turnRef: "turn-a" },
    { slotId: 2, turnRef: "turn-b" },
  ]);
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(restarted.getTurn("turn-b")?.state).toBe("UNRECONCILED");
    expect(restarted.getAccountSlotHolders()).toEqual([
      { slotId: 1, turnRef: "turn-a" },
      { slotId: 2, turnRef: "turn-b" },
    ]);
    expect(restarted.getActiveAccountSlotCount()).toBe(2);
  } finally {
    restarted.close();
  }
});

test("stale claimed operation becomes UNCERTAIN on restart and never redispatches", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  const admitted = broker.admitNext()!;
  accept(broker);
  bindConversation(broker);
  broker.recordAnswerBoundary("turn-a", admitted.initialOpRef, '{"chars":10}');
  expect(broker.claimOperation({ turnRef: "turn-a", opRef: admitted.initialOpRef, inputHash: "input" }).kind)
    .toBe("EXECUTE");
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getOperation(admitted.initialOpRef)?.state).toBe("UNCERTAIN");
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(restarted.claimOperation({ turnRef: "turn-a", opRef: admitted.initialOpRef, inputHash: "input" }).kind)
      .toBe("UNCERTAIN");
    expect(restarted.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    restarted.close();
  }
});

test("terminal op replay is exact and same ref with different input conflicts", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const admitted = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", admitted.initialOpRef, '{"chars":10}');
    expect(broker.claimOperation({ turnRef: "turn-a", opRef: admitted.initialOpRef, inputHash: "input" }).kind)
      .toBe("EXECUTE");
    const terminal = broker.completeOperation({
      opRef: admitted.initialOpRef,
      inputHash: "input",
      outcome: "SUCCESS",
      resultJson: '{"ok":true}',
    });
    const replay = broker.claimOperation({ turnRef: "turn-a", opRef: admitted.initialOpRef, inputHash: "input" });
    expect(replay).toEqual({
      kind: "REPLAY",
      opRef: admitted.initialOpRef,
      seq: 1,
      outcome: "SUCCESS",
      resultJson: '{"ok":true}',
      nextOpRef: terminal.nextOpRef,
    });
    expect(broker.claimOperation({ turnRef: "turn-a", opRef: admitted.initialOpRef, inputHash: "changed" }).kind)
      .toBe("CONFLICT");
  } finally {
    broker.close();
  }
});

test("answer boundary is durable and required before tool claim", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    expect(broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" }).kind)
      .toBe("BOUNDARY_REQUIRED");
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    expect(broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" }).kind)
      .toBe("EXECUTE");
  } finally {
    broker.close();
  }
});

test("answer boundary requires canonical conversation plus accepted absolute user identity before claim", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    broker.markSendActivated("turn-a");
    expect(() => broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}'))
      .toThrow(SessionBrokerError);
    broker.markAccepted("turn-a", "user-turn-a");
    expect(() => broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}'))
      .toThrow(SessionBrokerError);
    bindConversation(broker);
    expect(broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}').answerBoundaryJson)
      .toBe('{"chars":10}');
    expect(broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" }).kind)
      .toBe("EXECUTE");
  } finally {
    broker.close();
  }
});

test("late terminal reconciliation resolves operation uncertainty and permits ordinary completion reconciliation", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  const { initialOpRef } = broker.admitNext()!;
  accept(broker);
  bindConversation(broker);
  broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
  broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" });
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    restarted.reconcileLateTerminal({
      opRef: initialOpRef,
      inputHash: "input",
      outcome: "SUCCESS",
      resultJson: '{"ok":true}',
    });
    bindConversation(restarted);
    restarted.recordFinalDigest("turn-a", "digest");
    const claim = restarted.beginCompletion("turn-a");
    expect(claim.turnRef).toBe("turn-a");
    expect(restarted.commitCompletion(claim, completionEvidence(initialOpRef)).state).toBe("COMPLETE");
  } finally {
    restarted.close();
  }
});

test("operator-known terminal reconciliation requires post-owner uncertainty and replays exactly", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  const { initialOpRef } = broker.admitNext()!;
  accept(broker);
  bindConversation(broker);
  broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
  broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "known-input" });
  broker.markUnreconciled("turn-a", "known_executed_uncommitted");
  expect(() => broker.reconcileKnownOperationTerminal({
    turnRef: "turn-a", opRef: initialOpRef, inputHash: "known-input", outcome: "SUCCESS", resultJson: '{"ok":true}',
  })).toThrow(SessionBrokerError);
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getOperation(initialOpRef)?.state).toBe("UNCERTAIN");
    expect(() => restarted.reconcileKnownOperationTerminal({
      turnRef: "turn-a", opRef: initialOpRef, inputHash: "wrong-input", outcome: "SUCCESS", resultJson: '{"ok":true}',
    })).toThrow(SessionBrokerError);
    const first = restarted.reconcileKnownOperationTerminal({
      turnRef: "turn-a", opRef: initialOpRef, inputHash: "known-input", outcome: "SUCCESS", resultJson: '{"ok":true}',
    });
    expect(first.operation.state).toBe("SUCCESS");
    const replay = restarted.reconcileKnownOperationTerminal({
      turnRef: "turn-a", opRef: initialOpRef, inputHash: "known-input", outcome: "SUCCESS", resultJson: '{"ok":true}',
    });
    expect(replay.nextOpRef).toBe(first.nextOpRef);
    expect(() => restarted.reconcileKnownOperationTerminal({
      turnRef: "turn-a", opRef: initialOpRef, inputHash: "known-input", outcome: "FAILURE", resultJson: '{"ok":false}',
    })).toThrow(SessionBrokerError);
    expect(restarted.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    restarted.close();
  }
});

test("owned claimed operation quarantine is idempotent and retains the slot until reconciliation", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "known-input" });

    const first = broker.quarantineOwnedOperation({
      turnRef: "turn-a", opRef: initialOpRef, reason: "semantic_progress_stalled",
    });
    expect(first.kind).toBe("QUARANTINED");
    expect(first.operation.state).toBe("UNCERTAIN");
    expect(broker.getTurn("turn-a")).toMatchObject({
      state: "UNRECONCILED", unreconciledReason: "semantic_progress_stalled",
    });
    expect(broker.getAccountSlotHolder()).toBe("turn-a");

    expect(broker.quarantineOwnedOperation({
      turnRef: "turn-a", opRef: initialOpRef, reason: "semantic_progress_stalled",
    }).kind).toBe("ALREADY_UNCERTAIN");
    const terminal = broker.reconcileKnownOperationTerminal({
      turnRef: "turn-a",
      opRef: initialOpRef,
      inputHash: "known-input",
      outcome: "SUCCESS",
      resultJson: '{"ok":true}',
    });
    expect(terminal.operation.state).toBe("SUCCESS");
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("terminal operation commit wins cleanly over a later quarantine attempt", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "known-input" });
    broker.completeOperation({
      opRef: initialOpRef, inputHash: "known-input", outcome: "SUCCESS", resultJson: '{"ok":true}',
    });

    const decision = broker.quarantineOwnedOperation({
      turnRef: "turn-a", opRef: initialOpRef, reason: "late_timeout",
    });
    expect(decision.kind).toBe("TERMINAL");
    expect(decision.operation.state).toBe("SUCCESS");
    expect(broker.getTurn("turn-a")?.state).toBe("TURN_OUTSTANDING");
  } finally {
    broker.close();
  }
});

test("uncertain tool owner keeps its slot while a safe second-slot completion admits the queued turn", () => {
  const { broker } = fixture();
  try {
    createSession(broker, "goose-a");
    createSession(broker, "goose-b");
    createSession(broker, "goose-c");
    enqueue(broker, "goose-a", "turn-a", "req-a");
    enqueue(broker, "goose-b", "turn-b", "req-b");
    enqueue(broker, "goose-c", "turn-c", "req-c");

    const a = broker.admitNext("turn-a")!;
    accept(broker, "turn-a");
    bindConversation(broker, "goose-a", "conversation-a");
    broker.recordAnswerBoundary("turn-a", a.initialOpRef, '{"chars":10}');
    broker.claimOperation({ turnRef: "turn-a", opRef: a.initialOpRef, inputHash: "input-a" });
    broker.quarantineOwnedOperation({ turnRef: "turn-a", opRef: a.initialOpRef, reason: "semantic_progress_stalled" });

    broker.admitNext("turn-b");
    accept(broker, "turn-b");
    bindConversation(broker, "goose-b", "conversation-b");
    expect(broker.admitNext("turn-c")).toBeNull();
    broker.recordFinalDigest("turn-b", "digest-b");
    const claim = broker.beginCompletion("turn-b");
    broker.commitCompletion(claim, {
      connectorFinal: "ACKNOWLEDGED",
      canonicalConversationId: "conversation-b",
      acceptedUserTurnId: "user-turn-b",
      noUnresolvedGooseWork: true,
      remoteNonRunning: true,
      observedFinalDigest: "digest-b",
      canonicalHistoryWatermark: "wm-b",
      answerBoundary: null,
    });

    expect(broker.admitNext("turn-c")?.turn.turnRef).toBe("turn-c");
    expect(broker.getAccountSlotHolders()).toEqual([
      { slotId: 1, turnRef: "turn-a" },
      { slotId: 2, turnRef: "turn-c" },
    ]);
    expect(broker.getOperation(a.initialOpRef)?.state).toBe("UNCERTAIN");
  } finally {
    broker.close();
  }
});

test("timeout or silence alone never releases its slot while the second slot remains independent", () => {
  let now = 1_000;
  const { broker } = fixture("broker-a", () => now);
  try {
    createSession(broker, "goose-a");
    createSession(broker, "goose-b");
    createSession(broker, "goose-c");
    enqueue(broker, "goose-a", "turn-a", "req-a");
    enqueue(broker, "goose-b", "turn-b", "req-b");
    enqueue(broker, "goose-c", "turn-c", "req-c");
    expect(broker.admitNext("turn-a")?.turn.turnRef).toBe("turn-a");
    accept(broker, "turn-a");
    broker.bindConversation({ gooseSessionId: "goose-a", epoch: 1, conversationId: "conversation-a" });
    broker.markUnreconciled("turn-a", "ui_stale");
    expect(broker.admitNext("turn-b")?.turn.turnRef).toBe("turn-b");
    now += 24 * 60 * 60 * 1_000;

    expect(broker.getAccountSlotHolders()).toEqual([
      { slotId: 1, turnRef: "turn-a" },
      { slotId: 2, turnRef: "turn-b" },
    ]);
    expect(broker.admitNext("turn-c")).toBeNull();
    expect(() => broker.releaseSlotAfterPositiveTerminal("turn-a", {
      ...positiveTerminal,
      remoteUiNonRunningAcrossQualifiedSettle: false,
    })).toThrow(SessionBrokerError);

    broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);
    expect(broker.getCurrentEpoch("goose-a")?.leaseState).toBe("UNRECONCILED");
    expect(broker.getAccountSlotHolders()).toEqual([{ slotId: 2, turnRef: "turn-b" }]);
    expect(broker.admitNext("turn-c")?.turn.turnRef).toBe("turn-c");
    expect(broker.getAccountSlotHolders()).toEqual([
      { slotId: 1, turnRef: "turn-c" },
      { slotId: 2, turnRef: "turn-b" },
    ]);
    expect(broker.getCurrentEpoch("goose-a")?.leaseState).toBe("UNRECONCILED");
  } finally {
    broker.close();
  }
});

test("positive-terminal recovery atomically binds a missing orphan identity before slot release", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    broker.markSendActivated("turn-a");
    broker.markUnreconciled("turn-a", "browser_lost_before_identity_capture");

    const released = broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);
    expect(released.acceptedUserTurnId).toBe("user-turn-a");
    expect(broker.getCurrentEpoch("goose-a")?.conversationId).toBe("conversation-a");
    expect(broker.getAccountSlotHolder()).toBeNull();
    expect(broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal).acceptedUserTurnId)
      .toBe("user-turn-a");
  } finally {
    broker.close();
  }
});

test("positive-terminal orphan identity conflict rolls back a partial recovery binding", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    broker.markSendActivated("turn-a");
    broker.markAccepted("turn-a", "different-user-turn");
    broker.markUnreconciled("turn-a", "browser_lost_before_conversation_capture");

    expect(() => broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal))
      .toThrow(SessionBrokerError);
    expect(broker.getCurrentEpoch("goose-a")?.conversationId).toBeNull();
    expect(broker.getTurn("turn-a")?.acceptedUserTurnId).toBe("different-user-turn");
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("positive-terminal recovery checks final-state guards before binding a missing orphan identity", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    broker.markSendActivated("turn-a");
    broker.markUnreconciled("turn-a", "browser_lost_before_identity_capture");
    broker.recordFinalDigest("turn-a", "digest-before-recovery");

    expect(() => broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal))
      .toThrow(SessionBrokerError);
    expect(broker.getCurrentEpoch("goose-a")?.conversationId).toBeNull();
    expect(broker.getTurn("turn-a")?.acceptedUserTurnId).toBeNull();
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("positive-terminal demotion fails while an operation remains unresolved", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" });
    broker.markUnreconciled("turn-a", "transport_lost");
    expect(() => broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal))
      .toThrow(SessionBrokerError);
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("completion CAS is invalidated and cleared by later broker activity", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.recordFinalDigest("turn-a", "digest");
    const claim = broker.beginCompletion("turn-a");
    broker.recordProgress("turn-a");
    expect(broker.getTurn("turn-a")?.completionClaimRevision).toBeNull();
    expect(() => broker.commitCompletion(claim, completionEvidence(null)))
      .toThrow(SessionBrokerError);
    const fresh = broker.beginCompletion("turn-a");
    expect(broker.commitCompletion(fresh, completionEvidence(null)).state).toBe("COMPLETE");
  } finally {
    broker.close();
  }
});

test("completion after tool dispatch must prove content advanced beyond the latest answer boundary", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" });
    broker.completeOperation({ opRef: initialOpRef, inputHash: "input", outcome: "SUCCESS", resultJson: '{"ok":true}' });
    broker.recordFinalDigest("turn-a", "digest");

    const claim = broker.beginCompletion("turn-a");
    expect(() => broker.commitCompletion(claim, completionEvidence(null)))
      .toThrow(SessionBrokerError);
    expect(() => broker.commitCompletion(claim, {
      ...completionEvidence(initialOpRef),
      answerBoundary: { opRef: initialOpRef, contentAdvanced: false },
    })).toThrow(SessionBrokerError);
    expect(broker.commitCompletion(claim, completionEvidence(initialOpRef)).state).toBe("COMPLETE");
  } finally {
    broker.close();
  }
});

test("completion can recover post-tool advancement from the durable boundary text digest", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    const beforeDigest = createHash("sha256").update("before-tool", "utf8").digest("hex");
    const finalDigest = createHash("sha256").update("after-tool final", "utf8").digest("hex");
    broker.recordAnswerBoundary("turn-a", initialOpRef, JSON.stringify({ answerTextSha256: beforeDigest }));
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" });
    broker.completeOperation({ opRef: initialOpRef, inputHash: "input", outcome: "SUCCESS", resultJson: '{"ok":true}' });
    broker.recordFinalDigest("turn-a", finalDigest);
    const claim = broker.beginCompletion("turn-a");
    expect(broker.commitCompletion(claim, {
      ...completionEvidence(initialOpRef, finalDigest),
      answerBoundary: { opRef: initialOpRef, contentAdvanced: false },
    }).state).toBe("COMPLETE");
  } finally {
    broker.close();
  }
});

test("durable boundary digest equality does not falsely prove post-tool advancement", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    const digest = createHash("sha256").update("unchanged", "utf8").digest("hex");
    broker.recordAnswerBoundary("turn-a", initialOpRef, JSON.stringify({ answerTextSha256: digest }));
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" });
    broker.completeOperation({ opRef: initialOpRef, inputHash: "input", outcome: "SUCCESS", resultJson: '{"ok":true}' });
    broker.recordFinalDigest("turn-a", digest);
    const claim = broker.beginCompletion("turn-a");
    expect(() => broker.commitCompletion(claim, {
      ...completionEvidence(initialOpRef, digest),
      answerBoundary: { opRef: initialOpRef, contentAdvanced: false },
    })).toThrow(SessionBrokerError);
  } finally {
    broker.close();
  }
});

test("canonical conversation identity is unique and cannot be rebound to another epoch", () => {
  const { broker } = fixture();
  try {
    createSession(broker, "goose-a");
    createSession(broker, "goose-b");
    broker.bindConversation({ gooseSessionId: "goose-a", epoch: 1, conversationId: "conversation-1" });
    expect(() => broker.bindConversation({ gooseSessionId: "goose-a", epoch: 1, conversationId: "conversation-2" }))
      .toThrow(SessionBrokerError);
    expect(() => broker.bindConversation({ gooseSessionId: "goose-b", epoch: 1, conversationId: "conversation-1" }))
      .toThrow(SessionBrokerError);
  } finally {
    broker.close();
  }
});

test("terminal operation tombstone becomes stale after replay window without becoming executable", () => {
  let now = 1_000;
  const { broker } = fixture("broker-a", () => now);
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" });
    broker.completeOperation({ opRef: initialOpRef, inputHash: "input", outcome: "SUCCESS", resultJson: '{"ok":true}' });
    now += 60_001;
    expect(broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" }).kind)
      .toBe("STALE");
  } finally {
    broker.close();
  }
});

test("duplicate delivery while the same broker owns a claimed operation attaches instead of executing twice", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    expect(broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" }).kind).toBe("EXECUTE");
    expect(broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" }).kind).toBe("ATTACH");
  } finally {
    broker.close();
  }
});

test("orphan recovery may bind the verified accepted user turn exactly once", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  broker.markSendActivated("turn-a");
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.markAccepted("turn-a", "user-verified").acceptedUserTurnId).toBe("user-verified");
    expect(restarted.markAccepted("turn-a", "user-verified").acceptedUserTurnId).toBe("user-verified");
    expect(() => restarted.markAccepted("turn-a", "different-user")).toThrow(SessionBrokerError);
  } finally {
    restarted.close();
  }
});

test("completed turn releases the same epoch for the next append-compatible Goose turn", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker, "goose-a", "turn-a", "req-a");
    broker.admitNext();
    accept(broker, "turn-a");
    bindConversation(broker);
    broker.recordFinalDigest("turn-a", "digest-a");
    const claim = broker.beginCompletion("turn-a");
    broker.commitCompletion(claim, completionEvidence(null, "digest-a"));

    expect(broker.getCurrentEpoch("goose-a")?.epoch).toBe(1);
    expect(broker.getCurrentEpoch("goose-a")?.leaseState).toBe("IDLE");
    expect(broker.getCurrentEpoch("goose-a")?.historyWatermark).toBe("wm-a");
    expect(enqueue(broker, "goose-a", "turn-b", "req-b").epoch).toBe(1);
    expect(broker.admitNext()?.turn.turnRef).toBe("turn-b");
  } finally {
    broker.close();
  }
});

test("positive-terminal slot demotion alone preserves the quarantined lease and blocks epoch rollover", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    broker.bindConversation({ gooseSessionId: "goose-a", epoch: 1, conversationId: "conversation-a" });
    broker.markUnreconciled("turn-a", "stopped_incomplete");
    broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);
    expect(broker.getAccountSlotHolder()).toBeNull();
    expect(broker.getCurrentEpoch("goose-a")?.leaseState).toBe("UNRECONCILED");
    expect(() => broker.createEpoch({ gooseSessionId: "goose-a" })).toThrow(SessionBrokerError);
  } finally {
    broker.close();
  }
});

test("legacy abandoned rows remain readable and terminal across broker restart", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  bindConversation(broker);
  broker.markUnreconciled("turn-a", "legacy_abandoned_pair");
  broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);
  broker.close();

  const legacy = new Database(path, { strict: true });
  try {
    legacy.query("UPDATE turns SET abandoned_at = 1 WHERE turn_ref = 'turn-a'").run();
    legacy.query("UPDATE remote_epochs SET is_current = 0 WHERE goose_session_id = 'goose-a' AND epoch = 1").run();
  } finally {
    legacy.close();
  }

  const restarted = open(path, "broker-legacy-abandoned");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("ABANDONED");
    expect(restarted.getAccountSlotHolder()).toBeNull();
    expect(restarted.getCurrentEpoch("goose-a")).toBeNull();
    expect(restarted.createEpoch({ gooseSessionId: "goose-a" }).epoch).toBe(2);
  } finally {
    restarted.close();
  }
});

test("legacy pre-abandonment schema migrates abandoned_at compatibility without a current abandonment API", () => {
  const { broker, path } = fixture();
  createSession(broker);
  broker.close();

  const legacy = new Database(path, { strict: true });
  try {
    legacy.exec(`DROP INDEX one_open_turn_per_epoch;
      ALTER TABLE turns DROP COLUMN abandoned_at;
      CREATE UNIQUE INDEX one_open_turn_per_epoch ON turns(goose_session_id, epoch)
      WHERE state IN ('QUEUED', 'TURN_OUTSTANDING', 'UNRECONCILED');`);
    const columns = legacy.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
    expect(columns.some(column => column.name === "abandoned_at")).toBe(false);
  } finally {
    legacy.close();
  }

  const restarted = open(path, "broker-schema-migration");
  try {
    const inspect = new Database(path, { strict: true });
    try {
      const columns = inspect.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
      expect(columns.some(column => column.name === "abandoned_at")).toBe(true);
      const indexSql = (inspect.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'one_open_turn_per_epoch'")
        .get() as { sql: string }).sql;
      expect(indexSql).toContain("abandoned_at IS NULL");
    } finally {
      inspect.close();
    }
  } finally {
    restarted.close();
  }
});

test("legacy one-slot broker migrates its outstanding owner into durable slot 1", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  bindConversation(broker);
  broker.close();

  const legacy = new Database(path, { strict: true });
  try {
    legacy.exec(`DROP TABLE account_slots;
      CREATE UNIQUE INDEX one_account_slot_holder ON turns(slot_held) WHERE slot_held = 1;`);
    const holder = legacy.query("SELECT turn_ref FROM turns WHERE slot_held = 1").get() as { turn_ref: string };
    expect(holder.turn_ref).toBe("turn-a");
  } finally {
    legacy.close();
  }

  const restarted = open(path, "broker-legacy-account-slot");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(restarted.getAccountSlotHolders()).toEqual([{ slotId: 1, turnRef: "turn-a" }]);
    expect(restarted.getActiveAccountSlotCount()).toBe(1);

    const inspect = new Database(path, { strict: true });
    try {
      expect(inspect.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'one_account_slot_holder'").get()).toBeNull();
      expect(inspect.query("SELECT turn_ref FROM account_slots WHERE slot_id = 1").get()).toEqual({ turn_ref: "turn-a" });
      expect(inspect.query("SELECT turn_ref FROM account_slots WHERE slot_id = 2").get()).toEqual({ turn_ref: null });
    } finally {
      inspect.close();
    }
  } finally {
    restarted.close();
  }
});

test("restart retires a legacy abandoned epoch that was still marked current", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  bindConversation(broker);
  broker.markUnreconciled("turn-a", "legacy_abandoned_current_epoch");
  broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);
  broker.close();

  const legacy = new Database(path, { strict: true });
  try {
    legacy.query("UPDATE turns SET abandoned_at = 1 WHERE turn_ref = 'turn-a'").run();
    legacy.query("UPDATE remote_epochs SET is_current = 1 WHERE goose_session_id = 'goose-a' AND epoch = 1").run();
  } finally {
    legacy.close();
  }

  const restarted = open(path, "broker-legacy-abandoned-current");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("ABANDONED");
    expect(restarted.getCurrentEpoch("goose-a")).toBeNull();
    expect(restarted.createEpoch({ gooseSessionId: "goose-a" }).epoch).toBe(2);
  } finally {
    restarted.close();
  }
});

test("two independent sessions fill the bounded slots and FIFO refills only the freed slot", () => {
  const { broker } = fixture();
  try {
    for (const session of ["goose-a", "goose-b", "goose-c", "goose-d"]) createSession(broker, session);
    enqueue(broker, "goose-a", "turn-a", "req-a");
    enqueue(broker, "goose-b", "turn-b", "req-b");
    enqueue(broker, "goose-c", "turn-c", "req-c");
    enqueue(broker, "goose-d", "turn-d", "req-d");

    expect(broker.admitNext("turn-a")?.turn.turnRef).toBe("turn-a");
    expect(broker.admitNext("turn-b")?.turn.turnRef).toBe("turn-b");
    expect(broker.getActiveAccountSlotCount()).toBe(2);
    expect(broker.admitNext("turn-d")).toBeNull();

    broker.cancelBeforeSend("turn-a");
    expect(broker.getAccountSlotHolders()).toEqual([{ slotId: 2, turnRef: "turn-b" }]);
    expect(broker.admitNext("turn-d")?.turn.turnRef).toBe("turn-c");
    expect(broker.getAccountSlotHolders()).toEqual([
      { slotId: 1, turnRef: "turn-c" },
      { slotId: 2, turnRef: "turn-b" },
    ]);

    broker.cancelBeforeSend("turn-b");
    expect(broker.admitNext("turn-d")?.turn.turnRef).toBe("turn-d");
    expect(broker.getAccountSlotHolders()).toEqual([
      { slotId: 1, turnRef: "turn-c" },
      { slotId: 2, turnRef: "turn-d" },
    ]);
  } finally {
    broker.close();
  }
});

test("FIFO order survives cancellation and slot handoff across independent sessions", () => {
  const { broker } = fixture();
  try {
    createSession(broker, "goose-a");
    createSession(broker, "goose-b");
    createSession(broker, "goose-c");
    enqueue(broker, "goose-a", "turn-a", "req-a");
    enqueue(broker, "goose-b", "turn-b", "req-b");
    enqueue(broker, "goose-c", "turn-c", "req-c");

    expect(broker.admitNext()?.turn.turnRef).toBe("turn-a");
    broker.cancelBeforeSend("turn-a");
    expect(broker.admitNext()?.turn.turnRef).toBe("turn-b");
    broker.cancelBeforeSend("turn-b");
    expect(broker.admitNext()?.turn.turnRef).toBe("turn-c");
  } finally {
    broker.close();
  }
});

test("accepted final digest is durable before completion and blocks positive-terminal slot demotion after restart", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  broker.bindConversation({ gooseSessionId: "goose-a", epoch: 1, conversationId: "conversation-a" });
  broker.recordFinalDigest("turn-a", "digest-a");
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.finalDigest).toBe("digest-a");
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(() => restarted.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal)).toThrow(SessionBrokerError);
    expect(restarted.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    restarted.close();
  }
});

test("accepted final recovery verifies the same remote pair without resuming it as running", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  bindConversation(broker);
  broker.recordFinalDigest("turn-a", "digest-a");
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(() => restarted.verifyFinalRecoveryRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "wrong-conversation",
      acceptedUserTurnId: "user-turn-a",
      remoteIdentityVerified: true,
    })).toThrow(SessionBrokerError);
    const verified = restarted.verifyFinalRecoveryRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "conversation-a",
      acceptedUserTurnId: "user-turn-a",
      remoteIdentityVerified: true,
    });
    expect(verified).toMatchObject({ state: "UNRECONCILED", finalDigest: "digest-a" });
    expect(restarted.getAccountSlotHolder()).toBe("turn-a");
    expect(() => restarted.rebindVerifiedRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "conversation-a",
      acceptedUserTurnId: "user-turn-a",
      remoteIdentityVerified: true,
    })).toThrow(SessionBrokerError);
    const claim = restarted.beginCompletion("turn-a");
    expect(restarted.commitCompletion(claim, completionEvidence(null, "digest-a")).state).toBe("COMPLETE");
  } finally {
    restarted.close();
  }
});

test("final digest acknowledgement is idempotent but conflicting final evidence fails closed", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    expect(broker.recordFinalDigest("turn-a", "digest-a").finalDigest).toBe("digest-a");
    expect(broker.recordFinalDigest("turn-a", "digest-a").finalDigest).toBe("digest-a");
    expect(() => broker.recordFinalDigest("turn-a", "digest-b")).toThrow(SessionBrokerError);
  } finally {
    broker.close();
  }
});

test("completion cannot begin until final digest evidence is durably recorded", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    expect(() => broker.beginCompletion("turn-a")).toThrow(SessionBrokerError);
    broker.recordFinalDigest("turn-a", "digest");
    expect(broker.beginCompletion("turn-a").turnRef).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("fresh side-effecting operation after accepted final digest escalates without execution", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "first" });
    const { nextOpRef } = broker.completeOperation({
      opRef: initialOpRef,
      inputHash: "first",
      outcome: "SUCCESS",
      resultJson: '{"ok":true}',
    });
    broker.recordFinalDigest("turn-a", "digest");
    broker.recordAnswerBoundary("turn-a", nextOpRef, '{"chars":20}');

    expect(broker.claimOperation({ turnRef: "turn-a", opRef: nextOpRef, inputHash: "late-fresh" }).kind)
      .toBe("PROTOCOL_VIOLATION");
    expect(broker.getOperation(nextOpRef)?.state).toBe("MINTED");
    expect(broker.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("terminal operation committed before caller loss replays exactly after broker restart", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  const { initialOpRef } = broker.admitNext()!;
  accept(broker);
  bindConversation(broker);
  broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
  broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" });
  const terminal = broker.completeOperation({
    opRef: initialOpRef,
    inputHash: "input",
    outcome: "SUCCESS",
    resultJson: '{"effect":1}',
  });
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(restarted.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "input" })).toEqual({
      kind: "REPLAY",
      opRef: initialOpRef,
      seq: 1,
      outcome: "SUCCESS",
      resultJson: '{"effect":1}',
      nextOpRef: terminal.nextOpRef,
    });
  } finally {
    restarted.close();
  }
});

test("completed turn remains terminal across restart and logical request replay", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  bindConversation(broker);
  broker.recordFinalDigest("turn-a", "digest");
  const claim = broker.beginCompletion("turn-a");
  broker.commitCompletion(claim, completionEvidence(null));
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("COMPLETE");
    expect(restarted.getCurrentEpoch("goose-a")?.leaseState).toBe("IDLE");
    expect(restarted.getAccountSlotHolder()).toBeNull();
    expect(enqueue(restarted).state).toBe("COMPLETE");
  } finally {
    restarted.close();
  }
});

test("completion claim is invalidated on restart but durable final evidence remains reconcilable", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  bindConversation(broker);
  broker.recordFinalDigest("turn-a", "digest");
  const staleClaim = broker.beginCompletion("turn-a");
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    const turn = restarted.getTurn("turn-a");
    expect(turn?.state).toBe("UNRECONCILED");
    expect(turn?.completionClaimRevision).toBeNull();
    expect(turn?.finalDigest).toBe("digest");
    expect(() => restarted.commitCompletion(staleClaim, completionEvidence(null))).toThrow(SessionBrokerError);
    const fresh = restarted.beginCompletion("turn-a");
    expect(restarted.commitCompletion(fresh, completionEvidence(null)).state).toBe("COMPLETE");
  } finally {
    restarted.close();
  }
});

test("SQLite rejects a second open turn per epoch and impossible journal field combinations", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  broker.close();

  const db = new Database(path, { strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    expect(() => db.query(`INSERT INTO turns(
      turn_ref, goose_session_id, epoch, request_hash, submit_nonce, state, revision, created_at, updated_at
    ) VALUES ('turn-second', 'goose-a', 1, 'req-second', 'nonce-second', 'QUEUED', 0, 1, 1)`).run())
      .toThrow();
    expect(() => db.query(`UPDATE operations SET state = 'CLAIMED', input_hash = 'input', owner_id = 'owner'
      WHERE turn_ref = 'turn-a' AND seq = 1`).run()).toThrow();
    expect(() => db.query("UPDATE operations SET state = 'SUCCESS' WHERE turn_ref = 'turn-a' AND seq = 1").run())
      .toThrow();
  } finally {
    db.close();
  }
});

test("positive-terminal release does not hide a missing account-slot invariant", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  broker.bindConversation({ gooseSessionId: "goose-a", epoch: 1, conversationId: "conversation-a" });
  broker.markUnreconciled("turn-a", "ui_stale");
  broker.close();

  const db = new Database(path, { strict: true });
  db.query("UPDATE account_slots SET turn_ref = NULL WHERE turn_ref = 'turn-a'").run();
  db.query("UPDATE turns SET slot_held = 0 WHERE turn_ref = 'turn-a'").run();
  db.close();

  const restarted = open(path, "broker-b");
  try {
    expect(() => restarted.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal))
      .toThrow(SessionBrokerError);
  } finally {
    restarted.close();
  }
});

test("positive-terminal slot demotion is idempotent only after its evidence is durable", () => {
  const { broker } = fixture();
  try {
    createSession(broker, "goose-a");
    createSession(broker, "goose-b");
    enqueue(broker, "goose-a", "turn-a", "req-a");
    enqueue(broker, "goose-b", "turn-b", "req-b");
    broker.admitNext();
    accept(broker, "turn-a");
    broker.bindConversation({ gooseSessionId: "goose-a", epoch: 1, conversationId: "conversation-a" });
    broker.markUnreconciled("turn-a", "ui_stale");
    broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);
    expect(broker.admitNext()?.turn.turnRef).toBe("turn-b");
    expect(broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal).state).toBe("UNRECONCILED");
    expect(broker.getAccountSlotHolder()).toBe("turn-b");
  } finally {
    broker.close();
  }
});

test("only one live broker instance may own a database at a time", () => {
  const { broker, path } = fixture();
  try {
    createSession(broker);
    expect(() => open(path, "broker-b")).toThrow();
  } finally {
    broker.close();
  }

  const restarted = open(path, "broker-b");
  restarted.close();
});

test("dead broker owner is safely taken over before restart reconciliation", () => {
  const { broker, path } = fixture();
  createSession(broker);
  broker.close();

  const db = new Database(path, { strict: true });
  db.query("UPDATE broker_owner SET owner_id = 'dead-owner', pid = 2147483647 WHERE singleton = 1").run();
  db.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getCurrentEpoch("goose-a")?.epoch).toBe(1);
  } finally {
    restarted.close();
  }
});

test("positive-terminal demotion rejects mismatched durable conversation or user-turn identity", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    broker.bindConversation({ gooseSessionId: "goose-a", epoch: 1, conversationId: "conversation-a" });
    broker.markUnreconciled("turn-a", "ui_stale");
    expect(() => broker.releaseSlotAfterPositiveTerminal("turn-a", {
      ...positiveTerminal,
      canonicalConversationId: "wrong-conversation",
    })).toThrow(SessionBrokerError);
    expect(() => broker.releaseSlotAfterPositiveTerminal("turn-a", {
      ...positiveTerminal,
      acceptedUserTurnId: "wrong-user-turn",
    })).toThrow(SessionBrokerError);
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("completion compares observed final digest to the durable final instead of trusting a boolean", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.recordFinalDigest("turn-a", "digest");
    const claim = broker.beginCompletion("turn-a");
    expect(() => broker.commitCompletion(claim, completionEvidence(null, "wrong-digest"))).toThrow(SessionBrokerError);
    expect(broker.commitCompletion(claim, completionEvidence(null, "digest")).state).toBe("COMPLETE");
  } finally {
    broker.close();
  }
});

test("completion rejects mismatched canonical conversation or absolute user-turn identity", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.recordFinalDigest("turn-a", "digest");
    const claim = broker.beginCompletion("turn-a");
    expect(() => broker.commitCompletion(claim, {
      ...completionEvidence(null),
      canonicalConversationId: "wrong-conversation",
    })).toThrow(SessionBrokerError);
    expect(() => broker.commitCompletion(claim, {
      ...completionEvidence(null),
      acceptedUserTurnId: "wrong-user-turn",
    })).toThrow(SessionBrokerError);
    expect(broker.commitCompletion(claim, completionEvidence(null)).state).toBe("COMPLETE");
  } finally {
    broker.close();
  }
});

test("checkpoint progress is durable and invalidates an in-flight completion claim", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  bindConversation(broker);
  broker.recordFinalDigest("turn-a", "digest");
  broker.beginCompletion("turn-a");
  expect(broker.recordProgress("turn-a", '{"cursor":7}').completionClaimRevision).toBeNull();
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.checkpointJson).toBe('{"cursor":7}');
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
  } finally {
    restarted.close();
  }
});

test("SQLite enforces two durable slot identities, unique owners, and globally unique submit nonce", () => {
  const { broker, path } = fixture();
  createSession(broker, "goose-a");
  createSession(broker, "goose-b");
  enqueue(broker, "goose-a", "turn-a", "req-a");
  enqueue(broker, "goose-b", "turn-b", "req-b");
  broker.close();

  const db = new Database(path, { strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.query("UPDATE account_slots SET turn_ref = 'turn-a' WHERE slot_id = 1").run();
    db.query("UPDATE account_slots SET turn_ref = 'turn-b' WHERE slot_id = 2").run();
    expect(() => db.query("INSERT INTO account_slots(slot_id, turn_ref, updated_at) VALUES (1, NULL, 1)").run()).toThrow();
    expect(() => db.query("UPDATE account_slots SET turn_ref = 'turn-a' WHERE slot_id = 2").run()).toThrow();
    expect(() => db.query("INSERT INTO account_slots(slot_id, turn_ref, updated_at) VALUES (3, NULL, 1)").run()).toThrow();
    expect(() => db.query(`INSERT INTO turns(
      turn_ref, goose_session_id, epoch, request_hash, submit_nonce, state, revision, created_at, updated_at
    ) VALUES ('turn-collision', 'goose-b', 1, 'req-collision', 'nonce-turn-a', 'CANCELLED', 0, 1, 1)`).run()).toThrow();
  } finally {
    db.close();
  }
});

test("Responses transport replay remains idempotent even after the session rolls to a new epoch", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    const first = enqueue(broker, "goose-a", "turn-a", "req-a");
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.recordFinalDigest("turn-a", "digest");
    const claim = broker.beginCompletion("turn-a");
    broker.commitCompletion(claim, completionEvidence(null));
    expect(broker.createEpoch({ gooseSessionId: "goose-a" }).epoch).toBe(2);

    const replay = broker.enqueueTurn({ gooseSessionId: "goose-a", requestHash: "req-a" });
    expect(replay.turnRef).toBe(first.turnRef);
    expect(replay.epoch).toBe(1);
    expect(replay.state).toBe("COMPLETE");
    expect(broker.enqueueTurn({ gooseSessionId: "goose-a", requestHash: "req-b" }).epoch).toBe(2);
  } finally {
    broker.close();
  }
});

test("ticketless side effect is never executable and matching recent journal input is suspected redelivery", () => {
  let now = 1_000;
  const { broker } = fixture("broker-a", () => now);
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "same-input" });
    expect(broker.classifyMissingOperationRef("turn-a", "same-input")).toEqual({
      kind: "UNCERTAIN",
      matchingOpRefs: [initialOpRef],
    });
    expect(broker.classifyMissingOperationRef("turn-a", "different-input")).toEqual({ kind: "INVALID" });

    broker.completeOperation({
      opRef: initialOpRef,
      inputHash: "same-input",
      outcome: "SUCCESS",
      resultJson: '{"ok":true}',
    });
    expect(broker.classifyMissingOperationRef("turn-a", "same-input").kind).toBe("UNCERTAIN");
    now += 60_001;
    expect(broker.classifyMissingOperationRef("turn-a", "same-input")).toEqual({ kind: "INVALID" });
  } finally {
    broker.close();
  }
});

test("ticketless side effect after accepted final is a protocol violation and escalates", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.recordFinalDigest("turn-a", "digest");
    expect(broker.classifyMissingOperationRef("turn-a", "fresh-input")).toEqual({ kind: "PROTOCOL_VIOLATION" });
    expect(broker.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("completion cannot begin until canonical conversation identity is bound", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    broker.recordFinalDigest("turn-a", "digest");
    expect(() => broker.beginCompletion("turn-a")).toThrow(SessionBrokerError);
    bindConversation(broker);
    expect(broker.beginCompletion("turn-a").turnRef).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("completion atomically advances the epoch canonical-history watermark", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.recordFinalDigest("turn-a", "digest");
    const claim = broker.beginCompletion("turn-a");
    broker.commitCompletion(claim, completionEvidence(null, "digest", "canonical-projection-v1"));
    expect(broker.getCurrentEpoch("goose-a")?.historyWatermark).toBe("canonical-projection-v1");
  } finally {
    broker.close();
  }
});

test("broker construction fails closed without the dedicated provider project identity", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-session-broker-project-"));
  roots.push(root);
  expect(() => new SessionBroker(join(root, "broker.sqlite"), {
    projectId: "",
    terminalReplayWindowMs: 60_000,
  })).toThrow(SessionBrokerError);
});

test("matching configured Project may reopen persisted broker state", () => {
  const { broker, path } = fixture();
  createSession(broker);
  broker.close();

  const restarted = open(path, "broker-project-match");
  try {
    expect(restarted.getCurrentEpoch("goose-a")?.projectId).toBe("project");
  } finally {
    restarted.close();
  }
});

test("mismatched configured Project fails before schema migration and does not strand broker ownership", () => {
  const { broker, path } = fixture();
  createSession(broker);
  broker.close();

  const legacy = new Database(path, { strict: true });
  try {
    legacy.exec(`DROP INDEX one_open_turn_per_epoch;
      ALTER TABLE turns DROP COLUMN abandoned_at;
      CREATE UNIQUE INDEX one_open_turn_per_epoch ON turns(goose_session_id, epoch)
      WHERE state IN ('QUEUED', 'TURN_OUTSTANDING', 'UNRECONCILED');`);
  } finally {
    legacy.close();
  }

  let failure: unknown;
  try {
    new SessionBroker(path, {
      projectId: "different-project",
      terminalReplayWindowMs: 60_000,
      instanceId: "broker-project-mismatch",
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SessionBrokerError);
  expect((failure as SessionBrokerError).code).toBe("PROJECT_MISMATCH");

  const inspect = new Database(path, { strict: true });
  try {
    expect(inspect.query("SELECT owner_id, pid FROM broker_owner WHERE singleton = 1").get())
      .toEqual({ owner_id: null, pid: null });
    const columns = inspect.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
    expect(columns.some(column => column.name === "abandoned_at")).toBe(false);
    const indexSql = (inspect.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'one_open_turn_per_epoch'")
      .get() as { sql: string }).sql;
    expect(indexSql).not.toContain("abandoned_at IS NULL");
  } finally {
    inspect.close();
  }

  const restarted = open(path, "broker-project-correct-after-mismatch");
  try {
    const migrated = new Database(path, { strict: true });
    try {
      const columns = migrated.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
      expect(columns.some(column => column.name === "abandoned_at")).toBe(true);
    } finally {
      migrated.close();
    }
  } finally {
    restarted.close();
  }
});

test("a separate live process cannot take over the broker database", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-session-broker-process-"));
  roots.push(root);
  const path = join(root, "broker.sqlite");
  const ready = join(root, "ready");
  const source = join(process.cwd(), "src/session-broker.ts");
  const childCode = `
    import { writeFileSync } from "node:fs";
    import { SessionBroker } from ${JSON.stringify(source)};
    const broker = new SessionBroker(process.argv[1], { projectId: "project", terminalReplayWindowMs: 60000, instanceId: "child-owner" });
    writeFileSync(process.argv[2], "ready");
    await Bun.sleep(30000);
    broker.close();
  `;
  const child = Bun.spawn([process.execPath, "-e", childCode, path, ready], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    if (!existsSync(ready)) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`child broker did not acquire ownership: ${stderr}`);
    }
    expect(() => new SessionBroker(path, {
      projectId: "project",
      terminalReplayWindowMs: 60_000,
      instanceId: "parent-contender",
    })).toThrow(SessionBrokerError);
  } finally {
    child.kill();
    await child.exited;
  }

  const takeover = new SessionBroker(path, {
    projectId: "project",
    terminalReplayWindowMs: 60_000,
    instanceId: "parent-after-child-exit",
  });
  takeover.close();
});

test("conflicting op_ref input after accepted final escalates as protocol violation without execution", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    broker.claimOperation({ turnRef: "turn-a", opRef: initialOpRef, inputHash: "original-input" });
    broker.completeOperation({
      opRef: initialOpRef,
      inputHash: "original-input",
      outcome: "SUCCESS",
      resultJson: '{"ok":true}',
    });
    broker.recordFinalDigest("turn-a", "digest");

    expect(broker.claimOperation({
      turnRef: "turn-a",
      opRef: initialOpRef,
      inputHash: "different-input",
    })).toEqual({ kind: "PROTOCOL_VIOLATION", opRef: initialOpRef, seq: 1 });
    expect(broker.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
    expect(broker.getOperation(initialOpRef)?.resultJson).toBe('{"ok":true}');
  } finally {
    broker.close();
  }
});

test("boundary-bearing MINTED op stays non-executed until exact running-turn recovery is verified", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  const { initialOpRef } = broker.admitNext()!;
  accept(broker);
  bindConversation(broker);
  broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
  expect(broker.getOperation(initialOpRef)?.state).toBe("MINTED");
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(restarted.getOperation(initialOpRef)?.state).toBe("MINTED");
    expect(restarted.claimOperation({
      turnRef: "turn-a",
      opRef: initialOpRef,
      inputHash: "input",
    })).toEqual({ kind: "UNCERTAIN", opRef: initialOpRef, seq: 1 });
    expect(restarted.getOperation(initialOpRef)?.state).toBe("MINTED");

    expect(() => restarted.rebindVerifiedRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "wrong-conversation",
      acceptedUserTurnId: "user-turn-a",
      remoteIdentityVerified: true,
    })).toThrow(SessionBrokerError);
    expect(restarted.rebindVerifiedRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "conversation-a",
      acceptedUserTurnId: "user-turn-a",
      remoteIdentityVerified: true,
    }).state).toBe("TURN_OUTSTANDING");
    expect(restarted.claimOperation({
      turnRef: "turn-a",
      opRef: initialOpRef,
      inputHash: "input",
    })).toEqual({ kind: "EXECUTE", opRef: initialOpRef, seq: 1 });
  } finally {
    restarted.close();
  }
});

test("an older request fingerprint may become a new logical turn after intervening canonical activity", () => {
  const { broker } = fixture();
  try {
    createSession(broker);

    enqueue(broker, "goose-a", "turn-a", "req-a");
    broker.admitNext();
    accept(broker, "turn-a");
    bindConversation(broker);
    broker.recordFinalDigest("turn-a", "digest-a");
    broker.commitCompletion(broker.beginCompletion("turn-a"), completionEvidence(null, "digest-a", "wm-a"));

    enqueue(broker, "goose-a", "turn-b", "req-b");
    broker.admitNext();
    accept(broker, "turn-b");
    broker.recordFinalDigest("turn-b", "digest-b");
    broker.commitCompletion(broker.beginCompletion("turn-b"), {
      ...completionEvidence(null, "digest-b", "wm-b"),
      acceptedUserTurnId: "user-turn-b",
    });

    const repeated = broker.enqueueTurn({ gooseSessionId: "goose-a", requestHash: "req-a" });
    expect(repeated.turnRef).toBe("turn-c");
    expect(repeated.requestHash).toBe("req-a");
    expect(repeated.state).toBe("QUEUED");
  } finally {
    broker.close();
  }
});

test("verified rebind may bind one missing post-send accepted-user identity without replacing it later", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    broker.markSendActivated("turn-a");
    bindConversation(broker);
    broker.markUnreconciled("turn-a", "browser_lost_before_local_acceptance_binding");
    expect(broker.getTurn("turn-a")).toMatchObject({ state: "UNRECONCILED", acceptedUserTurnId: null });

    const rebound = broker.rebindVerifiedRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "conversation-a",
      acceptedUserTurnId: "user-recovered",
      remoteIdentityVerified: true,
    });
    expect(rebound).toMatchObject({ state: "TURN_OUTSTANDING", acceptedUserTurnId: "user-recovered" });
    expect(() => broker.rebindVerifiedRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "conversation-a",
      acceptedUserTurnId: "user-different",
      remoteIdentityVerified: true,
    })).toThrow(SessionBrokerError);
  } finally {
    broker.close();
  }
});

test("verified persistent-pair rebind enforces remote identity and remains idempotent", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.markUnreconciled("turn-a", "transport_lost");

    expect(() => broker.rebindVerifiedRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "conversation-a",
      acceptedUserTurnId: "user-turn-a",
      remoteIdentityVerified: false as true,
    })).toThrow(SessionBrokerError);

    expect(broker.rebindVerifiedRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "conversation-a",
      acceptedUserTurnId: "user-turn-a",
      remoteIdentityVerified: true,
    }).state).toBe("TURN_OUTSTANDING");

    expect(() => broker.rebindVerifiedRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "wrong-conversation",
      acceptedUserTurnId: "user-turn-a",
      remoteIdentityVerified: true,
    })).toThrow(SessionBrokerError);
  } finally {
    broker.close();
  }
});

test("boundary-bearing MINTED work blocks completion and positive-terminal slot demotion until resolved", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    const { initialOpRef } = broker.admitNext()!;
    accept(broker);
    bindConversation(broker);
    broker.recordAnswerBoundary("turn-a", initialOpRef, '{"chars":10}');
    broker.recordFinalDigest("turn-a", "digest");

    expect(() => broker.beginCompletion("turn-a")).toThrow(SessionBrokerError);
    broker.markUnreconciled("turn-a", "stopped_incomplete");
    expect(() => broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal)).toThrow(SessionBrokerError);
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
    expect(broker.getOperation(initialOpRef)?.state).toBe("MINTED");
  } finally {
    broker.close();
  }
});

test("unknown op_ref after accepted final is a protocol violation and escalates", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.recordFinalDigest("turn-a", "digest");

    expect(broker.claimOperation({
      turnRef: "turn-a",
      opRef: "unminted-op",
      inputHash: "fresh-input",
    })).toEqual({ kind: "PROTOCOL_VIOLATION", opRef: "unminted-op", seq: null });
    expect(broker.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    broker.close();
  }
});

test("positive-terminal slot demotion replays only the exact durable evidence", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.markUnreconciled("turn-a", "ui_stale");
    broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);
    expect(broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal).state).toBe("UNRECONCILED");
    expect(() => broker.releaseSlotAfterPositiveTerminal("turn-a", {
      ...positiveTerminal,
      noContradictoryActivity: false,
    })).toThrow(SessionBrokerError);
  } finally {
    broker.close();
  }
});

test("constructor recovery failure does not leave its own live broker-ownership lock", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  bindConversation(broker);
  broker.recordFinalDigest("turn-a", "digest");
  broker.commitCompletion(broker.beginCompletion("turn-a"), completionEvidence(null));
  broker.close();

  const corrupt = new Database(path, { strict: true });
  corrupt.query(`UPDATE operations SET state = 'CLAIMED', input_hash = 'corrupt', owner_id = 'dead-owner',
    answer_boundary_json = '{"chars":1}' WHERE turn_ref = 'turn-a' AND seq = 1`).run();
  corrupt.close();

  let failure: unknown;
  try {
    open(path, "broker-recovery-fails");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SessionBrokerError);
  expect((failure as SessionBrokerError).code).toBe("JOURNAL_CORRUPT");

  const inspect = new Database(path, { strict: true });
  try {
    expect(inspect.query("SELECT owner_id, pid FROM broker_owner WHERE singleton = 1").get())
      .toEqual({ owner_id: null, pid: null });
  } finally {
    inspect.close();
  }
});

test("initial Responses projection checkpoint is atomic and older transport replay cannot rewind later progress", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    const turn = broker.enqueueTurn({ gooseSessionId: "goose-a", requestHash: "req-a", checkpointJson: '{"projection":"initial"}' });
    expect(turn.checkpointJson).toBe('{"projection":"initial"}');
    broker.admitNext();
    accept(broker);
    broker.recordProgress(turn.turnRef, '{"projection":"advanced"}');

    const replay = broker.enqueueTurn({
      gooseSessionId: "goose-a",
      requestHash: "req-a",
      checkpointJson: '{"projection":"initial"}',
    });
    expect(replay.turnRef).toBe(turn.turnRef);
    expect(replay.checkpointJson).toBe('{"projection":"advanced"}');
    expect(broker.getTurn(turn.turnRef)?.checkpointJson).toBe('{"projection":"advanced"}');
  } finally {
    broker.close();
  }
});

test("atomic tool progress plus terminal commit rolls back checkpoint and claim if next op mint fails", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-session-broker-atomic-tool-"));
  roots.push(root);
  const broker = new SessionBroker(join(root, "broker.sqlite"), {
    projectId: "project",
    terminalReplayWindowMs: 60_000,
    instanceId: "atomic-tool-broker",
    now: () => 1_000,
    makeTurnRef: () => "turn-atomic",
    makeSubmitNonce: () => "nonce-atomic",
    // The initial mint succeeds; the terminal transition's next-op mint collides and must roll back
    // every write in the surrounding transaction, including the proposed projection checkpoint.
    makeOpRef: () => "op_same",
  });
  try {
    broker.createEpoch({ gooseSessionId: "goose-atomic" });
    const initialCheckpoint = '{"projection":"initial"}';
    const turn = broker.enqueueTurn({ gooseSessionId: "goose-atomic", requestHash: "req-atomic", checkpointJson: initialCheckpoint });
    const admitted = broker.admitNext()!;
    broker.markSendActivated(turn.turnRef);
    broker.markAccepted(turn.turnRef, "user-atomic");
    broker.bindConversation({ gooseSessionId: "goose-atomic", epoch: 1, conversationId: "conversation-atomic" });
    broker.recordAnswerBoundary(turn.turnRef, admitted.initialOpRef, '{"boundary":"stable"}');
    expect(broker.claimOperation({ turnRef: turn.turnRef, opRef: admitted.initialOpRef, inputHash: "input-atomic" }).kind).toBe("EXECUTE");

    expect(() => broker.completeOperationWithProgress({
      turnRef: turn.turnRef,
      opRef: admitted.initialOpRef,
      inputHash: "input-atomic",
      outcome: "SUCCESS",
      resultJson: '{"ok":true}',
      checkpointJson: '{"projection":"advanced"}',
    })).toThrow();

    expect(broker.getTurn(turn.turnRef)?.checkpointJson).toBe(initialCheckpoint);
    expect(broker.getOperation(admitted.initialOpRef)?.state).toBe("CLAIMED");
    expect(broker.getOperation(admitted.initialOpRef)?.resultJson).toBeNull();
  } finally {
    broker.close();
  }
});

test("retryable pre-send cancellation frees an unowned or held queue entry and exact replay creates a fresh attempt", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    const first = enqueue(broker);
    expect(broker.getAccountSlotHolder()).toBeNull();
    expect(broker.cancelRetryableBeforeSend(first.turnRef).state).toBe("CANCELLED");
    expect(broker.getAccountSlotHolder()).toBeNull();

    const second = broker.enqueueTurn({ gooseSessionId: "goose-a", requestHash: "req-a" });
    expect(second.turnRef).toBe("turn-b");
    expect(broker.admitNext()?.turn.turnRef).toBe("turn-b");
    expect(broker.cancelRetryableBeforeSend("turn-b").state).toBe("CANCELLED");
    expect(broker.getAccountSlotHolder()).toBeNull();

    const third = broker.enqueueTurn({ gooseSessionId: "goose-a", requestHash: "req-a" });
    expect(third.turnRef).toBe("turn-c");
  } finally {
    broker.close();
  }
});

test("ordinary pre-send cancellation remains terminal for exact request replay", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    const first = enqueue(broker);
    broker.admitNext();
    broker.cancelBeforeSend(first.turnRef);
    const replay = broker.enqueueTurn({ gooseSessionId: "goose-a", requestHash: "req-a" });
    expect(replay.turnRef).toBe(first.turnRef);
    expect(replay.state).toBe("CANCELLED");
  } finally {
    broker.close();
  }
});

test("serial tool work is never pre-rejected by a local conversation-growth budget", () => {
  const { broker } = fixture();
  try {
    broker.createEpoch({ gooseSessionId: "uncapped-tools" });
    const turn = broker.enqueueTurn({ gooseSessionId: "uncapped-tools", requestHash: "uncapped-request" });
    let opRef = broker.admitNext()!.initialOpRef;
    broker.markSendActivated(turn.turnRef);
    broker.bindConversation({
      gooseSessionId: "uncapped-tools", epoch: 1, conversationId: "uncapped-conversation",
    });
    broker.markAccepted(turn.turnRef, "uncapped-user");

    for (let index = 0; index < 12; index += 1) {
      broker.recordAnswerBoundary(turn.turnRef, opRef, JSON.stringify({ chars: index + 1 }));
      expect(broker.claimOperation({
        turnRef: turn.turnRef, opRef, inputHash: `hash-${index}`,
      })).toMatchObject({ kind: "EXECUTE" });
      const terminal = broker.completeOperation({
        opRef, inputHash: `hash-${index}`, outcome: "SUCCESS",
        resultJson: JSON.stringify({ output: "x".repeat(40_000) }),
      });
      opRef = terminal.nextOpRef;
    }

    expect(broker.getTurn(turn.turnRef)).toMatchObject({
      state: "TURN_OUTSTANDING", budgetReservedTokens: null,
      budgetPromptTokens: null, budgetGrowthConsumedTokens: null,
    });
  } finally {
    broker.close();
  }
});

test("positive-terminal slot quarantine can reacquire capacity and rebind the same persistent pair", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.markUnreconciled("turn-a", "qualified_terminal_slot_quarantine");

    broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);
    expect(broker.getAccountSlotHolder()).toBeNull();
    expect(broker.getCurrentEpoch("goose-a")).toMatchObject({
      epoch: 1,
      conversationId: "conversation-a",
      leaseState: "UNRECONCILED",
      leaseTurnRef: "turn-a",
    });

    const reacquired = broker.reacquireReleasedSlotForRebind("turn-a");
    expect(reacquired).toMatchObject({
      turnRef: "turn-a",
      state: "UNRECONCILED",
      acceptedUserTurnId: "user-turn-a",
    });
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
    expect(broker.rebindVerifiedRemoteTurn({
      turnRef: "turn-a",
      canonicalConversationId: "conversation-a",
      acceptedUserTurnId: "user-turn-a",
      remoteIdentityVerified: true,
    }).state).toBe("TURN_OUTSTANDING");
    expect(broker.hasRecordedPositiveTerminalSlotRelease("turn-a")).toBeFalse();
    expect(broker.getCurrentEpoch("goose-a")).toMatchObject({
      epoch: 1,
      conversationId: "conversation-a",
      leaseState: "TURN_OUTSTANDING",
      leaseTurnRef: "turn-a",
    });
  } finally {
    broker.close();
  }
});

test("failed pre-rebind attachment can restore the prior positive-terminal slot release", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    broker.markUnreconciled("turn-a", "qualified_terminal_slot_quarantine");
    broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);

    expect(broker.reacquireReleasedSlotForRebind("turn-a")?.state).toBe("UNRECONCILED");
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
    const restored = broker.restorePositiveTerminalSlotRelease("turn-a");
    expect(restored).toMatchObject({ state: "UNRECONCILED", acceptedUserTurnId: "user-turn-a" });
    expect(broker.getAccountSlotHolder()).toBeNull();
    expect(broker.hasRecordedPositiveTerminalSlotRelease("turn-a")).toBeTrue();
  } finally {
    broker.close();
  }
});

test("slot-quarantined pair waits when both bounded account slots are occupied", () => {
  const { broker } = fixture();
  try {
    createSession(broker, "goose-a");
    createSession(broker, "goose-b");
    createSession(broker, "goose-c");
    enqueue(broker, "goose-a", "turn-a", "req-a");
    broker.admitNext("turn-a");
    accept(broker, "turn-a");
    bindConversation(broker, "goose-a", "conversation-a");
    broker.markUnreconciled("turn-a", "qualified_terminal_slot_quarantine");
    broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);

    enqueue(broker, "goose-b", "turn-b", "req-b");
    enqueue(broker, "goose-c", "turn-c", "req-c");
    expect(broker.admitNext("turn-b")?.turn.turnRef).toBe("turn-b");
    expect(broker.admitNext("turn-c")?.turn.turnRef).toBe("turn-c");
    expect(broker.reacquireReleasedSlotForRebind("turn-a")).toBeNull();
    expect(broker.getCurrentEpoch("goose-a")).toMatchObject({
      conversationId: "conversation-a", leaseState: "UNRECONCILED", leaseTurnRef: "turn-a",
    });
  } finally {
    broker.close();
  }
});

test("positive-terminal slot quarantine survives broker restart and remains rebindable", () => {
  const { broker, path } = fixture();
  createSession(broker);
  enqueue(broker);
  broker.admitNext();
  accept(broker);
  bindConversation(broker);
  broker.markUnreconciled("turn-a", "qualified_terminal_slot_quarantine");
  broker.releaseSlotAfterPositiveTerminal("turn-a", positiveTerminal);
  broker.close();

  const restarted = open(path, "broker-b");
  try {
    expect(restarted.getTurn("turn-a")).toMatchObject({
      state: "UNRECONCILED", acceptedUserTurnId: "user-turn-a",
    });
    expect(restarted.getCurrentEpoch("goose-a")).toMatchObject({
      epoch: 1,
      conversationId: "conversation-a",
      leaseState: "UNRECONCILED",
      leaseTurnRef: "turn-a",
      isCurrent: true,
    });
    expect(restarted.getAccountSlotHolder()).toBeNull();
    expect(restarted.hasRecordedPositiveTerminalSlotRelease("turn-a")).toBeTrue();
    expect(restarted.reacquireReleasedSlotForRebind("turn-a")?.state).toBe("UNRECONCILED");
    expect(restarted.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    restarted.close();
  }
});

test("isStrictPrefixDigest returns true only for strict prefix hashes", () => {
  const prefix = "hello world";
  const full = "hello world!";
  const prefixDigest = createHash("sha256").update(prefix, "utf8").digest("hex");
  const fullDigest = createHash("sha256").update(full, "utf8").digest("hex");

  expect(isStrictPrefixDigest(prefixDigest, full)).toBe(true);
  expect(isStrictPrefixDigest(fullDigest, full)).toBe(false); // equal length, not strict prefix
  expect(isStrictPrefixDigest(prefixDigest, prefix)).toBe(false); // equal, not strict prefix
  expect(isStrictPrefixDigest("deadbeef".repeat(8), full)).toBe(false); // wrong digest
  expect(isStrictPrefixDigest(prefixDigest, "different text")).toBe(false); // not a prefix
  expect(isStrictPrefixDigest("", full)).toBe(false); // empty stored digest
  expect(isStrictPrefixDigest(prefixDigest, "")).toBe(false); // empty fresh text
});

test("isStrictPrefixDigest handles Unicode and surrogate pairs correctly", () => {
  // Text with emoji (surrogate pair)
  const prefix = "hello 🌍";
  const full = "hello 🌍!";
  const prefixDigest = createHash("sha256").update(prefix, "utf8").digest("hex");
  const fullDigest = createHash("sha256").update(full, "utf8").digest("hex");

  expect(isStrictPrefixDigest(prefixDigest, full)).toBe(true);
  expect(isStrictPrefixDigest(fullDigest, full)).toBe(false);

  // Multiple emoji
  const prefix2 = "🎉🎊";
  const full2 = "🎉🎊🎈";
  const prefixDigest2 = createHash("sha256").update(prefix2, "utf8").digest("hex");
  const fullDigest2 = createHash("sha256").update(full2, "utf8").digest("hex");

  expect(isStrictPrefixDigest(prefixDigest2, full2)).toBe(true);
  expect(isStrictPrefixDigest(fullDigest2, full2)).toBe(false);

  // A digest made from a string cut through the emoji surrogate pair must never match.
  const splitFull = "hello 🌍!";
  const splitPrefix = splitFull.slice(0, "hello ".length + 1);
  expect(splitPrefix.length).toBe("hello ".length + 1);
  const splitDigest = createHash("sha256").update(splitPrefix, "utf8").digest("hex");
  expect(isStrictPrefixDigest(splitDigest, splitFull)).toBe(false);
});

test("recordFinalDigestRecovery replaces digest only under strict recovery conditions", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    const initialDigest = createHash("sha256").update("initial", "utf8").digest("hex");
    broker.recordFinalDigest("turn-a", initialDigest);
    broker.markUnreconciled("turn-a", "browser_crash");

    // Wrong state (TURN_OUTSTANDING) should fail - create a separate turn in TURN_OUTSTANDING
    broker.createEpoch({ gooseSessionId: "goose-b" });
    const turn2 = broker.enqueueTurn({ gooseSessionId: "goose-b", requestHash: "req-b" });
    broker.admitNext(turn2.turnRef);
    broker.markSendActivated(turn2.turnRef);
    broker.recordFinalDigest(turn2.turnRef, initialDigest);
    expect(() => broker.recordFinalDigestRecovery(turn2.turnRef, initialDigest, "new-digest"))
      .toThrow(SessionBrokerError);

    // Completion claim in flight should fail
    broker.recordFinalDigest("turn-a", initialDigest); // re-acknowledge
    broker.beginCompletion("turn-a");
    expect(() => broker.recordFinalDigestRecovery("turn-a", initialDigest, "new-digest"))
      .toThrow(SessionBrokerError);

    // Clear completion claim (simulate restart or invalidation)
    broker.recordProgress("turn-a");

    // Wrong expected digest should fail
    expect(() => broker.recordFinalDigestRecovery("turn-a", "wrong-digest", "new-digest"))
      .toThrow(SessionBrokerError);

    // Same digest should fail
    expect(() => broker.recordFinalDigestRecovery("turn-a", initialDigest, initialDigest))
      .toThrow(SessionBrokerError);

    // Empty replacement should fail
    expect(() => broker.recordFinalDigestRecovery("turn-a", initialDigest, ""))
      .toThrow(SessionBrokerError);

    // Valid recovery should succeed
    const newDigest = createHash("sha256").update("initial!", "utf8").digest("hex");
    const recovered = broker.recordFinalDigestRecovery("turn-a", initialDigest, newDigest);
    expect(recovered.finalDigest).toBe(newDigest);
    expect(recovered.revision).toBeGreaterThan(0);
    expect(recovered.completionClaimRevision).toBeNull();
  } finally {
    broker.close();
  }
});

test("recordFinalDigestRecovery requires UNRECONCILED state and held slot", () => {
  const { broker } = fixture();
  try {
    createSession(broker);
    enqueue(broker);
    broker.admitNext();
    accept(broker);
    bindConversation(broker);
    const digest = createHash("sha256").update("final", "utf8").digest("hex");
    broker.recordFinalDigest("turn-a", digest);
    broker.markUnreconciled("turn-a", "test");

    // Should work in UNRECONCILED with slot held
    const newDigest = createHash("sha256").update("final!", "utf8").digest("hex");
    const recovered = broker.recordFinalDigestRecovery("turn-a", digest, newDigest);
    expect(recovered.finalDigest).toBe(newDigest);

    // After recovery, turn is still UNRECONCILED with slot held
    expect(broker.getTurn("turn-a")?.state).toBe("UNRECONCILED");
    expect(broker.getAccountSlotHolder()).toBe("turn-a");
  } finally {
    broker.close();
  }
});
