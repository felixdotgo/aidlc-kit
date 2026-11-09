# Command reference

Lookup reference for every `aidlc-kit` command, flag, and loop environment variable, plus the lifecycle scripts installed into a project. Concepts: [Operating the workflow](./operating-workflow.md); `.agents/config.json` fields: [Configuration](./configuration.md).

- All commands operate on local files. Examples run version `0.3.0` through npm (`npx` may ask to fetch the package once); replace `.` with the target project path. Source checkout: [development guide](./development.md).
- Global flags: `--version` (`-v`) prints the package version and exits; `--help` prints usage.

Contents:

- [`init`](#init) — install the workflow into a project.
- [`status`](#status) — report the installed version.
- [`doctor`](#doctor) — check manifest, configuration, and state.
- [`profile validate`](#profile-validate) — print the resolved profile chain.
- [`uninstall`](#uninstall) — remove managed assets.
- [`mcp setup`](#mcp-setup) — configure the optional coordination service.
- [`upgrade`](#upgrade) — human-only package upgrade.
- [`loop`](#loop) — run and inspect the end-to-end loop daemon.
- [`ui`](#ui) — web dashboard.
- [Installed lifecycle scripts](#installed-lifecycle-scripts) — `state.mjs`, `task-next.mjs`, `loop.mjs`, and fleet scripts inside the project.

## `init`

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit init [path] [--agent <name[,name]> | --all] [--loop-mode off|local|fleet] [--loop-lead codex|claude|opencode] [--loop-workers <id=provider,...>] [--yes] [--dry-run] [--force]
```

- Prints a preview and writes only after confirmation (or `--yes`); `--dry-run` prints the plan without writing.
- One detected agent is selected automatically. Interactive terminals get a checkbox prompt (arrows move, Space toggles, A toggles all, Enter confirms); scripts pass `--agent <name[,name]>` or `--all`.
- Interactive setup asks for a loop mode and providers. Non-interactive: omit loop options to keep `off`, or pass `--loop-mode local|fleet` with `--loop-lead` and `--loop-workers` (for example `--loop-workers a=codex,b=opencode`). This only configures the loop; `aidlc-kit loop start` starts it.
- Loop and coordination flags are experimental ([Status and stability](./loop-runbook.md#status-and-stability)).
- `--force` replaces an unmanaged conflicting file on an intentional initial install only; it is not an upgrade mechanism. Another installed package version needs the human-run upgrade.

## `status`

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit status [path] [--json]
```

- Reports the installed version and local installation status; never queries a registry.
- `--json` prints `workflow`, `installedVersion`, `schema`, `detectedAgents`.

## `doctor`

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit doctor [path] [--strict] [--json]
```

- Checks the local manifest, configuration, and canonical state; never queries a registry.
- `--strict` turns compatibility warnings (for example a legacy manifest) into errors.
- `--json` prints `{level, message, strict}`; an `error` level exits non-zero.

## `profile validate`

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit profile validate [path]
```

- Resolves the `.agents/config.json` profile chain and prints the effective order. Run it after changing `extends` or local profiles.

## `uninstall`

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit uninstall [path] [--yes] [--dry-run]
```

- Prints the removal plan, then removes eligible unchanged managed assets; project configuration and state are preserved. Run `--dry-run` first in an existing project.

## `mcp setup`

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit mcp setup [path] [--dry-run] [--yes] [--storage sqlite|postgres] [--deployment docker|remote] [--bind localhost|network] [--workspace <id>] [--poll-ms <n>] [--token-env <name>] [--providers <p,...>] [--enable]
```

- Previews the coordination service configuration and writes only after confirmation. Non-interactive use requires `--deployment`, `--storage`, `--bind`, and `--workspace`.
- Never starts Docker; `--enable` is explicit; remote mode has no local fallback. Deployment and credentials: [AI-DLC Coordination service](./coordination-service.md).
- `--token-env <name>` overrides the default `AIDLC_MCP_TOKEN` variable name in the generated compose file.
- `--providers <p,...>` selects connectors non-interactively: `jira`, `trello`, `github-issues`.

## `upgrade`

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit upgrade [path] [--loop-mode off|local|fleet] [--loop-lead codex|claude|opencode] [--loop-workers <id=provider,...>] [--dry-run]
```

- Human-only: rejects `--yes` and `--force`, requires an interactive terminal and an exact typed confirmation of the package version (same styled prompt as `init`). Agents must never run, preview, detect, or suggest upgrades.
- An omitted loop selection preserves the existing config; an explicit one appears in the preview and in the backup and rollback. Enabling a mode requires a lead and worker mapping.
- Supported legacy `.aidlc/` data is handled transactionally: identical paths are deduplicated, differing content or unsafe entries stop the plan, and an audit backup supports rollback.

## `loop`

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop up [--root PATH] [--loop-env PATH] [--port 4173] [--host 127.0.0.1] [--open] [--no-ui]
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop down|stop [--root PATH] [--now]
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop env [--root PATH] [--loop-env PATH] [--json]
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop status [--root PATH] [--json]
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop start [--root PATH] [--mode local|fleet] [--loop-env PATH]
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop intake [--task-id ID] [--title TITLE] [--root PATH] [--mode local|fleet]
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop status --task-id ID [--root PATH] [--mode local|fleet]
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop worker-image [--provider opencode|codex|claude] [--tag TAG] [--root PATH]
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit loop leases [--task-id ID] [--root PATH] [--json] [--clear-stale]
```

> [!WARNING]
> Experimental, pre-1.0. See [Status and stability](./loop-runbook.md#status-and-stability).

- `--mode` defaults to the configured `loop.mode` and fails closed on a mismatch (`Requested mode does not match configured authority`).
- Every action except `worker-image`, `leases`, and `migrate-data` requires an enabled `loop.mode` with a lead and worker mapping. Local and fleet mode share one daemon and the same actions.

| Action | Behaviour |
| --- | --- |
| `up` | Local mode only. Checks `loop.mode` is `local` (otherwise prints the config to add) and `--port` is valid, runs the `env` report and stops on any error, starts the daemon detached (stderr → `.agents/data/loop/daemon.log`; reports `already running` rather than starting a second; warns when the env file changed after the daemon started), then serves the dashboard in the foreground like `ui`, recording `{ pid, url }` (never the token) in `.agents/data/loop/ui.json`. `Ctrl-C` closes only the dashboard. `--no-ui` starts only the daemon; a recorded dashboard still answering at its URL is reported, not restarted (a stale record is ignored). |
| `down` | Stops the dashboard recorded by `up` — only when its URL answers `GET /api/instance` with the random id in `ui.json`, so another project's dashboard or a reused pid is never signalled — then the daemon (as `stop`). |
| `stop` | One `SIGTERM`: finish the current agent turn and exit, waiting up to 15 s; `--now` sends the second, cancelling the in-flight turn. The requested stage is recorded in `.agents/data/loop/daemon.stop` for that daemon run (pid and start time), so repeating `stop` or `stop --now` never sends the third signal that kills the daemon outright; a terminal `Ctrl-C` on a foreground `loop start` is not counted. An expired lease or a daemon held by another host is never signalled. On Windows the signal ends the process immediately. |
| `env` | Prints what the daemon will see: providers from `loop.agents`, the env file, and each variable with its source (`shell`, `file`, `derived:<path>`) and whether it is set. Only `AIDLC_OPENCODE_MODEL`, `AIDLC_LOOP_EVENT_LOG`, `AIDLC_WORKER_DOCKER_IMAGE`, `AIDLC_LOCAL_WORKTREES_ROOT`, and `AIDLC_ENV_FILE` show their value; others show `set` or `missing`; unreadable config files are reported without quoting content. Exits `1` when the daemon could not start (for example a missing OpenCode model). `--json` prints the same report. |
| `start` | Starts the singleton daemon in the foreground (`daemon` lease in `.agents/data/loop/daemon.lock`, renewed every 15 s; a second `start` fails with `Loop daemon already running (pid N): …` naming the holder). Reads **no** requirement. Fleet `start` preflights the coordination service (`fleet_get`) and the remote integration branch and fails closed instead of falling back to local. |
| `intake` | Creates one loop-owned task without running it. The requirement comes from stdin (interactive prompt on a TTY), at most 8192 bytes; id and title derive from its first line unless `--task-id`/`--title` are given. Local intake refuses while an interactive (non-loop) task is actionable; fleet intake creates the remote task under a short lead claim. Both write `.agents/data/tasks/<id>/runtime/intake.json` (`authority: "local"` or `"fleet"`) and `runtime/requirement.md`. |
| `status` | With `--task-id`: the canonical task and its derived next action, plus the loop run record (local) or the durable gate checkpoint (fleet). Without it: daemon (pid, start time, unresolved errors), dashboard, and the `env` report (`--json` combines them). |
| `leases` | Read-only diagnostic for every loop lease, lock, and claim (daemon lease, `.agents/data/loop/<task>.lease` with `activity`, assignment locks and claims with `effectiveState` from `.agents/data/tasks/<task>/runtime/assignments.*` — and from `.agents/data/loop/assignments/` until migrated — the state lock, leftovers from older versions): state (`live`, `stale`, `expired`, `corrupt`), holder (pid, host, command, activity), heartbeat, expiry, what it blocks, and the fix. With `loop.mode: fleet` and the lead credential (`AIDLC_FLEET_URL`, `AIDLC_FLEET_TOKEN`, `AIDLC_FLEET_WORKSPACE`) it also lists the `fleet_get` supervisor lease, lead lease (`run_claim`, lead epoch; supervisor epoch only when different), and job claims. `--task-id` filters; `--json` is stable (`schemaVersion: 1`); `--clear-stale` removes only stale or TTL-expired corrupt files, never a live holder, a claim, or the state lock. Works with any `loop.mode`; see [Troubleshooting](./troubleshooting.md#loop-leases-locks-and-claims). |
| `migrate-data` | Moves per-task files written by versions before the `runtime/` layout (`.agents/data/loop/assignments/<task>.json`, `loop/events/<task>.jsonl` and `.1`, `loop/<task>.json` run record, `tasks/<task>/loop-intake.json` and `requirement.md`) to `.agents/data/tasks/<task>/runtime/` (`assignments.json`, `events.jsonl`, `run.json`, `intake.json`, `requirement.md`). Idempotent: a file moves only when its destination is absent, an existing destination is reported `skipped` and the source kept; nothing is deleted or overwritten; locks, leases, guards, `<task>.supervisor.json`, and `<task>.gate-receipt.json` stay in `.agents/data/loop/`. `--dry-run` lists without moving; `--json` is stable (`schemaVersion: 1`, `entries[{ taskId, name, from, to, action: moved \| skipped \| would-move, reason? }]`, `moved`, `skipped`). The local daemon runs the same migration once at start (one `diagnostic` event when it moved or skipped anything), and each writer moves its own file before its first write, so running it by hand is optional. Works with any `loop.mode`. |
| `worker-image` | Builds the shipped worker image without loop configuration: `--provider` defaults to `opencode`, `--tag` to `aidlc-worker-<provider>:local`. Runs `docker build` on the packaged `assets/aidlc/docker/Dockerfile.<provider>` and records the tag in `config.loop.workerImage`. |

### Daemon behaviour

- `loop resume` is removed (`loop resume is removed; the daemon auto-resumes actionable tasks — run 'loop start' …`). Re-activate a paused task with the dashboard **resume**, `state.mjs task status <id> --status active` (local), or `loop-entry.mjs resume-task <id> .` (either mode).
- **Ownership.** Only **loop-owned** tasks run: locally, tasks with an intake record or a loop run record; in fleet mode, only tasks whose local intake record says `authority: "fleet"`. Tasks created by an interactive lead are never picked up.
- **Scheduling.** Every `loop.pollMs` (default `5000` ms) the daemon lists actionable loop-owned tasks and runs one bounded supervised run per task in round-robin order (bounded by `loop.limits.maxTurns`).
- **Retries.** A run that throws, or ends `blocked` or `reconcile`, is retried with exponential backoff (poll interval doubled per failure, capped at 10 minutes). A gate wait or completion does not stop the daemon; an unreachable authority is reported as `daemon_poll_error` and retried next poll.
- **Fleet gates.** A fleet run returns at a gate (`gate`/`waiting`) and releases the supervisor lease; after reviewer approval the next poll re-claims the task.
- **Shutdown.** First `SIGINT`/`SIGTERM` stops after the current turn, second cancels the in-flight turn (and any build worker batch), third exits immediately. A terminal `Ctrl-C` also reaches the agent child, so the turn usually ends on the first press. Stopped runs are recorded `stopped` (not paused) and continue on the next `start`.
- **Events.** Events go to stderr with their `taskId` and are appended to the JSONL file named by `AIDLC_LOOP_EVENT_LOG` when set. Daemon events: `daemon_start`, `daemon_poll`, `daemon_poll_error`, `daemon_turn`, `daemon_turn_error`, `build_deferred` (a ready build item waiting for a later batch), `gate`, `loop_stopped`.

### Loop environment (local mode)

`loop start`/`up` and a dashboard-started daemon resolve the environment in this order:

1. **The invoking shell** — an exported variable is never overridden, even when empty.
2. **The env file** — `AIDLC_ENV_FILE` (relative to the project root) or `--loop-env PATH` (relative to the current directory), default `.agents/loop.env`. Minimal dotenv: `KEY=VALUE`, optional `export `, `#` comments, quotes, no variable expansion. Values act like shell exports and reach the lead and the workers.
3. **Values derived from the configured providers only:**

| Variable | Derived from |
| --- | --- |
| `AIDLC_LOOP_EVENT_LOG` | `.agents/data/loop/ui-events.jsonl` |
| `AIDLC_OPENCODE_MODEL` | `model` of the OpenCode config (project `opencode.json[c]` over `OPENCODE_CONFIG` over `~/.config/opencode`) |
| OpenCode worker keys | API-key entries in `~/.local/share/opencode/auth.json` |
| Codex worker key | `$CODEX_HOME/auth.json` (`OPENAI_API_KEY`; a ChatGPT-only login produces a warning) |
| Claude Code worker key | `env.ANTHROPIC_API_KEY` in `.claude/settings.local.json`, `.claude/settings.json`, or `~/.claude/settings.json` |

- Detected worker keys reach the Docker workers only; host lead turns do not receive them (`AIDLC_LEAD_ENV_EXCLUDE`), so a `claude` or `codex` lead keeps its own login.
- **Errors (daemon does not start):** a missing or invalid OpenCode model, an explicit env file that does not exist, or a malformed env file.
- **Warnings:** a missing worker key, a missing `docker`, or an env file that `git check-ignore` would not ignore.
- The option is `--loop-env`, not `--env-file` (Node.js reserves `--env-file`). Fleet mode does not read the env file.
- Optional overrides: `AIDLC_WORKER_DOCKER_IMAGE` (single worker image instead of the per-provider default) and `AIDLC_LOCAL_WORKTREES_ROOT` (worker worktrees root; default a system temp directory; must be outside the integration checkout).
- Local mode requires Docker plus provider credentials. The worker image is auto-built on first dispatch and its tag recorded; `AIDLC_WORKER_DOCKER_IMAGE` only overrides the default.
- Local approval: the trusted host terminal command `node .agents/aidlc/scripts/loop-gate.mjs <task-id>` (refuses piped input) or the dashboard.

### Launchers (loop.sh / loop.cmd)

`init` and `upgrade` install `.agents/aidlc/scripts/loop.sh` (executable) and `loop.cmd` for every loop mode, plus `.agents/loop.env` (commented template) and `.agents/.gitignore` (`loop.env`) when missing; all are project-owned and never overwritten.

| Launcher command | Runs |
| --- | --- |
| `up` (default) | `aidlc-kit loop up` |
| `down` | `aidlc-kit loop down` |
| `stop` | `aidlc-kit loop stop` |
| `status` | `aidlc-kit loop status` |
| `check` | `aidlc-kit loop env` |
| `logs` | follows `.agents/data/loop/daemon.log` |

Each forwarded command runs with `--root` set to the project. CLI lookup order (never installs anything):

1. The project's `node_modules/.bin`.
2. The CLI that last applied `init`/`upgrade`, recorded as `{ cli, version, recordedAt }` in machine-local `.agents/data/loop/cli.json` (not in the manifest) while that file exists; covers `npx --package` and `.tgz` installs that `npx --no-install @felixdotgo/aidlc-kit` cannot find.
3. `aidlc-kit` on `PATH`.
4. `npx --no-install`.

### Fleet environment

| Variable | Requirement |
| --- | --- |
| `AIDLC_FLEET_URL`, `AIDLC_FLEET_WORKSPACE` | Required. |
| `AIDLC_FLEET_TOKEN` | Required: the lead credential. |
| `AIDLC_FLEET_INTEGRATION_BRANCH` | Required. |
| `AIDLC_FLEET_GIT_REMOTE` | Optional. |
| `AIDLC_FLEET_PROJECT_ROOT`, `AIDLC_FLEET_WORKER_IDS`, `AIDLC_FLEET_WORKER_PROVIDERS`, lead agent | Derived by the facade from the root and `loop.agents`; explicitly set values must match. |
| `AIDLC_FLEET_MAX_TURNS`, `AIDLC_FLEET_TURN_TIMEOUT_MS`, `AIDLC_FLEET_MAX_STALL_TURNS`, `AIDLC_FLEET_POLL_MS` | Optional overrides. `loop.limits` (`maxTurns`, `turnTimeoutMs`, `maxStallTurns`) and `loop.pollMs` are the fleet defaults; an explicit value overrides them. |
| `AIDLC_FLEET_REVIEWER_TOKEN` | Never given to lead and worker processes. |

Fleet workers run through the fleet runner on each worker machine; a reviewer approves gates with the reviewer credential ([Coordination service](./coordination-service.md)).

### Loop entry script (`loop-entry.mjs`)

- `loop-entry.mjs` is the single entry point behind the CLI and the dashboard. Positional form: `loop-entry.mjs <action> [task-id] [root] [mode] [provider] [tag] [title]`, for example `echo "<requirement>" | node .agents/aidlc/scripts/loop-entry.mjs intake "" .`.
- Diagnostic form: `loop-entry.mjs leases [task-id] [root] [--json] [--clear-stale]` (an empty task id lists every task).
- Extra actions: `resume-task <id>` (both modes) and the fleet-only dashboard JSON actions `tasks`, `task <id>`, `gate <id>` (current review snapshot with its checkpoint), `approve <id>`, `feedback <id>`. A local dashboard reads local state in-process, so these fail in local mode.
- `approve <id>` reads the approval source on stdin; the reviewer credential comes only from that process's `AIDLC_FLEET_REVIEWER_TOKEN`.
- `feedback <id>` reads stdin JSON `{"reason":"<feedback>","source":"<provenance>"}` and keeps the task at its gate via `remote-state.mjs task status <id> --status active --mode audited` under the lead claim; it never needs the reviewer credential.

## `ui`

```sh
npx --package @felixdotgo/aidlc-kit@0.3.0 aidlc-kit ui [path] [--port 4173] [--host 127.0.0.1] [--open] [--reviewer-token-file PATH]
```

- Web dashboard on `node:http` (no extra dependencies). The project is the positional `path` (default `.`); there is no `--root` flag.
- Authority comes from `loop.mode` (header: `authority · local` or `authority · fleet`). Local dashboards read canonical state in-process; fleet dashboards read tasks, details, and gate snapshots through the `loop-entry.mjs` JSON actions.
- Dashboard usage (board, side panel, live log, containers, changes, settings, feedback): [Local loop walkthrough](./loop-local-run.md#use-the-web-dashboard).
- No session token: the dashboard is meant for a trusted local or LAN network and relies on request-shape guards ([Dashboard access](#dashboard-access)).

| Flag | Effect |
| --- | --- |
| `--port`, `--host` | Bind address; defaults to `127.0.0.1:4173`. Pass `--host 0.0.0.0` only as an explicit opt-in; a non-loopback bind prints `Warning: the dashboard has no authentication; expose it only on a trusted network.` |
| `--open` | Launches the system browser with the dashboard URL (best effort; the URL is printed anyway). |
| `--reviewer-token-file PATH` | Fleet only: reads the reviewer credential from `PATH` (same file rules, never created). `AIDLC_FLEET_REVIEWER_TOKEN` in the `ui` environment works the same way. |

### Routes

- `GET /` — kanban board by `phase` with list toggle, **Settings**, and **New task**; `/?task=<id>` opens the task side panel.
- `GET /docs[/<slug>]` — the packaged guides; only whitelisted slugs are served (`404` otherwise).
- `POST /api/markdown` (field `markdown`) — `{ ok, html }` from the same escaping renderer as task artifacts.
- `GET /tasks/:id` — detail page (stepper, gate view or fleet snapshot text, rendered `intent`/`design`/`workplan`, decisions, items, **Containers**, evidence, live log). `GET /partial/tasks/:id` — the same body as an HTML fragment for the side panel (last 20 important log lines).
- `GET /tasks/:id/changes[?item=<item-id>][&ws=ignore]` — code changes (file list with +/− counts and status badges, unified diff) for the whole task or one item. **Wrap lines** and **Ignore whitespace** toggles on the page mirror the `diffWrap`/`diffIgnoreWs` settings.
- `GET /api/tasks/:id/changes[?item=][&ws=ignore]` — the same data: `{ ok, source, items: [{ itemId, workerId?, commit, base?, workingTree?, files: [{ path, oldPath?, status, added, removed, binary, whitespaceOnly? }], patch, truncated, note? }], note? }`. `ws=ignore` diffs with `git diff -w` for that request (whitespace-only files stay listed with `whitespaceOnly: true` and no patch section); any other `ws` value is `400`.
  - One source order for every mode: **fleet** (fleet only) — the current gate snapshot's `integrationCommit` diffed against its first parent; **assignments** (local) — `.agents/data/tasks/<task>/runtime/assignments.json` (or the pre-runtime `.agents/data/loop/assignments/<task>.json` until migrated), per item the latest reported/integrated attempt, preferring its `integrationCommit`, else `baseCommit..commit`; **task-range** (any mode, when the task state carries `baseCommit`) — one item `task` diffing `baseCommit..finalCommit` for a `done` task, or `baseCommit..HEAD` plus the working tree (`workingTree: true`) while the task is open; **working-tree** — `git diff HEAD` plus untracked files, labelled uncommitted and not task-scoped.
  - `task-range` is what makes changes durable: it needs only two SHAs recorded in the canonical task state ([Installed lifecycle scripts](#installed-lifecycle-scripts)), so it works for tasks driven from a terminal without the loop and after worker worktrees are gone. Its note says the range may include commits made outside the task. Assignments fall through to it when none of their commits is in the local repository; a fleet snapshot without an integration commit does the same. Outside a Git repository `source` is `none`.
  - Only task and item ids come from the URL; commits come from records, are validated as hex SHAs and resolved with `git rev-parse`; Git runs without a shell.
  - Limits: 300 files and 1 MiB of patch per item (`truncated: true` beyond), 4 MiB of patch per whole-task view; further items list files only and load their diff on selection.
  - A recorded integration commit missing locally falls back to the worker commit; a commit missing entirely is a note, not an error.
- `GET /api/tasks/:id/containers` — worker containers recorded for the task: `{ ok, docker: "ok" | "unavailable", host, containers: [{ name, assignmentId, itemId, workerId, agent, mode, host, turn, startedAt, endedAt?, exitCode?, log, running, local }] }`, read from `.agents/data/tasks/<id>/runtime/workers/index.json` (same file in local and fleet mode; empty for tasks the loop never built). `running` combines the index with `docker ps --filter label=aidlc.task=<id>` (no shell, 4 s timeout, result shared for 1.5 s); without Docker the state falls back to the index and `docker` is `unavailable`. `local` is false for entries another fleet worker host recorded.
- `GET /api/tasks/:id/containers/:assignment/log[?tail=<bytes>]` — the raw container output of one assignment as `text/plain` (default tail 64 KiB, max 1 MiB, cut at a line boundary and prefixed with `… (earlier output truncated)`; headers `x-aidlc-log-size`, `x-aidlc-log-truncated`). Serves `<assignment>.log.1` when the current generation is missing. The file holds every turn's stdout and stderr unredacted between `--- turn N container <name> <time> ---` / `--- end turn … ---` lines; it never leaves the host.
- `GET /api/live?known=<region>:<hash>,…[&task=<id>][&drawer=<id>][&notify=<n>]` — in-place updates. Regions: `notify` (header bell; `notify` items, default 5, max 100), `daemon` (header pill), `board`, `detail` (needs `task`), `drawer` (needs `drawer`).
  - Re-renders the listed regions from one state read and returns `{ regions: { <name>: { hash, html } }, reviews: { count, items } }` with only changed regions; unknown names are ignored.
  - Pages poll about every 1.5 s and morph the HTML in place. In fleet mode reads share a result up to 1 s old instead of spawning `loop-entry.mjs` per request.
- `GET /api/tasks` (`?archive=1`, `?statuses=`, `?query=`, `?limit=`, `?cursor=`) — task summaries; `GET /api/tasks/:id` — one task; `GET /api/tasks/:id/gate` — gate view or fleet snapshot (`409` when not waiting); `GET /api/tasks/:id/artifact/:name` — raw artifact content.
- `GET /api/loop/status?task-id=` — `loop status` as JSON.
- `POST /api/loop/start` (field `requirement`) — loop intake, starting the daemon if none runs; `201` with `taskId`, `title`, `daemon`; `409` with the intake error.
- `POST /api/loop/resume` (field `taskId`) — re-activates a `paused` task; `409` for any other status.
- `POST /api/gate/approve` (fields `taskId`, `source`, optional `gate` — the gate the reviewer saw; `409` if the task now waits at another) — the atomic `state.mjs gate approve` locally, or the fleet reviewer approval of the current snapshot.
- `POST /api/gate/feedback` (fields `taskId`, `feedback`, optional `source`) — keeps the task at its gate: locally `state.mjs task status <id> --status active --mode audited --reason <feedback> --source <provenance>`, fleet `loop-entry.mjs feedback <id>`; `400` on missing `feedback`, `409` when not at a gate.
- All `POST` routes spawn the installed scripts asynchronously as thin facades; a malformed or non-object JSON body is `400`.
- `GET /api/events[?task-id=]` — SSE loop events: on connect the last 200 matching lines within the most recent 256 KB, then new complete lines; follows rotation/truncation and resumes from `Last-Event-ID`.
  - With `task-id` (must match the task-id pattern, else `400`) it reads `.agents/data/tasks/<task-id>/runtime/events.jsonl` (`.1` generation first; the pre-runtime `.agents/data/loop/events/<task-id>.jsonl` until migrated); ids are `t:<inode>:<offset>` and a full replay is preceded by `event: reset`.
  - Without a history file it filters the global `ui-events.jsonl` by `taskId`. A symlinked per-task file or `events` directory is never followed (falls back to the global file).

### Dashboard access

The dashboard has no session token and no login: it is built for a trusted local machine or internal network. At start the CLI prints `Open: http://127.0.0.1:4173`. What still guards it:

- A `Host` header that does not name the bound address is rejected `403` (any loopback name — `127.0.0.1`, `localhost`, `[::1]` — is accepted when bound to loopback). A wildcard bind (`0.0.0.0`, `::`) cannot pin the Host and relies on the request-shape checks below.
- Every request other than `GET`/`HEAD`/`OPTIONS` must have the shape of a same-origin `fetch` from the dashboard page: an `Origin` header equal to the dashboard's own origin, `Sec-Fetch-Site` (when the browser sends it) of `same-origin` or `none`, and the custom header `x-aidlc-request`. Any missing or foreign value is `403`; the dashboard scripts send all three.
- In fleet mode `POST /api/gate/approve` returns `403` unless the UI holds a reviewer credential (`AIDLC_FLEET_REVIEWER_TOKEN` or `--reviewer-token-file`); without one the detail page shows the `remote-state.mjs gate inbox` / `gate approve` reviewer commands instead. The credential goes only to that one approve child process. `POST /api/gate/feedback` never needs it.
- The daemon and every other child process the UI spawns never inherit the reviewer credential.

Why (a browser sends requests to `127.0.0.1` on behalf of any web page):

- A cross-site form post cannot set a custom header or forge `Origin`, and a `fetch` with a custom header triggers a CORS preflight the dashboard never answers, so another page cannot create tasks or approve gates (CSRF). The Host check defeats DNS rebinding on a pinned bind; on a wildcard bind only IP-literal or `localhost` Host values are accepted, so a rebound DNS name is still refused.
- Residual risk: anyone who can reach the port can read and act; keep the default loopback bind unless the network is trusted, and remember that the reviewer credential (fleet) is the only secret the dashboard holds.

### Operational notes

- The gate panel renders only on `/tasks/:id` while the task is `blocked_on_user`. Feedback records `Cancelled gate wait at <gate>: <feedback>`, sets the task `active` at the same gate, and the loop re-presents the revised artifact, exactly like `loop-gate.mjs` feedback; approval is never blocked by pending feedback.
- Live log events carry optional `actor` (`lead` or a worker id), `phase`, `itemId`, and a redacted `summary` (at most 240 characters; command output is never logged in the event stream — the raw per-container output lives only in the task's `runtime/workers/` log files). The **Important**/**All**/**Raw JSON** choice is kept in `localStorage` (`aidlc-live-log`); its default comes from **Settings**.
- **Settings** (header ⚙) are browser-only, kept in `localStorage` (`aidlc-settings`) and applied immediately: theme (system/light/dark), live-update interval (1.5 s, 3 s, paused), browser notifications when a task starts waiting for review, live log default filter and Raw JSON, diff wrap and ignore-whitespace, container log tail size (64/256/1024 KiB), and whether a card click opens the side panel or the full page. Nothing is stored server-side.
- **Task runtime data:** every per-task operational file lives under `.agents/data/tasks/<task-id>/runtime/`: `assignments.json`/`assignments.lock` (local worker claims), `events.jsonl` (+ `.1`, the task's event history), `run.json` (loop run record), `intake.json` and `requirement.md` (loop intake), and `workers/index.json` plus `workers/<assignment>.log` (5 MiB with one `.log.1` generation). The task directory root keeps only review artifacts. `runtime/` is treated like `.agents/data/loop/`: never part of a commit, handoff, or clean check, and listed in the installer's `.agents/.gitignore` (`data/loop/`, `data/tasks/*/runtime/`). The same layout serves the no-loop workflow, the local loop, and fleet (fleet claims live in the service; the lead host writes events, run record, and intake; worker hosts write `workers/`); without the loop only the files an interactive lead needs exist. Files from older versions: `migrate-data` above.
- Event files: every event goes to `.agents/data/loop/ui-events.jsonl` (rotated to `.jsonl.1` at 5 MB; feeds the daemon health banner), every task event also to `.agents/data/tasks/<task-id>/runtime/events.jsonl` (rotated to `.1` at 1 MiB; written only when the global file is the standard `<root>/.agents/data/loop/` sidecar, so the task is known). `daemon_poll` is written only when the actionable set, back-off set, or error state changes.
- Every local daemon (`loop up`, `loop start`, **New task**) sets `AIDLC_LOOP_EVENT_LOG` to the global file unless the shell does; `loop up` and **New task** daemons write stderr to `.agents/data/loop/daemon.log`.
- **Exposure:** every route relies on the bind address, the Host check, and the request-shape guards above. `--host 0.0.0.0` lets anyone reaching the port read task diffs, artifacts, container logs, and repository changes, and act on gates.
- **resume** appears only on `paused` tasks and runs the re-activation command for the mode; the daemon picks a loop-owned task up on its next poll.

## Installed lifecycle scripts

After `init`, lifecycle commands live in the target project, not in the package CLI:

```sh
node .agents/aidlc/scripts/state.mjs task list --limit 20
node .agents/aidlc/scripts/state.mjs task find --query "<words>" --include-archive
node .agents/aidlc/scripts/state.mjs task show <task-id>
node .agents/aidlc/scripts/state.mjs task next <task-id>
node .agents/aidlc/scripts/state.mjs task ready <task-id>
node .agents/aidlc/scripts/state.mjs feature create <feature-id> --branch <integration-branch>
node .agents/aidlc/scripts/state.mjs feature link <feature-id> <task-id> [--depends-on <task-id,...>]
node .agents/aidlc/scripts/state.mjs feature ready <feature-id>
node .agents/aidlc/scripts/task-next.mjs <task-id> --require-stop
node .agents/aidlc/scripts/gate-view.mjs <task-id>
```

### Unattended runner (`loop.mjs`)

The interactive loop runs in the current Codex, Claude Code, or OpenCode conversation; `loop.mjs` runs one task unattended from the CLI:

```sh
node .agents/aidlc/scripts/loop.mjs run <task-id> --agent codex|claude|opencode [--max-turns N] [--turn-timeout-ms N] [--max-stall-turns N] [--root PATH]
node .agents/aidlc/scripts/loop.mjs resume <task-id> [--max-turns N] [--turn-timeout-ms N] [--max-stall-turns N] [--root PATH]
node .agents/aidlc/scripts/loop.mjs status <task-id> [--root PATH]
```

- `--agent opencode` requires `AIDLC_OPENCODE_MODEL` in `provider/model[#variant]` form; the turn fails closed without it. OpenCode works for host-executed lead turns and Docker workers, never the container-isolated lead ([Provider credentials and OpenCode](./configuration.md#provider-credentials-and-opencode)).
- **Limits.** Defaults: 12 turns, 10 minutes per turn; two completed turns without observable progress stop the run.
- **Provider.** Each run records its provider; `resume` rejects a different agent. The runner never grants human approval.
- **Lease.** A run holds `.agents/data/loop/<task-id>.lease` with activity `turn`, so `state.mjs gate approve <task-id>` refuses until it stops at the gate. `status` prints `liveLease` (the holder while a turn runs, else `null`) and `lease` (state, holder, activity, expiry, fix).
- **Resuming.** An interactive client resumes by reading `task next` and reconciling local assignment metadata; fleet execution uses fenced service leases and remote canonical state.
- If context preparation fails before a turn starts, the loop pauses with a reason; fix it and `resume`. An interrupted turn with no captured session ID needs inspection of canonical state before recovery.

### Fleet runner and remote state

From the service deployment (a source checkout or the installed `.agents/aidlc-coordination/`), with the lead credential plus `AIDLC_FLEET_WORKER_IDS`, `AIDLC_FLEET_INTEGRATION_BRANCH`, and `AIDLC_FLEET_PROJECT_ROOT`:

```sh
node .agents/aidlc-coordination/src/fleet-run.mjs supervisor <task-id>
node .agents/aidlc-coordination/src/fleet-run.mjs coordinator <task-id> --once
node .agents/aidlc-coordination/src/fleet-run.mjs worker --once
```

- `supervisor` claims the supervisor lease, runs fenced lead turns through the coordinator, publishes each gate snapshot with its checkpoint in one service transaction, waits for reviewer approval, and resumes. It returns at a pause, blocked state, or completion and never approves a gate.
- `coordinator --once` runs one unattended pass without the supervisor lease.
- `worker --once` claims one ready assignment on a worker machine and fails closed without a usable worker image or that machine's worker credential ([image resolution](./coordination-service.md#multi-machine-loop-deployment)).
- `aidlc-kit loop start --mode fleet` runs the same supervisor inside the loop daemon, returning at each gate instead of waiting.

Fleet mode uses `remote-state.mjs` instead of `state.mjs`. Set `AIDLC_FLEET_URL`, `AIDLC_FLEET_WORKSPACE`, and `AIDLC_FLEET_PROJECT_ROOT`; lead mutations also need `AIDLC_FLEET_TOKEN` and the current `AIDLC_FLEET_LEAD_EPOCH`. Claim an epoch before creating or changing a task:

```sh
node .agents/aidlc/scripts/remote-state.mjs run claim <task-id>
node .agents/aidlc/scripts/remote-state.mjs task next <task-id>
node .agents/aidlc/scripts/remote-state.mjs phase context <task-id>
node .agents/aidlc/scripts/remote-state.mjs run release <task-id> --epoch <epoch>
```

- The client covers task items, evidence, decisions, status, audited transitions, wrap lessons, and feature manifests through revision-checked remote mutations. It cannot approve gates with a lead token.
- A connected reviewer uses `gate inbox` and, only after an explicit later user reply, `gate approve <task-id> --snapshot <id> --source <reply>` with `AIDLC_FLEET_REVIEWER_TOKEN`.
- While `AIDLC_FLEET_URL` is set, local lifecycle, context, gate, assignment, and standalone loop commands reject use, so an unattended lead cannot mutate a second local authority. Unset it only when deliberately returning to a local run.

### Options and project root

- Options may appear before or after positionals as `--name value` or `--name=value`. Unknown, duplicate, command-irrelevant, missing-value, and surplus positional arguments are rejected before state I/O.
- Boolean options (`--all`, `--include-archive`, `--require-stop`) take no value. A literal value starting with `--` needs the equals form.
- An explicit `--root <path>` wins and must contain `.agents/`. Otherwise the runtime walks upward to the nearest ancestor containing `.agents/aidlc/`; with no marker it fails without creating local state.
- Manual calls from a nested directory need an absolute or upward-relative script path. Runtime-generated actions always carry an absolute script path and an absolute `--root`.

### Output envelope and exit codes

Every `state.mjs` and `task-next.mjs` command prints one JSON envelope: `{ok: true, result, nextAction?}`.

- **`result`** carries the payload (a mutation nests it as `{task, ...extra}`; a read returns the read object).
- **`nextAction`** is present for every task-scoped command. Task-less commands (`memory list|promote|retire`, `lesson rebuild|search`, `state migrate`, `task list|find`) return none.
- **`warnings`** `[{code, message, hint?}]` may accompany a success when the mutation persisted but a derived step failed: `LESSON_INDEX_STALE` (lesson-index rebuild) or `RENDER_FAILED` (workplan render). The exit code stays `0`; follow the hint, do not retry. The repair commands (`lesson rebuild`, `render.mjs`) and `state migrate` still fail loudly.
- **Failures** print one line `{ok: false, error: {message, hint?}}` on stderr — never a stack trace.
- **Exit codes:** `0` success, `1` expected validation or gate error, `2` continuation guard, `3` unexpected crash.
- Execute `run_phase` actions immediately; a successful mutation is not permission to stop. In build the action includes `itemId`, `remainingItems`, and an item-focused context command while work remains; every embedded command carries an explicit `--root`.

### Continuation guard

- `task-next.mjs --require-stop` prints the current action plus a `continuation` object — `{required, code, taskId, classification}` and, when work remains, `command`, `reason`, `itemId`, `remainingItems` — and exits `2` when the classification is `run_phase`.
- The first stderr line is `CONTINUATION_REQUIRED: {json}` with the same task id, command, and reason, followed by an explicit "expected pause, not a failure" note. The caller must execute `continuation.command` instead of replying.
- It exits normally (`continuation.code = STOP_ALLOWED`) for a valid human gate, durable blocker, terminal outcome, or completion.
- The guard detects at the package boundary and cannot intercept an already-emitted message; hosts recover by running `task next <task-id>` in the next turn and executing its command.
- `task status ... --status blocked_on_user` fails instead of persisting when the current gate is not ready; `gate-view.mjs` renders only tasks already in that validated status.

### Gate approval

Human approval is a dedicated atomic operation. Review steps map to stable `--gate` values: **Confirm requirements** → `G0_confirm`, **Approve plan** → `G1_review`, **Review implementation** → `G2_codereview`. Display labels are always English; task prose may follow the task language.

```sh
node .agents/aidlc/scripts/state.mjs gate approve <task-id> --gate <gate> --source "<explicit approval>"
```

`--source` is audit provenance, not authentication or proof of consent. Invoke it only in a later user turn that explicitly approves the gate currently presented.

### Evidence, status, and transitions

- **Evidence.** `evidence add` accepts `spec`, `test`, `lint`, `review`, and `diagnostic`; it rejects `approval`. `--area` must belong to the task's affected areas; multi-area test or lint evidence must name its area.
- **Status.** `task status` accepts `active`, `blocked_on_user`, and `paused` (`done` is not a status; finish with `task transition --to done` or `task archive`). It rejects `blocked_on_user` at wrap, which has no human gate.
- **Audited exits.** Every route out of a validated `blocked_on_user` wait, including `paused`, requires audited `--reason` and `--source` and appends diagnostic evidence. `active → paused` requires the same `--mode audited --reason --source` triple and appends a `Paused while active` diagnostic; `paused → active` needs no audit metadata.
- **Repair bounds.** The third failed verify record per area, or the second failed review record, in the current build flips `nextAction` to `blocked` and adds a `REPAIR_BOUND` error to the Review implementation gate check.
- **Advancing and finishing.** Phases advance with `gate approve`; wrap completes with `task transition --to done` or `task archive <task-id> --reason "<reason>" --source "<source>"`, which applies the same transition checks and appends an `Archive to done` diagnostic. Both record `finalCommit` (the checkout's `HEAD`, or `--final-commit <sha>`) on the task; `--final-commit` is rejected for any other target phase.
- **Commit tracking.** `baseCommit` (recorded by `task create` from `HEAD`, or `--base-commit <sha>`) and `finalCommit` are optional lowercase hex SHAs in the canonical task state, shared by `state.mjs` and the fleet `remote-state.mjs` and kept in the archive record. The core never runs git; outside a repository the fields stay unset. They let the dashboard rebuild a task's changes from history alone ([`ui` routes](#routes)).

The low-level transition escape hatch is intentionally noisy: it records diagnostic evidence, applies all transition checks, requires audit metadata, and rejects self-transitions:

```sh
node .agents/aidlc/scripts/state.mjs task transition <task-id> --to <phase> --mode audited --reason "<reason>" --source "<source>"
```

### Task creation, features, and item scopes

- **Creation.** `task create` rejects an id that collides case-insensitively with an existing task or archive record. Multiple actionable tasks may coexist; the optional `--switch-from <ids>` acknowledgement (names must be actionable) stamps a resume-marker diagnostic without mutating anything. `--feature <feature-id>` permits sibling tasks in an existing feature.
- **Dependencies.** `feature link` checks membership and task dependencies; `task item ... --depends-on <item-id,...> --owns <path,...>` adds item edges and an optional Git path scope. Missing and cyclic dependencies fail; an item or feature task cannot finish before its prerequisites.
- **Path scopes.** Loop dispatch (local and fleet) requires a nonempty path scope. With `loop.mode` `local` or `fleet`, the Approve plan check fails with `PARTITION_SCOPE` for an open item without `--owns` and `PARTITION_OVERLAP` when two items that can run concurrently (no direct or transitive `--depends-on`) own overlapping paths; with the loop off both are warnings.
- **Overlap rules.** Per path segment: `src` overlaps `src/a.ts` but not `srcx`. Scopes are normalized (trailing slashes stripped), may name a file or a directory, and directory scopes cover every file beneath. The rendered workplan shows `owns: … · after: …` per item.
- **Reopening.** After reopening Approve plan, all non-deferred execution items return to `todo`; prior Review implementation, verification, and review evidence cannot satisfy the new build boundary, and repair-bound counters reset.

### Atomic writes and archives

- State writes and generated workplans use symlink-checked atomic replacement. State-lock release is owner-token checked and never removes a replacement owner's lock.
- A process that stops after writing a terminal archive record but before committing the catalog leaves an orphan; a retry replaces it only when the persisted catalog still holds the same active task identity and references no archive record. Malformed, referenced, or identity-conflicting records fail closed.

### Memory promotion

Promoting an agent-memory candidate requires traceable source records and an explicit approver:

```sh
node .agents/aidlc/scripts/state.mjs memory promote <memory-id> --summary "<summary>" --guidance "<guidance>" --source-task <task-id> --source-lesson <lesson-id> --approved-by "<human>"
```

## Related

- [Operating the workflow](./operating-workflow.md) — gates, approvals, handoffs, and task ownership.
- [Configuration](./configuration.md) — `.agents/config.json`, `loop.*`, `mcp`, and adapter permissions.
- [Loop setup runbook](./loop-runbook.md) — step-by-step loop setup.
- [Troubleshooting](./troubleshooting.md) — error codes and recovery.
