import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

export type LeaseState = "IDLE" | "TURN_OUTSTANDING" | "UNRECONCILED";
export type TurnState =
  | "QUEUED"
  | "TURN_OUTSTANDING"
  | "UNRECONCILED"
  | "COMPLETE"
  | "CANCELLED"
  | "ABANDONED";
// Keep abandonment out of the persisted state enum: exact older broker DBs have an immutable
// state CHECK, so additive abandoned_at preserves upgrade compatibility without rebuilding turns.
type StoredTurnState = Exclude<TurnState, "ABANDONED">;
export type OperationState = "MINTED" | "CLAIMED" | "SUCCESS" | "FAILURE" | "UNCERTAIN";
export type TerminalOperationState = Extract<OperationState, "SUCCESS" | "FAILURE">;

export interface RemoteEpoch {
  gooseSessionId: string;
  epoch: number;
  projectId: string;
  conversationId: string | null;
  historyWatermark: string | null;
  budgetPolicyJson: string | null;
  budgetConsumedTokens: number | null;
  isCurrent: boolean;
  leaseState: LeaseState;
  leaseTurnRef: string | null;
}

export interface BrokerTurn {
  turnRef: string;
  gooseSessionId: string;
  epoch: number;
  requestHash: string;
  submitNonce: string;
  state: TurnState;
  acceptedUserTurnId: string | null;
  revision: number;
  completionClaimRevision: number | null;
  checkpointJson: string | null;
  finalDigest: string | null;
  unreconciledReason: string | null;
  budgetReservedTokens: number | null;
  budgetPromptTokens: number | null;
  budgetGrowthConsumedTokens: number | null;
}

export interface BrokerOperation {
  opRef: string;
  turnRef: string;
  seq: number;
  state: OperationState;
  inputHash: string | null;
  resultJson: string | null;
  ownerId: string | null;
  answerBoundaryJson: string | null;
  terminalAt: number | null;
  budgetReservedTokens: number;
  budgetChargeTokens: number | null;
}

export interface PositiveTerminalEvidence {
  canonicalConversationId: string;
  acceptedUserTurnId: string;
  remoteUiNonRunningAcrossQualifiedSettle: boolean;
  noUnresolvedGooseWork: boolean;
  noContradictoryActivity: boolean;
}

export interface CompletionEvidence {
  connectorFinal: "ACKNOWLEDGED" | "UNAVAILABLE";
  canonicalConversationId: string;
  acceptedUserTurnId: string;
  noUnresolvedGooseWork: boolean;
  remoteNonRunning: boolean;
  observedFinalDigest: string;
  canonicalHistoryWatermark: string;
  answerBoundary: { opRef: string; contentAdvanced: boolean; qualifiedTerminal?: boolean } | null;
}

export interface CompletionClaim {
  turnRef: string;
  revision: number;
}

export interface AccountSlotOwnership {
  slotId: 1 | 2;
  turnRef: string;
}

export type OperationClaimDecision =
  | { kind: "EXECUTE"; opRef: string; seq: number }
  | { kind: "ATTACH"; opRef: string; seq: number }
  | { kind: "REPLAY"; opRef: string; seq: number; outcome: TerminalOperationState; resultJson: string; nextOpRef: string }
  | { kind: "UNCERTAIN"; opRef: string; seq: number }
  | { kind: "CONFLICT"; opRef: string; seq: number }
  | { kind: "BOUNDARY_REQUIRED"; opRef: string; seq: number }
  | { kind: "OUT_OF_ORDER"; opRef: string; seq: number }
  | { kind: "PROTOCOL_VIOLATION"; opRef: string; seq: number | null }
  | { kind: "STALE"; opRef: string; seq: number }
  | { kind: "WRONG_TURN"; opRef: string; seq: number }
  | { kind: "UNKNOWN"; opRef: string; seq: null };

export type OperationQuarantineDecision =
  | { kind: "QUARANTINED" | "ALREADY_UNCERTAIN"; operation: BrokerOperation }
  | { kind: "TERMINAL"; operation: BrokerOperation };

export type MissingOperationDecision =
  | { kind: "UNCERTAIN"; matchingOpRefs: string[] }
  | { kind: "PROTOCOL_VIOLATION" }
  | { kind: "INVALID" };

export interface SessionBrokerOptions {
  projectId: string;
  terminalReplayWindowMs: number;
  now?: () => number;
  instanceId?: string;
  makeTurnRef?: () => string;
  makeSubmitNonce?: () => string;
  makeOpRef?: () => string;
}

export class SessionBrokerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SessionBrokerError";
  }
}

interface EpochRow {
  goose_session_id: string;
  epoch: number;
  project_id: string;
  conversation_id: string | null;
  history_watermark: string | null;
  budget_policy_json: string | null;
  budget_consumed_tokens: number | null;
  is_current: number;
}

interface TurnRow {
  turn_ref: string;
  goose_session_id: string;
  epoch: number;
  request_hash: string;
  submit_nonce: string;
  state: StoredTurnState;
  slot_held: number;
  accepted_user_turn_id: string | null;
  revision: number;
  completion_claim_revision: number | null;
  checkpoint_json: string | null;
  final_digest: string | null;
  unreconciled_reason: string | null;
  abandoned_at: number | null;
  pre_send_retryable_cancelled: number;
  budget_reserved_tokens: number | null;
  budget_prompt_tokens: number | null;
  budget_growth_consumed_tokens: number | null;
}

interface OperationRow {
  op_ref: string;
  turn_ref: string;
  seq: number;
  state: OperationState;
  input_hash: string | null;
  result_json: string | null;
  owner_id: string | null;
  answer_boundary_json: string | null;
  terminal_at: number | null;
  budget_reserved_tokens: number;
  budget_charge_tokens: number | null;
}

const schema = `
CREATE TABLE IF NOT EXISTS remote_epochs (
  goose_session_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT,
  history_watermark TEXT,
  budget_policy_json TEXT,
  budget_consumed_tokens INTEGER CHECK (budget_consumed_tokens IS NULL OR budget_consumed_tokens >= 0),
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (goose_session_id, epoch)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_epoch_per_session
  ON remote_epochs(goose_session_id) WHERE is_current = 1;
CREATE UNIQUE INDEX IF NOT EXISTS unique_remote_conversation
  ON remote_epochs(conversation_id) WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS turns (
  queue_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_ref TEXT NOT NULL UNIQUE,
  goose_session_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  submit_nonce TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'QUEUED', 'TURN_OUTSTANDING', 'UNRECONCILED', 'COMPLETE', 'CANCELLED'
  )),
  slot_held INTEGER NOT NULL DEFAULT 0 CHECK (slot_held IN (0, 1)),
  accepted_user_turn_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  completion_claim_revision INTEGER,
  checkpoint_json TEXT,
  final_digest TEXT,
  unreconciled_reason TEXT,
  positive_terminal_evidence_json TEXT,
  pre_send_retryable_cancelled INTEGER NOT NULL DEFAULT 0 CHECK (pre_send_retryable_cancelled IN (0, 1)),
  abandoned_at INTEGER CHECK (
    abandoned_at IS NULL OR (
      state = 'UNRECONCILED' AND slot_held = 0 AND positive_terminal_evidence_json IS NOT NULL
      AND final_digest IS NULL AND completion_claim_revision IS NULL
    )
  ),
  budget_reserved_tokens INTEGER CHECK (budget_reserved_tokens IS NULL OR budget_reserved_tokens >= 0),
  budget_prompt_tokens INTEGER CHECK (budget_prompt_tokens IS NULL OR budget_prompt_tokens >= 0),
  budget_growth_consumed_tokens INTEGER CHECK (budget_growth_consumed_tokens IS NULL OR budget_growth_consumed_tokens >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (goose_session_id, epoch) REFERENCES remote_epochs(goose_session_id, epoch),
  CHECK (slot_held = 0 OR state NOT IN ('COMPLETE', 'CANCELLED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_submit_nonce ON turns(submit_nonce);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_turn_per_epoch
  ON turns(goose_session_id, epoch)
  WHERE state IN ('QUEUED', 'TURN_OUTSTANDING', 'UNRECONCILED');
CREATE INDEX IF NOT EXISTS queued_turns ON turns(state, queue_seq);

CREATE TABLE IF NOT EXISTS account_slots (
  slot_id INTEGER PRIMARY KEY CHECK (slot_id IN (1, 2)),
  turn_ref TEXT UNIQUE,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (turn_ref) REFERENCES turns(turn_ref)
);
INSERT OR IGNORE INTO account_slots(slot_id, turn_ref, updated_at) VALUES (1, NULL, 0);
INSERT OR IGNORE INTO account_slots(slot_id, turn_ref, updated_at) VALUES (2, NULL, 0);

CREATE TABLE IF NOT EXISTS broker_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT,
  pid INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((owner_id IS NULL AND pid IS NULL) OR (owner_id IS NOT NULL AND pid IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS operations (
  op_ref TEXT PRIMARY KEY,
  turn_ref TEXT NOT NULL,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('MINTED', 'CLAIMED', 'SUCCESS', 'FAILURE', 'UNCERTAIN')),
  input_hash TEXT,
  result_json TEXT,
  owner_id TEXT,
  answer_boundary_json TEXT,
  budget_reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved_tokens >= 0),
  budget_charge_tokens INTEGER CHECK (budget_charge_tokens IS NULL OR budget_charge_tokens >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  UNIQUE (turn_ref, seq),
  FOREIGN KEY (turn_ref) REFERENCES turns(turn_ref),
  CHECK (
    (state = 'MINTED' AND input_hash IS NULL AND result_json IS NULL AND owner_id IS NULL AND terminal_at IS NULL)
    OR (state = 'CLAIMED' AND input_hash IS NOT NULL AND result_json IS NULL AND owner_id IS NOT NULL AND terminal_at IS NULL AND answer_boundary_json IS NOT NULL)
    OR (state = 'UNCERTAIN' AND input_hash IS NOT NULL AND result_json IS NULL AND owner_id IS NULL AND terminal_at IS NULL AND answer_boundary_json IS NOT NULL)
    OR (state IN ('SUCCESS', 'FAILURE') AND input_hash IS NOT NULL AND result_json IS NOT NULL AND owner_id IS NULL AND terminal_at IS NOT NULL AND answer_boundary_json IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS operations_by_turn ON operations(turn_ref, seq);
`;

function epochFromRow(
  row: EpochRow,
  lease: { state: LeaseState; turnRef: string | null },
): RemoteEpoch {
  return {
    gooseSessionId: row.goose_session_id,
    epoch: row.epoch,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    historyWatermark: row.history_watermark,
    budgetPolicyJson: row.budget_policy_json,
    budgetConsumedTokens: row.budget_consumed_tokens,
    isCurrent: row.is_current === 1,
    leaseState: lease.state,
    leaseTurnRef: lease.turnRef,
  };
}

function turnFromRow(row: TurnRow): BrokerTurn {
  return {
    turnRef: row.turn_ref,
    gooseSessionId: row.goose_session_id,
    epoch: row.epoch,
    requestHash: row.request_hash,
    submitNonce: row.submit_nonce,
    state: row.abandoned_at === null ? row.state : "ABANDONED",
    acceptedUserTurnId: row.accepted_user_turn_id,
    revision: row.revision,
    completionClaimRevision: row.completion_claim_revision,
    checkpointJson: row.checkpoint_json,
    finalDigest: row.final_digest,
    unreconciledReason: row.unreconciled_reason,
    budgetReservedTokens: row.budget_reserved_tokens,
    budgetPromptTokens: row.budget_prompt_tokens,
    budgetGrowthConsumedTokens: row.budget_growth_consumed_tokens,
  };
}

function operationFromRow(row: OperationRow): BrokerOperation {
  return {
    opRef: row.op_ref,
    turnRef: row.turn_ref,
    seq: row.seq,
    state: row.state,
    inputHash: row.input_hash,
    resultJson: row.result_json,
    ownerId: row.owner_id,
    answerBoundaryJson: row.answer_boundary_json,
    terminalAt: row.terminal_at,
    budgetReservedTokens: row.budget_reserved_tokens,
    budgetChargeTokens: row.budget_charge_tokens,
  };
}

function positiveTerminalSatisfied(evidence: PositiveTerminalEvidence): boolean {
  return Boolean(evidence.canonicalConversationId)
    && Boolean(evidence.acceptedUserTurnId)
    && evidence.remoteUiNonRunningAcrossQualifiedSettle
    && evidence.noUnresolvedGooseWork
    && evidence.noContradictoryActivity;
}

export class SessionBroker {
  private readonly db: Database;
  private readonly projectId: string;
  private readonly now: () => number;
  private readonly makeTurnRef: () => string;
  private readonly makeSubmitNonce: () => string;
  private readonly makeOpRef: () => string;
  private readonly instanceId: string;
  private readonly terminalReplayWindowMs: number;

  constructor(databasePath: string, options: SessionBrokerOptions) {
    if (!options.projectId) {
      throw new SessionBrokerError("INVALID_POLICY", "projectId must not be empty");
    }
    if (!Number.isFinite(options.terminalReplayWindowMs) || options.terminalReplayWindowMs <= 0) {
      throw new SessionBrokerError("INVALID_POLICY", "terminalReplayWindowMs must be a positive finite duration");
    }
    this.projectId = options.projectId;
    this.now = options.now ?? Date.now;
    this.makeTurnRef = options.makeTurnRef ?? (() => `turn_${randomUUID()}`);
    this.makeSubmitNonce = options.makeSubmitNonce ?? (() => `submit_${randomUUID()}`);
    this.makeOpRef = options.makeOpRef ?? (() => `op_${randomUUID()}`);
    this.instanceId = options.instanceId ?? `broker_${randomUUID()}`;
    this.terminalReplayWindowMs = options.terminalReplayWindowMs;
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.query("PRAGMA journal_mode = WAL").get();
    this.db.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    try {
      this.db.exec(schema);
      const at = this.now();
      this.db.query("INSERT OR IGNORE INTO broker_owner(singleton, owner_id, pid, updated_at) VALUES (1, NULL, NULL, ?)").run(at);
      this.claimBrokerOwnership();
      this.assertProjectBinding();
      this.migrateSchema();
      this.recoverAfterRestart();
    } catch (error) {
      try {
        this.db.query("UPDATE broker_owner SET owner_id = NULL, pid = NULL, updated_at = ? WHERE singleton = 1 AND owner_id = ?")
          .run(this.now(), this.instanceId);
      } catch {
        // Preserve the original constructor failure; process death remains fail-closed fallback.
      }
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.transaction(() => {
      this.db.query("UPDATE broker_owner SET owner_id = NULL, pid = NULL, updated_at = ? WHERE singleton = 1 AND owner_id = ?")
        .run(this.now(), this.instanceId);
    });
    this.db.close();
  }

  createEpoch(input: {
    gooseSessionId: string;
    historyWatermark?: string | null;
  }): RemoteEpoch {
    if (!input.gooseSessionId) this.fail("INVALID_SESSION", "gooseSessionId must not be empty");
    return this.transaction(() => {
      const current = this.currentEpochRow(input.gooseSessionId);
      if (current) {
        if (this.hasNonterminalTurn(input.gooseSessionId, current.epoch)) {
          this.fail("EPOCH_BUSY", "Cannot roll epoch while its conversation or turn is nonterminal");
        }
        this.db.query("UPDATE remote_epochs SET is_current = 0, updated_at = ? WHERE goose_session_id = ? AND epoch = ?")
          .run(this.now(), input.gooseSessionId, current.epoch);
      }
      const maximum = this.db.query("SELECT MAX(epoch) AS value FROM remote_epochs WHERE goose_session_id = ?")
        .get(input.gooseSessionId) as { value: number | null } | null;
      const epoch = (maximum?.value ?? 0) + 1;
      const at = this.now();
      this.db.query(`INSERT INTO remote_epochs(
        goose_session_id, epoch, project_id, conversation_id, history_watermark,
        budget_policy_json, budget_consumed_tokens, is_current, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, ?, ?)`)
        .run(
          input.gooseSessionId,
          epoch,
          this.projectId,
          input.historyWatermark ?? null,
          null,
          null,
          at,
          at,
        );
      return this.getEpochRequired(input.gooseSessionId, epoch);
    });
  }

  bindConversation(input: {
    gooseSessionId: string;
    epoch: number;
    conversationId: string;
  }): RemoteEpoch {
    if (!input.conversationId) this.fail("INVALID_CONVERSATION", "conversationId must not be empty");
    return this.transaction(() => {
      this.bindConversationInside(input);
      return this.getEpochRequired(input.gooseSessionId, input.epoch);
    });
  }

  getCurrentEpoch(gooseSessionId: string): RemoteEpoch | null {
    const row = this.currentEpochRow(gooseSessionId);
    return row ? this.epochFromRow(row) : null;
  }

  enqueueTurn(input: {
    gooseSessionId: string;
    requestHash: string;
    checkpointJson?: string;
  }): BrokerTurn {
    if (!input.gooseSessionId || !input.requestHash) {
      this.fail("INVALID_TURN", "gooseSessionId and requestHash are required");
    }
    return this.transaction(() => {
      const latest = this.db.query("SELECT * FROM turns WHERE goose_session_id = ? ORDER BY queue_seq DESC LIMIT 1")
        .get(input.gooseSessionId) as TurnRow | null;
      // requestHash identifies the initial Goose delivery for logical-turn replay. checkpointJson
      // is mutable provider progress and may already have advanced through later tool rounds; an
      // old transport retry must never overwrite or be rejected merely because that checkpoint
      // has moved forward.
      if (latest?.request_hash === input.requestHash
        && !(latest.state === "CANCELLED" && latest.pre_send_retryable_cancelled === 1)) {
        return turnFromRow(latest);
      }

      const epochRow = this.currentEpochRow(input.gooseSessionId);
      if (!epochRow) this.fail("UNKNOWN_EPOCH", "Goose session has no current remote epoch");
      if (this.hasNonterminalTurn(input.gooseSessionId, epochRow.epoch)) {
        this.fail("CONVERSATION_BUSY", "Current remote epoch cannot accept another turn");
      }
      const turnRef = this.makeTurnRef();
      const submitNonce = this.makeSubmitNonce();
      if (!turnRef || !submitNonce) this.fail("INVALID_TURN_IDENTITY", "Turn identity factories returned an empty value");

      const at = this.now();
      this.db.query(`INSERT INTO turns(
        turn_ref, goose_session_id, epoch, request_hash, submit_nonce, state, slot_held,
        accepted_user_turn_id, revision, completion_claim_revision, checkpoint_json,
        final_digest, unreconciled_reason, positive_terminal_evidence_json,
        budget_reserved_tokens, budget_prompt_tokens, budget_growth_consumed_tokens,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'QUEUED', 0, NULL, 0, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)` )
        .run(
          turnRef,
          input.gooseSessionId,
          epochRow.epoch,
          input.requestHash,
          submitNonce,
          input.checkpointJson ?? null,
          at,
          at,
        );
      return this.getTurnRequired(turnRef);
    });
  }

  admitNext(requestedTurnRef?: string): { turn: BrokerTurn; initialOpRef: string } | null {
    return this.transaction(() => {
      if (requestedTurnRef) {
        const requested = this.turnRowRequired(requestedTurnRef);
        if (requested.state !== "QUEUED") this.fail("TURN_STATE", "Only a queued turn can wait for admission");
        if (this.accountSlotForTurn(requestedTurnRef) !== null) {
          const initialOpRef = this.operationRefAt(requestedTurnRef, 1);
          if (!initialOpRef) this.fail("JOURNAL_CORRUPT", "Admitted pre-send turn is missing its initial operation ref");
          return { turn: turnFromRow(requested), initialOpRef };
        }
      } else {
        const heldQueued = this.db.query(`SELECT turns.* FROM turns
          JOIN account_slots ON account_slots.turn_ref = turns.turn_ref
          WHERE turns.state = 'QUEUED' ORDER BY turns.queue_seq ASC LIMIT 1`).get() as TurnRow | null;
        if (heldQueued) {
          const initialOpRef = this.operationRefAt(heldQueued.turn_ref, 1);
          if (!initialOpRef) this.fail("JOURNAL_CORRUPT", "Admitted pre-send turn is missing its initial operation ref");
          return { turn: turnFromRow(heldQueued), initialOpRef };
        }
      }

      const freeSlot = this.db.query("SELECT slot_id FROM account_slots WHERE turn_ref IS NULL ORDER BY slot_id ASC LIMIT 1")
        .get() as { slot_id: 1 | 2 } | null;
      if (!freeSlot) return null;
      const next = this.db.query("SELECT * FROM turns WHERE state = 'QUEUED' AND slot_held = 0 ORDER BY queue_seq ASC LIMIT 1")
        .get() as TurnRow | null;
      if (!next) return null;
      const epoch = this.epochRowRequired(next.goose_session_id, next.epoch);
      if (epoch.is_current !== 1) {
        this.fail("QUEUE_INVARIANT", "Oldest queued turn no longer belongs to the current epoch");
      }
      const at = this.now();
      const slot = this.db.query("UPDATE account_slots SET turn_ref = ?, updated_at = ? WHERE slot_id = ? AND turn_ref IS NULL")
        .run(next.turn_ref, at, freeSlot.slot_id);
      if (slot.changes !== 1) this.fail("ACCOUNT_SLOT", "Failed to acquire the bounded account execution slot");
      const held = this.db.query("UPDATE turns SET slot_held = 1, updated_at = ? WHERE turn_ref = ? AND slot_held = 0")
        .run(at, next.turn_ref);
      if (held.changes !== 1) this.fail("ACCOUNT_SLOT", "Failed to mark the admitted turn as slot-owning");
      const initialOpRef = this.operationRefAt(next.turn_ref, 1) ?? this.mintOperation(next.turn_ref, 1);
      return { turn: turnFromRow(this.turnRowRequired(next.turn_ref)), initialOpRef };
    });
  }

  cancelBeforeSend(turnRef: string): BrokerTurn {
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.state === "CANCELLED") return turnFromRow(turn);
      if (turn.state !== "QUEUED") this.fail("TURN_STATE", "Only a slot-owning queued turn may be cancelled before send");
      this.requireSlotHolder(turnRef);
      const at = this.now();
      const result = this.db.query(`UPDATE turns SET state = 'CANCELLED', slot_held = 0, completion_claim_revision = NULL,
        budget_reserved_tokens = CASE WHEN budget_reserved_tokens IS NULL THEN NULL ELSE 0 END,
        revision = revision + 1, updated_at = ? WHERE turn_ref = ? AND slot_held = 1`)
        .run(at, turnRef);
      if (result.changes !== 1) this.fail("ACCOUNT_SLOT", "Pre-send cancellation lost its account slot");
      this.releaseAccountSlotInside(turnRef, at);
      return this.getTurnRequired(turnRef);
    });
  }

  /** Cancel only while the durable send fence is still QUEUED; exact replay may create a fresh attempt. */
  cancelRetryableBeforeSend(turnRef: string): BrokerTurn {
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.state === "CANCELLED" && turn.pre_send_retryable_cancelled === 1) return turnFromRow(turn);
      if (turn.state !== "QUEUED") {
        this.fail("TURN_STATE", "Retryable cancellation is valid only before durable send activation");
      }
      const at = this.now();
      const result = this.db.query(`UPDATE turns SET state = 'CANCELLED', slot_held = 0,
        pre_send_retryable_cancelled = 1, completion_claim_revision = NULL,
        budget_reserved_tokens = CASE WHEN budget_reserved_tokens IS NULL THEN NULL ELSE 0 END,
        revision = revision + 1, updated_at = ? WHERE turn_ref = ? AND state = 'QUEUED'`)
        .run(at, turnRef);
      if (result.changes !== 1) this.fail("TURN_STATE", "Retryable pre-send cancellation lost the queued turn state");
      this.releaseAccountSlotIfHeldInside(turnRef, at);
      return this.getTurnRequired(turnRef);
    });
  }

  // Persist TURN_OUTSTANDING immediately before the irreversible Enter/click.
  markSendActivated(turnRef: string): BrokerTurn {
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.state === "TURN_OUTSTANDING") return turnFromRow(turn);
      if (turn.state !== "QUEUED") this.fail("TURN_STATE", "Only a slot-owning queued turn may arm submission");
      this.requireSlotHolder(turnRef);
      this.db.query("UPDATE turns SET state = 'TURN_OUTSTANDING', completion_claim_revision = NULL, revision = revision + 1, updated_at = ? WHERE turn_ref = ?")
        .run(this.now(), turnRef);
      return this.getTurnRequired(turnRef);
    });
  }

  markAccepted(turnRef: string, acceptedUserTurnId: string | null = null): BrokerTurn {
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.abandoned_at !== null) {
        if (acceptedUserTurnId && acceptedUserTurnId !== turn.accepted_user_turn_id) {
          this.fail("USER_TURN_CONFLICT", "Accepted user turn is already bound to another identity");
        }
        return turnFromRow(turn);
      }
      if (turn.state === "UNRECONCILED") {
        if (!acceptedUserTurnId) return turnFromRow(turn);
        this.bindAcceptedUserTurnId(turn, acceptedUserTurnId);
        return this.getTurnRequired(turnRef);
      }
      if (turn.state !== "TURN_OUTSTANDING") this.fail("TURN_STATE", "Submission must be durably armed before semantic acceptance");
      if (acceptedUserTurnId) this.bindAcceptedUserTurnId(turn, acceptedUserTurnId);
      return this.getTurnRequired(turnRef);
    });
  }

  markUnreconciled(turnRef: string, reason: string): BrokerTurn {
    if (!reason) this.fail("INVALID_REASON", "Unreconciled state requires a reason");
    return this.transaction(() => this.markUnreconciledInside(turnRef, reason));
  }

  rebindVerifiedRemoteTurn(input: {
    turnRef: string;
    canonicalConversationId: string;
    acceptedUserTurnId: string;
    remoteIdentityVerified: true;
  }): BrokerTurn {
    if (input.remoteIdentityVerified !== true) this.fail("RECOVERY_EVIDENCE", "Rebind requires positive remote identity evidence");
    return this.transaction(() => {
      const turn = this.turnRowRequired(input.turnRef);
      if (turn.abandoned_at !== null || (turn.state !== "UNRECONCILED" && turn.state !== "TURN_OUTSTANDING")) {
        this.fail("TURN_STATE", "Only an unreconciled or already-attached remote turn may pass verified rebind");
      }
      this.requireSlotHolder(input.turnRef);
      const epoch = this.epochRowRequired(turn.goose_session_id, turn.epoch);
      if (epoch.conversation_id !== input.canonicalConversationId
        || turn.accepted_user_turn_id !== input.acceptedUserTurnId) {
        this.fail("RECOVERY_IDENTITY", "Recovery identity does not match the durable conversation/turn binding");
      }
      if (turn.final_digest) this.fail("RECOVERY_FINAL", "A turn with accepted final content cannot resume as running");
      if (this.hasAmbiguousOperation(input.turnRef)) {
        this.fail("UNRESOLVED_OPERATION", "A turn with claimed or uncertain operations cannot resume ordinary execution");
      }
      if (turn.state === "TURN_OUTSTANDING") return turnFromRow(turn);
      this.db.query(`UPDATE turns SET state = 'TURN_OUTSTANDING', unreconciled_reason = NULL,
        positive_terminal_evidence_json = NULL, completion_claim_revision = NULL,
        revision = revision + 1, updated_at = ? WHERE turn_ref = ?`)
        .run(this.now(), input.turnRef);
      return this.getTurnRequired(input.turnRef);
    });
  }

  verifyFinalRecoveryRemoteTurn(input: {
    turnRef: string;
    canonicalConversationId: string;
    acceptedUserTurnId: string;
    remoteIdentityVerified: true;
  }): BrokerTurn {
    if (input.remoteIdentityVerified !== true) {
      this.fail("RECOVERY_EVIDENCE", "Final recovery requires positive remote identity evidence");
    }
    return this.transaction(() => {
      const turn = this.turnRowRequired(input.turnRef);
      if (turn.abandoned_at !== null || turn.state !== "UNRECONCILED") {
        this.fail("TURN_STATE", "Accepted-final recovery requires an unreconciled remote turn");
      }
      this.requireSlotHolder(input.turnRef);
      const epoch = this.epochRowRequired(turn.goose_session_id, turn.epoch);
      if (epoch.conversation_id !== input.canonicalConversationId
        || turn.accepted_user_turn_id !== input.acceptedUserTurnId) {
        this.fail("RECOVERY_IDENTITY", "Final recovery identity does not match the durable conversation/turn binding");
      }
      if (!turn.final_digest) {
        this.fail("FINAL_DIGEST_REQUIRED", "Accepted-final recovery requires a durably acknowledged final digest");
      }
      if (this.hasUnresolvedOperation(input.turnRef)) {
        this.fail("UNRESOLVED_OPERATION", "Accepted-final recovery cannot proceed with unresolved Goose work");
      }
      // This proves only that the disposable browser reattached to the already-final durable pair.
      // Keep the turn UNRECONCILED so the existing completion CAS must still freshly confirm the
      // remote final and match its digest before releasing the account slot.
      return turnFromRow(turn);
    });
  }

  releaseSlotAfterPositiveTerminal(turnRef: string, evidence: PositiveTerminalEvidence): BrokerTurn {
    if (!positiveTerminalSatisfied(evidence)) {
      this.fail("POSITIVE_TERMINAL_REQUIRED", "Account-slot release requires the full positive terminal predicate");
    }
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.state !== "UNRECONCILED") this.fail("TURN_STATE", "Only an unreconciled turn can be quarantined with its slot released");
      if (this.accountSlotForTurn(turnRef) === null) {
        const recorded = this.recordedSlotDemotionEvidence(turnRef);
        if (recorded !== null) {
          if (recorded !== JSON.stringify(evidence)) {
            this.fail("POSITIVE_TERMINAL_CONFLICT", "Slot demotion is already recorded with different evidence");
          }
          return turnFromRow(turn);
        }
        this.fail("ACCOUNT_SLOT", "Unreconciled turn lost its account slot without durable demotion evidence");
      }

      const epoch = this.epochRowRequired(turn.goose_session_id, turn.epoch);
      if (turn.final_digest) this.fail("POSITIVE_TERMINAL_REQUIRED", "Accepted final content must use normal completion reconciliation");
      if (turn.completion_claim_revision !== null) this.fail("COMPLETION_IN_FLIGHT", "Cannot release account slot while a completion claim exists");
      if (this.hasUnresolvedOperation(turnRef)) this.fail("UNRESOLVED_OPERATION", "Cannot release account slot with claimed or uncertain operations");

      // The same positive-terminal proof that permits slot release may also close the crash window
      // between irreversible send and durable remote identity capture. Bind only missing identity;
      // any pre-existing conflict still fails the whole transaction closed.
      if (epoch.conversation_id) {
        if (epoch.conversation_id !== evidence.canonicalConversationId) {
          this.fail("POSITIVE_TERMINAL_REQUIRED", "Positive-terminal conversation identity does not match the durable binding");
        }
      } else {
        this.bindConversationInside({
          gooseSessionId: turn.goose_session_id,
          epoch: turn.epoch,
          conversationId: evidence.canonicalConversationId,
        });
      }
      if (turn.accepted_user_turn_id) {
        if (turn.accepted_user_turn_id !== evidence.acceptedUserTurnId) {
          this.fail("POSITIVE_TERMINAL_REQUIRED", "Positive-terminal user identity does not match the durable binding");
        }
      } else {
        this.bindAcceptedUserTurnId(turn, evidence.acceptedUserTurnId);
      }
      const at = this.now();
      const result = this.db.query(`UPDATE turns SET positive_terminal_evidence_json = ?, slot_held = 0,
        revision = revision + 1, updated_at = ? WHERE turn_ref = ? AND slot_held = 1`)
        .run(JSON.stringify(evidence), at, turnRef);
      if (result.changes !== 1) this.fail("ACCOUNT_SLOT", "Positive-terminal demotion lost its account slot");
      this.releaseAccountSlotInside(turnRef, at);
      return this.getTurnRequired(turnRef);
    });
  }


  reacquireReleasedSlotForRebind(turnRef: string): BrokerTurn | null {
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.abandoned_at !== null || turn.state !== "UNRECONCILED") {
        this.fail("TURN_STATE", "Only an unreconciled persistent pair can reacquire a released account slot");
      }
      if (this.accountSlotForTurn(turnRef) !== null) return turnFromRow(turn);
      if (this.recordedSlotDemotionEvidence(turnRef) === null) {
        this.fail("RECOVERY_EVIDENCE", "Slot reacquisition requires a prior positive-terminal slot release");
      }
      const epoch = this.epochRowRequired(turn.goose_session_id, turn.epoch);
      if (epoch.is_current !== 1 || !epoch.conversation_id || !turn.accepted_user_turn_id) {
        this.fail("RECOVERY_IDENTITY", "Slot reacquisition requires the same durable Goose and ChatGPT pair identity");
      }
      if (turn.final_digest) this.fail("RECOVERY_FINAL", "A turn with accepted final content cannot resume as running");
      if (turn.completion_claim_revision !== null) {
        this.fail("COMPLETION_IN_FLIGHT", "Cannot reacquire an account slot while a completion claim exists");
      }
      if (this.hasUnresolvedOperation(turnRef)) {
        this.fail("UNRESOLVED_OPERATION", "Cannot reacquire an account slot with claimed or uncertain operations");
      }
      const freeSlot = this.db.query("SELECT slot_id FROM account_slots WHERE turn_ref IS NULL ORDER BY slot_id ASC LIMIT 1")
        .get() as { slot_id: 1 | 2 } | null;
      if (!freeSlot) return null;
      const at = this.now();
      const slot = this.db.query("UPDATE account_slots SET turn_ref = ?, updated_at = ? WHERE slot_id = ? AND turn_ref IS NULL")
        .run(turnRef, at, freeSlot.slot_id);
      if (slot.changes !== 1) this.fail("ACCOUNT_SLOT", "Failed to reacquire the bounded account execution slot");
      const held = this.db.query(`UPDATE turns SET slot_held = 1, completion_claim_revision = NULL,
        revision = revision + 1, updated_at = ? WHERE turn_ref = ? AND state = 'UNRECONCILED' AND slot_held = 0`)
        .run(at, turnRef);
      if (held.changes !== 1) this.fail("ACCOUNT_SLOT", "Failed to restore slot ownership to the unreconciled pair");
      return this.getTurnRequired(turnRef);
    });
  }

  restorePositiveTerminalSlotRelease(turnRef: string): BrokerTurn {
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.abandoned_at !== null || turn.state !== "UNRECONCILED") {
        this.fail("TURN_STATE", "Only an unreconciled persistent pair can restore its positive-terminal slot release");
      }
      if (this.recordedSlotDemotionEvidence(turnRef) === null) {
        this.fail("RECOVERY_EVIDENCE", "Slot release restoration requires prior positive-terminal evidence");
      }
      if (this.accountSlotForTurn(turnRef) === null) return turnFromRow(turn);
      if (turn.final_digest) this.fail("RECOVERY_FINAL", "A turn with accepted final content cannot restore a released slot");
      if (turn.completion_claim_revision !== null) {
        this.fail("COMPLETION_IN_FLIGHT", "Cannot restore a released slot while a completion claim exists");
      }
      if (this.hasUnresolvedOperation(turnRef)) {
        this.fail("UNRESOLVED_OPERATION", "Cannot restore a released slot with claimed or uncertain operations");
      }
      const at = this.now();
      const result = this.db.query(`UPDATE turns SET slot_held = 0, completion_claim_revision = NULL,
        revision = revision + 1, updated_at = ? WHERE turn_ref = ? AND state = 'UNRECONCILED' AND slot_held = 1`)
        .run(at, turnRef);
      if (result.changes !== 1) this.fail("ACCOUNT_SLOT", "Failed to restore the positive-terminal slot release");
      this.releaseAccountSlotInside(turnRef, at);
      return this.getTurnRequired(turnRef);
    });
  }

  recordProgress(turnRef: string, checkpointJson?: string): BrokerTurn {
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.abandoned_at !== null || (turn.state !== "TURN_OUTSTANDING" && turn.state !== "UNRECONCILED")) {
        this.fail("TURN_STATE", "Progress evidence requires a remotely outstanding or unreconciled turn");
      }
      if (checkpointJson === undefined) this.bumpTurnRevision(turnRef);
      else this.db.query(`UPDATE turns SET checkpoint_json = ?, completion_claim_revision = NULL,
        revision = revision + 1, updated_at = ? WHERE turn_ref = ?`).run(checkpointJson, this.now(), turnRef);
      return this.getTurnRequired(turnRef);
    });
  }

  recordFinalDigest(turnRef: string, finalDigest: string): BrokerTurn {
    if (!finalDigest) this.fail("INVALID_FINAL_DIGEST", "Final digest must not be empty");
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.abandoned_at !== null || (turn.state !== "TURN_OUTSTANDING" && turn.state !== "UNRECONCILED")) {
        this.fail("TURN_STATE", "Final digest requires an outstanding or unreconciled remote turn");
      }
      if (turn.final_digest && turn.final_digest !== finalDigest) {
        this.fail("FINAL_DIGEST_CONFLICT", "A different final digest is already durably acknowledged");
      }
      if (!turn.final_digest) {
        this.db.query("UPDATE turns SET final_digest = ?, completion_claim_revision = NULL, revision = revision + 1, updated_at = ? WHERE turn_ref = ?")
          .run(finalDigest, this.now(), turnRef);
      }
      return this.getTurnRequired(turnRef);
    });
  }

  recordAnswerBoundary(turnRef: string, opRef: string, boundaryJson: string): BrokerOperation {
    if (!boundaryJson) this.fail("INVALID_BOUNDARY", "Answer boundary must not be empty");
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.state !== "TURN_OUTSTANDING") this.fail("TURN_STATE", "Answer boundary requires an outstanding remote turn");
      const epoch = this.epochRowRequired(turn.goose_session_id, turn.epoch);
      if (!epoch.conversation_id || !turn.accepted_user_turn_id) {
        this.fail("BOUNDARY_IDENTITY_REQUIRED", "Answer boundary requires canonical conversation and accepted user-turn identity");
      }
      const op = this.operationRowRequired(opRef);
      if (op.turn_ref !== turnRef) this.fail("WRONG_TURN", "Operation belongs to another turn");
      if (op.state !== "MINTED") this.fail("OP_STATE", "Answer boundary can be attached only before operation claim");
      if (op.answer_boundary_json && op.answer_boundary_json !== boundaryJson) {
        this.fail("BOUNDARY_CONFLICT", "Operation already has a different answer boundary");
      }
      if (!op.answer_boundary_json) {
        this.db.query("UPDATE operations SET answer_boundary_json = ?, updated_at = ? WHERE op_ref = ?")
          .run(boundaryJson, this.now(), opRef);
        this.bumpTurnRevision(turnRef);
      }
      return this.getOperationRequired(opRef);
    });
  }

  claimOperation(input: { turnRef: string; opRef: string; inputHash: string }): OperationClaimDecision {
    if (!input.inputHash) this.fail("INVALID_INPUT_HASH", "inputHash must not be empty");
    return this.transaction(() => {
      const op = this.operationRow(input.opRef);
      if (!op) {
        const turn = this.turnRow(input.turnRef);
        if (turn?.abandoned_at !== null && turn?.abandoned_at !== undefined) {
          return { kind: "PROTOCOL_VIOLATION", opRef: input.opRef, seq: null };
        }
        if (turn?.final_digest) {
          if (turn.state === "TURN_OUTSTANDING") this.markUnreconciledInside(input.turnRef, "unknown_operation_after_final");
          return { kind: "PROTOCOL_VIOLATION", opRef: input.opRef, seq: null };
        }
        return { kind: "UNKNOWN", opRef: input.opRef, seq: null };
      }
      if (op.turn_ref !== input.turnRef) return { kind: "WRONG_TURN", opRef: op.op_ref, seq: op.seq };
      const turn = this.turnRowRequired(input.turnRef);
      if (turn.final_digest && op.input_hash && op.input_hash !== input.inputHash) {
        if (turn.state === "TURN_OUTSTANDING") this.markUnreconciledInside(input.turnRef, "conflicting_operation_after_final");
        return { kind: "PROTOCOL_VIOLATION", opRef: op.op_ref, seq: op.seq };
      }
      if (op.input_hash && op.input_hash !== input.inputHash) return { kind: "CONFLICT", opRef: op.op_ref, seq: op.seq };

      if (op.state === "SUCCESS" || op.state === "FAILURE") {
        if (op.terminal_at === null || this.now() - op.terminal_at > this.terminalReplayWindowMs) {
          return { kind: "STALE", opRef: op.op_ref, seq: op.seq };
        }
        const nextOpRef = this.nextOpRef(op.turn_ref, op.seq);
        if (op.result_json === null || !nextOpRef) this.fail("JOURNAL_CORRUPT", "Terminal operation is missing replay state");
        return { kind: "REPLAY", opRef: op.op_ref, seq: op.seq, outcome: op.state, resultJson: op.result_json, nextOpRef };
      }
      if (turn.abandoned_at !== null) return { kind: "STALE", opRef: op.op_ref, seq: op.seq };
      if (op.state === "UNCERTAIN") return { kind: "UNCERTAIN", opRef: op.op_ref, seq: op.seq };
      if (op.state === "CLAIMED") {
        return op.owner_id === this.instanceId
          ? { kind: "ATTACH", opRef: op.op_ref, seq: op.seq }
          : { kind: "UNCERTAIN", opRef: op.op_ref, seq: op.seq };
      }

      if (turn.state === "COMPLETE" || turn.state === "CANCELLED") {
        return { kind: "STALE", opRef: op.op_ref, seq: op.seq };
      }
      if (turn.final_digest) {
        if (turn.state === "TURN_OUTSTANDING") this.markUnreconciledInside(input.turnRef, "fresh_operation_after_final");
        return { kind: "PROTOCOL_VIOLATION", opRef: op.op_ref, seq: op.seq };
      }
      if (turn.state === "UNRECONCILED") return { kind: "UNCERTAIN", opRef: op.op_ref, seq: op.seq };
      if (turn.state !== "TURN_OUTSTANDING") return { kind: "OUT_OF_ORDER", opRef: op.op_ref, seq: op.seq };
      if (!op.answer_boundary_json) return { kind: "BOUNDARY_REQUIRED", opRef: op.op_ref, seq: op.seq };
      const newest = this.db.query("SELECT MAX(seq) AS value FROM operations WHERE turn_ref = ?")
        .get(input.turnRef) as { value: number | null } | null;
      if (newest?.value !== op.seq) return { kind: "OUT_OF_ORDER", opRef: op.op_ref, seq: op.seq };

      this.db.query(`UPDATE operations SET state = 'CLAIMED', input_hash = ?, owner_id = ?,
        budget_reserved_tokens = 0, updated_at = ? WHERE op_ref = ?`)
        .run(input.inputHash, this.instanceId, this.now(), input.opRef);
      this.bumpTurnRevision(input.turnRef);
      return { kind: "EXECUTE", opRef: op.op_ref, seq: op.seq };
    });
  }

  quarantineOwnedOperation(input: {
    turnRef: string;
    opRef: string;
    reason: string;
  }): OperationQuarantineDecision {
    if (!input.reason) this.fail("INVALID_REASON", "Operation quarantine requires a reason");
    return this.transaction(() => {
      const op = this.operationRowRequired(input.opRef);
      if (op.turn_ref !== input.turnRef) this.fail("WRONG_TURN", "Operation belongs to another turn");
      if (op.state === "SUCCESS" || op.state === "FAILURE") {
        return { kind: "TERMINAL", operation: operationFromRow(op) };
      }
      if (op.state === "UNCERTAIN") {
        return { kind: "ALREADY_UNCERTAIN", operation: operationFromRow(op) };
      }
      if (op.state !== "CLAIMED" || op.owner_id !== this.instanceId) {
        this.fail("OP_STATE", "Only this broker instance's claimed operation can be quarantined");
      }
      const turn = this.turnRowRequired(input.turnRef);
      if (turn.state === "TURN_OUTSTANDING") this.markUnreconciledInside(input.turnRef, input.reason);
      else if (turn.state !== "UNRECONCILED") {
        this.fail("TURN_STATE", "Operation quarantine requires an outstanding or unreconciled turn");
      }
      const at = this.now();
      const changed = this.db.query(`UPDATE operations SET state = 'UNCERTAIN', owner_id = NULL,
        updated_at = ? WHERE op_ref = ? AND state = 'CLAIMED' AND owner_id = ?`)
        .run(at, input.opRef, this.instanceId);
      if (changed.changes !== 1) this.fail("OP_STATE", "Operation quarantine lost its owned claim");
      if (turn.state === "UNRECONCILED") this.bumpTurnRevision(input.turnRef);
      return { kind: "QUARANTINED", operation: this.getOperationRequired(input.opRef) };
    });
  }

  classifyMissingOperationRef(turnRef: string, inputHash: string): MissingOperationDecision {
    if (!inputHash) this.fail("INVALID_INPUT_HASH", "inputHash must not be empty");
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.abandoned_at !== null) return { kind: "PROTOCOL_VIOLATION" };
      if (turn.final_digest) {
        if (turn.state === "TURN_OUTSTANDING") this.markUnreconciledInside(turnRef, "ticketless_operation_after_final");
        return { kind: "PROTOCOL_VIOLATION" };
      }
      const cutoff = this.now() - this.terminalReplayWindowMs;
      const rows = this.db.query(`SELECT op_ref FROM operations WHERE turn_ref = ? AND input_hash = ? AND (
        state IN ('CLAIMED', 'UNCERTAIN') OR (state IN ('SUCCESS', 'FAILURE') AND terminal_at >= ?)
      ) ORDER BY seq ASC`).all(turnRef, inputHash, cutoff) as Array<{ op_ref: string }>;
      return rows.length
        ? { kind: "UNCERTAIN", matchingOpRefs: rows.map(row => row.op_ref) }
        : { kind: "INVALID" };
    });
  }


  completeOperation(input: {
    opRef: string;
    inputHash: string;
    outcome: TerminalOperationState;
    resultJson: string;
  }): { operation: BrokerOperation; nextOpRef: string } {
    return this.transaction(() => this.finishOperationInside(input, false));
  }

  completeOperationWithProgress(input: {
    turnRef: string;
    opRef: string;
    inputHash: string;
    outcome: TerminalOperationState;
    resultJson: string;
    checkpointJson: string;
  }): { operation: BrokerOperation; nextOpRef: string } {
    if (!input.checkpointJson) this.fail("INVALID_CHECKPOINT", "Progress checkpoint must not be empty");
    return this.transaction(() => {
      const turn = this.turnRowRequired(input.turnRef);
      const op = this.operationRowRequired(input.opRef);
      if (op.turn_ref !== input.turnRef) this.fail("WRONG_TURN", "Operation does not belong to the supplied turn");
      if (op.input_hash !== input.inputHash) this.fail("OP_REF_CONFLICT", "Operation input hash does not match its durable claim");
      if (op.state !== "CLAIMED" || op.owner_id !== this.instanceId) {
        this.fail("OP_STATE", "Only the live broker-owned claim can atomically commit tool progress");
      }
      if (turn.abandoned_at !== null || (turn.state !== "TURN_OUTSTANDING" && turn.state !== "UNRECONCILED")) {
        this.fail("TURN_STATE", "Tool progress requires a remotely outstanding or unreconciled turn");
      }
      this.db.query(`UPDATE turns SET checkpoint_json = ?, completion_claim_revision = NULL,
        revision = revision + 1, updated_at = ? WHERE turn_ref = ?`)
        .run(input.checkpointJson, this.now(), input.turnRef);
      return this.finishOperationInside({
        opRef: input.opRef,
        inputHash: input.inputHash,
        outcome: input.outcome,
        resultJson: input.resultJson,
      }, false);
    });
  }

  reconcileLateTerminal(input: {
    opRef: string;
    inputHash: string;
    outcome: TerminalOperationState;
    resultJson: string;
  }): { operation: BrokerOperation; nextOpRef: string } {
    return this.transaction(() => this.finishOperationInside(input, true));
  }

  reconcileKnownOperationTerminal(input: {
    turnRef: string;
    opRef: string;
    inputHash: string;
    outcome: TerminalOperationState;
    resultJson: string;
  }): { operation: BrokerOperation; nextOpRef: string } {
    return this.transaction(() => {
      const turn = this.turnRowRequired(input.turnRef);
      if (turn.abandoned_at !== null || turn.state !== "UNRECONCILED") {
        this.fail("TURN_STATE", "Known operation reconciliation requires an unreconciled turn");
      }
      if (turn.final_digest) {
        this.fail("RECOVERY_FINAL", "A turn with accepted final content must use normal completion reconciliation");
      }
      const op = this.operationRowRequired(input.opRef);
      if (op.turn_ref !== input.turnRef) this.fail("WRONG_TURN", "Operation belongs to another turn");
      if (!op.answer_boundary_json) this.fail("BOUNDARY_REQUIRED", "Known operation reconciliation requires the durable pre-tool answer boundary");
      if (op.input_hash !== input.inputHash) this.fail("OP_REF_CONFLICT", "Operation input hash does not match its durable claim");
      if (op.state === "MINTED" || op.state === "CLAIMED") {
        this.fail("OP_STATE", "Known operation reconciliation requires a post-owner UNCERTAIN operation");
      }
      return this.finishOperationInside({
        opRef: input.opRef,
        inputHash: input.inputHash,
        outcome: input.outcome,
        resultJson: input.resultJson,
      }, true);
    });
  }

  beginCompletion(turnRef: string): CompletionClaim {
    return this.transaction(() => {
      const turn = this.turnRowRequired(turnRef);
      if (turn.abandoned_at !== null || (turn.state !== "TURN_OUTSTANDING" && turn.state !== "UNRECONCILED")) {
        this.fail("TURN_STATE", "Completion requires an outstanding or unreconciled remote turn");
      }
      this.requireSlotHolder(turnRef);
      const epoch = this.epochRowRequired(turn.goose_session_id, turn.epoch);
      if (!epoch.conversation_id || !turn.accepted_user_turn_id) {
        this.fail("COMPLETION_IDENTITY_REQUIRED", "Completion requires canonical conversation and absolute user-turn identity");
      }
      if (!turn.final_digest) this.fail("FINAL_DIGEST_REQUIRED", "Completion requires a durably acknowledged final digest");
      if (this.hasUnresolvedOperation(turnRef)) this.fail("UNRESOLVED_OPERATION", "Completion cannot begin with claimed or uncertain operations");
      if (turn.completion_claim_revision !== null) {
        if (turn.completion_claim_revision !== turn.revision) this.fail("COMPLETION_STALE", "Existing completion claim is stale");
        return { turnRef, revision: turn.revision };
      }
      this.db.query("UPDATE turns SET completion_claim_revision = ?, updated_at = ? WHERE turn_ref = ?")
        .run(turn.revision, this.now(), turnRef);
      return { turnRef, revision: turn.revision };
    });
  }

  commitCompletion(claim: CompletionClaim, evidence: CompletionEvidence): BrokerTurn {
    if (!evidence.noUnresolvedGooseWork || !evidence.remoteNonRunning
      || !evidence.observedFinalDigest || !evidence.canonicalHistoryWatermark) {
      this.fail("COMPLETION_EVIDENCE", "Completion evidence is not conjunctively satisfied");
    }
    if (evidence.connectorFinal !== "ACKNOWLEDGED" && evidence.connectorFinal !== "UNAVAILABLE") {
      this.fail("COMPLETION_EVIDENCE", "Connector-final state is invalid");
    }
    return this.transaction(() => {
      const turn = this.turnRowRequired(claim.turnRef);
      if (turn.abandoned_at !== null || (turn.state !== "TURN_OUTSTANDING" && turn.state !== "UNRECONCILED")) {
        this.fail("TURN_STATE", "Only an outstanding or unreconciled turn can complete");
      }
      if (turn.revision !== claim.revision || turn.completion_claim_revision !== claim.revision) {
        this.fail("COMPLETION_STALE", "Completion CAS revision changed after begin");
      }
      if (this.hasUnresolvedOperation(claim.turnRef)) this.fail("UNRESOLVED_OPERATION", "Completion cannot commit with claimed or uncertain operations");
      this.requireSlotHolder(claim.turnRef);
      const epoch = this.epochRowRequired(turn.goose_session_id, turn.epoch);
      if (epoch.conversation_id !== evidence.canonicalConversationId
        || turn.accepted_user_turn_id !== evidence.acceptedUserTurnId) {
        this.fail("COMPLETION_EVIDENCE", "Completion identity evidence does not match the durable conversation/turn binding");
      }
      if (!turn.final_digest) this.fail("FINAL_DIGEST_REQUIRED", "Completion lost its durable final digest");
      if (turn.final_digest !== evidence.observedFinalDigest) {
        this.fail("COMPLETION_EVIDENCE", "Observed final digest does not match the durably acknowledged final");
      }
      this.assertAnswerBoundarySatisfied(claim.turnRef, evidence);

      const at = this.now();
      const result = this.db.query(`UPDATE turns SET state = 'COMPLETE', slot_held = 0, completion_claim_revision = NULL,
        budget_reserved_tokens = CASE WHEN budget_reserved_tokens IS NULL THEN NULL ELSE 0 END,
        revision = revision + 1, updated_at = ? WHERE turn_ref = ? AND slot_held = 1`)
        .run(at, claim.turnRef);
      if (result.changes !== 1) this.fail("ACCOUNT_SLOT", "Completion lost its account slot");
      this.releaseAccountSlotInside(claim.turnRef, at);
      this.db.query(`UPDATE remote_epochs SET history_watermark = ?, updated_at = ?
        WHERE goose_session_id = ? AND epoch = ?`)
        .run(evidence.canonicalHistoryWatermark, at, turn.goose_session_id, turn.epoch);
      return this.getTurnRequired(claim.turnRef);
    });
  }

  getTurn(turnRef: string): BrokerTurn | null {
    const row = this.turnRow(turnRef);
    return row ? turnFromRow(row) : null;
  }

  findInitialRequestReplay(gooseSessionId: string, requestHash: string): BrokerTurn | null {
    if (!gooseSessionId || !requestHash) this.fail("INVALID_TURN", "gooseSessionId and requestHash are required");
    const latest = this.db.query("SELECT * FROM turns WHERE goose_session_id = ? ORDER BY queue_seq DESC LIMIT 1")
      .get(gooseSessionId) as TurnRow | null;
    if (!latest || latest.request_hash !== requestHash
      || (latest.state === "CANCELLED" && latest.pre_send_retryable_cancelled === 1)) return null;
    return turnFromRow(latest);
  }

  getOpenTurnForSession(gooseSessionId: string): BrokerTurn | null {
    if (!gooseSessionId) this.fail("INVALID_SESSION", "gooseSessionId must not be empty");
    const row = this.db.query(`SELECT * FROM turns WHERE goose_session_id = ?
      AND abandoned_at IS NULL AND state IN ('QUEUED', 'TURN_OUTSTANDING', 'UNRECONCILED')
      ORDER BY queue_seq DESC LIMIT 1`).get(gooseSessionId) as TurnRow | null;
    return row ? turnFromRow(row) : null;
  }

  getOperation(opRef: string): BrokerOperation | null {
    const row = this.operationRow(opRef);
    return row ? operationFromRow(row) : null;
  }

  getInitialOperationForTurn(turnRef: string): BrokerOperation {
    this.turnRowRequired(turnRef);
    const row = this.db.query("SELECT * FROM operations WHERE turn_ref = ? ORDER BY seq ASC LIMIT 1")
      .get(turnRef) as OperationRow | null;
    if (!row) this.fail("UNKNOWN_OP_REF", "Turn has no operation journal");
    return operationFromRow(row);
  }

  hasBlockingOperation(turnRef: string): boolean {
    this.turnRowRequired(turnRef);
    return this.hasUnresolvedOperation(turnRef);
  }

  getLatestTerminalOperationForTurn(turnRef: string): BrokerOperation | null {
    this.turnRowRequired(turnRef);
    const row = this.db.query(`SELECT * FROM operations WHERE turn_ref = ?
      AND state IN ('SUCCESS', 'FAILURE') ORDER BY seq DESC LIMIT 1`).get(turnRef) as OperationRow | null;
    return row ? operationFromRow(row) : null;
  }

  getNextOperationForTurn(turnRef: string, seq: number): BrokerOperation | null {
    this.turnRowRequired(turnRef);
    const row = this.db.query("SELECT * FROM operations WHERE turn_ref = ? AND seq = ?")
      .get(turnRef, seq + 1) as OperationRow | null;
    return row ? operationFromRow(row) : null;
  }

  getAccountSlotHolders(): AccountSlotOwnership[] {
    return this.accountSlotHolders();
  }

  hasRecordedPositiveTerminalSlotRelease(turnRef: string): boolean {
    this.turnRowRequired(turnRef);
    return this.recordedSlotDemotionEvidence(turnRef) !== null;
  }

  getActiveAccountSlotCount(): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM account_slots WHERE turn_ref IS NOT NULL").get() as { count: number };
    return row.count;
  }

  getAccountSlotHolder(): string | null {
    return this.accountSlotHolders()[0]?.turnRef ?? null;
  }

  private claimBrokerOwnership(): void {
    this.transaction(() => {
      const row = this.db.query("SELECT owner_id, pid FROM broker_owner WHERE singleton = 1").get() as { owner_id: string | null; pid: number | null };
      if (row.owner_id && row.pid !== null && this.processIsAlive(row.pid)) {
        this.fail("BROKER_BUSY", "Another live Session Broker owns this database");
      }
      this.db.query("UPDATE broker_owner SET owner_id = ?, pid = ?, updated_at = ? WHERE singleton = 1")
        .run(this.instanceId, process.pid, this.now());
    });
  }

  private migrateSchema(): void {
    this.transaction(() => {
      const epochColumns = this.db.query("PRAGMA table_info(remote_epochs)").all() as Array<{ name: string }>;
      if (!epochColumns.some(column => column.name === "budget_policy_json")) {
        this.db.exec("ALTER TABLE remote_epochs ADD COLUMN budget_policy_json TEXT");
      }
      if (!epochColumns.some(column => column.name === "budget_consumed_tokens")) {
        // Legacy budget columns remain additive compatibility only. The current runtime
        // does not use local conversation estimates as execution or rollover authority.
        this.db.exec(`ALTER TABLE remote_epochs ADD COLUMN budget_consumed_tokens INTEGER
          CHECK (budget_consumed_tokens IS NULL OR budget_consumed_tokens >= 0)`);
      }

      const turnColumns = this.db.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
      if (!turnColumns.some(column => column.name === "abandoned_at")) {
        this.db.exec(`ALTER TABLE turns ADD COLUMN abandoned_at INTEGER CHECK (
          abandoned_at IS NULL OR (
            state = 'UNRECONCILED' AND slot_held = 0 AND positive_terminal_evidence_json IS NOT NULL
            AND final_digest IS NULL AND completion_claim_revision IS NULL
          )
        )`);
      }
      if (!turnColumns.some(column => column.name === "pre_send_retryable_cancelled")) {
        this.db.exec(`ALTER TABLE turns ADD COLUMN pre_send_retryable_cancelled INTEGER NOT NULL DEFAULT 0
          CHECK (pre_send_retryable_cancelled IN (0, 1))`);
      }
      if (!turnColumns.some(column => column.name === "budget_reserved_tokens")) {
        this.db.exec(`ALTER TABLE turns ADD COLUMN budget_reserved_tokens INTEGER
          CHECK (budget_reserved_tokens IS NULL OR budget_reserved_tokens >= 0)`);
      }
      if (!turnColumns.some(column => column.name === "budget_prompt_tokens")) {
        this.db.exec(`ALTER TABLE turns ADD COLUMN budget_prompt_tokens INTEGER
          CHECK (budget_prompt_tokens IS NULL OR budget_prompt_tokens >= 0)`);
      }
      if (!turnColumns.some(column => column.name === "budget_growth_consumed_tokens")) {
        this.db.exec(`ALTER TABLE turns ADD COLUMN budget_growth_consumed_tokens INTEGER
          CHECK (budget_growth_consumed_tokens IS NULL OR budget_growth_consumed_tokens >= 0)`);
      }

      const operationColumns = this.db.query("PRAGMA table_info(operations)").all() as Array<{ name: string }>;
      if (!operationColumns.some(column => column.name === "budget_reserved_tokens")) {
        this.db.exec(`ALTER TABLE operations ADD COLUMN budget_reserved_tokens INTEGER NOT NULL DEFAULT 0
          CHECK (budget_reserved_tokens >= 0)`);
      }
      if (!operationColumns.some(column => column.name === "budget_charge_tokens")) {
        this.db.exec(`ALTER TABLE operations ADD COLUMN budget_charge_tokens INTEGER
          CHECK (budget_charge_tokens IS NULL OR budget_charge_tokens >= 0)`);
      }

      const legacySlotHolders = this.db.query("SELECT turn_ref FROM turns WHERE slot_held = 1 ORDER BY queue_seq ASC")
        .all() as Array<{ turn_ref: string }>;
      const durableSlotHolders = this.accountSlotHolders();
      if (durableSlotHolders.length === 0 && legacySlotHolders.length === 1) {
        this.db.query("UPDATE account_slots SET turn_ref = ?, updated_at = ? WHERE slot_id = 1 AND turn_ref IS NULL")
          .run(legacySlotHolders[0]!.turn_ref, this.now());
      } else if (durableSlotHolders.length === 0 && legacySlotHolders.length > 1) {
        this.fail("JOURNAL_CORRUPT", "Legacy broker contains more account-slot holders than its schema allowed");
      }
      this.db.exec("DROP INDEX IF EXISTS one_account_slot_holder");
      this.assertAccountSlotIntegrity();

      const openTurnIndex = this.db.query(`SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'one_open_turn_per_epoch'`).get() as { sql: string | null } | null;
      if (!openTurnIndex?.sql?.includes("abandoned_at IS NULL")) {
        this.db.exec(`DROP INDEX IF EXISTS one_open_turn_per_epoch;
          CREATE UNIQUE INDEX one_open_turn_per_epoch ON turns(goose_session_id, epoch)
          WHERE abandoned_at IS NULL AND state IN ('QUEUED', 'TURN_OUTSTANDING', 'UNRECONCILED');`);
      }
      const invalid = this.db.query(`SELECT turn_ref FROM turns WHERE abandoned_at IS NOT NULL AND (
        state <> 'UNRECONCILED' OR slot_held <> 0 OR positive_terminal_evidence_json IS NULL
        OR final_digest IS NOT NULL OR completion_claim_revision IS NOT NULL
      ) LIMIT 1`).get() as { turn_ref: string } | null;
      if (invalid) this.fail("JOURNAL_CORRUPT", "Persisted abandoned turn violates quarantine invariants");
      const foreignKeyErrors = this.db.query("PRAGMA foreign_key_check").all();
      if (foreignKeyErrors.length > 0) this.fail("JOURNAL_CORRUPT", "Session Broker schema migration failed foreign-key validation");
    });
  }

  private assertProjectBinding(): void {
    const mismatch = this.db.query("SELECT project_id FROM remote_epochs WHERE project_id <> ? LIMIT 1")
      .get(this.projectId) as { project_id: string } | null;
    if (mismatch) {
      this.fail("PROJECT_MISMATCH", "Persisted Session Broker state belongs to a different ChatGPT Project");
    }
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private recoverAfterRestart(): void {
    this.transaction(() => {
      const at = this.now();
      // Older rebuild checkpoints recorded abandonment on the turn but left that epoch current.
      // Repair that additive state on open so an explicitly retired remote conversation can never
      // become an append target after provider restart or upgrade.
      this.db.query(`UPDATE remote_epochs SET is_current = 0, updated_at = ?
        WHERE is_current = 1 AND EXISTS (
          SELECT 1 FROM turns
          WHERE turns.goose_session_id = remote_epochs.goose_session_id
            AND turns.epoch = remote_epochs.epoch
            AND turns.abandoned_at IS NOT NULL
        )`).run(at);
      // QUEUED is strictly before the durable send fence. After process restart its HTTP owner is
      // gone, so retaining it would let an ownerless FIFO entry retain one of the bounded account slots.
      // Make it retryable-cancelled: exact Goose replay can create a fresh pre-send attempt.
      this.db.query(`UPDATE account_slots SET turn_ref = NULL, updated_at = ?
        WHERE turn_ref IN (SELECT turn_ref FROM turns WHERE state = 'QUEUED')`).run(at);
      this.db.query(`UPDATE turns SET state = 'CANCELLED', slot_held = 0,
        pre_send_retryable_cancelled = 1, completion_claim_revision = NULL,
        budget_reserved_tokens = CASE WHEN budget_reserved_tokens IS NULL THEN NULL ELSE 0 END,
        revision = revision + 1, updated_at = ? WHERE state = 'QUEUED'`)
        .run(at);

      const claimed = this.db.query("SELECT turn_ref FROM operations WHERE state = 'CLAIMED'")
        .all() as Array<{ turn_ref: string }>;
      this.db.query("UPDATE operations SET state = 'UNCERTAIN', owner_id = NULL, updated_at = ? WHERE state = 'CLAIMED'")
        .run(at);

      // A broker restart invalidates any completion claim because Requirement 10
      // requires the terminal observation to be fresh after begin(). Durable final
      // evidence remains, so reconciliation can begin a new claim after restart.
      const interrupted = this.db.query(`SELECT turn_ref FROM turns
        WHERE abandoned_at IS NULL AND (state = 'TURN_OUTSTANDING' OR completion_claim_revision IS NOT NULL)`)
        .all() as Array<{ turn_ref: string }>;
      const affected = new Set(interrupted.map(row => row.turn_ref));

      for (const turnRef of affected) {
        this.db.query(`UPDATE turns SET state = 'UNRECONCILED',
          unreconciled_reason = COALESCE(unreconciled_reason, 'broker_restart_with_remote_turn'),
          completion_claim_revision = NULL, revision = revision + 1, updated_at = ? WHERE turn_ref = ?`)
          .run(at, turnRef);
      }

      for (const { turn_ref: turnRef } of claimed) {
        if (affected.has(turnRef)) continue;
        const turn = this.turnRowRequired(turnRef);
        if (turn.state === "COMPLETE" || turn.state === "CANCELLED" || turn.abandoned_at !== null) {
          this.fail("JOURNAL_CORRUPT", "Terminal turn contains a nonterminal operation claim");
        }
        this.db.query(`UPDATE turns SET state = 'UNRECONCILED', unreconciled_reason = COALESCE(unreconciled_reason, 'stale_claim_after_broker_restart'),
          completion_claim_revision = NULL, revision = revision + 1, updated_at = ? WHERE turn_ref = ?`)
          .run(at, turnRef);
      }
      this.assertAccountSlotIntegrity();
    });
  }

  private finishOperationInside(input: {
    opRef: string;
    inputHash: string;
    outcome: TerminalOperationState;
    resultJson: string;
  }, allowUncertain: boolean): { operation: BrokerOperation; nextOpRef: string } {
    const op = this.operationRowRequired(input.opRef);
    if (op.input_hash !== input.inputHash) this.fail("OP_REF_CONFLICT", "Operation input hash does not match its durable claim");
    if (op.state === "SUCCESS" || op.state === "FAILURE") {
      if (op.state !== input.outcome || op.result_json !== input.resultJson) {
        this.fail("TERMINAL_CONFLICT", "Operation already has a different terminal result");
      }
      const nextOpRef = this.nextOpRef(op.turn_ref, op.seq);
      if (!nextOpRef) this.fail("JOURNAL_CORRUPT", "Terminal operation is missing its next minted ref");
      return { operation: operationFromRow(op), nextOpRef };
    }
    const ownedClaim = op.state === "CLAIMED" && op.owner_id === this.instanceId;
    const late = allowUncertain && op.state === "UNCERTAIN";
    if (!ownedClaim && !late) this.fail("OP_STATE", "Operation cannot accept this terminal result");

    const at = this.now();
    this.db.query(`UPDATE operations SET state = ?, result_json = ?, owner_id = NULL,
      budget_reserved_tokens = 0, budget_charge_tokens = NULL, terminal_at = ?, updated_at = ?
      WHERE op_ref = ?`)
      .run(input.outcome, input.resultJson, at, at, input.opRef);
    this.bumpTurnRevision(op.turn_ref);
    let nextOpRef = this.nextOpRef(op.turn_ref, op.seq);
    if (!nextOpRef) nextOpRef = this.mintOperation(op.turn_ref, op.seq + 1);
    return { operation: this.getOperationRequired(input.opRef), nextOpRef };
  }

  private assertAnswerBoundarySatisfied(turnRef: string, evidence: CompletionEvidence): void {
    const latest = this.db.query(`SELECT op_ref, answer_boundary_json FROM operations
      WHERE turn_ref = ? AND state IN ('SUCCESS', 'FAILURE') ORDER BY seq DESC LIMIT 1`)
      .get(turnRef) as { op_ref: string; answer_boundary_json: string | null } | null;
    if (!latest) {
      if (evidence.answerBoundary !== null) this.fail("COMPLETION_EVIDENCE", "No dispatched operation requires answer-boundary evidence");
      return;
    }
    if (!latest.answer_boundary_json) this.fail("JOURNAL_CORRUPT", "Terminal operation is missing its durable answer boundary");
    if (!evidence.answerBoundary || evidence.answerBoundary.opRef !== latest.op_ref) {
      this.fail("COMPLETION_EVIDENCE", "Completion must reference the latest dispatched operation boundary");
    }
    if (!evidence.answerBoundary.contentAdvanced && !evidence.answerBoundary.qualifiedTerminal) {
      this.fail("COMPLETION_EVIDENCE", "Completion must prove post-tool content or qualified terminal semantics");
    }
  }

  private markUnreconciledInside(turnRef: string, reason: string): BrokerTurn {
    const turn = this.turnRowRequired(turnRef);
    if (turn.state === "UNRECONCILED") return turnFromRow(turn);
    if (turn.state !== "TURN_OUTSTANDING") {
      this.fail("TURN_STATE", "Only a remotely outstanding turn can become unreconciled");
    }
    this.requireSlotHolder(turnRef);
    this.db.query(`UPDATE turns SET state = 'UNRECONCILED', unreconciled_reason = ?, completion_claim_revision = NULL,
      revision = revision + 1, updated_at = ? WHERE turn_ref = ?`)
      .run(reason, this.now(), turnRef);
    return this.getTurnRequired(turnRef);
  }

  private bindConversationInside(input: {
    gooseSessionId: string;
    epoch: number;
    conversationId: string;
  }): void {
    const row = this.epochRowRequired(input.gooseSessionId, input.epoch);
    if (row.is_current !== 1) this.fail("STALE_EPOCH", "Only the current epoch may bind a conversation");
    if (row.conversation_id && row.conversation_id !== input.conversationId) {
      this.fail("CONVERSATION_CONFLICT", "Remote epoch is already bound to another canonical conversation");
    }
    const existing = this.db.query("SELECT goose_session_id, epoch FROM remote_epochs WHERE conversation_id = ?")
      .get(input.conversationId) as { goose_session_id: string; epoch: number } | null;
    if (existing && (existing.goose_session_id !== input.gooseSessionId || existing.epoch !== input.epoch)) {
      this.fail("CONVERSATION_CONFLICT", "Canonical conversation is already bound to another epoch");
    }
    if (!row.conversation_id) {
      this.db.query(`UPDATE remote_epochs SET conversation_id = ?, updated_at = ?
        WHERE goose_session_id = ? AND epoch = ?`)
        .run(input.conversationId, this.now(), input.gooseSessionId, input.epoch);
    }
  }

  private bindAcceptedUserTurnId(turn: TurnRow, acceptedUserTurnId: string): void {
    if (turn.accepted_user_turn_id && turn.accepted_user_turn_id !== acceptedUserTurnId) {
      this.fail("USER_TURN_CONFLICT", "Accepted user turn is already bound to another identity");
    }
    if (!turn.accepted_user_turn_id) {
      this.db.query("UPDATE turns SET accepted_user_turn_id = ?, completion_claim_revision = NULL, revision = revision + 1, updated_at = ? WHERE turn_ref = ?")
        .run(acceptedUserTurnId, this.now(), turn.turn_ref);
    }
  }

  private mintOperation(turnRef: string, seq: number): string {
    const opRef = this.makeOpRef();
    if (!opRef) this.fail("INVALID_OP_REF", "Operation reference factory returned an empty value");
    this.insertOperation(opRef, turnRef, seq);
    return opRef;
  }

  private insertOperation(opRef: string, turnRef: string, seq: number): void {
    const at = this.now();
    this.db.query(`INSERT INTO operations(
      op_ref, turn_ref, seq, state, input_hash, result_json, owner_id,
      answer_boundary_json, budget_reserved_tokens, budget_charge_tokens, created_at, updated_at, terminal_at
    ) VALUES (?, ?, ?, 'MINTED', NULL, NULL, NULL, NULL, 0, NULL, ?, ?, NULL)`)
      .run(opRef, turnRef, seq, at, at);
  }

  private operationRefAt(turnRef: string, seq: number): string | null {
    const row = this.db.query("SELECT op_ref FROM operations WHERE turn_ref = ? AND seq = ?")
      .get(turnRef, seq) as { op_ref: string } | null;
    return row?.op_ref ?? null;
  }

  private nextOpRef(turnRef: string, seq: number): string | null {
    return this.operationRefAt(turnRef, seq + 1);
  }

  private hasNonterminalTurn(gooseSessionId: string, epoch: number): boolean {
    const row = this.db.query(`SELECT 1 AS value FROM turns WHERE goose_session_id = ? AND epoch = ?
      AND abandoned_at IS NULL AND state IN ('QUEUED', 'TURN_OUTSTANDING', 'UNRECONCILED') LIMIT 1`)
      .get(gooseSessionId, epoch) as { value: number } | null;
    return Boolean(row);
  }

  private hasAmbiguousOperation(turnRef: string): boolean {
    const row = this.db.query("SELECT 1 AS value FROM operations WHERE turn_ref = ? AND state IN ('CLAIMED', 'UNCERTAIN') LIMIT 1")
      .get(turnRef) as { value: number } | null;
    return Boolean(row);
  }

  private hasUnresolvedOperation(turnRef: string): boolean {
    const row = this.db.query(`SELECT 1 AS value FROM operations WHERE turn_ref = ? AND (
      state IN ('CLAIMED', 'UNCERTAIN') OR (state = 'MINTED' AND answer_boundary_json IS NOT NULL)
    ) LIMIT 1`).get(turnRef) as { value: number } | null;
    return Boolean(row);
  }

  private recordedSlotDemotionEvidence(turnRef: string): string | null {
    const row = this.db.query("SELECT positive_terminal_evidence_json AS evidence FROM turns WHERE turn_ref = ?")
      .get(turnRef) as { evidence: string | null } | null;
    return row?.evidence ?? null;
  }

  private bumpTurnRevision(turnRef: string): void {
    this.db.query("UPDATE turns SET completion_claim_revision = NULL, revision = revision + 1, updated_at = ? WHERE turn_ref = ?")
      .run(this.now(), turnRef);
  }

  private requireSlotHolder(turnRef: string): void {
    if (this.accountSlotForTurn(turnRef) === null) this.fail("ACCOUNT_SLOT", "Turn does not own an account execution slot");
  }

  private accountSlotForTurn(turnRef: string): 1 | 2 | null {
    const row = this.db.query("SELECT slot_id FROM account_slots WHERE turn_ref = ?").get(turnRef) as { slot_id: 1 | 2 } | null;
    return row?.slot_id ?? null;
  }

  private accountSlotHolders(): AccountSlotOwnership[] {
    const rows = this.db.query("SELECT slot_id, turn_ref FROM account_slots WHERE turn_ref IS NOT NULL ORDER BY slot_id ASC")
      .all() as Array<{ slot_id: 1 | 2; turn_ref: string }>;
    return rows.map(row => ({ slotId: row.slot_id, turnRef: row.turn_ref }));
  }

  private releaseAccountSlotInside(turnRef: string, at: number): void {
    const result = this.db.query("UPDATE account_slots SET turn_ref = NULL, updated_at = ? WHERE turn_ref = ?")
      .run(at, turnRef);
    if (result.changes !== 1) this.fail("ACCOUNT_SLOT", "Turn lost its durable account-slot ownership");
  }

  private releaseAccountSlotIfHeldInside(turnRef: string, at: number): void {
    const result = this.db.query("UPDATE account_slots SET turn_ref = NULL, updated_at = ? WHERE turn_ref = ?")
      .run(at, turnRef);
    if (result.changes > 1) this.fail("JOURNAL_CORRUPT", "Turn owns more than one durable account slot");
  }

  private assertAccountSlotIntegrity(): void {
    const slots = this.db.query("SELECT slot_id, turn_ref FROM account_slots ORDER BY slot_id ASC")
      .all() as Array<{ slot_id: number; turn_ref: string | null }>;
    if (slots.length !== 2 || slots[0]?.slot_id !== 1 || slots[1]?.slot_id !== 2) {
      this.fail("JOURNAL_CORRUPT", "Broker must contain exactly durable account slots 1 and 2");
    }
    const durable = new Set(slots.flatMap(slot => slot.turn_ref ? [slot.turn_ref] : []));
    const mirrored = (this.db.query("SELECT turn_ref FROM turns WHERE slot_held = 1").all() as Array<{ turn_ref: string }>)
      .map(row => row.turn_ref);
    if (durable.size !== mirrored.length || mirrored.some(turnRef => !durable.has(turnRef))) {
      this.fail("JOURNAL_CORRUPT", "Durable account-slot ownership disagrees with turn slot markers");
    }
  }

  private currentEpochRow(gooseSessionId: string): EpochRow | null {
    return this.db.query("SELECT * FROM remote_epochs WHERE goose_session_id = ? AND is_current = 1")
      .get(gooseSessionId) as EpochRow | null;
  }

  private epochRow(gooseSessionId: string, epoch: number): EpochRow | null {
    return this.db.query("SELECT * FROM remote_epochs WHERE goose_session_id = ? AND epoch = ?")
      .get(gooseSessionId, epoch) as EpochRow | null;
  }

  private epochRowRequired(gooseSessionId: string, epoch: number): EpochRow {
    const row = this.epochRow(gooseSessionId, epoch);
    if (!row) this.fail("UNKNOWN_EPOCH", "Remote epoch does not exist");
    return row;
  }

  private getEpochRequired(gooseSessionId: string, epoch: number): RemoteEpoch {
    return this.epochFromRow(this.epochRowRequired(gooseSessionId, epoch));
  }

  private epochFromRow(row: EpochRow): RemoteEpoch {
    const lease = this.db.query(`SELECT turn_ref, state FROM turns
      WHERE goose_session_id = ? AND epoch = ? AND abandoned_at IS NULL
      AND state IN ('TURN_OUTSTANDING', 'UNRECONCILED') LIMIT 1`)
      .get(row.goose_session_id, row.epoch) as { turn_ref: string; state: StoredTurnState } | null;
    return epochFromRow(row, lease
      ? { state: lease.state === "UNRECONCILED" ? "UNRECONCILED" : "TURN_OUTSTANDING", turnRef: lease.turn_ref }
      : { state: "IDLE", turnRef: null });
  }

  private turnRow(turnRef: string): TurnRow | null {
    return this.db.query("SELECT * FROM turns WHERE turn_ref = ?").get(turnRef) as TurnRow | null;
  }

  private turnRowRequired(turnRef: string): TurnRow {
    const row = this.turnRow(turnRef);
    if (!row) this.fail("UNKNOWN_TURN", "Broker turn does not exist");
    return row;
  }

  private getTurnRequired(turnRef: string): BrokerTurn {
    return turnFromRow(this.turnRowRequired(turnRef));
  }

  private operationRow(opRef: string): OperationRow | null {
    return this.db.query("SELECT * FROM operations WHERE op_ref = ?").get(opRef) as OperationRow | null;
  }

  private operationRowRequired(opRef: string): OperationRow {
    const row = this.operationRow(opRef);
    if (!row) this.fail("UNKNOWN_OP_REF", "Operation reference does not exist");
    return row;
  }

  private getOperationRequired(opRef: string): BrokerOperation {
    return operationFromRow(this.operationRowRequired(opRef));
  }

  private transaction<T>(body: () => T): T {
    return this.db.transaction(body)();
  }

  private fail(code: string, message: string): never {
    throw new SessionBrokerError(code, message);
  }
}
