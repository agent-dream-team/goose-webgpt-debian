# Security policy

Do not open public issues containing ChatGPT cookies/browser storage, tunnel IDs or keys, Goose prompts/tool results, local runtime secrets, or private filesystem paths. Redact diagnostic bundles before sharing.

The current runtime binds its local control/provider surfaces to loopback, but loopback does not protect against a malicious process running as the same OS user. Treat browser authentication state and tunnel/runtime credentials as sensitive local secrets.

In full mode, an untrusted ChatGPT response can request tools only through the active Goose tool contract. Goose remains responsible for execution, sandboxing, approvals, delegation, and tool results. Keep Goose's permissions aligned with the workspace's risk.

The planned Goose Control surface is a separate management capability. Its first proof must expose only the narrow authenticated HTTPS REST/OpenAPI facade documented in [`docs/goose-control-plan.md`](docs/goose-control-plan.md), with authenticated loopback ACP behind it. It must not expose raw ACP, Goose Native turn-token authority, browser/CDP control, arbitrary filesystem paths, or arbitrary provider/model selection.

Read the complete [`docs/security-model.md`](docs/security-model.md) before changing full-mode capability or Goose Control boundaries.

The stable MCP v1 SDK currently declares the vulnerable `@hono/node-server` 1.x range even though this project uses only its stdio transport. The lockfile explicitly resolves that unused HTTP adapter to patched 2.0.12. Keep dependency/audit gates current and remove the override when the stable SDK itself moves to the patched major.
