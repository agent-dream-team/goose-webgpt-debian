# Architecture

Status: **current/proven** for the runtime architecture described here. Goose Control is marked separately as the next **active** milestone.

## Runtime shape

```text
Goose
  │ custom ChatGPT-Web Responses provider
  ▼
Responses daemon (independently supervised, loopback)
  │
  ├─ bounded response/turn replay state
  ├─ capability broker in full mode
  └─ browser helper
          │ BrowserHost control + CDP
          ▼
  Electron BrowserHost (bootstrap-only)
          │ authenticated task-bound surface
          ▼
  ChatGPT Temporary Chat

Full-mode tool path:
ChatGPT → Goose Native → Secure MCP Tunnel → active Goose tool contract
       ← same browser response ← tool result ← Goose execution/approval
```

## Ownership contracts

### Goose

Goose is the source of truth for:

- logical conversation/session state;
- tools and approvals;
- delegation/subagents;
- recipes/extensions;
- project execution;
- compaction/context lifecycle.

Browser chats are transport state, not durable Goose history.

### Responses daemon

The daemon owns the loopback Responses provider surface, bounded response replay/turn correlation, the full-mode capability broker, and the browser-helper client process. It is supervised independently of Electron.

### Electron BrowserHost

Electron owns BrowserHost only:

- the authenticated ChatGPT partition;
- task-bound browser surfaces;
- BrowserHost control endpoint;
- CDP endpoint;
- surface lease/release and BrowserHost-local cleanup.

In standalone Goose bootstrap-only mode, Electron must not adopt, restart, drain, or stop the Responses daemon or Secure MCP Tunnel. The inherited `RuntimeSupervisor` still exists in the launcher code for other modes; it is **not** the standalone ownership contract and must not be restored as daemon/tunnel owner.

### Secure MCP Tunnel

The tunnel is independently supervised below the connector/tool path. In full mode it carries `Goose Native` connector calls back to the active Goose turn. Restarting the daemon alone is not equivalent to restarting a tunnel-owned connector child after a public tool-contract change.

## Browser-turn contract

Each logical Goose user turn may use a fresh ChatGPT Temporary Chat. Goose sends the accumulated context it wants the provider to see; physical browser-chat reuse is not required for Goose continuation.

For a tool-capable turn:

1. the daemon creates a bounded browser-turn capability;
2. ChatGPT requests an action through `Goose Native`;
3. the bridge returns a normal provider tool call to Goose;
4. Goose executes/approves the tool;
5. the matching tool result returns with the same logical provider-turn identity;
6. the browser helper resumes the same active ChatGPT response;
7. completion revokes the capability and releases the BrowserHost surface.

Goose continuation has been proven with a persisted named Goose session and a separate later `--resume`. A raw `previous_response_id` request is not a substitute for native Goose continuation metadata.

## BrowserHost readiness

Usable BrowserHost readiness is stronger than a PID, descriptor, or listening CDP socket.

The canonical lifecycle readiness proof:

1. waits for authenticated BrowserHost session readiness;
2. leases exactly one disposable lifecycle surface through the BrowserHost control path;
3. reads the descriptor-provided helper executable/script;
4. runs that helper with Node/Electron Node semantics and `ELECTRON_RUN_AS_NODE=1`;
5. verifies the exact leased surface;
6. releases the disposable lease in `finally`;
7. verifies BrowserHost is idle/usable again.

Bun-direct Playwright/CDP is not authoritative readiness evidence because that path has produced false hangs/timeouts against an otherwise healthy BrowserHost.

## Canonical lifecycle and autostart

```text
start: tunnel ready → BrowserHost genuinely ready → Responses daemon ready
stop:  Responses daemon → BrowserHost → tunnel
```

Ordered macOS autostart uses one login-visible project coordinator LaunchAgent. The coordinator invokes canonical `lifecycle start` and has `KeepAlive=false`; daemon/tunnel launchd definitions are managed under the Goose runtime home and are loaded/supervised by launchd after canonical startup.

The coordinator design prevents three independent login startup paths from racing and preserves the canonical dependency order.

Actual Mac reboot/login reconstruction is **NOT RUN**. See [`runtime-lifecycle.md`](runtime-lifecycle.md) for the proof register.

## Self-interference boundary

An active BrowserHost-backed agent turn must not be used as proof that stopping/restarting the same BrowserHost stack is safe. An earlier failed in-task autostart/lifecycle proof was narrowed to that self-interference and is not a general Electron regression.

## Goose Control — active next milestone

Goose Control is above Goose's persisted session boundary, not below it:

```text
ChatGPT Planner
  → private custom GPT
  → GPT Action
  → authenticated HTTPS REST/OpenAPI Goose Control facade
  → authenticated loopback goose serve ACP
  → persisted Goose session
```

Goose Control must not depend on Electron windows, CDP targets, ChatGPT browser-session identity, or BrowserHost process identity. It is also separate from Goose Native's per-turn `turn_token` capability.

ACP is the settled Goose-side control backend. A later Orchestrator/Palmate layer may become a workflow target behind Goose Control, but it is not the Goose Control transport.

See [`goose-control-plan.md`](goose-control-plan.md).
