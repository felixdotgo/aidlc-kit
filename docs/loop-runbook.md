# Loop setup runbook

> [!WARNING]
> The loop and the coordination service are **experimental and unfinished**: they contain known bugs and rough edges, and — because the package is still pre-1.0 (`0.x`) — the `loop.*` fields, provider mappings, environment variables, and diagnostics can change incompatibly in any release before `1.0.0`.

This runbook walks through the three most common operational journeys for the end-to-end loop, in order:

1. [Enable the loop from `off`](#enable-the-loop-from-off)
2. [Run the loop in `local` mode](#local-mode)
3. [Run the loop across multiple machines (`fleet`)](#fleet-multi-machine)

It is a step-by-step guide, not a reference. For the full field, flag, and environment reference, see [Configuration](./configuration.md), [Command reference](./command-reference.md), and [AI-DLC Coordination service](./coordination-service.md); this runbook links to those pages for depth instead of repeating them.

## The loop in one paragraph

The loop drives a task end-to-end. A **lead** agent runs the clarify, plan, and wrap phases, while **workers** execute build items. `local` mode uses the project's canonical local state (`state.mjs`) with a host-executed lead and Docker-isolated workers on one Linux host. `fleet` mode delegates authority to a coordination service and can spread workers across machines. Selecting a mode only configures the loop; nothing runs until you call `aidlc-kit loop start` explicitly.

## Enable the loop from `off`

`loop.mode` defaults to `off` (an absent `loop` field also means `off`). Enabling it means setting `loop.mode` to `local` or `fleet` and providing `loop.agents` with one `lead` and one or more named `workers`, each mapped to `codex`, `claude`, or `opencode`:

```json
{
  "loop": {
    "mode": "local",
    "agents": { "lead": "codex", "workers": { "worker-a": "codex", "worker-b": "opencode" } }
  }
}
```

### Step 1 — Choose how to write the config

Pick one of three ways to set `loop.mode` and `loop.agents`:

- **Edit `.agents/config.json` directly.** This is the project-owned config; the fields are described in [Configuration](./configuration.md#optional-loop-configuration).
- **Use `init`** for a new install:
  ```sh
  npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit init . \
    --loop-mode local --loop-lead codex --loop-workers a=codex,b=opencode
  ```
- **Use the human-only `upgrade`** for an existing install, which preserves the existing config when you omit the loop flags and lets an authorised human review the change before applying:
  ```sh
  npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit upgrade . \
    --loop-mode local --loop-lead codex --loop-workers a=codex,b=opencode --dry-run
  ```

### Step 2 — Verify the loop is enabled

`aidlc-kit loop start` fails closed unless the config is complete:

- `loop.mode` must be `local` or `fleet`.
- `loop.agents` must have a valid `lead` provider and at least one valid `worker` mapping (`Loop requires a configured lead and worker providers`).
- The requested `--mode` must match the configured `loop.mode` (`Requested mode does not match configured authority`).

These checks run on any `aidlc-kit loop` invocation before anything starts, so a wrong configuration fails closed with a clear message rather than silently running. A valid configuration is only a selection: it does not install or start a service, authorise an upgrade, or grant gate approval. Run `aidlc-kit loop start` to actually start the loop, and keep provider credentials out of the config object.

## Local mode

Local mode is the single-machine journey. The lead runs on the host (Codex, Claude Code, or OpenCode) for clarify/plan/wrap, and build items fan out to Docker-isolated workers. It uses the canonical local state and requires local authority; see [Command reference](./command-reference.md#loop) for the authority boundary.

### Prerequisites

| Requirement | Notes |
| --- | --- |
| Linux host | Loop/fleet features require Docker and a POSIX shell; `loop-local-workers.mjs` rejects non-Linux hosts. |
| Docker engine | The worker batch preflights `docker info` and the worker image. |
| Non-root host user | Docker workers require a non-root uid/gid. |
| Worker Docker image | Auto-built from the packaged Dockerfile on first build dispatch (`aidlc-kit loop worker-image`); set `AIDLC_WORKER_DOCKER_IMAGE` only to override the per-provider default. |
| Provider credentials | Exported in the environment; never written into `.agents/config.json`. |

### Step 1 — Configure `local`

Set `loop.mode` to `local` with a lead and workers (see [Enable the loop from `off`](#enable-the-loop-from-off)):

```json
{
  "loop": {
    "mode": "local",
    "agents": { "lead": "codex", "workers": { "worker-a": "codex", "worker-b": "opencode" } }
  }
}
```

### Step 2 — Set the environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `AIDLC_WORKER_DOCKER_IMAGE` | no | Optional single-image override. The per-provider default `aidlc-worker-<provider>:local` is auto-built and recorded in `loop.workerImage`. |
| `AIDLC_OPENCODE_MODEL` | if any provider is `opencode` | `provider/model[#variant]` (for example `opencode-go/gpt-6-luna`). The turn fails closed without a valid value. |
| `OPENAI_API_KEY` | if a provider is `codex` | Codex worker credential. |
| `ANTHROPIC_API_KEY` | if a provider is `claude` | Claude Code worker credential. |
| `OPENCODE_API_KEY` | if a provider is `opencode` | OpenCode worker credential. The key follows the model provider: `openai/` → `OPENAI_API_KEY`, `anthropic/` → `ANTHROPIC_API_KEY`, otherwise `OPENCODE_API_KEY`. |
| `AIDLC_LOCAL_WORKTREES_ROOT` | no | Root for worker worktrees; defaults to a system temp directory. It must be outside the integration checkout. |

Local Docker workers authenticate OpenCode from the environment and redirect OpenCode's XDG data/config roots into the worker's ephemeral HOME. The **isolated lead** container and **fleet worker** containers do not support OpenCode yet (`OpenCode workers require file-based credentials and are not available in isolated containers yet`); use a host-executed OpenCode lead (`loop.mjs run --agent opencode`) or choose Codex/Claude Code where container isolation is required.

### Step 3 — Build the worker image (usually automatic)

Build the worker image for each provider you use, or let the supervisor auto-build it on the first build dispatch:

```sh
npx @felixdotgo/aidlc-kit loop worker-image --provider codex    # → aidlc-worker-codex:local
npx @felixdotgo/aidlc-kit loop worker-image --provider opencode # → aidlc-worker-opencode:local
```

The command records the tag into `loop.workerImage`; the local supervisor reuses it and auto-builds any missing per-provider image before dispatch. The batch preflight still inspects the image and runs each provider CLI with `--version` inside the container, so a missing or mismatched image fails before any worker starts. See [Testing and release](./testing-and-release.md#loop-docker-and-postgresql-verification) for the fixture build pattern used by the test suite.

### Step 4 — Start, watch, and resume

`start` reads the requirement from an interactive prompt or stdin — the requirement is never passed as an argument, and it is capped at 8192 bytes:

```sh
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit loop start
```

`status` prints the canonical task and its derived next action:

```sh
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit loop status --task-id <task-id>
```

`resume` continues a run that stopped at a pause, blocked state, or completion boundary:

```sh
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit loop resume --task-id <task-id>
```

The supervisor runs in the foreground until the next gate, a pause, a blocked state, or completion, emitting each gate view and the waiting state. A run records its lead provider; `resume` rejects a different lead agent.

As an alternative to typing these commands repeatedly, `aidlc-kit ui` starts a minimal local web dashboard to view task status and start/resume the loop; gate approval stays on the trusted terminal. See [Command reference](./command-reference.md#ui).

### Step 5 — Approve gates from the trusted host terminal

Gate approval happens only through the trusted host terminal — never from a lead or worker container, and never via piped input:

```sh
node .agents/aidlc/scripts/loop-gate.mjs <task-id>
```

The command prints the exact review (task, phase, gate, artifact digests, and — at `G2_codereview` — the integration commit), then prompts `Type approve to approve this exact review:`. Type `approve` to approve that exact review. If the review changes while you type, it fails closed and asks you to inspect the new review.

## Fleet (multi-machine)

Fleet mode spreads the loop across machines through the coordination service. It uses `remote-state.mjs` instead of the local `state.mjs`, and the remote workspace is canonical. Deployment, storage (SQLite for one host, PostgreSQL for multiple hosts), and credentials are covered in [Coordination service](./coordination-service.md); this section keeps the loop-specific steps and links there for the rest.

### Prerequisites

- A deployed coordination service with PostgreSQL for a multi-host topology, and a shared Git remote — see [Coordination service](./coordination-service.md#multi-machine-loop-deployment).
- `loop.mode` set to `fleet` with a lead and workers matching your worker machines.
- Three distinct credential classes (`MCP_FLEET_LEAD_TOKEN`, `MCP_FLEET_REVIEWER_TOKEN`, and `MCP_FLEET_WORKER_TOKENS`) configured on the service.

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
| `AIDLC_FLEET_URL` | yes | The full HTTPS `/mcp` URL of the service. |
| `AIDLC_FLEET_WORKSPACE` | yes | The remote workspace id. |
| `AIDLC_FLEET_TOKEN` | yes | The lead credential. |
| `AIDLC_FLEET_INTEGRATION_BRANCH` | yes | The shared integration branch. |
| `AIDLC_FLEET_PROJECT_ROOT` | yes | Absolute project root. Set automatically by the `aidlc-kit loop` facade; required for the direct `remote-state.mjs` / fleet-runner client. When set explicitly it must match the loop root. |
| `AIDLC_FLEET_WORKER_IDS` | yes | Comma-separated worker ids; must match the configured `loop.agents.workers`. |
| `AIDLC_FLEET_WORKER_PROVIDERS` | optional | JSON override mapping each worker to `codex`/`claude`/`opencode`; defaults to the configured mapping. |
| `AIDLC_FLEET_AGENT` | optional | Lead agent override (`codex`, `claude`, or `opencode`). |
| `AIDLC_FLEET_GIT_REMOTE` | optional | Git remote name; defaults to `origin`. |

### Step 3 — Start the supervised run

`aidlc-kit loop start --mode fleet` wraps the fleet supervisor with requirement intake and preflight (service reachability plus the integration branch), failing closed instead of falling back to local:

```sh
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit loop start --mode fleet
```

The underlying fleet runner is also available directly from the service deployment (the installed `.agents/aidlc-coordination/`, or `dist/services/aidlc-coordination/` from a source checkout):

```sh
node .agents/aidlc-coordination/src/fleet-run.mjs supervisor <task-id>
node .agents/aidlc-coordination/src/fleet-run.mjs coordinator <task-id> --once
```

`supervisor` claims the task lease, runs fenced lead turns through the coordinator, publishes each gate snapshot with its checkpoint in one transaction, waits for reviewer approval, and resumes automatically; it never approves a gate.

### Step 4 — Run a worker on each worker machine

On each worker machine, point at the same `AIDLC_FLEET_URL` and workspace, then set:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AIDLC_FLEET_WORKER_ID` | yes | This machine's worker id (must be a configured worker). |
| `AIDLC_FLEET_WORKTREES_ROOT` | yes | Root for this worker's isolated worktrees. |
| `AIDLC_WORKER_DOCKER_IMAGE` | yes | The worker Docker image (build it on this machine with `aidlc-kit loop worker-image --provider <provider>`). |
| worker credential | yes | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (or `OPENCODE_API_KEY`) for this worker's provider. |

Run one bounded assignment per invocation:

```sh
node .agents/aidlc-coordination/src/fleet-run.mjs worker --once
```

`worker --once` claims one ready assignment and fails closed without the image and that machine's credential. Fleet worker containers reject `opencode` (the same container diagnostic as local isolation); the blocker surfaces when the job executes rather than being reported as an invalid provider.

### Step 5 — Approve gates as the reviewer

Use the reviewer credential in a connected reviewer conversation:

```sh
node .agents/aidlc/scripts/remote-state.mjs gate inbox
node .agents/aidlc/scripts/remote-state.mjs gate approve <task-id> --snapshot <snapshot-id> --source "<explicit user approval>"
```

The approve command checks that the snapshot is still current and uses the reviewer-only service operation. Run it only after the human explicitly approves the packet.

## Authority boundary

`local` mode uses the canonical local state and requires local authority; `fleet` mode uses `remote-state.mjs`. When `AIDLC_FLEET_URL` is set, local lifecycle, context, gate, assignment, and standalone loop commands reject use so an unattended lead cannot accidentally mutate a second local authority. Unset `AIDLC_FLEET_URL` only when deliberately returning to a local run. See [Coordination service](./coordination-service.md#state-and-synchronization-contract) for the remote canonical-state contract.

## Where to go next

- [Operating the workflow](./operating-workflow.md) — gates, approvals, handoffs, and task ownership.
- [Troubleshooting](./troubleshooting.md) — symptom/error-code recovery, including fleet authority and Docker worker image diagnostics.
