---
name: aidlc-plan
description: "AI-DLC phase 2 (Approve plan): after intent is confirmed, run bounded discovery, then produce a detailed design, canonical decisions, and a per-submodule workplan. Triggers when the AI-DLC Orchestrator routes a task after requirements confirmation to planning. Ends at the executable Approve plan review for explicit user approval."
---

# AI-DLC · Plan (Approve plan) — adapter

This skill is a thin Claude Code adapter. The canonical playbook is tool-agnostic and lives in the repo:

**Read `.agents/aidlc/phase-plan.md` and execute it exactly.**

- Shared conventions (canonical state, gates, continuation, evidence): `.agents/aidlc/conventions.md`
- Common rules & orchestrator: `.agents/aidlc/orchestrator.md`
- Templates: `.agents/aidlc/templates/` · Stack rules: `.agents/aidlc/rules/`
- Lifecycle state: `.agents/data/state/aidlc-state.json` · discovery indexes: `.agents/data/index/repo-map.md`, `.agents/data/index/specs-index.md`

Do not re-author content from memory — the canonical files are the source of truth.
