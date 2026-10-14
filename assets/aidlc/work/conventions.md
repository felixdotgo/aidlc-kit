# Local personal work

Personal work owns awareness, sources, context and next actions in `.agents/data/work/`. AI-DLC owns phases, gates and evidence in `.agents/data/state/` and task artifacts in `.agents/data/tasks/`. Work statuses and links never approve gates.

Use `node .agents/aidlc/scripts/work.mjs <operation> --root <project>` with JSON on stdin. Operations: init, preflight, repair, search, get, create, update, comment, move, intake, checkpoint, restore, link. Output is `{ok:true,result}` or a sanitized `{ok:false,error:{code,message}}`. Only local storage is supported; there are no credentials, remote API calls, MCP work tools or configurable storage paths.

For requested local setup, run `init` with `{}`. It preserves unrelated config and enables `personalWork: {enabled:true,provider:"local"}`. Otherwise disabled utilities stop with WORK_DISABLED; uninitialized enabled storage stops with WORK_NOT_INITIALIZED. Do not switch providers as fallback. Run preflight to check the store identity/access.

Use the six provider capabilities through the runtime rather than editing JSON files. References contain provider local, work UUID and `aidlc-work://<storeUUID>/<workUUID>`; the URI is an opaque project reference, not a browser link. A foreign store reference is rejected. Logical statuses: INBOX, READY, DOING, WAITING, DONE.

Each item's events.jsonl is the authoritative append-only history. item.json, sources.jsonl and checkpoints.jsonl are derived readable projections; manual edits are ignored. Run repair to rebuild projections after fixing path/permission errors. Never repair a corrupt journal by deleting history: stop with WORK_CORRUPT and restore a verified backup.

Normalize inputs against source-envelope, work-item and work-checkpoint schemas. Mutations require a stable idempotencyKey of 1–256 characters. Retain the same key AND input for retries; changed input fails with WORK_IDEMPOTENCY. Obvious secrets are redacted before persistence; do not deliberately capture secrets or echo raw source content.

A same-host project-wide lock serializes independent processes. Live locks are never stolen based on age; provably dead owners can be reclaimed. WORK_LOCKED requires inspecting the owner before retrying. Malformed lock/recovery files require deliberate owner inspection. NFS, distributed writers and Git merges are outside the boundary.

Reads report completeness. WORK_INCOMPLETE stops absence-based writes; explicitly select an item or adjust a configured bound. WORK_UNCERTAIN requires a fresh read/reconciliation before retrying. AMBIGUOUS requires selection. A multi-message intake is not an all-or-nothing transaction: report partial effects and reconcile after failure.

DOING requires explicit start/select intent. WAITING requires a reason. The DOING limit is advisory. Automatic DONE for a linked item checks fresh successful AI-DLC completion; checkpoint/restore never move status.

Data is private by default and ignored by the store's .gitignore. Back up the entire store including store.json and journals while no writer is active. Keep personal work separate from shared lifecycle artifacts; copying only one item or merging stores loses project identity guarantees.
