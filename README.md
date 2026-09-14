# Goose ChatGPT Web — DreamBook

This repository is the Debian/DreamBook build of Goose ChatGPT Web: a ChatGPT-Web-backed provider appliance for Goose with persistent, recoverable provider conversations.

- Canonical repository: `agent-dream-team/goose-webgpt-debian`
- DreamBook checkout: `/home/dreamteam/repos/goose-chatgpt-web-rebuild`
- Stable installed entrypoint: `~/.local/bin/goose-chatgpt-web`
- Mutable runtime root: `~/.local/share/goose-chatgpt-web-rebuild`
- Separate MBP/macOS adaptation: `luke-m-selway/goose-chatgpt-web`

The MBP repository is a different product target. Do not point this DreamBook checkout at it or treat it as this appliance's deployment remote.

## Current state

The qualified installed runtime behavior is based on source checkpoint `5aff187bf356b6ca8287347106659489904f1842` (`Retire local conversation budget enforcement`). The active immutable bundle is `531d4ef3f9d9fb73fa22695878a2ed5f31cf2ac66ce8179976bc8719034c0860`, AppImage SHA-256 `7f15dff2a9175ee136bd9e9a107cc51d2c267c1ed26dec04f962e1cb9677bebb`.

The non-reboot V1 is qualified. Actual DreamBook reboot reconstruction remains deferred and must not be performed without explicit operator approval.

## Authority

Read these before changing the appliance:

- `AGENTS.md` — repository boundaries, safety rules, and workflow.
- `docs/persistent-chat-lifecycle.md` — non-negotiable persistent-conversation and recovery invariants.
- `docs/persistent-chat-follow-up.md` — current implementation/qualification gaps and next work.

Goose owns logical sessions, transcript/context lifecycle, tools, approvals, delegation, and project execution. This repository owns only the provider-side ChatGPT Web appliance and the local state needed to operate and recover it.

The inherited `miuuyy/codex-chatgpt-web` codebase remains implementation lineage for selected browser/profile/packaging mechanisms. Its Codex product workflow and documentation are not part of this repository's operating surface.

## Development

Use the repository-pinned Bun/runtime tooling and the validation appropriate to the changed path. Do not use old Codex setup, model-install, browser-smoke, or MCP instructions as Goose ChatGPT Web recovery procedures.
