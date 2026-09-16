# Goose ChatGPT Web V1 rules

This checkout contains the qualified Goose ChatGPT Web V1. Read `docs/persistent-chat-lifecycle.md` before architecture, browser, lifecycle, or recovery work; it owns the non-negotiable persistent-conversation invariants. Then read `docs/persistent-chat-follow-up.md` for the current implementation/qualification gaps. The qualified installed runtime behavior is based on source checkpoint `15fbb7e25e00b7eed63e5313a090e79818fa4bf3` (`Support two persistent GCW execution slots`), immutable bundle `bf526d243be697bf7d116a5c3f3394e3948307f80ffa61223e25753c16b2090d`, AppImage SHA-256 `7bd181efad6cee39144f5ddcf90e556aad73fdd0b95ae04aa735e367187b4311`. Repository HEAD may be newer, but source after that checkpoint is not installed authority until separately packaged and qualified.

DreamBook repository authority: `origin` must be `agent-dream-team/goose-webgpt-debian`. Do not point this checkout at `luke-m-selway/goose-chatgpt-web`; that repository is reserved for later cross-platform/macOS adaptation of the V1 design.

Baseline: `miuuyy/codex-chatgpt-web@e85e3693fdb4e3e033348c08df0298c20fcdb612` (v5.0.6 lineage). Inspect current upstream before diagnosing browser/UI/authentication behavior and reuse proven upstream mechanisms where their semantics fit.

## Authority and boundaries

- Goose owns the canonical logical session/transcript projection, tools and approvals, delegation/subagents, project execution, and Goose context lifecycle.
- A persistent ChatGPT conversation is provider-side working continuity only. It may continue only while its recorded Goose projection remains append-compatible.
- **Core persistence invariant:** the durable execution context is a pair: the persisted local Goose session/transcript plus the server-side ordinary ChatGPT conversation identified by its canonical `/c/<uuid>` conversation ID. Provider HTTP requests, connector attachments, BrowserHost tabs, renderer instances, Playwright handles, helpers, and launcher process memory are disposable attachments/views, never either chat's identity.
- **Recovery invariant:** persistent context pairs are reattached, not abandoned. Browser/DOM/heartbeat/elapsed-time failure may trigger refresh/view recovery and, after a fully settled stopped/error view with no intended final and no unresolved Goose tool work, an internal same-chat continuation prompt. It must not retire the Goose session, terminate the provider chat, click Retry, resend the original Goose turn, or independently start another ChatGPT conversation.
- **Paired-context invariant:** one Goose chat and one ChatGPT provider chat remain context partners until deliberate handoff. When context health requires rollover, obtain a handoff and start both a fresh ChatGPT conversation and a fresh Goose session; do not roll only the provider chat while continuing the old Goose session.
- Detailed lifecycle semantics, including continuation-as-GCW-artifact and the requirement for ChatGPT-side context-degradation/handoff instructions, are owned by `docs/persistent-chat-lifecycle.md`.
- Do not recreate Goose session, delegation, approval, or context authority inside this repository.
- Model-visible turn identifiers are correlation values, never the sole authorization for local tools.

## Current product boundary

This repository is **Goose ChatGPT Web**, not the inherited Codex product described by the upstream README. For V1 operation and follow-up qualification:

- **Rebuild-owned production path:** `runtimeKind=persistent-rebuild`, core/profile root `~/.local/share/goose-chatgpt-web-rebuild`, persistent Goose Responses facade, Session Broker, rebuild connector gateway, launcher-owned BrowserHost, and the reused `Goose Native 2nd Shift` tunnel/connector identity.
- **Borrowed development mechanisms:** Electron BrowserHost/profile/session ownership, embedded ChatGPT login/browser surface, selected Playwright/DOM/auth helpers, packaging/runtime installation primitives, and launcher supervision where explicitly adapted. Borrowing a mechanism does **not** import its Codex setup semantics.
- **Retired legacy appliance:** `/home/dreamteam/repos/goose-webgpt-debian` and `~/.goose-chatgpt-web-dev` were removed after the V1 cutover on 2026-09-13. They are historical evidence only and are not a supported rollback route.
- **Inherited upstream surfaces that are not rebuild workflow:** Codex route/catalog integration, Setup/MCP mutation paths, browser smoke → Install models, `Codex Native2`, Bigger Context, Zero Risk/manual mode, Codex compaction/subagents, and default `~/.codex-chatgpt-web` / `~/.config/Codex Web GPT` production profile. Obsolete upstream operator documentation has been removed; do not recreate it as current Goose guidance.
- **Qualification-only scaffolding:** `.qualification/`, isolated worktrees, VNC/x11vnc, and source/account-fence/Xvfb launch helpers are disposable local evidence unless explicitly promoted. `.qualification/` is ignored and should be removed once its durable conclusions are recorded.

If an inherited UI/code path conflicts with this section, `docs/persistent-chat-lifecycle.md`, or `docs/persistent-chat-follow-up.md`, treat it as non-authoritative and stop before acting on it.

## Safety and isolation

- The pre-rebuild appliance and its mutable state were retired after V1 cutover. Do not recreate them as an implicit fallback; any future rollback design must be explicit and independently qualified.
- The production mutable root is `~/.local/share/goose-chatgpt-web-rebuild`; do not share its browser profile, broker database, connector authorization, or tunnel runtime with another CGW appliance.
- The package-owned account fence remains the local single-appliance authority. Defensive checks for historical legacy paths may remain in code, but those paths are not production infrastructure.
- The dedicated `CGW Provider Sessions` Project with project-only memory is the accepted provider-chat topology for Gate 0, but it is a **behavioral** correctness mechanism rather than a security boundary: ChatGPT can technically reference sibling Project chats. Project instructions require each provider chat to ignore sibling memory, and correctness must not treat sibling inaccessibility as guaranteed. Any observed cross-session bleed halts shared-Project use until a fallback topology is qualified.
- Never print, log, commit, or expose credentials, cookies, runtime keys, host-held connector authentication, or other secrets. Durable ChatGPT history also requires explicit local-data retention/redaction controls.
- Do not use broad process kills. Target only positively identified rebuild-owned processes during an explicitly authorized qualification gate.
- Do not mutate live ChatGPT/browser/runtime/service/tunnel/account state unless the current qualification gate explicitly authorizes it.
- Never auto-answer a ChatGPT connector approval surface. Unexpected approval/permission UI is `HUMAN_REQUIRED`/`UNCERTAIN`; neither automatic Allow nor automatic Deny is a valid rebuild recovery action.

## Workflow

Current follow-up priorities and qualification gaps live in `docs/persistent-chat-follow-up.md`; do not infer current work from old commits, historical PR discussion, or retired gate evidence.

For documentation work apply the current Day Shift lean-documentation skill. Before source/configuration changes apply the current code-maintainability skill and preserve the product boundary documented here and in the follow-up plan. Future behavior belongs in the plan until implemented and qualified; current-state documentation must describe only what is actually true.
