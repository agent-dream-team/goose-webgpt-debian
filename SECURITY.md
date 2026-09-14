# Security policy

This DreamBook appliance handles an authenticated ChatGPT browser session and a local Goose tool connector. Treat credentials, cookies, browser/profile state, tunnel/runtime keys, connector authorization, private prompts, tool results, and persisted provider history as sensitive.

The production mutable root is `~/.local/share/goose-chatgpt-web-rebuild`. Do not copy or share its browser profile, broker database, connector authorization, or tunnel runtime with another appliance. The package-owned DreamBook account fence remains the local single-appliance execution boundary.

Do not publish raw logs or evidence that can contain account identity, credentials, private repository content, prompts, or tool output. Report any credential exposure, authentication-boundary failure, unauthorized local-tool execution, or cross-session/provider-history bleed privately to the repository owner.

Current security and lifecycle boundaries are owned by `AGENTS.md`, `docs/persistent-chat-lifecycle.md`, and `docs/persistent-chat-rebuild-plan.md`.
