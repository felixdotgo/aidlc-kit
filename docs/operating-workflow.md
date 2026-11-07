# Operating the workflow

`aidlc-kit` gives an agent a repeatable delivery lifecycle — intent, design, implementation, final review — with a human approving each point where scope or risk changes. Settings: [Configuration](./configuration.md); exact flags: [Command reference](./command-reference.md).

## Lifecycle at a glance

```text
request → clarify → Confirm requirements → plan → Approve plan → build and verify → Review implementation → wrap → done
```

| Stage | Result | Human action |
| --- | --- | --- |
| Clarify | Intent, scope, assumptions, and open questions | Confirm the requirements. |
| Plan | Design, decisions, work items, and verification plan | Resolve decisions and approve the plan. |
| Build | Approved change, verification, and adversarial review | Review the completed change at Review implementation. |
| Wrap | Delivery notes, lessons, and residual risk | Runs only after Review implementation approval. |

- The agent continues after every non-terminal transition and item or evidence mutation (completing one item is progress, not a turn boundary) and stops only for a gate ready for human action, a durable blocker, a terminal non-success outcome, or completion.
- The client conversation (Codex, Claude Code, or OpenCode) is the lead: it dispatches native agents for independent items and presents each gate. After a restart, ask it to resume the task ID; it rereads `task next`, inspects assignment records and worktree results, and continues dependency-ready work only.

Related tasks can form a feature graph:

```sh
node .agents/aidlc/scripts/state.mjs feature create checkout --branch feature/checkout
node .agents/aidlc/scripts/state.mjs feature link checkout checkout-api
node .agents/aidlc/scripts/state.mjs feature link checkout checkout-ui
node .agents/aidlc/scripts/state.mjs feature link checkout checkout-integration --depends-on checkout-api,checkout-ui
node .agents/aidlc/scripts/state.mjs feature ready checkout
node .agents/aidlc/scripts/state.mjs task ready checkout-api
```

- Task IDs must exist before `feature link`; add a sibling with `task create <id> --title <title> --feature checkout [--depends-on <task-id,...>]`. Each task passes its own G0/G1/G2.
- Build items declare `--depends-on <item-id,...>` via `task item`; `task ready` lists dispatchable items. Missing, cyclic, or incomplete dependencies are rejected.

Unattended multi-machine work uses the optional coordination service as sole canonical authority: [Coordination service](./coordination-service.md#multi-machine-loop-deployment).

## Parallel workstreams

- The lead may delegate independent, bounded workstreams when the host has spare worker capacity: keep one slot, assign explicit ownership and completion criteria, integrate returned work before relying on it.
- The lead is the only writer for task state, evidence, review artifacts, and gates; parallel work never relaxes approvals.
- A build batch holds only items with non-overlapping file/area ownership; shared surfaces, integration, task-wide verification, and adversarial review stay lead-owned.

## Starting work

Make a normal change request, for example `Add rate limiting to the login endpoint using the AI-DLC workflow.` The adapter creates the task, writes an intent brief, and presents Confirm requirements. A partial implementation is not approved work; a passing test is not approval at Review implementation.

## State and review artifacts

Project data: `.agents/data/`; package-managed workflow: `.agents/aidlc/`. Never hand-edit lifecycle state:

```sh
node .agents/aidlc/scripts/state.mjs task list --limit 20
node .agents/aidlc/scripts/state.mjs task find --query "rate limiting" --include-archive
node .agents/aidlc/scripts/state.mjs task show <task-id>
node .agents/aidlc/scripts/state.mjs task next <task-id>
node .agents/aidlc/scripts/gate-view.mjs <task-id>
```

`task next` is the authoritative next instruction; `gate-view` renders the review packet for every gate.

### Script contract in brief

- Every `state.mjs` and `task-next.mjs` command prints one JSON envelope `{ok, result, nextAction?}`; failures are one-line `{ok: false, error}` on stderr with exit code `1` (expected), `2` (continuation guard), or `3` (crash).
- Before any final response, run `task-next.mjs <task-id> --require-stop`; exit code `2` means execute `continuation.command` instead of replying. Recover from a premature reply with `task next <task-id>` in the next turn — never by re-approving a gate.
- Rendering, gate-check, and context commands may print Markdown or plain text instead of JSON.
- In build, `nextAction` names the next `in_progress` or `todo` item and stays `run_phase` after the last item until verification, adversarial review, and gate preparation finish.
- Options, root discovery, warnings, and the full envelope are in [Installed lifecycle scripts](./command-reference.md#installed-lifecycle-scripts).

### Task switch guard

- `task create` fails closed while another task is actionable until the agent passes the returned `--switch-from` acknowledgement with explicit user direction; this stamps a resume-marker diagnostic on the acknowledged task without mutating it.
- The coordination service does not enforce this guard (remote `upsertTask`/`replaceState` can add tasks alongside actionable work); MCP-backed hosts rely on the adapter protocol.

## Review steps and approvals

Review-step names are English in every task; internal IDs are stable. Identify gates by `gate`, never by display text (`title`, `action`).

| Review step | Internal gate ID |
| --- | --- |
| Confirm requirements | `G0_confirm` |
| Approve plan | `G1_review` |
| Review implementation | `G2_codereview` |

```sh
node .agents/aidlc/scripts/state.mjs gate approve <task-id> --gate <gate-name> --source "<explicit approval>"
```

- Approval is an explicit human action, recorded and advanced atomically by `gate approve` — the only command that creates approval evidence. Never invent approvals or approve unresolved design decisions.
- `--source` is provenance, not authentication. Call `gate approve` only in a later user turn that explicitly assents to the gate currently shown.
- Approve plan starts a build boundary; the verification, adversarial review, and Review implementation approval that enter wrap must belong to the current boundary.
- Reopening the plan invalidates Approve plan and Review implementation approvals, resets every non-deferred build item to `todo`, and requires current-build verification and review.
- Evidence is append-only; the current boundary is identified by evidence order, not timestamps.
- Per affected area: at least one `test` or `lint` result, and the latest result of every verification kind present must pass.
- Archiving commits the immutable record before the compact catalog; a retry recovers the interrupted-write window only when the catalog still proves the same active task and the orphan record has the same stable identity. Other conflicts need investigation, not overwrite.
- Rendered workplans are derived views, replaced atomically under the state lock by the standalone render command.

## Blocked work and successors

`blocked_on_user` means a valid human gate is ready, never that a failed change awaits a rubber stamp. When verification or review cannot pass, record a durable handoff:

- **Validation.** Wrap has no human gate and rejects `blocked_on_user`; `task status` validates gate prerequisites before persisting it, and `gate-view` refuses an active or unready task.
- **Leaving a gate wait.** Requires audited reason and source metadata plus diagnostic evidence; sourced closure and handoff records give the terminal trail.
- **Compatibility paths.** Only migration-stamped legacy Review implementation waits and recovery of an invalid `wrap`/`none` wait are exempt; neither is an approval. `legacyG2Wait` is written only by state-schema migration (`state.mjs state migrate` or a human-run installer upgrade), exempts only a still-ready pre-existing wait from the repair bound, and is cleared by every route out of the wait.
- **Repair bounds.** Three failed verify records per area or two failed review records in the current build flip `nextAction` to `blocked` and close Review implementation with `REPAIR_BOUND` until a durable handoff is recorded.

```sh
node .agents/aidlc/scripts/state.mjs task handoff <task-id> --kind <kind> --reason "<reason>" --source "<evidence>"
node .agents/aidlc/scripts/state.mjs task reopen <task-id> --to plan --reason "<reason>" --source "<explicit request>"
node .agents/aidlc/scripts/state.mjs task close <task-id> --reason "<reason>" --source "<explicit request>"
```

To continue in a fresh task, create it at Confirm requirements and link it as a successor. `closed` and `superseded` are terminal non-success outcomes: no approvals transfer, no delivery is implied.

## Operational rules

- The installed workflow never downloads runtime assets or checks a registry.
- Only a human may initiate or apply workflow upgrades.
- A status label never substitutes for test or review evidence.
- Put project-specific behaviour in project configuration or local rules, never in the package-managed kernel.

## Optional end-to-end loop

> [!WARNING]
> Experimental, pre-1.0. See [Status and stability](./loop-runbook.md#status-and-stability).

- With `loop.mode` enabled, `aidlc-kit loop start` (local: `./.agents/aidlc/scripts/loop.sh up`) runs one singleton daemon per project; it reads no requirement, runs only loop-owned tasks, and auto-resumes actionable ones.
- Add tasks with `aidlc-kit loop intake` (requirement on stdin) or the dashboard **New task**; the same ID and requirement reuse the task. There is no `loop resume`: re-activate with the dashboard **resume** or `state.mjs task status <id> --status active`.
- After a restart the daemon reconciles from canonical state; a consumed, stale, or mismatched checkpoint stops for manual reconciliation. A paused or handed-off task, outdated snapshot, or uncertain Git result is never auto-resumed.
- The loop never approves a gate: local mode uses the trusted terminal `loop-gate.mjs` or the signed-in dashboard, fleet mode only the reviewer credential.
- Leads and workers may be `codex`, `claude`, or `opencode`; only the container-isolated lead rejects OpenCode. Any `opencode` provider needs `AIDLC_OPENCODE_MODEL` ([Provider credentials and OpenCode](./configuration.md#provider-credentials-and-opencode)).

## Related

- [Loop setup runbook](./loop-runbook.md) — loop setup.
- [Local loop walkthrough](./loop-local-run.md) — local loop operation.
- [Command reference: `loop`](./command-reference.md#loop) — loop actions and environment.
- [Configuration](./configuration.md) — project, loop, and adapter settings.
