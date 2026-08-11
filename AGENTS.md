# Agent safety notes

These instructions apply to coding/automation agents working in this repository.

- Preserve ignored `.env` files, browser authentication state, runtime keys, credentials, and unrelated local proof artifacts unless the task explicitly authorizes changing them.
- Never print, log, commit, or otherwise expose credentials or authentication material.
- Do not enumerate macOS Keychain contents or use broad discovery commands such as `security dump-keychain`. Repository/configuration discovery must not inspect unrelated credentials.
- If a task genuinely requires a Keychain item, access only the exact known service/account entry needed for that task; otherwise prefer the project's existing private managed files or an ignored `.env`/process environment for local configuration.
- Do not use broad process-kill commands for Chrome/Playwright. Target only a known project-owned process when a test explicitly requires it.
- A Goose main agent must never restart, quit, upgrade, relaunch, terminate, or otherwise replace the Goose host carrying its own session.
- If host-Goose lifecycle work is genuinely required, stop and ask Luke to perform it externally.
- Authorized project-owned child services may be restarted only when that cannot terminate the hosting Goose session.
- Until Electron/browser-host concurrency is explicitly qualified, ChatGPT-Web child agents must be spawned deliberately, at most one may be active at a time under managed Chrome, and parallel ChatGPT-Web child fan-out is forbidden.
- When delegating to a non-ChatGPT/free worker, name the intended provider/model explicitly so it does not inherit the ChatGPT-Web transport by accident.
