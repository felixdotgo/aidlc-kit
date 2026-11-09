# AI-DLC Coordination service

The optional, Docker-deployable authority for a workflow workspace: remote canonical state for a team, or the fleet loop across machines ([runbook](./loop-runbook.md#fleet-multi-machine)). Disabled by default: without an enabled `mcp` block, installed lifecycle scripts stay local and make no network calls.

> [!WARNING]
> Experimental, pre-1.0. See [Status and stability](./loop-runbook.md#status-and-stability).

## Safe setup

Preview first; outside an interactive terminal, provide all four selection flags:

```sh
npx --package @felixdotgo/aidlc-kit@0.4.0 aidlc-kit mcp setup . --dry-run \
  --deployment docker --storage sqlite --bind localhost --workspace engineering
```

Remove `--dry-run` and confirm to create `.agents/aidlc-coordination/` and update `.agents/config.json`. Setup does not start Docker. Copy `.env.example` to a secret-managed `.env`, review it, then start:

```sh
docker compose --env-file .agents/aidlc-coordination/.env -f .agents/aidlc-coordination/compose.yaml up -d
```

- SQLite only on the local Docker volume; PostgreSQL for multiple hosts.
- A network bind requires `MCP_STATE_AUTH_TOKEN` and TLS/reverse-proxy termination. Never commit `.env` or provider credentials.
- Source checkout: [development guide](./development.md).

## State and synchronization contract

- When enabled, the remote workspace is canonical. Import/export is an explicit recovery or migration action; there is no background dual-write or local fallback during an outage.
- Clients pull a revision or poll `state_events_since`; there are no realtime subscriptions or push notifications.

## Multi-machine loop deployment

Storage backends, with no implicit fallback or migration between them (never switch an existing authority automatically):

- **SQLite**: one service on one host, database on a local volume (`MCP_STATE_DATABASE=sqlite`, the default, plus `MCP_STATE_SQLITE_PATH`). Availability and write concurrency are limited to that host.
- **PostgreSQL**: multiple hosts or service instances.

Fleet mode is a separate compose profile. The source checkout keeps the template in `services/aidlc-coordination/`; human-run `mcp setup` copies it to `.agents/aidlc-coordination/`. Copy `.env.fleet.example` to a private `.env`, set the database and three distinct credential classes (`MCP_FLEET_LEAD_TOKEN`, `MCP_FLEET_REVIEWER_TOKEN`, and the worker-ID-to-token JSON map `MCP_FLEET_WORKER_TOKENS`), then start:

```sh
docker compose --env-file .env --profile fleet -f services/aidlc-coordination/compose.yaml up -d fleet-coordination
# installed project: -f .agents/aidlc-coordination/compose.yaml
```

- Default binding `127.0.0.1:8788`; for workers on other machines, expose `POST /mcp` through a TLS reverse proxy and set the binding deliberately.
- Requires the chosen database backend and a shared Git remote. Each worker gets an isolated worktree, a scoped branch, and its own credential.
- A process supervisor must restart the supervisor, lead, and workers; after restart they reacquire fenced leases and reconcile reported or uncertain Git results before retrying.

**Vocabulary.** Three kinds of fenced ownership, each with its own epoch counter:

- **supervisor lease** (`supervisor_*`): one `loop start` supervising a task;
- **lead lease** (`run_claim`): the lead epoch every lifecycle mutation must present;
- **job claims** (`job_*`): a worker's ownership of one item, with a job epoch.

`aidlc-kit loop leases` shows the supervisor epoch only when it differs from the lead epoch. A `FleetConflict` (for example `stale or expired lead claim`) is reported as `Fleet conflict: <explanation>. Inspect: node .agents/aidlc/scripts/loop-entry.mjs leases (<original message>)`. Local leases: [Troubleshooting](./troubleshooting.md#loop-leases-locks-and-claims).

**Roles.**

- Lead credential: advances lifecycle state only while holding the current task epoch.
- Worker credentials: claim, checkpoint, and report assigned jobs; never mutate lifecycle state or approve gates.
- Reviewer credential: reads pending gate snapshots and records a later explicit human approval against the snapshot and current revision.
- When the database, Git remote, or reviewer is unavailable, the run waits or fails closed; never a local fallback.

The remote lifecycle client needs `AIDLC_FLEET_URL` (full HTTPS `/mcp` URL), `AIDLC_FLEET_WORKSPACE`, and `AIDLC_FLEET_PROJECT_ROOT` (absolute); lead mutations also `AIDLC_FLEET_TOKEN` and the current `AIDLC_FLEET_LEAD_EPOCH` from its claim.

### Create tasks and a feature manifest

Create task records before the manifest: claim a lead epoch, export it, create the task with the feature ID, release; repeat per task; then create and link the manifest:

```sh
node .agents/aidlc/scripts/remote-state.mjs run claim checkout-api
export AIDLC_FLEET_LEAD_EPOCH=<returned-epoch>
node .agents/aidlc/scripts/remote-state.mjs task create checkout-api --title "Checkout API" --feature checkout
node .agents/aidlc/scripts/remote-state.mjs run release checkout-api --epoch <returned-epoch>
# Repeat claim/create/release for checkout-ui and checkout-integration.
node .agents/aidlc/scripts/remote-state.mjs feature create checkout --branch feature/checkout --tasks checkout-api,checkout-ui,checkout-integration
node .agents/aidlc/scripts/remote-state.mjs feature link checkout checkout-integration --depends-on checkout-api,checkout-ui
node .agents/aidlc/scripts/remote-state.mjs feature ready checkout
```

Every manifest member must have a canonical task record with the matching feature ID; a partially created task stays fail-closed until the manifest is complete. The lead epoch is task-specific; refresh it after release or expiry.

### Approve gates as the reviewer

In a connected reviewer conversation with `AIDLC_FLEET_REVIEWER_TOKEN`, inspect the pending packet; only after the human approves it, run:

```sh
node .agents/aidlc/scripts/remote-state.mjs gate inbox
node .agents/aidlc/scripts/remote-state.mjs gate approve <task-id> --snapshot <snapshot-id> --source "<explicit user approval>"
```

- `gate approve` checks the snapshot is still current and uses the reviewer-only operation; at G2 it also verifies the snapshot's integration commit matches the live remote branch (protect that branch against writes outside the lead).
- `--source` is the review message as provenance; the token authenticates the client, and the operator is responsible for using the user's actual reply.

### Run the fleet processes

Run the packaged fleet process on the lead and each worker machine under a process supervisor, same `AIDLC_FLEET_URL` and workspace, own role token each. Environment variables: runbook [lead](./loop-runbook.md#step-2--set-lead-machine-environment) and [worker](./loop-runbook.md#step-4--run-a-worker-on-each-worker-machine) tables; `AIDLC_FLEET_AGENT` selects the lead provider for the direct runner (default `codex`; `aidlc-kit loop` sets it from `loop.agents.lead`) and is the per-worker fallback; `AIDLC_FLEET_WORKER_PROVIDERS` overrides it per worker. `job_schedule` accepts `codex`, `claude`, or `opencode`; worker containers run all three, only the isolated lead container does not support OpenCode ([credentials](./configuration.md#provider-credentials-and-opencode)). The worker image is resolved to its immutable `sha256:` id before any job runs.

```sh
node dist/services/aidlc-coordination/src/fleet-run.mjs feature <feature-id>
node dist/services/aidlc-coordination/src/fleet-run.mjs worker
# installed project: node .agents/aidlc-coordination/src/fleet-run.mjs …
```

- `coordinator <task-id>` runs one task; `--once` runs a bounded polling pass.
- Defaults: four worker jobs per feature, five-minute leases with one-minute heartbeat, 12 turns per phase or assignment, 10 minutes per turn, two consecutive stalls. Override: `AIDLC_FLEET_MAX_WORKERS`, `AIDLC_FLEET_LEASE_MS`, `AIDLC_FLEET_HEARTBEAT_MS`, `AIDLC_FLEET_MAX_TURNS`, `AIDLC_FLEET_TURN_TIMEOUT_MS`, `AIDLC_FLEET_MAX_STALL_TURNS`.
- Feature mode dispatches dependency-ready tasks in order from one integration checkout; independent items of the active task can run on several machines.
- The coordinator never dispatches two items whose owned paths overlap by path segment (`src` overlaps `src/a.ts`, not `srcx`); the later item waits. With `MCP_FLEET_ENABLED=1` the service also refuses to approve the Approve plan gate for such overlaps or unscoped open items (`PARTITION_OVERLAP`, `PARTITION_SCOPE`).
- After a lost worker report the lead checks remote Git state and stops for reconciliation if ambiguous. `AIDLC_FLEET_CODE_ONLY_RETRY=1` permits an automatic retry only after the prior turn's timeout window elapsed and Git confirms no branch was published.
- The coordinator and feature commands return at a human gate (feature mode dispatches no further tasks); restart after the reviewer acts.
- Command events and failure diagnostics report status and exit code, never command text or output. Worker progress observes file content changes as well as paths.

### Unattended operation with the loop daemon

`aidlc-kit loop start --mode fleet` on the lead machine replaces a hand-run supervisor: it runs each fleet loop-owned task until its next gate, releases the supervisor lease, and re-claims after reviewer approval. It takes `loop.limits` and `loop.pollMs` as defaults for the `AIDLC_FLEET_*` limits and never passes `AIDLC_FLEET_REVIEWER_TOKEN` to a lead or worker process. Steps: [loop runbook](./loop-runbook.md#fleet-multi-machine). On the lead machine the task's event history, run record, and intake files live under `.agents/data/tasks/<task-id>/runtime/` exactly as in local mode; worker machines write only `runtime/workers/` there. Claims are service-side, so no `assignments.json` exists in fleet mode.

## Shared coordination board

A small workspace-scoped Kanban board, separate from lifecycle state. Board tasks may link to an AI-DLC task ID or artifact, but board writes, comments, and claims cannot mutate lifecycle state, approve a gate, or rewrite project files.

- Bounded MCP tools: `board_get`, `board_apply`, `task_thread_get`, `task_comment_add`, `task_claim`, `coordination_events_since`.
- Status `backlog`, `ready`, `in_progress`, `blocked`, `done`, or `cancelled`, plus priority, labels, assignees, and renewable one-minute-to-one-hour claims.
- Mutations require an expected board revision, idempotency key, actor ID, and role; a conflicting live claim is rejected.
- Threads: short append-only comments with author type, optional mentions, and `question`, `status`, `handoff`, or `decision` intent; never credentials, hidden reasoning, chat, or gate approvals.
- Clients poll compact cursor events, coalesce them, and read details only for assignment, mention, watched-task, explicit-user, or claim-expiry activity, always after a fresh revision check.

### `state_apply` contract

- Every write needs an `expectedRevision`, an `idempotencyKey`, and an absolute `clientProjectRoot`. The root only formats portable `nextActions` (absolute script paths, explicit `--root`); it grants no filesystem access or authority.
- A stale revision returns the current projection for pull/rebase; a retry with the same idempotency key returns the original committed result.
- Responses include `nextActions` for touched tasks, so remote callers follow the same item loop and stop classifications as the local CLI.
- SQLite uses an immediate transaction and busy timeout; PostgreSQL locks the workspace row in a transaction.

Lifecycle invariants are checked across the whole before/after snapshot, not only touched task IDs:

- Evidence is append-only: the prior evidence array must remain an exact structural prefix (field-wise; key order is free, record order is not).
- A validated `blocked_on_user` wait cannot be deleted; while a task waits, every non-evidence field (items, decisions, artifacts, …) is frozen.
- Leaving a wait requires, in the same mutation, one of: a passing approval for that exact gate; gate-bound cancellation evidence with a non-empty source; or a sourced closure/handoff record (`closed`/`superseded` with closure metadata, `paused` with handoff metadata). One compatibility recovery mirrors the local CLI: an invalid wait at the gateless wrap phase may return to `active` with no appended evidence; it is not a human approval.
- A snapshot that requests or holds `blocked_on_user` while shared predicates still require planning, items, verification, review, or an unexhausted repair bound is rejected.
- The `legacyG2Wait` repair-bound exemption marker is migration-owned: stamped only when upgrading a stored pre-v4 row; client mutations creating or changing it are rejected.

In default shared-token mode these guards keep history tamper-evident but do not authenticate approvals: `source` is client-supplied provenance. Fleet mode binds lead, worker, and reviewer credentials to server-side roles; only a reviewer credential can call the atomic gate approval tool. The service cannot inspect client artifacts: the lead runs local artifact checks before publishing a review snapshot; the service enforces structural gate readiness and snapshot revision at approval.

`work_item_request` is only a credential-free preflight for Jira, Trello, or GitHub Issues: it reports the required environment variable names and never returns a reusable token, Authorization header, or token-bearing URL. External updates are opt-in, outside the lifecycle transaction.

## Service health, logging, and image

- `GET /healthz`: unauthenticated, static `200 {"ok":true}`, reads no state, version, or workspace data; registered before the auth middleware; used by the container `HEALTHCHECK` and compose healthchecks.
- Each request logs one JSON line to stderr: `{"ts":...,"method":...,"path":...,"status":...,"principal":...,"ms":...}` (`principal` omitted when absent). Never headers, bodies, or tokens.
- McpServer version: the `version` field of the `package.json` next to the service root (`new URL("../package.json", import.meta.url)`), fallback `"0.0.0-dev"` (source checkouts); the bundled image gets it by build-time injection.
- Image: two stages, both `node:24-bookworm-slim` (matching `better-sqlite3` ABI), non-root `node` user, `HEALTHCHECK` against `/healthz`; the compose `aidlc-coordination` and `fleet-coordination` services define matching healthchecks.

## Related

- [Loop setup runbook](./loop-runbook.md#fleet-multi-machine) — step-by-step fleet loop setup.
- [Configuration](./configuration.md) — the `mcp` and `loop` config blocks.
- [Command reference](./command-reference.md) — `mcp setup`, `loop`, and environment variables.
- [Troubleshooting](./troubleshooting.md#loop-leases-locks-and-claims) — leases, claims, and fleet conflicts.
