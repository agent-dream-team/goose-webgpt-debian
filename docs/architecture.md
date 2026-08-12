# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
launcher-owned codex-chatgpt-web daemon
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ ChatGPT browser worker (up to five task-bound Electron tabs)
  ├─ capability broker (full mode only)
  └─ stdio MCP server
            ▲
            │ outbound OpenAI Tunnel
            ▼
      ChatGPT custom connector
```

## Modes

### `browser-only`

- Exposes Instant (`chatgpt-web/light`), Medium, High, and Extra High; each model advertises exactly one
  immutable Codex effort matching its ChatGPT browser mode. `chatgpt-web/pro` is appended only when
  the authenticated account exposes Pro.
- Sends the complete Codex context and image attachments to a fresh ChatGPT Temporary Chat.
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

- Exposes the same fixed models; Instant through Extra High are tool-capable, while Pro remains
  read-only.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call presents the current turn_token directly; the MCP server idempotently claims
  an internal binding and dispatches the call in the same request. The binding is never exposed to
  the model.
- Tool calls and results remain in the same ChatGPT response while the outer harness (Codex or
  standalone Goose) executes them locally.

The ChatGPT connector name is also the public MCP ABI identity. ChatGPT caches a connector's tool
schema and granted action permission by that identity, so the direct turn-token contract uses a
fresh name (`Goose Native`); the retired `Codex Native` identity is never selected or refreshed in
place. Setup and the browser worker fail closed with an explicit migration error rather than
silently reusing a legacy connector's stale contract or permission grant. See
[security model](security-model.md) for the full capability flow.

## Browser lifecycle

The desktop launcher owns one persistent Electron partition and up to five task-bound browser
tabs. Each Codex task is leased an independent `WebContentsView` and surface ID; Playwright attaches
to that exact surface through a launcher-owned loopback CDP endpoint. It does not launch another
browser or copy authentication state. Each tab opens a fresh Temporary Chat, shares only the local
login partition, and keeps its own document and lifecycle. Terminal task tabs are released when the
turn completes, fails, or is aborted; the result/history remains owned by the outer harness rather
than the embedded browser. Closing a running tab destroys its page and terminates that browser turn.
A sixth concurrent turn fails explicitly; the cap avoids excessive parallel traffic that could
trigger account abuse controls.

The complete serialized Codex task is inserted as one inline JSON envelope. Image bytes stay out of
the JSON and are attached natively with stable references. The runtime does not create a context
JSONL file, upload a synthetic context document, include prompt hashes, or truncate the envelope.
Attachment acceptance and send readiness are verified before the turn begins.

The appended models advertise the authenticated account's context window and a ten-percent
auto-compaction reserve. Usage is counted with the GPT-5 tokenizer plus fixed platform/image
reserves, rather than inferred from character length. The ChatGPT composer also has an independent
inline-size boundary: usage accounting asks Codex to compact before that boundary, and a prompt
that still exceeds the proven hard ceiling fails explicitly before any browser turn opens.

Routed compaction v1/v2 runs as a dedicated read-only browser summarization turn with no broker or
local tools, then returns the native replacement-history shape expected by Codex. A prompt-level
checkpoint marker is translated into a visible Codex trace item; tool-capable turns re-bind the
same capability after that checkpoint. Visible ChatGPT status rows become reasoning summaries,
while stable prose between rows becomes native Codex commentary.

## Installation and lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper.
Browser-only mode downloads no browser and requires no system Node/Bun. Full mode separately
downloads the official pinned `openai/tunnel-client` build for the current OS/architecture and
verifies it against the release SHA-256 manifest.

On first launch, the embedded runtime is identity-checked and copied atomically into a private
versioned directory under the application home. Daemon and MCP commands use that durable copy,
which is required because Linux AppImage mount paths are temporary and must never be persisted in
Codex or tunnel configuration.

The canonical operator-facing lifecycle is `codex-chatgpt-web lifecycle <status|start|restart|stop>`.
It reuses the project-owned tunnel and daemon lifecycle implementations and the bootstrap-only
Electron launcher path, in the proved order:

1. tunnel ready;
2. bootstrap-only Electron BrowserHost genuinely ready;
3. BrowserHost authenticated and session-ready;
4. exactly one disposable `lifecycle_*` surface acquired through the launcher control channel;
5. that leased surface verified through the Node-side launcher helper using `ELECTRON_RUN_AS_NODE=1`;
6. the disposable lease released in `finally`;
7. BrowserHost proven idle/usable again;
8. daemon healthy and accepting turns.

The launcher remains BrowserHost-only. It does not own the tunnel or daemon, and its bootstrap-only
shutdown path only releases browser-host state. `scripts/start-goose-launcher.ts` remains an
implementation entrypoint for the launcher process, not the agent-facing lifecycle interface.
Legacy launcher-supervisor ownership notes are historical; do not reintroduce them as the current
operating model.

The lifecycle coordinator deliberately does not use Bun-direct `chromium.connectOverCDP()` as
authoritative BrowserHost health evidence. That path was observed to hang or time out under Bun
even while the same BrowserHost remained healthy. The working readiness proof uses the descriptor's
helper executable/script contract and the Node-side browser-helper maintenance path instead.

Status is observational only: `codex-chatgpt-web lifecycle status` uses a read-only CDP health
signal and does not create or inspect a turn. It must not fail merely because Goose is actively
using ChatGPT Web.

2026-08-12 proof checkpoint:

- canonical manual cold lifecycle: passed;
- ordinary Goose named turn: passed;
- separate named `--resume` continuation: passed;
- active runtime home: `/Users/luke/.goose-chatgpt-web-dev`.

Native login items or an owner-local XDG autostart file launch the app hidden after sign-in. A
marker containing only launcher-owned PIDs lets doctor distinguish the launcher runtime from a stale
or external process.

Setup keeps Codex's built-in `openai` provider and switches only `openai_base_url`. The daemon
forwards the authenticated official model catalog and appends only the routed models owned by the
`chatgpt-web/` namespace; no static catalog is installed.

On this repository, the launcher-local Electron 41.7.1 bundle was observed to partially extract
under Node 24.16.0, leaving `Frameworks` and the Electron version marker missing. The project code
was not the cause. A clean official Electron bootstrap under Node 20.20.2 repaired the launcher
bundle using:

```text
force_no_cache=true npx -y node@20 launcher/node_modules/electron/install.js
```

Before introducing any future local bootstrap workaround, re-check current upstream Electron and
`miuuyy/codex-chatgpt-web`, because this dependency behavior may change.

The built-in provider attempts a Responses WebSocket prewarm. The local route explicitly returns
HTTP `426`, which is Codex's native capability-negotiation signal for an immediate, session-sticky
switch to its HTTP/SSE transport. No model or provider fallback occurs.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports two independent counters:

- active Responses HTTP requests, including native compaction passthrough;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results.

The lifecycle operation proceeds only when both counters are zero. The launcher then stops the
tunnel through its runtime command and asks the daemon to flush state and exit through an
authenticated shutdown endpoint. If the contract is unavailable, malformed, non-idle, or cannot
be completed, the operation fails closed and restores the drained runtime when possible. An
unexpected child exit is recovered with a bounded restart budget; a crash loop becomes an explicit
launcher error.

## Security invariants

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Limit browser turns to five independent task-bound tabs and reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
