---
name: aidlc-clarify
description: "AI-DLC phase 1 (Confirm requirements): turn a raw request into a confirmed intent brief — restate the problem, map affected submodules + specs, list assumptions and open questions, fix scope. Cheap: reads only the AI-DLC index, no deep code dive. Triggers: a NEW feature/bug/change request when the AI-DLC Orchestrator routes to clarify. Ends by STOPPING for user confirmation (Confirm requirements)."
---

# AI-DLC · Clarify (Confirm requirements) — adapter

This skill is a thin Claude Code adapter. The canonical playbook is tool-agnostic and lives in the repo:

**Read `.agents/aidlc/phase-clarify.md` and execute it exactly.**

- Shared conventions (canonical state, gates, continuation, evidence): `.agents/aidlc/conventions.md`
- Common rules & orchestrator: `.agents/aidlc/orchestrator.md`
- Templates: `.agents/aidlc/templates/` · Stack rules: `.agents/aidlc/rules/`
- Lifecycle state: `.agents/data/state/aidlc-state.json` · discovery indexes: `.agents/data/index/repo-map.md`, `.agents/data/index/specs-index.md`

Do not re-author content from memory — the canonical files are the source of truth.
