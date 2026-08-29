# Agent safety and runtime rules

These instructions apply to coding/automation agents working in this repository.

For documentation creation, changes, review, or cleanup, read and apply `.agents/skills/lean-documentation/SKILL.md`.

## Read current documentation first

Before architecture, lifecycle, BrowserHost, tunnel, or Goose Control work, read:

1. `docs/README.md`
2. `docs/architecture.md`
3. `docs/runtime-lifecycle.md`
4. `docs/roadmap.md`
5. `docs/goose-control-plan.md` when the task concerns Goose Control

Current documentation outranks historical roadmap material and draft PR designs. Draft PR #25 and PR #26 are design inputs only after the documentation reconciliation on current `main`.

## Host/session safety

- Preserve ignored `.env` files, browser authentication state, runtime keys, credentials, and unrelated local proof artifacts unless the task explicitly authorizes changing them.
- Never print, log, commit, or otherwise expose credentials or authentication material.
- Do not enumerate macOS Keychain contents or use broad discovery commands such as `security dump-keychain`.
- If a task genuinely requires a Keychain item, access only the exact known service/account entry needed for that task.
- A Goose main agent must never restart, quit, upgrade, relaunch, terminate, or otherwise replace the Goose host carrying its own session.
- Do not use broad process-kill commands for Chrome, Electron, Playwright, the Responses daemon, or the tunnel. Target only a known project-owned process when an explicit test requires it.

## Current ownership and lifecycle

- Goose owns logical session state, tools/approvals, delegation/subagents, recipes/extensions, project execution, and context lifecycle.
- The Responses daemon and Secure MCP Tunnel are independently supervised.
- Electron owns BrowserHost only: authenticated browser state, task-bound surfaces, BrowserHost control, and CDP.
- Do not restore daemon/tunnel ownership to Electron `RuntimeSupervisor` in standalone Goose mode.

Canonical lifecycle:

```text
start: tunnel ready → BrowserHost genuinely ready → Responses daemon ready
stop:  Responses daemon → BrowserHost → tunnel
```

Use the canonical lifecycle entry point rather than reconstructing startup from lower-level service scripts.

## Proof boundaries that must not be rediscovered

- BrowserHost readiness uses the descriptor-provided browser helper with Node/Electron Node semantics and `ELECTRON_RUN_AS_NODE=1`. Bun-direct Playwright/CDP is not authoritative readiness evidence.
- A lifecycle/autostart proof launched from an active BrowserHost-backed turn can interfere with the runtime carrying that same turn. Do not generalize such self-interference into an Electron regression.
- Ordinary Goose continuation proof is a persisted named session followed by a separate later `--resume`. Do not substitute stdin-interactive Goose or a hand-written `previous_response_id` request for that proof.
- Fresh ChatGPT Temporary Chats across Goose user turns are expected. Goose, not browser chat reuse, owns durable continuation.
- Ordered macOS autostart is implemented and live-checked short of an actual reboot/login. Reboot/login reconstruction remains **NOT RUN** until explicitly performed.

## Goose Control boundary

- Goose Control addresses persisted Goose sessions through authenticated loopback `goose serve` ACP.
- It must not address Electron windows, CDP targets, ChatGPT browser sessions, or BrowserHost process identity.
- It is separate from Goose Native's per-turn `turn_token` capability.
- Do not invent a second Goose session/execution API; use native ACP session operations.
- The first implementation proof is the narrow synchronous GPT Action → REST/OpenAPI → ACP continuation path documented in `docs/goose-control-plan.md`; async jobs, cancellation, multi-target routing, fresh sessions, and Orchestrator are later work.

## Delegation

- Until BrowserHost concurrency is explicitly qualified for a task, avoid parallel ChatGPT-Web child fan-out under the managed browser host.
- When delegating to a non-ChatGPT/free worker, name the intended provider/model explicitly so it does not inherit ChatGPT-Web transport by accident.
