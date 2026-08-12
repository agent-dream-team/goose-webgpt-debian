# Security model

Status: **current/proven** for the existing runtime. Goose Control notes are **active design** until that surface is implemented.

## Trust boundaries

The user trusts:

- Goose as the outer harness;
- the local Responses daemon;
- the project-owned Electron BrowserHost and its private authenticated ChatGPT partition;
- the selected ChatGPT account/workspace;
- the Secure MCP Tunnel in full mode;
- the exact `Goose Native` connector configured for the active Goose turn.

Repository contents, websites, tool output, prompt text, and model output are untrusted data.

## Full-mode capability flow

1. Goose sends a Responses-compatible provider request to the loopback daemon.
2. Tool authority comes only from the active Goose turn/tool contract, never from user-authored prompt text.
3. The daemon creates a random bounded per-turn capability.
4. ChatGPT can request an action through the current `Goose Native` connector.
5. The connector/tunnel path returns a normal provider tool request to Goose.
6. Goose remains responsible for tool registry, execution, approvals/sandboxing, delegation, and tool results.
7. The matching result returns to the same logical browser response.
8. The turn capability is revoked on completion/abort/failure.

The bridge transports model decisions; it does not add a second planner, semantic router, or fallback model.

## Runtime ownership as a security boundary

Standalone Goose intentionally separates:

- Responses daemon;
- Electron BrowserHost;
- Secure MCP Tunnel.

Electron must not adopt or stop daemon/tunnel ownership. Lifecycle operations must target the exact project-owned component and use the canonical dependency order.

BrowserHost readiness is also part of the safety boundary: PID/descriptor/CDP existence alone is insufficient. The authoritative lifecycle readiness path verifies a disposable leased surface through the descriptor-provided Node/Electron Node browser helper and releases that lease cleanly.

## Principal risks

### Prompt injection and destructive tool use

ChatGPT sees untrusted repository/tool content. In full mode it can request write/command actions only if Goose exposes them. Keep Goose's sandbox/approval policy appropriate for the workspace and task. The connector must not widen authority beyond the active Goose turn.

### Browser session theft

The Electron BrowserHost partition authorizes ChatGPT access. Keep it in private local application state; never copy it into prompts, diagnostics, Git, uploads, or shared artifacts. Revoke/sign out the ChatGPT session after suspected exposure.

### Tunnel/runtime credential theft

Tunnel/runtime credentials are sensitive. Keep them in user-private storage and out of command-line arguments, logs, prompts, generated public profiles, and Git. Rotate after suspected exposure.

### Same-user local process

Responses, BrowserHost control, CDP, and planned ACP client surfaces are loopback/private. Loopback does not defend against another malicious process running as the same OS user. Treat same-user local code execution as inside the trust boundary.

### Browser/UI drift

ChatGPT DOM/page behavior is not a stable API. Automation must use bounded evidence and fail closed on drift. Do not silently switch model, reasoning mode, browser transport, or provider.

### Cross-turn data leakage

Goose is the durable conversation source of truth. Browser surfaces and Temporary Chats are transport state. The authenticated partition is shared only for login/session state; turn surfaces must remain independently leased/released. Bounded daemon replay state exists only to resume the same logical provider response across tool-result rounds and must not become a second durable conversation store.

### Lifecycle self-interference

An active BrowserHost-backed turn can disrupt itself if it stops/restarts the runtime carrying that turn. Lifecycle/autostart qualification must be performed from an external/operator-safe boundary. A self-interfering failed proof is not evidence of a general BrowserHost regression.

## Goose Control — active design security boundary

The first Goose Control proof is deliberately narrower than the existing Goose Native tool surface:

```text
ChatGPT Planner
  → private custom GPT Action
  → authenticated HTTPS REST/OpenAPI facade
  → authenticated loopback goose serve ACP
  → one server-approved persisted Goose session
```

Required boundaries:

- raw ACP remains loopback/private;
- the Goose server secret never reaches ChatGPT;
- the ChatGPT-reachable HTTPS facade is authenticated and exposes only the documented narrow OpenAPI operation;
- first proof targets exactly one server-approved persisted session;
- no Planner-supplied cwd/provider/model/session creation;
- no arbitrary shell/file/browser/process/tunnel/lifecycle APIs;
- Goose Native `turn_token` authority remains separate and is not reused for Goose Control;
- Goose remains the normal tool/approval/execution authority inside the receiving session;
- `request_id` idempotency prevents ambiguous network/Action retries from appending duplicate Goose turns.

Later async jobs, cancellation, multiple targets, fresh-session profiles, and Orchestrator/Palmate must preserve the same least-authority boundary.

## Network exposure

- Existing Responses/health and BrowserHost control/CDP listeners are loopback-only.
- Full mode uses an outbound Secure MCP Tunnel; it does not require an inbound public listener or router port-forward.
- Goose Control's first proof adds a deliberately narrow authenticated HTTPS facade because GPT Actions require a reachable web surface; raw ACP stays on authenticated loopback behind that facade.

## Non-goals

- Defending against a compromised local OS account or compromised trusted runtime binary.
- Bypassing ChatGPT plan, workspace, usage, connector/action, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI model API contract.
