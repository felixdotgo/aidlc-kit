# Work checkpoint

For “checkpoint this”, “save my context”, or a context switch, identify the selected personal-work reference. If selection is ambiguous, use bounded search and ask for selection. Do not silently choose unrelated work.

Attempt to preserve goal, current state, completed work, observations, hypothesis, blockers, inspected files/modules, links, and executable next action. Unknown state/hypothesis are null; unavailable lists are empty. Distinguish observed findings from hypotheses and avoid hidden reasoning transcripts.

Submit `checkpoint` with `{ref,idempotencyKey,checkpoint:{schemaVersion:1,goal,state,completed,observations,hypothesis,blockers,files,links,nextAction,capturedAt}}`. Capture time is an ISO timestamp; retain that value and key on retry. The runtime validates/redacts before appending. Older checkpoints and source history remain intact.

Report saved reference and next action. Checkpoint never implicitly pauses an AI-DLC task, approves a gate, starts different work or moves a personal status. A separate explicit user instruction is needed for those operations.
