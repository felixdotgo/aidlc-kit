# Architecture

`aidlc-kit` is a single Node.js/TypeScript package that installs static AI-DLC workflow assets into another project. The package CLI is used for installation and human-authorised maintenance; an installed project runs the dependency-free workflow scripts locally.

## Source-to-consumer flow

```text
assets/aidlc/ + skills/
        │ build-assets.mjs
        ▼
dist/assets/.agents/ + dist/src/
        │ package CLI: init / upgrade
        ▼
consumer project: .agents/aidlc/ + .agents/skills/ + project-owned .agents/data/
```

The distinction matters:

- **Source layout** is this repository's editable `assets/aidlc/` and `skills/` tree.
- **Bundle layout** is generated under `dist/assets/.agents/` for package publication.
- **Installed layout** is written under a consumer project's `.agents/` directory.

`dist/` is generated. Source assets and installed assets must remain behaviourally aligned through the bundle and package-smoke tests.

## Module boundaries

| Boundary | Modules | Responsibility |
| --- | --- | --- |
| CLI and installation | `src/cli.ts` + `src/cli/` (`argv`, `options`, `prompt`, `commands` registry), `src/installer.ts`, `src/workflow.ts`, `src/adapters.ts`, `src/mcp-setup.ts` | Parse commands, select adapters, plan deterministic writes, install managed assets (including the coordination-service template), and expose local status/doctor checks. |
| Shared planning core | `src/managed-planning.ts` | Single manifest reading, inventory-key handling, and the managed-file planning ladder (create/skip/update/conflict) with explicit init vs upgrade policies; consumed by installation and migration. |
| Lifecycle domain | `src/model/` (barrel `src/model.ts`), `src/state/` (barrel `src/state.ts`: `io`, `paths`, `domain`, `guards`, `archive-record`, `items`, `commands`, `transitions`, `validate`, `store`, `memory`, `lessons`, `lifecycle`, `render`, `migrate`, `lock`), `src/gate.ts`, `src/context.ts` | Validate canonical state, calculate transitions and gate readiness, classify next actions, and build bounded phase packets. |
| Profiles and project integration | `src/profiles.ts` | Resolve project configuration/profiles, validate config (incl. the config-only `tracker` section — no runtime tracker consumer ships today), and expand effective rules. |
| Migration | `src/upgrade.ts`, `src/project-migration.ts`, `src/legacy.ts`, `src/upgrade-board.ts` | Plan and apply safe legacy-data and version-layout migration (incl. legacy `BOARD.md` parsing) with audit backups. |
| Shared file semantics | `src/project-path.ts`, `src/managed-content.ts` | Keep all paths inside the project, reject unsafe symlinks, and own the managed-block marker format as its single definition. |
| Development evaluator | `dev/evaluator/` | Run repository-only evaluation; never expose evaluator assets through the published package CLI. |

Dependencies flow inward: CLI, installation, and migration depend on the shared planning core, lifecycle, and shared helpers; the planning core depends only on lifecycle/config/shared modules (`model`, `workflow`, `managed-content`, `profiles`) — never on the CLI, installer, or upgrade. Migration does not import installation (`upgrade.ts` consumes `managed-planning.ts` directly); the remaining one-directional `installer.ts` → `project-migration.ts` edge supports init-time legacy-layout planning. Lifecycle does not depend on installation; evaluator may provision an installation but is not part of published runtime behaviour. `src/ledger.ts` and `src/tracker.ts` were removed as runtime-dead code; the `tracker` config section remains schema-only (`TrackerConfig`).

## Installed workflow runtime

The installed kernel consists of contracts, templates, schemas, profiles, and dependency-free scripts under `.agents/aidlc/`. Thin adapter instructions connect a selected coding tool to that kernel. Project customisation belongs outside the kernel:

| Location | Ownership | Purpose |
| --- | --- | --- |
| `.agents/aidlc/` | Package managed | Lifecycle contracts, schemas, and scripts. |
| `.agents/data/` | Project owned | Canonical state, task artifacts, derived indexes, memory, and evidence. |
| `.agents/project/` | Project owned | Local profiles, rules, and evaluation material. |

The state machine enforces the lifecycle; gates require explicit human approval; evidence is append-only. Installed scripts remain usable without an `aidlc-kit` executable or a duplicate board file.

> [!WARNING]
> The **local/interactive loop is usable** today; the end-to-end **fleet** coordinator described below is **still under active development**. Both are **experimental** — because the package is still pre-1.0 (`0.x`), their command surface, configuration fields, and state layout can change incompatibly in any release before `1.0.0`.

The interactive loop runs inside the current Codex, Claude Code, or OpenCode conversation. Native workers use local assignment records under `.agents/data/loop/`; those records hold claims and checkpoints while `.agents/data/state/` remains lifecycle authority. The optional headless fleet runner uses the coordination service's PostgreSQL state, fenced lead and worker claims, and Git commit handoff. Its assignment records are operational metadata; task phase, evidence, and gates stay in the canonical lifecycle state. All hosts derive dispatch from task `nextAction` and dependency-ready work.

Installed entry points share a strict dependency-free argv parser. Parsing and command-shape validation precede root discovery, lock acquisition, and state reads. Explicit roots are validated project directories; implicit roots use nearest-ancestor `.agents/aidlc/` discovery and never fall back to writing beneath an arbitrary working directory.

## Trust and safety boundaries

- Workflow assets are local package assets. The manifest records `remoteUpdates: false`; status and doctor do not consult a registry.
- Install/upgrade plans are conflict-first, path-contained, and reject unsafe symlink traversal.
- Human-only upgrade is an intentional boundary: interactive confirmation is required and agents must not run or discover upgrades.
- Codex, Claude Code, and OpenCode adapters are installed. Codex uses trusted project-scoped `.codex/config.toml` and `.codex/rules/aidlc.rules`; Claude Code scopes lifecycle-script permission through its local settings and phase skills. OpenCode gets an owner-scoped `AGENTS.md` block only, and `.opencode/` is read solely for detection, so no OpenCode configuration, MCP, or permission file is overridden.
- Project commands are configured as executable-and-argument arrays rather than opaque shell strings.
- Canonical state, terminal records, and rendered workplans reject symlink traversal and use same-directory atomic replacement. Lock acquisition is guard-serialized, while release verifies the owner token directly so a contended guard cannot strand the owner's main lock.
- The compact master catalog remains archive authority. Recovery can replace only a valid, unreferenced terminal orphan tied by `id` and `createdAt` to the still-active catalog task; referenced, malformed, and identity-conflicting records fail closed.

## Change impact guide

| If you change… | Also inspect… |
| --- | --- |
| A lifecycle/state rule | Installed scripts, schemas, gate/context rendering, runtime parity tests. |
| An asset or adapter | Asset builder, package inventory, installer, adapter tests, tarball smoke test. |
| A configuration/profile field | Validator, schema, effective-profile behaviour, documentation, and tests. |
| Migration semantics | Upgrade plan/apply logic, path safety, transaction rollback, and migration tests. |
| A public command | CLI parsing, README/setup guidance, command reference, and package tests. |

Use this guide with [Development](./development.md) and [Testing and release](./testing-and-release.md) before changing a cross-cutting boundary.


The optional end-to-end loop coordinator is implemented for both authorities. Local mode runs a foreground supervisor over the canonical local state: a host-executed lead, Docker-isolated workers, and gate approval only through the trusted host terminal. Fleet mode runs the same loop against a coordination service: the service owns supervisor leases, gate checkpoints, and reviewer approval, workers execute in Docker with their own credentials, and Git integration is fenced per backend (SQLite on one host with a local volume, or PostgreSQL across hosts). Selecting a mode configures the loop; only an explicit `loop start` runs it. Host-executed lead turns accept Codex, Claude Code, or OpenCode; container-isolated lead turns accept Codex and Claude Code only and reject OpenCode with an explicit diagnostic because its credentials are file-based. Local Docker worker batches accept Codex, Claude Code, or OpenCode (OpenCode workers authenticate from environment credentials with their XDG roots redirected into the ephemeral worker HOME); fleet worker containers reject OpenCode. See [Coordination service](./coordination-service.md) for deployment and recovery constraints.
