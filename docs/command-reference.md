# Command reference

All package commands operate on local files. The examples run version `0.0.1` through npm; `npx` may ask permission to fetch that package on first use. Replace `.` with the target project path when needed. For a source checkout, see the [development guide](./development.md).

## `init`

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow init [path] [--agent <name[,name]> | --all] [--yes] [--dry-run] [--force]
```

Plans the installation, prints a preview, and then writes the workflow only after confirmation (or `--yes`). `--dry-run` prints the same plan without writing. If exactly one installed agent is detected, it can be selected automatically. In an interactive terminal, choose multiple agents with the checkbox prompt: use arrow keys to move, Space to toggle, A to toggle all, and Enter to confirm. For scripts and non-interactive terminals, use `--agent <name[,name]>` or `--all`.

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
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow upgrade [path] [--dry-run]
```

Upgrade is deliberately human-only. The command rejects `--yes` and `--force`; applying it requires an interactive terminal and an exact typed confirmation of the package version. Interactive confirmations use the same styled terminal prompt as `init`. Agents must not run, preview, detect, or suggest package upgrades on their own.

The upgrade plan handles supported legacy `.aidlc/` project data transactionally: identical paths are deduplicated, differing content or unsafe entries stop the plan, and an audit backup supports rollback. Review the preview before an authorised human applies it.

## Installed lifecycle scripts

After `init`, task lifecycle commands live in the target project, not in the package CLI:

```sh
node .agents/aidlc/scripts/state.mjs task list --limit 20
node .agents/aidlc/scripts/state.mjs task find --query "<words>" --include-archive
node .agents/aidlc/scripts/state.mjs task show <task-id>
node .agents/aidlc/scripts/state.mjs task next <task-id>
node .agents/aidlc/scripts/task-next.mjs <task-id> --require-stop
node .agents/aidlc/scripts/gate-view.mjs <task-id>
```

Installed lifecycle options may appear before or after positionals and accept both `--name value` and `--name=value`. Unknown, duplicate, command-irrelevant, missing-value, and surplus positional arguments are rejected before state I/O. Boolean options such as `--all`, `--include-archive`, and `--require-stop` do not accept values. When a literal value begins with `--`, use the equals form so it is not confused with a missing value.

An explicit `--root <path>` wins and must identify a directory containing `.agents/`. Without `--root`, the runtime walks upward from the current working directory and selects the nearest ancestor containing `.agents/aidlc/`. If no installed-workflow marker exists, the command fails without creating local state. Manual calls from a nested directory need an absolute or upward-relative script path so Node can locate the entry point. Runtime-generated actions always include both an absolute script path and an absolute `--root`, so they remain executable from any working directory.

Every `state.mjs` and `task-next.mjs` command prints one JSON envelope: `{ok: true, result, nextAction?}`. `result` carries the command payload (a mutated command nests it as `{task, ...extra}`; a read returns the read object), and `nextAction` is present whenever the command is task-scoped. Task-less commands (`memory list|promote|retire`, `lesson rebuild|search`, `state migrate`, `task list|find`) return no `nextAction`. A success envelope may additionally carry `warnings: [{code, message, hint?}]` when the mutation persisted but a derived step failed afterwards — `LESSON_INDEX_STALE` (lesson-index rebuild) or `RENDER_FAILED` (workplan render); the mutation is committed and the exit code stays `0`, so callers follow the warning hint instead of retrying the mutation, while the explicit repair commands (`lesson rebuild`, `render.mjs`) and `state migrate` still fail loudly. Failures print a one-line `{ok: false, error: {message, hint?}}` on stderr — never a stack trace. Exit codes are typed: `0` success, `1` expected validation or gate error, `2` the continuation guard, `3` an unexpected crash. Callers must execute `run_phase` actions immediately; a successful mutation is not permission to stop. In build, the action includes `itemId`, `remainingItems`, and an item-focused context command while work remains, and every embedded command carries an explicit `--root` so it runs from any working directory.

`task-next.mjs --require-stop` prints the current action plus a machine-readable `continuation` object in the stdout envelope — `{required, code, taskId, classification}` and, when work remains, `command`, `reason`, `itemId`, and `remainingItems` — and exits `2` when the classification is `run_phase`. The first stderr line is `CONTINUATION_REQUIRED: {json}` carrying the same task id, command, and reason (followed by an explicit "expected pause, not a failure" note); it is a local guard against a premature final response, and the caller must execute `continuation.command` instead of replying. It exits normally (`continuation.code = STOP_ALLOWED`) for a valid human gate, durable blocker, terminal outcome, or completion. The guard is detection at the package boundary: it cannot technically intercept a message a model host has already emitted, so hosts recover by running `task next <task-id>` in the next turn and executing its command. `task status ... --status blocked_on_user` fails instead of persisting when the current gate is not ready, and `gate-view.mjs` only renders tasks already in that validated status.

Human approval is a dedicated atomic operation:

```sh
node .agents/aidlc/scripts/state.mjs gate approve <task-id> --gate <gate> --source "<explicit approval>"
```

`--source` is audit provenance, not authentication or proof of consent. The host agent must invoke this command only in a later user turn that explicitly approves the gate currently presented.

`evidence add` accepts `spec`, `test`, `lint`, `review`, and `diagnostic`; it rejects `approval`. An evidence `--area` must belong to the task's affected areas, and multi-area test or lint evidence must name its area. `task status` accepts `active`, `blocked_on_user`, and `paused` (`done` is not a status command; finish with `task transition --to done` or `task archive`), and rejects `blocked_on_user` at wrap, which has no human gate. Every route out of a validated `blocked_on_user` wait, including `paused`, requires audited `--reason` and `--source` metadata and appends diagnostic evidence; entering `paused` from `active` requires the same audited `--mode audited --reason --source` triple and appends a `Paused while active` diagnostic, while resuming `paused → active` needs no audit metadata. Repair bounds are machine-enforced: the third failed verify record per area, or the second failed review record, in the current build flips `nextAction` to `blocked` and adds a `REPAIR_BOUND` error to the G2 gate check. Normal phase advancement uses `gate approve`, and wrap completion uses `task transition --to done` or `task archive <task-id> --reason "<reason>" --source "<source>"`, which applies the same transition checks and appends an `Archive to done` diagnostic. The low-level transition escape hatch is intentionally noisy, records diagnostic evidence, still applies all transition checks, and requires audit metadata:

```sh
node .agents/aidlc/scripts/state.mjs task transition <task-id> --to <phase> --mode audited --reason "<reason>" --source "<source>"
```

Self-transitions are rejected, and `task create` rejects an id that collides case-insensitively with an existing task or archive record. `task create` also fails while any other task is actionable (`nextAction` classification `run_phase`); the error lists the actionable task ids and the exact `--switch-from <ids>` acknowledgement. Passing that flag — only with explicit user direction to switch — records a resume-marker diagnostic on each acknowledged task and never pauses, closes, or otherwise mutates its lifecycle; the acknowledged task remains the authoritative resume target. After a G1 reopen, all non-deferred execution items return to `todo`; prior G2, verification, and review evidence cannot satisfy the new build boundary, and repair-bound counters reset with it.

State writes and generated workplans use symlink-checked atomic replacement. State-lock release is owner-token checked and never removes a replacement owner's lock. If a process stops after writing a terminal archive record but before committing the catalog, a retry replaces that orphan only when the persisted catalog still contains the same active task identity and does not reference an archive record; malformed, referenced, or identity-conflicting records fail closed.

Promoting an agent-memory candidate requires traceable source records and an explicit approver:

```sh
node .agents/aidlc/scripts/state.mjs memory promote <memory-id> --summary "<summary>" --guidance "<guidance>" --source-task <task-id> --source-lesson <lesson-id> --approved-by "<human>"
```

Use [Operating the workflow](./operating-workflow.md) for gates, approvals, handoffs, and task ownership.
