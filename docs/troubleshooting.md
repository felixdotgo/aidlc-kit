# Troubleshooting

Symptom- and error-code-oriented recovery guide for the AI-DLC workflow. Read [Operating the workflow](./operating-workflow.md) for the lifecycle model and [Command reference](./command-reference.md) for flag details.

## State lock held or times out

- Lock files live at `.agents/data/state/.aidlc-state.lock` and its companion `.agents/data/state/.aidlc-state.lock.guard`.
- Defaults: acquisition times out after **5 seconds** (`timeoutMs` 5000) and treats a lock as stale only when it is **30 seconds** old (`staleMs` 30000) **and** its owning PID is no longer alive.
- Contention under concurrent agents is normal; every mutation acquires the lock, including read-only `task list` and `task show`. Wait or serialize callers rather than deleting a live lock.
- A dead PID lets the lock be reclaimed automatically. Do not delete a lock whose PID is still alive — that corrupts in-flight state.
- Partially written or corrupt lock records are now reclaimed automatically instead of wedging mutations (recent release note). The reclamation is best-effort: if it fails, inspect the file before retrying.
- When a lock is corrupt, the owning process may be unable to release it; remove only an unreadable/partial file after confirming no live process holds it.

## Loop leases, locks and claims

Start every loop "stuck" or "already running" investigation with one read-only command. It lists who holds what, until when, what it blocks, and how to clear it:

```bash
aidlc-kit loop leases [--task-id <task-id>]            # or: node .agents/aidlc/scripts/loop-entry.mjs leases [task-id]
aidlc-kit loop leases --json                           # stable JSON (schemaVersion 1)
aidlc-kit loop leases --clear-stale                    # remove stale holders only
```

Three words, three meanings:

| Word | Meaning | Local files under `.agents/data/` | Fleet (coordination service) |
| --- | --- | --- | --- |
| **lock** | Short mutex held only while a file is read-modified-written | `state/.aidlc-state.lock` (lifecycle state), `loop/assignments/<task>.lock` | — |
| **lease** | A process owns something: the loop daemon, or a task's loop run | `loop/daemon.lock`, `loop/<task>.lease` | supervisor lease, lead lease (`run_claim`) |
| **claim** | A worker owns an item and its paths | `loop/assignments/<task>.json` (assignment records) | job claim (`job_*`) |

How local leases and locks work (one format for all of them):

- Each holder file records `kind`, `scope`, `pid`, `host`, `command`, `activity`, `startedAt`, `heartbeatAt`, and `expiresAt`. A holder is **live** while `expiresAt` is in the future **and**, on the same host, its pid is still running. A host-local pid cannot be checked from another host, so a holder written by another host (a shared drive) is judged by `expiresAt` alone.
- Leases last **60 s** and are renewed every **15 s**. Locks last **30 s** and are not renewed. A recycled pid no longer keeps a lease alive forever: once the owner stops renewing it, it expires.
- A holder that is no longer live is **stale**. The next acquire reclaims it automatically (event `holder_reclaimed`).
- An unreadable holder file is **corrupt**. Once it is older than its TTL it is reclaimed like a stale one. A recent corrupt file fails closed with its path and age; wait for the TTL, then use `--clear-stale` if no loop process is running.
- The task lease `loop/<task>.lease` has an `activity`. `waiting` means the supervisor sits between runs and a human may approve gates. `turn` means a loop run is executing, and `state.mjs gate approve` refuses.
- Reclaims, renewals, and releases are serialized by a short-lived `<file>.guard`. A guard is treated as abandoned when its pid is gone or it is older than 10 s.

`--clear-stale` removes only stale lease, lock, and guard files, and corrupt files older than their TTL. It re-reads each one under its guard first. It never removes a live holder, never releases an assignment claim (it prints the `reconcile` / `release` command instead), and never touches the lifecycle state lock, which reclaims itself. Do not delete these files by hand.

| Symptom / message | Cause | Fix |
| --- | --- | --- |
| `Loop daemon already running (pid N): lease daemon is held by pid N on <host> …` | Another `loop start` owns this project root | Stop it (Ctrl-C). If that process is gone, the lease expires within 60 s and is reclaimed |
| `Task <id> already has a live supervisor` / `… live loop runner (pid N): …` | Another loop process owns the task lease | `loop leases --task-id <id>` shows the pid, host, and command. Stop that process or wait |
| `Gate approval is unavailable while loop runner owns <id>; … task lease held by pid N …, activity turn` | A loop run is executing for that task | Wait for it to stop at the gate (the task lease returns to `waiting`), then approve |
| `Corrupt lease file <path> (modified 5s ago); it is reclaimed automatically once older than 60s …` | An unreadable holder file | Wait for the TTL. If no loop process is running, run `loop leases --clear-stale` afterwards |
| `lease ownership lost: lease task:<id> was taken over …` / `local supervisor ownership lost` | This process stopped renewing for longer than the TTL (suspended machine, blocked event loop) and another process reclaimed the lease | The run stops safely. Restart `loop start` |
| `A loop from a previous aidlc-kit version is still running for <id> …` | An old `<task>.supervisor.lease` is still held after an upgrade | Stop the old daemon and any `loop start`, then retry. Stop the daemon before every upgrade |
| `Timed out waiting for assignment lock: <task>: lock assignments:<task> is held by …` | Another assignment command is mid-write | Retry. A stale lock is reclaimed automatically |
| `Item already leased: <item>: claimed by assignment <id> (… worker …, paths …, claim expires …)` | A worker holds the claim | Wait for it to report or expire. If the worker is gone: `assignment.mjs release <task> <id>` (discards its unintegrated result) |
| `Item has unresolved assignment; reconcile before retry: <item>: assignment <id> …` / `Owned path overlaps active assignment: <path>: held by assignment <id> …` | An earlier claim is `reported`/`uncertain`, or holds overlapping paths | `assignment.mjs reconcile <task>` once the item is done in canonical state; otherwise `assignment.mjs release <task> <id>` |
| `assignment.mjs show` lists `"effectiveState": "expired"` | A `leased` claim passed `leaseExpiresAt`; `show` never writes, so the stored state is still `leased` | `assignment.mjs reconcile <task>` (the next mutation persists it as `uncertain`) |
| `Worker lease lost: the claim on assignment <id> … ended before the worker finished` | Claim renewal failed or the worker turn was aborted | The result is not integrated. Run `assignment.mjs reconcile <task>` |
| `Fleet conflict: the lead lease (run_claim) is no longer valid … (stale or expired lead claim)` | The lead's `loop start` stopped, lost its connection, or another lead took over | Restart the loop on one lead machine. `loop leases` lists the fleet supervisor lease, lead lease, and job claims when lead credentials are set |
| `Fleet conflict: another lead holds the lead lease … (lead claim is held)` | Two lead machines run the same task | Stop one. Fleet leases expire 5 minutes after the last heartbeat |

## Corrupt state or assignment files

- Corrupt local assignment files surface as `Corrupt local assignments for <task-id>`; corrupt loop records surface as `Corrupt loop run record`. Corrupt lease and lock files surface as `Corrupt <lease|lock> file <path> (modified <age> ago)`; see [Loop leases, locks and claims](#loop-leases-locks-and-claims). State JSON problems surface as `<label> is corrupted or unreadable: ...`.
- Restore from `.agents/data/state/backups/upgrade-<timestamp>` created by `upgrade`/migration, or from git. These backups are the audit trail for managed writes.
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
- `PARTITION_SCOPE` / `PARTITION_OVERLAP` — Approve plan parallel work partition; see [below](#parallel-work-partition-partition_overlap--partition_scope).
- `GATE_OK` — informational; no `ERROR` diagnostics (warnings may still be listed).

## Parallel work partition (`PARTITION_OVERLAP` / `PARTITION_SCOPE`)

The Approve plan check (`gate-check.mjs <task-id>`) inspects build items so parallel workers never edit the same files:

- `PARTITION_SCOPE` — an open item has no owned paths. Give it a scope: `node .agents/aidlc/scripts/state.mjs task item <task-id> <item-id> --status todo --label "<label>" --owns src/a,docs/b`.
- `PARTITION_OVERLAP` — two items that can run concurrently (no direct or transitive `dependsOn` between them) own overlapping paths. Overlap is per path segment: `src` overlaps `src/a.ts`, but not `srcx`. Split the paths, merge the items, or order them with `--depends-on <item-id>`.
- Severity follows the loop: `ERROR` when `loop.mode` is `local` or `fleet` (or inside a fleet-enabled coordination service), so the gate cannot be presented; `WARN` when the loop is `off`, and the gate still passes with `GATE_OK`.
- The rendered workplan shows each item's scope as `owns: … · after: …`; the intent and design templates carry **Work boundaries** / **Parallel work partition** sections to plan it.

## Build items deferred or `build dispatch failure: Unresolved assignment`

- A `build_deferred` event (with `itemId` and `reason`) is not an error. The local scheduler dispatches a batch of non-overlapping ready items, at most one per configured worker, and defers the rest (`overlaps <item>`, `busy path held by an active assignment`, `unresolved assignment`, `capacity`) to a later batch. The fleet coordinator applies the same overlap rule.
- The task pauses with `build dispatch failure: Unresolved assignment <id> (<state>) for <item> holds <paths>; inspect it, then run node .agents/aidlc/scripts/assignment.mjs reconcile <task-id> or … release <task-id> <assignment-id>` when a `reported` or `uncertain` assignment of an unfinished item (or a still-`leased` one, reported as `Active assignment`) blocks every ready item. The loop never releases it automatically.
- Inspect it with `aidlc-kit loop leases --task-id <task-id>` (claims with expiry and the exact commands) or `node .agents/aidlc/scripts/assignment.mjs show <task-id>`, plus the worker's branch or worktree. Run `assignment.mjs reconcile <task-id>` when the outcome is recorded, or `assignment.mjs release <task-id> <assignment-id>` only after confirming the work is abandoned. Then re-activate the task (dashboard **resume** or `state.mjs task status <task-id> --status active`).
- `Build item <item> requires an owned path scope for Docker dispatch` means an item reached build without `--owns`; fix the plan (see `PARTITION_SCOPE`).

## `Git worktree must be clean before handoff or integration`

- The lead checkout must have no uncommitted or untracked changes before a worker handoff or integration. Commit, stash, or remove them, then re-activate the task.
- Host-local loop files under `.agents/data/loop/` (daemon lock, `daemon.log`, `ui-events.jsonl`) are ignored by this check, so a running daemon or dashboard does not trigger it.

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

## Worker image missing at build dispatch

- Local build dispatch auto-builds the per-provider image (`aidlc-worker-<provider>:local`) from the packaged Dockerfile when it is missing, so this error usually does not surface.
- If the build cannot complete (no Docker daemon, no network to fetch the CLI, or a removed Dockerfile), the worker batch fails with `Docker engine, image, or provider CLI preflight failed`. Run `aidlc-kit loop worker-image --provider <provider>` directly to see the build output, or set `AIDLC_WORKER_DOCKER_IMAGE` to an image you built yourself.
- Fleet workers resolve the image on their own machine: `AIDLC_WORKER_DOCKER_IMAGE`, else `loop.workerImage[provider]` from the project config, else `aidlc-worker-<provider>:local` (auto-built when missing). The provider comes from `AIDLC_FLEET_WORKER_AGENT`, else the worker's entry in `AIDLC_FLEET_WORKER_PROVIDERS`, else `AIDLC_FLEET_AGENT` (a copied lead env never overrides the worker's own mapping); without one, `AIDLC_WORKER_DOCKER_IMAGE is required when the worker provider is unknown`. To build ahead of time, run `aidlc-kit loop worker-image --provider codex|claude|opencode` on that machine.

## Loop daemon diagnostics

- `Loop daemon already running (pid N): …` — one daemon per project (the `daemon` lease in `.agents/data/loop/daemon.lock`); stop the running one first. A lease whose pid is gone, or that stopped renewing for 60 s, is reclaimed automatically. Run `aidlc-kit loop leases` to see the holder.
- `daemon_poll_error` — the daemon could not list tasks (for example the fleet service is unreachable). It keeps polling and does not stop; fix connectivity or credentials and it recovers on the next poll.
- `daemon_turn_error`, or a `daemon_turn` with status `blocked`/`reconcile` — that task is retried with exponential backoff (capped at 10 minutes) while other tasks keep running. Inspect it with `task show` (local) or `remote-state.mjs task next` (fleet).
- `loop resume is removed …` — use `loop start`; re-activate a paused task with the dashboard **resume** or the task status command.

## Dashboard `401` / `403`

- `401 Invalid or missing approve token` — the browser has no current token. Open the login URL printed by `aidlc-kit ui` (the token changes on every restart unless you pass `--token-file`), or paste the token into **Settings**. The token is accepted only in the `x-aidlc-token` or `Authorization: Bearer` header, never as a form or body field.
- `403 Host header does not match this dashboard; open it at its bound address` — the page was opened under a host name other than the bound address (for example a LAN name while bound to `127.0.0.1`). Use the printed URL; any loopback name works when bound to loopback.
- `403 Cross-origin request rejected` — a state-changing request came from another origin. Use the dashboard page itself.
- `403 Fleet approval needs the reviewer credential …` — a fleet dashboard without a reviewer credential cannot approve. Restart `aidlc-kit ui` with `AIDLC_FLEET_REVIEWER_TOKEN` or `--reviewer-token-file <file>` (outside the project, mode `600`), or approve from a reviewer terminal with `remote-state.mjs gate approve <task-id> --snapshot <id> --source "<approval>"`.
- `Token file must …` — `--token-file`/`--reviewer-token-file` must live outside the project, be a regular non-symlink file with mode `600`/`400`, and contain one 16–256 character token.

## Loop / fleet experimental status

- Local loop mode is usable today; fleet mode and the coordination service are still under active development. The whole loop is experimental; pre-1.0 breaking changes are possible.
- Selecting a mode during `init` or `upgrade` never starts or approves anything. Only `aidlc-kit loop start` runs the loop daemon, in either mode.
- See the warning in [README](../README.md) and [Coordination service](./coordination-service.md).

## When to escalate

- Repair bound hit (`REPAIR_BOUND`): follow the returned handoff command — record a durable handoff (`task handoff`), reopen to plan, create a successor, supersede, or close — with evidence. Do not present G2.
- Security, migration, or contract changes reopen Approve plan (G1) even after a prior approval; re-run `gate-check` and present the gate again.
- Fleet/loop issues affecting canonical state: stop and use `remote-state.mjs`; never mix authorities.