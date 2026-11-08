# Local loop walkthrough

Day-to-day operation of the loop in `local` mode on one machine: start the daemon, add tasks, watch, answer gates, resume. To enable the loop first, follow the [Loop setup runbook](./loop-runbook.md#local-mode).

> [!WARNING]
> Experimental, pre-1.0. See [Status and stability](./loop-runbook.md#status-and-stability).

Commands use the published package (`npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit …`) or the installed launcher `./.agents/aidlc/scripts/loop.sh`; both drive the installed `loop-entry.mjs`. Source checkout: [Dogfooding this repository](./development.md#dogfooding-this-repository).

## How the loop works

- The **lead** runs `clarify` (gate `G0_confirm`), `plan` (`G1_review`), and `wrap` on the host, no Docker; **workers** run only `build` items (`G2_codereview`), isolated in Docker. Gates: [Operating the workflow](./operating-workflow.md).
- Each iteration reads `state.mjs task next`, runs one agent turn on the returned `nextAction`, re-reads canonical state, and updates the checkpoint/fingerprint.
- The loop **stops at every gate** and **never self-approves**; only a human on the trusted terminal or the signed-in dashboard approves.
- It also stops after the per-run `maxTurns` budget (a resumed run gets a fresh one), after `maxStallTurns` unchanged turns, or at `blocked`/`terminal`/`complete` (`loop.limits`: [Configuration](./configuration.md#optional-loop-configuration)).
- Config alone runs nothing; only `loop start` or `loop.sh up` runs the loop.

## Prerequisites

- Linux host with Docker (`docker info` must pass for the build phase) and a POSIX shell; Node.js ≥ 20.17.
- Lead provider CLI (`opencode`, `codex`, or `claude`) on the host `PATH`, matching `loop.agents.lead`.
- If any provider is `opencode`: `AIDLC_OPENCODE_MODEL` naming a model listed by `opencode models`.
- Worker credentials per provider/model: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENCODE_API_KEY`. The worker image is built automatically ([Worker Docker image](#worker-docker-image)).

## Set the environment

Put loop variables in `.agents/loop.env` (installed as a commented template, git-ignored through `.agents/.gitignore`) or `export` them in the shell that starts the daemon; exported values win. `loop start`, `loop up`, and a dashboard-started daemon load the file.

```sh
# .agents/loop.env
# Required for opencode unless "model" is set in opencode.json; use a model from `opencode models`:
AIDLC_OPENCODE_MODEL=<provider/model>
# Worker key for the build phase; read from ~/.local/share/opencode/auth.json when unset:
# OPENCODE_API_KEY=...
```

```sh
./.agents/aidlc/scripts/loop.sh check   # what the daemon will see; secrets are never printed
```

`AIDLC_LOOP_EVENT_LOG` is set to `.agents/data/loop/ui-events.jsonl` automatically. All variables: [runbook](./loop-runbook.md#step-2--fill-in-agentsloopenv); lookup order: [Command reference](./command-reference.md#loop).

> [!IMPORTANT]
> A running daemon keeps the environment it started with. After editing `.agents/loop.env`, run `loop.sh down`, then `loop.sh up`; `loop up` warns when the file changed after the daemon started.

## Start the daemon and add tasks

```sh
./.agents/aidlc/scripts/loop.sh up      # --open launches the browser; --no-ui starts only the daemon
./.agents/aidlc/scripts/loop.sh status  # daemon, dashboard, environment
./.agents/aidlc/scripts/loop.sh logs    # follow the daemon log
./.agents/aidlc/scripts/loop.sh down    # stop both; --now cancels the running turn
```

`Ctrl-C` in the `up` terminal closes only the dashboard. Windows: `.agents\aidlc\scripts\loop.cmd`, same commands.

Underneath, `loop start` runs the persistent daemon in the foreground and reads no requirement; one per project (a second fails with `Loop daemon already running (pid N)`):

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop start
```

- The daemon runs only **loop-owned** tasks: created through loop intake (`.agents/data/tasks/<id>/runtime/intake.json`) or holding a loop run record (`runtime/run.json`). An interactively created task (`state.mjs task create`) is never picked up, so the daemon cannot race an interactive lead.
- It runs one bounded run per actionable task in turn and keeps polling after a gate or completion.

Add a loop-owned task:

- **Dashboard → New task** creates the task and starts the daemon if none is running.
- **Terminal intake** reads the requirement from stdin (never an argument), at most 8192 bytes; id and title derive from the first line (`--task-id`/`--title` override).

  ```sh
  echo "Add PDF report export" | npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop intake
  echo "Add PDF report export" | node .agents/aidlc/scripts/loop-entry.mjs intake "" .   # installed entry point
  ```

- Intake refuses (creates nothing) while an **interactive** task is actionable; finish or pause it first.

Stopping (`Ctrl-C` or `SIGTERM`) is staged: first signal stops after the current turn, second cancels the in-flight agent turn, third exits immediately.

- A stopped run is recorded as `stopped` (the task is **not** paused) and resumes on the next `loop start`. A terminal `Ctrl-C` also reaches the agent child, so the turn usually ends on the first press; still `stopped`, not a transport failure.
- `aidlc-kit loop start` stays in the foreground for the whole shutdown (forwards `SIGTERM`, lets the terminal deliver `Ctrl-C`), so later presses reach the daemon.

## Watch status

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop status --task-id <task-id>
```

Prints `authority`, `record` (the loop run record), and `nextAction` (`classification`: `run_phase`, `await_user`, `blocked`, `complete`, …).

## Approve a gate or send feedback

Answer a gate on the trusted host terminal or the signed-in dashboard, never from the lead or a worker, never with piped input:

```sh
node .agents/aidlc/scripts/loop-gate.mjs <task-id>
# type: approve            -> approves this exact review and advances the phase
# type: <any other text>   -> feedback: the task stays at this gate
```

- Prints the exact review (task, phase, gate, artifact digests, and at `G2_codereview` the integration commit), then prompts `Type approve to approve this exact review, or type feedback to send guidance back to the loop:`.
- **`approve`** is the only answer that moves the task forward; if the review changes while you type, it fails closed.
- **Any other text is feedback**: recorded as evidence `Cancelled gate wait at <gate>: <feedback>`; the task returns to `active` at the same gate, and the next lead turn revises the review and re-presents the **same** gate.
- The dashboard detail page offers the same actions, **Send feedback (stay at gate)** and **✓ Approve** ([dashboard](#use-the-web-dashboard)).

## Resume after a gate or a pause

There is **no `loop resume`** in either mode; the daemon auto-resumes every task whose `nextAction` is `run_phase` (*actionable*).

- **After approving a gate**: nothing; the next poll runs the next lead turn.
- **After a pause** (agent transport failure, per-run turn limit): the task is `paused` (`nextAction` `blocked`) and skipped. Fix the cause, then press **resume** on the dashboard or run the command below; the next poll (default about 5 s) picks it up.

  ```sh
  node .agents/aidlc/scripts/state.mjs task status <task-id> --status active   # or: loop-entry.mjs resume-task <task-id> .
  ```

- `aidlc-kit loop resume` and `loop-entry.mjs resume` fail closed with `loop resume is removed; the daemon auto-resumes actionable tasks — run 'loop start', and re-activate a paused task from the dashboard (resume) or with the task status command`.

## Follow the streaming log

Progress goes to **stderr** (stdout stays the final JSON):

```
━━ turn 1 · phase clarify · agent opencode ━━
  › tool: grep
  › tool: read
  › command completed (exit 0)
<stream text from the lead>
━━ turn done ━━
```

A clarify or plan turn can take minutes without output. At a gate the daemon prints the **gate view** and moves on. Every event carries its `taskId`:

| Event | Meaning |
| --- | --- |
| `turn_start` / `turn_end` | Turn boundary, with phase and agent. |
| `agent_text` | Lead text, capped at 4096 characters per chunk. |
| `agent_tool` | Tool in use (`grep`, `read`, `glob`, `shell`, …). |
| `lifecycle_command` | Shell result and exit code. |
| `gate` | Gate view. |
| `daemon_start`, `daemon_poll`, `daemon_turn`, `loop_stopped` | Daemon lifecycle. |
| `daemon_poll_error` | The task list could not be read; the daemon keeps polling. |
| `daemon_turn_error` | A task run threw (or ended `blocked`/`reconcile`); retried with exponential backoff (poll interval doubled per failure, capped at 10 minutes). |
| `build_deferred` | A ready build item held for a later batch. `reason`: overlaps another item, busy path held by an active assignment, unresolved assignment, or `capacity` (one item per configured worker per batch). |

## Use the web dashboard

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit ui .   # loop.sh up starts the same dashboard
```

Branded **Loop**, binds `127.0.0.1:4173` by default and prints `Open: http://127.0.0.1:4173` (or pass `--open`).

**Access**

- There is no login or session token: the dashboard is for a trusted local machine or internal network. Mutating actions (new task, resume, gate feedback, gate approve) work right away from the page.
- Another origin, a foreign `Host` header, or a request that does not look like the dashboard's own `fetch` gets `403` ([Dashboard access](./command-reference.md#dashboard-access)). Binding to a non-loopback address prints a warning that the dashboard has no authentication.

**Header and updates**

- Header: authority (`authority · local`), daemon state, and a bell listing tasks needing review. The daemon pill turns amber (**daemon · N errors**) while a turn or poll keeps failing; hover for messages.
- Pages poll about every 1.5 s and patch only what changed. An unreachable server shows a **reconnecting…** pill and polling backs off.
- A new gate updates the bell, the tab title (`(2) Loop`), and a **Review needed** toast; with **Settings → notifications** on, a browser notification too (permission is asked only then).
- Light/dark follows the system unless pinned in **Settings**. Shortcuts: <kbd>N</kbd> new task, <kbd>/</kbd> search, <kbd>Esc</kbd> close.

**Where things live**

| Where | What |
| --- | --- |
| Header bell | Tasks waiting at a gate (5 newest; **Load more**). A `blocked_on_user` card shows **review**, which opens the detail page. |
| Card | Title only (id on hover and in search). Click opens the side panel and adds `?task=<task-id>` to the URL (or the full page, per **Settings**); ctrl/cmd/middle-click opens the full page in a new tab, shift-click in this tab. |
| Side panel | Stepper (clarify → plan → build → wrap → done), artifacts, last 20 important log lines, a copy button for the id, **Open full page ↗**; at a gate, **Open review →**. |
| Detail page `/tasks/<task-id>` | The only place with gate approval and feedback; containers, full live log — the one place to follow everything a task does. |
| Settings (header ⚙) | Browser-only preferences: theme, live-update interval or pause, browser notifications for reviews, live log defaults, diff wrap / ignore whitespace, container log tail size, card click target. **Reset to defaults** restores them. |
| Containers (detail page) | Every worker container the loop ran for the task (local or fleet; same layout), newest first: worker, item, turn, `running` / `exited <code>` / `signal`, start time and duration, host when recorded elsewhere. **Log** opens the raw output of that assignment (all turns, stdout and stderr unredacted) with **Follow** while it runs; the tail size comes from Settings. `docker · unavailable` means the state comes from the index only. |
| Review panel (while `blocked_on_user`) | **Feedback** textarea + **Send feedback (stay at gate)**; **Approve** note + **✓ Approve** (popup; only **Confirm approve** sends). |
| Approve semantics | The note is audit provenance, never feedback. A moved gate is refused with `409`. After feedback a **feedback pending** pill shows until approval; failing structural checks replace the gate view. |
| New task (side panel) | Markdown editor. **Create task** runs loop intake and starts the daemon if none runs (stderr → `.agents/data/loop/daemon.log`); a toast shows the id or the intake error. |
| Search and filters | Browser-only; never call the API. The **done** column shows 8 recent tasks; **Show N more** expands it. |
| resume | On `paused` tasks; sets them back to `active`. |
| Live log (detail page) | Lines `time · actor · what happened`, grouped by turn. **Important** (default) hides bookkeeping, **All** shows everything, **Raw JSON** shows the events. |
| Changes `/tasks/<id>/changes` | Files and diff per work item from the commits workers recorded; otherwise the task range from the task's `baseCommit` to its `finalCommit` (or `HEAD` plus the working tree while open) — so a task driven from the terminal, or a finished task whose worker worktrees are gone, still shows its changes; last resort, the uncommitted working tree. **Wrap lines** and **Ignore whitespace** toggles. |

Live log files: the log replays the last 200 events of `.agents/data/tasks/<task-id>/runtime/events.jsonl` (1 MiB, one `.1` generation; a file an older version left in `.agents/data/loop/events/` is read until `loop migrate-data` moves it), then follows live; older tasks fall back to the global `.agents/data/loop/ui-events.jsonl` (rotated to `.jsonl.1` at 5 MB), written only when `AIDLC_LOOP_EVENT_LOG` points at it. Container output is separate: `.agents/data/tasks/<task-id>/runtime/workers/<assignment>.log` (5 MiB, one `.log.1` generation) next to `index.json`, never committed. **Docs** in the header opens these guides.

## Worker Docker image

The build phase runs workers in Docker containers whose image contains the provider CLI (`opencode`, `codex`, or `claude`):

- Dockerfiles ship with the package (`assets/aidlc/docker/Dockerfile.<provider>`); the supervisor **auto-builds** a missing image before preflight and records the name in `.agents/config.json` (`loop.workerImage`), so `AIDLC_WORKER_DOCKER_IMAGE` is not needed.
- Build ahead of time (default provider `opencode`; default tag `aidlc-worker-<provider>:local`):

  ```sh
  npx @felixdotgo/aidlc-kit loop worker-image --provider opencode   # or codex | claude
  ```

- Images named `aidlc-worker-*-test:local` contain only a fake CLI for tests. The real image is `node:24-bookworm-slim` (Debian/glibc, because `opencode` is a dynamically linked ELF) with the CLI from `npm install -g`.
- Each worker container is started with labels `aidlc.task`, `aidlc.item`, `aidlc.worker`, and `aidlc.assignment` (`docker ps --filter label=aidlc.task=<task-id>` lists a task's workers), and its stdout/stderr are teed unredacted into the task's `runtime/workers/` log while the live log keeps only summaries.
- The container runs non-root and `--read-only`, so the CLI must be on the system `PATH` (npm global → `/usr/local/bin`). `opencode` uses `@opencode/cli` (OpenCode 2), **not** `opencode-ai` (OpenCode 1).
- Worker credentials come from the environment, per model: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENCODE_API_KEY`. Preflight runs `docker run … --entrypoint <cli> --version`; a missing or invalid binary fails before any worker starts.

## Quick lead-only run

A single lead with no Docker or workers, using the installed loop runner directly:

```sh
export AIDLC_OPENCODE_MODEL=<provider/model>

node .agents/aidlc/scripts/loop.mjs run <task-id> --agent opencode --max-turns 12 --root .
node .agents/aidlc/scripts/loop.mjs status <task-id> --root .
node .agents/aidlc/scripts/loop.mjs resume <task-id> --root .
```

The JSON output reports `status` (`gate`, `paused`, `blocked`, or `complete`) with `stopReason` and `nextAction`.

## Troubleshooting

- [Loop stops, pauses, or never starts](./troubleshooting.md#loop-stops-pauses-or-never-starts)
- [Dashboard live log or actions do nothing](./troubleshooting.md#dashboard-live-log-or-actions-do-nothing)
- [Loop leases, locks and claims](./troubleshooting.md#loop-leases-locks-and-claims) — "already running", unapprovable gate, stuck claims
- [Build items deferred](./troubleshooting.md#build-items-deferred-or-build-dispatch-failure-unresolved-assignment) — `build_deferred`, `build dispatch failure`

## Related

- [Loop setup runbook](./loop-runbook.md) — enabling and configuring the loop.
- [Configuration](./configuration.md#optional-loop-configuration) — `loop.*` fields.
- [Command reference](./command-reference.md#loop) — all loop flags and environment variables.
- [AI-DLC Coordination service](./coordination-service.md) — fleet (multi-machine) deployment.
