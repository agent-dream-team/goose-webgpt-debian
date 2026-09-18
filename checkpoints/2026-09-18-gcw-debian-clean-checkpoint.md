# GCW Debian whole-system clean checkpoint

Date: 2026-09-18
Host: DreamBook (Debian 12)
Status: CLEAN CHECKPOINT — deployed, idle, recoverable, autostart-qualified without reboot

## Canonical source

- Canonical DreamBook checkout: `/home/dreamteam/repos/goose-chatgpt-web-rebuild`
- Branch: `fix/semantic-progress-recovery`
- HEAD: `297b4484034ff3e76b5fbb9f074d4299521dbc81`
- Worktree: clean
- Temporary `goose-chatgpt-web-recovery-fix` worktree: retired
- Temporary `goose-chatgpt-web-recovery-control` worktree: retired after its uncommitted diagnostic diff was archived locally as superseded/not deployed

## Off-machine source recovery

Deployment repository: `agent-dream-team/goose-webgpt-debian`

Checkpoint branch:
`checkpoint/semantic-progress-recovery-20260918`

The branch is based on the last published deployment source checkpoint:
`883113222e7ed003266563a1458a7c52dafba4e1` (`fix/two-persistent-gcw-slots`).

Published recovery artifacts:
- `checkpoints/2026-09-18-gcw-semantic-progress-recovery.mbox.gz.b64`
  - Git blob SHA: `15e7358cf371e7b7e8df4d34c473e3264d9b45a7`
  - raw mbox SHA-256 after decode/decompress: `6cad4bcdb9e69c7b2830d60f81c0c677ee76cb45d4346658e73f702530eed2a4`
  - reconstructs the exact nine local GCW commits ending at `297b4484034ff3e76b5fbb9f074d4299521dbc81`
- `checkpoints/2026-09-18-goose-post-tool-resume.mbox.gz.b64`
  - Git blob SHA: `f2938c447ddd3604aa2ddfca80c6b44270272eab`
  - raw mbox SHA-256 after decode/decompress: `92a9d4a145e1f3bda5a13623275753acaa870b7ae63f4880980b84a93726261f`
  - base: `d213a3b13545b4e85524a572ac695b2181728e3b`
  - reconstructs the four local Goose commits ending at `ebe9fe226b46681c04a33cdec4dc98e3fdfde790`

The Goose source artifact is deliberately stored on the deployment checkpoint branch rather than pushed to `aaif-goose/goose`; upstream implementation remains deferred until issue #12133 is Ready.

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

## Runtime configuration durability

Mutable config now points to immutable installed runtime paths rather than source-tree commands:

- runtime Bun: `~/.local/share/goose-chatgpt-web-rebuild/versions/5.0.6-linux-x64/runtime/bun`
- runtime entrypoint: `~/.local/share/goose-chatgpt-web-rebuild/versions/5.0.6-linux-x64/app/cli.js`
- tunnel wrapper: `~/.local/share/goose-chatgpt-web-rebuild/versions/5.0.6-linux-x64/bin/dreambook-rebuild-tunnel-client-auth-wrapper.sh`

Private state SHA-256 values at checkpoint:
- `config.json`: `689f9965ba6776ba9e07ead34909ae73115a9aeb5857d2752f4716be5715f576`
- `launcher/launcher-state.json`: `2adc1b0534f1ba5ec3d96b61cbed2c273cc5ebc3963b934d61b7726deb35cb9f`
- XDG autostart desktop file: `5f8dc87193c2b47d241c17b6aaa19aef9f1eb16f867060f5a6bc82fdbd7a6544`

All three files are mode `0600`.

## Boot/autostart ownership

Linux ownership model is the packaged launcher + XDG autostart, not systemd.

Autostart state:
- launcher state `autoStart=true`
- `~/.config/autostart/dev.codexwebgpt.launcher.desktop` exists
- Exec: `~/.local/bin/goose-chatgpt-web --hidden`
- X-GNOME-Autostart-enabled=true

Non-reboot reconstruction qualification:
1. GCW was idle with both slots free and no outstanding turns.
2. The running launcher root was terminated cleanly.
3. Provider port, account owner marker, and prior AppImage mount cleared.
4. The exact XDG Exec command was launched: `~/.local/bin/goose-chatgpt-web --hidden`.
5. The final bundle reconstructed successfully and provider health returned in 12 seconds.
6. The root process re-parented to PID 1 after launch-shell exit.
7. Authenticated embedded ChatGPT browser check passed.
8. Tunnel runtime re-established and reports healthy/ready.
9. Broker ownership re-established under the new provider process.

An actual machine reboot/login cycle was not performed because DreamBook reboot remains explicitly disallowed without separate approval. This is a deferred deployment proof, not an observed checkpoint defect.

## Provider/browser/tunnel state

Final provider:
- service: `goose-chatgpt-web-rebuild`
- version: `5.0.6`
- mode: `full`
- accepting turns: true
- active HTTP turns: 0
- active browser turns: 0

Authenticated browser:
- Playwright reaches the embedded authenticated ChatGPT surface.

Tunnel:
- pinned tunnel client installed
- runtime key private
- launcher owns tunnel runtime
- tunnel reports healthy and ready

The standalone legacy `doctor` still exits non-zero for two known non-appliance assumptions:
- it expects the retired Codex model route;
- it expects service name `codex-chatgpt-web` rather than the persistent rebuild service `goose-chatgpt-web-rebuild`.

Those two doctor checks are not used as readiness gates for this Goose deployment; browser, provider, launcher ownership, pinned tunnel, key privacy, and tunnel health all pass.

## Goose runtime

Installed system Goose remains stock `1.50.0` and the authoritative Second Shift Goose service remains separate from GCW.

Qualified recovery binary retained separately:
`~/.local/share/goose-chatgpt-web-rebuild/qualification-binaries/goose-post-tool-resume-ebe9fe22`

Pinned recovery binary SHA-256:
`1b1161a58d084623f5be689ce54f756b673ce8ea16ba53fcba0c3f9cd5d32a78`

Qualified patched Goose version: `1.51.0`.

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
- 14 older `UNRECONCILED` turns are intentionally retained as recovery history;
- all 14 hold no account slot;
- all 14 have zero `CLAIMED`/`UNCERTAIN` blocking operations;
- all 14 retain positive-terminal evidence;
- they are historical quarantined records, not active work or slot debt.

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

## Retained recovery/rollback evidence

Database snapshots retained:
- `qualification-backups/20260917-pre-pair-a-post-tool-resume/`
- `qualification-backups/20260918-pre-final-pair-a-resume/`
- `qualification-backups/20260918-pre-final-pair-b-resume/`
- `qualification-backups/20260918-post-final-post-tool-resume/`

Small request/JSONL/rehearsal artifacts remain for reproducibility.

The superseded uncommitted recovery-control experiment was archived locally as a clearly marked never-deployed patch before its worktree was removed.

## Cleanup completed

- 11 superseded installed GCW qualification bundles removed
- obsolete earlier Goose candidate removed
- redundant intermediate DB snapshots removed
- temporary recovery-fix and recovery-control worktrees removed
- obsolete local recovery-control branch removed
- stale GCW `/tmp` qualification/probe files removed
- canonical source checkout reconciled to deployed final source
- approximately 27 GB free on root filesystem at checkpoint

## Intentionally deferred only

1. **Actual DreamBook reboot/login proof.** XDG autostart is configured and the exact autostart command has been qualified, but no machine reboot was performed under the standing no-reboot rule.
2. **Upstream Goose submission.** When `aaif-goose/goose#12133` becomes Ready, refresh the local Goose patch against then-current upstream, regenerate artifacts as needed, rerun focused qualification, and prepare the upstream PR.

No other GCW Debian cleanup or local implementation work is intentionally outstanding at this checkpoint.
