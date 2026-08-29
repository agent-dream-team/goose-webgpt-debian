---
name: code-maintainability
description: Keep code safe to modify across agents by preserving non-obvious intent without unnecessary comments or duplication.
---

# Code Maintainability

Apply this skill before creating or modifying source code, scripts, or behavioral/executable configuration.

Do not load it for ordinary read-only work unless the task explicitly reviews code maintainability or is preparing a code change.

## Write for the next editor

Prefer clear names, structure, types, tests, and deterministic checks over explanatory comments.

Do not add comments that merely restate visible code.

Add or preserve a concise nearby comment when a future editor could otherwise reasonably misunderstand:

- a non-obvious invariant or ordering requirement;
- why apparently redundant code must remain;
- an external, platform, protocol, or compatibility constraint;
- a safety, security, billing, privacy, concurrency, or lifecycle boundary;
- why a plausible alternative is deliberately not used;
- why similar-looking behavior must not be duplicated, merged, or moved.

Explain **why**, not what.

Keep comments as short as the constraint permits. Put substantial explanation in the appropriate authoritative documentation when it cannot be expressed locally without bloating the code.

Where an invariant can be enforced by code, types, validation, or tests, enforce it there rather than relying on a comment alone.

Before adding a helper, guard, workaround, or state transition, check whether equivalent behavior already exists. Do not duplicate behavior merely because the existing implementation was not immediately obvious.

When changing code, update or remove nearby comments that are no longer true.

## Completion check

Before completing a code change, verify that:

- the changed code is locally understandable without reconstructing important intent from history;
- non-obvious constraints that could invite an incorrect future change are preserved locally;
- comments explain necessary intent rather than obvious mechanics;
- changed comments still describe current behavior;
- no equivalent behavior was unnecessarily duplicated.
