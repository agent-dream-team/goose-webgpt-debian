# GCW Debian whole-system clean checkpoint

Date: 2026-09-18
Host: DreamBook (Debian 12)
Status: CLEAN CHECKPOINT — deployed, idle, recoverable, autostart-qualified without reboot

## Canonical source

- Canonical DreamBook checkout: `/home/dreamteam/repos/goose-chatgpt-web-rebuild`
- Branch: `fix/semantic-progress-recovery`
- HEAD: `297b4484034ff3e76b5fbb9f074d4299521dbc81`
- Worktree: clean
- Temporary recovery worktrees retired.
- Reproducible source-tree build outputs pruned after qualification; installed packages and off-machine source bundles remain authoritative.

## Off-machine source recovery

Deployment repository: `agent-dream-team/goose-webgpt-debian`

Checkpoint branches:
- `checkpoint/gcw-debian-clean-20260918` — exact Git bundles for final GCW and the local Goose patch
- `checkpoint/semantic-progress-recovery-20260918` — this whole-system checkpoint record and patch-series recovery artifacts

Exact final GCW source:
- local ref: `fix/semantic-progress-recovery`
- final commit: `297b4484034ff3e76b5fbb9f074d4299521dbc81`
- prerequisite/base: `883113222e7ed003266563a1458a7c52dafba4e1`
- exact Git bundle is stored off-machine on `checkpoint/gcw-debian-clean-20260918`

Exact Goose #12133 local patch:
- local ref: `fix/persisted-post-tool-resume`
- final commit: `ebe9fe226b46681c04a33cdec4dc98e3fdfde790`
- prerequisite/upstream base: `d213a3b13545b4e85524a572ac695b2181728e3b`
- exact Git bundle is stored off-machine on `checkpoint/gcw-debian-clean-20260918`

The Goose implementation is deliberately checkpointed in the deployment repository rather than pushed to `aaif-goose/goose`; upstream implementation remains deferred until issue #12133 is Ready.

## Installed GCW

Live bundle ID:
`29bada9e07e8a8fc74e8bc15a1929ea454892c3c45081148df06dfca95ad0983`

Live AppImage SHA-256:
`1cda6ba09deeed6fe822688543bf933193caeac4fad2c11af6dbcd6767fdebec`

Stable entrypoint:
`~/.local/bin/goose-chatgpt-web`

Retained rollback bundle:
`5.0.6-linux-x64-d2a7aaf6ef1aacf44884aa6874d6148dd4a7ab23cea32f3a7543e8723f9af167`

Only the live final bundle plus this immediately previous known-good rollback bundle remain installed.

The shared durable runtime manifest also reports the live final bundle ID, so mutable launcher config and the stable wrapper resolve to the same installed release.

## Runtime configuration durability

Mutable config points to immutable installed runtime paths rather than source-tree commands:

- runtime Bun: `~/.local/share/goose-chatgpt-web-rebuild/versions/5.0.6-linux-x64/runtime/bun`
- runtime entrypoint: `~/.local/share/goose-chatgpt-web-rebuild/versions/5.0.6-linux-x64/app/cli.js`
- tunnel wrapper: `~/.local/share/goose-chatgpt-web-rebuild/versions/5.0.6-linux-x64/bin/dreambook-rebuild-tunnel-client-auth-wrapper.sh`

No DreamBook source-checkout path or `~/.bun/bin/bun` remains in mutable GCW config.

Private state SHA-256 values:
- `config.json`: `689f9965ba6776ba9e07ead34909ae73115a9aeb5857d2752f4716be5715f576`
- `launcher/launcher-state.json`: `2adc1b0534f1ba5ec3d96b61cbed2c273cc5ebc3963b934d61b7726deb35cb9f`
- XDG autostart desktop file: `5f8dc87193c2b47d241c17b6aaa19aef9f1eb16f867060f5a6bc82fdbd7a6544`

All three files are mode `0600`. Tunnel runtime key and custom-provider config are also mode `0600`.

The broker SQLite files are `0644` but live under a `0700` runtime directory inside a `0700` application root, so they are not accessible to other users through the filesystem hierarchy. No permission mutation was made to the live SQLite set.

## Browser/authentication ownership

Persistent rebuild uses launcher-owned browser mode.

- launcher profile directory is private (`0700`)
- launcher Cookies/Preferences are private (`0600`)
- browser worker attaches to the launcher-owned persistent browser context before any standalone `storageStatePath` is consulted
- therefore the absence of `browser/storage-state.json` is expected in this deployment mode and is not a cold-start dependency

Authenticated embedded ChatGPT browser checks passed during final deployment and XDG reconstruction qualification.

## Boot/autostart ownership

Linux ownership model is the packaged launcher + XDG autostart, not a dedicated GCW systemd service.

Autostart state:
- launcher state `autoStart=true`
- `~/.config/autostart/dev.codexwebgpt.launcher.desktop` exists
- Exec: `~/.local/bin/goose-chatgpt-web --hidden`
- `X-GNOME-Autostart-enabled=true`

Non-reboot reconstruction qualification:
1. GCW was idle with both slots free and no outstanding turns.
2. The running launcher root was terminated cleanly.
3. Provider port, account owner marker, and prior AppImage mount cleared.
4. The exact XDG Exec command was launched: `~/.local/bin/goose-chatgpt-web --hidden`.
5. The final bundle reconstructed successfully.
6. The root process re-parented to PID 1 after launch-shell exit.
7. The embedded ChatGPT browser authenticated successfully.
8. Tunnel runtime re-established.
9. Broker ownership re-established under the new provider process.
10. Provider returned healthy with zero active HTTP/browser turns.

An actual machine reboot/login cycle was not performed because DreamBook reboot remains explicitly disallowed without separate approval. This is the only unobserved boot-level proof; the exact autostart command itself is qualified.

## Surrounding Second Shift services

At final audit the following services were both enabled and active:
- `second-shift-goose.service`
- `second-shift-goose-control.service`
- `second-shift-goose-control-tunnel.service`
- `second-shift-goose-pilot.service`
- `second-shift-goose-pilot-tunnel.service`
- `second-shift-agent-notify.service`
- `second-shift-agent-notify-tunnel.service`

Enabled maintenance timers:
- DreamBook Borg backup
- Borg repository check
- Borg retention maintenance
- Second Shift recovery sentinel

Most recent backup/check/retention service results were successful. Recovery sentinel result was successful.

## Provider/browser/tunnel state

Final provider:
- service: `goose-chatgpt-web-rebuild`
- version: `5.0.6`
- mode: `full`
- accepting turns: true
- active HTTP turns: 0
- active browser turns: 0

The live process tree is entirely from the final `29bada9e…` installed bundle and durable `versions/5.0.6-linux-x64` runtime. The account lease owner marker matches that live launcher.

Launcher JSONL logging is internally bounded:
- active log rotates at 4 MiB
- one `.1` previous file is retained
- in-memory record set is capped at 300

No host-side logrotate rule is required for the launcher JSONL.

## Goose runtime

Installed system Goose remains stock `1.50.0`; the authoritative Second Shift Goose service remains separate from GCW.

Qualified recovery binary retained separately:
`~/.local/share/goose-chatgpt-web-rebuild/qualification-binaries/goose-post-tool-resume-ebe9fe22`

Pinned recovery binary SHA-256:
`1b1161a58d084623f5be689ce54f756b673ce8ea16ba53fcba0c3f9cd5d32a78`

Qualified patched Goose version: `1.51.0`.

The Goose source checkout is clean at `ebe9fe226b46681c04a33cdec4dc98e3fdfde790`. Its ~31 GiB reproducible Cargo `target/` tree was removed after qualification; the checkout, Hermit environment, pinned binary, and exact off-machine Git bundle remain.

## Persistent-pair state

Pair A:
- Goose session `20260916_11`
- GCW turn `turn_71c1d4b6-c9e1-482e-9757-d61770a0fa88`
- state `COMPLETE`
- slot released
- current checkpoint has `stableNonInputHash`

Pair B:
- Goose session `20260916_4`
- GCW turn `turn_48bde705-7f7d-4865-b655-6c7a98713207`
- state `COMPLETE`
- slot released
- current checkpoint has `stableNonInputHash`

Both account slots are free and there are no `TURN_SENDING` or `TURN_OUTSTANDING` rows.

Historical broker quarantine:
- 14 older `UNRECONCILED` turns are intentionally retained as recovery history
- all 14 hold no account slot
- all 14 have zero `CLAIMED`/`UNCERTAIN` blocking operations
- all 14 retain positive-terminal evidence
- each has only an unclaimed next `MINTED` operation
- they are historical quarantine, not active work or slot debt

## Qualification

Final source/runtime qualification includes:
- TypeScript PASS
- Responses projection tests 7/7 PASS
- provider runtime 38/38 PASS
- full GCW repository 941 PASS, 1 intentional skip, 0 fail, 4,896 assertions
- package smoke PASS
- independent Sonnet review: no P0/P1/P2 findings
- live Pair A recovery PASS
- live Pair B 25-tool legacy recovery PASS
- exact XDG-autostart-command reconstruction PASS
- surrounding Second Shift services/timers audit PASS
- backup/recovery-sentinel status PASS

## Retained recovery/rollback evidence

Database snapshots retained:
- `qualification-backups/20260917-pre-pair-a-post-tool-resume/`
- `qualification-backups/20260918-pre-final-pair-a-resume/`
- `qualification-backups/20260918-pre-final-pair-b-resume/`
- `qualification-backups/20260918-post-final-post-tool-resume/`

Small request/JSONL/rehearsal artifacts remain for reproducibility.

## Cleanup completed

- 11 superseded installed GCW qualification bundles removed
- only live + immediate known-good rollback bundle retained
- obsolete earlier Goose candidate removed
- redundant intermediate DB snapshots removed
- temporary recovery worktrees removed
- stale GCW-specific `/tmp` qualification/probe files removed
- canonical source checkout reconciled to deployed final source
- Goose reproducible Cargo `target/` tree removed (~31 GiB)
- GCW reproducible `dist`, launcher build/dist, and package-artifact directories removed (~0.5 GiB)
- canonical GCW checkout remains dependency-ready (`node_modules` retained)
- root filesystem now has approximately 57 GiB free (76% used), versus ~26–27 GiB before final build-cache cleanup

## Intentionally deferred only

1. **Actual DreamBook reboot/login proof.** XDG autostart is configured and the exact autostart command has been qualified, but no machine reboot was performed under the standing no-reboot rule.
2. **Upstream Goose submission.** When `aaif-goose/goose#12133` becomes Ready, refresh the local Goose patch against then-current upstream, regenerate artifacts as needed, rerun focused qualification, and prepare the upstream PR.

No other GCW Debian cleanup or local implementation work is intentionally outstanding at this checkpoint.
