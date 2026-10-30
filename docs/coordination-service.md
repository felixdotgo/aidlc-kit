# AI-DLC Coordination service

> [!WARNING]
> The coordination service (and the end-to-end loop that builds on it) is **experimental and unfinished**: it contains known bugs and rough edges. The package is pre-1.0 (`0.x`), so setup flags, `mcp.*`/`loop.*` configuration, endpoints, environment variables, and storage behaviour can change incompatibly in any release before `1.0.0`. Do not treat it as a stable dependency yet.

The optional AI-DLC Coordination service is a separate Docker-deployable authority for a workflow workspace. It is disabled by default: without an enabled `mcp` block, installed lifecycle scripts remain local and make no network calls.

## Safe setup

Preview a configuration first. Outside an interactive terminal, provide all four selection flags.

```sh
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit mcp setup . --dry-run \
  --deployment docker --storage sqlite --bind localhost --workspace engineering
```

This command uses the npm package at version `0.1.1`. To run from a source checkout instead, see the [development guide](./development.md).

Remove `--dry-run` and confirm to create `.agents/aidlc-coordination/` and update `.agents/config.json`. Setup does not start Docker. Copy `.env.example` to a secret-managed `.env`, review it, then start explicitly:

```sh
docker compose --env-file .agents/aidlc-coordination/.env -f .agents/aidlc-coordination/compose.yaml up -d
```

Use SQLite only on the local Docker volume. Use PostgreSQL for multiple hosts. A network bind requires `MCP_STATE_AUTH_TOKEN` and TLS/reverse-proxy termination; never commit either the `.env` file or provider credentials.

## State and synchronization contract

When enabled, the remote workspace is canonical. Import/export is an explicit recovery or migration action; there is no background dual-write or local fallback during an outage. Clients pull a revision or poll `state_events_since`; the service provides neither realtime subscriptions nor push notifications.

## Multi-machine loop deployment

The fleet service supports both approved storage backends: SQLite through one coordination service on one host with the database on a local volume (set `MCP_STATE_DATABASE=sqlite`, the default, and `MCP_STATE_SQLITE_PATH`), and PostgreSQL for deployments spanning multiple hosts or service instances. Each deployment keeps its chosen backend; there is no implicit fallback or migration between them. SQLite limits availability and write concurrency to that single host. Do not switch an existing authority automatically; follow the supported deployment below.

Fleet mode is separate from the default local service profile. The source checkout keeps its deployment template in `services/aidlc-coordination/`; human-run `mcp setup` copies it into the target project's `.agents/aidlc-coordination/`. Copy that directory's `.env.fleet.example` to a private `.env`, set the database choice and three distinct credential classes (`MCP_FLEET_LEAD_TOKEN`, `MCP_FLEET_REVIEWER_TOKEN`, and the worker-ID-to-token JSON map `MCP_FLEET_WORKER_TOKENS`), then start the fleet profile. From a source checkout:

```sh
docker compose --env-file .env --profile fleet -f services/aidlc-coordination/compose.yaml up -d fleet-coordination
```

For an installed project, use `-f .agents/aidlc-coordination/compose.yaml` instead.

The default host binding is `127.0.0.1:8788`. For workers on other machines, expose `POST /mcp` through a TLS reverse proxy and set the binding deliberately. Fleet mode requires the chosen database backend and a shared Git remote. Give each worker an isolated worktree, a scoped branch, and its own worker credential. A process supervisor must restart the supervisor, lead, and workers; after restart they reacquire fenced leases and reconcile reported or uncertain Git results before retrying.

The lead credential can advance lifecycle state only while holding the current task epoch. Worker credentials can claim, checkpoint, and report assigned jobs but cannot mutate lifecycle state or approve gates. The reviewer credential can read pending gate snapshots and record a later explicit human approval against the snapshot and current revision. When the database, Git remote, or reviewer is unavailable, the run waits or fails closed; it does not fall back to local state.

The installed remote lifecycle client needs `AIDLC_FLEET_URL` (the full HTTPS `/mcp` URL), `AIDLC_FLEET_WORKSPACE`, and `AIDLC_FLEET_PROJECT_ROOT` (absolute). Lead mutations also need `AIDLC_FLEET_TOKEN` and the current `AIDLC_FLEET_LEAD_EPOCH` from its claim.

Create the task records before the remote feature manifest. For each task, claim a lead epoch, export the returned `epoch`, then create it with the feature ID; repeat for sibling tasks. Once both records exist, create and link the manifest:

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

The service checks that every manifest member has a canonical task record with the matching feature ID. A partially created task stays fail-closed until the manifest is completed. The lead epoch is task-specific and must be refreshed after release or expiry.

In a connected reviewer conversation, configure `AIDLC_FLEET_REVIEWER_TOKEN`, inspect the pending packet, and only after the human replies approving that packet run:

```sh
node .agents/aidlc/scripts/remote-state.mjs gate inbox
node .agents/aidlc/scripts/remote-state.mjs gate approve <task-id> --snapshot <snapshot-id> --source "<explicit user approval>"
```

The second command checks that the snapshot remains current and uses the reviewer-only service operation. At G2 it also verifies that the snapshot's integration commit still matches the live remote branch. Protect the integration branch against writes outside the lead so it cannot change between verification and approval. The review message is the source provenance; the token authenticates the reviewer client, while the client operator remains responsible for using the user's actual later reply.

Run the packaged fleet process on a lead machine and worker machines under a process supervisor. Point every process to the same `AIDLC_FLEET_URL` and workspace, but give each its own role token. On the lead, set `AIDLC_FLEET_WORKER_IDS` (comma-separated), `AIDLC_FLEET_INTEGRATION_BRANCH`, and optionally `AIDLC_FLEET_AGENT` (`codex`, `claude`, or `opencode`); `AIDLC_FLEET_WORKER_PROVIDERS` can override the provider per worker. The `job_schedule` tool accepts the same three agent values, but worker containers reject `opencode` with `OpenCode workers require file-based credentials and are not available in isolated containers yet`. The explicit blocker is reported when the job executes; there is no silent host fallback. On each worker, set its matching `AIDLC_FLEET_WORKER_ID` and `AIDLC_FLEET_WORKTREES_ROOT`:

```sh
node dist/services/aidlc-coordination/src/fleet-run.mjs feature <feature-id>
node dist/services/aidlc-coordination/src/fleet-run.mjs worker
```

`coordinator <task-id>` runs one task. `--once` processes a bounded polling pass for supervision or diagnostics. Defaults are four worker jobs per feature, five-minute leases with one-minute heartbeat, 12 turns per phase or assignment, 10 minutes per turn, and two consecutive stalls. Set `AIDLC_FLEET_MAX_WORKERS`, `AIDLC_FLEET_LEASE_MS`, `AIDLC_FLEET_HEARTBEAT_MS`, `AIDLC_FLEET_MAX_TURNS`, `AIDLC_FLEET_TURN_TIMEOUT_MS`, and `AIDLC_FLEET_MAX_STALL_TURNS` to change them. Feature mode dispatches dependency-ready tasks in order from one integration checkout; independent items within the active task can use several machines concurrently. After a lost worker report, the lead checks remote Git state and stops for reconciliation if the outcome is ambiguous. Set `AIDLC_FLEET_CODE_ONLY_RETRY=1` to permit an automatic retry only after the prior turn's timeout window has elapsed and Git confirms that no branch was published.

The coordinator and feature commands return when a task reaches a human gate; feature mode stops before dispatching further tasks. After the reviewer acts, restart the command to continue. Command events and command-failure diagnostics report status and exit code without the command text or its output. Worker progress observes changes to file content as well as paths.

## Shared coordination board

The opt-in service also provides a small workspace-scoped Kanban board that is separate from lifecycle state. Board tasks may link to an AI-DLC task ID or artifact, but board writes, comments, and claims cannot mutate lifecycle state, approve a gate, or rewrite project files.

`board_get`, `board_apply`, `task_thread_get`, `task_comment_add`, `task_claim`, and `coordination_events_since` are bounded MCP tools. Tasks use `backlog`, `ready`, `in_progress`, `blocked`, `done`, or `cancelled`, plus priority, labels, assignees, and renewable one-minute-to-one-hour claims. Mutations require an expected board revision, idempotency key, actor ID, and role. A conflicting live claim is rejected.

Threads are short append-only comments with author type, optional mentions, and `question`, `status`, `handoff`, or `decision` intent. They never carry credentials, hidden reasoning, general chat, or gate approvals. Clients poll compact cursor events, coalesce and debounce them, then read details only for assignment, mention, watched-task, explicit-user, or claim-expiry activity. A notice always requires a fresh revision check before action.

Every `state_apply` write needs an `expectedRevision`, an `idempotencyKey`, and an absolute `clientProjectRoot`. The root is used only to format portable `nextActions` with absolute script paths and an explicit `--root`; it does not grant the server filesystem access or authority over that path. A stale revision returns the current projection for pull/rebase, and a retry with the same idempotency key returns the original committed result. Successful responses include `nextActions` for touched tasks so remote callers follow the same item loop and stop classifications as the local CLI.

The service checks lifecycle invariants across the whole before/after snapshot, not only touched task IDs. Existing evidence is append-only: the prior evidence array must remain an exact structural prefix (compared field-wise, so re-serialization key order does not matter, while record order still does). A validated `blocked_on_user` wait cannot be deleted, and while a task waits its readiness-bearing state (items, decisions, artifacts, and every other non-evidence field) is frozen; only evidence may be appended. Leaving a wait requires, in the same mutation, one of: a passing approval for that exact gate, gate-bound cancellation diagnostic evidence with a non-empty source, or a sourced closure/handoff record (`closed`/`superseded` with closure metadata, or `paused` with handoff metadata). The one compatibility recovery mirrors the local CLI: an invalid wait at the gateless wrap phase may return to `active` with no appended evidence; it is not a human approval. A snapshot that requests or holds `blocked_on_user` while shared lifecycle predicates still require planning, items, verification, review, or an unexhausted repair bound is rejected. The `legacyG2Wait` repair-bound exemption marker is migration-owned: the service stamps it only when upgrading a stored pre-v4 row, and rejects any client mutation that creates or changes it. SQLite uses an immediate transaction and busy timeout; PostgreSQL locks the workspace row in a transaction.

In default shared-token mode, these guards keep remote history tamper-evident but do not authenticate approvals: `source` remains provenance supplied by a client. Fleet mode binds separate lead, worker, and reviewer credentials to server-side roles, and only a reviewer credential can call the atomic gate approval tool. The service cannot inspect client project artifacts, so the lead must run local artifact checks before publishing a review snapshot; the service enforces structural gate readiness and snapshot revision at approval.

`work_item_request` is intentionally only a credential-free preflight for Jira, Trello, or GitHub Issues. It reports the required environment variable names and never returns a reusable token, Authorization header, or token-bearing URL. External updates remain opt-in and must be made outside the lifecycle transaction.

## Service health, logging, and image

The service exposes an unauthenticated, static `GET /healthz` that returns `200 {"ok":true}` without reading state, version, or workspace data. It is registered before the auth middleware and is used by the container `HEALTHCHECK` and compose healthchecks.

Every request emits one compact JSON line to stderr on response finish, of the form `{"ts":...,"method":...,"path":...,"status":...,"principal":...,"ms":...}` (principal is the fleet principal id when present, otherwise omitted). Logging never includes headers, request bodies, Authorization headers, or tokens.

The McpServer version is read from the `version` field of the `package.json` next to the service root (`new URL("../package.json", import.meta.url)`), falling back to `"0.0.0-dev"` when missing or unreadable. In source checkouts the service package has no version field, so the fallback applies; the bundled image receives the package version through build-time injection.

The container image is now built in two stages (both `node:24-bookworm-slim`, so the `better-sqlite3` ABI matches), installs dependencies in the build stage, and runs as the non-root `node` user with a `HEALTHCHECK` against `/healthz`. The compose `aidlc-coordination` and `fleet-coordination` services also define matching healthchecks.
