---
type: plan
status: current
as_of: 2026-09-14
---

# Goose ChatGPT Web current follow-up plan

> **Purpose:** current implementation/qualification gaps for the DreamBook appliance only.
> **Lifecycle authority:** `docs/persistent-chat-lifecycle.md` owns the non-negotiable persistent-conversation and paired-handoff invariants.
> **Historical evidence:** use Git history and the relevant merged/draft PRs when forensic detail is actually needed. Superseded gate diaries, package hashes, experiments, and retired recovery targets are intentionally not repeated here.

## Current qualified runtime

The non-reboot V1 appliance is installed and operational on DreamBook through `~/.local/bin/goose-chatgpt-web` and the immutable package under `~/.local/lib/goose-chatgpt-web/`.

The currently installed runtime behavior was built from source checkpoint `5aff187bf356b6ca8287347106659489904f1842` (`Retire local conversation budget enforcement`):

- immutable bundle `531d4ef3f9d9fb73fa22695878a2ed5f31cf2ac66ce8179976bc8719034c0860`;
- AppImage SHA-256 `7f15dff2a9175ee136bd9e9a107cc51d2c267c1ed26dec04f962e1cb9677bebb`;
- a fresh installed-package Goose/GCW turn completed successfully after activation;
- local conversation-budget estimates no longer reject tool work, cap otherwise valid output, or force provider-chat rollover.

Repository HEAD may contain later source, documentation, or test robustness fixes. Do not describe those later commits as installed until a package built from them is independently qualified and activated.

The old DreamBook appliance and its mutable state are retired. The active repository is `agent-dream-team/goose-webgpt-debian`; the separate `luke-m-selway/goose-chatgpt-web` repository is the MBP/macOS target.

## Current architecture boundary

Goose owns the logical session/transcript, context lifecycle, tools, approvals, delegation, recipes, and project execution. GCW owns only the ChatGPT-Web provider surface and the provider-local state required to operate and recover it.

The durable remote identity is the server-side ordinary ChatGPT conversation identified by its canonical `/c/<uuid>` id. Browser tabs, renderer processes, Playwright handles, and helper processes are disposable views.

One Goose session and one ChatGPT provider conversation remain a context pair until deliberate handoff. View failure, elapsed time, repeated recovery, or local estimates do not independently replace the provider conversation.

The dedicated `CGW Provider Sessions` Project with project-only memory is an accepted behavioral topology, not a hard security boundary. Cross-chat isolation must continue to be tested rather than assumed.

## Remaining work

### 1. Paired context handoff

The current lifecycle decision supersedes older independent provider-epoch rollover behavior. Context pressure or non-append-compatible Goose history must lead to a deliberate handoff and then a **fresh Goose session plus fresh ChatGPT conversation together**.

Qualify this for ordinary context pressure and for non-append-compatible history such as compaction/truncation/fork-style divergence. Richer and multimodal history must not be silently repaired by rolling only the provider chat.

Any remaining source path that automatically creates a replacement provider epoch under the same Goose session because of history rewrite or local context estimates is implementation debt until narrowed to initial pair creation or deliberate paired handoff.

### 2. Persistent-chat recovery fault matrix

Qualify the accepted recovery loop end to end:

`observe -> hard refresh -> settle -> reassess -> continue same chat if stopped`

Cover stale/lost browser views, connection/error UI, genuine mid-turn stops, Browser/Electron death, broker/connector restart, page loss during active tool work, exact-request replay, duplicate admission attempts, authentication/workspace mismatch, and repeated continuation recovery.

A settled stopped/error view with no intended final should receive the standardized GCW-internal continuation in the same ChatGPT conversation. Do not click ChatGPT Retry, resend the original Goose prompt, or abandon the persistent conversation merely because observation failed.

### 3. Tool/delegation edge qualification

The serial connector/tool path is already usable. Remaining edge qualification includes stale turn-ref rejection, capability lifetime across long work/view recovery, ambiguous side-effect delivery remaining `UNCERTAIN`, final-answer blocking while tool work is unresolved, and one native Goose child-delegation path without GCW owning child-session state.

Native Goose approval-round qualification is deferred while DreamBook remains in Goose `auto`; it becomes required before supporting non-`auto` modes.

### 4. Retention, isolation, and contention

Continue auditing what local data is allowed into durable ChatGPT history, result-size/redaction/retention behavior, connector authorization boundaries, aged-Project cross-session isolation, and contention between independent Goose sessions for the one ChatGPT account slot.

Any observed sibling-chat bleed is a blocking correctness defect for the shared-Project topology and requires a different qualified topology rather than stronger prompt wording alone.

### 5. Long-duration real-work soak

Run genuinely long multi-turn work with tools/delegation, controlled view failures, repeated refresh/continuation recovery, and at least one deliberate paired Goose/ChatGPT handoff. Success means no duplicate side effects, stale authority, independent provider-chat rollover, cross-session bleed, or security/account warnings.

### 6. Reboot reconstruction

Package/install/autostart/headless ownership are qualified without a machine reboot. The remaining deployment proof is an actual DreamBook reboot followed by stable XDG-autostart reconstruction, account-fence ownership, authenticated BrowserHost, provider health, managed tunnel readiness, and a final ordinary-Goose/no-held-slot sanity check.

This reboot is deliberately deferred to a coordinated multi-system reboot window. **Do not reboot DreamBook for GCW qualification without explicit operator approval.**

## Non-goals

- rebuilding the retired pre-V1 appliance as an implicit rollback route;
- Codex product compatibility or restoration of inherited Codex operator workflows;
- a second Goose transcript/context/delegation authority inside GCW;
- multi-tab concurrent ChatGPT-Web execution;
- parallel side-effecting connector operations without separate qualification;
- an LLM watcher or recovery arbiter deciding ambiguous state; ambiguity remains durably `UNCERTAIN` and escalates to the operator rather than model judgement;
- treating Project memory/instructions as a technical security boundary;
- claiming exactly-once semantics where the observed contract supports only idempotent or `UNCERTAIN` outcomes.

## Qualification discipline

Current-state documentation describes only behavior that is implemented and qualified. Historical experiments or superseded checkpoints are not operating authority. When old evidence is needed for diagnosis, retrieve it from Git history or the relevant PR rather than restoring it to the current documentation surface.

After any source behavior change, run focused regression coverage, TypeScript, `git diff --check`, and the repository verification appropriate to the changed path. A known environment/timing baseline failure must be identified explicitly; do not relabel a red run as fully passing.
