---
name: lean-documentation
description: Create, maintain, review, and remove technical documentation using minimum sufficient documentation, current-state hygiene, one authoritative source per concern, explicit navigation, and a small shared schema.
---

# Lean Documentation

Apply this skill when creating, changing, reviewing, or cleaning technical documentation, and when a technical change may alter documented state.

Project-local architecture, safety, and contribution rules still govern their own subjects.

## Core rule

Documentation must earn its place.

Keep only information that helps a reader:

- understand the current system;
- operate it;
- maintain or safely change it;
- navigate to the correct authoritative source;
- understand the rationale for an important decision.

If removing content does not reduce one of those capabilities, remove it.

## Before creating documentation

Before creating a document or adding substantial documentation:

1. Identify the information that needs a durable home.
2. Find whether an existing source already owns that concern.
3. If an owner exists, update or link to it.
4. If no owner exists, decide whether the information needs to survive the current task or PR.
5. Use the smallest existing document type that fits.

Do not create documentation merely because work produced information.

Prefer:

1. updating an existing canonical source;
2. keeping task-specific material in the issue or PR;
3. creating a new document only when neither is adequate.

## Authority

Each current fact, rule, interface, configuration, architectural boundary, or operational procedure has one authoritative owner.

Other documents may summarize enough context to orient the reader, but must not become competing specifications.

When exact values live in code, configuration, schema, or another machine-readable source, keep that source authoritative. Documentation should explain meaning and usage rather than duplicate values unnecessarily.

When ownership moves:

1. establish the new authoritative source;
2. update meaningful links to it;
3. remove the obsolete duplicate.

Do not preserve redirect documents unless an external dependency makes them necessary.

## Current-state maintenance

Current documentation must change with the system.

Before completing a technical change, determine whether it changes any documented behavior, architecture, interface, configuration, command, path, ownership boundary, or operating procedure.

If it does:

1. Update the authoritative documentation in the same work.
2. Remove or rewrite instructions and claims that are no longer true.
3. Update meaningful links when authoritative ownership moves.
4. Delete obsolete current-state documentation rather than preserving stale procedures for history.
5. Verify that surviving current documentation describes the resulting system.

Do not create documentation churn when a change does not affect documented information.

`reference`, `how-to`, and `explanation` documents normally describe current state. Future or proposed behavior belongs in a `plan`, `roadmap`, issue, or PR and must not read as current operating procedure.

### When documentation and the system disagree

If current documentation conflicts with authoritative implementation, configuration, or observed system behavior, treat the documentation as potentially stale.

Do not blindly follow a disputed operational procedure when doing so could disrupt working infrastructure.

Establish the current state and authoritative owner, then correct stale documentation as part of the work. Until the conflict is resolved, do not treat the disputed documentation as authority for a potentially disruptive action.

If the conflict cannot be resolved safely, stop before the potentially disruptive action and surface the mismatch rather than guessing.

## Navigation

Assume any document may be the reader's entry point.

Near the beginning of a document, make clear when needed:

- what this document owns;
- which closely related concerns it does not own;
- where those concerns are owned.

A reader should not need to read deeply before discovering that they need another source.

Links must state what the destination provides.

Prefer:

`Provider selection and fallback rules are defined in routing-policy.md.`

over:

`See routing-policy.md.`

Link directly to the authoritative source. Avoid chains of documents that only redirect to other documents.

### Navigation block

Use this block when adjacent ownership could reasonably be confused:

```markdown
> **Covers:** Provider-selection policy.
> **Elsewhere:** Exact provider/model aliases are defined in `provider-model-aliases.md`.
```

Use only the lines needed. Do not add a navigation block where the document's purpose and boundaries are already obvious.

## Documentation schema

Use the schema for standalone technical documentation.

It does not apply to:

- agent skills;
- `AGENTS.md`;
- repository-root `README.md`;
- generated documentation;
- small local README files whose only purpose is directory orientation.

Standalone technical documentation uses:

```yaml
---
type: reference
status: current
---
```

Use only defined values. Do not include empty or unused fields.

### Types

- `reference` — authoritative facts, interfaces, configuration meaning, commands, limits, mappings, or other exact current information.
- `how-to` — a procedure for achieving a specific task.
- `explanation` — architecture, boundaries, relationships, or concepts needed to understand how or why the current system works.
- `decision` — rationale for an important decision that remains useful after implementation.
- `roadmap` — durable remaining direction across multiple pieces of work.
- `plan` — bounded implementation, migration, investigation, or change planning. Plans are normally temporary; prefer an issue or PR when it is an adequate working surface.
- `evidence` — qualification, experiment, incident, compatibility, investigation, or other evidence whose result remains useful. Evidence is normally time-sensitive and disposable.

### Status

- `current` — a valid current source.
- `temporary` — exists for active work or evidence and should be removed when that purpose ends.
- `superseded` — no longer current but retained because its historical rationale or evidence still serves a specific purpose.

There is no `obsolete` status. Delete obsolete documents.

### Optional metadata

Use optional metadata only when it changes how the document should be interpreted or maintained.

`as_of` marks inherently time-sensitive truth such as provider availability, qualification state, external pricing or limits, compatibility, or environment state. Do not use it merely as a last-edited date.

```yaml
as_of: <YYYY-MM-DD>
```

`superseded_by` is used only with `status: superseded` and points directly to the replacement when one exists.

```yaml
superseded_by: replacement-decision.md
```

`source_of_truth` identifies another source that owns exact values while this document explains or presents them. Do not use it when the document itself owns the information.

```yaml
source_of_truth: config/routes.yaml
```

## README

The repository README is the front door.

It should contain only what is needed to:

- identify the project;
- state its important purpose or boundary;
- get started;
- route the reader to deeper authoritative documentation.

Do not copy architecture, policy, roadmap, or reference material into the README when another source owns it.

## Decision records

Use `type: decision` only when preserving rationale is likely to help future work. Keep one decision per record.

Use:

```markdown
## Status

## Context

## Decision

## Consequences
```

Add another section only when it carries necessary information.

When replaced, set `status: superseded`, add `superseded_by`, and retain the record only if its rationale remains useful.

Decision records explain why. `reference`, `how-to`, and `explanation` documents explain what is true now.

## Roadmaps

Use `type: roadmap` for remaining direction, not completed history.

Remove completed work. Do not create separate phase documents when one current roadmap can express the remaining direction.

## Plans

Use `type: plan`, normally with `status: temporary`, only when work needs a durable repository-local planning artifact.

When the work finishes:

- move current-state conclusions into their authoritative documentation;
- preserve important rationale as a decision record when needed;
- preserve reusable verification as tests, checks, fixtures, or procedures;
- delete the plan.

## Evidence

Use `type: evidence`.

State near the beginning what was tested or observed, the result, and what conclusion it supports. Use `as_of` when freshness matters. Include reproduction details only when needed to reproduce or interpret the result.

When the evidence stops serving an active purpose, move durable conclusions into the appropriate current source, preserve reusable verification elsewhere, and delete the evidence document.

Do not keep old smoke tests, qualification reports, or investigation notes merely because the work once mattered.

## Writing rules

Put the answer, rule, action, or current state before supporting detail.

Use direct declarative sentences for facts and rules. Use imperative verbs for procedures.

Use concrete properties instead of generic quality claims. Avoid unsupported terms such as `robust`, `seamless`, `scalable`, `production-ready`, `best-practice`, or `comprehensive`.

Do not instruct an agent to "write professionally", "follow best practices", or similar. State the required behavior instead.

Do not add introductions, summaries, conclusions, background sections, tables, diagrams, examples, or glossaries unless they materially improve understanding, operation, maintenance, or navigation.

Do not repeat the title in prose.

Use a table when it expresses structured information more clearly and compactly than prose. Use a diagram only when relationships are materially clearer visually.

Do not create hierarchy that contains only one meaningful child or exists only to make the document look structured.

## Filenames

Use stable descriptive filenames for current documentation.

Do not date filenames merely to record when a document was written. Use dates only when the document intentionally represents a time-bound snapshot or historical record.

Prefer subject names over development-phase names.

## Cleanup

When reviewing existing documentation, classify each document or section as:

- **Keep** — it has a current purpose and is the correct owner.
- **Merge** — useful information belongs in another authoritative source.
- **Replace with link** — another source owns the information and this location only needs navigation.
- **Convert** — useful rationale belongs in a decision record, or reusable evidence belongs in a test, check, fixture, or procedure.
- **Delete** — it no longer serves a current purpose.

Deletion is a successful outcome.

Do not preserve material because effort was previously spent creating it. Do not create an archive directory merely to avoid deleting obsolete documentation. Git already preserves history.

## Extending the schema

Add a new type, status, field, or standard block only when:

- an existing feature does not fit;
- the need is recurring or clearly cross-repository;
- standardising it removes repeated agent judgment or prevents inconsistency;
- the new feature changes lifecycle, navigation, interpretation, or maintenance behavior.

Do not add schema for hypothetical future needs.

Prefer extending the shared vocabulary over creating repository-local equivalents. Remove schema features that stop serving a practical purpose.

## Completion check

Before finishing a documentation change or a technical change that affects documented state, verify:

- every surviving document has a current purpose;
- each concern has one authoritative owner;
- related documents link to that owner instead of duplicating it;
- direct-entry readers can quickly determine scope and where to go next;
- schema fields are valid and necessary;
- changes that affect documented system state have updated or removed the affected documentation, and no surviving current documentation describes superseded behavior;
- temporary plans and evidence remain only while useful;
- obsolete material has been deleted;
- no content can be removed without losing useful information, navigation, or lifecycle meaning.
