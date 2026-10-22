# AI-DLC v1 Conventions

## Canonical data

Schema v4 is one authoritative store with multiple records: `.agents/data/state/aidlc-state.json` keeps active task state plus a compact archive catalog; immutable terminal records live under `.agents/data/state/archive/` and are verified by digest. `.agents/data/lessons/index.json` is a rebuildable cache, never a source of truth. `.agents/data/memory/agentic-memory.json` is a separate project-owned advisory registry, with explicit promotion/retirement audit data; it is never lifecycle state or a substitute for project rules. Use bounded `task list`, `task find`, and `task show <task-id>` commands; do not persist `BOARD.md` or another editable state projection. Intent, design, and workplan prose remain Markdown review artifacts under a stable task directory keyed by `task_id`.

Never edit review artifacts to change state. Use `node .agents/aidlc/scripts/state.mjs`, then run `node .agents/aidlc/scripts/render.mjs <task-id>` when a refreshed workplan is needed.

## Task lifecycle

```text
clarify/G0_confirm → plan/G1_review → build/G2_codereview → wrap/none → done/none
                                      ↘ paused/handoff → reopened plan, closed, or superseded → fresh successor at Confirm requirements
```

Each transition requires the preceding approval evidence. Build additionally requires every decision to be `approved`, `changed`, or `dropped`. The latest passing approval at Approve plan starts the current build boundary. Wrap requires current-build verification, current-build review, and current-build approval at Review implementation; evidence from an older build boundary cannot advance a reopened task.

Verification is evaluated independently for each affected area and each `test` or `lint` kind recorded after the current build boundary. At least one verification kind must exist per area, and the latest record of every kind present must pass. A lint pass cannot hide a test failure, or vice versa.

`blocked_on_user` is reserved for a gate that is structurally ready and waiting for explicit human approval; wrap has no human gate, so it is rejected there. Every route that leaves a human gate wait, including `paused`, requires the audited form `task status <id> --status <active|paused> --mode audited --reason <reason> --source <source>`, which records a gate-bound diagnostic evidence entry, or a sourced closure/handoff command that leaves its own terminal trail. Entering `paused` from `active` requires the same audited form and records a `Paused while active` diagnostic; resuming `paused → active` needs no audit metadata. `task archive <id> --reason <reason> --source <source>` is the sourced completion alias of `task transition --to done`: it applies the same transition checks and records an `Archive to done` diagnostic. Exactly two compatibility paths exist and neither is a human approval: a migration-stamped legacy Review implementation wait (the `legacyG2Wait` marker is written only by schema migration and only exempts a still-ready wait from the repair bound; runtime commands consume and clear it) and the command-driven recovery of an invalid `wrap`/`none` wait back to `active`. A real blocker or exhausted repair bound uses `task handoff` with `--kind` exactly one of `repair_exhausted`, `review_exhausted`, `g2_failed`, `release_failed`, `structural_change`, or `other`. Every durable handoff exposes `create_successor`, `supersede`, and `close`; build-phase handoffs additionally expose `reopen_g1`. Reopening the Approve plan step resets every non-deferred build item to `todo`. `closed` and `superseded` are terminal non-success outcomes that preserve the phase where work stopped; only `done` is successful completion. A successor is created as a fresh task at Confirm requirements, then linked atomically with `task supersede`; it never inherits approvals or evidence.

Lifecycle commands that end or redirect work require an explicit reason and source:

```sh
node .agents/aidlc/scripts/state.mjs task handoff <id> --kind <kind> --reason <reason> --source <source>
node .agents/aidlc/scripts/state.mjs task reopen <id> --to plan --reason <reason> --source <source>
node .agents/aidlc/scripts/state.mjs task close <id> --reason <reason> --source <source>
node .agents/aidlc/scripts/state.mjs task supersede <id> --successor <fresh-id> --reason <reason> --source <source>
```

Decision states:

- `unresolved`: build is blocked.
- `approved`: implement the proposed choice.
- `changed`: implement the recorded resolution.
- `dropped`: explicitly out of scope.

## Evidence

Evidence kinds are `approval`, `spec`, `test`, `lint`, `review`, and `diagnostic`; results are `pass`, `fail`, or `skip`. Approval evidence is created only by atomic `gate approve`; the generic `evidence add` command rejects `approval`. A skipped verification must state residual risk. Evidence is append-only during a task; corrections add a new record rather than rewriting history, and current-build boundaries use that append order rather than wall-clock ordering.

## Command output contract

Every `state.mjs` and `task-next.mjs` command prints one JSON envelope: `{ok: true, result, nextAction?}` on success (with `nextAction` present whenever the command is task-scoped) and a one-line `{ok: false, error: {message, hint?}}` on stderr for failures. A success envelope may additionally carry `warnings: [{code, message, hint?}]` when the mutation persisted but a derived step failed afterwards — `LESSON_INDEX_STALE` (lesson-index rebuild) or `RENDER_FAILED` (workplan render); the mutation is committed, exit stays `0`, and the caller follows the hint instead of treating the command as failed. The explicit repair commands (`lesson rebuild`, `render.mjs`) and `state migrate` still fail loudly. With `--require-stop`, `task-next.mjs` adds a machine-readable `continuation` object to the envelope (`{required, code: CONTINUATION_REQUIRED|STOP_ALLOWED, taskId, classification}` plus `command`, `reason`, `itemId`, and `remainingItems` while work remains) and prints `CONTINUATION_REQUIRED: {json}` as the first stderr line; execute `continuation.command` instead of replying. Exit codes are typed: `0` success, `1` an expected validation or gate error, `2` the `--require-stop` continuation guard (an expected pause, not a failure), `3` an unexpected crash. Commands embedded in `nextAction` carry an explicit `--root` so they run correctly from any working directory.

## Human gate forms

Gate presentation is executable, not model-authored. After a passing gate check, set `blocked_on_user`, render the phase artifact when required, then run `node .agents/aidlc/scripts/gate-view.mjs <task-id>` and relay its output verbatim. The default Markdown uses a portable `[!IMPORTANT]` blockquote with explicit task state, artifact links, decision/execution counts, evidence, and exactly one `ACTION REQUIRED` line. Use `--format plain` when the tool does not render Markdown and `--format json` for integrations. Renderer-specific color is enhancement only; approval semantics live in canonical state.

The Confirm requirements, Approve plan, and Review implementation steps never auto-pass. Gate approval and phase transition are atomic; after a non-terminal transition or item/evidence mutation, continue until the next human gate, real blocker, or completion. Item completion is never a turn-level handoff. The local CLI validates gate readiness and records `--source` as provenance, but without a host-attested channel it cannot prove who authored free-form text; adapters must invoke approval only in a later turn containing explicit user assent.

## Context budget

The default phase packet budget is 16,000 characters. Optional rules and diagnostics are omitted first. The next-action contract, full phase contract, approved decisions, safety/spec anchors, task state, and applicable latest evidence are mandatory; if they do not fit, packet generation fails instead of truncating them. Packet output reports characters, estimated tokens, and omitted rule files.

## Repair bounds

Repair bounds are machine-enforced from current-build evidence; the model does not have to count.

- Verification: at most three failed verify records (`test`/`lint`) per affected area. The third failure flips `nextAction` to `blocked` and adds a `REPAIR_BOUND` error to the Review implementation gate check.
- Review: at most two failed review records; the second failure does the same with `--kind review_exhausted`.
- Security, migration, contract, or where-logic-lives changes reopen the Approve plan step immediately.
- A bound hit produces a diagnosis and human escalation; it never silently passes. Follow the handoff command returned by `nextAction` instead of retrying.
- Reopening the Approve plan step moves the build boundary, which resets both counters for the new cycle.

## Language and scaffold

Technical tokens, paths, commands, enum values, and structural headings remain English. Prose follows the task language. Stable emoji headings are: `📋 Problem`, `🗺️ Affected areas`, `💭 Assumptions`, `❓ Open questions`, `🎯 Scope` (with an inline `**🚫 Out:**` list inside it), `🧩 Solution per affected area`, `📌 Spec traceability`, `🔗 Cross-service contracts`, `⚠️ Risks / edge cases`, `🧩 Decisions`, and `🧩 Tasks`. The intent headings and the design headings are enforced verbatim by `gate-check.mjs` at Confirm requirements and Approve plan.
