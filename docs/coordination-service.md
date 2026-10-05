# AI-DLC Coordination service

The optional AI-DLC Coordination service is a separate Docker-deployable authority for a workflow workspace. It is disabled by default: without an enabled `mcp` block, installed lifecycle scripts remain local and make no network calls.

## Safe setup

Preview a configuration first. Outside an interactive terminal, provide all four selection flags.

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow mcp setup . --dry-run \
  --deployment docker --storage sqlite --bind localhost --workspace engineering
```

This command uses the npm package at version `0.0.1`. To run from a source checkout instead, see the [development guide](./development.md).

Remove `--dry-run` and confirm to create `.agents/aidlc-coordination/` and update `.agents/config.json`. Setup does not start Docker. Copy `.env.example` to a secret-managed `.env`, review it, then start explicitly:

```sh
docker compose --env-file .agents/aidlc-coordination/.env -f .agents/aidlc-coordination/compose.yaml up -d
```

Use SQLite only on the local Docker volume. Use PostgreSQL for multiple hosts. A network bind requires `MCP_STATE_AUTH_TOKEN` and TLS/reverse-proxy termination; never commit either the `.env` file or provider credentials.

## State and synchronization contract

When enabled, the remote workspace is canonical. Import/export is an explicit recovery or migration action; there is no background dual-write or local fallback during an outage. Clients pull a revision or poll `state_events_since`; the service provides neither realtime subscriptions nor push notifications.

## Shared coordination board

The opt-in service also provides a small workspace-scoped Kanban board that is separate from lifecycle state. Board tasks may link to an AI-DLC task ID or artifact, but board writes, comments, and claims cannot mutate lifecycle state, approve a gate, or rewrite project files.

`board_get`, `board_apply`, `task_thread_get`, `task_comment_add`, `task_claim`, and `coordination_events_since` are bounded MCP tools. Tasks use `backlog`, `ready`, `in_progress`, `blocked`, `done`, or `cancelled`, plus priority, labels, assignees, and renewable one-minute-to-one-hour claims. Mutations require an expected board revision, idempotency key, actor ID, and role. A conflicting live claim is rejected.

Threads are short append-only comments with author type, optional mentions, and `question`, `status`, `handoff`, or `decision` intent. They never carry credentials, hidden reasoning, general chat, or gate approvals. Clients poll compact cursor events, coalesce and debounce them, then read details only for assignment, mention, watched-task, explicit-user, or claim-expiry activity. A notice always requires a fresh revision check before action.

Every `state_apply` write needs an `expectedRevision`, an `idempotencyKey`, and an absolute `clientProjectRoot`. The root is used only to format portable `nextActions` with absolute script paths and an explicit `--root`; it does not grant the server filesystem access or authority over that path. A stale revision returns the current projection for pull/rebase, and a retry with the same idempotency key returns the original committed result. Successful responses include `nextActions` for touched tasks so remote callers follow the same item loop and stop classifications as the local CLI.

The service checks lifecycle invariants across the whole before/after snapshot, not only touched task IDs. Existing evidence is append-only: the prior evidence array must remain an exact structural prefix (compared field-wise, so re-serialization key order does not matter, while record order still does). A validated `blocked_on_user` wait cannot be deleted, and while a task waits its readiness-bearing state (items, decisions, artifacts, and every other non-evidence field) is frozen; only evidence may be appended. Leaving a wait requires, in the same mutation, one of: a passing approval for that exact gate, gate-bound cancellation diagnostic evidence with a non-empty source, or a sourced closure/handoff record (`closed`/`superseded` with closure metadata, or `paused` with handoff metadata). The one compatibility recovery mirrors the local CLI: an invalid wait at the gateless wrap phase may return to `active` with no appended evidence; it is not a human approval. A snapshot that requests or holds `blocked_on_user` while shared lifecycle predicates still require planning, items, verification, review, or an unexhausted repair bound is rejected. The `legacyG2Wait` repair-bound exemption marker is migration-owned: the service stamps it only when upgrading a stored pre-v4 row, and rejects any client mutation that creates or changes it. SQLite uses an immediate transaction and busy timeout; PostgreSQL locks the workspace row in a transaction.

These guards keep remote history tamper-evident, but they do not authenticate approvals. The `source` on an approval record is provenance supplied by the client, not an authenticator: any client holding the shared token can append a well-formed approval and leave a wait. The service never runs the local `checkGate` against client artifacts (it has no access to `clientProjectRoot`), so gate predicates are enforced structurally at wait entry and through the parked-state freeze, not re-verified from artifacts at exit. Treat MCP approval records exactly like the local `gate approve --source` honor system, behind a token you protect.

`work_item_request` is intentionally only a credential-free preflight for Jira, Trello, or GitHub Issues. It reports the required environment variable names and never returns a reusable token, Authorization header, or token-bearing URL. External updates remain opt-in and must be made outside the lifecycle transaction.
