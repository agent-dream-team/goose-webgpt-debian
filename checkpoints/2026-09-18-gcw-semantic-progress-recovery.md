# GCW Debian semantic-progress recovery checkpoint

- Repository: `agent-dream-team/goose-webgpt-debian`
- Remote base branch: `fix/two-persistent-gcw-slots`
- Remote base commit: `883113222e7ed003266563a1458a7c52dafba4e1`
- Final local branch: `fix/semantic-progress-recovery`
- Final local commit: `297b4484034ff3e76b5fbb9f074d4299521dbc81`
- Patch series: `gcw-semantic-progress-recovery-20260918.mbox`
- Live GCW bundle ID: `29bada9e07e8a8fc74e8bc15a1929ea454892c3c45081148df06dfca95ad0983`
- Live AppImage SHA-256: `1cda6ba09deeed6fe822688543bf933193caeac4fad2c11af6dbcd6767fdebec`
- Goose recovery patch commit: `ebe9fe226b46681c04a33cdec4dc98e3fdfde790`
- GCW full test suite: 941 pass, 1 intentional skip, 0 fail
- Provider runtime: 38/38 pass
- Pair A and Pair B: COMPLETE live qualification

Apply the mbox to the base commit with `git am` to reconstruct the exact local commit series.

## Durable GitHub checkpoint artifact

For GitHub checkpoint transport the patch series is stored as `2026-09-18-gcw-semantic-progress-recovery.mbox.gz.b64`.

Restore it with:

```sh
base64 -d 2026-09-18-gcw-semantic-progress-recovery.mbox.gz.b64 | gzip -d > recovery.mbox
git checkout 883113222e7ed003266563a1458a7c52dafba4e1
git am recovery.mbox
```

Expected raw mbox SHA-256: `6cad4bcdb9e69c7b2830d60f81c0c677ee76cb45d4346658e73f702530eed2a4`.
