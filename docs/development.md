# Development guide

This guide is for contributors to `@felixdotgo/aidlc-kit`. It covers local setup, source ownership, and the rules that keep the package runtime and installed workflow behaviour aligned.

## Requirements and dependencies

- Node.js 20.17 or newer is required by the package runtime.
- npm installs the repository development dependencies.
- `@inquirer/prompts` is the runtime dependency for interactive CLI prompts; installed lifecycle scripts remain dependency-free.
- Development uses TypeScript and `@types/node` as declared in `package.json`.

```sh
npm install
```

Codex or Claude Code are optional for manually exercising real evaluator drivers. Ordinary build, lint, and unit-test work does not need external model credentials.

## Repository layout

```text
assets/aidlc/                Source workflow contracts, schemas, and installed scripts
skills/                      Source thin phase adapters
src/                         TypeScript package CLI, installer, lifecycle, profiles, and migrations
dev/evaluator/               Development-only evaluator harness and runners
scripts/build-assets.mjs     Bundles workflow assets for package distribution
test/unit/                   Unit and installed-runtime parity tests
docs/                        User, operator, and contributor documentation
dist/                        Generated TypeScript and bundled assets; do not hand-edit
```

The asset build copies `assets/aidlc/` and `skills/` into `dist/assets/.agents/`. At install time, the package writes the workflow to a consumer project's `.agents/aidlc/` and `.agents/skills/` locations. Always state which of these three layouts—source, bundle, or installed project—you mean in code or documentation.

## Local commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Rebuild bundled workflow assets and compile TypeScript into `dist/`. |
| `npm run lint` | Type-check without emitting files. |
| `npm test` | Build, then run every compiled unit test with Node's test runner. |
| `node --test dist/test/unit/<file>.test.js` | Run a focused compiled test after building. |
| `npm run release:check` | Run the repository release-evidence policy check. |

Run the narrowest relevant test while iterating, then run `npm test` and `npm run lint` before handing off a non-trivial change. See [Testing and release](./testing-and-release.md) for the package smoke test and evaluator.

## Local build and registry-free installation

Use this fast smoke test to install workflow assets from the current checkout into a disposable consumer project. It invokes the freshly compiled CLI directly, so the consumer installation does not use `npm install`, `npx`, a published package, or an npm registry. Repository bootstrap and build still use npm and the dependencies already installed in this checkout.

Run the following POSIX shell commands from the repository root:

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

The dry run previews the managed writes before `--yes` applies them. `status` describes the installed version and adapters, `doctor --strict` is the integrity check, and the final command confirms that the copied dependency-free lifecycle runtime can read its canonical state without the package CLI.

Always use a new empty directory and inspect the printed path before removing it manually. Do not point this recipe at a real project unless its managed files and workflow state are intentional test targets. Reusing a fixture across package versions triggers the human-only upgrade protection by design. On Windows, use WSL or Git Bash for the snippet, or create a temporary directory in PowerShell and pass its absolute path to the same Node commands.

This direct-`dist` smoke verifies the compiled checkout, but it does not verify the published file allowlist, package bin metadata, or tarball exclusions. Before release, also run the separate [package smoke test](./testing-and-release.md#package-smoke-test), which packs and extracts a local tarball without installing or fetching the package from a registry.

## Run `npx` from a local package archive

To test the package before release, create its `.tgz` archive and run the local archive with `npx`:

```sh
npm pack
npx --package felixdotgo-aidlc-kit-0.0.1.tgz -- aidlc-workflow init .
```

`npx` runs the archive without publishing it. Run the command from the directory containing the archive. Use a disposable project instead of `.` if you do not want the command to write workflow files into the current directory.

## Ownership boundaries

The package has three ownership layers:

1. Package-managed kernel assets installed under `.agents/aidlc/`.
2. Project-owned configuration, profiles, rules, and evaluation material under `.agents/project/`.
3. Project-owned task state and derived data under `.agents/data/`.

Do not introduce a second lifecycle board or hand-edit canonical state. The installed lifecycle scripts are dependency-free so consumer projects do not need this package to operate after installation.

## Mirrored runtime behaviour

The TypeScript implementation powers the package CLI. Installed projects use a dependency-free mirror under `assets/aidlc/scripts/`. Changes to shared lifecycle, state, gate, profile, or context behaviour must preserve parity between these paths and add coverage for both package and installed-runtime execution.

Likewise, a public configuration or schema change must update its validator, JSON schema, installed assets, package inventory, documentation, and tests together.

## Safe implementation rules

- Resolve all project-relative paths through the shared path helpers; reject traversal and symlink escape.
- Keep installation, migration, and upgrade plans deterministic and conflict-first.
- Preserve project-owned configuration and state when changing managed assets.
- Do not add remote profile discovery, runtime asset downloads, executable plugin hooks, registry checks, or shell-string command execution.
- Treat human-gated lifecycle transitions as atomic, auditable state operations.

Read [Architecture](./architecture.md) before changing a module boundary, migration, installed script, or bundle layout.
