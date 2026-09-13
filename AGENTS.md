# Goose ChatGPT Web V1 rules

This checkout contains the qualified Goose ChatGPT Web V1. Read `docs/persistent-chat-rebuild-plan.md` before architecture, browser, connector, lifecycle, security, or recovery work; it is now the durable qualification ledger and follow-up-gate authority rather than a pre-V1 design proposal. The exact deployed non-reboot V1 code checkpoint is `2ac2f561a674482d8eccf0e0cc690edc095b7806`; later repository commits may be documentation/closeout only.

Baseline: `miuuyy/codex-chatgpt-web@e85e3693fdb4e3e033348c08df0298c20fcdb612` (v5.0.6 lineage). Inspect current upstream before diagnosing browser/UI/authentication behavior and reuse proven upstream mechanisms where their semantics fit.

## Authority and boundaries

- Goose owns the canonical logical session/transcript projection, tools and approvals, delegation/subagents, project execution, and Goose context lifecycle.
- A persistent ChatGPT conversation is provider-side working continuity only. It may continue only while its recorded Goose projection remains append-compatible.
- **Core persistence invariant:** within that provider layer, the persistent remote object is the server-side ordinary ChatGPT conversation identified by its canonical `/c/<uuid>` conversation ID. BrowserHost tabs, renderer instances, Playwright handles, and launcher process memory are disposable views onto that conversation, never its identity. Loss of a view alone must recover/reopen the same canonical conversation; it is not permission to create a new epoch.
- Goose compaction, truncation, revision, branching, or any other non-append-compatible model-visible history change forces a new remote conversation epoch. Proven remote-conversation irrecoverability or an explicit context/budget boundary may also roll an epoch, but only after bounded same-ID reopen/reconstruction has failed; ephemeral tab/process loss does not qualify.
- Epoch rollover may replay the current canonical Goose projection. Full-history replay is reduced to explicit boundaries, not claimed to be eliminated.
- Do not recreate Goose session, delegation, approval, or context authority inside this repository.
- Model-visible turn identifiers are correlation values, never the sole authorization for local tools.

## Current product boundary

This repository is **Goose ChatGPT Web**, not the inherited Codex product described by the upstream README. For V1 operation and follow-up qualification:

- **Rebuild-owned production path:** `runtimeKind=persistent-rebuild`, core/profile root `~/.local/share/goose-chatgpt-web-rebuild`, persistent Goose Responses facade, Session Broker, rebuild connector gateway, launcher-owned BrowserHost, and the reused `Goose Native 2nd Shift` tunnel/connector identity.
- **Borrowed development mechanisms:** Electron BrowserHost/profile/session ownership, embedded ChatGPT login/browser surface, selected Playwright/DOM/auth helpers, packaging/runtime installation primitives, and launcher supervision where explicitly adapted. Borrowing a mechanism does **not** import its Codex setup semantics.
- **Retired legacy appliance:** `/home/dreamteam/repos/goose-webgpt-debian` and `~/.goose-chatgpt-web-dev` were removed after the V1 cutover on 2026-09-13. They are historical evidence only and are not a supported rollback route.
- **Inherited upstream surfaces that are not rebuild workflow:** top-level README Quick Start, browser smoke → Install models, Setup/MCP pages, Codex route/catalog integration, `Codex Native2`, Bigger Context, Zero Risk/manual mode, Codex compaction/subagents, and default `~/.codex-chatgpt-web` / `~/.config/Codex Web GPT` production profile. Do not use these to configure, qualify, or repair the persistent rebuild.
- **Qualification-only scaffolding:** `.qualification/`, isolated worktrees, VNC/x11vnc, and source/account-fence/Xvfb launch helpers are disposable local evidence unless explicitly promoted. `.qualification/` is ignored and should be removed once its durable conclusions are recorded.

If an inherited UI or document conflicts with this section or `docs/persistent-chat-rebuild-plan.md`, treat it as heritage/reference and stop before acting on it.

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

Gate sequencing and current qualification status live in `docs/persistent-chat-rebuild-plan.md`; do not infer the next gate from this rules file. Later evidence may reopen any contradicted contract.

For documentation work apply the current Day Shift lean-documentation skill. Before source/configuration changes apply the current code-maintainability skill and the plan's upstream keep/adapt/delete/excise boundary. Future behavior belongs in the plan until implemented and qualified; current-state documentation must describe only what is actually true.
