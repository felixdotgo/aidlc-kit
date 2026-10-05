# Testing and release

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

Runners exchange JSON, and reports capture transport, transcript, normalised events, usage, and diagnostics. Real Codex or Claude runs can consume credentials and model budget; they are not required for ordinary development verification.

The release-eligible suite includes `build-multi-item-continuation`, which starts with three canonical build items and requires one agent run to complete all of them, record verification/review evidence, and stop only at a ready G2. This complements unit guards by exercising the model-facing continuation contract.

The release checker validates required evidence according to the configured adapter policy. This repository's script uses the Codex-only policy:

```sh
npm run release:check
```

It reads local evaluation evidence from `.agents/project/release-eval.json` and fails closed if required evidence or integrity thresholds are missing.

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
