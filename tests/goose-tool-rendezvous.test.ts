import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/canonical-json";
import { encodeGooseResponsesProjectionCheckpoint, gooseResponsesProjectionCheckpoint } from "../src/goose-responses-projection";
import { GooseToolRendezvous, GooseToolRendezvousError, type GooseToolContinuationCandidate } from "../src/goose-tool-rendezvous";

function initialBody() {
  return {
    model: "gpt-4.1",
    stream: true,
    input: [
      { role: "system", content: [{ type: "input_text", text: "system" }] },
      { role: "user", content: [{ type: "input_text", text: "user" }] },
    ],
    tools: [{ type: "function", name: "tree", parameters: { type: "object" } }],
  };
}

function continuationBody(previous: ReturnType<typeof initialBody>, opRef: string, toolName: string, args: Record<string, unknown>, output: string) {
  return {
    ...previous,
    input: [
      ...previous.input,
      { type: "function_call", call_id: opRef, name: toolName, arguments: canonicalJson(args) },
      { type: "function_call_output", call_id: opRef, output },
    ],
  };
}

function fixture(body = initialBody()) {
  let durable = encodeGooseResponsesProjectionCheckpoint(gooseResponsesProjectionCheckpoint(body));
  const rendezvous = new GooseToolRendezvous({ loadCheckpoint: () => durable });
  const commit = (candidate: GooseToolContinuationCandidate) => {
    durable = candidate.checkpointJson;
    candidate.commit();
  };
  return { rendezvous, durable: () => durable, commit };
}


describe("GooseToolRendezvous", () => {
  test("continuation waiter exists before function_call release and committed progress activates next ownership", async () => {
    const { rendezvous, commit } = fixture();
    const body = initialBody();
    const stage = rendezvous.openStage({ turnRef: "turn-a", body });
    const result = rendezvous.dispatchTool({ turnRef: "turn-a", opRef: "op-1", toolName: "tree", arguments: { path: "." } });
    expect(await stage.waitForDirective()).toEqual({ kind: "FUNCTION_CALL", opRef: "op-1", toolName: "tree", argumentsJson: '{"path":"."}' });
    const nextBody = continuationBody(body, "op-1", "tree", { path: "." }, "tool-output");
    const nextStage = rendezvous.openStage({ turnRef: "turn-a", body: nextBody });
    const candidate = await result;
    expect(candidate.output).toBe("tool-output");
    expect(nextStage.releaseBeforeDispatch()).toBe(true);
    commit(candidate);
    const reacquired = rendezvous.openStage({ turnRef: "turn-a", body: nextBody });
    expect(reacquired.checkpoint.inputCount).toBe(4);
  });

  test("stage handle exposes only the exact advertised Goose function names", () => {
    const body = initialBody();
    (body.tools as Array<Record<string, unknown>>).push({
      type: "function", name: "shell",
      description: "PRIVATE_TOOL_DESCRIPTION",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    });
    const { rendezvous } = fixture(body);
    const stage = rendezvous.openStage({ turnRef: "turn-a", body });
    expect(stage.advertisedToolNames).toEqual(["tree", "shell"]);
    expect(JSON.stringify(stage.advertisedToolNames)).not.toContain("parameters");
    expect(JSON.stringify(stage.advertisedToolNames)).not.toContain("PRIVATE_TOOL_DESCRIPTION");
    expect(stage.releaseBeforeDispatch()).toBe(true);
  });

  test("active Goose registry resolves connector-qualified aliases and rejects unknown tools", () => {
    const { rendezvous } = fixture();
    const body = initialBody();
    const stage = rendezvous.openStage({ turnRef: "turn-a", body });
    expect(rendezvous.resolveToolName("turn-a", "tree")).toBe("tree");
    expect(rendezvous.resolveToolName("turn-a", "developer__tree")).toBe("tree");
    expect(() => rendezvous.resolveToolName("turn-a", "developer__shell")).toThrow(GooseToolRendezvousError);
    try { rendezvous.resolveToolName("turn-a", "developer__shell"); } catch (error) {
      expect((error as GooseToolRendezvousError).code).toBe("TOOL_UNAVAILABLE");
    }
    expect(stage.releaseBeforeDispatch()).toBe(true);
  });

  test("exact advertised namespaced tool wins over compatibility alias resolution", () => {
    const body = initialBody();
    body.tools.push({ type: "function", name: "developer__tree", parameters: { type: "object" } });
    const { rendezvous } = fixture(body);
    const stage = rendezvous.openStage({ turnRef: "turn-a", body });
    expect(rendezvous.resolveToolName("turn-a", "developer__tree")).toBe("developer__tree");
    expect(stage.releaseBeforeDispatch()).toBe(true);
  });

  test("serial tool rounds activate each next stage only after the durable commit", async () => {
    const { rendezvous, commit } = fixture();
    const firstBody = initialBody();
    const firstStage = rendezvous.openStage({ turnRef: "turn-a", body: firstBody });
    const firstResult = rendezvous.dispatchTool({ turnRef: "turn-a", opRef: "op-1", toolName: "tree", arguments: { path: "." } });
    await firstStage.waitForDirective();
    const secondBody = continuationBody(firstBody, "op-1", "tree", { path: "." }, "one");
    const secondStage = rendezvous.openStage({ turnRef: "turn-a", body: secondBody });
    commit(await firstResult);
    const secondResult = rendezvous.dispatchTool({ turnRef: "turn-a", opRef: "op-2", toolName: "tree", arguments: { path: "src" } });
    expect(await secondStage.waitForDirective()).toEqual({ kind: "FUNCTION_CALL", opRef: "op-2", toolName: "tree", argumentsJson: '{"path":"src"}' });
    const thirdBody = continuationBody(secondBody as any, "op-2", "tree", { path: "src" }, "two");
    rendezvous.openStage({ turnRef: "turn-a", body: thirdBody });
    const secondCandidate = await secondResult;
    expect(secondCandidate.output).toBe("two");
    commit(secondCandidate);
  });

  test("stale old-stage replay after dispatch never receives the function_call again", async () => {
    const { rendezvous } = fixture();
    const body = initialBody();
    const stage = rendezvous.openStage({ turnRef: "turn-a", body });
    void rendezvous.dispatchTool({ turnRef: "turn-a", opRef: "op-1", toolName: "tree", arguments: { path: "." } });
    await stage.waitForDirective();
    expect(() => rendezvous.openStage({ turnRef: "turn-a", body })).toThrow(GooseToolRendezvousError);
    try { rendezvous.openStage({ turnRef: "turn-a", body }); } catch (error) { expect((error as GooseToolRendezvousError).code).toBe("STALE_STAGE_REPLAY"); }
  });

  test("process-local stage loss never reconstructs a claimed tool", async () => {
    const body = initialBody();
    const durable = encodeGooseResponsesProjectionCheckpoint(gooseResponsesProjectionCheckpoint(body));
    const replacement = new GooseToolRendezvous({ loadCheckpoint: () => durable });
    await expect(replacement.dispatchTool({ turnRef: "turn-a", opRef: "op-claimed-before-restart", toolName: "tree", arguments: { path: "src" } }))
      .rejects.toMatchObject({ code: "STAGE_UNAVAILABLE" });
  });

  test("continuation preserves exact literal tool identity and canonical input prefix", async () => {
    const { rendezvous } = fixture();
    const body = initialBody();
    const stage = rendezvous.openStage({ turnRef: "turn-a", body });
    void rendezvous.dispatchTool({ turnRef: "turn-a", opRef: "op-1", toolName: "tree", arguments: { b: 2, a: 1 } });
    expect((await stage.waitForDirective()).argumentsJson).toBe('{"a":1,"b":2}');
    const wrong = continuationBody(body, "op-1", "tree", { a: 1, b: 3 }, "output");
    expect(() => rendezvous.openStage({ turnRef: "turn-a", body: wrong })).toThrow(GooseToolRendezvousError);
  });

  test("failed atomic commit quarantines the pending stage while durable checkpoint stays old", async () => {
    const { rendezvous, durable } = fixture();
    const initial = initialBody();
    const initialCheckpoint = durable();
    const stage = rendezvous.openStage({ turnRef: "turn-a", body: initial });
    const result = rendezvous.dispatchTool({ turnRef: "turn-a", opRef: "op-1", toolName: "tree", arguments: { path: "." } });
    await stage.waitForDirective();
    const next = continuationBody(initial, "op-1", "tree", { path: "." }, "effect-may-have-happened");
    const pending = rendezvous.openStage({ turnRef: "turn-a", body: next });
    const candidate = await result;
    candidate.abort();
    expect(durable()).toBe(initialCheckpoint);
    await expect(pending.waitForDirective()).rejects.toMatchObject({ code: "TURN_UNCERTAIN" });
    await expect(rendezvous.dispatchTool({ turnRef: "turn-a", opRef: "op-2", toolName: "tree", arguments: {} })).rejects.toMatchObject({ code: "TURN_UNCERTAIN" });
    expect(() => rendezvous.openStage({ turnRef: "turn-a", body: next })).toThrow(GooseToolRendezvousError);
  });

  test("released current stage cannot be replaced by stale history after durable progress advances", async () => {
    const { rendezvous, commit } = fixture();
    const initial = initialBody();
    const first = rendezvous.openStage({ turnRef: "turn-a", body: initial });
    const output = rendezvous.dispatchTool({ turnRef: "turn-a", opRef: "op-1", toolName: "tree", arguments: { path: "." } });
    await first.waitForDirective();
    const current = continuationBody(initial, "op-1", "tree", { path: "." }, "tool-output");
    const second = rendezvous.openStage({ turnRef: "turn-a", body: current });
    commit(await output);
    expect(second.releaseBeforeDispatch()).toBe(true);
    expect(() => rendezvous.openStage({ turnRef: "turn-a", body: initial })).toThrow(GooseToolRendezvousError);
    const reopened = rendezvous.openStage({ turnRef: "turn-a", body: current });
    expect(reopened.checkpoint.inputCount).toBe(4);
  });

  test("only a dead pre-dispatch HTTP owner may transfer stage ownership", async () => {
    const { rendezvous } = fixture();
    const body = initialBody();
    const original = rendezvous.openStage({ turnRef: "turn-a", body });
    expect(() => rendezvous.openStage({ turnRef: "turn-a", body })).toThrow(GooseToolRendezvousError);
    expect(original.releaseBeforeDispatch()).toBe(true);
    const replacement = rendezvous.openStage({ turnRef: "turn-a", body });
    void rendezvous.dispatchTool({ turnRef: "turn-a", opRef: "op-1", toolName: "tree", arguments: {} });
    await replacement.waitForDirective();
    expect(replacement.releaseBeforeDispatch()).toBe(false);
  });
});
