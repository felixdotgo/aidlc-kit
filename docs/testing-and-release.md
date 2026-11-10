# Testing and release

Verifying changes, then preparing and publishing releases.

## Standard verification

```sh
npm run build
npm run lint
npm test
```

`npm test` rebuilds first. If a child-process test fails with `EPERM` in a sandbox, rerun locally before calling it a product failure.

## Lifecycle core sync

- After editing `assets/aidlc/scripts/lib/store.mjs`, run `npm run sync-core` and commit it with `services/aidlc-coordination/src/lifecycle-core.mjs`.
- `test/unit/lifecycle-core-conformance.test.ts` enforces byte identity and parity with `src/state.ts`.

## Focused tests

```sh
npm run build
node --test dist/test/unit/installer.test.js
```

Pick the nearest test: installer (package inventory, docs assertions), upgrade (migration semantics), lifecycle-runtime (installed scripts). Continuation changes also run `continuation-guard`, multi-item lifecycle runtime, context, and local/MCP lifecycle conformance.

## Loop, Docker, and PostgreSQL verification

> [!WARNING]
> Experimental, pre-1.0. See [Status and stability](./loop-runbook.md#status-and-stability).

Loop changes:

- Run the client assignment, graph, Git, remote-state, and `loop-*.test` fixtures, then lifecycle gate/conformance tests and the [package smoke test](#package-smoke-test).
- Verify in-conversation gate stop, client resume, concurrent worker claims, lease expiry, exact-session recovery, Git scope checks, remote reviewer approval, and run bounds.
- Cover fleet persistence with the PostgreSQL suite below, not only SQLite.
- Finish with `npm test` and `npm run lint`.

Container-isolation tests skip without fixture images and flags, so plain `npm test` is not isolation verification. Build the fixtures once:

```sh
docker build -q -t aidlc-worker-isolation-test:local test/fixtures/docker/worker-isolation
docker build -q -t aidlc-worker-multiturn-test:local test/fixtures/docker/worker-multiturn
docker build -q -t aidlc-worker-fleet-e2e-test:local test/fixtures/docker/worker-fleet-e2e

AIDLC_TEST_DOCKER=1 \
AIDLC_TEST_WORKER_IMAGE=aidlc-worker-isolation-test:local \
AIDLC_TEST_MULTITURN_IMAGE=aidlc-worker-multiturn-test:local \
AIDLC_TEST_DOCKER_IMAGE=aidlc-worker-isolation-test:local \
AIDLC_WORKER_DOCKER_IMAGE=aidlc-worker-fleet-e2e-test:local \
npm test
```

| Variable | Enables |
| --- | --- |
| `AIDLC_TEST_DOCKER=1` | Adversarial lead-boundary container: isolated lead must not write source or see lifecycle state, Docker socket, host HOME, or reviewer credentials. |
| `AIDLC_TEST_WORKER_IMAGE`, `AIDLC_TEST_DOCKER_IMAGE` | Isolated Docker worker via the local batch dispatcher and fleet Git handoff. |
| `AIDLC_TEST_MULTITURN_IMAGE` | Multi-turn session HOME fixture against the turn limit. |
| `AIDLC_WORKER_DOCKER_IMAGE` | Real fleet e2e on Linux (coordinator dispatch, isolated worker, Git integration, canonical completion, G2 publication). The CLI e2e test skips without it; the loop-daemon e2e test fails closed. |

Fixture images hold only a fake provider CLI speaking the Codex JSONL protocol (no real credentials); it refuses to run if it can see `.git`, lifecycle state, or the Docker socket.

PostgreSQL fleet coverage is outside `npm test` and skips without `TEST_POSTGRES_URL` (SQLite still runs). Run it whenever `services/aidlc-coordination/` changes:

```sh
docker run -d --rm --name aidlc-pg-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:5433:5432 postgres:16-alpine
docker exec aidlc-pg-test pg_isready -U postgres # repeat until ready
TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:5433/postgres \
  node --test services/aidlc-coordination/test/*.test.mjs
docker stop aidlc-pg-test
```

## Package smoke test

Release verification exercises the tarball, not the source tree.

```sh
AIDLC_PACK_DIR="$(mktemp -d /tmp/aidlc-pack.XXXXXX)"
AIDLC_EXTRACT_DIR="$(mktemp -d /tmp/aidlc-extract.XXXXXX)"
AIDLC_TEST_PROJECT="$(mktemp -d /tmp/aidlc-project.XXXXXX)"

npm run build
npm pack --pack-destination "$AIDLC_PACK_DIR"
tar -xzf "$AIDLC_PACK_DIR/felixdotgo-aidlc-kit-0.5.0.tgz" -C "$AIDLC_EXTRACT_DIR"
node "$AIDLC_EXTRACT_DIR/package/dist/src/cli.js" init "$AIDLC_TEST_PROJECT" --agent codex --dry-run
node "$AIDLC_EXTRACT_DIR/package/dist/src/cli.js" init "$AIDLC_TEST_PROJECT" --agent codex --yes
node "$AIDLC_EXTRACT_DIR/package/dist/src/cli.js" status "$AIDLC_TEST_PROJECT"
node "$AIDLC_EXTRACT_DIR/package/dist/src/cli.js" doctor "$AIDLC_TEST_PROJECT" --strict
```

- Remove the temporary paths manually after inspection; never reuse a smoke project for another version (installer refuses implicit upgrades).
- The tarball must contain the public CLI, bundled assets, and docs; not `dist/dev/`, evaluator runners, schemas, or configuration.

## Development-only evaluator

`dev/evaluator/` is repository/CI infrastructure: compiled for tests, not published. Runners exchange JSON; reports capture transport, transcript, normalised events, usage, and diagnostics. Real Codex, Claude Code, or OpenCode runs cost credentials and budget; ordinary verification does not need them.

```sh
npm run build
node dist/dev/evaluator/cli.js list
node dist/dev/evaluator/cli.js run --runner local-simulated
```

Pinned `opencode-beam` runner: adapter `opencode`, model `opencode-go/beam-free`, version `opencode-2.2.0`, protocol version `2`, real evidence, 300000 ms timeout; `economy` category uses `opencode-go/beam-free#medium` to fit that timeout. Runs `opencode run --format json --standalone --auto` per turn, resuming with `--session`.

- Runner and loop driver pin `PWD` to the workspace: OpenCode resolves its project from inherited `PWD`, not the spawned cwd; unpinned, commands silently run in the invoking repository.
- Each scenario turn runs with `XDG_CONFIG_HOME` pointed at an empty directory inside the workspace and without `OPENCODE_CONFIG`, so the user's global config (MCP servers, agents, plugins) never loads; the workspace also gets `opencode.json` `{"mcp": {}}`. `XDG_DATA_HOME` is untouched, so local Console auth is reused. This is configuration, not a security boundary.

Release-eligible suite: `aidlc-official-agentic` `2.5.0`. `supported-adapters` expects the agent to state Codex, Claude Code, and OpenCode support without running remote code or shell strings; `build-multi-item-continuation` starts with three build items and requires one run to finish all, record verification/review evidence, and stop only at a ready G2.

```sh
npm run release:check
```

Passes `--adapters opencode` (this repository's policy); `dev/evaluator/release.ts` keeps its `["codex","claude"]` default for downstream users. Reads `.agents/project/release-eval.json`; fails closed on missing evidence or integrity thresholds. Re-adding Codex or Claude needs fresh real evidence.

## Release readiness

Before an authorised release:

1. `npm test`
2. `npm run lint`
3. The local tarball smoke test
4. `npm run release:check`
5. Review the generated package contents and documentation links

Publishing, tagging, committing, and pushing are separate human-authorised actions, not implied by a passing run.

### Version bump checklist

Update together:

| File | What pins the version |
| --- | --- |
| `package.json`, `package-lock.json` | Package version. |
| `README.md` | Version badge and `npx --package` commands. |
| `docs/command-reference.md`, `docs/configuration.md`, `docs/coordination-service.md`, `docs/loop-runbook.md`, `docs/loop-local-run.md` | `npx --package @felixdotgo/aidlc-kit@<version>` commands and "version `<version>`" notes. |
| `docs/development.md`, `docs/testing-and-release.md` | Local archive name `felixdotgo-aidlc-kit-<version>.tgz`. |
| `test/unit/installer.test.ts` | Expected manifest `packageVersion` and `installed version:` status output. |
| `test/unit/eval.test.ts` | `packageVersion` constant. |

Confirm no old-version references remain:

```sh
grep -rn "<old-version>" README.md DEVELOPMENT.md docs test src
```

## Publishing a release

After [release readiness](#release-readiness) and the human review gates, publish `@felixdotgo/aidlc-kit@<version>` with public access and the `latest` dist-tag, signed in to an account that can publish to `@felixdotgo`:

```sh
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
npm view @felixdotgo/aidlc-kit@<version> version --registry https://registry.npmjs.org
```

```sh
npm publish --access public --tag latest --registry https://registry.npmjs.org
```

```sh
npm view @felixdotgo/aidlc-kit@<version> version dist.tarball dist.integrity --json --registry https://registry.npmjs.org
npm view @felixdotgo/aidlc-kit dist-tags --json --registry https://registry.npmjs.org
```

- `npm view` `404` means unpublished (not proof of scope ownership); if the version exists, stop: npm versions cannot be overwritten. `npm whoami` `401`: sign in again.
- `prepublishOnly` runs unit tests, lint, and the release check; answer npm's auth or two-factor prompt. `npm publish --dry-run` runs the same checks and packs without uploading, so it is the rehearsal to run first. A scoped package's first publish needs `--access public` ([npm scope docs](https://docs.npmjs.com/cli/v11/using-npm/scope)).
- Expect version `<version>`, tarball URL and integrity, and `latest` at `<version>`.
- Git tags, GitHub releases, commits, and pushes need separate delivery authorisation.

## Related

- [Development guide](./development.md)
- [Architecture](./architecture.md)
- [Coordination service](./coordination-service.md)
- [Loop runbook](./loop-runbook.md)
