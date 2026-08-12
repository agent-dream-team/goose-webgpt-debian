# Goose Control — active Planner-to-Goose bridge

Status: **active next milestone; not yet implemented.**
Last reconciled: **2026-08-12**.

Goose Control removes the manual clipboard relay between a persistent ChatGPT planning conversation and an ordinary persisted Goose execution session. It does not replace Goose as the conversation or execution authority.

## Settled architecture

### Goose-side backend

Use authenticated loopback `goose serve` **ACP**.

The settled Goose-side contract is:

- ACP session IDs map to persisted Goose sessions;
- ordinary persisted `User` sessions can be listed and loaded through ACP;
- existing targets are loaded with their persisted/listed working directory rather than a Planner-supplied cwd;
- execution uses native ACP `session/prompt`;
- Goose persists the conversation and remains the execution authority;
- later fresh-session support, if needed, uses native ACP `session/new` behind server-approved profiles rather than a second session API;
- later cancellation maps to native ACP cancellation rather than process/browser termination.

Do **not** invent a second Goose session or execution API.

### Goose remains authoritative

Goose continues to own:

- logical conversation/session state;
- tools and approvals;
- delegation/subagents;
- recipes/extensions;
- project execution;
- provider/model state for the persisted target;
- compaction/context lifecycle.

Goose Control is a narrow management facade into that existing authority. It must not become a second conversation store or execution engine.

### Goose Control is not BrowserHost control

Goose Control addresses Goose sessions, not browser infrastructure.

It must not address or depend on:

- Electron windows or `WebContentsView` identities;
- CDP targets;
- ChatGPT browser-session/chat identity;
- BrowserHost descriptors/PIDs;
- Electron `RuntimeSupervisor`;
- lifecycle/autostart process identity.

Electron/BrowserHost can change without redefining the Goose Control API.

### Goose Control is not Goose Native

`Goose Native` is the per-provider-turn tool bridge. Its `turn_token` authority is scoped to one active Goose provider turn.

Goose Control is a Planner-to-persisted-Goose management path across turns and must not reuse or expose Goose Native's `turn_token` as session-management authority.

The two surfaces may reuse safe implementation plumbing, but their public authority models are separate.

### Orchestrator/Palmate is later workflow architecture

Orchestrator/Palmate is not the Goose Control transport. A future persistent Orchestrator may become a target/workflow manager behind Goose Control after real use justifies it; ACP remains the control backend.

## Planner-facing product surface

Draft PR #25 assumed the first Planner-facing write surface could be a private custom MCP app. Do not carry that assumption forward for the present Plus Planner account.

The first practical proof is:

```text
ChatGPT Planner
  → private custom GPT invoked in the existing web conversation
  → GPT Action
  → narrow authenticated HTTPS REST/OpenAPI Goose Control facade
  → authenticated loopback goose serve ACP
  → ordinary persisted Goose session
```

This is a **product-surface adaptation only**. Keep the ACP core independent of the REST/Action facade so a future write-capable MCP surface can replace the Planner-facing transport without redesigning Goose Control.

The Planner-facing HTTPS service must expose only the narrow operation needed for the current proof. Raw ACP and the Goose server secret stay private on loopback.

## First implementation proof

The first proof is intentionally smaller than the eventual asynchronous design.

### Scope

- exactly one hard-approved persisted Goose target configured server-side;
- **continuation only** against that target;
- short, synchronous, bounded `submit_turn`;
- mandatory idempotent caller `request_id`;
- final user-visible Goose result only;
- no arbitrary cwd selection;
- no arbitrary provider/model selection;
- no `session/new`;
- no multi-target registry;
- no cancellation initially;
- no Orchestrator/Palmate;
- no Electron, BrowserHost, lifecycle, or autostart changes.

### Minimal public operation

Conceptually:

```text
submit_turn(
  request_id,
  instructions
)
  → final user-visible Goose result
```

The target is not supplied by the Planner in the first proof; it is the one server-approved persisted Goose session.

The successful response projection contains only the canonical final user-visible Goose assistant result, not tool logs, internal reasoning, browser traces, session metadata, or a copied full Goose transcript.

### Idempotency

`request_id` is mandatory.

- same `request_id` + same request payload must not append a second Goose turn;
- same `request_id` + materially different payload must fail closed;
- record enough durable correlation state before executing the ACP prompt to resolve an ambiguous Action/network retry safely.

Goose remains the canonical conversation store; the facade's durable state is correlation/idempotency state only.

### ACP behavior behind `submit_turn`

For the approved target:

1. resolve the configured persisted session ID;
2. obtain/use its persisted/listed cwd rather than accepting cwd from the Planner;
3. load the persisted session through authenticated ACP;
4. execute exactly one native `session/prompt`;
5. wait only within the deliberately short synchronous bound;
6. project the final user-visible Goose result;
7. preserve the persisted target's provider/model and normal Goose tool/approval behavior.

If the real GPT Action request/response behavior cannot support the measured bound reliably, stop expanding the synchronous shim and move to the async phase below rather than adding retries or a second execution engine.

## First-proof acceptance criteria

The first end-to-end milestone passes when:

1. The existing ChatGPT Planner conversation can invoke the private custom GPT Action.
2. The Action reaches the authenticated HTTPS Goose Control facade.
3. The facade reaches authenticated loopback Goose ACP without exposing raw ACP publicly.
4. One `submit_turn` becomes exactly one normal Goose continuation turn in the hard-approved persisted session.
5. Goose retains its existing provider/model, tools, approvals, delegation, and persistence behavior.
6. The Planner receives the final user-visible Goose result without manual prompt/output copying.
7. Repeating the same `request_id` cannot execute the turn twice.
8. Reusing the same `request_id` with different instructions fails closed.
9. No arbitrary cwd/provider/model/session creation authority is exposed.
10. Existing Goose Native, Electron BrowserHost, lifecycle, autostart, and Secure MCP Tunnel behavior is unchanged.

## Later phases — not first-proof requirements

### Async job UX

After the basic bridge works, the likely real UX is:

```text
submit_task(...) → job_id
get_job(job_id)  → running | completed | failed
```

Introduce this only after the minimal end-to-end transport is proven, or earlier only if measured GPT Action request behavior makes the synchronous bound impractical.

The async layer is a Planner-facing job handle around native ACP `session/prompt`, not a new Goose execution engine.

### Cancellation

Add only when needed. Map it to native ACP cancellation for the active Goose session. Never implement cancellation as Goose/Electron/BrowserHost/tunnel process termination.

### Multiple targets

Add a deterministic server-controlled target registry only after the one-target flow is proven. Fail closed on unknown/ambiguous/stale mappings. Do not let the Planner supply arbitrary cwd/provider/model values.

### Fresh sessions

If real workflows require fresh workstreams, use ACP `session/new` behind approved server-side profiles. Do not expose raw arbitrary session creation.

### Orchestrator/Palmate

Keep later. It may own workflow decomposition/review/Workers after dogfooding demonstrates that need, but it remains above the ACP transport rather than replacing it.

## Security boundary

For the first proof:

- the internet-facing surface is authenticated HTTPS with a narrow OpenAPI contract;
- the `goose serve` ACP endpoint stays loopback/private and authenticated;
- the Goose server secret is never exposed to ChatGPT;
- the approved target is configured server-side;
- no shell/file/browser/process/tunnel/lifecycle API is exposed by Goose Control;
- the receiving Goose session retains its normal tool approvals and execution policy;
- Goose Native per-turn capabilities remain unchanged and separate.

## Decisions that should not be reopened without contradictory evidence

- Backend protocol: authenticated loopback Goose ACP through `goose serve`.
- Existing-session addressability: persisted Goose sessions, including ordinary `User` sessions, are the target identity.
- Execution primitive: native ACP `session/prompt`.
- Conversation authority: Goose.
- BrowserHost identity: irrelevant to Goose Control.
- Goose Native relationship: separate per-turn authority model.
- Second Goose session API: do not build one.
- Orchestrator/Palmate: later workflow architecture, not transport.
- First Planner-facing product surface: private custom GPT Action → authenticated HTTPS REST/OpenAPI facade → ACP.
- First proof: one target, continuation-only, synchronous/bounded, idempotent `request_id`, final result projection only.
