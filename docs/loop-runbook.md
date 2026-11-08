# Loop setup runbook

Setup for the end-to-end loop: a **lead** agent runs clarify, plan, and wrap, **workers** run build items in Docker, and the loop stops at every gate for a human. Journeys, in order: [Enable the loop from `off`](#enable-the-loop-from-off), [Local mode](#local-mode), [Fleet (multi-machine)](#fleet-multi-machine); day-to-day operation is the [Local loop walkthrough](./loop-local-run.md).

## Status and stability

> [!WARNING]
> **Experimental, pre-1.0 (`0.x`).** Local mode is usable on one Linux host; fleet mode and the Coordination service are under active development with known bugs.
> CLI flags, `loop.*`/`mcp.*` fields, environment variables, diagnostics, and installed layouts can change incompatibly before `1.0.0`.
> Selecting a mode never starts or approves anything; only `aidlc-kit loop start` (or `loop.sh up`) runs the loop.

## Enable the loop from `off`

`loop.mode` defaults to `off` (absent `loop` field included). Set it to `local` or `fleet` and give `loop.agents` one `lead` and one or more named `workers`, each `codex`, `claude`, or `opencode`:

```json
{
  "loop": {
    "mode": "local",
    "agents": { "lead": "codex", "workers": { "worker-a": "codex", "worker-b": "opencode" } }
  }
}
```

- Edit `.agents/config.json` directly; fields in [Configuration](./configuration.md#optional-loop-configuration).
- New install, with `init`:
  ```sh
  npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit init . \
    --loop-mode local --loop-lead codex --loop-workers a=codex,b=opencode
  ```
- Existing install, with the human-only `upgrade` (omitting the loop flags preserves the config). Stop the daemon first; a newer loop refuses to start while an older one holds a task (`A loop from a previous aidlc-kit version is still running …`).
  ```sh
  npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit upgrade . \
    --loop-mode local --loop-lead codex --loop-workers a=codex,b=opencode --dry-run
  ```

Verify: every `aidlc-kit loop` invocation fails closed before anything starts unless:

- `loop.mode` is `local` or `fleet`, and `loop.agents` has a valid `lead` and at least one valid worker (`Loop requires a configured lead and worker providers`).
- Any `--mode` flag matches `loop.mode` (`Requested mode does not match configured authority`).

A valid config is only a selection: it installs and starts nothing and grants no approval. Keep credentials out of the config object.

## Local mode

One Linux host: the lead runs on the host (Codex, Claude Code, or OpenCode), build items fan out to Docker-isolated workers, and the canonical state is the local `state.mjs`.

### Prerequisites

| Requirement | Notes |
| --- | --- |
| Linux host, non-root user | `loop-local-workers.mjs` rejects non-Linux hosts; Docker workers need a non-root uid/gid. |
| Docker engine | The worker batch preflights `docker info` and the worker image. |
| Worker Docker image | Auto-built on first build dispatch; `AIDLC_WORKER_DOCKER_IMAGE` only overrides the default. |
| Provider credentials | In `.agents/loop.env` (git-ignored) or exported; never in `.agents/config.json`. |

### Step 1 — Configure `local`

Set `loop.mode` to `local` with a lead and workers, as shown in [Enable the loop from `off`](#enable-the-loop-from-off).

### Step 2 — Fill in `.agents/loop.env`

`init`/`upgrade` install `.agents/loop.env` as a commented template (git-ignored through `.agents/.gitignore`). Uncomment what you need; exported shell variables win, and values your tools already store are detected for the configured providers only:

| Variable | Required | Purpose and detected from |
| --- | --- | --- |
| `AIDLC_OPENCODE_MODEL` | if any provider is `opencode` | `provider/model[#variant]` (for example `opencode-go/gpt-6-luna`); the turn fails closed without it. Detected: `"model"` in `opencode.json` (project, `OPENCODE_CONFIG`, or `~/.config/opencode`). |
| `OPENAI_API_KEY` | if a provider is `codex` | Codex worker credential. Detected: `~/.codex/auth.json` after `codex login --with-api-key` (a ChatGPT-only login is not enough). |
| `ANTHROPIC_API_KEY` | if a provider is `claude` | Claude Code worker credential. Detected: `"env"` in `.claude/settings.local.json`, `.claude/settings.json`, or `~/.claude/settings.json`. |
| `OPENCODE_API_KEY` | if a provider is `opencode` | OpenCode worker credential; the key follows the model prefix (`openai/` → `OPENAI_API_KEY`, `anthropic/` → `ANTHROPIC_API_KEY`, otherwise `OPENCODE_API_KEY`). Detected: `~/.local/share/opencode/auth.json`. |
| `AIDLC_WORKER_DOCKER_IMAGE` | no | Single-image override; the default `aidlc-worker-<provider>:local` is auto-built and recorded in `loop.workerImage`. |

Check the result (secrets never printed) with `./.agents/aidlc/scripts/loop.sh check` (= `aidlc-kit loop env`).

Rarely set: `AIDLC_LOCAL_WORKTREES_ROOT` (worker worktrees root, default a system temp directory, must be outside the integration checkout); `AIDLC_LOOP_EVENT_LOG` (always `.agents/data/loop/ui-events.jsonl` for a local daemon); `AIDLC_ENV_FILE` or `--loop-env PATH` (another env file). Lookup order: [Command reference](./command-reference.md#loop). Credential rule: [Provider credentials and OpenCode](./configuration.md#provider-credentials-and-opencode).

### Step 3 — Build the worker image (usually automatic)

```sh
npx @felixdotgo/aidlc-kit loop worker-image --provider codex    # → aidlc-worker-codex:local
npx @felixdotgo/aidlc-kit loop worker-image --provider opencode # → aidlc-worker-opencode:local
```

- Records the tag in `loop.workerImage`; the supervisor auto-builds any missing per-provider image before dispatch.
- Batch preflight inspects the image and runs each provider CLI with `--version` in the container; a missing or mismatched image fails before any worker starts. Test fixtures: [Testing and release](./testing-and-release.md#loop-docker-and-postgresql-verification).

### Step 4 — Start the daemon, add tasks, and watch

```sh
./.agents/aidlc/scripts/loop.sh up      # env check + daemon + dashboard; --open launches the browser, --no-ui skips the dashboard
./.agents/aidlc/scripts/loop.sh down    # stop both (--now cancels the running turn); also: status, logs, check
```

`Ctrl-C` in the `up` terminal closes only the dashboard. On Windows use `.agents\aidlc\scripts\loop.cmd`.

Underneath, `loop start` runs the singleton daemon (one per project) and reads no requirement. Add tasks with the dashboard **New task** or with intake (stdin only, capped at 8192 bytes):

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop start
echo "Add PDF report export" | npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop intake
```

- The daemon runs only loop-owned tasks, keeps polling after a gate or completion, and auto-resumes approved tasks; there is no `loop resume`.
- Stuck: `aidlc-kit loop leases`, then [Loop leases, locks and claims](./troubleshooting.md#loop-leases-locks-and-claims).
- Upgraded from a version that kept assignments, event logs, run records, and intake files under `.agents/data/loop/` or at the task directory root: the daemon moves them under `.agents/data/tasks/<id>/runtime/` when it starts; `aidlc-kit loop migrate-data --dry-run` previews, `aidlc-kit loop migrate-data` runs it by hand ([Command reference](./command-reference.md#loop)).
- Status, stopping, resuming, the streaming log, and the dashboard: [Local loop walkthrough](./loop-local-run.md#start-the-daemon-and-add-tasks).

### Step 5 — Approve gates, or send feedback, from the trusted host terminal

Only a human approves a gate, on the trusted host terminal or the signed-in dashboard; never a lead or worker container, never piped input:

```sh
node .agents/aidlc/scripts/loop-gate.mjs <task-id>   # type approve, or any other text as feedback (task stays at the gate)
```

The dashboard detail page offers the same two actions ([details](./loop-local-run.md#approve-a-gate-or-send-feedback)).

## Fleet (multi-machine)

Fleet mode spreads the loop across machines through the coordination service: `remote-state.mjs` replaces the local `state.mjs`, and the remote workspace is canonical. Deployment, storage, and credentials: [Coordination service](./coordination-service.md#multi-machine-loop-deployment).

### Prerequisites

- A deployed coordination service (PostgreSQL for multi-host) and a shared Git remote.
- `loop.mode` set to `fleet`, with workers matching your worker machines.
- Three distinct credential classes on the service: `MCP_FLEET_LEAD_TOKEN`, `MCP_FLEET_REVIEWER_TOKEN`, `MCP_FLEET_WORKER_TOKENS`.

### Step 1 — Configure `fleet`

```json
{
  "loop": {
    "mode": "fleet",
    "agents": { "lead": "codex", "workers": { "worker-a": "codex", "worker-b": "opencode" } }
  }
}
```

### Step 2 — Set lead-machine environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `AIDLC_FLEET_URL` | yes | Full HTTPS `/mcp` URL of the service. |
| `AIDLC_FLEET_WORKSPACE` | yes | Remote workspace id. |
| `AIDLC_FLEET_TOKEN` | yes | Lead credential. |
| `AIDLC_FLEET_INTEGRATION_BRANCH` | yes | Shared integration branch; must exist on the remote. |
| `AIDLC_FLEET_PROJECT_ROOT` | no | Set by `aidlc-kit loop`; needed only for the direct `remote-state.mjs` / fleet-runner client. Must match the loop root. |
| `AIDLC_FLEET_WORKER_IDS` (comma-separated) / `AIDLC_FLEET_WORKER_PROVIDERS` | no | Derived from `loop.agents.workers`; must match it. |
| `AIDLC_FLEET_GIT_REMOTE` | no | Git remote name; default `origin`. |
| `AIDLC_FLEET_AGENT` | direct runner only | Lead provider when running `fleet-run.mjs` directly (default `codex`); `aidlc-kit loop` sets it from `loop.agents.lead`. Also the per-worker provider fallback. |
| `AIDLC_FLEET_MAX_TURNS`, `AIDLC_FLEET_TURN_TIMEOUT_MS`, `AIDLC_FLEET_MAX_STALL_TURNS`, `AIDLC_FLEET_POLL_MS` | no | Override `loop.limits` and `loop.pollMs`. |

The lead agent is `loop.agents.lead`. Do not export `AIDLC_FLEET_REVIEWER_TOKEN` in the lead shell; the daemon strips it from every lead and worker process.

### Step 3 — Start the daemon and add tasks

`loop start --mode fleet` preflights the service (`fleet_get`) and the remote integration branch, then runs the same daemon as local mode, failing closed instead of falling back to local:

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop start --mode fleet
echo "Add PDF report export" | npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop intake --mode fleet
```

- **Intake** creates the remote task under a short lead claim and writes `.agents/data/tasks/<task-id>/runtime/intake.json` with `authority: "fleet"`; only those tasks are fleet loop-owned.
- **Each actionable task** runs the fleet supervisor bounded (claim the supervisor lease, fenced lead turns and worker dispatch, publish the gate snapshot, release); after reviewer approval the next poll re-claims it.
- An unreachable service shows as `daemon_poll_error`; the daemon keeps running.

The fleet runner also runs directly from the service deployment (`.agents/aidlc-coordination/`, or `dist/services/aidlc-coordination/` in a source checkout); `supervisor` waits at each gate and never approves:

```sh
node .agents/aidlc-coordination/src/fleet-run.mjs supervisor <task-id>
node .agents/aidlc-coordination/src/fleet-run.mjs coordinator <task-id> --once
```

### Step 4 — Run a worker on each worker machine

Same `AIDLC_FLEET_URL`, workspace, and `AIDLC_FLEET_PROJECT_ROOT` (a project checkout); this worker's own `AIDLC_FLEET_TOKEN`; and:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AIDLC_FLEET_WORKER_ID` | yes | This machine's worker id (a configured worker). |
| `AIDLC_FLEET_WORKTREES_ROOT` | yes | Root for this worker's isolated worktrees. |
| `AIDLC_FLEET_WORKER_AGENT` | recommended | Provider (`codex`, `claude`, or `opencode`); falls back to this worker's entry in `AIDLC_FLEET_WORKER_PROVIDERS`, then `AIDLC_FLEET_AGENT`. A worker rejects jobs for another provider. |
| `AIDLC_WORKER_DOCKER_IMAGE` | no | Image override; otherwise `loop.workerImage[provider]` or `aidlc-worker-<provider>:local`, auto-built. Required when the provider is unknown. |
| `AIDLC_OPENCODE_MODEL` | if the provider is `opencode` | `provider/model[#variant]`. |
| worker credential | yes | `OPENAI_API_KEY` (codex), `ANTHROPIC_API_KEY` (claude), or the key matching the opencode model prefix (`openai/`, `anthropic/`, otherwise `OPENCODE_API_KEY`). |

```sh
node .agents/aidlc-coordination/src/fleet-run.mjs worker --once   # omit --once to keep polling
```

The worker resolves the image to its immutable `sha256:` id and preflights Docker and the provider CLI before claiming work.

### Step 5 — Approve gates as the reviewer

```sh
node .agents/aidlc/scripts/remote-state.mjs gate inbox
node .agents/aidlc/scripts/remote-state.mjs gate approve <task-id> --snapshot <snapshot-id> --source "<explicit user approval>"
```

- `gate approve` checks the snapshot is still current and uses the reviewer-only operation; run it only after the human explicitly approves the packet.
- Dashboard: start `aidlc-kit ui` with the Step 2 environment plus `AIDLC_FLEET_REVIEWER_TOKEN` or `--reviewer-token-file`; without it the approve API returns `403` and the page shows these commands.
- **Send feedback (stay at gate)** needs no reviewer credential: it runs `remote-state.mjs task status <task-id> --status active --mode audited` under the lead claim; the task stays at the gate and the supervisor publishes a revised snapshot.

## Authority boundary

`local` uses the canonical local state; `fleet` uses `remote-state.mjs`. While `AIDLC_FLEET_URL` is set, local lifecycle, context, gate, assignment, and standalone loop commands reject use; unset it only when deliberately returning to a local run. Contract: [State and synchronization contract](./coordination-service.md#state-and-synchronization-contract).

## Where to go next

- [Local loop walkthrough](./loop-local-run.md) — day-to-day operation.
- [AI-DLC Coordination service](./coordination-service.md) — deploying the fleet service.
- [Operating the workflow](./operating-workflow.md) — gates, approvals, handoffs.
- [Troubleshooting](./troubleshooting.md) — symptom and error-code recovery.
