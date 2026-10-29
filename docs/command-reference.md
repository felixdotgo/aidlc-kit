# Command reference

All package commands operate on local files. The examples run version `0.0.1` through npm; `npx` may ask permission to fetch that package on first use. Replace `.` with the target project path when needed. For a source checkout, see the [development guide](./development.md).

## `init`

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow init [path] [--agent <name[,name]> | --all] [--loop-mode off|local|fleet] [--loop-lead codex|claude|opencode] [--loop-workers <id=provider,...>] [--yes] [--dry-run] [--force]
```

Plans the installation, prints a preview, and then writes the workflow only after confirmation (or `--yes`). `--dry-run` prints the same plan without writing. If exactly one installed agent is detected, it can be selected automatically. In an interactive terminal, choose multiple agents with the checkbox prompt: use arrow keys to move, Space to toggle, A to toggle all, and Enter to confirm. For scripts and non-interactive terminals, use `--agent <name[,name]>` or `--all`.

In interactive setup, choose a loop mode and, when enabled, the lead and worker providers. For non-interactive setup, omit loop options to keep the default off, or specify `--loop-mode local|fleet` together with `--loop-lead` and `--loop-workers` (for example, `--loop-workers a=codex,b=opencode`). The preview includes the project config change. These settings only configure the loop; run `aidlc-workflow loop start` to actually start it.

`--force` is for an intentional initial replacement of an unmanaged conflicting file. It is not an upgrade mechanism. If the project already has another workflow package version, use the human-run upgrade flow instead.

## `status`

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow status [path]
```

Reports the installed version and local installation status. It does not query a registry.

## `doctor`

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow doctor [path] [--strict]
```

Checks the local manifest, configuration, and canonical state. `--strict` turns compatibility warnings such as a legacy manifest into errors. It does not query a registry.

## `profile validate`

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow profile validate [path]
```

Loads `.agents/config.json`, resolves its profile chain, and prints the effective profile order. Use it after changing `extends` or local profiles.

## `uninstall`

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow uninstall [path] [--yes] [--dry-run]
```

Prints the removal plan before applying it. It removes eligible unchanged managed assets but preserves project configuration and state. Prefer `--dry-run` first when working in an existing project.

## `mcp setup`

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow mcp setup [path] [--dry-run] [--yes] [--storage sqlite|postgres] [--deployment docker|remote] [--bind localhost|network] [--workspace <id>] [--poll-ms <n>] [--enable]
```

Previews the optional AI-DLC Coordination service configuration, then writes only after confirmation. Non-interactive use requires `--deployment`, `--storage`, `--bind`, and `--workspace`. It never starts Docker; `--enable` is explicit and remote mode has no local fallback. See [AI-DLC Coordination service](./coordination-service.md) for deployment and credential requirements.

## `upgrade`

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow upgrade [path] [--loop-mode off|local|fleet] [--loop-lead codex|claude|opencode] [--loop-workers <id=provider,...>] [--dry-run]
```

Upgrade is deliberately human-only. The command rejects `--yes` and `--force`; applying it requires an interactive terminal and an exact typed confirmation of the package version. Interactive confirmations use the same styled terminal prompt as `init`. Agents must not run, preview, detect, or suggest package upgrades on their own.

An omitted loop selection preserves the existing config; an explicit selection appears in the preview and is included in the upgrade backup and rollback. Enabling a mode requires a lead and worker mapping.

The upgrade plan handles supported legacy `.aidlc/` project data transactionally: identical paths are deduplicated, differing content or unsafe entries stop the plan, and an audit backup supports rollback. Review the preview before an authorised human applies it.

## `loop`

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow loop start|status|resume [options]
```

Options: `--task-id <id>` (optional for `start`, which derives one; required for `status`/`resume`), `--root <path>`, and `--mode local|fleet` (defaults to the configured `loop.mode`). `start` reads the requirement from an interactive prompt or stdin — the requirement is never passed as an argument. The command fails closed when the requested mode does not match the configured authority, when another task is actionable, or when a resume record is missing.

`status` prints the canonical task, its derived next action, and — in fleet mode — the durable gate checkpoint. `start` and `resume` run the supervisor in the foreground until the next gate, a pause, a blocked state, or completion; the emitted events include each gate view and the waiting state.

Local mode requires the Docker worker image configuration described in [Testing and release](./testing-and-release.md) plus the provider credential environment; approval happens through the trusted host terminal command `node .agents/aidlc/scripts/loop-gate.mjs <task-id>`, which refuses piped input.

Fleet mode requires the running coordination service (`AIDLC_FLEET_URL`, `AIDLC_FLEET_WORKSPACE`, lead `AIDLC_FLEET_TOKEN`, `AIDLC_FLEET_INTEGRATION_BRANCH`, and optionally `AIDLC_FLEET_GIT_REMOTE`); worker IDs must match the configured `loop.agents.workers`, and `AIDLC_FLEET_WORKER_PROVIDERS` may map each worker to `codex`, `claude`, or `opencode`. The facade preflights the service and the integration branch and fails closed with a diagnosis instead of falling back to local. Fleet worker containers reject `opencode` with the container diagnostic above; assignment validation accepts it so that blocker surfaces when the job executes rather than being reported as an invalid provider. Fleet workers run separately through the fleet runner (`worker --once`) on each worker machine with `AIDLC_WORKER_DOCKER_IMAGE` and their own worker credential; a reviewer approves gates through the reviewer credential as documented in [Coordination service](./coordination-service.md).

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

`--agent opencode` requires `AIDLC_OPENCODE_MODEL` in `provider/model[#variant]` form; the turn fails closed without it. Docker-isolated lead turns, local Docker worker batches, and fleet worker containers reject OpenCode with `OpenCode workers require file-based credentials and are not available in isolated containers yet` and do not fall back to the host. Use `loop.mjs run --agent opencode` for host-executed lead turns, or use Codex or Claude Code where container isolation is required.

The defaults are 12 turns and 10 minutes per turn; two completed turns without observable progress stop the run. Each run records its provider, and `resume` rejects a different agent. The runner never grants human approval. An interactive client can resume by reading `task next` and reconciling local assignment metadata; fleet execution uses fenced service leases and the remote canonical state.

If context preparation fails before an agent turn starts, the loop pauses with a reason; fix the context problem and use `resume`. An interrupted running turn with no captured session ID still requires inspection of canonical state before recovery.

The fleet runner drives the supervised multi-worker flow against a coordination service. From the service deployment (a source checkout or the installed `.agents/aidlc-coordination/`), with the lead credential plus `AIDLC_FLEET_WORKER_IDS`, `AIDLC_FLEET_INTEGRATION_BRANCH`, and `AIDLC_FLEET_PROJECT_ROOT` set:

```sh
node .agents/aidlc-coordination/src/fleet-run.mjs supervisor <task-id>
node .agents/aidlc-coordination/src/fleet-run.mjs coordinator <task-id> --once
node .agents/aidlc-coordination/src/fleet-run.mjs worker --once
```

`supervisor` claims the task's supervisor lease, runs fenced lead turns through the coordinator, publishes each gate snapshot with its checkpoint in one service transaction, waits for the reviewer approval, and resumes automatically; it returns at a pause, blocked state, or completion, and never approves a gate. `coordinator --once` runs a single unattended pass without the supervisor lease. `worker --once` claims one ready assignment on a worker machine; it requires `AIDLC_WORKER_DOCKER_IMAGE` and that machine's worker credential and fails closed without them. `aidlc-workflow loop start --mode fleet` wraps the same supervisor with requirement intake and preflight.

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

Self-transitions are rejected, and `task create` rejects an id that collides case-insensitively with an existing task or archive record. `task create` also fails while another unrelated task is actionable; its `--switch-from <ids>` acknowledgement still requires explicit user direction. `--feature <feature-id>` permits sibling tasks in an existing feature without abandoning them. `feature link` checks membership and task dependencies; `task item ... --depends-on <item-id,...> --owns <path,...>` adds item edges and an optional Git path scope. Fleet dispatch requires a nonempty path scope. Path scopes are normalized (trailing slashes stripped) and may name either a file or a directory; directory scopes cover every file beneath them. Missing and cyclic dependencies fail, and an item or feature task cannot finish before its prerequisites. After reopening the Approve plan step, all non-deferred execution items return to `todo`; prior Review implementation, verification, and review evidence cannot satisfy the new build boundary, and repair-bound counters reset with it.

State writes and generated workplans use symlink-checked atomic replacement. State-lock release is owner-token checked and never removes a replacement owner's lock. If a process stops after writing a terminal archive record but before committing the catalog, a retry replaces that orphan only when the persisted catalog still contains the same active task identity and does not reference an archive record; malformed, referenced, or identity-conflicting records fail closed.

Promoting an agent-memory candidate requires traceable source records and an explicit approver:

```sh
node .agents/aidlc/scripts/state.mjs memory promote <memory-id> --summary "<summary>" --guidance "<guidance>" --source-task <task-id> --source-lesson <lesson-id> --approved-by "<human>"
```

Use [Operating the workflow](./operating-workflow.md) for gates, approvals, handoffs, and task ownership.
