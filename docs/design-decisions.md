# Design decisions (ADR-lite)

Numbered decisions that constrain future changes across modules or releases (runtime boundaries, state formats, safety policies). Local implementation choices belong in code comments or the originating task.

## D1. One lifecycle core with a typed facade and conformance

- **Context:** Installed projects need dependency-free lifecycle scripts; the package CLI is TypeScript.
- **Decision:** One canonical core: `assets/aidlc/scripts/lib/store.mjs` (dependency-free ESM). A byte-identical copy is synced into `services/aidlc-coordination/src/lifecycle-core.mjs`, and `src/state/shared.ts` is a thin typed facade that delegates every lifecycle function to it. Persistence primitives live in `assets/aidlc/scripts/lib/store-sqlite.mjs`.
- **Consequences:** Parity is checked by `lifecycle-core-conformance` (byte identity + property/fuzz); a core change requires `npm run sync-core` and those tests.

## D2. Single SQLite state database with JSON checkpoint for git

- **Context:** Local-first; no registry in consumer projects. Node.js ≥ 24 ships the built-in `node:sqlite` driver.
- **Decision:** One SQLite database (`.agents/data/state/aidlc.db`, WAL + busy timeout) stores the canonical `WorkflowState` (JSON blob per workspace), archive records, and feature manifests, serialized by the file lock (`.aidlc-state.lock` + guard). On every save, `.agents/data/state/aidlc-state.json` and the archive records are regenerated as commit-friendly checkpoint projections for git recovery and diffs; the database is authoritative at runtime and git-ignored.
- **Consequences:** One logic and one store shared by the interactive workflow, the local loop, and the coordination service; multiple task leads can progress concurrently (writers serialize briefly under the lock, readers proceed via WAL). Recovery stays simple: deleting the database re-imports from the checkpoint; digest verification still guards archive records.

## D3. Append-only evidence with append-order boundaries

- **Context:** Verification and review outcomes must stay auditable and never be rewritten.
- **Decision:** Evidence is append-only; current-build boundaries follow append order, not wall-clock timestamps.
- **Consequences:** Re-running a check appends; "latest" means latest appended. Tampering requires rewriting the whole state file, detectable via lock and digest checks.

## D4. Human-only upgrades

- **Context:** Upgrades touch managed assets and state; automated upgrades risk data loss.
- **Decision:** `upgrade` rejects `--yes`/`--force`, requires an interactive TTY, and asks the human to type the target version; no background checks or postinstall.
- **Consequences:** Upgrades are auditable and intentional; CI cannot auto-upgrade; rollback uses the upgrade journal.

## D5. Local-first / no-registry policy

- **Context:** Consumer projects must work offline; status/doctor must not phone home.
- **Decision:** `remoteUpdates: false` by default; status and doctor never consult a registry; fleet is opt-in and separately deployed.
- **Consequences:** No surprise network calls; version drift is detected locally; fleet authority is explicit via `AIDLC_FLEET_URL`.

## D6. Compact code style in the installed kernel

- **Context:** Installed scripts must fit the 16,000-character phase-packet budget.
- **Decision:** The installed kernel uses compact style; package and service code do not.
- **Consequences:** Two style regimes; never "pretty-print" installed scripts in ways that bloat packets; mandatory sections are never truncated.

## D7. Machine-enforced repair bounds

- **Context:** Repair loops need a hard stop.
- **Decision:** Three failed verify records per affected area, or two failed review records, in the current build flip `nextAction` to `blocked` and add a `REPAIR_BOUND` error to the Review implementation gate check.
- **Consequences:** No self-approval past the bound; a durable handoff is required. Legacy G2 waits migrated by schema v4 are exempt once.

## D8. Assignment records are operational metadata

- **Context:** Worker assignment state must not become a second lifecycle authority.
- **Decision:** Assignment records (`.agents/data/tasks/<id>/runtime/assignments.json`) are operational metadata; canonical task state is the authority.
- **Consequences:** Assignment corruption or loss does not invalidate the task; `assignment.mjs reconcile` is required before dispatch.

## D9. Configured commands as executable + args arrays

- **Context:** Shell strings are unsafe and non-portable.
- **Decision:** Project-configured commands are stored and executed as executable + args arrays; shell strings are rejected.
- **Consequences:** No shell injection; explicit invocation; predictable cross-platform behaviour.

## D10. Task language `vi` / `en`

- **Context:** Artifacts and prompts need a declared language; broader i18n is not justified yet.
- **Decision:** Task language is `vi` or `en`; further extensibility is deferred.
- **Consequences:** New languages need a schema and conformance change; existing tasks keep their declared language.

## D11. Optional `$schema` reference in generated config

- **Context:** Offline-first tooling needs schema validation without network.
- **Decision:** Generated config may include an optional relative `$schema` reference to the local schema.
- **Consequences:** Editors validate offline; a missing reference degrades gracefully.

## D12. Timing-safe comparison for all coordination auth

- **Context:** Non-fleet coordination endpoints must not leak tokens via timing.
- **Decision:** Non-fleet coordination auth uses the same timing-safe comparison as the fleet path.
- **Consequences:** One auth implementation; no fast-path bypass; consistent with the service's credential model.

## How to add a decision

1. Record it in canonical state via `decision set`, tracked with its task.
2. Cite the source (file, PR, or task id) and present it at Approve plan (G1).
3. Append a numbered Context / Decision / Consequences entry here; link from [Architecture](./architecture.md) when it changes a boundary.

## Related

- [Architecture](./architecture.md)
- [Development guide](./development.md)
- [Testing and release](./testing-and-release.md)
