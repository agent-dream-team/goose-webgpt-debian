import { canonicalJson } from "./canonical-json";
import {
  classifyGooseResponsesContinuation,
  decodeGooseResponsesProjectionCheckpoint,
  encodeGooseResponsesProjectionCheckpoint,
  gooseResponsesProjectionCheckpoint,
  type ExpectedGooseToolCall,
  type GooseResponsesProjectionCheckpoint,
} from "./goose-responses-projection";

export interface GooseToolDispatchRequest {
  turnRef: string;
  opRef: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface GooseToolFunctionCallDirective extends ExpectedGooseToolCall {
  kind: "FUNCTION_CALL";
}

export interface GooseToolContinuationCandidate {
  readonly output: string;
  readonly checkpointJson: string;
  /** Activate the already-observed next Goose stage after the broker atomically commits progress+terminal state. */
  commit(): void;
  /** Quarantine the live turn if that atomic commit fails after the local Goose tool may have executed. */
  abort(): void;
}

export interface GooseResponsesStageHandle {
  readonly turnRef: string;
  readonly checkpoint: GooseResponsesProjectionCheckpoint;
  /** Exact function names advertised by this live Goose Responses stage, in request order. */
  readonly advertisedToolNames: readonly string[];
  waitForDirective(): Promise<GooseToolFunctionCallDirective>;
  /** Release only a stage that has not emitted a provider function_call. */
  releaseBeforeDispatch(): boolean;
}

export class GooseToolRendezvousError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "GooseToolRendezvousError";
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface StageState {
  turnRef: string;
  checkpoint: GooseResponsesProjectionCheckpoint;
  toolNames: ReadonlySet<string>;
  directive: Deferred<GooseToolFunctionCallDirective>;
  lifecycle: "pending" | "active" | "emitted" | "released";
}

interface AwaitingContinuation {
  expectedTool: ExpectedGooseToolCall;
  previous: GooseResponsesProjectionCheckpoint;
  toolNames: ReadonlySet<string>;
  result: Deferred<GooseToolContinuationCandidate>;
  candidateCreated: boolean;
}

export function advertisedGooseToolNames(body: unknown): ReadonlySet<string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GooseToolRendezvousError("TOOL_REGISTRY_INVALID", "Goose Responses request must be an object");
  }
  const tools = (body as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return new Set();
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const entry = tool as Record<string, unknown>;
    if (entry.type !== "function") continue;
    if (typeof entry.name !== "string" || !entry.name) {
      throw new GooseToolRendezvousError("TOOL_REGISTRY_INVALID", "Advertised Goose function tool is missing its name");
    }
    if (names.has(entry.name)) {
      throw new GooseToolRendezvousError("TOOL_REGISTRY_AMBIGUOUS", `Advertised Goose function tool name is duplicated: ${entry.name}`);
    }
    names.add(entry.name);
  }
  return names;
}

export interface GooseToolRendezvousOptions {
  /** Read the broker-owned current projection checkpoint; no raw Responses content is persisted here. */
  loadCheckpoint(turnRef: string): string | null;
}

/**
 * Process-local baton between one Goose Responses stage and one serial connector operation.
 * Raw tool identity/arguments intentionally die with this process. Broker recovery then owns all
 * durable CLAIMED/UNCERTAIN reconciliation; hashes or persistent history never reconstruct a call.
 */
export class GooseToolRendezvous {
  private readonly currentStages = new Map<string, StageState>();
  private readonly awaitingContinuations = new Map<string, AwaitingContinuation>();
  private readonly quarantinedTurns = new Set<string>();

  constructor(private readonly options: GooseToolRendezvousOptions) {}

  openStage(input: { turnRef: string; body: unknown }): GooseResponsesStageHandle {
    if (this.quarantinedTurns.has(input.turnRef)) {
      throw new GooseToolRendezvousError("TURN_UNCERTAIN", "Live Goose stage authority is quarantined after an ambiguous tool result commit");
    }
    const awaiting = this.awaitingContinuations.get(input.turnRef);
    if (awaiting) return this.acceptContinuation(input.turnRef, input.body, awaiting);

    const checkpoint = gooseResponsesProjectionCheckpoint(input.body);
    const toolNames = advertisedGooseToolNames(input.body);
    this.requireDurableCheckpoint(input.turnRef, checkpoint);
    if (this.currentStages.has(input.turnRef)) {
      throw new GooseToolRendezvousError(
        "STAGE_ALREADY_OPEN",
        "A Goose Responses stage already owns this remote turn; a retry must first prove the prior HTTP owner is gone",
      );
    }
    const stage = this.makeStage(input.turnRef, checkpoint, toolNames, "active");
    this.currentStages.set(input.turnRef, stage);
    return this.handleFor(stage);
  }

  resolveToolName(turnRef: string, requestedToolName: string): string {
    if (this.quarantinedTurns.has(turnRef)) {
      throw new GooseToolRendezvousError("TURN_UNCERTAIN", "Live Goose stage authority is quarantined");
    }
    const toolNames = this.currentStages.get(turnRef)?.toolNames ?? this.awaitingContinuations.get(turnRef)?.toolNames;
    if (!toolNames) {
      throw new GooseToolRendezvousError("STAGE_UNAVAILABLE", "No live Goose Responses stage can authorize a tool name");
    }
    if (toolNames.has(requestedToolName)) return requestedToolName;
    const separator = requestedToolName.lastIndexOf("__");
    if (separator > 0) {
      const unqualified = requestedToolName.slice(separator + 2);
      if (unqualified && toolNames.has(unqualified)) return unqualified;
    }
    throw new GooseToolRendezvousError("TOOL_UNAVAILABLE", `Requested Goose tool is not advertised by the active Responses stage: ${requestedToolName}`);
  }

  async dispatchTool(request: GooseToolDispatchRequest): Promise<GooseToolContinuationCandidate> {
    if (this.quarantinedTurns.has(request.turnRef)) {
      throw new GooseToolRendezvousError("TURN_UNCERTAIN", "Live Goose stage authority is quarantined");
    }
    if (this.awaitingContinuations.has(request.turnRef)) {
      throw new GooseToolRendezvousError("CONTINUATION_PENDING", "A Goose tool continuation is already pending for this turn");
    }
    const stage = this.currentStages.get(request.turnRef);
    if (!stage || stage.lifecycle !== "active") {
      throw new GooseToolRendezvousError(
        "STAGE_UNAVAILABLE",
        "No live Goose Responses stage can receive this claimed operation; never reconstruct or redispatch after stage loss",
      );
    }

    const expectedTool: ExpectedGooseToolCall = {
      opRef: request.opRef,
      toolName: request.toolName,
      // Canonicalize exactly once; this same literal string is emitted and later compared.
      argumentsJson: canonicalJson(request.arguments),
    };
    const result = deferred<GooseToolContinuationCandidate>();
    this.awaitingContinuations.set(request.turnRef, {
      expectedTool,
      previous: stage.checkpoint,
      toolNames: stage.toolNames,
      result,
      candidateCreated: false,
    });

    // The continuation waiter is live before the function_call can leave this process.
    stage.lifecycle = "emitted";
    this.currentStages.delete(request.turnRef);
    stage.directive.resolve({ kind: "FUNCTION_CALL", ...expectedTool });
    return result.promise;
  }

  private acceptContinuation(
    turnRef: string,
    body: unknown,
    awaiting: AwaitingContinuation,
  ): GooseResponsesStageHandle {
    if (awaiting.candidateCreated) {
      throw new GooseToolRendezvousError(
        "CONTINUATION_ALREADY_ACCEPTED",
        "A Goose tool-result POST already owns the pending next stage",
      );
    }
    const durable = decodeGooseResponsesProjectionCheckpoint(this.options.loadCheckpoint(turnRef));
    if (encodeGooseResponsesProjectionCheckpoint(durable) !== encodeGooseResponsesProjectionCheckpoint(awaiting.previous)) {
      throw new GooseToolRendezvousError("DURABLE_CHECKPOINT_DRIFT", "Broker progress changed outside the live Goose tool continuation");
    }
    const decision = classifyGooseResponsesContinuation({ body, previous: awaiting.previous, expectedTool: awaiting.expectedTool });
    if (decision.kind === "REPLAY") {
      throw new GooseToolRendezvousError(
        "STALE_STAGE_REPLAY",
        "The already-dispatched Goose Responses stage was replayed; refusing to re-emit a possibly side-effecting function_call",
      );
    }
    if (decision.kind === "DIVERGED") {
      throw new GooseToolRendezvousError("CONTINUATION_DIVERGED", decision.reason);
    }

    awaiting.candidateCreated = true;
    const pending = this.makeStage(turnRef, decision.checkpoint, advertisedGooseToolNames(body), "pending");
    const checkpointJson = encodeGooseResponsesProjectionCheckpoint(decision.checkpoint);
    const candidate: GooseToolContinuationCandidate = {
      output: decision.output,
      checkpointJson,
      commit: () => {
        if (this.awaitingContinuations.get(turnRef) !== awaiting) return;
        this.awaitingContinuations.delete(turnRef);
        if (pending.lifecycle === "pending") {
          pending.lifecycle = "active";
          this.currentStages.set(turnRef, pending);
        }
      },
      abort: () => {
        if (this.awaitingContinuations.get(turnRef) === awaiting) this.awaitingContinuations.delete(turnRef);
        this.quarantinedTurns.add(turnRef);
        if (pending.lifecycle === "pending") {
          pending.lifecycle = "released";
          pending.directive.reject(new GooseToolRendezvousError(
            "TURN_UNCERTAIN",
            "Atomic broker commit failed after the Goose tool may have executed",
          ));
          void pending.directive.promise.catch(() => {});
        }
      },
    };
    awaiting.result.resolve(candidate);
    return this.handleFor(pending);
  }

  private requireDurableCheckpoint(turnRef: string, checkpoint: GooseResponsesProjectionCheckpoint): void {
    const durable = decodeGooseResponsesProjectionCheckpoint(this.options.loadCheckpoint(turnRef));
    if (encodeGooseResponsesProjectionCheckpoint(checkpoint) !== encodeGooseResponsesProjectionCheckpoint(durable)) {
      throw new GooseToolRendezvousError(
        "STAGE_CHECKPOINT_MISMATCH",
        "Goose Responses stage does not match the broker's current durable projection; stale history cannot become current",
      );
    }
  }

  private makeStage(
    turnRef: string,
    checkpoint: GooseResponsesProjectionCheckpoint,
    toolNames: ReadonlySet<string>,
    lifecycle: StageState["lifecycle"],
  ): StageState {
    return { turnRef, checkpoint, toolNames, directive: deferred<GooseToolFunctionCallDirective>(), lifecycle };
  }

  private handleFor(stage: StageState): GooseResponsesStageHandle {
    return {
      turnRef: stage.turnRef,
      checkpoint: stage.checkpoint,
      advertisedToolNames: [...stage.toolNames],
      waitForDirective: () => stage.directive.promise,
      releaseBeforeDispatch: () => {
        if (stage.lifecycle === "pending") {
          stage.lifecycle = "released";
          stage.directive.reject(new GooseToolRendezvousError("STAGE_RELEASED", "Pending Goose HTTP owner disappeared before activation"));
          void stage.directive.promise.catch(() => {});
          return true;
        }
        if (stage.lifecycle !== "active" || this.currentStages.get(stage.turnRef) !== stage) return false;
        this.currentStages.delete(stage.turnRef);
        stage.lifecycle = "released";
        stage.directive.reject(new GooseToolRendezvousError("STAGE_RELEASED", "Goose Responses stage owner disappeared before dispatch"));
        void stage.directive.promise.catch(() => {});
        return true;
      },
    };
  }
}
