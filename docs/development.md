# Development guide

Local setup, dogfooding, source ownership, and the rules that keep package runtime and installed workflow aligned. To use the workflow in your own project, start at the [documentation index](./README.md).

## Requirements and dependencies

- Node.js 24 or newer; npm installs the dev dependencies (TypeScript, `@types/node`).
- `@inquirer/prompts` is the only runtime dependency; installed lifecycle scripts are dependency-free.
- Codex, Claude Code, or OpenCode: only for real evaluator drivers; OpenCode also needs `AIDLC_OPENCODE_MODEL` (`provider/model[#variant]`).

```sh
npm install
```

## Platform support

| Platform | Status | Notes |
| --- | --- | --- |
| Linux | Supported | Full CI coverage; Docker worker isolation available. |
| macOS | Supported | Full test coverage; POSIX shell recipes apply. |
| Windows | Best-effort | Use WSL or Git Bash for shell recipes. win32 separators handled in `src/state/guards.ts`, `src/profiles.ts`, installed `lib/store.mjs` and `context-runtime.mjs`; state lock liveness via `process.kill(pid, 0)`. Not in CI. |
| Loop / fleet | Linux only | Needs Docker and a POSIX shell; `loop-local-workers.mjs` rejects other hosts. E2e tests need `AIDLC_TEST_WORKER_IMAGE` and `AIDLC_WORKER_DOCKER_IMAGE`. |

## Repository layout

```text
assets/aidlc/                Source workflow contracts, schemas, and installed scripts
skills/                      Source thin phase adapters
src/                         Package CLI (src/cli/), installer, shared planning core, lifecycle domain (src/model/, src/state/), profiles, migrations
dev/evaluator/               Development-only evaluator harness and runners
scripts/build-assets.mjs     Bundles workflow assets for package distribution
test/unit/                   Unit and installed-runtime parity tests
docs/                        User, operator, and contributor documentation
dist/                        Generated TypeScript and bundled assets; do not hand-edit
```

Three layouts: source (`assets/aidlc/`, `skills/`), bundle (`dist/assets/.agents/`), installed (consumer `.agents/aidlc/` and `.agents/skills/`). Say which you mean.

## Local commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Bundle workflow assets and compile TypeScript into `dist/`. |
| `npm run sync-core` | Copy `assets/aidlc/scripts/lib/store.mjs` to `services/aidlc-coordination/src/lifecycle-core.mjs` byte-identically. |
| `npm run lint` | Type-check without emitting files. |
| `npm test` | Build, then run all compiled unit tests (Node test runner). |
| `node --test dist/test/unit/<file>.test.js` | Run one compiled test after building. |
| `npm run release:check` | Release-evidence policy check. |

## Local build and registry-free installation

Install the checkout's assets into a disposable consumer project via the compiled CLI (no `npm install`, `npx`, or registry). From the repository root:

```sh
AIDLC_REPO="$(pwd)"
AIDLC_LOCAL_PROJECT="$(mktemp -d "${TMPDIR:-/tmp}/aidlc-local-project.XXXXXX")"

npm run build
node "$AIDLC_REPO/dist/src/cli.js" init "$AIDLC_LOCAL_PROJECT" --agent codex --dry-run
node "$AIDLC_REPO/dist/src/cli.js" init "$AIDLC_LOCAL_PROJECT" --agent codex --yes
node "$AIDLC_REPO/dist/src/cli.js" status "$AIDLC_LOCAL_PROJECT"
node "$AIDLC_REPO/dist/src/cli.js" doctor "$AIDLC_LOCAL_PROJECT" --strict
node "$AIDLC_LOCAL_PROJECT/.agents/aidlc/scripts/state.mjs" task list --root "$AIDLC_LOCAL_PROJECT"

printf 'Local test project: %s\n' "$AIDLC_LOCAL_PROJECT"
```

- Use a new empty directory each time (reuse across versions triggers the human-only upgrade protection); remove it manually. On Windows, create it in PowerShell and pass the absolute path.
- Do not target a real project unless its managed files and state are intentional test targets.
- This checks the compiled checkout only, not the published allowlist, bin metadata, or tarball exclusions; run the [package smoke test](./testing-and-release.md#package-smoke-test) before release.

## Run `npx` from a local package archive

```sh
npm pack
npx --package felixdotgo-aidlc-kit-0.3.0.tgz -- aidlc-kit init .
```

Run from the archive's directory; pass a disposable project instead of `.` to avoid writing into the current directory.

## Dogfooding this repository

`.agents/` is gitignored; each contributor installs the repository's own workflow from the checkout.

### Install the workflow from source

```sh
npm install
npm run build
node dist/src/cli.js init . --agent <codex|claude|opencode> --loop-mode off --yes
```

Edit `.agents/config.json` as below (`commands` as executable-and-argument arrays; your adapter id → `"scripted"` in `agentState`), then `node dist/src/cli.js profile validate .`.

```json
{
  "commands": {
    "build": { "command": "npm", "args": ["run", "build"] },
    "test": { "command": "npm", "args": ["test"] },
    "lint": { "command": "npm", "args": ["run", "lint"] }
  },
  "agentState": { "opencode": "scripted" }
}
```

### Check for drift and re-sync

After changing `assets/aidlc/`, check for a stale install (any output means stale; symptom: `loop: Isolated local worker dispatcher is not integrated; loop execution is unavailable`):

```sh
diff -rq assets/aidlc/scripts .agents/aidlc/scripts
```

Re-sync is a human-only upgrade (TTY required); stop the loop daemon first (`node dist/src/cli.js loop down --root .` or `loop stop`), then re-run `diff -rq`:

```sh
npm run build
node dist/src/cli.js upgrade . --dry-run   # preview the plan
node dist/src/cli.js upgrade .             # type the package version when prompted
```

### Run the loop from a source checkout

> [!WARNING]
> Experimental, pre-1.0. See [Status and stability](./loop-runbook.md#status-and-stability).

In place of `npx --package @felixdotgo/aidlc-kit@<version> aidlc-kit …`, run the compiled CLI after `npm run build`:

| Task | Command |
| --- | --- |
| Start the daemon and dashboard | `node dist/src/cli.js loop up --root .` |
| Check daemon and task status | `node dist/src/cli.js loop status --root . [--task-id <task-id>]` |
| Serve only the dashboard | `node dist/src/cli.js ui .` |

See [Local loop walkthrough](./loop-local-run.md) and [Command reference](./command-reference.md#loop).

## Ownership boundaries

- `.agents/aidlc/`: package-managed kernel assets.
- `.agents/project/`: project-owned config, profiles, rules, and evaluation material.
- `.agents/data/`: project-owned task state and derived data; never add a second lifecycle board or hand-edit it.

## Mirrored runtime behaviour

- TypeScript powers the package CLI; installed projects use the dependency-free mirror in `assets/aidlc/scripts/`. Lifecycle, state, gate, profile, or context changes keep parity and add coverage for both.
- A public configuration or schema change updates validator, JSON schema, installed assets, package inventory, docs, and tests together.
- Dual-core sync rule: after editing `assets/aidlc/scripts/lib/store.mjs`, run `npm run sync-core` so `services/aidlc-coordination/src/lifecycle-core.mjs` stays byte-identical.

## Code style and conventions

Baseline (decision `D1-convention-standard`, task `refactor-source-readability`):

- **Strict TypeScript.** Keep `strict`; enforce via `npm run lint` (`tsc --noEmit`). No ESLint/Prettier or other tooling deps.
- **Size.** ≤250 lines per file, ≤60 per function; split by responsibility.
- **Modules.** One responsibility each; a facade may re-export a public API (e.g. `src/state.ts`).
- **Naming.** camelCase functions/variables, `PascalCase` types, `SCREAMING_SNAKE_CASE` constants; file name matches primary export.
- **Errors.** Typed one-line errors; never swallow; validate inputs before I/O.
- **Dependencies.** Pass fetch, clock, environment explicitly; no module-level mutable state.
- **Public API.** JSDoc exported symbols with non-obvious contracts.
- **Behavior preservation.** Refactors never change CLI output, state schema, file layout, or installed assets; run parity tests.
- **Verification.** Narrowest test while iterating; `npm test` + `npm run lint` before handoff.

## Safe implementation rules

- Resolve project-relative paths through the shared path helpers; reject traversal and symlink escape.
- Keep install, migration, and upgrade plans deterministic and conflict-first.
- Preserve project-owned configuration and state when changing managed assets.
- Never add remote profile discovery, runtime asset downloads, executable plugin hooks, registry checks, or shell-string execution.
- Human-gated lifecycle transitions are atomic, auditable state operations.
- Read [Architecture](./architecture.md) before changing a module boundary, migration, installed script, or bundle layout.

## Contributing to prompt assets

Prompt assets are the contracts under `assets/aidlc/` (`orchestrator.md`, `phase-*.md`) that `context.mjs` turns into phase packets.

- Keep them compact: default packet budget is 16,000 characters (`config.context.maxChars`); optional rules and diagnostics drop first.
- Never truncated (generation fails instead): next-action contract, phase contract, approved decisions, safety/spec anchors, task state, latest applicable evidence.
- Heading invariants enforced by `gate-check.mjs`:
  - Intent (`G0_confirm`): `## 📋 Problem`, `## 🗺️ Affected areas`, `## 💭 Assumptions`, `## ❓ Open questions`, `## 🎯 Scope`.
  - Design (`G1_review`): `## 🧩 Solution per affected area`, `## 📌 Spec traceability`, `## 🔗 Cross-service contracts`, `## ⚠️ Risks / edge cases`.
- After changing contracts, run `npm run release:check` (`--adapters opencode`) and the evaluator suite; update docs and tests in the same change. Rationale: [Design decisions](./design-decisions.md) D6.

## Documentation conventions

Follow [Adding or changing a page](./README.md#adding-or-changing-a-page). In addition:

- A public contract change (command, config field, schema, installed asset) updates its guide and the asserting test in the same change.
- Never duplicate canonical agent instructions from `assets/aidlc/`; link to the installed asset.

## Related

- [Testing and release](./testing-and-release.md)
- [Architecture](./architecture.md)
- [Design decisions](./design-decisions.md)
- [Configuration](./configuration.md)
