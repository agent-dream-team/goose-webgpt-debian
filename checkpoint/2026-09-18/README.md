# DreamBook GCW clean checkpoint — 2026-09-18

This branch is an off-machine recovery checkpoint for the final locally qualified Debian GCW state.

## GCW exact Git bundle

Target ref:
- `fix/semantic-progress-recovery`
- final commit: `297b4484034ff3e76b5fbb9f074d4299521dbc81`
- prerequisite/base: `883113222e7ed003266563a1458a7c52dafba4e1`
- bundle SHA-256: `32499fe6e162eb72ea8478d0f7822636374c9e6d5312fe595f0030a5b580d3c6`

Reconstruct:

```bash
cat checkpoint/2026-09-18/gcw-final.bundle.b64.part-* | base64 -d > /tmp/gcw-final.bundle
sha256sum /tmp/gcw-final.bundle
git bundle verify /tmp/gcw-final.bundle
git fetch /tmp/gcw-final.bundle fix/semantic-progress-recovery:fix/semantic-progress-recovery
```

## Goose #12133 local patch exact Git bundle

Target ref:
- `fix/persisted-post-tool-resume`
- final commit: `ebe9fe226b46681c04a33cdec4dc98e3fdfde790`
- prerequisite/upstream base: `d213a3b13545b4e85524a572ac695b2181728e3b`
- bundle SHA-256: `4a11b3579a2803df246dd164b53dc533186d38c41641b36f984da2f3377141f0`

Reconstruct inside an aaif-goose/goose clone containing the prerequisite:

```bash
cat checkpoint/2026-09-18/goose-post-tool-resume.bundle.b64.part-* | base64 -d > /tmp/goose-post-tool-resume.bundle
sha256sum /tmp/goose-post-tool-resume.bundle
git bundle verify /tmp/goose-post-tool-resume.bundle
git fetch /tmp/goose-post-tool-resume.bundle fix/persisted-post-tool-resume:fix/persisted-post-tool-resume
```

No upstream Goose PR was submitted. Issue #12133 was still open without a Ready label at close-out.

## Deployed GCW identity

- app version: 5.0.6
- live bundle ID: `29bada9e07e8a8fc74e8bc15a1929ea454892c3c45081148df06dfca95ad0983`
- AppImage SHA-256: `1cda6ba09deeed6fe822688543bf933193caeac4fad2c11af6dbcd6767fdebec`
- retained rollback bundle: `d2a7aaf6ef1aacf44884aa6874d6148dd4a7ab23cea32f3a7543e8723f9af167`

Local qualification record:
`~/.local/share/goose-chatgpt-web-rebuild/qualification-artifacts/post-tool-resume-final-20260918.md`

Both live qualification pairs were COMPLETE at close-out.
