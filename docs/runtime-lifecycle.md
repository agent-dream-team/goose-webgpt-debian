# Runtime lifecycle and macOS autostart

Status: **current/proven** through manual/canonical lifecycle, live ordered-autostart triggering, ordinary Goose first turn, and separate dependent continuation. **Actual reboot/login reconstruction is NOT RUN.**

Known-good Electron checkpoint: `c624274` (`Checkpoint proven Electron lifecycle and Goose inference`).
Current-main autostart checkpoint: `dd44b74` (`Add ordered macOS autostart coordinator`).

## Ownership

The standalone Goose runtime has three separately owned infrastructure layers:

1. **Secure MCP Tunnel** — independently supervised outbound connector/tool runtime.
2. **Electron BrowserHost** — bootstrap-only browser owner.
3. **Responses daemon** — independently supervised loopback Responses provider and browser-helper owner.

Goose is outside that infrastructure ownership tree and remains the owner of logical conversation/session state, tools/approvals, delegation, recipes/extensions, project execution, and context lifecycle.

Electron owns BrowserHost only. Do not restore daemon/tunnel ownership to Electron `RuntimeSupervisor`.

## Canonical lifecycle

Startup:

```text
Secure MCP Tunnel ready
  → Electron BrowserHost genuinely ready
    → Responses daemon ready
```

Shutdown:

```text
Responses daemon
  → Electron BrowserHost
    → Secure MCP Tunnel
```

The operator-facing path is:

```bash
codex-chatgpt-web lifecycle <status|start|restart|stop>
```

Use that coordinator rather than manually composing tunnel/service/launcher steps for ordinary operation.

## BrowserHost readiness contract

`lifecycle start` treats BrowserHost as ready only after the existing descriptor-provided helper path succeeds:

1. BrowserHost authenticated/session-ready inspection succeeds.
2. One disposable `lifecycle_*` surface is leased through the BrowserHost control path.
3. The descriptor's helper executable/script is launched with `ELECTRON_RUN_AS_NODE=1`.
4. The helper verifies the exact leased surface.
5. The lease is released in `finally`, including failure paths.
6. A read-only BrowserHost probe confirms the host is usable again.

Do not replace this evidence with Bun-direct Playwright `connectOverCDP()` or another Bun-direct CDP probe. That route has hung/timed out while the same BrowserHost remained healthy through the Node/Electron Node helper path.

## Ordered macOS autostart

The current autostart entry point is:

```bash
codex-chatgpt-web autostart <status|install|trigger|disable>
```

The installed ownership model is:

```text
~/Library/LaunchAgents/
  one project coordinator LaunchAgent
      RunAtLoad=true
      KeepAlive=false
      → canonical lifecycle start

Goose runtime home/launchd/
  daemon launchd definition   (KeepAlive=true)
  tunnel launchd definition   (KeepAlive=true, full mode)
```

Only the coordinator is login-visible. The daemon/tunnel definitions are moved to the runtime-managed launchd directory and are explicitly bootstrapped by the canonical lifecycle in dependency order. This preserves launchd supervision without allowing daemon/tunnel `RunAtLoad` behavior to race BrowserHost construction at login.

Bootstrap-only Electron disables its inherited launcher autostart behavior; the canonical lifecycle is the startup authority.

## Proof register

### PASS

- one login-visible project coordinator LaunchAgent;
- daemon/tunnel launchd definitions managed under the Goose runtime home;
- coordinator invokes canonical `lifecycle start`;
- coordinator `KeepAlive=false`;
- launchd daemon/tunnel ownership loaded correctly;
- canonical lifecycle reports daemon/tunnel/BrowserHost healthy;
- after the earlier live-task self-interference was diagnosed, a fresh ordinary Goose first turn passed;
- a separate dependent `--resume` also passed.

### NOT RUN

- actual Mac reboot/login → automatic reconstruction → ordinary Goose first turn → separate dependent `--resume`.

Do not describe reboot/login recovery as proven before that exact sequence is run.

## Continuation proof boundary

The authoritative ordinary-Goose continuation proof is:

1. run a persisted named Goose session;
2. end that invocation;
3. later perform a separate `--resume` of that persisted session;
4. verify dependent continuation through ordinary Goose/native metadata.

Do not substitute stdin-interactive continuation or a hand-authored raw Responses request carrying only `previous_response_id`.

Fresh ChatGPT Temporary Chats across Goose user turns are expected because Goose, not browser-chat persistence, is the durable conversation authority.

## Self-interference boundary

Do not test stop/restart/autostart lifecycle behavior from an active BrowserHost-backed turn that depends on the exact runtime being manipulated. A prior failed in-task proof was narrowed to this self-interference. It must not be recorded as a general Electron or autostart regression.

## Current non-regression rules

- Keep daemon and tunnel supervision independent from Electron.
- Keep the canonical start/stop order above.
- Keep BrowserHost readiness on the descriptor-provided Node/Electron Node helper path.
- Release disposable lifecycle leases in `finally`.
- Preserve the original causal error rather than replacing it with later retry/cleanup symptoms.
- Do not repeat expensive runtime proofs merely because old historical docs mention them; re-run only the proof relevant to a changed contract.
