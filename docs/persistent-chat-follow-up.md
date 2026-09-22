---
type: plan
status: current
as_of: 2026-09-22
---

# Goose ChatGPT Web current follow-up plan

> **Purpose:** current implementation/qualification gaps for the DreamBook appliance only.
> **Lifecycle authority:** `docs/persistent-chat-lifecycle.md` owns the non-negotiable persistent-conversation and paired-handoff invariants.
> **Historical evidence:** use Git history and the relevant merged/draft PRs when forensic detail is actually needed. Superseded gate diaries, package hashes, experiments, and retired recovery targets are intentionally not repeated here.

## Current qualified runtime

The V1 appliance is installed and operational on DreamBook through `~/.local/bin/goose-chatgpt-web` and the immutable package under `~/.local/lib/goose-chatgpt-web/`. The enabled deployment owner is the system service `/etc/systemd/system/second-shift-gcw.service`, running as `dreamteam`; XDG desktop autostart is not the service authority.

The currently installed runtime behavior was built from source checkpoint `948010baaf38604d6e877d31245a8afe9bb7ef6a` (`Allow safe pre-acceptance projection rebind`):

- immutable bundle `1789d88f81716b3f3ac10d3e3c689975dc8ff0545bdcbd135e410dffeff4cd5c`;
- AppImage SHA-256 `515c291a435c2b8d374fc62b5e071aff8e4a2808e127ca284e5e16e117bbba7a`;
- runtime-manifest SHA-256 `aa3ea59fdfb1c5283fa045d714178f6ecc475675ea8cbe5b81b18c6b317e8e48` for the package built from that checkpoint;
- exactly two concurrent persistent browser turns remain the qualified capacity, intended for one GCW parent/orchestrator plus one native-Goose GCW child/worker;
- broker process ownership now records Linux boot identity plus process start identity, so PID reuse cannot by itself make a dead broker appear live; legacy unencoded owners remain fail-closed and require explicit reconciliation when independently proven stale;
- after the 2026-09-21 machine reboot exposed the legacy PID-reuse defect, the fixed package was installed, passed package/ABI smoke, restored provider and BrowserHost health, completed an ordinary Goose→GCW turn, released its second slot, survived a controlled system-service restart, and completed another ordinary turn after that restart while the preserved unreconciled pair remained unchanged;
- pre-acceptance same-pair rebind now tolerates only generated Goose system/tool projection drift when stable request fields and every canonical history item remain exact and the sole broker operation is still pristine `MINTED`; all history, stable-request, or tool-progress ambiguity remains fail-closed;
- the preserved turn-328 specimen recovered under its original Goose Control request and Goose session, became `COMPLETE` with durable accepted-user/final identity, released its retained slot, and the same Goose Control request reconciled to completion; a subsequent fresh Goose→GCW smoke returned `GCW_CLEAN_BASELINE_OK`, after which both account slots and both active-turn counters were zero;
- local conversation-budget estimates no longer reject tool work, cap otherwise valid output, or force provider-chat rollover.

The installed AppImage hash records the exact activated package; byte-for-byte AppImage reproducibility is not claimed. Git history and the active PR retain detailed qualification evidence. Repository HEAD may contain later source, documentation, or test changes. Do not describe source after this checkpoint as installed until a package built from it is independently qualified and activated.

The old DreamBook appliance and its mutable state are retired. The active repository is `agent-dream-team/goose-webgpt-debian`; the separate `luke-m-selway/goose-chatgpt-web` repository is the MBP/macOS target.

## Current architecture boundary

Goose owns the logical session/transcript, context lifecycle, tools, approvals, delegation, recipes, and project execution. GCW owns only the ChatGPT-Web provider surface and the provider-local state required to operate and recover it.

The durable identities are symmetric: the local persisted Goose session/transcript and the server-side ordinary ChatGPT conversation identified by its canonical `/c/<uuid>` id. Browser tabs, renderer processes, Playwright handles, helpers, HTTP requests, connector attachments, and other process-local owners are disposable attachments/views.

One Goose session and one ChatGPT provider conversation remain a context pair until deliberate handoff. Attachment loss means reconnect/rebind the same pair. View failure, elapsed time, repeated recovery, local estimates, process restart, or temporary account-slot release do not independently replace either chat. Time-based watchers may escalate observation but do not retire tool authority; `UNCERTAIN` is reserved for genuinely ambiguous correlated execution/result state and must be reconciled against durable broker evidence plus the persistent Goose session before the pair resumes. Qualified positive-terminal recovery may release one of the two account execution slots while retaining the current pair; exact replay reacquires capacity before same-pair rebind and never resends the original prompt. A successful rebind consumes that terminal evidence, so later capacity release after resumed execution requires a fresh qualified settle.

The dedicated `CGW Provider Sessions` Project with project-only memory is an accepted behavioral topology, not a hard security boundary. Cross-chat isolation must continue to be tested rather than assumed.

## Remaining work

### 1. Paired context handoff

The current lifecycle decision supersedes older independent provider-epoch rollover behavior. Context pressure or non-append-compatible Goose history must lead to a deliberate handoff and then a **fresh Goose session plus fresh ChatGPT conversation together**.

Qualify this for ordinary context pressure and for non-append-compatible history such as compaction/truncation/fork-style divergence. Richer and multimodal history must not be silently repaired by rolling only the provider chat.

The installed source no longer creates a replacement provider epoch under an existing Goose session when canonical history diverges. It returns `paired_handoff_required` and leaves the existing pair intact. Remaining work is to qualify and automate the deliberate paired-handoff transaction itself.

### 2. Persistent-chat recovery fault matrix

Qualify the accepted recovery loop end to end:

`observe -> refresh/hard refresh view -> settle -> reassess -> continue same ChatGPT chat if stopped`

The refresh loop exists only to reveal authoritative server-side state. It must preserve or reconstruct the attachment to the same local Goose session and the same canonical ChatGPT conversation. Cover stale/lost browser views, connection/error UI, genuine mid-turn stops, Browser/Electron death, broker/connector restart, page loss during active tool work, exact-request replay, duplicate admission attempts, authentication/workspace mismatch, attachment rebind, positive-terminal slot quarantine/reacquisition, and repeated continuation recovery.

A settled stopped/error view with no intended final should receive the standardized GCW-internal continuation in the same ChatGPT conversation. Do not click ChatGPT Retry, resend the original Goose prompt, or abandon the persistent conversation merely because observation failed.

### 3. Tool/delegation edge qualification

The serial connector/tool path is already usable, and the installed package has qualified one tool-capable native-Goose GCW child without GCW owning child-session state. Remaining edge qualification includes stale turn-ref rejection, capability lifetime across long work/view recovery, ambiguous side-effect delivery remaining `UNCERTAIN`, and final-answer blocking while tool work is unresolved.

Native Goose approval-round qualification is deferred while DreamBook remains in Goose `auto`; it becomes required before supporting non-`auto` modes.

### 4. Retention, isolation, and contention

Continue auditing what local data is allowed into durable ChatGPT history, result-size/redaction/retention behavior, connector authorization boundaries, aged-Project cross-session isolation, and contention between independent Goose sessions. The installed runtime has a qualified hard capacity of exactly two concurrent persistent browser turns, intended for one GCW orchestrator plus one native-Goose GCW child. Capacity beyond two remains out of scope, and parallel side-effecting connector operations still require separate qualification.

Any observed sibling-chat bleed is a blocking correctness defect for the shared-Project topology and requires a different qualified topology rather than stronger prompt wording alone.

### 5. Long-duration real-work soak

Run genuinely long multi-turn work with tools/delegation, controlled view failures, repeated refresh/continuation recovery, and at least one deliberate paired Goose/ChatGPT handoff. Success means no duplicate side effects, stale authority, independent provider-chat rollover, cross-session bleed, or security/account warnings.

### 6. Fixed-package full-reboot confirmation

The 2026-09-21 DreamBook reboot proved system-service launcher reconstruction, account-fence ownership, and authenticated BrowserHost reconstruction, and exposed a stale legacy broker owner whose PID had been reused after boot. The installed fix prevents recurrence for newly encoded broker owners and has passed focused PID-reuse coverage plus a live controlled service restart.

A second full-machine reboot of the fixed package remains the strict end-to-end confirmation that all repaired components reconstruct together from power-on. It is not required for ordinary operation now that the live appliance and controlled restart are qualified. **Do not reboot DreamBook solely for this confirmation without explicit operator approval.**

## Non-goals

- rebuilding the retired pre-V1 appliance as an implicit rollback route;
- Codex product compatibility or restoration of inherited Codex operator workflows;
- a second Goose transcript/context/delegation authority inside GCW;
- general multi-tab ChatGPT-Web execution beyond the bounded two-turn orchestrator-plus-one-worker provider behavior;
- parallel side-effecting connector operations without separate qualification;
- an LLM watcher or recovery arbiter deciding ambiguous state; ambiguity remains durably `UNCERTAIN` and escalates to the operator rather than model judgement;
- treating Project memory/instructions as a technical security boundary;
- claiming exactly-once semantics where the observed contract supports only idempotent or `UNCERTAIN` outcomes.

## Qualification discipline

Current-state documentation describes only behavior that is implemented and qualified. Historical experiments or superseded checkpoints are not operating authority. When old evidence is needed for diagnosis, retrieve it from Git history or the relevant PR rather than restoring it to the current documentation surface.

After any source behavior change, run focused regression coverage, TypeScript, `git diff --check`, and the repository verification appropriate to the changed path. A known environment/timing baseline failure must be identified explicitly; do not relabel a red run as fully passing.
