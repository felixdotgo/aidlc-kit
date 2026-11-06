# Command reference

All package commands operate on local files. The examples run version `0.2.0` through npm; `npx` may ask permission to fetch that package on first use. Replace `.` with the target project path when needed. For a source checkout, see the [development guide](./development.md).

Global flags available on every invocation: `--version` (or `-v`) prints the package version and exits; `--help` prints usage.

## `init`

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit init [path] [--agent <name[,name]> | --all] [--loop-mode off|local|fleet] [--loop-lead codex|claude|opencode] [--loop-workers <id=provider,...>] [--yes] [--dry-run] [--force]
```

Plans the installation, prints a preview, and then writes the workflow only after confirmation (or `--yes`). `--dry-run` prints the same plan without writing. If exactly one installed agent is detected, it can be selected automatically. In an interactive terminal, choose multiple agents with the checkbox prompt: use arrow keys to move, Space to toggle, A to toggle all, and Enter to confirm. For scripts and non-interactive terminals, use `--agent <name[,name]>` or `--all`.

In interactive setup, choose a loop mode and, when enabled, the lead and worker providers. For non-interactive setup, omit loop options to keep the default off, or specify `--loop-mode local|fleet` together with `--loop-lead` and `--loop-workers` (for example, `--loop-workers a=codex,b=opencode`). The preview includes the project config change. These settings only configure the loop; run `aidlc-kit loop start` to actually start it. Local loop mode is usable today; fleet mode is still under active development; the loop and the coordination service remain experimental: their flags and defaults may change incompatibly in any release before `1.0.0`.

`--force` is for an intentional initial replacement of an unmanaged conflicting file. It is not an upgrade mechanism. If the project already has another workflow package version, use the human-run upgrade flow instead.

## `status`

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit status [path] [--json]
```

Reports the installed version and local installation status. It does not query a registry. Pass `--json` to print the same data as a JSON object (`workflow`, `installedVersion`, `schema`, `detectedAgents`).

## `doctor`

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit doctor [path] [--strict] [--json]
```

Checks the local manifest, configuration, and canonical state. `--strict` turns compatibility warnings such as a legacy manifest into errors. It does not query a registry. Pass `--json` to print `{level, message, strict}`; an `error` level sets a non-zero exit code.

## `profile validate`

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit profile validate [path]
```

Loads `.agents/config.json`, resolves its profile chain, and prints the effective profile order. Use it after changing `extends` or local profiles.

## `uninstall`

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit uninstall [path] [--yes] [--dry-run]
```

Prints the removal plan before applying it. It removes eligible unchanged managed assets but preserves project configuration and state. Prefer `--dry-run` first when working in an existing project.

## `mcp setup`

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit mcp setup [path] [--dry-run] [--yes] [--storage sqlite|postgres] [--deployment docker|remote] [--bind localhost|network] [--workspace <id>] [--poll-ms <n>] [--token-env <name>] [--providers <p,...>] [--enable]
```

Previews the optional AI-DLC Coordination service configuration, then writes only after confirmation. Non-interactive use requires `--deployment`, `--storage`, `--bind`, and `--workspace`. It never starts Docker; `--enable` is explicit and remote mode has no local fallback. See [AI-DLC Coordination service](./coordination-service.md) for deployment and credential requirements.

`--token-env <name>` overrides the default `AIDLC_MCP_TOKEN` environment variable name used in the generated compose file. `--providers <p,...>` selects project-management connectors non-interactively (`jira`, `trello`, `github-issues`).

## `upgrade`

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit upgrade [path] [--loop-mode off|local|fleet] [--loop-lead codex|claude|opencode] [--loop-workers <id=provider,...>] [--dry-run]
```

Upgrade is deliberately human-only. The command rejects `--yes` and `--force`; applying it requires an interactive terminal and an exact typed confirmation of the package version. Interactive confirmations use the same styled terminal prompt as `init`. Agents must not run, preview, detect, or suggest package upgrades on their own.

An omitted loop selection preserves the existing config; an explicit selection appears in the preview and is included in the upgrade backup and rollback. Enabling a mode requires a lead and worker mapping.

The upgrade plan handles supported legacy `.aidlc/` project data transactionally: identical paths are deduplicated, differing content or unsafe entries stop the plan, and an audit backup supports rollback. Review the preview before an authorised human applies it.

## `loop`

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop start [--root PATH] [--mode local|fleet]
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop intake [--task-id ID] [--title TITLE] [--root PATH] [--mode local|fleet]
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop status --task-id ID [--root PATH] [--mode local|fleet]
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop worker-image [--provider opencode|codex|claude] [--tag TAG] [--root PATH]
```

> [!WARNING]
> **Local loop mode is usable** today; **fleet mode is still under active development**. The loop commands remain **experimental** — because the package is still pre-1.0 (`0.x`), their options, environment variables, and diagnostics can change incompatibly in any release before `1.0.0`.

`--mode` defaults to the configured `loop.mode`; the command fails closed when it does not match (`Requested mode does not match configured authority`). Every action except `worker-image` requires an enabled `loop.mode` with a lead and worker mapping. Local and fleet mode share one daemon and the same actions:

| Action | Behaviour |
| --- | --- |
| `start` | Starts the singleton loop daemon for the project in the foreground (lock `.agents/data/loop/daemon.lock`; a second `start` fails with `Loop daemon already running (pid N)`). It reads **no** requirement. Fleet `start` first preflights the coordination service (`fleet_get`) and the remote integration branch and fails closed instead of falling back to local. |
| `intake` | Creates one loop-owned task without running it. The requirement is read from stdin (an interactive prompt on a TTY), at most 8192 bytes; the id and title are derived from its first line unless `--task-id`/`--title` are given. Local intake refuses while an interactive (non-loop) task is actionable. Fleet intake creates the remote task under a short lead claim. Both write `.agents/data/tasks/<id>/loop-intake.json` (`authority: "local"` or `"fleet"`). |
| `status` | Prints the canonical task and its derived next action; local mode adds the loop run record, fleet mode the durable gate checkpoint. |
| `worker-image` | Builds (or rebuilds) the shipped worker image without requiring loop configuration: `--provider` defaults to `opencode`, `--tag` to `aidlc-worker-<provider>:local`. It runs `docker build` against the packaged `assets/aidlc/docker/Dockerfile.<provider>` and records the tag in `config.loop.workerImage`. |

`loop resume` is removed in both modes; it fails with `loop resume is removed; the daemon auto-resumes actionable tasks — run 'loop start' …`. Re-activate a paused task with the dashboard **resume** button, `state.mjs task status <id> --status active` (local), or `node .agents/aidlc/scripts/loop-entry.mjs resume-task <id> .` (either mode).

The daemon only runs **loop-owned** tasks: locally, tasks with an intake record or a loop run record; in fleet mode, only tasks whose local intake record says `authority: "fleet"`. Tasks created by an interactive lead are never picked up. Every `loop.pollMs` (default `5000` ms) it lists actionable loop-owned tasks and runs one bounded supervised run per task in round-robin order (bounded by the per-run `loop.limits.maxTurns`). A run that throws, or ends `blocked` or `reconcile`, is retried with exponential backoff (poll interval doubled per failure, capped at 10 minutes). A gate wait or completion does not stop the daemon, and an unreachable authority (for example the fleet service) is reported as `daemon_poll_error` and retried on the next poll. In fleet mode a run returns at a gate (`gate`/`waiting`) and releases the supervisor lease; after the reviewer approves, the next poll re-claims the task and continues.

Shutdown is two-stage in both modes: the first `SIGINT`/`SIGTERM` stops after the current turn, the second cancels the in-flight agent turn (and any build worker batch), and the third exits immediately. A terminal `Ctrl-C` also reaches the agent child process, so the in-flight turn usually ends on the first press. Stopped runs are recorded as `stopped` (the task is not paused) and continue on the next `start`. Events go to stderr, carry their `taskId`, and are also appended to the JSONL file named by `AIDLC_LOOP_EVENT_LOG` when set. Daemon events include `daemon_start`, `daemon_poll`, `daemon_poll_error`, `daemon_turn`, `daemon_turn_error`, `build_deferred` (a ready build item waiting for a later batch), `gate`, and `loop_stopped`.

Local mode requires Docker plus the provider credential environment; the worker image is auto-built from the packaged Dockerfile on first dispatch and its tag is recorded automatically, so `AIDLC_WORKER_DOCKER_IMAGE` is only needed to override the default. Local approval happens through the trusted host terminal command `node .agents/aidlc/scripts/loop-gate.mjs <task-id>`, which refuses piped input, or the dashboard.

Fleet mode requires `AIDLC_FLEET_URL`, `AIDLC_FLEET_WORKSPACE`, the lead `AIDLC_FLEET_TOKEN`, and `AIDLC_FLEET_INTEGRATION_BRANCH` (optionally `AIDLC_FLEET_GIT_REMOTE`). The facade derives `AIDLC_FLEET_PROJECT_ROOT`, `AIDLC_FLEET_WORKER_IDS`, `AIDLC_FLEET_WORKER_PROVIDERS`, and the lead agent from the root and `loop.agents`; explicitly set values must match. `loop.limits` (`maxTurns`, `turnTimeoutMs`, `maxStallTurns`) and `loop.pollMs` become the fleet defaults, and an explicit `AIDLC_FLEET_MAX_TURNS`, `AIDLC_FLEET_TURN_TIMEOUT_MS`, `AIDLC_FLEET_MAX_STALL_TURNS`, or `AIDLC_FLEET_POLL_MS` still overrides them. Lead and worker processes never receive `AIDLC_FLEET_REVIEWER_TOKEN`. Fleet workers run separately through the fleet runner on each worker machine, and a reviewer approves gates with the reviewer credential as documented in [Coordination service](./coordination-service.md).

The installed `loop-entry.mjs` is the single entry point behind the CLI and the dashboard. Its positional form is `loop-entry.mjs <action> [task-id] [root] [mode] [provider] [tag] [title]`, for example `echo "<requirement>" | node .agents/aidlc/scripts/loop-entry.mjs intake "" .`. Besides the actions above it accepts `resume-task <id>` (re-activate a paused task, both modes) and the fleet-only dashboard JSON actions `tasks`, `task <id>`, `gate <id>` (current review snapshot with its checkpoint), and `approve <id>` (approval source on stdin; reviewer credential only from that process's `AIDLC_FLEET_REVIEWER_TOKEN`). A local dashboard reads local state in-process, so those read actions fail in local mode.

## `ui`

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit ui [path] [--port 4173] [--host 127.0.0.1] [--open] [--token-file PATH] [--reviewer-token-file PATH]
```

Starts a web dashboard (built on `node:http`, no extra dependencies) for viewing task status and operating the loop without typing CLI commands repeatedly. The project is the positional `path` (default `.`); `ui` has no `--root` flag. The authority comes from `loop.mode`: the header shows `authority · local` or `authority · fleet`. Local dashboards read canonical local state in-process; fleet dashboards read tasks, task details, and gate snapshots (review text from the coordination service) through the `loop-entry.mjs` JSON actions.

| Flag | Effect |
| --- | --- |
| `--port`, `--host` | Bind address; defaults to `127.0.0.1:4173`. Pass `--host 0.0.0.0` only as an explicit opt-in. |
| `--open` | Launches the system browser with the login URL (best effort; the URL is printed anyway). |
| `--token-file PATH` | Uses a fixed session token from `PATH` so the browser stays signed in across restarts. The file must live outside the project, be a regular non-symlink file with mode `600`/`400`, and hold one 16–256 character token; a missing file is created with a random token. |
| `--reviewer-token-file PATH` | Fleet only: reads the reviewer credential from `PATH` (same file rules, never created). `AIDLC_FLEET_REVIEWER_TOKEN` in the `ui` environment works the same way. |

Routes:

- `GET /` renders a **kanban board by default** (columns grouped by `phase`: clarify / plan / build / wrap / done) with a list/table toggle, plus **New task** and **Settings** modals. The page uses the full window width and is branded **Loop**. Clicking a task opens a **side panel** that slides in from the right (`/?task=<id>` opens it directly; Back or <kbd>Esc</kbd> closes it); ctrl/cmd-click or middle-click opens the full detail page.
- `GET /tasks/:id` renders the full task detail page: a horizontal progress stepper, a structured gate view (in fleet mode the review snapshot text), rendered `intent`/`design`/`workplan` artifacts (Markdown), decisions, work items, evidence, details, and a live log stream. `GET /partial/tasks/:id` returns the same detail body as an HTML fragment for the side panel.
- `GET /api/tasks` returns task summaries as JSON (`?archive=1`, `?statuses=`, `?query=`, `?limit=`, `?cursor=`); `GET /api/tasks/:id` returns one task; `GET /api/tasks/:id/gate` returns the gate view or fleet snapshot (`409` when the task is not waiting); `GET /api/tasks/:id/artifact/:name` returns raw artifact content for programmatic clients.
- `GET /api/loop/status?task-id=` returns `loop status` as JSON. `POST /api/loop/start` (field `requirement`) runs loop intake and starts the daemon if none is running (`201` with `taskId`, `title`, `daemon`; `409` with the intake error). `POST /api/loop/resume` (field `taskId`) re-activates a `paused` task (`409` for any other status). `POST /api/gate/approve` (fields `taskId`, `source`) runs the atomic `state.mjs gate approve` locally, or the fleet reviewer approval of the current snapshot. All spawn the installed scripts asynchronously as thin facades; a malformed or non-object JSON body is a `400`.
- `GET /api/events[?task-id=]` streams the event-log sidecar as SSE: on connect the last 200 matching lines within the most recent 256 KB, then new complete lines; it follows rotation/truncation and resumes from `Last-Event-ID`.

### Dashboard authentication

At start the CLI prints a login URL such as `http://127.0.0.1:4173/#token=<token>`. Opening it stores the token in the browser's `localStorage` and strips the fragment from the address bar (a fragment is never sent to the server); **⚙ Settings** still accepts a pasted token. There is no unauthenticated mode. The rules:

- The mutating actions (new task, resume, gate approve) require the token in a header — `x-aidlc-token` or `Authorization: Bearer <token>` — never in a form or JSON body field. A missing or wrong token is `401`.
- Every request whose `Host` header does not name the bound address is rejected `403` (any loopback name — `127.0.0.1`, `localhost`, `[::1]` — is accepted when bound to loopback). A wildcard bind (`0.0.0.0`, `::`) cannot pin the Host and relies on the token and the Origin check.
- A non-`GET` request whose `Origin` is not the dashboard's own origin is rejected `403`.
- In fleet mode, `POST /api/gate/approve` returns `403` unless the UI holds a reviewer credential (`AIDLC_FLEET_REVIEWER_TOKEN` or `--reviewer-token-file`); the detail page then shows the `remote-state.mjs gate inbox` / `gate approve` reviewer commands instead of the approve form. The credential is passed only to that one approve child process.
- The daemon and every other child process the UI spawns never inherit the UI token or the reviewer credential.

These rules exist because a browser will send requests to `127.0.0.1` on behalf of any web page: a header-only token defeats cross-site form posts (CSRF), the Host check defeats DNS rebinding, and keeping tokens out of the daemon environment stops a host-executed lead from approving its own gate. Residual risk: a `--token-file` is readable by any process running as the same user, so prefer the per-session token unless you need restarts to keep the browser signed in.

Operational notes:

- The gate **approve** form renders only on the full task detail page (`/tasks/:id`) while the task is `blocked_on_user`; on the dashboard such a task shows an **approve** button that opens that page. The dashboard header shows whether the daemon is running.
- The **live log** on the detail page is an SSE stream of that task's events over the fixed file `.agents/data/loop/ui-events.jsonl` (rotated to `.jsonl.1` at 5 MB). A daemon started by **New task** gets `AIDLC_LOOP_EVENT_LOG` pointed at that file automatically and writes its stderr to `.agents/data/loop/daemon.log`; a **manually started** daemon must export the same variable, or the live log stays empty (see [Loop local run](./loop-local-run.md#51-set-environment-variables)).
- The dashboard **resume** button appears only on `paused` tasks and sets them back to `active` (locally equivalent to `node .agents/aidlc/scripts/state.mjs task status <id> --status active`; in fleet mode `loop-entry.mjs resume-task`); the daemon then picks the task up on its next poll if it is loop-owned.

## Installed lifecycle scripts

After `init`, task lifecycle commands live in the target project, not in the package CLI:

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

The normal interactive loop runs in the current Codex, Claude Code, or OpenCode conversation, using native agents and the installed lifecycle commands. The optional `loop.mjs` command is for unattended CLI execution:

```sh
node .agents/aidlc/scripts/loop.mjs run <task-id> --agent codex|claude|opencode [--max-turns N] [--turn-timeout-ms N] [--max-stall-turns N] [--root PATH]
node .agents/aidlc/scripts/loop.mjs resume <task-id> [--max-turns N] [--turn-timeout-ms N] [--max-stall-turns N] [--root PATH]
node .agents/aidlc/scripts/loop.mjs status <task-id> [--root PATH]
```

`--agent opencode` requires `AIDLC_OPENCODE_MODEL` in `provider/model[#variant]` form; the turn fails closed without it. The container-isolated lead rejects OpenCode with `OpenCode workers require file-based credentials and are not available in isolated containers yet` and does not fall back to the host. Local Docker worker batches and fleet worker containers accept OpenCode via environment credentials — the key follows the `AIDLC_OPENCODE_MODEL` prefix: `openai/` → `OPENAI_API_KEY`, `anthropic/` → `ANTHROPIC_API_KEY`, otherwise `OPENCODE_API_KEY` — with OpenCode's XDG data/config roots redirected into the worker's ephemeral HOME. Use `loop.mjs run --agent opencode` for host-executed lead turns, or use Codex or Claude Code where an isolated lead is required.

The defaults are 12 turns and 10 minutes per turn; two completed turns without observable progress stop the run. Each run records its provider, and `resume` rejects a different agent. The runner never grants human approval. An interactive client can resume by reading `task next` and reconciling local assignment metadata; fleet execution uses fenced service leases and the remote canonical state.

If context preparation fails before an agent turn starts, the loop pauses with a reason; fix the context problem and use `resume`. An interrupted running turn with no captured session ID still requires inspection of canonical state before recovery.

The fleet runner drives the supervised multi-worker flow against a coordination service. From the service deployment (a source checkout or the installed `.agents/aidlc-coordination/`), with the lead credential plus `AIDLC_FLEET_WORKER_IDS`, `AIDLC_FLEET_INTEGRATION_BRANCH`, and `AIDLC_FLEET_PROJECT_ROOT` set:

```sh
node .agents/aidlc-coordination/src/fleet-run.mjs supervisor <task-id>
node .agents/aidlc-coordination/src/fleet-run.mjs coordinator <task-id> --once
node .agents/aidlc-coordination/src/fleet-run.mjs worker --once
```

`supervisor` claims the task's supervisor lease, runs fenced lead turns through the coordinator, publishes each gate snapshot with its checkpoint in one service transaction, waits for the reviewer approval, and resumes automatically; it returns at a pause, blocked state, or completion, and never approves a gate. `coordinator --once` runs a single unattended pass without the supervisor lease. `worker --once` claims one ready assignment on a worker machine and fails closed without a usable worker image or that machine's worker credential; see [Coordination service](./coordination-service.md#multi-machine-loop-deployment) for how the image is resolved. `aidlc-kit loop start --mode fleet` runs the same supervisor inside the shared loop daemon in a bounded mode that returns at each gate instead of waiting for the reviewer.

Fleet mode uses `remote-state.mjs` instead of local `state.mjs`. Set `AIDLC_FLEET_URL`, `AIDLC_FLEET_WORKSPACE`, and `AIDLC_FLEET_PROJECT_ROOT`; lead mutations additionally require `AIDLC_FLEET_TOKEN` and the current `AIDLC_FLEET_LEAD_EPOCH`. Claim an epoch before creating or changing a task:

```sh
node .agents/aidlc/scripts/remote-state.mjs run claim <task-id>
node .agents/aidlc/scripts/remote-state.mjs task next <task-id>
node .agents/aidlc/scripts/remote-state.mjs phase context <task-id>
node .agents/aidlc/scripts/remote-state.mjs run release <task-id> --epoch <epoch>
```

The same client supports task items, evidence, decisions, status, audited transitions, wrap lessons, and feature manifests through revision-checked remote mutations. It cannot approve gates with a lead token. A connected reviewer uses `gate inbox` and, only after an explicit later user reply, `gate approve <task-id> --snapshot <id> --source <reply>` with `AIDLC_FLEET_REVIEWER_TOKEN`. See [Coordination service](./coordination-service.md#multi-machine-loop-deployment) for bootstrap, fleet processes, and credentials.
When `AIDLC_FLEET_URL` is set, local lifecycle, context, gate, assignment, and standalone loop commands reject use so an unattended lead cannot accidentally mutate a second local authority. Unset it only when deliberately returning to a local run.

Installed lifecycle options may appear before or after positionals and accept both `--name value` and `--name=value`. Unknown, duplicate, command-irrelevant, missing-value, and surplus positional arguments are rejected before state I/O. Boolean options such as `--all`, `--include-archive`, and `--require-stop` do not accept values. When a literal value begins with `--`, use the equals form so it is not confused with a missing value.

An explicit `--root <path>` wins and must identify a directory containing `.agents/`. Without `--root`, the runtime walks upward from the current working directory and selects the nearest ancestor containing `.agents/aidlc/`. If no installed-workflow marker exists, the command fails without creating local state. Manual calls from a nested directory need an absolute or upward-relative script path so Node can locate the entry point. Runtime-generated actions always include both an absolute script path and an absolute `--root`, so they remain executable from any working directory.

Every `state.mjs` and `task-next.mjs` command prints one JSON envelope: `{ok: true, result, nextAction?}`. `result` carries the command payload (a mutated command nests it as `{task, ...extra}`; a read returns the read object), and `nextAction` is present whenever the command is task-scoped. Task-less commands (`memory list|promote|retire`, `lesson rebuild|search`, `state migrate`, `task list|find`) return no `nextAction`. A success envelope may additionally carry `warnings: [{code, message, hint?}]` when the mutation persisted but a derived step failed afterwards — `LESSON_INDEX_STALE` (lesson-index rebuild) or `RENDER_FAILED` (workplan render); the mutation is committed and the exit code stays `0`, so callers follow the warning hint instead of retrying the mutation, while the explicit repair commands (`lesson rebuild`, `render.mjs`) and `state migrate` still fail loudly. Failures print a one-line `{ok: false, error: {message, hint?}}` on stderr — never a stack trace. Exit codes are typed: `0` success, `1` expected validation or gate error, `2` the continuation guard, `3` an unexpected crash. Callers must execute `run_phase` actions immediately; a successful mutation is not permission to stop. In build, the action includes `itemId`, `remainingItems`, and an item-focused context command while work remains, and every embedded command carries an explicit `--root` so it runs from any working directory.

`task-next.mjs --require-stop` prints the current action plus a machine-readable `continuation` object in the stdout envelope — `{required, code, taskId, classification}` and, when work remains, `command`, `reason`, `itemId`, and `remainingItems` — and exits `2` when the classification is `run_phase`. The first stderr line is `CONTINUATION_REQUIRED: {json}` carrying the same task id, command, and reason (followed by an explicit "expected pause, not a failure" note); it is a local guard against a premature final response, and the caller must execute `continuation.command` instead of replying. It exits normally (`continuation.code = STOP_ALLOWED`) for a valid human gate, durable blocker, terminal outcome, or completion. The guard is detection at the package boundary: it cannot technically intercept a message a model host has already emitted, so hosts recover by running `task next <task-id>` in the next turn and executing its command. `task status ... --status blocked_on_user` fails instead of persisting when the current gate is not ready, and `gate-view.mjs` only renders tasks already in that validated status.

Human approval is a dedicated atomic operation. The displayed review steps map to stable `--gate` values: **Confirm requirements** → `G0_confirm`, **Approve plan** → `G1_review`, **Review implementation** → `G2_codereview`. Display labels are always English; task prose may follow the task language:

```sh
node .agents/aidlc/scripts/state.mjs gate approve <task-id> --gate <gate> --source "<explicit approval>"
```

`--source` is audit provenance, not authentication or proof of consent. The host agent must invoke this command only in a later user turn that explicitly approves the gate currently presented.

`evidence add` accepts `spec`, `test`, `lint`, `review`, and `diagnostic`; it rejects `approval`. An evidence `--area` must belong to the task's affected areas, and multi-area test or lint evidence must name its area. `task status` accepts `active`, `blocked_on_user`, and `paused` (`done` is not a status command; finish with `task transition --to done` or `task archive`), and rejects `blocked_on_user` at wrap, which has no human gate. Every route out of a validated `blocked_on_user` wait, including `paused`, requires audited `--reason` and `--source` metadata and appends diagnostic evidence; entering `paused` from `active` requires the same audited `--mode audited --reason --source` triple and appends a `Paused while active` diagnostic, while resuming `paused → active` needs no audit metadata. Repair bounds are machine-enforced: the third failed verify record per area, or the second failed review record, in the current build flips `nextAction` to `blocked` and adds a `REPAIR_BOUND` error to the Review implementation gate check. Normal phase advancement uses `gate approve`, and wrap completion uses `task transition --to done` or `task archive <task-id> --reason "<reason>" --source "<source>"`, which applies the same transition checks and appends an `Archive to done` diagnostic. The low-level transition escape hatch is intentionally noisy, records diagnostic evidence, still applies all transition checks, and requires audit metadata:

```sh
node .agents/aidlc/scripts/state.mjs task transition <task-id> --to <phase> --mode audited --reason "<reason>" --source "<source>"
```

Self-transitions are rejected, and `task create` rejects an id that collides case-insensitively with an existing task or archive record. `task create` also fails while another unrelated task is actionable; its `--switch-from <ids>` acknowledgement still requires explicit user direction. `--feature <feature-id>` permits sibling tasks in an existing feature without abandoning them. `feature link` checks membership and task dependencies; `task item ... --depends-on <item-id,...> --owns <path,...>` adds item edges and an optional Git path scope. Loop dispatch (local and fleet) requires a nonempty path scope. When `loop.mode` is `local` or `fleet`, the Approve plan check also fails with `PARTITION_SCOPE` for an open item without `--owns`, and with `PARTITION_OVERLAP` when two items that can run concurrently (no direct or transitive `--depends-on` between them) own overlapping paths; with the loop off both are warnings. Overlap is per path segment: `src` overlaps `src/a.ts` but not `srcx`. The rendered workplan shows each item's scope as `owns: … · after: …`. Path scopes are normalized (trailing slashes stripped) and may name either a file or a directory; directory scopes cover every file beneath them. Missing and cyclic dependencies fail, and an item or feature task cannot finish before its prerequisites. After reopening the Approve plan step, all non-deferred execution items return to `todo`; prior Review implementation, verification, and review evidence cannot satisfy the new build boundary, and repair-bound counters reset with it.

State writes and generated workplans use symlink-checked atomic replacement. State-lock release is owner-token checked and never removes a replacement owner's lock. If a process stops after writing a terminal archive record but before committing the catalog, a retry replaces that orphan only when the persisted catalog still contains the same active task identity and does not reference an archive record; malformed, referenced, or identity-conflicting records fail closed.

Promoting an agent-memory candidate requires traceable source records and an explicit approver:

```sh
node .agents/aidlc/scripts/state.mjs memory promote <memory-id> --summary "<summary>" --guidance "<guidance>" --source-task <task-id> --source-lesson <lesson-id> --approved-by "<human>"
```

Use [Operating the workflow](./operating-workflow.md) for gates, approvals, handoffs, and task ownership.
