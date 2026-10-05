# Operating the workflow

`aidlc-kit` gives an agent a repeatable delivery lifecycle. It separates intent, design, implementation, and final review so a human explicitly approves the points where scope or risk changes.

## Lifecycle at a glance

```text
request → clarify → G0 → plan → G1 → build and verify → G2 → wrap → done
```

| Stage | Result | Human action |
| --- | --- | --- |
| Clarify | Intent, scope, assumptions, and open questions | Approve G0. |
| Plan | Design, decisions, work items, and verification plan | Resolve decisions and approve G1. |
| Build | Approved change, verification, and adversarial review | Review the completed change at G2. |
| Wrap | Delivery notes, lessons, and residual risk | Runs only after G2 approval. |

An agent continues after each non-terminal transition and after every item or evidence mutation. Completing one work item is a progress update, not a turn boundary: the agent consumes the returned `nextAction` and continues through the remaining items, verification, and review. It stops only for a gate that is ready for human action, a durable blocker, a terminal non-success outcome, or successful completion.

## Parallel workstreams

At any phase, the lead agent may use the orchestration contract to delegate independent, bounded workstreams when the host has spare worker capacity. The lead keeps one slot, assigns explicit ownership and completion criteria, and integrates returned work before relying on it. It remains the only writer for task state, evidence, review artifacts, and gates. In build, a batch may contain only items with non-overlapping file/area ownership; shared surfaces, integration, task-wide verification, and adversarial review remain lead-owned. Parallel work never changes the approval or lifecycle requirements described below.

## Starting work

After installation, make a normal change request to the selected coding agent. For example:

```text
Add rate limiting to the login endpoint using the AI-DLC workflow.
```

The adapter creates a task, writes an intent brief, and presents G0. Do not treat a partial implementation as approved work before G1, and do not treat a passing test as approval at G2.

## State and review artifacts

Each installed project owns its data under `.agents/data/`. Package-managed workflow instructions live under `.agents/aidlc/`; project configuration, local rules, and evidence are project-owned. The package supports Codex and Claude Code only. Do not hand-edit lifecycle state: use the installed scripts instead.

```sh
node .agents/aidlc/scripts/state.mjs task list --limit 20
node .agents/aidlc/scripts/state.mjs task find --query "rate limiting" --include-archive
node .agents/aidlc/scripts/state.mjs task show <task-id>
node .agents/aidlc/scripts/state.mjs task next <task-id>
node .agents/aidlc/scripts/gate-view.mjs <task-id>
```

`task next` is the authoritative instruction for what happens next. `gate-view` renders the review packet consistently for G0, G1, and G2.

Lifecycle options support both `--name value` and `--name=value` in any order. Invalid options and command shapes fail before lock or state access. From a project subdirectory, an omitted `--root` selects the nearest ancestor containing `.agents/aidlc/`; outside an installed project the command fails without creating `.agents`. Use explicit `--root` to select a different installed project.

Every `state.mjs` and `task-next.mjs` command returns one JSON envelope `{ok, result, nextAction?}`. Rendering, gate-check, and context commands may produce Markdown or plain text. All failures use one-line `{ok: false, error}` records on stderr with typed exit codes (`1` expected, `2` continuation guard, `3` crash). During build, the action identifies the next `in_progress` or `todo` item; after all items are terminal it still returns `run_phase` until verification, adversarial review, and G2 preparation finish. Before any final response, the agent runs `task-next.mjs <task-id> --require-stop` and parses its machine-readable `continuation` object; exit code `2` (`continuation.code = CONTINUATION_REQUIRED`) means it must execute `continuation.command` instead of replying. This guard is detection, not hard prevention: no package-owned hook can intercept a message the model host has already emitted, so the residual risk is a premature final response that the host must recover from by running `task next <task-id>` in its very next turn and executing the returned command — never by re-approving a gate. Creating a new task while another is actionable is likewise fail-closed at the local CLI: `task create` rejects it until the agent passes the returned `--switch-from` acknowledgement with explicit user direction, which stamps a resume-marker diagnostic on the acknowledged task instead of mutating it. The optional AI-DLC Coordination service does not enforce this switch guard; remote `upsertTask`/`replaceState` can still add tasks alongside actionable work, so MCP-backed hosts rely on the adapter protocol for switch discipline.

## Gates and approvals

Approval is an explicit human action. When the agent receives an approval, it records the approval and advances the lifecycle atomically:

```sh
node .agents/aidlc/scripts/state.mjs gate approve <task-id> --gate <gate-name> --source "<explicit approval>"
```

Do not invent approvals or approve unresolved design decisions. Approval evidence can be created only by `gate approve`; generic evidence recording cannot manufacture it. A passing G1 approval starts a build boundary. Verification, adversarial review, and G2 approval used to enter wrap must all belong to the current boundary.

`--source` records provenance; it is not authentication or proof of consent. The local CLI enforces lifecycle structure, while the host agent must call `gate approve` only in a later user turn that explicitly assents to the gate currently shown.

A reopened plan invalidates the prior G1 and G2 approvals, resets every non-deferred build item to `todo`, and requires current-build verification and review. Evidence is append-only, so the runtime identifies the current boundary by evidence order instead of trusting timestamps. For each affected area, at least one `test` or `lint` result is required and the latest result of every verification kind present must pass; one kind cannot hide a failure in the other.

Terminal archiving commits the immutable record before the compact catalog. A retry may recover the narrow interrupted-write window only when the catalog still proves the same task is active and the unreferenced record has the same stable identity. Other archive conflicts require investigation rather than overwrite. Rendered workplans are derived views and are replaced atomically under the same state lock when rendered by the standalone command.

## Blocked work and successors

`blocked_on_user` means a valid human gate is ready; wrap has no human gate and rejects it. The status command validates gate prerequisites before persisting it, and `gate-view` refuses to present an active or unready task. Ordinary exits from a validated human-gate wait require audited reason and source metadata plus diagnostic evidence; sourced closure and handoff records provide the corresponding terminal trail. The two compatibility paths are migration-stamped legacy G2 waits and recovery of an invalid `wrap`/`none` wait; neither is a human approval. The `legacyG2Wait` marker is written only by state-schema migration (`state.mjs state migrate` or a human-run installer upgrade), only exempts a still-ready pre-existing wait from the repair bound, and is cleared by every route out of the wait. Repair bounds are machine-enforced: three failed verify records per area or two failed review records in the current build flip `nextAction` to `blocked` and close G2 with `REPAIR_BOUND` until a durable handoff is recorded. It does not mean a failed change is waiting for a rubber stamp. When verification or review cannot pass, the workflow records a durable handoff and offers structured options.

```sh
node .agents/aidlc/scripts/state.mjs task handoff <task-id> --kind <kind> --reason "<reason>" --source "<evidence>"
node .agents/aidlc/scripts/state.mjs task reopen <task-id> --to plan --reason "<reason>" --source "<explicit request>"
node .agents/aidlc/scripts/state.mjs task close <task-id> --reason "<reason>" --source "<explicit request>"
```

If work continues in a fresh task, create that task at G0 and link it as a successor. `closed` and `superseded` are terminal non-success outcomes; they do not transfer approvals or imply a completed delivery.

## Operational rules

- The installed workflow never downloads runtime assets or checks a registry.
- Only a human may initiate or apply workflow upgrades.
- Keep task artifacts and verification evidence honest; a status label never substitutes for test or review evidence.
- Put project-specific behaviour in project configuration or local rules, not in the package-managed workflow kernel.

See [Configuration](./configuration.md) for project customisation and [Command reference](./command-reference.md) for package commands.
