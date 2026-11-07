# Loop setup runbook

> [!WARNING]
> The loop is **experimental** and pre-1.0 (`0.x`): the `loop.*` fields, provider mappings, environment variables, and diagnostics can change incompatibly in any release before `1.0.0`. **Local mode is usable** on a single Linux host today; **fleet mode is still under active development** and is not yet stable.

This runbook walks through the three most common operational journeys for the end-to-end loop, in order:

1. [Enable the loop from `off`](#enable-the-loop-from-off)
2. [Run the loop in `local` mode](#local-mode)
3. [Run the loop across multiple machines (`fleet`)](#fleet-multi-machine)

It is a step-by-step guide, not a reference. For the full field, flag, and environment reference, see [Configuration](./configuration.md), [Command reference](./command-reference.md), and [AI-DLC Coordination service](./coordination-service.md); this runbook links to those pages for depth instead of repeating them.

## The loop in one paragraph

The loop drives a task end-to-end. A **lead** agent runs the clarify, plan, and wrap phases, while **workers** execute build items. `local` mode uses the project's canonical local state (`state.mjs`) with a host-executed lead and Docker-isolated workers on one Linux host. `fleet` mode delegates authority to a coordination service and can spread workers across machines. Both modes use the same loop daemon, intake, and dashboard; only the authority differs. Selecting a mode only configures the loop; nothing runs until you call `aidlc-kit loop start` explicitly.

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
  npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit init . \
    --loop-mode local --loop-lead codex --loop-workers a=codex,b=opencode
  ```
- **Use the human-only `upgrade`** for an existing install, which preserves the existing config when you omit the loop flags and lets an authorised human review the change before applying:
  ```sh
  npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit upgrade . \
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
| `AIDLC_LOOP_EVENT_LOG` | no (see note) | Path to a JSONL event-log sidecar that feeds the web dashboard live log. The `aidlc-kit ui` **New task** action (when it starts the daemon) sets it to `.agents/data/loop/ui-events.jsonl` automatically; a **manually started** daemon must set it to the same path or the dashboard live log stays empty. Task events are also written to `events/<task-id>.jsonl` next to it (per-task history for the live log). |

Docker workers (local and fleet) authenticate OpenCode from the environment and redirect OpenCode's XDG data/config roots into the worker's ephemeral HOME. Only the **isolated lead** container does not support OpenCode yet (`OpenCode workers require file-based credentials and are not available in isolated containers yet`); the daemon runs the lead on the host, so an OpenCode lead works there.

### Step 3 — Build the worker image (usually automatic)

Build the worker image for each provider you use, or let the supervisor auto-build it on the first build dispatch:

```sh
npx @felixdotgo/aidlc-kit loop worker-image --provider codex    # → aidlc-worker-codex:local
npx @felixdotgo/aidlc-kit loop worker-image --provider opencode # → aidlc-worker-opencode:local
```

The command records the tag into `loop.workerImage`; the local supervisor reuses it and auto-builds any missing per-provider image before dispatch. The batch preflight still inspects the image and runs each provider CLI with `--version` inside the container, so a missing or mismatched image fails before any worker starts. See [Testing and release](./testing-and-release.md#loop-docker-and-postgresql-verification) for the fixture build pattern used by the test suite.

### Step 4 — Start the daemon, add tasks, and watch

`start` launches the singleton daemon (one per project) and reads no requirement. Add tasks with the web dashboard **New task** or loop intake, which reads the requirement from stdin (capped at 8192 bytes) and never from an argument:

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop start
echo "Add PDF report export" | npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop intake
```

The daemon runs only loop-owned tasks (created through intake), one bounded run per task in turn, and keeps polling after a task reaches a gate or completes. Stop it with `Ctrl-C`: the first signal stops after the current turn, the second cancels the turn, the third exits. A stopped run is not a pause; the task continues on the next `start`.

`status` prints the canonical task and its derived next action:

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop status --task-id <task-id>
```

There is no `loop resume`. After a gate approval the daemon continues the task on its next poll. A **paused** task is not actionable: fix the cause, then press **resume** on the dashboard or run `node .agents/aidlc/scripts/state.mjs task status <task-id> --status active`.

As an alternative to typing these commands repeatedly, `aidlc-kit ui` starts a web dashboard to view task status, add tasks, resume paused tasks, send gate feedback, and approve gates; it prints a login URL that signs the browser in. See [Command reference](./command-reference.md#ui) and [Loop local run](./loop-local-run.md#57-web-dashboard-aidlc-kit-ui).

### Step 5 — Approve gates, or send feedback, from the trusted host terminal

Gate approval happens only through a human — the trusted host terminal or the signed-in dashboard — never from a lead or worker container, and never via piped input:

```sh
node .agents/aidlc/scripts/loop-gate.mjs <task-id>
```

The command prints the exact review (task, phase, gate, artifact digests, and — at `G2_codereview` — the integration commit), then prompts `Type approve to approve this exact review, or type feedback to send guidance back to the loop:`. Type `approve` to approve that exact review. Any other text is feedback: the task stays at the same gate, goes back to `active` with evidence `Cancelled gate wait at <gate>: <feedback>`, and the daemon's next lead turn revises the review artifact and re-presents the gate. If the review changes while you type, it fails closed and asks you to inspect the new review.

On the dashboard the task detail page offers the same two actions: **Send feedback (stay at gate)** and **✓ Approve** (which asks for confirmation in a popup before sending). A **feedback pending** pill on the card and detail page shows feedback that has not yet been followed by an approval of that gate.

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
| `AIDLC_FLEET_INTEGRATION_BRANCH` | yes | The shared integration branch; it must exist on the remote. |
| `AIDLC_FLEET_PROJECT_ROOT` | no | Set automatically by `aidlc-kit loop`; required only for the direct `remote-state.mjs` / fleet-runner client. When set explicitly it must match the loop root. |
| `AIDLC_FLEET_WORKER_IDS` / `AIDLC_FLEET_WORKER_PROVIDERS` | no | Derived from `loop.agents.workers`; when set explicitly they must match it. |
| `AIDLC_FLEET_GIT_REMOTE` | no | Git remote name; defaults to `origin`. |
| `AIDLC_FLEET_MAX_TURNS`, `AIDLC_FLEET_TURN_TIMEOUT_MS`, `AIDLC_FLEET_MAX_STALL_TURNS`, `AIDLC_FLEET_POLL_MS` | no | Override `loop.limits` and `loop.pollMs`, which are the defaults. |

The lead agent comes from `loop.agents.lead`. Do not export `AIDLC_FLEET_REVIEWER_TOKEN` in the lead shell; the daemon strips it from every lead and worker process anyway.

### Step 3 — Start the daemon and add tasks

`aidlc-kit loop start --mode fleet` preflights the service (`fleet_get`) and the remote integration branch, then starts the same daemon as local mode, failing closed instead of falling back to local:

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop start --mode fleet
echo "Add PDF report export" | npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop intake --mode fleet
```

Intake creates the remote task under a short lead claim and writes `.agents/data/tasks/<task-id>/loop-intake.json` with `authority: "fleet"` on this lead machine. Only those tasks are fleet loop-owned; a remote task created any other way is never picked up. For each actionable task the daemon runs the fleet supervisor in a bounded mode: it claims the supervisor lease, runs fenced lead turns and worker dispatch through the coordinator, publishes the gate snapshot with its checkpoint, then returns and releases the lease. After the reviewer approves, the next poll re-claims the task and continues. An unreachable service shows up as `daemon_poll_error` and does not stop the daemon. Shutdown, backoff, and `status` behave as in local mode; there is no `loop resume` (re-activate a paused task with the dashboard **resume**).

The underlying fleet runner is also available directly from the service deployment (the installed `.agents/aidlc-coordination/`, or `dist/services/aidlc-coordination/` from a source checkout):

```sh
node .agents/aidlc-coordination/src/fleet-run.mjs supervisor <task-id>
node .agents/aidlc-coordination/src/fleet-run.mjs coordinator <task-id> --once
```

Run directly, `supervisor` waits at each gate for the reviewer approval and resumes automatically; it never approves a gate.

### Step 4 — Run a worker on each worker machine

On each worker machine, point at the same `AIDLC_FLEET_URL`, workspace, and `AIDLC_FLEET_PROJECT_ROOT` (a checkout of the project), use that worker's own `AIDLC_FLEET_TOKEN`, then set:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AIDLC_FLEET_WORKER_ID` | yes | This machine's worker id (must be a configured worker). |
| `AIDLC_FLEET_WORKTREES_ROOT` | yes | Root for this worker's isolated worktrees. |
| `AIDLC_FLEET_WORKER_AGENT` | recommended | This worker's provider (`codex`, `claude`, or `opencode`); falls back to this worker's entry in `AIDLC_FLEET_WORKER_PROVIDERS`, then to `AIDLC_FLEET_AGENT`. A worker with a provider rejects jobs for another provider. |
| `AIDLC_WORKER_DOCKER_IMAGE` | no | Image override. Otherwise the image is `loop.workerImage[provider]` from the project config or `aidlc-worker-<provider>:local`, auto-built from the packaged Dockerfile when missing. Without a known provider this variable is required. |
| `AIDLC_OPENCODE_MODEL` | if the provider is `opencode` | `provider/model[#variant]`. |
| worker credential | yes | `OPENAI_API_KEY` (codex), `ANTHROPIC_API_KEY` (claude), or for opencode the key matching the model prefix (`openai/`, `anthropic/`, otherwise `OPENCODE_API_KEY`). |

Run one bounded assignment per invocation, or omit `--once` to keep polling:

```sh
node .agents/aidlc-coordination/src/fleet-run.mjs worker --once
```

The worker resolves the image to its immutable `sha256:` id and preflights Docker and the provider CLI before claiming work.

### Step 5 — Approve gates as the reviewer

Use the reviewer credential in a connected reviewer conversation:

```sh
node .agents/aidlc/scripts/remote-state.mjs gate inbox
node .agents/aidlc/scripts/remote-state.mjs gate approve <task-id> --snapshot <snapshot-id> --source "<explicit user approval>"
```

The approve command checks that the snapshot is still current and uses the reviewer-only service operation. Run it only after the human explicitly approves the packet. Alternatively, start `aidlc-kit ui` with the fleet environment from Step 2 plus the reviewer credential (`AIDLC_FLEET_REVIEWER_TOKEN` or `--reviewer-token-file`): the dashboard then approves the current snapshot itself, passing the credential only to that one approve process. Without a reviewer credential the dashboard shows these commands instead and its approve API returns `403`.

To send the loop back to work instead of approving, use **Send feedback (stay at gate)** on the dashboard detail page. Feedback needs **no reviewer credential** in fleet mode: the dashboard runs `loop-entry.mjs feedback <task-id>`, which records the feedback under the lead claim through `remote-state.mjs task status <task-id> --status active --mode audited`; the task stays at the same gate, the supervisor sees the pending feedback on its next poll, revises the review artifact, and publishes a new snapshot for the reviewer.

## Authority boundary

`local` mode uses the canonical local state and requires local authority; `fleet` mode uses `remote-state.mjs`. When `AIDLC_FLEET_URL` is set, local lifecycle, context, gate, assignment, and standalone loop commands reject use so an unattended lead cannot accidentally mutate a second local authority. Unset `AIDLC_FLEET_URL` only when deliberately returning to a local run. See [Coordination service](./coordination-service.md#state-and-synchronization-contract) for the remote canonical-state contract.

## Where to go next

- [Operating the workflow](./operating-workflow.md) — gates, approvals, handoffs, and task ownership.
- [Troubleshooting](./troubleshooting.md) — symptom/error-code recovery, including fleet authority and Docker worker image diagnostics.
