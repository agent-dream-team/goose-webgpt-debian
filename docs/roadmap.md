# goose-chatgpt-web roadmap

This file is the durable handoff for the next implementation steps. Keep it concise and update it when a milestone materially changes.

## Completed milestone — first real Goose-owned tool round trip

Status as of 2026-08-08: **PASS.** The first real end-to-end Goose-owned tool round trip succeeded (trace `c57eb8d02ba2`): ordinary Goose → `goose-chatgpt-web` standalone full mode → authenticated ChatGPT Web → `Codex Native` connector/tunnel → real Goose-owned MCP tool (`get_proof_nonce`) → matching `function_call_output` resumed the same active browser response → ChatGPT returned the exact unpredictable nonce → Goose displayed it. Exactly one ChatGPT-Web browser turn was created for the successful attempt.

- `setup --full --standalone` is implemented and proven live with the tunnel runtime, MCP broker, authenticated ChatGPT Web path, and a real Goose-owned tool.
- The bridge returns a standard Responses `function_call`; Goose remains the tool executor; the matching `function_call_output` is delivered through `broker.completeTool(...)` into the same active `ChatGptTurnSession`; the bridge does not execute the Goose tool itself.
- Standalone Goose supplies no trusted native-Codex cwd/sandbox authority. The bridge therefore carries only Goose's currently advertised tool registry and leaves cwd/sandbox authority absent rather than fabricating it; the native Codex environment store remains fail-closed.
- The clean proof used `autoApproveToolCalls` for ChatGPT's per-call connector confirmation and `GOOSE_DISABLE_SESSION_NAMING=true` so Goose did not generate a second concurrent provider/browser turn merely to name the session.
- Goose auxiliary model calls can multiply ChatGPT-Web traffic. Goose 1.45.0 session naming generated a second concurrent ChatGPT browser turn during proof testing. The ChatGPT-Web path should initially run with `GOOSE_DISABLE_SESSION_NAMING=true`. No separate per-tool-call LLM summary request was found in Goose 1.45.0.
- Earlier attempts surfaced a confirmed ChatGPT-side `Too many requests` / 429 condition and, separately, a send-stage acknowledgement timeout while Goose was launching two concurrent browser turns. The send-stage failure was **not** directly confirmed as a 429; current send-stage polling does not invoke the existing rate-limit-dialog detector, so keep that diagnostic gap as a later reliability concern rather than treating the timeout itself as proof of throttling.
- During an earlier cleanup, forcibly killing Playwright/Chrome exposed a stale-browser-handle failure (`Target page, context or browser has been closed`); a clean daemon/service restart (not `pkill -9`) discards the stale handle and lets the browser worker reacquire a fresh one. See the stale-browser-recovery follow-up below.
- Local validation before merge: `bun test tests/*.test.ts` — 262 passed, 0 failed; `bunx tsc --noEmit` — clean. A bounded free-code-worker review found no confirmed defects, and an independent PR review found no blocking code issue.

Closure: implementation, live proof, local validation, scope review, and independent review are complete. PR #3 is the merge vehicle for this milestone. After it is merged, continue from the next milestone in fresh ChatGPT and Goose sessions.

## Next milestone — browser UX and reliability

Status as of 2026-08-08: **PASS (fallback #2).** Three mechanisms were tried in order:

1. Headless by default (`agent/managed-chrome-headless-default`, draft PR #4, not merged) — **blocked**: `chatgpt.com` serves a Cloudflare `Just a moment...` bot-check to Playwright's headless Chromium and never exposes the composer, even with the identical stored session that succeeds headed. Do not revisit without a validated anti-detection change; this repo does not do Cloudflare-bypass work.
2. Headed without activation/focus theft — **blocked**: a deterministic `NSWorkspace.frontmostApplication` A/B test showed Chrome always activates and steals macOS keyboard focus the instant it shows any real window/tab (confirmed via `chromium.launch()`, via macOS `open -g` non-activating launch, and via a raw CDP `Target.createTarget` call with no Playwright involved at all — all three activate). No Chromium command-line switch suppresses it.
3. Headed, immediately minimized — **implemented**. `pageForNewTurn()` in `src/adapters/chatgpt-web/browser-worker.ts` now minimizes each new managed-Chrome window immediately after creation via CDP `Browser.getWindowForTarget` + `Browser.setWindowBounds({windowState: "minimized"})`, gated on `config.headed` (headless and `launcher` browser-host turns are unaffected; interactive `loginToChatGpt` is untouched and stays visible). Live A/B testing (`NSWorkspace.frontmostApplication` timeline, 4 runs including one real authenticated ChatGPT turn) showed Chrome activates for roughly 2–3 seconds after each new window, then focus reliably returns to the previously-frontmost app on its own; the real ChatGPT composer became reachable and Goose automation continued to work normally while the window stayed minimized for the rest of the turn.

Follow-ups:

- The ~2–3s activation window at turn start is a known, bounded limitation of this fallback, not eliminated by it; do not attempt further focus-suppression tricks without new evidence.

## Completed milestone — bounded browser-reliability follow-ups

Status as of 2026-08-08: **PASS.**

- Stale managed-browser recovery: `ensureManagedBrowser()` in `src/adapters/chatgpt-web/browser-worker.ts` now checks `browser.isConnected()` and `!context.isClosed()` before reusing the cached handle; a dead one is discarded (no process killing — just dropping the reference) and a fresh browser is acquired instead of surfacing `Target page, context or browser has been closed`. Bounded: one check, one relaunch attempt, no retry loop. Live-validated: the cached managed Chrome process was killed with a single targeted `kill -TERM` (not a broad kill), and the next turn transparently acquired a fresh browser and reached `composer_ready` successfully — no stale-handle error surfaced.
- Send-stage 429 detection: `waitForSubmissionAccepted()` now also calls the existing `throwIfChatGptRateLimitDialog()` on every poll, so a rate-limit dialog appearing after submission surfaces as an explicit `429`/`rate_limit_error` instead of degrading into a generic send-stage timeout. Covered by a focused test (dialog visible ⇒ explicit 429, not a hang); a real live 429 was not forced, since reliably reproducing ChatGPT's actual rate limit requires abusive rapid-fire requests, which is out of scope.
- Minimum browser-surface count re-confirmed with `GOOSE_DISABLE_SESSION_NAMING=true`: one ordinary Goose request produced exactly one managed Chrome process and exactly one ChatGPT browser turn, end to end to a correct reply.
- No retry/backoff logic was added — 429 handling stays conservative by construction (surface once, explicitly, and stop; a confirmed 429 should still only ever get a very low retry cap with no rapid retry loop if retry logic is added later).
- Local validation: `bun test tests/*.test.ts` — 273 passed, 0 failed; `bunx tsc --noEmit` — clean.

Newly discovered, explicitly **not fixed** in this milestone (stop-boundary: this is a deeper issue than "died or was externally closed"): after using `codex-chatgpt-web service cancel-turns` to abort a turn that was already stuck in an unrelated pre-existing stage-timeout (`session_verification`, intermittent ChatGPT-side screenshot/DOM flakiness seen throughout this session, unrelated to the browser-worker code), the worker's cached browser handle was observed to still report `isConnected() === true` / `!isClosed()` on the next call, yet a subsequent `context.newPage()` hung for the full stage timeout instead of erroring or succeeding — i.e., a "wedged but technically connected" handle that the new liveness check cannot detect, distinct from an outright-dead handle. A clean daemon/service restart resolved it immediately. Follow-up options for later, not started: a real (bounded, timeout-guarded) CDP round-trip liveness probe instead of the cheap local checks, and/or having `cancel-turns` itself discard the worker's cached browser handle rather than leaving it for the next turn to discover.

## Then — reconcile with upstream before more custom development

Before adding more architecture, inspect the current `miuuyy/codex-chatgpt-web` delta from this fork's base and reuse upstream fixes where possible.

Pay particular attention to newer upstream work around:

- rate-limit handling;
- connector migration/versioning (`Codex Native` / newer connector contracts);
- model/runtime changes;
- browser/runtime reliability;
- any changes that would supersede custom work in this fork.

Do not independently rebuild functionality that upstream already provides cleanly.

## Then — continue the core Goose architecture

Only after upstream reconciliation:

- choose and verify the strongest tool-capable ChatGPT-Web tier suitable as the normal Goose model;
- investigate persistent ChatGPT browser conversation reuse across separate user turns, while Goose remains the canonical durable conversation history;
- broaden Goose-owned tool coverage only after the single-tool lifecycle is solid;
- then revisit Day Shift orchestration, free-worker delegation, provider routing and related refinements.

## Boundaries

- `goose-chatgpt-web` owns ChatGPT Web transport and Goose provider compatibility.
- Day Shift remains a separate orchestration/policy project.
- Reuse Goose-native and upstream mechanisms before creating new orchestration layers.
- Never commit credentials, browser auth state, `.env`, runtime keys or other secrets.
- Keep implementation work on feature branches and draft PRs; no merge without explicit approval.
