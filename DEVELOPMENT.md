# Contributing to aidlc-kit

Entry point for contributors. Details live in [`docs/`](./docs/README.md).

## Local bootstrap

Node.js 20.17+ and npm.

```sh
npm install
npm test        # build + unit tests
npm run lint    # tsc --noEmit
```

To develop with the repository's own workflow (`.agents/` is gitignored), follow [Dogfooding this repository](./docs/development.md#dogfooding-this-repository).

## Contributor documentation

- [Development guide](./docs/development.md) — layout, local commands, boundaries, code style, dogfooding.
- [Testing and release](./docs/testing-and-release.md) — focused tests, Docker/PostgreSQL verification, package smoke test, release checklist.
- [Architecture](./docs/architecture.md) — module ownership and source → bundle → installed flow.
- [Design decisions](./docs/design-decisions.md) — numbered decisions and how to add one.

## Documentation policy

- `README.md` is the fastest path to install and use; everything else goes in `docs/` per [Adding or changing a page](./docs/README.md#adding-or-changing-a-page).
- A public contract change (command, config field, schema, installed asset) updates its guide and test in the same change.
- Never duplicate canonical agent instructions from `assets/aidlc/`; link to them.

## Delivery boundary

Passing verification does not authorise publishing, tagging, committing, or pushing; each needs separate human approval.
