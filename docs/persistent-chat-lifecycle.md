---
type: decision
status: current
---

# Persistent ChatGPT conversation lifecycle

> **Covers:** the non-negotiable lifecycle and recovery invariants for Goose ChatGPT Web persistent provider chats.
> **Elsewhere:** `docs/persistent-chat-follow-up.md` owns the current implementation and qualification gaps. Historical rebuild evidence lives in Git history rather than the current documentation surface.

## Status

Accepted. Recovery mechanics and thresholds may be refined, but they must preserve the invariants below.

## Context

An ordinary ChatGPT browser view is not a reliable representation of the underlying server-side conversation. Long turns can continue or finish while the rendered page becomes stale, interrupted, disconnected, or otherwise misleading. In normal Goose Pilot planning use, durable chats remain useful by preserving the conversation, refreshing the view when necessary, and issuing a same-chat continuation when a settled view shows that work stopped before a final answer.

The rebuild therefore must manage ChatGPT as a durable server-side conversation with a disposable browser view, not as a browser process whose liveness determines conversation lifetime.

## Decision

1. **The server-side ChatGPT conversation is durable.** Its canonical conversation identity, not a tab, renderer, DOM tree, Playwright/CDP handle, helper process, heartbeat, or launcher process, owns provider continuity. Once ChatGPT accepts a turn, GCW assumes that server-side turn will eventually settle to either an intended final answer or a stopped/error state that can be continued in the same conversation. Elapsed silence is never evidence that the conversation should be abandoned or replaced.
2. **The local Goose session is durable too.** The Goose session/transcript remains the local execution identity across provider transport, browser, helper, connector, or runtime attachment loss. A lost live connection is an attachment failure, not disappearance of the Goose session.
3. **One Goose session and one ChatGPT conversation form a persistent context pair.** Preserve the durable Goose session id, ChatGPT `/c/<uuid>` identity, accepted remote turn identity, and broker correlation needed to reconnect them. If the live attachment cannot be kept alive, repair/rebind the same pair after reconciling any in-flight tool/result state. Ordinary recovery must not silently substitute either member of the pair.
4. **A browser surface is only a disposable view and interaction surface.** DOM and browser signals tell GCW what the server-side conversation currently appears to be doing. They must not, by themselves, prove that the conversation died, authorize abandonment, create a replacement conversation, retire Goose execution authority, or resend the original Goose turn.
5. **Refresh and hard refresh are observation tools.** Their purpose is to obtain a fresh view when the current browser may lag the already-settled server-side state. Do not refresh so aggressively that GCW fights or destabilizes Chromium/Electron, and do not wait indefinitely on a stale view. Never issue another refresh until the previous refresh has settled. Exact observation cadence and escalation thresholds are tunable policy.
6. **Timers, heartbeats, and semantic-silence watchers may escalate observation only.** They may trigger inspection, refresh, hard refresh, browser-view reconstruction, or diagnostics. Time alone must not convert `CLAIMED` work to `UNCERTAIN`, cancel a tool, release a slot, retire a Goose turn, or replace either durable chat.
7. **Incomplete stopped ChatGPT turns continue in the same conversation.** After a fully settled fresh view proves that the remote turn is no longer running and the intended final assistant output is absent, do not click ChatGPT Retry and do not resend the original Goose prompt. Send the standardized GCW continuation instruction in that same conversation: `You seem to have stopped mid-turn. Work out where you got to and continue from there.` Repeat as necessary until a final answer is produced or a deliberate paired handoff is required.
8. **GCW continuation prompts are provider-internal recovery artifacts.** They are not Goose user messages, must not be projected into Goose's canonical transcript, and must not make Goose believe the user issued another instruction.
9. **Attachment loss is repaired, not treated as chat loss.** If browser/helper/provider/connector ownership is lost, first rediscover the same persistent Goose session and same canonical ChatGPT conversation. Reconcile any ambiguous in-flight operation against durable broker state and the persistent Goose session. `UNCERTAIN` is permitted only when correlated execution/result authority is genuinely ambiguous; it is a temporary reconciliation state, not permission to abandon either chat. Once ambiguity is resolved, rebind and continue the same pair. If qualified positive-terminal evidence proves a settled remote turn while no process-local owner or unresolved Goose work remains, GCW may release the scarce account execution slot without retiring the pair. That release is capacity quarantine only: an exact later replay must reacquire a slot and rebind the same pair without resending the original Goose prompt. Successful rebind consumes that terminal observation; any later slot release after resumed remote execution requires fresh qualified terminal evidence.
10. **Deliberate handoff is the only normal way to replace the pair.** Browser failure, elapsed time, repeated refresh/continuation, local budget estimation, transport loss, or process restart do not independently roll either side. When context health truly requires fresh context, perform a paired handoff and then start both a fresh Goose session and a fresh ChatGPT conversation from the handoff.
11. **Repeated recovery is a context-health signal, not a reason to abandon.** Recovery frequency may inform a later handoff decision, but no fixed recovery count or local budget is an automatic replacement threshold.
12. **Provider-chat instructions must promote graceful context rollover.** The ChatGPT-side system/Project instructions must preserve the current objective and constraints, prefer a safe checkpoint over grinding into context degradation, and produce a useful handoff when context quality becomes unreliable. Exact wording may evolve; the paired-handoff requirement must remain.

### Operational recovery classifier

Once the canonical ChatGPT conversation id is known, browser state is never the primary diagnosis. Reopen or refresh that same conversation, wait until the page has fully hydrated and its rendered state has settled, then classify the server-side turn:

- `RUNNING` — ChatGPT is still working; do not prompt, retry, or otherwise disturb it.
- `STALLED_OR_ERROR` — the settled fresh view shows work has stopped without the intended final. When no unresolved Goose tool work remains, send the standard GCW-internal continuation in the same conversation.
- `FINAL` — the intended final output is present; leave the turn terminal for the owning system to consume.

A partially loaded or stale browser view is not classifiable evidence. If the view becomes unreadable or stale again after the observation threshold, refresh or reconstruct the same conversation, allow it to settle, and repeat the classifier. The exceptional case is browser loss during the first fresh turn before a canonical conversation id exists; without that durable address, fail closed rather than guessing which remote chat accepted the send or resending the original prompt.

## Consequences

- Current runtime recovery exposes no operation that creates a newly abandoned persistent pair. Legacy persisted `ABANDONED` rows remain readable only for backward-compatible database migration/reconstruction. Account-slot ownership is capacity state, not pair identity: qualified recovery may release and later reacquire a slot while the same Goose session, ChatGPT conversation, accepted user turn, and current epoch remain durable.
- Existing helper-heartbeat/tab-reaping logic must reclaim only disposable browser resources; it must not convert view loss into provider-chat death.
- The recovery state machine should converge on `observe -> hard refresh -> settle -> reassess -> continue if stopped`, with browser replacement only as a view-level fallback. Exact settle times and stale-view detectors remain tunable.
- The old one-continuation limit is incompatible with this decision.
- Any conversation-budget or maximum-length mechanism may provide advisory context-health evidence, but a new provider conversation requires a paired ChatGPT/Goose handoff rather than an independent remote-epoch rollover.
- Qualification must test stale-view recovery, repeated continuation, and paired handoff without relying on abandonment as the success path.
