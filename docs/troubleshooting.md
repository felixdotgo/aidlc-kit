# Troubleshooting

Symptom- and error-code recovery for the AI-DLC workflow and the loop: lifecycle state, gates and plans, the loop, the dashboard, fleet. Lifecycle model: [Operating the workflow](./operating-workflow.md); flags: [Command reference](./command-reference.md).

## State lock held or times out

- Lock files: `.agents/data/state/.aidlc-state.lock` and `.agents/data/state/.aidlc-state.lock.guard`.
- Defaults: acquisition times out after **5 seconds** (`timeoutMs` 5000); a lock is stale only when **30 seconds** old (`staleMs` 30000) **and** its owning PID is dead.
- Every mutation acquires the lock, including read-only `task list` and `task show`; contention is normal. Wait or serialize callers.
- A dead PID is reclaimed automatically. Never delete a lock whose PID is alive.
- Corrupt lock records are reclaimed best-effort; if that fails, remove only an unreadable/partial file after confirming no live process holds it.

## Corrupt state or assignment files

- Messages: `Corrupt local assignments for <task-id>`, `Corrupt loop run record`, `Corrupt <lease|lock> file <path> (modified <age> ago)` ([leases](#loop-leases-locks-and-claims)), `<label> is corrupted or unreadable: ...` (state JSON).
- Restore from `.agents/data/state/backups/upgrade-<timestamp>` (created by `upgrade`/migration) or git; re-run `state.mjs state migrate` if schema-versioned. Never hand-edit canonical state.

## `LESSON_INDEX_STALE` warning

- A mutation committed but the derived lesson-index rebuild failed; the mutation stays committed and the exit code stays `0`.
- Run `node .agents/aidlc/scripts/state.mjs lesson rebuild` (local authority; throws `Fleet authority is configured` if `AIDLC_FLEET_URL` is set — use `remote-state.mjs`).

## `RENDER_FAILED` warning

- A mutation committed but the workplan render failed. Run `node .agents/aidlc/scripts/render.mjs <task-id>` (or `--all`).

## Continuation guard exit code 2 (`CONTINUATION_REQUIRED`)

- `task-next.mjs <task-id> --require-stop` exits `2` with `continuation.code = CONTINUATION_REQUIRED`: an expected pause, not a failure. Execute `continuation.command` instead of replying.
- After a premature final response, run `task next <task-id>` in the very next turn and execute its command. Never re-approve a gate to catch up.

## `Task already exists` / actionable-task guard

- `Task already exists: <id>` — resume with `task next <id>`.
- `Task create is blocked while other work is actionable: ...` — another task has `nextAction: run_phase`. Pass `--switch-from <task-id>` **only** with explicit user direction; the acknowledged task keeps its state, remains the resume target (a resume-marker diagnostic is stamped), and is never paused or mutated.
- Local-CLI enforcement only; the coordination service does not enforce it.

## Gate-check structural errors

`gate-check.mjs` returns diagnostics; fix the artifact or record, never skip the check. Codes:

- `INTENT_HEADING` — intent artifact missing one of: `## 📋 Problem`, `## 🗺️ Affected areas`, `## 💭 Assumptions`, `## ❓ Open questions`, `## 🎯 Scope`.
- `DESIGN_HEADING` — design artifact missing one of: `## 🧩 Solution per affected area`, `## 📌 Spec traceability`, `## 🔗 Cross-service contracts`, `## ⚠️ Risks / edge cases`.
- `UNRESOLVED_DECISION` — a decision is still `unresolved`; resolve all before presenting G1.
- `TASKS_OPEN` — build tasks remain `todo`/`in_progress`.
- `VERIFY_EVIDENCE` — latest post-G1 verification evidence must pass for every affected area.
- `REVIEW_EVIDENCE` — latest post-G1 code-review evidence must pass.
- `REPAIR_BOUND` — repair bound exhausted (3 failed verify cycles per area, or 2 failed review passes); record a durable handoff instead of presenting G2.
- `TASK_UNKNOWN` — unknown task id.
- `GATE_STATE` — task is at a different gate than requested.
- `TASK_TERMINAL` — a terminal task cannot approve a gate.
- `TASK_HANDOFF` — unresolved handoff.
- `TASK_ID` — task key and id differ.
- `TASK_FIELDS` — title or affected areas missing.
- `PARTITION_SCOPE` / `PARTITION_OVERLAP` — see [below](#parallel-work-partition-partition_overlap--partition_scope).
- `GATE_OK` — informational; no `ERROR` diagnostics (warnings may still be listed).

## Parallel work partition (`PARTITION_OVERLAP` / `PARTITION_SCOPE`)

The Approve plan check (`gate-check.mjs <task-id>`) inspects build items so parallel workers never edit the same files:

- `PARTITION_SCOPE` — an open item has no owned paths. Fix: `node .agents/aidlc/scripts/state.mjs task item <task-id> <item-id> --status todo --label "<label>" --owns src/a,docs/b`.
- `PARTITION_OVERLAP` — two items with no direct or transitive `dependsOn` own overlapping paths (per path segment: `src` overlaps `src/a.ts`, not `srcx`). Split the paths, merge the items, or order them with `--depends-on <item-id>`.
- Severity: `ERROR` when `loop.mode` is `local` or `fleet` (or in a fleet-enabled coordination service), so the gate cannot be presented; `WARN` when the loop is `off` (gate still `GATE_OK`).
- The workplan shows `owns: … · after: …` per item; the intent and design templates carry **Work boundaries** / **Parallel work partition** sections.

## Loop stops, pauses, or never starts

> [!WARNING]
> The loop and fleet sections below cover experimental, pre-1.0 features. See [Status and stability](./loop-runbook.md#status-and-stability).

Start with `node .agents/aidlc/scripts/state.mjs task show <task-id>`: look for a `diagnostic` `Paused while active: …`; the cause is also the run's `stopReason`, for example `"agent transport failure: opencode reported an error: Model unavailable: opencode-go/flint-40b-free"`.

| Symptom / message | Cause | Fix |
| --- | --- | --- |
| `agent transport failure: …` (for example `Model unavailable: …`) | Missing, invalid, or unavailable `AIDLC_OPENCODE_MODEL` | Check `opencode models`, set `AIDLC_OPENCODE_MODEL`, restart the daemon, re-activate the task (below) |
| `turn limit reached` | The per-run `maxTurns` budget ran out before a gate | Raise `loop.limits.maxTurns` if needed, then re-activate |
| `opencode provider requires AIDLC_OPENCODE_MODEL` | Unset or not `provider/model[#variant]` | `loop.sh check` names the value and where to set it (`.agents/loop.env` or `"model"` in `opencode.json`); `loop start`/`loop up` stop on this before the daemon starts. Restart a running daemon after changing it |
| `Loop requires a configured lead and worker providers` | `loop.agents.lead` or `loop.agents.workers` missing | Complete `loop.agents` ([Enable the loop](./loop-runbook.md#enable-the-loop-from-off)) |
| `Requested mode does not match configured authority` | `--mode` differs from `loop.mode` | Drop `--mode` |
| `loop: Isolated local worker dispatcher is not integrated; loop execution is unavailable` | Stale installed `.agents/` copy (predates `createIsolatedLocalSupervisor`) | Re-sync with the human-only [`upgrade`](./command-reference.md#upgrade); source checkout: [Dogfooding](./development.md#dogfooding-this-repository) |

**The task pauses right after a gate approval and the daemon polls `actionable: []`.** The lead turn after approval failed, so the loop re-paused the task (`status: paused`, `nextAction: blocked`). Recovery from any pause:

1. Fix the environment (for example `opencode models`, then `AIDLC_OPENCODE_MODEL`).
2. Restart the daemon (`loop.sh down`, `loop.sh up`); a running daemon keeps the environment it started with.
3. Re-activate: dashboard **resume**, or `node .agents/aidlc/scripts/state.mjs task status <task-id> --status active`.

OpenCode's own log: `grep -n "ModelUnavailableError\|Failed to drain Session" ~/.local/share/opencode/log/opencode.log | tail -20`. A silent lead is usually not hanging; a clarify or plan turn can take minutes ([streaming log](./loop-local-run.md#follow-the-streaming-log)).

## Loop leases, locks and claims

Start every "stuck" or "already running" investigation with the read-only diagnostic; it lists who holds what, until when, what it blocks, and how to clear it:

```bash
aidlc-kit loop leases [--task-id <task-id>]            # or: node .agents/aidlc/scripts/loop-entry.mjs leases [task-id]
aidlc-kit loop leases --json                           # stable JSON (schemaVersion 1)
aidlc-kit loop leases --clear-stale                    # remove stale holders only
```

| Word | Meaning | Local files under `.agents/data/` | Fleet (coordination service) |
| --- | --- | --- | --- |
| **lock** | Short mutex held only while a file is read-modified-written | `state/.aidlc-state.lock` (lifecycle state), `loop/assignments/<task>.lock` | — |
| **lease** | A process owns something: the loop daemon, or a task's loop run | `loop/daemon.lock`, `loop/<task>.lease` | supervisor lease, lead lease (`run_claim`) |
| **claim** | A worker owns an item and its paths | `loop/assignments/<task>.json` (assignment records) | job claim (`job_*`) |

Local holder files share one format:

- Fields: `kind`, `scope`, `pid`, `host`, `command`, `activity`, `startedAt`, `heartbeatAt`, `expiresAt`. A holder is **live** while `expiresAt` is in the future **and**, on the same host, its pid is running; from another host (shared drive) `expiresAt` alone counts.
- Leases last **60 s**, renewed every **15 s**; locks last **30 s**, not renewed. A recycled pid cannot keep a lease alive.
- A holder no longer live is **stale**; the next acquire reclaims it (event `holder_reclaimed`). An unreadable holder is **corrupt**: older than its TTL it is reclaimed like a stale one, younger it fails closed with its path and age.
- The task lease `loop/<task>.lease` has an `activity`: `waiting` (gates may be approved) or `turn` (a run is executing; `state.mjs gate approve` refuses).
- Reclaims, renewals, and releases are serialized by a short-lived `<file>.guard`, abandoned when its pid is gone or it is older than 10 s.
- `--clear-stale` removes only stale lease, lock, and guard files and corrupt files older than their TTL, re-reading each under its guard. It never removes a live holder, never releases an assignment claim (it prints the `reconcile` / `release` command), and never touches the lifecycle state lock. Never delete these files by hand.

| Symptom / message | Cause | Fix |
| --- | --- | --- |
| `Loop daemon already running (pid N): lease daemon is held by pid N on <host> …` | Another `loop start` owns this project root (`daemon` lease in `.agents/data/loop/daemon.lock`) | Stop it (`loop.sh down`, or Ctrl-C in its terminal). If that process is gone, the lease is reclaimed within 60 s |
| `loop: error: opencode needs a model …` / `environment is incomplete` | No valid `AIDLC_OPENCODE_MODEL`, a malformed env file, or a missing explicit env file | `.agents/aidlc/scripts/loop.sh check`, then set the named value in `.agents/loop.env` (or `"model"` in `opencode.json`) |
| `The loop daemon exited during start-up` | The daemon exited before taking its lease | Read the printed tail of `.agents/data/loop/daemon.log`; `loop.sh logs` follows it |
| `loop.sh: the aidlc-kit CLI was not found` / `npx --no-install` fails | No package in `node_modules`, the CLI recorded in `.agents/data/loop/cli.json` by `init`/`upgrade` is gone (cleaned npx cache), and none on `PATH` | Rerun `init`/`upgrade` from the package or `.tgz` you want, or run the printed `npm install --save-dev @felixdotgo/aidlc-kit@<version>` |
| `Task <id> already has a live supervisor` / `… live loop runner (pid N): …` | Another loop process owns the task lease | `loop leases --task-id <id>` shows pid, host, and command; stop it or wait |
| `Gate approval is unavailable while loop runner owns <id>; … task lease held by pid N …, activity turn` | A loop run is executing for that task | Wait until it stops at the gate (activity `waiting`), then approve |
| `Corrupt lease file <path> (modified 5s ago); it is reclaimed automatically once older than 60s …` | An unreadable holder file | Wait for the TTL; if no loop process is running, `loop leases --clear-stale` |
| `lease ownership lost: lease task:<id> was taken over …` / `local supervisor ownership lost` | This process stopped renewing past the TTL (suspended machine, blocked event loop) and another reclaimed the lease | The run stops safely; restart `loop start` |
| `A loop from a previous aidlc-kit version is still running for <id> …` | An old `<task>.supervisor.lease` is still held after an upgrade | Stop the old daemon and any `loop start`, retry. Stop the daemon before every upgrade |
| `Timed out waiting for assignment lock: <task>: lock assignments:<task> is held by …` | Another assignment command is mid-write | Retry; a stale lock is reclaimed automatically |
| `Item already leased: <item>: claimed by assignment <id> (… worker …, paths …, claim expires …)` | A worker holds the claim | Wait for it to report or expire. If the worker is gone: `assignment.mjs release <task> <id>` (discards its unintegrated result) |
| `Item has unresolved assignment; reconcile before retry: <item>: assignment <id> …` / `Owned path overlaps active assignment: <path>: held by assignment <id> …` | An earlier claim is `reported`/`uncertain`, or holds overlapping paths | `assignment.mjs reconcile <task>` once the item is done in canonical state; otherwise `assignment.mjs release <task> <id>` |
| `assignment.mjs show` lists `"effectiveState": "expired"` | A `leased` claim passed `leaseExpiresAt`; `show` never writes | `assignment.mjs reconcile <task>` (the next mutation persists it as `uncertain`) |
| `Worker lease lost: the claim on assignment <id> … ended before the worker finished` | Claim renewal failed or the worker turn was aborted | The result is not integrated; `assignment.mjs reconcile <task>` |
| `Fleet conflict: the lead lease (run_claim) is no longer valid … (stale or expired lead claim)` | The lead's `loop start` stopped, lost its connection, or another lead took over | Restart the loop on one lead machine. `loop leases` lists the fleet supervisor lease, lead lease, and job claims when lead credentials are set |
| `Fleet conflict: another lead holds the lead lease … (lead claim is held)` | Two lead machines run the same task | Stop one. Fleet leases expire 5 minutes after the last heartbeat |

## Loop daemon diagnostics

- `daemon_poll_error` — the daemon could not list tasks (for example the fleet service is unreachable); it keeps polling and recovers once connectivity or credentials are fixed.
- `daemon_turn_error`, or a `daemon_turn` with status `blocked`/`reconcile` — that task is retried with exponential backoff (capped at 10 minutes) while other tasks keep running. Inspect with `task show` (local) or `remote-state.mjs task next` (fleet).
- `loop resume is removed …` — use `loop start`; re-activate a paused task with the dashboard **resume** or the task status command.

## Build items deferred or `build dispatch failure: Unresolved assignment`

- `build_deferred` (with `itemId` and `reason`) is not an error: the scheduler dispatches non-overlapping ready items, at most one per configured worker, and defers the rest (`overlaps <item>`, `busy path held by an active assignment`, `unresolved assignment`, `capacity`). The fleet coordinator applies the same overlap rule.
- `build dispatch failure: Unresolved assignment <id> (<state>) for <item> holds <paths>; inspect it, then run node .agents/aidlc/scripts/assignment.mjs reconcile <task-id> or … release <task-id> <assignment-id>` pauses the task when a `reported`/`uncertain` assignment of an unfinished item (or a still-`leased` one, reported as `Active assignment`) blocks every ready item. The loop never releases it automatically.
- Inspect with `aidlc-kit loop leases --task-id <task-id>` or `node .agents/aidlc/scripts/assignment.mjs show <task-id>`, plus the worker's branch or worktree. `assignment.mjs reconcile <task-id>` when the outcome is recorded; `assignment.mjs release <task-id> <assignment-id>` only after confirming the work is abandoned. Then re-activate the task (dashboard **resume** or `state.mjs task status <task-id> --status active`).
- `Build item <item> requires an owned path scope for Docker dispatch` — an item reached build without `--owns`; fix the plan (`PARTITION_SCOPE`).

## `Git worktree must be clean before handoff or integration`

- The lead checkout must have no uncommitted or untracked changes before a worker handoff or integration. Commit, stash, or remove them, then re-activate the task.
- Host-local loop files under `.agents/data/loop/` (daemon lock, `daemon.log`, `ui-events.jsonl`) are ignored.

## Worker image missing at build dispatch

- Local build dispatch auto-builds `aidlc-worker-<provider>:local` from the packaged Dockerfile, so this rarely surfaces.
- If the build cannot complete (no Docker daemon, no network for the CLI, removed Dockerfile), the batch fails with `Docker engine, image, or provider CLI preflight failed`. Run `aidlc-kit loop worker-image --provider <provider>` to see the build output, or set `AIDLC_WORKER_DOCKER_IMAGE` to an image you built.
- Fleet workers resolve the image on their own machine: `AIDLC_WORKER_DOCKER_IMAGE`, else `loop.workerImage[provider]`, else `aidlc-worker-<provider>:local` (auto-built). Provider: `AIDLC_FLEET_WORKER_AGENT`, else the worker's entry in `AIDLC_FLEET_WORKER_PROVIDERS`, else `AIDLC_FLEET_AGENT` (a copied lead env never overrides the worker's own mapping); without one: `AIDLC_WORKER_DOCKER_IMAGE is required when the worker provider is unknown`. Build ahead with `aidlc-kit loop worker-image --provider codex|claude|opencode` on that machine.
- Fleet e2e tests: in `test/unit/loop-fleet-e2e.test.ts` the CLI e2e skips with `Docker worker image unavailable` and the loop-daemon e2e fails when the image (default `aidlc-worker-fleet-e2e-test:local`, overridable via `AIDLC_WORKER_DOCKER_IMAGE`) is missing. Build it, or set `AIDLC_TEST_WORKER_IMAGE`/`AIDLC_WORKER_DOCKER_IMAGE`; Postgres coverage also needs `TEST_POSTGRES_URL`.

## Dashboard live log or actions do nothing

### Approve, send feedback, or resume does nothing

- The **feedback** and **approve** forms exist only on the full detail page `/tasks/<id>`; the **review** button on a `blocked_on_user` card opens that page.
- **✓ Approve** opens a confirmation popup; only **Confirm approve** sends. For guidance use **Send feedback (stay at gate)**; the approval note is provenance only.
- **Send feedback** is blocked while the textarea is empty (API `400`) and returns `409` when the task is not `blocked_on_user`. After a send the task shows `active` with a **feedback pending** pill; it runs again only if a daemon is polling.
- **resume** applies only to a `paused` task; any other status returns `409` with the reason. A resumed task runs only if loop-owned and a daemon is running.
- Nothing at all (no toast, error, or update): hard-refresh (Ctrl+Shift+R) and check the browser DevTools console.

### Dashboard `401` / `403`

- `401 Invalid or missing approve token` — open the login URL printed by `aidlc-kit ui` (new on every restart unless `--token-file`), or paste the token into **Settings**. Accepted only in the `x-aidlc-token` or `Authorization: Bearer` header, never as a form or body field.
- `403 Host header does not match this dashboard; open it at its bound address` — opened under another host name (for example a LAN name while bound to `127.0.0.1`). Use the printed URL; any loopback name works when bound to loopback.
- `403 Cross-origin request rejected` — a state-changing request from another origin; use the dashboard page itself.
- `403 Fleet approval needs the reviewer credential …` — restart `aidlc-kit ui` with `AIDLC_FLEET_REVIEWER_TOKEN` or `--reviewer-token-file <file>` (outside the project, mode `600`), or approve from a reviewer terminal with `remote-state.mjs gate approve <task-id> --snapshot <id> --source "<approval>"`.
- `Token file must …` — `--token-file`/`--reviewer-token-file` must be outside the project, a regular non-symlink file with mode `600`/`400`, containing one 16–256 character token.

### Live log is empty or stuck on "connecting…"

- The log reads `.agents/data/loop/events/<task-id>.jsonl`, falling back to the **fixed** global `.agents/data/loop/ui-events.jsonl`. The daemon writes only when `AIDLC_LOOP_EVENT_LOG` points at that exact path (set automatically); if the shell exports another path, unset it and restart the daemon.
- The full log is on the **detail** page (`/tasks/<id>`); the side panel shows the last 20 important lines.
- A stopped daemon produces no events; the header shows whether it runs, and `.agents/data/loop/daemon.log` has start-up errors.
- Daemon-wide events (`daemon_poll`, written only when the actionable set or error state changes) are only in the global file. If **Important** shows little, switch to **All** or **Raw JSON**.
- `tail -f` the task file (or the global file): if it grows while the page does not, hard-refresh. A quiet global file is normal; idle polls are not logged.

## Fleet authority mismatch

- With `AIDLC_FLEET_URL` set, local lifecycle scripts throw `Fleet authority is configured; use remote-state.mjs instead of local lifecycle scripts`. By design: never silently switch authorities.
- Use `node .agents/aidlc/scripts/remote-state.mjs ...` for all mutations ([Coordination service](./coordination-service.md)).

## When to escalate

- `REPAIR_BOUND`: follow the returned handoff command — durable handoff (`task handoff`), reopen to plan, successor, supersede, or close — with evidence. Do not present G2.
- Security, migration, or contract changes reopen Approve plan (G1) even after approval; re-run `gate-check` and present the gate again.
- Fleet/loop issues affecting canonical state: stop and use `remote-state.mjs`; never mix authorities.

## Related

- [Local loop walkthrough](./loop-local-run.md) — day-to-day loop operation.
- [Loop setup runbook](./loop-runbook.md) — enabling and configuring the loop.
- [AI-DLC Coordination service](./coordination-service.md) — fleet deployment and remote state.
- [Command reference](./command-reference.md) — flags, environment variables, and dashboard routes.
