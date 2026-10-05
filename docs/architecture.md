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
| CLI and installation | `src/cli.ts`, `src/installer.ts`, `src/workflow.ts`, `src/adapters.ts` | Parse commands, select adapters, plan deterministic writes, install managed assets, and expose local status/doctor checks. |
| Lifecycle domain | `src/model.ts`, `src/state.ts`, `src/gate.ts`, `src/context.ts` | Validate canonical state, calculate transitions and gate readiness, and build bounded phase packets. |
| Profiles and project integration | `src/profiles.ts`, `src/tracker.ts` | Resolve project configuration/profiles and optional tracker integration. |
| Migration | `src/upgrade.ts`, `src/project-migration.ts`, `src/legacy.ts` | Plan and apply safe legacy-data and version-layout migration with audit backups. |
| Shared file semantics | `src/project-path.ts`, `src/managed-content.ts` | Keep all paths inside the project, reject unsafe symlinks, and preserve managed-content ownership. |
| Development evaluator | `dev/evaluator/` | Run repository-only evaluation; never expose evaluator assets through the published package CLI. |

Dependencies flow inward: CLI, installation, and migration depend on lifecycle and shared helpers; lifecycle does not depend on installation; evaluator may provision an installation but is not part of published runtime behaviour.

## Installed workflow runtime

The installed kernel consists of contracts, templates, schemas, profiles, and dependency-free scripts under `.agents/aidlc/`. Thin adapter instructions connect a selected coding tool to that kernel. Project customisation belongs outside the kernel:

| Location | Ownership | Purpose |
| --- | --- | --- |
| `.agents/aidlc/` | Package managed | Lifecycle contracts, schemas, and scripts. |
| `.agents/data/` | Project owned | Canonical state, task artifacts, derived indexes, memory, and evidence. |
| `.agents/project/` | Project owned | Local profiles, rules, and evaluation material. |

The state machine enforces the lifecycle; gates require explicit human approval; evidence is append-only. Installed scripts remain usable without an `aidlc-workflow` executable or a duplicate board file.

Installed entry points share a strict dependency-free argv parser. Parsing and command-shape validation precede root discovery, lock acquisition, and state reads. Explicit roots are validated project directories; implicit roots use nearest-ancestor `.agents/aidlc/` discovery and never fall back to writing beneath an arbitrary working directory.

## Trust and safety boundaries

- Workflow assets are local package assets. The manifest records `remoteUpdates: false`; status and doctor do not consult a registry.
- Install/upgrade plans are conflict-first, path-contained, and reject unsafe symlink traversal.
- Human-only upgrade is an intentional boundary: interactive confirmation is required and agents must not run or discover upgrades.
- Only Codex and Claude Code adapters are installed. Codex uses trusted project-scoped `.codex/config.toml` and `.codex/rules/aidlc.rules`; Claude Code scopes lifecycle-script permission through its local settings and phase skills.
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
