# AI-DLC · Wrap

Precondition: the user approved the implementation at Review implementation and canonical state contains passing approval evidence for that step.

Wrap is success-only and has NO human gate (`gate: none`): never set `blocked_on_user` here — the CLI rejects it. `closed` and `superseded` tasks are terminal at the phase where they stopped and never enter wrap or imply release success.

Use the shared orchestration contract in `orchestrator.md` for independent read-only delivery-policy, lesson, or residual-risk checks. The lead reconciles outputs and is the only agent that records lessons/delivery evidence, performs delivery actions, or transitions the task.

1. Commit only when the user requested it. Follow the project's configured delivery policy; kernel does not assume submodules, branches, PR provider, or issue tracker.
2. Review durable corrections. Record each with `node .agents/aidlc/scripts/state.mjs lesson record <task-id> <lesson-id> --summary <s> --prevention <p> --example <e> --source <source>`, including provenance; if none exist, run `node .agents/aidlc/scripts/state.mjs lesson none <task-id> --reason <reason> --source <source>`. Promote advisory project memory only with explicit user approval via `state.mjs memory promote`; retirement also requires an explicit audited approval. Prefer executable enforcement over prose. Memory and lesson-index commands are not task-scoped, so their output has no `nextAction` — continue the wrap steps in order.
3. Record delivery evidence and residual risk. Rebuild/search lessons and manage advisory memory only through the installed lifecycle script; never hand-edit the derived index or memory registry.
4. Complete the task with `node .agents/aidlc/scripts/state.mjs task transition <task-id> --mode audited --to done --reason <completion-summary> --source <source>` (or `task archive <task-id> --reason <completion-summary> --source <source>`); the lesson disposition from step 2 is required first. Schema v3 writes a digest-validated terminal record and compacts the active catalog. Refresh only this task's review artifact.

Post-condition: reported commits/integrations match reality, the terminal task and lesson disposition are durable, and no local rule was silently admitted.

Before any final response, execute `task-next.mjs <task-id> --require-stop`; a continuation-required result prohibits a final response.
