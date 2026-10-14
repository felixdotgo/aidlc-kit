# Local personal work

Capture messages, save investigation context, and resume after interruption with a private local store. Installed utilities use JavaScript and Node.js built-ins. No account, API key, token, network connection or extra runtime dependency is needed.

## Setup

From a project where AI-DLC is already installed, run:

```sh
node .agents/aidlc/scripts/work.mjs init --root . < /dev/null
node .agents/aidlc/scripts/work.mjs preflight --root . < /dev/null
```

In a source checkout of this repository, use the source runtime instead:

```sh
node assets/aidlc/scripts/work.mjs init --root . < /dev/null
node assets/aidlc/scripts/work.mjs preflight --root . < /dev/null
```

This runs local work directly from the checkout. Installed projects use the first pair of commands; managed workflow updates follow the normal human maintenance process.

Both commands should return `"ok":true`. Init creates `.agents/data/work/` and enables local work in `.agents/config.json`, preserving other settings. Repeating init retains the same store identity. Init takes no input options; an empty input means `{}`. Existing provider configuration is replaced by local defaults. Copy any settings you want to retain before initialization.

The minimum configuration is:

```json
{
  "personalWork": {
    "enabled": true,
    "provider": "local"
  }
}
```

Omitting personalWork or setting enabled false disables utilities. An enabled configuration with any other provider fails clearly. Manually enabling it still requires init to create the store. Optional defaults are:

```json
{
  "capture": { "preserveRawSource": true, "autoReady": true },
  "limits": {
    "doing": 2,
    "resumeContextChars": 12000,
    "searchItems": 500,
    "contextRecords": 200,
    "intakeMessages": 50
  }
}
```

Put capture and limits inside personalWork. Storage location and credentials are not configurable.

## Using the skills

Ask the agent to “capture this message” with work-intake. It classifies ACTIONABLE, CONTEXT, DECISION, QUESTION, REFERENCE or NOISE and normalizes goal, outcome and next action. Exact source/thread identities, references and task links resolve existing work; keyword matches require selection. Related context can join a newly captured actionable message. Replay of a stable source does not duplicate work or source history. A batch may have partial effects if a later operation fails; reconcile before retrying.

Ask “checkpoint this” with work-checkpoint to save goal, current state, completed steps, observations, hypothesis, blockers, files, links and an executable next action. Ask “what was I doing?” with work-restore to resume from the newest checkpoint. A limited context window still pins that checkpoint and checks explicit invalidation against the entire journal. Other newer context requires semantic review.

Statuses are INBOX, READY, DOING, WAITING, DONE. Fully described incoming work can become READY. DOING requires explicit start or selection; WAITING requires a reason. The DOING limit is advisory. Checkpoint and restore never change status. Automatic completion of a linked item requires fresh successful AI-DLC completion.

Only explicit implementation selection starts/resumes the normal AI-DLC workflow. After creating/selecting its task and writing the normal intent, link the work reference with `link`. Work status, comments and links never approve G0, G1 or G2. Linking updates the work item and intent artifact independently; reconcile a partial link before retrying. Lifecycle state/evidence remains authoritative in its own store.

## Direct CLI example

Save this as a private input file named capture.json:

```json
{
  "idempotencyKey": "capture-retry-message-1",
  "messages": [{
    "classification": "ACTIONABLE",
    "source": {
      "source": "manual", "externalId": "retry-message-1",
      "threadId": null, "author": null, "timestamp": null, "url": null,
      "body": "Investigate payment retry after timeout."
    },
    "item": {
      "schemaVersion": 1,
      "title": "Investigate payment retry",
      "summary": "Retry fails after timeout",
      "expectedOutcome": "Find the cause",
      "nextAction": "Reproduce the timeout",
      "status": "INBOX", "priority": null, "due": null, "project": null,
      "aidlcTaskId": null, "sources": [],
      "dedupe": { "externalIds": [], "threadIds": [], "references": [], "keywords": [] }
    }
  }]
}
```

```sh
node .agents/aidlc/scripts/work.mjs intake --root . < capture.json
node .agents/aidlc/scripts/work.mjs search --root . < /dev/null
```

Keep the returned ref object for get, checkpoint, restore and move. Its URI `aidlc-work://<storeUUID>/<workUUID>` is an opaque reference, not a web page. Foreign-store references fail. Mutations need an idempotencyKey; retry using the exact same key and input. Reusing a key for changed input fails with WORK_IDEMPOTENCY. Installed schemas and [command reference](./command-reference.md) describe other inputs. Successful commands write a JSON success envelope; errors exit nonzero with a sanitized code/message.

For a checkpoint, save checkpoint.json, replacing the reference placeholders with the returned ref:

```json
{
  "ref": { "provider": "local", "id": "<workUUID>", "url": "aidlc-work://<storeUUID>/<workUUID>" },
  "idempotencyKey": "retry-checkpoint-1",
  "checkpoint": {
    "schemaVersion": 1, "goal": "Find retry failure",
    "state": "Timeout reproduced", "hypothesis": "Cleanup races the retry",
    "completed": ["Reproduced timeout"], "observations": ["Cleanup still running"],
    "blockers": [], "files": [], "links": [],
    "nextAction": "Add transaction tracing", "capturedAt": "2026-10-14T00:00:00Z"
  }
}
```

Save ref.json containing `{"ref": <the returned ref object>}`, then run:

```sh
node .agents/aidlc/scripts/work.mjs checkpoint --root . < checkpoint.json
node .agents/aidlc/scripts/work.mjs restore --root . < ref.json
```

## Storage, repair and backup

`.agents/data/work/store.json` contains the store UUID. Each work UUID directory contains authoritative events.jsonl and derived item.json, sources.jsonl and checkpoints.jsonl. History is append-only and checksum/sequence validated. Reads replay journals; editing projections does not update work.

The store is private by default: its .gitignore ignores work data. Back up the complete store, including store.json and journals, while no writer is active. Store UUIDs survive copying a complete backup. Keep work data separate from shared `.agents/data/tasks/` and lifecycle state. Do not merge stores with Git.

Same-host processes serialize through a project-wide lock. Live owners are never evicted based on age; a provably dead process can be reclaimed. NFS and distributed writers are unsupported. WORK_LOCKED means inspect the owner before retrying; malformed lock/recovery files require deliberate manual recovery after confirming no writer is active.

If a committed journal reports projection warnings, fix the affected path/permissions and run:

```sh
node .agents/aidlc/scripts/work.mjs repair --root . < /dev/null
```

Repair rebuilds projections without changing journals. Orphan staging/temp files are ignored and may be inspected separately while no writer is active. WORK_CORRUPT fails closed: restore a verified backup; repair does not rewrite damaged authority. WORK_UNCERTAIN means a publish happened but durability could not be confirmed: read/reconcile before retrying.

Events are bounded at 16000 characters, each journal at 16 MiB, and aggregate search reads at 64 MiB. Search/context windows report incompleteness. Absence-based creation and intake stop on WORK_INCOMPLETE; explicitly select work or deliberately adjust configured bounds. DONE items remain searchable. Obvious secrets are redacted before persistence; avoid capturing credentials deliberately.

## Verification

Run `npm run test:personal-work` from the source repository. Tests exercise real local files, persisted replay, lock/concurrency recovery, projection repair, corruption, budgets and no-network behavior. The repository package smoke test also executes utilities installed from a packed tarball. Run `npm test` and `npm run lint` for aggregate checks. No live SaaS acceptance or credentials are required.
