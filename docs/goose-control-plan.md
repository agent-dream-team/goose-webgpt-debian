# Goose Control — deferred planner-to-Goose control bridge

Status: **auxiliary design note / deferred; not an active implementation milestone**  
Captured: **2026-08-10**  
Purpose: preserve the design discussion so a future dedicated chat can resume from this point without reconstructing the architecture from memory.

## Why this exists

The current `goose-chatgpt-web` workflow proves an important direction successfully:

```text
Goose
  ↓ provider request
goose-chatgpt-web
  ↓
ChatGPT Web
```

ChatGPT Web can therefore act as the main model/provider inside an ordinary Goose session while Goose owns the conversation, tools, local execution, delegation, approvals, and recipes.

The remaining usability problem is the manual planning/execution boundary. Today Luke often uses a separate ChatGPT planning conversation to reason about architecture and decide the next step, then manually copies a generated prompt into the correct Goose conversation, waits for Goose, copies Goose's result back into ChatGPT, and repeats.

The intended permanent experience should not require that clipboard relay.

This document records an **intermediate solution** called **Goose Control**: keep the planner exactly where it is — a persistent ChatGPT conversation — but give that planner a narrow connector that can send work directly to Goose sessions and retrieve their results.

The initial goal is not full autonomous orchestration. It is simply to remove the human transport layer between planner and executor.

## Desired user experience

Current flow:

```text
Luke
  ↓
ChatGPT planner
  ↓ generates paste-ready prompt
Luke copies prompt
  ↓
Goose session
  ↓ runs task
Luke copies result
  ↓
ChatGPT planner
  ↓ assesses result / generates next prompt
```

Goose Control MVP:

```text
Luke
  ↓
ChatGPT planner
  ↓ Goose Control
relevant Goose session
  ↓ runs task
Goose Control
  ↓
ChatGPT planner
  ↓ assesses result / sends next instruction
```

Luke should no longer need to:

- copy prompts into Goose;
- copy Goose output back into ChatGPT;
- remember Goose session IDs;
- decide whether a response belongs in an existing task session or a fresh one once that policy can be encoded deterministically.

For the first asynchronous version, the only unavoidable manual action may be a tiny follow-up message in the ChatGPT planning conversation after Goose has finished, such as `check`. That new ChatGPT turn gives the planner an opportunity to call Goose Control, retrieve the completed job, assess it, and continue. If Luke sends any normal message instead, the planner can opportunistically check pending jobs during that turn.

The connector alone should **not** be expected to wake a completed ChatGPT conversation spontaneously when Goose finishes. Removing that final nudge belongs to a later event-driven orchestration layer.

## Architectural principle

**Do not merge the planner and executor merely to eliminate copy/paste.**

The planning conversation is valuable precisely because it stays separate from long implementation turns, tool output, logs, retries, and code context. Goose Control should preserve that separation while removing the manual transport boundary.

Conceptually:

```text
                 Luke
                   │
                   ▼
        ┌─────────────────────┐
        │ Persistent Planner  │
        │ ChatGPT Web / High  │
        └──────────┬──────────┘
                   │
              Goose Control
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
     Goose A    Goose B    Goose C
  implementation review    deployment
        │          │          │
        └──────────┼──────────┘
                   ▼
             Goose workers /
             Day Shift routes
```

The planner remains the strategic interface. Goose sessions remain the execution contexts.

## Goose Control is not Goose Native

Keep the control plane separate from the existing Goose Native connector.

### Goose Native

Purpose:

```text
active ChatGPT-Web provider turn
  ↓
Goose Native connector
  ↓
Goose-owned tools / delegation for that turn
```

It is an execution-time bridge tied to the currently active Goose turn and its tool/broker semantics.

### Goose Control

Purpose:

```text
persistent ChatGPT planning conversation
  ↓
Goose Control
  ↓
Goose session management / job submission / result retrieval
```

It is a management interface across Goose sessions.

Do not give Goose Control arbitrary shell, file-editing, browser-control, credential, or process-management capabilities merely because Goose Native or Goose itself has those capabilities. Goose Control should remain a narrow session/job API; the receiving Goose session retains responsibility for its own normal permissions and tools.

## Proposed connector boundary

The preferred shape is a small MCP/custom-app style control service reachable by the ChatGPT planner through the same general private-connector/tunnel pattern already proven in this project.

The exact transport should be re-evaluated when implementation begins, but the logical API should remain narrow.

### Minimum useful session operations

```text
list_sessions(...)
get_session(session_id)
start_session(...)
```

Potential inputs for `start_session`:

```text
project
working_dir
purpose
name
provider/model policy if explicitly allowed
```

The planner should not need to know raw IDs most of the time.

### Primary job operations

Prefer asynchronous semantics from the start:

```text
send_message_async(session_id | target, message, metadata?)
  → job_id

get_job(job_id)
  → running | completed | failed | cancelled

interrupt_job(job_id)
```

A synchronous `send_message()` may be useful for very short operations, but it should not be the primary mechanism because it would tie up the planner turn for the entire Goose execution.

### Optional convenience operations

Later, if clearly useful:

```text
list_jobs(status?)
get_pending_jobs()
peek_job(job_id)
get_job_output(job_id)
resolve_target(alias)
```

Avoid expanding the connector into a general Goose administration API unless a concrete workflow requires it.

## Async job semantics

The key usability requirement is that the planner is not blocked while Goose performs a long task.

Desired call:

```text
send_message_async(
  target = "goose-chatgpt-web:compaction",
  message = "..."
)
```

Immediate response:

```json
{
  "job_id": "goose_job_0042",
  "session_id": "20260810_7",
  "status": "running"
}
```

Goose continues independently.

A later planner turn calls:

```text
get_job("goose_job_0042")
```

and receives one of:

```text
running
completed
failed
cancelled
```

For completed/failed jobs the response should include the canonical Goose result required for the planner to judge the next step, without forcing Luke to relay it manually.

## Target/session aliases

A deterministic alias registry would remove most raw-session bookkeeping from the planner conversation.

Example:

```text
goose-chatgpt-web:compaction
  → 20260810_7

goose-chatgpt-web:deployment
  → 20260810_9

day-shift:groq-provider
  → 20260811_2
```

The exact storage mechanism can remain very small initially. The important property is that aliases resolve deterministically and visibly; the model should not silently guess among several plausible sessions.

The registry may eventually store:

```text
target alias
project/repository
session_id
purpose
state
last job id
created/updated timestamps
```

## Continuation vs fresh session policy

One existing planning convention should eventually become a first-class control decision rather than a manual copy/paste instruction:

```text
CONTINUATION — use the existing agent chat/context
```

versus:

```text
FRESH CHAT — start a new agent chat/context
```

The planner should continue a session only when the task is genuinely incremental within the same workstream. A distinct diagnostic, milestone, or problem should receive a fresh session so stale assumptions and accumulated context do not contaminate it.

Goose Control can eventually encode this explicitly, for example:

```text
submit_job(
  target = "goose-chatgpt-web:compaction",
  mode = "continuation",
  ...
)
```

or:

```text
submit_job(
  project = "goose-chatgpt-web",
  mode = "fresh",
  purpose = "pinned-delegation-policy",
  ...
)
```

Do not let the connector automatically infer a continuation when there is meaningful ambiguity.

## Planner availability and the remaining manual nudge

An MCP/control connector can remove the prompt/output copying boundary, but by itself it does not provide a durable background brain that can initiate a new planner turn after ChatGPT has already finished responding.

Therefore the expected intermediate behavior is:

```text
Luke → planner: start/continue task
planner → Goose Control: submit async job
planner → Luke: job is running

Goose completes independently

Luke → planner: "check"  (or any new normal message)
planner → Goose Control: retrieve job
planner → evaluates result
planner → Goose Control: sends next step if appropriate
```

This is already a large UX improvement because Luke's manual action becomes a tiny conversation nudge rather than a two-way clipboard relay.

The planner should also opportunistically inspect relevant pending jobs whenever Luke next talks normally, so `check` is not a special command the user must remember.

## What Goose Control deliberately does not solve

The MVP should not pretend to provide full autonomous orchestration.

It does **not** by itself solve:

- automatic wake-up of the planner when Goose completes;
- persistent CEO/COO hierarchy;
- autonomous multi-step review/implementation loops while Luke is absent;
- provider/model routing policy;
- worker concurrency policy;
- automatic deployment authority;
- system-wide health supervision;
- Session Guardian behavior;
- arbitrary recursive subagent trees.

Those can build on the same control plane later.

## Security and authority model

The connector should expose the minimum management authority needed by the planner.

Likely allowed:

```text
✓ list/inspect approved Goose sessions
✓ start an approved Goose session within configured project roots
✓ submit a message/job
✓ retrieve job status/result
✓ interrupt a job/session started or explicitly managed through this control plane
```

Likely disallowed directly through Goose Control:

```text
✗ arbitrary shell execution
✗ arbitrary file reads/writes
✗ credential/keychain access
✗ browser/CDP control
✗ broad process killing
✗ changing tunnel identity
✗ arbitrary provider spending
```

If a task needs shell/files/tools, Goose itself performs those actions under its own configured permissions and task policies.

Use explicit project-root/working-directory validation. Fail closed on unknown aliases, ambiguous sessions, unavailable targets, and unsupported provider/model requests.

## Relationship to Goose upstream Project Palmate / hidden Orchestrator

As of this note (2026-08-10), Goose upstream already contains a built-in **Orchestrator** platform extension introduced by upstream PR `#7999` as part of **Project Palmate**.

Important observations from the then-current upstream code:

- it is built into Goose core, not an external plugin;
- it is intentionally `default_enabled: false` and `hidden: true`;
- it can list, view, start, message, and interrupt agent sessions;
- `start_agent` currently inherits the orchestrator's provider/model and contains a TODO for model-tier selection;
- `send_message` is synchronous and consumes the target agent response until completion;
- Goose's separate Summon/subagent machinery already supports asynchronous background delegation with task IDs, status/peek, result retrieval, and cancellation.

**Re-check current Goose upstream before implementing.** This is an active area and may have changed substantially.

### Why not wait for or fully implement Palmate first?

A mature CEO/COO orchestration system needs much more than removing clipboard relay:

```text
persistent CEO
persistent COO
async CEO → COO jobs
COO task ledger
worker selection
parallelism
review loops
authority policy
provider/model selection
completion events
failure recovery
context membranes
durable orchestration state
```

Goose Control is intentionally much smaller. It only needs to give the existing ChatGPT planner a reliable way to address Goose sessions, submit work asynchronously, and fetch results.

This makes it a strong intermediate milestone even if Palmate later becomes the preferred native orchestration layer.

## Goose Control should not be throwaway work

Design the API so it can survive a later CEO/COO architecture.

A generic interface such as:

```text
submit_job(target, instructions, context?, authority?)
job_status(job_id)
job_result(job_id)
interrupt_job(job_id)
```

can initially mean:

```text
ChatGPT planner
  ↓
Goose Control
  ↓
implementation Goose session
```

Later it can mean:

```text
CEO planner
  ↓ same control interface
persistent COO Goose session
  ↓
workers
```

The transport and session-control layer therefore remains useful; the main evolution is changing the planner's target from direct execution sessions to a persistent orchestrator/COO.

## Longer-term CEO / COO design preserved here

The eventual preferred hierarchy discussed alongside Goose Control is:

```text
                         Luke
                          │
                          ▼
                ┌──────────────────┐
                │       CEO        │
                │ Persistent       │
                │ Planner          │
                │ ChatGPT-Web High │
                └────────┬─────────┘
                         │
                  async job packet
                         │
                         ▼
                ┌──────────────────┐
                │       COO        │
                │ Persistent       │
                │ Orchestrator     │
                │ ChatGPT-Web High │
                └────────┬─────────┘
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
        Implementer   Reviewer   Researcher
             │           │           │
             └───────────┼───────────┘
                         ▼
                      Day Shift
                 role/model/provider

              separate reliability plane
                         │
                         ▼
                  Session Guardian
```

The organizational metaphor is intentional:

- **CEO/planner:** takes the external meeting with Luke; discusses goals, priorities, architecture, trade-offs, and roadmap; remains available for conversation while execution runs.
- **COO/orchestrator:** takes internal meetings; decomposes jobs, chooses workers, handles implementation/review loops, validates completion gates, and reports executive summaries back to the CEO.
- **Workers:** bounded execution agents. They should not recursively create further management layers.
- **Session Guardian:** deterministic health/recovery plane, not an AI project manager.

Do not collapse CEO and COO merely because Goose can technically delegate. A combined planner-orchestrator would become occupied with internal execution decisions and defeat the purpose of keeping the strategic planning conversation continuously available.

### Context membranes

The COO does not need the CEO's entire planning history. Prefer structured job packets:

```text
objective
relevant background
architectural constraints
acceptance criteria
authority
budget/provider policy
repository/working directory
known risks
stop conditions
```

Likewise, workers may return large logs and implementation detail to the COO, but the COO should return to the CEO only:

```text
status
decisions made
material findings
artifacts / PRs
unresolved risks
next recommended action
```

This protects the strategic context from operational noise.

## Relative implementation scope

Use this only as a qualitative comparison, not an effort estimate:

```text
Goose Control MVP          small
Async Goose Control        small-to-medium
Persistent CEO/COO         substantially larger
Full autonomous system     larger again
```

The important conclusion is that **Goose Control is expected to be materially less work than completing a production-grade Palmate-style CEO/COO orchestration layer**, while delivering an immediate usability benefit.

## Suggested implementation phases when this is eventually prioritized

### Phase 0 — re-evaluate before coding

A dedicated future chat should first inspect:

1. current `goose-chatgpt-web` main and security model;
2. current Goose session APIs / AgentManager / event bus;
3. current Project Palmate / Orchestrator implementation;
4. current Summon async task semantics;
5. current ChatGPT custom-app/MCP write/action capabilities and Secure MCP Tunnel behavior;
6. whether an existing Goose API already provides the required async session control cleanly.

Do not assume this 2026-08-10 upstream snapshot is still current.

### Phase 1 — read-only discovery proof

Prove from the planner connector:

```text
list approved Goose sessions
inspect one known session
resolve a deterministic alias
```

No writes yet.

### Phase 2 — controlled send proof

Add one explicit `send_message`/`submit_job` path to a known test Goose session with strict target validation.

Prove the planner can send a task without Luke copying it.

### Phase 3 — async jobs

Make asynchronous submission the normal path:

```text
submit → job_id immediately
peek/status
retrieve result
cancel
```

Prove the ChatGPT planner is free to continue a separate conversation while Goose works.

### Phase 4 — session aliases and fresh/continuation semantics

Add deterministic target aliases and enough metadata to distinguish continuation from fresh work without relying on human copy/paste conventions.

### Phase 5 — real workflow dogfood

Use Goose Control for actual project work for a period before adding a COO.

Observe which operations still require manual intervention and which decisions are repetitive enough to move into the later orchestration layer.

### Phase 6 — optional CEO/COO evolution

Only after real usage demonstrates the need, insert a persistent COO between planner and workers, ideally reusing or extending Goose upstream Palmate/Orchestrator rather than creating an unrelated agent runtime.

## MVP acceptance criteria

The first useful Goose Control milestone should satisfy all of the following:

- The ChatGPT planner can deterministically identify or create the intended Goose session.
- The planner can send a complete task to Goose without Luke copying/pasting anything.
- Goose retains normal ownership of execution, tools, approvals, conversation, and delegation.
- The planner receives a stable job/session identifier.
- A long Goose task can run without holding the planner in a synchronous tool call for its entire execution.
- On a later ChatGPT turn, the planner can retrieve the canonical Goose result without Luke copying it.
- The planner can send a follow-up to the same session after assessing that result.
- The planner can explicitly choose a fresh session for a new workstream.
- Unknown/ambiguous targets fail closed.
- Goose Control itself exposes no arbitrary shell/file/credential/browser/process capability.
- Existing Goose Native behavior is unchanged.
- Existing Secure MCP Tunnel identity is not casually replaced as part of this feature.

A successful end-to-end demonstration should look like:

```text
Luke → planner: "continue with the next milestone"
planner → Goose Control: submit async task
Goose executes
Luke later → planner: "check" (or asks a normal unrelated question)
planner → Goose Control: retrieve result
planner judges result
planner → Goose Control: send appropriate continuation
```

with **zero prompt or output copying by Luke**.

## Later autonomous acceptance criterion

This is explicitly **not required for the MVP**:

```text
Goose finishes
  ↓ completion event
planner/orchestration process wakes automatically
  ↓
evaluates result
  ↓
sends next job
```

That requires an event-driven workflow owner outside the simple request/response connector and is effectively the beginning of the future COO/orchestration layer.

## Open questions for the future implementation chat

Re-evaluate rather than inheriting answers blindly:

1. Should Goose Control wrap Goose's existing HTTP/session API directly, or should a tiny local service own a more stable facade?
2. Can current Goose Palmate/Orchestrator already provide asynchronous session messages by then?
3. Should job state live in Goose, the connector service, or a tiny separate durable ledger?
4. What is the narrowest reliable alias/target model across multiple repositories?
5. How should the planner discover that a job finished when Luke returns to the chat?
6. Which connector writes need explicit user confirmation in the current ChatGPT custom-app model?
7. How should concurrent jobs targeting the same Goose session fail or queue?
8. What output projection gives the planner enough evidence without unnecessarily copying huge internal logs into the strategic context?
9. Which authorities may be delegated once at job submission versus requiring a later Luke approval?
10. At what point does real usage justify inserting the persistent COO instead of continuing direct planner → Goose session control?

## Priority / stop boundary

This plan is intentionally preserved **without implementing it now**.

Do not treat the existence of this file as authorization to:

- enable Goose's hidden Orchestrator/Palmate extension in production;
- add a new connector immediately;
- change current compaction work;
- alter Day Shift;
- build the Session Guardian;
- introduce a persistent COO;
- expose new local-machine authority to ChatGPT.

Resume only when Luke explicitly prioritizes **Goose Control** or asks to eliminate the planner↔Goose manual relay.

At that point, start a dedicated fresh planning/development chat and begin at **Phase 0 — re-evaluate before coding**.