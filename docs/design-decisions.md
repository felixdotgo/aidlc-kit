# Design decisions (ADR-lite)

Numbered decisions adopted by the project. Each entry records context, decision, and consequences. Cross-reference [Architecture](./architecture.md) for module boundaries and source-to-consumer flow.

## D1. Dual lifecycle cores with conformance instead of codegen

- **Context:** Installed projects must run lifecycle scripts with no dependencies; the package CLI itself is TypeScript and needs types.
- **Decision:** Keep two cores — TypeScript in `src/state.ts` and a dependency-free ESM mirror in `assets/aidlc/scripts/lib/store.mjs` plus a committed byte-identical copy in `services/aidlc-coordination/src/lifecycle-core.mjs` — enforced by `lifecycle-core-conformance` (byte-identity + property/fuzz) rather than codegen.
- **Consequences:** Parity is checked, not generated; a change to one core requires `npm run sync-core` and conformance tests. Cheaper than a build-time codegen step in a no-dep runtime.

## D2. Single JSON state with file lock and archive catalog

- **Context:** The workflow is local-first with no registry or database dependency in consumer projects.
- **Decision:** Canonical state is one JSON file (`.agents/data/state/aidlc-state.json`) serialized by a file lock (`.aidlc-state.lock` + guard), with terminal records archived under `.agents/data/state/backups/` and digest-verified.
- **Consequences:** Simple backup/restore and git diffing; contention is explicit and bounded by the 5s/30s lock defaults; not suited to high-concurrency multi-writer workloads beyond the lock.

## D3. Append-only evidence with append-order boundaries

- **Context:** Verification/review outcomes must be auditable and not rewritten by later runs.
- **Decision:** Evidence is append-only; current-build boundaries are defined by append order, not wall-clock timestamps.
- **Consequences:** Re-running a check appends a new record; "latest" means latest in append order. Tampering requires rewriting the whole state file, which the lock and digest checks make detectable.

## D4. Human-only upgrades

- **Context:** Workflow upgrades touch managed assets and state; silent or automated upgrades risk data loss.
- **Decision:** `upgrade` rejects `--yes`/`--force`, requires an interactive TTY, and asks the human to type the target version. No background checks or postinstall.
- **Consequences:** Upgrades are auditable and intentional; CI cannot auto-upgrade; rollback uses the upgrade journal.

## D5. Local-first / no-registry policy

- **Context:** Consumer projects must operate offline; status/doctor must not phone home.
- **Decision:** `remoteUpdates: false` by default; status and doctor never consult a registry. Fleet is opt-in and separately deployed.
- **Consequences:** No surprise network calls; version drift is detected locally; fleet authority is explicit via `AIDLC_FLEET_URL`.

## D6. Compact code style in the installed kernel

- **Context:** Phase packets have a 16,000-character budget; installed scripts must fit.
- **Decision:** The installed kernel uses compact style (phase-packet budget 16,000 chars); package and service code do not follow it.
- **Consequences:** Two style regimes; contributors must not "pretty-print" installed scripts in ways that bloat packets; mandatory sections are never truncated.

## D7. Machine-enforced repair bounds

- **Context:** Repair loops can run indefinitely without a hard stop.
- **Decision:** Three failed verify records per affected area, or two failed review records, in the current build flip `nextAction` to `blocked` and add a `REPAIR_BOUND` error to the Review implementation gate check.
- **Consequences:** The model cannot self-approve past the bound; a durable handoff is required. Legacy G2 waits migrated by schema v4 are exempt once.

## D8. Assignment records are operational metadata

- **Context:** Worker assignment state must not become a second lifecycle authority.
- **Decision:** Assignment records (`.agents/data/assignments/`) are operational metadata only; canonical task state remains the authority.
- **Consequences:** Assignment corruption or loss does not invalidate the task; reconciliation (`assignment.mjs reconcile`) is required before dispatch.

## D9. Configured commands as executable + args arrays

- **Context:** Shell strings are unsafe and non-portable.
- **Decision:** Project-configured commands are stored and executed as executable + args arrays; shell strings are rejected.
- **Consequences:** No shell injection; commands must be invoked explicitly; cross-platform behaviour is predictable.

## D10. Task language `vi` / `en`

- **Context:** Task artifacts and prompts need a declared language; broader i18n is not yet justified.
- **Decision:** Task language is restricted to `vi` or `en`; further extensibility is deferred.
- **Consequences:** New languages require a schema and conformance change; existing tasks keep their declared language.

## D11. Optional `$schema` reference in generated config

- **Context:** Offline-first tooling needs schema validation without network.
- **Decision:** Generated config may include a relative `$schema` reference pointing at the local schema; it is optional.
- **Consequences:** Editors get validation offline; missing reference degrades gracefully.

## D12. Timing-safe comparison for all coordination auth

- **Context:** Non-fleet coordination endpoints must not leak tokens via timing.
- **Decision:** Non-fleet coordination auth uses the same timing-safe comparison as the fleet path.
- **Consequences:** One auth implementation; no fast-path bypass; consistent with the service's credential model.

## How to add a decision

1. Record the decision in canonical state via `decision set` so it is tracked with the task that introduced it.
2. Cite the source (file, PR, or task id) and present it at Approve plan (G1) for review.
3. Append a numbered entry here following the Context / Decision / Consequences shape, and link from [Architecture](./architecture.md) when it changes a boundary.

See [Architecture](./architecture.md) for the module and ownership boundaries these decisions protect.