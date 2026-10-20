---
name: aidlc-build
description: "AI-DLC phase 3 (Review implementation): after explicit plan approval, implement the canonical work items, run the narrowest tests/lint, then run code-review. Triggers when the AI-DLC Orchestrator routes a task after plan approval to build. Ends at Review implementation for explicit user code review."
---

# AI-DLC · Build (Review implementation) — adapter

This skill is a thin Claude Code adapter. The canonical playbook is tool-agnostic and lives in the repo:

**Read `.agents/aidlc/phase-build.md` and execute it exactly.**

Completing a canonical item is progress, not a stopping point. Execute the mutation's returned `nextAction` immediately, loop across remaining items, and run `task-next.mjs <task-id> --require-stop` before any final response.

- Shared conventions (canonical state, gates, continuation, evidence): `.agents/aidlc/conventions.md`
- Common rules & orchestrator: `.agents/aidlc/orchestrator.md`
- Templates: `.agents/aidlc/templates/` · Stack rules: `.agents/aidlc/rules/`
- Lifecycle state: `.agents/data/state/aidlc-state.json` · discovery indexes: `.agents/data/index/repo-map.md`, `.agents/data/index/specs-index.md`

Do not re-author content from memory — the canonical files are the source of truth.
