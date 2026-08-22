# Debian/Linux portability groundwork

Status: **groundwork / evidence-based** (2026-08-22). Branch: `groundwork/debian-provider`.
Host audited: Debian 12 (bookworm), kernel 6.1.0-43-amd64, glibc 2.36, x86_64.

This document preserves the architectural and platform findings needed before any real
Debian ChatGPT-Web runtime work. It does **not** claim Linux ChatGPT-Web qualification:
no authenticated browser turn has been run on this host yet.

## Scope boundary

This repository owns Debian-specific ChatGPT-Web provider/runtime adaptation only:

- **2nd-shift** — harness / policy / orchestration (out of scope here).
- **this repo** — Debian-specific ChatGPT-Web provider/runtime integration.
- **future broader Goose fork** — general Goose fixes/integrations that are not
  ChatGPT-Web-specific (for example the upstream `verify` regression noted below).

The macOS lifecycle (launchd) is an implementation detail of macOS, not part of the
architecture contract. The portable contracts are: canonical start order
(`tunnel → BrowserHost → daemon`, reverse shutdown), descriptor-provided browser-helper
readiness with `ELECTRON_RUN_AS_NODE=1`, independently supervised daemon/tunnel, and
Electron owning BrowserHost only. See [`architecture.md`](architecture.md).

## Host findings (this Debian 12 machine)

| Area | Finding |
| --- | --- |
| Node | v24.15.0 at `/usr/bin/node`; npm 11.12.1 |
| Bun | Not preinstalled. Repo pins `bun@1.3.14`; installed user-locally to `~/.bun` (`curl bun.sh/install`, reversible). `installedBunExecutable()` (`src/config.ts:183`) finds it via PATH |
| Chromium/Chrome/Electron binaries | None installed. `apt` candidate `chromium 151.0.7922.137-1~deb12u1` available; Firefox present but not usable by this code path |
| Electron shared-library deps | All present: libgtk-3-0, libnss3, libasound2, libgbm1, libxss1 |
| Display | Xorg server packages installed; sddm active. The agent user's session is **tty-only** (`DISPLAY`/`WAYLAND_DISPLAY` empty); the graphical seat belongs to another user account and must not be touched. Electron BrowserHost needs a real display session for the runtime user (graphical login, or bounded `xvfb-run` experiments; `xvfb` is not installed) |
| systemd | `systemd --user` is running for this user. Deliberately **unused**: per task boundaries there must be no systemd/autostart work until the runtime is proven manually |
| Goose | `goose 1.47.0` at `~/.local/bin/goose` |
| Config paths | Runtime home defaults to `~/.codex-chatgpt-web` (`CODEX_CHATGPT_WEB_HOME` override; `src/config.ts:86`). Non-XDG-conventional but consistent between provider core and installer. Launcher-side honors `XDG_CONFIG_HOME`/`XDG_DATA_HOME` |

## Portability map

Evidence-based inventory (file:line verified on branch tip `a3785fa`). Git archaeology:
190-commit linear history, single origin, zero prior Linux-specific commits; the
`groundwork/debian-provider` branch started as a fresh pointer at `a3785fa`.

### Reusable unchanged on Linux

- Provider core transport: Responses daemon/server, SSE pull-stream strategy groups
  Darwin+Linux together (`src/server.ts:76-80`, `src/bridge.ts:873-884`); Responses
  parsing/replay state; retry/circuit; turn broker over Unix socket
  (`src/config.ts:99-101`).
- Browser automation always uses explicit `executablePath` from config
  (`chromeExecutablePath`) — no Playwright downloads, no channel resolution
  (`src/browser-login.ts:319-322`, `src/adapters/chatgpt-web/browser-worker.ts:919-960`).
  Composer keychord already branches for non-darwin (`browser-worker.ts:234-236`).
- Tunnel client: pinned linux amd64/arm64 builds already exist
  (`src/tunnel.ts:27-34`).
- Process supervision primitives: detached spawn, process-group kill
  (`src/process.ts:47-50`, `src/browser-login.ts:230-245`,
  `launcher/electron/process-tree.cjs`).
- Electron launcher shell: window/titlebar branches for non-darwin, tray icon.png path,
  state persistence (`launcher/electron/main.cjs`, `state.cjs`); supervised daemon/
  tunnel/BrowserHost children (`runtime-supervisor.cjs`) are platform-neutral.
- Linux launcher packaging/distribution already implemented end-to-end: AppImage target
  (`launcher/package.json build.linux`), `--linux` packager
  (`launcher/scripts/package.cjs`), Linux self-update (`update.cjs`,
  `update-worker.cjs updateLinux`), XDG autostart `.desktop`
  (`launcher/electron/autostart.cjs:6-95`), Linux install script
  (`scripts/install-launcher.sh:105-188`).
- Goose integration writer (`~/.config/goese`-style custom provider under
  `~/.config/goose/custom_providers`, `src/codex-integration.ts:213-290`).

### Linux adaptation required

- **Daemon/tunnel service start on Linux**: `startLifecycle()` calls
  `startService()`/`startTunnelService()` which hard-fail off-macOS
  (`src/service.ts:104-108`, `src/tunnel-service.ts:161-165`). On Debian these must be
  run manually first (see execution path below); user-level systemd units are later
  work, only after the manual runtime is proven.
- Terminal-only managed-Chrome setup gate (`src/setup.ts:302-306`): Linux intentionally
  requires launcher-BrowserHost mode today.
- Default browser discovery lists `/usr/bin/google-chrome` etc. but Debian's apt package
  installs `/usr/bin/chromium` — set `chromeExecutablePath` explicitly during setup, or
  extend the candidate list later (`src/config.ts:277-284`,
  `launcher/electron/runtime.cjs:65-74`).
- Release smoke hardcodes a macOS Chrome path and skips the browser check off-darwin
  (`scripts/smoke-release.ts:58,139-143`): needs a Linux equivalent before packaged
  release qualification.
- `open` helper prints URLs instead of using `xdg-open` (`src/cli.ts:306-308`) — works,
  could be nicer later.
- Packaged AppImage smoke requires `xvfb-run` (`launcher/scripts/smoke-package.cjs:66`);
  xvfb not installed on this host.
- arm64 Linux packaging case missing in `install-launcher.sh:29` (host is amd64; fine).
- Chrome credential-store behavior: login keeps the real OS credential store instead of
  mocks (`src/browser-login.ts:320-322`). On Debian this resolves to gnome-keyring/
  KWallet or plaintext fallback depending on session; verify behavior at first live login.
- Runtime-home convention (`~/.codex-chatgpt-web`) vs XDG: keep as-is for compatibility;
  revisit only with a migration story covering both provider core and launcher.

### macOS-only (dead weight for Linux; do not port)

- Entire launchd triple: `src/service.ts`, `src/tunnel-service.ts`, `src/autostart.ts`
  (plists, `launchctl bootstrap/bootout/print/kickstart`, `~/Library/LaunchAgents`,
  managed launchd dir). All fail closed on non-darwin; status functions report
  `supported:false`.
- Launcher darwin-only bits: `.app` bundle resolution and ditto-based mac
  extract/copy/relaunch (`update.cjs`, `update-worker.cjs` mac paths), external-launchd
  rollback snapshot guard (`runtime.cjs:413-415`), mac terminal repair refusal
  (`runtime.cjs:460-462`), mac terminal installer (`scripts/install.sh`,
  `install-launcher.sh` mac branch).
- No osascript/AppleScript/Keychain-CLI/caffeinate/sysctl/lsof usage exists anywhere
  (verified by search) — nothing hidden depends on macOS tooling.

### General issues that belong outside this repo

- **Upstream `verify` regression (fixed here because it blocks all local verification)**:
  commit `40c29bf` rewrote `README.md` and dropped the `requires Bun 1.3.14.` sentence
  that `scripts/check-version.ts` enforces (same for the zh stub), so `bun run verify`
  failed at step 1 on every platform since then. Restored here minimally. If the broader
  fork materializes, keep version-sync checks consistent there.
- Test hermeticity: `tests/goose-launcher-bootstrap.test.ts` hardcoded `/Users/luke`;
  fixed here (see below). Similar fixture hygiene should be reviewed in the broader fork.

## Smallest manual Debian execution path (target design)

Manual-first; no launchd port, no systemd, no autostart. Each step is operator-run:

1. Prereqs: Bun 1.3.14 on PATH; a Chromium/Chrome binary installed
   (`sudo apt-get install chromium` or Google Chrome .deb); a real display session for
   the runtime user.
2. From source: `bun install --frozen-lockfile && bun install --frozen-lockfile --cwd launcher`.
3. Launcher-owned setup/login (the only supported browserHost on Linux):
   run the launcher (dev: `bun run scripts/start-goose-launcher.ts`; or packaged:
   `scripts/install-launcher.sh` AppImage flow) and complete ChatGPT authentication
   inside its BrowserHost window. This produces config.json with
   `browserHost: "launcher"` plus the BrowserHost descriptor.
4. Start the Responses daemon manually (equivalent of what the launchd plist runs):
   `CODEX_CHATGPT_WEB_HOME=~/.codex-chatgpt-web bun run src/cli.ts serve`.
5. Full mode additionally starts the tunnel client manually with the same profile args
   the tunnel plist encodes (`tunnel-client run --profile-dir … --profile …`).
6. Point Goose at the loopback Responses endpoint via the existing custom-provider
   integration, then attempt one ordinary Goose turn (first live qualification).

Note: `codex-chatgpt-web lifecycle status/start` cannot work on Linux until daemon/
tunnel startup gains a non-launchd path; that adaptation is deliberately deferred past
the first manual proof.

## Groundwork changes in this checkpoint

- Fixed pre-existing version-sync breakage so verification runs again on any host:
  restored the enforced Bun-version sentence in `README.md` and `README.zh-CN.md`.
- Made `tests/goose-launcher-bootstrap.test.ts` hermetic (it previously passed only on
  the original author's Mac by matching `$HOME == /Users/luke`); pins actual behavior:
  explicit `~/…` overrides expand against the real OS home, not the injected bootstrap
  home. Production API nuance documented above rather than changed.
- Added this document and linked it from `docs/README.md`.

No production runtime behavior was changed. No launchd porting, no systemd/autostart,
no Electron rewrite.

## Component-level checks performed (Debian 12)

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` (root) | PASS |
| Root unit suite `bun test tests/*.test.ts` | 385/385 PASS (after hermetic test fix) |
| Launcher suite (`bun run --cwd launcher test`) | 168/168 PASS |
| `launcher:typecheck` | PASS |
| `launcher:build` (vite production build) | PASS |
| `build-runtime-bundle` to temp dir | Builds full runtime layout on Linux |
| `check-version` | PASS after README sync fix |
| Full `bun run verify` | NOT RUN end-to-end (last step `smoke-release.ts` is macOS-gated; see adaptations) |
| Live ChatGPT-Web turn on Linux | NOT RUN (blocked; see below) |

## Exact blockers before first live ChatGPT-Web qualification

1. A Chromium/Chrome binary installed and reachable (apt chromium vs Google Chrome .deb
   decision), recorded as `chromeExecutablePath` in config.
2. A real display session for the runtime user (graphical login preferred; `xvfb`
   installed only if a headless experiment is explicitly chosen — noting upstream
   warns that Bun-direct CDP probes are not authoritative readiness evidence, so
   readiness must go through the descriptor-provided helper either way).
3. Manual launcher BrowserHost login completed once (interactive, authenticated;
   cannot be automated safely at this stage).
4. Daemon/tunnel started by hand per the path above (no service manager yet).
5. First ordinary Goose turn + separate persisted-session `--resume` continuation,
   observed live, before anything here may be called qualified.

## Recommended next slice

Port the smallest possible daemon/tunnel startup alternative behind the existing gates
(e.g., a direct child-process `lifecycle start --foreground` variant for Linux that
preserves canonical order and readiness proofs), then re-run the component checks and
attempt blocker items 1–3 at an operator-controlled boundary. Keep user-level systemd
out until that manual path has proven one live turn.
