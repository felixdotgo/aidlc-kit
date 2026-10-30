# Operating the workflow

`aidlc-kit` gives an agent a repeatable delivery lifecycle. It separates intent, design, implementation, and final review so a human explicitly approves the points where scope or risk changes.

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

An agent continues after each non-terminal transition and after every item or evidence mutation. Completing one work item is a progress update, not a turn boundary: the agent consumes the returned `nextAction` and continues through the remaining items, verification, and review. It stops only for a gate that is ready for human action, a durable blocker, a terminal non-success outcome, or successful completion.

In ordinary use, ask Codex, Claude Code, or OpenCode to work on the feature in the same conversation. The client remains the lead, starts native agents for independent items, and presents each review gate in that conversation. After a restart, open the project and ask the client to resume the task ID. It rereads `task next`, inspects assignment records and worktree results, and continues only dependency-ready work. A human approval is still a later reply to the gate shown in that conversation.

For example, a feature with API, UI, and integration tasks can be recorded as a feature graph:

```sh
node .agents/aidlc/scripts/state.mjs feature create checkout --branch feature/checkout
node .agents/aidlc/scripts/state.mjs feature link checkout checkout-api
node .agents/aidlc/scripts/state.mjs feature link checkout checkout-ui
node .agents/aidlc/scripts/state.mjs feature link checkout checkout-integration --depends-on checkout-api,checkout-ui
node .agents/aidlc/scripts/state.mjs feature ready checkout
node .agents/aidlc/scripts/state.mjs task ready checkout-api
```

The task IDs must already exist before `feature link`. To create a new sibling in an existing feature, use `task create <id> --title <title> --feature checkout` and optionally `--depends-on <task-id,...>`. Each task still goes through its own G0/G1/G2. Build items can declare `--depends-on <item-id,...>` through `task item`; `task ready` reports which items can be dispatched. Dependencies that are missing, cyclic, or incomplete at completion are rejected.

For unattended work on multiple machines, deploy the optional coordination service with PostgreSQL, distinct lead/worker/reviewer credentials, a shared Git remote, and supervised coordinator/worker processes. The remote workspace is the sole canonical authority for that run. A worker claims a bounded assignment, commits and pushes within its owned paths, and reports its commit. The lead verifies and integrates it before marking the item done. Restarted processes reread canonical state and fenced leases; uncertain results are checked before retry. At G0/G1/G2 the coordinator publishes a review snapshot and waits for a reviewer in a connected client. It cannot grant its own approval.

## Parallel workstreams

At any phase, the lead agent may use the orchestration contract to delegate independent, bounded workstreams when the host has spare worker capacity. The lead keeps one slot, assigns explicit ownership and completion criteria, and integrates returned work before relying on it. It remains the only writer for task state, evidence, review artifacts, and gates. In build, a batch may contain only items with non-overlapping file/area ownership; shared surfaces, integration, task-wide verification, and adversarial review remain lead-owned. Parallel work never changes the approval or lifecycle requirements described below.

## Starting work

After installation, make a normal change request to the selected coding agent. For example:

```text
Add rate limiting to the login endpoint using the AI-DLC workflow.
```

The adapter creates a task, writes an intent brief, and presents Confirm requirements. Do not treat a partial implementation as approved work before Approve plan, and do not treat a passing test as approval at Review implementation.

## State and review artifacts

Each installed project owns its data under `.agents/data/`. Package-managed workflow instructions live under `.agents/aidlc/`; project configuration, local rules, and evidence are project-owned. The package supports Codex, Claude Code, and OpenCode. Do not hand-edit lifecycle state: use the installed scripts instead.

```sh
node .agents/aidlc/scripts/state.mjs task list --limit 20
node .agents/aidlc/scripts/state.mjs task find --query "rate limiting" --include-archive
node .agents/aidlc/scripts/state.mjs task show <task-id>
node .agents/aidlc/scripts/state.mjs task next <task-id>
node .agents/aidlc/scripts/gate-view.mjs <task-id>
```

`task next` is the authoritative instruction for what happens next. `gate-view` renders the review packet consistently for Confirm requirements, Approve plan, and Review implementation.

Lifecycle options support both `--name value` and `--name=value` in any order. Invalid options and command shapes fail before lock or state access. From a project subdirectory, an omitted `--root` selects the nearest ancestor containing `.agents/aidlc/`; outside an installed project the command fails without creating `.agents`. Use explicit `--root` to select a different installed project.

Every `state.mjs` and `task-next.mjs` command returns one JSON envelope `{ok, result, nextAction?}`. Rendering, gate-check, and context commands may produce Markdown or plain text. All failures use one-line `{ok: false, error}` records on stderr with typed exit codes (`1` expected, `2` continuation guard, `3` crash). During build, the action identifies the next `in_progress` or `todo` item; after all items are terminal it still returns `run_phase` until verification, adversarial review, and Review implementation preparation finish. Before any final response, the agent runs `task-next.mjs <task-id> --require-stop` and parses its machine-readable `continuation` object; exit code `2` (`continuation.code = CONTINUATION_REQUIRED`) means it must execute `continuation.command` instead of replying. This guard is detection, not hard prevention: no package-owned hook can intercept a message the model host has already emitted, so the residual risk is a premature final response that the host must recover from by running `task next <task-id>` in its very next turn and executing the returned command — never by re-approving a gate. Creating a new task while another is actionable is likewise fail-closed at the local CLI: `task create` rejects it until the agent passes the returned `--switch-from` acknowledgement with explicit user direction, which stamps a resume-marker diagnostic on the acknowledged task instead of mutating it. The optional AI-DLC Coordination service does not enforce this switch guard; remote `upsertTask`/`replaceState` can still add tasks alongside actionable work, so MCP-backed hosts rely on the adapter protocol for switch discipline.

## Review steps and approvals

Review-step names are English in every task. Internal IDs remain unchanged for commands and structured state:

| Review step | Internal gate ID |
| --- | --- |
| Confirm requirements | `G0_confirm` |
| Approve plan | `G1_review` |
| Review implementation | `G2_codereview` |

Display text such as JSON `title` and `action` uses these names; integrations should identify gates by `gate`, not by display text.

Approval is an explicit human action. When the agent receives an approval, it records the approval and advances the lifecycle atomically:

```sh
node .agents/aidlc/scripts/state.mjs gate approve <task-id> --gate <gate-name> --source "<explicit approval>"
```

Do not invent approvals or approve unresolved design decisions. Approval evidence can be created only by `gate approve`; generic evidence recording cannot manufacture it. A passing approval at Approve plan starts a build boundary. Verification, adversarial review, and approval at Review implementation used to enter wrap must all belong to the current boundary.

`--source` records provenance; it is not authentication or proof of consent. The local CLI enforces lifecycle structure, while the host agent must call `gate approve` only in a later user turn that explicitly assents to the gate currently shown.

A reopened plan invalidates prior approvals at Approve plan and Review implementation, resets every non-deferred build item to `todo`, and requires current-build verification and review. Evidence is append-only, so the runtime identifies the current boundary by evidence order instead of trusting timestamps. For each affected area, at least one `test` or `lint` result is required and the latest result of every verification kind present must pass; one kind cannot hide a failure in the other.

Terminal archiving commits the immutable record before the compact catalog. A retry may recover the narrow interrupted-write window only when the catalog still proves the same task is active and the unreferenced record has the same stable identity. Other archive conflicts require investigation rather than overwrite. Rendered workplans are derived views and are replaced atomically under the same state lock when rendered by the standalone command.

## Blocked work and successors

`blocked_on_user` means a valid human gate is ready; wrap has no human gate and rejects it. The status command validates gate prerequisites before persisting it, and `gate-view` refuses to present an active or unready task. Ordinary exits from a validated human-gate wait require audited reason and source metadata plus diagnostic evidence; sourced closure and handoff records provide the corresponding terminal trail. The two compatibility paths are migration-stamped legacy Review implementation waits and recovery of an invalid `wrap`/`none` wait; neither is a human approval. The `legacyG2Wait` marker is written only by state-schema migration (`state.mjs state migrate` or a human-run installer upgrade), only exempts a still-ready pre-existing wait from the repair bound, and is cleared by every route out of the wait. Repair bounds are machine-enforced: three failed verify records per area or two failed review records in the current build flip `nextAction` to `blocked` and close Review implementation with `REPAIR_BOUND` until a durable handoff is recorded. It does not mean a failed change is waiting for a rubber stamp. When verification or review cannot pass, the workflow records a durable handoff and offers structured options.

```sh
node .agents/aidlc/scripts/state.mjs task handoff <task-id> --kind <kind> --reason "<reason>" --source "<evidence>"
node .agents/aidlc/scripts/state.mjs task reopen <task-id> --to plan --reason "<reason>" --source "<explicit request>"
node .agents/aidlc/scripts/state.mjs task close <task-id> --reason "<reason>" --source "<explicit request>"
```

If work continues in a fresh task, create that task at Confirm requirements and link it as a successor. `closed` and `superseded` are terminal non-success outcomes; they do not transfer approvals or imply a completed delivery.

## Operational rules

- The installed workflow never downloads runtime assets or checks a registry.
- Only a human may initiate or apply workflow upgrades.
- Keep task artifacts and verification evidence honest; a status label never substitutes for test or review evidence.
- Put project-specific behaviour in project configuration or local rules, not in the package-managed workflow kernel.

See [Configuration](./configuration.md) for project customisation and [Command reference](./command-reference.md) for package commands.


## Optional end-to-end loop

When the project enables `loop.mode`, `aidlc-kit loop start` accepts a requirement once (interactive prompt or stdin), creates exactly one task under the configured authority, and runs the loop to the first gate or to completion. `loop status` reports the canonical task and gate checkpoint; `loop resume` continues after an interruption. The intake is idempotent: re-running `start` with the same task ID and requirement reuses the existing task, and it refuses to create a second task while another one is actionable.

The loop never approves a gate itself. At each gate it publishes the review packet and waits; in local mode approval happens only through the trusted host terminal command, and in fleet mode only through the reviewer credential against the published snapshot and revision. After a real approval the running supervisor re-reads the canonical state and checkpoint, re-acquires its fenced lease, and resumes automatically. If the supervisor is not running at approval time, restart it and it reconciles from the checkpoint; a consumed, stale, or mismatched checkpoint stops for manual reconciliation instead of guessing. Restarting never resumes a paused or handed-off task, an outdated snapshot, or an uncertain Git result — those require the documented recovery actions.

The supervisor runs in the foreground or under a process supervisor you choose; there is no background daemon. Workers execute in Docker with their own scoped credentials and never inherit host access. Host-executed lead turns support `codex`, `claude`, or `opencode`; container-isolated lead turns, local Docker worker batches, and fleet worker containers reject `opencode` because it requires file-based credentials, returning `OpenCode workers require file-based credentials and are not available in isolated containers yet` instead of falling back to the host. When the loop uses `opencode`, set `AIDLC_OPENCODE_MODEL` to a `provider/model[#variant]` value. See [Command reference](./command-reference.md) for the loop commands and environment, and [Coordination service](./coordination-service.md) for fleet deployment, backends, and recovery.
