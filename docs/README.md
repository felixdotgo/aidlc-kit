# Documentation

Use this page to choose the guide that matches your role and next task.

## For package users and operators

1. Start with the repository [README](../README.md) to install the workflow.
2. Read [Operating the workflow](./operating-workflow.md) before asking an agent to change a project.
3. Use [Configuration](./configuration.md) to configure project rules, profiles, and Codex/Claude permissions.
4. Keep [Command reference](./command-reference.md) nearby for safe CLI usage.
5. Read [AI-DLC Coordination service](./coordination-service.md) before enabling remote canonical state.
6. Use [Personal work orchestration](./personal-work-orchestration.md) for optional capture, checkpoints, restore, and local setup.

## For contributors and maintainers

1. Begin with [Development](./development.md) for local setup and implementation boundaries.
2. Use [Testing and release](./testing-and-release.md) for the verification and package-smoke workflow.
3. Read [Architecture](./architecture.md) before changing package, installed-runtime, migration, or asset behaviour.

## Documentation map

| Page | Audience | Purpose |
| --- | --- | --- |
| [Operating the workflow](./operating-workflow.md) | Operators | Lifecycle, task state, human gates, and blocked work. |
| [Configuration](./configuration.md) | Operators and maintainers | Project configuration, profile precedence, rules, and Codex/Claude permissions. |
| [Command reference](./command-reference.md) | Operators | Package CLI commands, flags, previews, and safety limits. |
| [Development](./development.md) | Contributors | Dependencies, source layout, local commands, and implementation rules. |
| [Testing and release](./testing-and-release.md) | Maintainers | Test strategy, evaluator, package smoke test, and release checks. |
| [Architecture](./architecture.md) | Contributors | Boundaries, dependency direction, and source-to-consumer flow. |
| [AI-DLC Coordination service](./coordination-service.md) | Operators | Opt-in service deployment, state authority, and credential safety. |
| [Personal work orchestration](./personal-work-orchestration.md) | Operators | Private local storage, utility flows, repair, backup, and verification. |

When a public command, configuration field, or installed layout changes, update the relevant guide and its validation in the same change.
