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

1. **The server-side ChatGPT conversation is the durable provider identity.** Its canonical conversation identity, not a tab, renderer, DOM tree, Playwright/CDP handle, helper process, heartbeat, or launcher process, owns continuity.
2. **A browser surface is only a disposable view and interaction surface.** DOM and browser signals may classify the health and state of that view. They must not, by themselves, prove that the server-side conversation died, authorize abandonment, create a replacement conversation, or resend the original Goose turn.
3. **Persistent provider chats are recovered, not abandoned.** Browser loss, stale DOM, helper-heartbeat loss, observation timeout, renderer failure, or similar view failure must retain the same ChatGPT conversation. The normal recovery action is a hard refresh of the owned view followed by a full settle before reassessment. A dead browser surface may be replaced when necessary, but replacing a view is never replacement of the conversation.
4. **Refresh is an observation/recovery tool, not a retry loop.** Do not issue another refresh until the previous refresh has fully settled. After settle, if ChatGPT is visibly still generating, resume observation and allow it to finish. Refresh again only after the view later becomes stale or otherwise needs reconstruction.
5. **Incomplete stopped turns continue in the same ChatGPT conversation.** If a fully settled view shows a recognized terminal/error state or shows the turn no longer running while the intended final assistant output is absent, do not click ChatGPT Retry and do not resend the original Goose prompt. Send a standardized GCW continuation instruction in the same persistent conversation, such as: `You seem to have stopped mid-turn. Work out where you got to and continue from there.` Repeat continuation recovery as many times as necessary until the turn produces a final answer or a deliberate paired handoff is required.
6. **GCW continuation prompts are provider-internal recovery artifacts.** They are not Goose user messages, must not be projected into Goose's canonical transcript, and must not make Goose believe the user issued another instruction.
7. **One Goose chat and one ChatGPT provider chat remain context partners until handoff.** Do not independently roll the ChatGPT conversation while continuing the same Goose session merely because of browser failure, elapsed time, local budget estimation, or repeated continuation. When context health requires a new chat, perform a deliberate paired handoff: obtain a handoff from the current ChatGPT conversation, then start both a fresh ChatGPT conversation and a fresh Goose session from that handoff so their working contexts remain aligned.
8. **Repeated recovery is a context-health signal, not a reason to abandon.** The implementation may use a tunable threshold (initially approximately three Goose turns requiring continuation recovery) to request a handoff. The threshold is policy, not an invariant; the paired-handoff rule is the invariant.
9. **Provider-chat instructions must promote graceful context rollover.** The ChatGPT-side system/Project instructions must tell the provider chat to monitor for context degradation using the same principles as the Day Shift planning-chat context-management guidance: preserve the current objective and constraints, prefer a safe checkpoint over grinding into failure, and produce a useful handoff when context quality becomes unreliable. Exact wording may evolve; the requirement must remain.
10. **Timers, heartbeats, and watchers may trigger observation or escalation only.** They may decide that a browser view deserves inspection, refresh, or operator-visible diagnostics. They must not terminate the persistent ChatGPT conversation, abandon its lease, authorize original-prompt resend, or silently start another conversation.

## Consequences

- Existing `abandon` paths are not normal recovery mechanisms and must be removed or narrowed so they cannot retire an ordinary persistent provider chat because observation failed.
- Existing helper-heartbeat/tab-reaping logic must reclaim only disposable browser resources; it must not convert view loss into provider-chat death.
- The recovery state machine should converge on `observe -> hard refresh -> settle -> reassess -> continue if stopped`, with browser replacement only as a view-level fallback. Exact settle times and stale-view detectors remain tunable.
- The old one-continuation limit is incompatible with this decision.
- Any conversation-budget or maximum-length mechanism may provide advisory context-health evidence, but a new provider conversation requires a paired ChatGPT/Goose handoff rather than an independent remote-epoch rollover.
- Qualification must test stale-view recovery, repeated continuation, and paired handoff without relying on abandonment as the success path.
