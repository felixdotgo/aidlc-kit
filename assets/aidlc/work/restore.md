# Work restore

Resolve an explicit item reference or bounded named search. Ambiguous matches require user selection. Submit `restore` with `{ref}`. Restore is read-only.

Read the bounded resume packet: goal, state, completed steps, observations, hypothesis, blockers, files/links, next action, latest checkpoint timestamp, historyComplete, conflict/notices, newerContext and linked task ID. Prefer the newest valid checkpoint over description text. Corrupt journals fail closed. A bounded context window still pins the newest checkpoint and checks explicit invalidation against the full journal; disclose incomplete context and review its semantic implications.

Compare newer context, including unstructured human comments, with the checkpoint. The runtime surfaces explicit invalidation and flags later comments for review; it cannot prove semantic agreement. Surface contradictions and adjust the proposed next action instead of presenting stale findings as current. Summarize what was being done, what was discovered, what is blocked, and the next executable step.

Only when the user explicitly selects implementation, follow AI-DLC orchestration: bounded task find, then task next for existing work or task create for a new task. Preserve any existing actionable task and switching acknowledgement rules. Create/write the normal intent before `link` with `{ref,taskId,intent:"implement",idempotencyKey}`. Linking adds provider-qualified refs to intent context and task ID to local work; it never approves G0/G1/G2. If either side fails, report the partial link and retry deliberately. READY is not G0 approval.
