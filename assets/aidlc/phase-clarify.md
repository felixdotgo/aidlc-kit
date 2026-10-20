# AI-DLC · Clarify (Confirm requirements)

Goal: confirm intent before discovery cost.

When independent, read-only index or ambiguity checks exist, use the shared orchestration contract in `orchestrator.md` to delegate bounded workstreams. The lead agent alone reconciles their findings, writes the intent brief, and performs every lifecycle or gate action.

1. Read the compact repository/spec indexes if available; do not scan implementation code.
2. Read `templates/model-contract.md` and apply its COSTARS clarify emphasis to the intent brief. Use CRITICS only for elevated risk, ambiguity, or model disagreement.
3. Canonical task state already exists from turn routing (`task create` runs there, before this packet). Never create it a second time; a repeated create fails with `Task already exists`.
4. Fill the intent template: problem, affected areas, assumptions, open questions with safe defaults, and decidable in/out scope.
5. Run `node .agents/aidlc/scripts/gate-check.mjs <task-id> --gate G0_confirm` and fix every structural error. Only after it passes, set the gate wait with `node .agents/aidlc/scripts/state.mjs task status <task-id> --status blocked_on_user`, then render only this task with `node .agents/aidlc/scripts/render.mjs <task-id>`.
6. Run `node .agents/aidlc/scripts/gate-view.mjs <task-id>`, relay the output verbatim, and stop. Presenting the gate ends this turn.

## ONLY in a later turn, after the user explicitly confirms the requirements at the Confirm requirements step

Explicit approval is a user message that says yes to this gate (for example "ok", "approve"). Resolving questions or requesting changes is NOT approval. Then — and only then — run `node .agents/aidlc/scripts/state.mjs gate approve <task-id> --gate G0_confirm --source <the-user-approval-message>`, parse the returned `nextAction`, and execute its `run_phase` command before emitting any final response. Continue into `plan` until Approve plan or a real blocker; never invent approval. If the user instead requests changes, revise the intent while the task waits, or cancel the wait explicitly with `task status <task-id> --status active --mode audited --reason <what-changed> --source <the-user-message>`.

Read-only questions remain off-workflow. The task language is set here and retained throughout the lifecycle.

Post-condition: a teammate with no chat context can understand the problem and scope; every affected area has an indexed source or explicitly says `none indexed`.

Before any final response, execute `task-next.mjs <task-id> --require-stop`; a continuation-required result prohibits a final response.
