# Architecture

One Node.js/TypeScript package: the CLI installs and maintains static AI-DLC workflow assets; installed projects run dependency-free scripts locally.

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

Layouts: **source** (editable `assets/aidlc/`, `skills/`), **bundle** (generated `dist/assets/.agents/`, never hand-edited), **installed** (consumer `.agents/`); bundle and package-smoke tests keep them aligned.

## Module boundaries

| Boundary | Modules | Responsibility |
| --- | --- | --- |
| CLI and installation | `src/cli.ts` + `src/cli/` (`argv`, `options`, `prompt`, `commands`), `src/installer.ts`, `src/workflow.ts`, `src/adapters.ts`, `src/mcp-setup.ts` | Parse commands, select adapters, plan deterministic writes, install managed assets (incl. coordination-service template), status/doctor. |
| Shared planning core | `src/managed-planning.ts` | Manifest reading, inventory keys, managed-file planning ladder (create/skip/update/conflict), init vs upgrade policies. |
| Lifecycle domain | `src/model/` (barrel `src/model.ts`), `src/state/` (barrel `src/state.ts`), `src/gate.ts`, `src/context.ts` | Validate state, compute transitions and gate readiness, classify next actions, build phase packets. |
| Profiles | `src/profiles.ts` | Resolve and validate config/profiles (incl. schema-only `tracker`), expand effective rules. |
| Migration | `src/upgrade.ts`, `src/project-migration.ts`, `src/legacy.ts`, `src/upgrade-board.ts` | Legacy-data and version-layout migration (incl. legacy `BOARD.md`) with audit backups. |
| Web dashboard | `src/task-ui.ts` (barrel) over `src/ui/`; browser scripts `assets/ui/*.js` | Serve `aidlc-kit ui` dependency-free; mutations only spawn installed scripts, never write state. |
| Shared file semantics | `src/project-path.ts`, `src/managed-content.ts` | Path containment, unsafe-symlink rejection, managed-block marker format. |
| Development evaluator | `dev/evaluator/` | Repository-only; never in the published CLI. |

`src/state/`: `io`, `paths`, `domain`, `guards`, `archive-record`, `items`, `commands`, `transitions`, `validate`, `store`, `memory`, `lessons`, `lifecycle`, `render`, `migrate`, `lock`.

### Web dashboard modules

- `src/ui/server`: route table (`ROUTES`) and `startUiServer`.
- `src/ui/security`: Host and request-shape checks (Origin, `Sec-Fetch-Site`, custom header); there is no session token.
- `src/ui/containers`: per-task worker container index and raw log tail (`.agents/data/tasks/<id>/runtime/workers/`), with `docker ps` enrichment.
- `src/ui/changes`: code changes with one source order for every mode (fleet snapshot → assignments → task range from `baseCommit`/`finalCommit` → working tree).
- `src/ui/options`, `src/ui/http`: option parsing, HTTP helpers.
- `src/ui/assets`: whitelisted static CSS/JS from `assets/ui/`.
- `src/ui/daemon`: daemon status, health, spawned script actions.
- `src/ui/data`: local and fleet reads.
- `src/ui/changes`: task diffs via Git.
- `src/ui/live`, `src/ui/sse`: `/api/live` regions and `/api/events`.
- `src/ui/markdown`: Markdown rendering.
- `src/ui/docs`: read-only packaged `docs/*.md` via the fixed `DOC_PAGES` whitelist.
- `src/ui/files`: byte-range file reads, optionally refusing symlinks.
- `src/ui/views/`: `layout`, `components`, `board`, `task`, `changes`, `docs`.
- `assets/ui/*.js`: plain browser scripts `common`, `dashboard`, `detail`, `live-log`, `changes`.

New page: route in `ROUTES` (`src/ui/server.ts`) + view in `src/ui/views/`.

### Dependency direction

- Inward only: CLI, installation, migration depend on planning core, lifecycle, shared helpers.
- Planning core depends only on `model`, `workflow`, `managed-content`, `profiles`; never on CLI, installer, or upgrade.
- Migration never imports installation (`upgrade.ts` uses `managed-planning.ts` directly); the only `installer.ts` → `project-migration.ts` edge is init-time legacy-layout planning.
- Lifecycle never depends on installation; the evaluator may provision one but is not published runtime.
- `src/ledger.ts` and `src/tracker.ts` were removed as dead code; `tracker` config is schema-only (`TrackerConfig`).

## Installed workflow runtime

Kernel: contracts, templates, schemas, profiles, dependency-free scripts in `.agents/aidlc/`, reached via thin adapter instructions. Customisation stays outside:

| Location | Ownership | Purpose |
| --- | --- | --- |
| `.agents/aidlc/` | Package managed | Lifecycle contracts, schemas, scripts. |
| `.agents/data/` | Project owned | Canonical state, task artifacts, derived indexes, memory, evidence. |
| `.agents/project/` | Project owned | Local profiles, rules, evaluation material. |

State machine enforces the lifecycle; gates need human approval; evidence is append-only; no `aidlc-kit` executable or duplicate board file needed.

### Loop runtime

> [!WARNING]
> Experimental, pre-1.0. See [Status and stability](./loop-runbook.md#status-and-stability).

Dispatch derives from task `nextAction` and dependency-ready work; assignment records are operational metadata; phase, evidence, gates stay canonical. Selecting a mode only configures; `loop start` (or `loop up`) runs.

| Variant | Authority | How it runs |
| --- | --- | --- |
| Interactive | Local `.agents/data/state/` | In the current agent conversation; native workers claim and checkpoint via assignment records in `.agents/data/loop/`. |

Every variant is a wrapper around the same data: the canonical task state (including `baseCommit`/`finalCommit`, written by `state.mjs` locally and `remote-state.mjs` in fleet mode through the shared core) and the task directory `.agents/data/tasks/<id>/` — review artifacts at its root, operational runtime data under `runtime/` (worker container index and logs, identical for local and fleet workers; absent without the loop). `.agents/data/loop/` holds only daemon and process state.
| Local | Local `.agents/data/state/` | Singleton daemon (`loop start` or `loop.sh up`): host-executed lead, Docker-isolated workers; gate approval only via trusted host terminal or dashboard. |
| Fleet | Coordination service | Service owns supervisor leases, gate checkpoints, reviewer approval; Docker workers hold own credentials; Git uses fenced lead/worker claims with commit handoff. SQLite single-host, PostgreSQL multi-host. |

**Agent support.**

- Host-executed lead turns: Codex, Claude Code, OpenCode.
- Container-isolated lead turns: Codex, Claude Code; OpenCode rejected with a diagnostic (file-based credentials; `lib/loop-lead-sandbox.mjs`).
- Docker workers (local and fleet): all three; OpenCode uses environment credentials, XDG roots redirected into the ephemeral worker HOME (`lib/loop-worker-docker.mjs`).

**Leases, locks, and claims.** One holder-file primitive (`lib/loop-holder.mjs`), three meanings:

- **Lock:** short mutex around a file write (assignment records).
- **Lease:** process ownership of the singleton daemon or one task's loop run (replacing separate runner and supervisor leases); its `activity` (`waiting` or `turn`) gates approval.
- **Claim:** a worker's ownership of an item and its paths.

One file format and liveness rule; 15 s renewal, 60 s TTL; a `<file>.guard` serializes reclaim, renewal, release. `aidlc-kit loop leases` lists them; details: [Troubleshooting](./troubleshooting.md#loop-leases-locks-and-claims).

### Installed entry points

A shared strict argv parser validates command shape before root discovery, lock acquisition, and state reads. Explicit roots must be validated project directories; implicit roots use nearest-ancestor `.agents/aidlc/` discovery, never an arbitrary cwd.

## Trust and safety boundaries

- Assets are local (manifest `remoteUpdates: false`); status/doctor never consult a registry.
- Install/upgrade plans: conflict-first, path-contained, no unsafe symlink traversal.
- Upgrade is human-only (interactive confirmation); agents never run or discover upgrades.
- Codex: project-scoped `.codex/config.toml`, `.codex/rules/aidlc.rules`. Claude Code: lifecycle-script permission via local settings and phase skills. OpenCode: owner-scoped `AGENTS.md` block only; `.opencode/` read for detection only.
- Project commands: executable-and-argument arrays, never shell strings.
- Canonical state, terminal records, and rendered workplans reject symlink traversal; writes are same-directory atomic replaces.
- State lock: guard-serialized; release verifies the owner token directly, so a contended guard cannot strand it; stale when its pid is gone and it is 30 s old.
- Loop holders (`lib/loop-holder.mjs`) re-read the token under the guard on reclaim, so a reclaimer never deletes a newer holder.
- The compact master catalog is archive authority; recovery replaces only a valid, unreferenced terminal orphan matching the active catalog task by `id` and `createdAt`; referenced, malformed, or identity-conflicting records fail closed.

## Change impact guide

| If you change… | Also inspect… |
| --- | --- |
| A lifecycle/state rule | Installed scripts, schemas, gate/context rendering, runtime parity tests. |
| An asset or adapter | Asset builder, package inventory, installer, adapter tests, tarball smoke test. |
| A configuration/profile field | Validator, schema, effective-profile behaviour, docs, tests. |
| Migration semantics | Upgrade plan/apply logic, path safety, transaction rollback, migration tests. |
| A public command | CLI parsing, README/setup guidance, command reference, package tests. |

## Related

- [Development guide](./development.md)
- [Testing and release](./testing-and-release.md)
- [Design decisions](./design-decisions.md)
- [Coordination service](./coordination-service.md)
