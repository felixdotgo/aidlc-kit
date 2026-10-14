# AI-DLC v1 Orchestrator

This file is the compact kernel contract. Project customization lives under `.agents/project/` (optional — create it when needed; the installer does not scaffold it); discovery indexes live under `.agents/data/index/`; the authoritative lifecycle store uses a compact `.agents/data/state/aidlc-state.json` catalog plus digest-validated terminal records under `.agents/data/state/archive/`; task prose and workplans are review artifacts, not mutable state.

## Turn routing

Personal-work capture, checkpoint and restore requests route to `work-intake`, `work-checkpoint` and `work-restore` utility skills. Read `work/conventions.md`; these are not lifecycle phases and do not automatically create implementation tasks. Explicit implementation selection returns to normal lifecycle routing below.

1. Use `node .agents/aidlc/scripts/state.mjs task list` (or `task find --query <text>`) for bounded routing. Never read or dump the canonical store directly. Use `task show <task-id>` only after selecting one task.
2. Resolve `node .agents/aidlc/scripts/state.mjs task next <task-id>` for an existing task; do not infer the next action from prose alone.
3. Classify the request as `NEW`, `RESUME`, `SWITCH`, or `OFF-WORKFLOW`.
   - A requested feature, bug fix, or project change is `NEW` unless canonical state already contains the matching unfinished task; a read-only explanation or inspection is `OFF-WORKFLOW`.
   - Bootstrap `NEW` with the exact user-supplied canonical ID when present: run `state.mjs task create`, then execute the clarify phase. `task next` applies only after canonical state exists. When the user supplies no ID, derive a short kebab-case slug from the title (lowercase letters, digits, hyphens; it must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, e.g. `fix-login-retry`) and reuse that exact ID for the whole lifecycle.
   - For `SWITCH`, preserve the current task. If it has a durable handoff, ask the user to reopen the Approve plan step, close it, or create a fresh successor at Confirm requirements and then supersede it; never mark failed work `done` or inherit approvals into the successor.
   - `task create` fails while another task is actionable (`nextAction` `run_phase`) and returns the actionable task(s) plus the exact `--switch-from <task-id>` acknowledgement. Pass that flag only with explicit user direction to switch; it records a resume-marker diagnostic on each acknowledged task and never pauses or mutates its lifecycle — the acknowledged task remains the authoritative resume target. This guard is local-CLI enforcement; the optional MCP state service does not enforce it.
4. For a task, request only its current phase packet with `node .agents/aidlc/scripts/context.mjs <task-id> --phase <phase>`. Do not load every workflow file.
5. Use `node .agents/aidlc/scripts/state.mjs` for lifecycle mutations when the active adapter policy is `scripted`. Gate approval always uses the atomic `gate approve` command when scripts are available. Native fallback must apply approval and transition as one logical transaction after the same checks.
6. A non-terminal transition is not a stopping point. Continue in the same turn until the next human gate, a real blocker, or completion; do not emit a final handoff between phases.
   After every lifecycle mutation, including item and evidence updates, parse the returned `nextAction`: execute `run_phase`, stop for `await_user`, `blocked`, or `terminal`, and treat only `complete` as successful completion. Completing an item or affected area is progress, not a stopping point; progress belongs in commentary, never a final response. `terminal` means closed/superseded without a success claim. Never convert this loop into automatic human approval.
   Immediately before any final response for a task, run `node .agents/aidlc/scripts/task-next.mjs <task-id> --require-stop` and parse its `continuation` object. Exit code 2 (`continuation.code = CONTINUATION_REQUIRED`) is a hard local guard: execute `continuation.command` instead of replying, and never convert the guard output into a final response or summary. This cannot technically intercept a message already emitted by a model host; if a premature final response slipped out, recover in the very next turn by running `state.mjs task next <task-id>` and executing its returned command — never re-approve a gate to catch up.
7. Use `node .agents/aidlc/scripts/render.mjs <task-id>` for the selected task review artifact. `--all` is explicit maintenance only. Never persist a second lifecycle-state projection such as `BOARD.md`.

Read-only questions remain off-workflow and do not create state. Multiple tasks may exist, but a session builds one task at a time.

## Review steps

- **Confirm requirements** (`G0_confirm`): the user confirms requirements and scope.
- **Approve plan** (`G1_review`): the user resolves every design decision and approves the plan.
- **Review implementation** (`G2_codereview`): verification and adversarial review have run; the user reviews the implementation.

Use these English names in user-facing communication and keep gate IDs for commands and structured state. The review-step names do not depend on the task language.

Before presenting a gate, run `node .agents/aidlc/scripts/gate-check.mjs <task-id> --gate <gate>`, set the validated wait with `node .agents/aidlc/scripts/state.mjs task status <task-id> --status blocked_on_user`, render the task artifact when the phase requires it, then run `node .agents/aidlc/scripts/gate-view.mjs <task-id>` and relay that output verbatim. Structural errors must be fixed. If Review implementation cannot pass or a repair bound is exhausted, record diagnostic evidence and use `task handoff`; do not set `blocked_on_user` or suggest gate approval. Semantic fidelity remains an LLM/human responsibility. Never mark work complete without executable evidence.

Transitions are enforced by the state machine. A gate may not be skipped, and unresolved decisions block build. Review implementation always requires human approval.

## Quality contract

- Inspect relevant files and specs before editing.
- Make the smallest approved change and preserve unrelated user work.
- Trace quantified rules, enumerations, and contracts to an exact source.
- Run the narrowest meaningful verification for every affected area.
- Review only the task diff against its approved decisions and spec anchors.
- Repair bounds (three verify cycles per area, two review passes) are machine-enforced from evidence: the bound hit flips `nextAction` to `blocked` and closes Review implementation with a `REPAIR_BOUND` error. Follow the returned handoff command and escalate with evidence.
- Structural changes discovered during build reopen the Approve plan step.

Economy models use the same bounded packet contract, gates, executable checks, and quality rules. Escalate to a stronger model or human for security, migrations, cross-service contracts, ambiguous specs, or exhausted repair bounds.

## Delegation contract

- At every phase entry and dependency boundary, the lead must triage whether independent, valuable work can proceed in parallel. Fan out only such work, and use at most the available collaboration slots minus the lead; keep dependent or low-value work local.
- The lead is the single writer for lifecycle state, gate actions, and task review artifacts. Workers never approve or present gates, mutate lifecycle records, or make canonical artifact decisions; every human-gate and state-machine invariant remains in force.
- Each worker assignment must name a bounded objective, owned paths or read-only scope, dependencies, expected verification, and required return output (summary, changed paths, evidence, and concerns). The lead integrates and verifies worker results before recording evidence or advancing the task.
- Assign one writer per path. Partition work so concurrent changes cannot overlap; workers may inspect shared files, but must report a needed cross-owner change to the lead rather than edit it. The lead resolves conflicts and performs final integration.

## Customization layers

Precedence is deterministic:

```text
kernel → built-in topology profile → local profile → project config/rules → approved task decisions
```

Built-in profiles are `topology/generic`, `topology/single`, `topology/workspace`, and `topology/git-submodules`. Stack, delivery, issue-tracker, runtime, and domain rules belong in `.agents/config.json`, `.agents/project/profiles/`, or `.agents/project/rules/` (create these optional directories when first needed), not in this kernel.

Configured commands use executable + argument arrays. Never turn configuration into an unreviewed shell string.

## Upgrade boundary — mandatory

Workflow upgrades are initiated and applied only by a human through documented `npm` or `npx` commands.

- Never query npm or another registry for newer workflow versions.
- Never run an `npm`/`npx` command whose purpose is installing, detecting, previewing, or upgrading this workflow. Project-configured build, test, and lint commands remain allowed.
- Never suggest an upgrade merely because an installed version is old.
- You may explain the command and review a dry-run report the user supplies.

`status` and `doctor` inspect only local state. The workflow has no background check, postinstall update, remote profile lookup, or runtime asset download.
