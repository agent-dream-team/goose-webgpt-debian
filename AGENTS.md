# Agent safety notes

These instructions apply to coding/automation agents working in this repository.

- Preserve ignored `.env` files, browser authentication state, runtime keys, credentials, and unrelated local proof artifacts unless the task explicitly authorizes changing them.
- Never print, log, commit, or otherwise expose credentials or authentication material.
- Do not enumerate macOS Keychain contents or use broad discovery commands such as `security dump-keychain`. Repository/configuration discovery must not inspect unrelated credentials.
- If a task genuinely requires a Keychain item, access only the exact known service/account entry needed for that task; otherwise prefer the project's existing private managed files or an ignored `.env`/process environment for local configuration.
- Do not use broad process-kill commands for Chrome/Playwright. Target only a known project-owned process when a test explicitly requires it.
