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

After the tool-bridge milestone is closed:

- Prefer headless browser operation for normal automated ChatGPT turns so Chrome does not steal focus or move user input into a newly opened browser window.
- Keep interactive login, account setup and connector configuration headed/visible.
- If headless proves incompatible with ChatGPT Web, fall back in this order:
  1. headed without activation/focus theft;
  2. headed and immediately hidden/minimized.
- Investigate why headed managed Chrome showed two ChatGPT tabs during earlier proof runs; session naming explained the second independent turn in those runs, so verify normal operation stays at the minimum required browser surfaces once auxiliary calls are disabled.
- Add recovery for a crashed or externally killed managed browser so a stale Playwright browser/context handle is discarded and a fresh browser is acquired instead of returning `Target page, context or browser has been closed`.
- Improve send-stage diagnostics so a rate-limit dialog that appears after submission is classified explicitly instead of degrading into a generic send acknowledgement timeout.
- Keep rate-limit handling conservative: a confirmed 429 should trigger backoff/stop behaviour with a very low retry cap, never a rapid retry loop.

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
