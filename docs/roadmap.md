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

Previously discovered, explicitly not fixed in this milestone: a "wedged but technically connected" cached-browser handle (`isConnected() === true` / `!isClosed()` yet `context.newPage()` hangs) after `service cancel-turns` aborts a turn mid stage-timeout. Fixed in the next milestone below.

## Completed milestone — connected-but-wedged managed-browser liveness probe

Status as of 2026-08-09: **PASS.**

- Root cause: `service cancel-turns` aborts the `AbortController`/timeout race in `runStage()`, but the underlying in-flight Playwright/CDP call is not itself cancelled — it keeps running against the real browser process. If that leaves the browser's CDP message handling backed up (e.g. mid an unrelated `session_verification` DOM stall), the WebSocket transport stays open (`isConnected() === true`) and the context is never explicitly closed (`!isClosed()`), but the browser stops answering CDP commands. Both existing checks are local flags, not round trips, so they cannot see this; the next `context.newPage()` then hangs for the full stage timeout instead of failing fast.
- Fix: `ensureManagedBrowser()` in `src/adapters/chatgpt-web/browser-worker.ts` now also runs `isManagedBrowserConnectionLive()` before trusting a cached connection — a bounded (`MANAGED_BROWSER_LIVENESS_PROBE_TIMEOUT_MS` = 3s), real `context.cookies()` CDP round trip (`Storage.getCookies`), chosen because it's the cheapest real round trip `BrowserContext` exposes with no visible side effect and no page required. On timeout or rejection the cached browser/context is discarded exactly like the existing dead-handle path (no process killing) and a fresh managed browser is acquired on the same call. One probe, no retry loop.
- Live-validated with a real Chrome process and the real stored login state (in-process, calling `ensureManagedBrowser()` directly against the real config, bypassing HTTP): call 1 launched a fresh managed Chrome; call 2 reused it via a healthy ~7ms liveness round trip; `SIGSTOP` on that Chrome process reproduced the exact "connected but wedged" symptom (`isConnected()` still `true`, no CDP responses); call 3 detected the wedge (bounded ~3s probe timeout), discarded the stale handle, and transparently relaunched a fresh managed Chrome (~5.1s total) — no daemon restart; call 4 confirmed the newly recovered browser became the healthy cached one. The real daemon service was restarted once to load the new code (not as part of the recovery mechanism itself) and came back up healthy.
- Not re-validated live in this milestone: the "one ordinary Goose turn creates exactly one browser surface with `GOOSE_DISABLE_SESSION_NAMING=true`" regression check from the prior milestone. The real `codex` CLI binary (required for the `codex-acp`/"Codex Native" route this repo hijacks via `route connect`) is not installed in this environment, and installing it plus mutating the shared global `~/.codex/config.toml` was judged disproportionate for a change that does not touch turn-creation, browser-surface counting, or session-naming logic at all — only the internal cached-connection liveness check inside `ensureManagedBrowser()`. Re-run that specific check if this environment gains a working `codex` CLI.
- Local validation: `bun test tests/*.test.ts` — 278 passed, 0 failed; `bunx tsc --noEmit` — clean.

## Completed milestone — ChatGPT-Web as ordinary Goose's main provider

Status as of 2026-08-09: **PASS.** Ordinary Goose (the real Goose Desktop/CLI at `/Applications/Goose.app`, not a scratch script) is cut over to ChatGPT Web as its normal main model, with Claude ACP and Codex ACP left fully configured as fallbacks.

- Goose 1.45.0 has no built-in provider that speaks the Responses API to a custom host — the plain `openai` provider is hardcoded to `v1/chat/completions`, and `chatgpt_codex` is hardcoded to `https://chatgpt.com`. The actual mechanism is Goose's **custom provider** feature (`goose configure` → `Custom Providers` → `Add A Custom Provider` → `OpenAI Compatible`, or the underlying `~/.config/goose/custom_providers/*.json`): `engine: "openai"` with `base_path: "v1/responses"` and `base_url` pointing at the daemon's loopback port. `requires_auth: false` since the bridge does not check the Responses endpoint's bearer. This created `custom_chatgpt_web__local_1` (`~/.config/goose/config.yaml`, `active_provider: custom_chatgpt_web__local_1`, model `chatgpt-web/medium`), and is now the durable, documented way to point ordinary Goose at this bridge — `providers.openai` in `config.yaml` is not it and does not work.
- Found and fixed a real bug blocking every tool-calling round trip through this path: standalone Goose re-stamps a live `<turn-context><current-time>...</current-time>...</turn-context>` block into the resent user message on every provider round, including the follow-up request that carries the `function_call_output` for the same logical turn. `tagStandaloneIdentity`'s digest and `extractChatGptTurnUserRevision` both hashed that raw content, so any tool round trip crossing a wall-clock minute (effort selection alone regularly takes ~20s) produced a different standalone identity for the follow-up request than the original — missing the existing `ChatGptTurnSession`, so the follow-up silently opened a second, independent browser turn instead of resuming the first. Fixed by stripping the volatile `<turn-context>` block before hashing (`stripVolatileTurnContextParts` in `src/adapters/chatgpt-web/environment.ts`, used by both `extractChatGptTurnUserRevision` and a new `standaloneIdentityPrefix` in `src/server.ts`). `bun test tests/*.test.ts` — 278 passed, 0 failed; `bunx tsc --noEmit` — clean.
- Live-validated end-to-end with the real Goose CLI (`goose run`), the real standalone `full` daemon (`~/.goose-chatgpt-web-dev`, mode `full`, `standalone: true`), and a real Goose-owned MCP tool (`--with-extension` running `scripts/proof-mcp-server.ts`'s `get_proof_nonce`, exposed as `bun__get_proof_nonce`): exactly one browser turn was created (trace `f6f319dce72c`), the tool call was queued/delivered/completed on that same trace, and ChatGPT relayed the exact unpredictable nonce back into the same turn, which Goose displayed correctly. `GOOSE_DISABLE_SESSION_NAMING=true` is set durably in `config.yaml`.
- ChatGPT's own MCP connector intermittently declines a tool call with "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request" or silently skips the call ("No value was returned."), on requests that are otherwise identical to ones that succeed. Observed on 2 of 4 fresh-identity attempts in one session; not something this bridge controls (it is ChatGPT's own connector-side gate on the `autoApproveToolCalls` auto-click), so treat tool-calling turns as retriable rather than guaranteed-first-try.
- Not re-validated: `doctor`'s tunnel-readiness check is unreliable — it reported "Tunnel runtime is not ready" / a stale `OnStop` log line even immediately after a successful `tunnel restart`, while the tunnel's own health endpoint and real browser/tool traffic were actually healthy. Don't trust `doctor`'s tunnel section as a go/no-go signal without also checking `curl $(cat "~/Library/Application Support/tunnel-client/health/codex-chatgpt-web.url")`.

## Completed milestone — unrestricted Goose tool handoff and native strictly-free delegation

Status as of 2026-08-09: **PASS.** ChatGPT-Web (`chatgpt-web/medium`) as ordinary Goose's main model is now live-proven using the Goose Native v4 connector/action contract, including generic Goose tool execution and first-class Goose-native delegation to an explicit strictly-free OpenRouter worker.

- Goose Native v4 connector selection and the direct `turn_token` contract are live-proven in ordinary Goose conversations with ChatGPT-Web as the main model.
- Generic Goose tool gateway: `codex_tool_inventory` discovered the actual Goose tool registry; the Goose command tool's `wire_name` was `shell`; `codex_tool_call` invoked it successfully; exact output returned: `GOOSE_GENERIC_TOOL_OK`.
- First-class Goose-native delegation is live-proven end to end: Goose Native exposes `goose_delegate`; ChatGPT accepted the action; Goose delegate execution started with provider `openrouter` and model `poolside/laguna-s-2.1:free`; the delegated worker returned exactly `FREE_WORKER_DELEGATION_OK`; that result returned to the parent ChatGPT-Web conversation. No Day Shift or paid provider/model fallback was used for this proof.
- Deployment lesson: the Secure MCP Tunnel owns a persistent stdio MCP child independently of the HTTP daemon. Restarting only the HTTP daemon does **not** refresh that child. After MCP action/schema changes, restart the established tunnel service while preserving tunnel identity, then refresh the ChatGPT-side Goose Native app so the updated contract is visible.
- Remaining compatibility follow-up: `codex_exec` still assumes Codex-style `exec_command` / `shell_command` or a native exec gateway and does not directly handle Goose's `shell` tool. This is a convenience-action compatibility issue only; the generic Goose tool gateway and native delegation milestone are both already proven.

## Upstream reconnaissance snapshot — `miuuyy/codex-chatgpt-web` v2.1.4

Audit date: **2026-08-09.** Upstream's latest release is v2.1.4. At the audit point this fork and upstream were materially diverged (upstream had 12 commits after the common base and this fork had 8 fork-specific commits). Do **selective reconciliation**, not a blind merge.

### Reuse/adapt before independently designing

1. **Fresh connector ABI identity + permissions.** Upstream's v2.1 line replaces the legacy `Codex Native` public MCP contract with a fresh `Codex Native2` identity because ChatGPT caches the MCP contract by connector identity. Upstream explicitly requires `Authentication: None` and **Allow all actions**; `Allow low-risk actions` blocks commands/patches before they reach the outer harness. For Goose, create/adapt a fresh Goose-specific connector identity rather than renaming/refreshing the old connector. Goose remains the final executor and approval/sandbox authority.
2. **v4 direct turn-token bridge.** Upstream removed the model-visible bind handshake. Six stable public MCP gateway actions accept the trusted turn capability directly while binding leases remain private in the runtime: `codex_exec`, `codex_write_stdin`, `codex_apply_patch`, `codex_view_image`, `codex_tool_inventory`, `codex_tool_call`. Adapt the transport concept/naming to Goose rather than extending the old v3 handshake.
3. **Descriptor-driven command dispatch.** Upstream no longer assumes one command ABI: gateway-only turns inspect the authoritative `ALL_TOOLS` registry and select exactly one of `exec_command` or `shell_command`, then map arguments to that ABI. Zero or multiple command candidates fail closed. Reuse this principle anywhere Goose tool descriptors differ from Codex.
4. **Context/usage accounting.** Upstream measured browser transport ceilings separately from underlying model context and recalculates usage after every tool-result round so compaction can trigger during long tool loops. Do not invent independent limits without first adapting/checking upstream's current measurements.
5. **Account-capability/model gating.** Upstream now dynamically exposes routes based on the authenticated account: Free/Go → Luna; Plus → Instant/Medium/High; Pro additionally gates Extra High/Pro. Audit this fork's static Goose picker against upstream rather than assuming every visible route is account-valid.
6. **Luna continuity lesson.** v2.1.4 changed rolling checkpoints from model-authored JSON to model-authored semantic text with bridge-owned serialization after malformed quoted content broke completed turns. If Goose ever needs checkpointing, keep semantic state model-owned and serialization deterministic/runtime-owned.
7. **Reliable configuration/lifecycle ideas.** Upstream has reversible route journaling, authenticated drain/shutdown, explicit active-request/browser-session counters, bounded crash recovery, and explicit HTTP/SSE negotiation. These are useful references, but much of the concrete code is Codex/launcher-specific; adopt only where Goose has the same problem.

### Upstream work that does not replace Goose-specific work

- **Native Web subagents:** upstream can expose `chatgpt-web/*` routes to Codex `spawn_agent`. This proves useful subagent plumbing is possible but does not replace the intended Goose path: ChatGPT-Web main → Goose-native `delegate`/summon → explicit free OpenRouter worker.
- **Electron browser host:** upstream owns a persistent Electron partition with up to five task-bound `WebContentsView` surfaces and a system-Chrome login handoff. Benefits include stronger task/surface isolation, bounded parallelism, integrated diagnostics, and potentially no ordinary Chrome focus theft. Do **not** migrate now: this fork's headed managed-Chrome path is already proven on the target Mac, simpler, and has bounded minimize/stale/wedged recovery. Revisit Electron only if concurrency/focus/browser-ownership become dominant problems.
- **Codex route/config integration:** upstream's model catalog injection, `openai_base_url` journaling and Codex feature toggles are primarily Codex-specific. Goose uses its custom OpenAI-compatible provider and should not inherit unnecessary Codex configuration machinery.
- **Windows launcher fixes:** track but do not port unless needed on this target. Open upstream PR #92 currently addresses Windows Chrome 151 login, Node/Bun differences, locale-independent composer selection, and partitioned-cookie handling; the selector/cookie lessons may be reusable later.

### Known upstream dead ends / still-open problems — do not rediscover them

- **Browser context ceiling (#76):** attaching canonical context as a file was rejected as a correctness path because ChatGPT may ignore/partially read it and consumption cannot be proven. Merely advertising a larger context window cannot bypass the composer/send limit. The deterministic larger-context transport problem remains open upstream.
- **Headless / centralized deployment (#58):** still open upstream. This fork already proved headless branded Chrome hits a Cloudflare challenge; do not pursue stealth/Cloudflare bypass.
- **Persistent normal ChatGPT chats (#94):** still only a feature request upstream. Persistent browser-conversation reuse across Goose user turns remains genuinely future work; Goose must remain canonical durable history unless/until a stronger design is proven.
- **Pro mode local tools:** upstream currently treats ChatGPT Pro mode as unable to initiate the custom MCP connector; do not assume the highest visible ChatGPT mode is tool-capable.

### Standing upstream-reconciliation rule

Before substantial new bridge/browser/tool work, check current upstream first. Classify each relevant upstream change as **adopt directly / adapt for Goose / already superseded here / irrelevant to Goose / deliberately defer**. Prefer a small compatibility note/update over rediscovering behavior experimentally.

## Then — continue the core Goose architecture

After the live-proven connector/tool/delegation milestone and the selective v2.1.4 reconciliation:

1. Fix the small `codex_exec` → Goose `shell` compatibility gap so the convenience action can dispatch Goose's actual command descriptor directly; keep `codex_tool_inventory` + `codex_tool_call` as the already-proven generic path.
2. Use ChatGPT-Web + Goose tools + free delegated workers for the bulk of subsequent `goose-chatgpt-web` development. ChatGPT-Web may inspect/edit/test/commit its own source tree, but should stop before replacing/restarting the live bridge carrying its current conversation; do runtime replacement and validation at a clean turn boundary. Claude/Codex remain fallback/recovery providers if the ChatGPT-Web runtime itself is broken.
3. Choose and verify the strongest **tool-capable** ChatGPT-Web tier suitable as the normal Goose model. Do not select purely by nominal reasoning strength; account capability, MCP availability, browser limits and reliability matter. Medium/High are the current Plus upstream tool-capable routes; verify High after the bridge reconciliation.
4. Broaden Goose-owned tool coverage and realistic delegated repository work now that the single explicit strictly-free worker lifecycle is live-proven.
5. Investigate persistent ChatGPT browser conversation reuse across separate user turns only later, while Goose remains the canonical durable conversation history.
6. Revisit browser architecture only if needed: first see whether managed Chrome can support explicit task/surface ownership and bounded parallelism; consider upstream's Electron host only if it materially solves a demonstrated focus/concurrency/lifecycle limitation.
7. Revisit Day Shift orchestration/provider-routing refinements only if native Goose delegation proves insufficient for a concrete requirement.

## Boundaries

- `goose-chatgpt-web` owns ChatGPT Web transport and Goose provider compatibility.
- Day Shift remains a separate orchestration/policy project.
- Reuse Goose-native and upstream mechanisms before creating new orchestration layers.
- Never commit credentials, browser auth state, `.env`, runtime keys or other secrets.
- Keep implementation work on feature branches and draft PRs; no merge without explicit approval.
