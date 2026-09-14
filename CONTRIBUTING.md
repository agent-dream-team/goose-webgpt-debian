# Contributing

Repository changes must follow `AGENTS.md` and the current authority documents it names.

Keep changes bounded to the DreamBook Goose ChatGPT Web appliance. Preserve Goose's ownership of sessions, context, tools, approvals, and delegation; do not reintroduce inherited Codex workflow or a second agent/session runtime.

Before proposing or changing lifecycle, browser, persistence, or recovery behavior, read `docs/persistent-chat-lifecycle.md` and `docs/persistent-chat-rebuild-plan.md`. Add focused regression coverage for behavior changes and run the validation required by the affected gate.

Never commit credentials, cookies, browser/profile state, tunnel/runtime keys, raw provider history, private prompts/tool results, or host-secret material. Work on a branch and keep qualification evidence privacy-safe and reproducible.
