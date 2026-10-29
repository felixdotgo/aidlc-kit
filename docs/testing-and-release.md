# Testing and release

Loop changes should run the focused client assignment, graph, Git, remote-state, and `loop-*.test` fixtures, then lifecycle gate/conformance tests and package smoke. Verify in-conversation gate stop, later client resume, concurrent worker claims, lease expiry, exact-session recovery, Git scope checks, remote reviewer approval, and run bounds before aggregate `npm test` and `npm run lint`. Fleet persistence needs PostgreSQL integration coverage as well as in-memory/SQLite fixtures.

Use the smallest relevant verification while developing, then complete the repository checks before a release review.

## Standard verification

```sh
npm run build
npm run lint
npm test
```

`npm test` rebuilds the package before running compiled unit tests. The tests cover CLI and installer behaviour, state and gate transitions, migration safety, managed content, profiles/context, evaluator logic, and installed-runtime parity.

If a test depends on child processes and a sandbox returns `EPERM`, rerun it in an appropriate local environment before deciding that the product failed.

## Focused tests

Build first, then invoke a compiled test file directly:

```sh
npm run build
node --test dist/test/unit/installer.test.js
```

Choose the test closest to the changed boundary. For example, use installer tests for package inventory or documentation assertions, upgrade tests for migration semantics, and lifecycle-runtime tests when touching installed scripts. Continuation changes must also run `continuation-guard`, multi-item lifecycle runtime, context, and local/MCP lifecycle conformance coverage.

## Loop, Docker, and PostgreSQL verification

Loop orchestration tests are part of `npm test`. The ones that exercise real container isolation gate on fixture images plus environment flags; build the fixtures once with a local Docker daemon:

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

- `AIDLC_TEST_DOCKER=1` builds and runs the adversarial lead-boundary container: the isolated lead must not write source or see lifecycle state, the Docker socket, host HOME, or reviewer credentials.
- `AIDLC_TEST_WORKER_IMAGE` and `AIDLC_TEST_DOCKER_IMAGE` run the isolated Docker worker through the local batch dispatcher and the fleet Git handoff.
- `AIDLC_TEST_MULTITURN_IMAGE` runs the multi-turn session HOME fixture against the turn limit.
- `AIDLC_WORKER_DOCKER_IMAGE` is required on Linux for the real fleet end-to-end test (coordinator dispatch, isolated worker, Git integration, canonical completion, and G2 publication). Without it that test fails closed instead of skipping.

Each fixture image contains only a fake provider CLI that emits the Codex JSONL protocol; no real Codex, Claude Code, or OpenCode credentials or accounts are used, and the fake refuses to run when it can see `.git`, lifecycle state, or the Docker socket.

Without these variables the Docker-gated tests skip, so a plain `npm test` is not loop-isolation verification.

PostgreSQL fleet coverage runs against a real database and is not part of `npm test`:

```sh
docker run -d --rm --name aidlc-pg-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:5433:5432 postgres:16-alpine
docker exec aidlc-pg-test pg_isready -U postgres # repeat until ready
TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:5433/postgres \
  node --test services/aidlc-coordination/test/*.test.mjs
docker stop aidlc-pg-test
```

Without `TEST_POSTGRES_URL` the PostgreSQL tests skip with SQLite coverage still running; run the coordination service suites separately whenever `services/aidlc-coordination/` changes.


## Package smoke test

Release verification must exercise the tarball rather than the source tree. From the repository root, build and pack locally, extract the archive, then run the extracted CLI against a clean temporary consumer project.

```sh
AIDLC_PACK_DIR="$(mktemp -d /tmp/aidlc-pack.XXXXXX)"
AIDLC_EXTRACT_DIR="$(mktemp -d /tmp/aidlc-extract.XXXXXX)"
AIDLC_TEST_PROJECT="$(mktemp -d /tmp/aidlc-project.XXXXXX)"

npm run build
npm pack --pack-destination "$AIDLC_PACK_DIR"
tar -xzf "$AIDLC_PACK_DIR/felixdotgo-aidlc-kit-0.0.1.tgz" -C "$AIDLC_EXTRACT_DIR"
node "$AIDLC_EXTRACT_DIR/package/dist/src/cli.js" init "$AIDLC_TEST_PROJECT" --agent codex --dry-run
node "$AIDLC_EXTRACT_DIR/package/dist/src/cli.js" init "$AIDLC_TEST_PROJECT" --agent codex --yes
node "$AIDLC_EXTRACT_DIR/package/dist/src/cli.js" status "$AIDLC_TEST_PROJECT"
node "$AIDLC_EXTRACT_DIR/package/dist/src/cli.js" doctor "$AIDLC_TEST_PROJECT" --strict
```

Keep the printed temporary paths until inspection is complete. Remove them manually afterwards. Do not reuse a smoke-test project for a different package version; the installer intentionally refuses implicit upgrades.

Check that the tarball contains the public CLI, bundled assets, and documentation, but not `dist/dev/`, evaluator runners, evaluator schemas, or evaluator configuration.

## Development-only evaluator

The evaluator under `dev/evaluator/` is repository and CI infrastructure. It is compiled for tests but excluded from the published package.

```sh
npm run build
node dist/dev/evaluator/cli.js list
node dist/dev/evaluator/cli.js run --runner local-simulated
```

Runners exchange JSON, and reports capture transport, transcript, normalised events, usage, and diagnostics. Real Codex, Claude Code, or OpenCode runs can consume credentials and model budget; they are not required for ordinary development verification.

The pinned `opencode-gpt6` runner uses adapter `opencode` with model `opencode-go/gpt-6-luna`, version `opencode-2.2.0`, protocol version `2`, real evidence, and a 300000 ms timeout. It runs `opencode run --format json --standalone --auto` once per turn, resumes with `--session`, and writes `opencode.json` containing `{"mcp": {}}` into each scenario workspace so project MCP servers do not leak into the evaluation. OpenCode resolves its project directory from the inherited `PWD`, not the spawned process working directory, so the runner and the loop driver pin `PWD` to the workspace; without that pin, commands would silently run in the invoking repository. OpenCode has no environment-credential mode, so the runner reuses the local Console authentication; the residual risk is that user plugins or agents can still load. That isolation is workspace configuration, not a security boundary.

The release-eligible `aidlc-official-agentic` suite is version `2.5.0`. Its `supported-adapters` scenario asks the agent to explain that the workflow supports Codex, Claude Code, and OpenCode without executing remote code or shell strings. The suite also includes `build-multi-item-continuation`, which starts with three canonical build items and requires one agent run to complete all of them, record verification/review evidence, and stop only at a ready G2. This complements unit guards by exercising the model-facing continuation contract.

The release checker validates required evidence according to the configured adapter policy. This repository's script uses the OpenCode-only policy:

```sh
npm run release:check
```

The script passes `--adapters opencode`, while `dev/evaluator/release.ts` keeps its `["codex","claude"]` default for compatibility so downstream users and existing policies are unaffected. It reads local evaluation evidence from `.agents/project/release-eval.json` and fails closed if required evidence or integrity thresholds are missing. Re-adding Codex or Claude to this repository's policy requires fresh real evidence for those adapters, not a policy-only edit.

## Release readiness

Before an authorised release, complete:

1. `npm test`
2. `npm run lint`
3. The local tarball smoke test
4. `npm run release:check`
5. A review of the generated package contents and documentation links

Publishing, tagging, committing, and pushing are separate human-authorised actions. A passing verification run is not delivery authority.

## First npm publication

The first release is `@felixdotgo/aidlc-kit@0.0.1`, with public access and the `latest` dist-tag. Complete the release checks and the project's human review gates before publishing.

From the repository root, sign in to an npm account with permission to publish to the `@felixdotgo` scope and confirm the active account:

```sh
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
npm view @felixdotgo/aidlc-kit@0.0.1 version --registry https://registry.npmjs.org
```

An unpublished package normally returns `404` from `npm view`; that response does not establish scope ownership or publish permission. If `0.0.1` already exists, stop: npm versions cannot be overwritten. If `npm whoami` returns `401`, sign in again before publishing.

After inspecting the local tarball and documentation, publish from the repository root:

```sh
npm publish --access public --tag latest --registry https://registry.npmjs.org
```

`prepublishOnly` runs the unit tests, lint, and evaluator release check before this command publishes. Complete any authentication or two-factor prompt from npm. The initial publication of a scoped package needs `--access public`; see the [npm scope documentation](https://docs.npmjs.com/cli/v11/using-npm/scope).

Confirm the published version, dist-tag and artifact metadata:

```sh
npm view @felixdotgo/aidlc-kit@0.0.1 version dist.tarball dist.integrity --json --registry https://registry.npmjs.org
npm view @felixdotgo/aidlc-kit dist-tags --json --registry https://registry.npmjs.org
```

Expect version `0.0.1`, a tarball URL and integrity value, and `latest` pointing to `0.0.1`. Git tags, GitHub releases, commits, and pushes require their own delivery authorisation.
