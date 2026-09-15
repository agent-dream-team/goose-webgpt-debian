# Goose ChatGPT Web — DreamBook

This repository is the Debian/DreamBook build of Goose ChatGPT Web: a ChatGPT-Web-backed provider appliance for Goose with persistent, recoverable provider conversations.

- Canonical repository: `agent-dream-team/goose-webgpt-debian`
- DreamBook checkout: `/home/dreamteam/repos/goose-chatgpt-web-rebuild`
- Stable installed entrypoint: `~/.local/bin/goose-chatgpt-web`
- Mutable runtime root: `~/.local/share/goose-chatgpt-web-rebuild`
- Separate MBP/macOS adaptation: `luke-m-selway/goose-chatgpt-web`

The MBP repository is a different product target. Do not point this DreamBook checkout at it or treat it as this appliance's deployment remote.

## Current state

The qualified installed runtime behavior is based on source checkpoint `15fbb7e25e00b7eed63e5313a090e79818fa4bf3` (`Support two persistent GCW execution slots`). The active immutable bundle is `bf526d243be697bf7d116a5c3f3394e3948307f80ffa61223e25753c16b2090d`, AppImage SHA-256 `7bd181efad6cee39144f5ddcf90e556aad73fdd0b95ae04aa735e367187b4311`. A clean rebuild from that source reproduces runtime-manifest SHA-256 `6a00bca55ec5ac0584341e138503df6c8c285f8e812e7adf90cab69e1a0f3c33` and the same runtime bundle ID; the installed AppImage hash is the activated package identity rather than a claim of byte-for-byte reproducible packaging.

The installed non-reboot V1 is qualified for exactly two concurrent persistent browser turns: one GCW parent/orchestrator plus one native-Goose GCW child/worker. Capacity beyond two and parallel side-effecting connector operations are not qualified. Actual DreamBook reboot reconstruction remains deferred and must not be performed without explicit operator approval.

## Authority

Read these before changing the appliance:

- `AGENTS.md` — repository boundaries, safety rules, and workflow.
- `docs/persistent-chat-lifecycle.md` — non-negotiable persistent-conversation and recovery invariants.
- `docs/persistent-chat-follow-up.md` — current implementation/qualification gaps and next work.

Goose owns logical sessions, transcript/context lifecycle, tools, approvals, delegation, and project execution. This repository owns only the provider-side ChatGPT Web appliance and the local state needed to operate and recover it.

The inherited `miuuyy/codex-chatgpt-web` codebase remains implementation lineage for selected browser/profile/packaging mechanisms. Its Codex product workflow and documentation are not part of this repository's operating surface.

## Development

Use the repository-pinned Bun/runtime tooling and the validation appropriate to the changed path. Do not use old Codex setup, model-install, browser-smoke, or MCP instructions as Goose ChatGPT Web recovery procedures.
