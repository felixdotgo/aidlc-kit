# Contributing to aidlc-kit

This file is the short entry point for maintainers and contributors. Detailed guidance lives in [`docs/`](./docs/README.md) so that user setup, system operation, and repository development can evolve independently.

## Local bootstrap

Requirements: Node.js 20 or newer and npm.

```sh
npm install
npm test
npm run lint
```

## Contributor documentation

- [Development guide](./docs/development.md) — dependencies, repository layout, implementation boundaries, and local commands.
- [Testing and release](./docs/testing-and-release.md) — focused tests, package smoke test, evaluator, and release readiness.
- [Architecture](./docs/architecture.md) — module ownership, data flow, and installed-runtime parity.
- [Configuration reference](./docs/configuration.md) — profiles, rules, Codex/Claude permissions, and project-owned configuration.

## Documentation policy

- Keep `README.md` focused on package requirements and setup.
- Add operational and system guidance to the relevant page in `docs/`.
- Update command/configuration examples and their tests in the same change as a public contract.
- Do not duplicate canonical agent instructions from `assets/aidlc/` in overview documentation.

## Delivery boundary

Running verification does not authorise publishing, tagging, committing, or pushing. Those actions require separate human approval.
