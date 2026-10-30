# Troubleshooting

Symptom- and error-code-oriented recovery guide for the AI-DLC workflow. Read [Operating the workflow](./operating-workflow.md) for the lifecycle model and [Command reference](./command-reference.md) for flag details.

## State lock held or times out

- Lock files live at `.agents/data/state/.aidlc-state.lock` and its companion `.agents/data/state/.aidlc-state.lock.guard`.
- Defaults: acquisition times out after **5 seconds** (`timeoutMs` 5000) and treats a lock as stale only when it is **30 seconds** old (`staleMs` 30000) **and** its owning PID is no longer alive.
- Contention under concurrent agents is normal; every mutation acquires the lock, including read-only `task list` and `task show`. Wait or serialize callers rather than deleting a live lock.
- A dead PID lets the lock be reclaimed automatically. Do not delete a lock whose PID is still alive — that corrupts in-flight state.
- Partially written or corrupt lock records are now reclaimed automatically instead of wedging mutations (recent release note). The reclamation is best-effort: if it fails, inspect the file before retrying.
- When a lock is corrupt, the owning process may be unable to release it; remove only an unreadable/partial file after confirming no live process holds it.

## Corrupt state or assignment files

- Corrupt local assignment files surface as `Corrupt local assignments for <task-id>`; corrupt loop/lease records surface as `Corrupt loop lease` / `Corrupt loop run record`. State JSON problems surface as `<label> is corrupted or unreadable: ...`.
- Restore from `.agents/data/state/backups/upgrade-<timestamp>` created by `upgrade`/migration, or from git. These backups are the audit trail for managed writes.
- `assignment-store` also guards against a corrupt assignment lock file (`Corrupt assignment lock for <task-id>`); inspect it before retrying rather than blindly deleting.
- Never hand-edit canonical state to "fix" corruption; restore from backup or git and re-run `state.mjs state migrate` if schema-versioned.

## `LESSON_INDEX_STALE` warning

- A mutation committed but the derived lesson-index rebuild failed. The mutation stays committed and the exit code stays `0`.
- Run `node .agents/aidlc/scripts/state.mjs lesson rebuild` (local authority required; throws `Fleet authority is configured` if `AIDLC_FLEET_URL` is set — use `remote-state.mjs`).

## `RENDER_FAILED` warning

- A mutation committed but the workplan render failed.
- Run `node .agents/aidlc/scripts/render.mjs <task-id>` (or `--all`).

## Continuation guard exit code 2 (`CONTINUATION_REQUIRED`)

- `task-next.mjs <task-id> --require-stop` exits `2` when `continuation.code = CONTINUATION_REQUIRED`. This is an expected pause, not a failure.
- Execute `continuation.command` instead of replying. Do not treat exit code 2 as an error.
- If a premature final response already slipped out, recover in the very next turn by running `task next <task-id>` and executing its returned command. Never re-approve a gate to catch up.

## Gate-check structural errors

`gate-check.mjs` returns diagnostics; fix the underlying artifact or record, never skip the check. Codes:

- `INTENT_HEADING` — intent artifact missing one of the five required headings: `## 📋 Problem`, `## 🗺️ Affected areas`, `## 💭 Assumptions`, `## ❓ Open questions`, `## 🎯 Scope`.
- `DESIGN_HEADING` — design artifact missing one of the four required headings: `## 🧩 Solution per affected area`, `## 📌 Spec traceability`, `## 🔗 Cross-service contracts`, `## ⚠️ Risks / edge cases`.
- `UNRESOLVED_DECISION` — a decision is still `unresolved`; resolve every decision before presenting G1.
- `TASKS_OPEN` — build tasks remain open (`todo`/`in_progress`).
- `VERIFY_EVIDENCE` — latest post-G1 verification evidence must pass for every affected area.
- `REVIEW_EVIDENCE` — latest post-G1 code-review evidence must pass.
- `REPAIR_BOUND` — repair bound exhausted (3 failed verify cycles per area, or 2 failed review passes); record a durable handoff instead of presenting G2.
- `TASK_UNKNOWN` — unknown task id.
- `GATE_STATE` — task is at a different gate than requested.
- `TASK_TERMINAL` — terminal task cannot approve a gate.
- `TASK_HANDOFF` — task has an unresolved handoff.
- `TASK_ID` — task key and id differ.
- `TASK_FIELDS` — task title or affected areas missing.
- `GATE_OK` — informational; all checks passed.

## `Task already exists` / actionable-task guard

- `task create` fails with `Task already exists: <id>` when the id is already present; resume with `task next <id>`.
- While another task has `nextAction: run_phase`, `task create` fails with `Task create is blocked while other work is actionable: ...`. Pass `--switch-from <task-id>` **only** with explicit user direction; acknowledged tasks keep their state and remain the resume target (a resume-marker diagnostic is stamped). Never pause or mutate the acknowledged task.
- This guard is local-CLI enforcement; the coordination service does not enforce it.

## Fleet authority mismatch

- When `AIDLC_FLEET_URL` is set, local lifecycle scripts throw `Fleet authority is configured; use remote-state.mjs instead of local lifecycle scripts`. This is by design — never silently switch authorities.
- Use `node .agents/aidlc/scripts/remote-state.mjs ...` for all mutations. See [Coordination service](./coordination-service.md).

## Docker worker image missing (fleet e2e tests)

- `test/unit/loop-fleet-e2e.test.ts` skips cleanly with `Docker worker image unavailable` when the image (default `aidlc-worker-fleet-e2e-test:local`, overridable via `AIDLC_WORKER_DOCKER_IMAGE`) is missing. No failure is recorded.
- Build the worker image, or set `AIDLC_TEST_WORKER_IMAGE`/`AIDLC_WORKER_DOCKER_IMAGE`, to enable coverage. Postgres coverage additionally needs `TEST_POSTGRES_URL`.

## Loop / fleet experimental status

- The end-to-end loop and coordination service are experimental and unfinished; pre-1.0 breaking changes are possible.
- Selecting a mode during `init` or `upgrade` never starts or approves anything. Only `aidlc-kit loop start` runs the loop.
- See the warning in [README](../README.md) and [Coordination service](./coordination-service.md).

## When to escalate

- Repair bound hit (`REPAIR_BOUND`): follow the returned handoff command — record a durable handoff (`task handoff`), reopen to plan, create a successor, supersede, or close — with evidence. Do not present G2.
- Security, migration, or contract changes reopen Approve plan (G1) even after a prior approval; re-run `gate-check` and present the gate again.
- Fleet/loop issues affecting canonical state: stop and use `remote-state.mjs`; never mix authorities.