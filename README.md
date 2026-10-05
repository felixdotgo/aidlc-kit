# aidlc-kit

`@felixdotgo/aidlc-kit` installs a local AI-DLC workflow into an existing project. The workflow gives coding agents a shared task lifecycle, explicit human review gates, and project-owned state and rules.

It is deliberately local-only: workflow assets are bundled with the package, `remoteUpdates` is `false`, and normal status checks never contact a registry.

## Requirements

- Node.js 20.17 or newer.
- An existing project directory.
- Codex or Claude Code.

## Quick start

Run these commands from your existing project's directory to preview the installation, then apply it:

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow init . --agent codex --dry-run
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow init . --agent codex --yes
```

`npx` may ask permission to download the package on first use. These examples pin version `0.0.1`. After installation, the project's lifecycle scripts run locally without `npx` or a registry connection.

Use the adapter that matches the coding tool:

| Tool | `--agent` value | Installed entry point |
| --- | --- | --- |
| Codex | `codex` | `AGENTS.md` |
| Claude Code | `claude` | `CLAUDE.md` and phase skills |

Use `--all` to install both supported adapters. Codex installs workspace-write sandboxing with on-request approvals and a project execpolicy that permits only AI-DLC lifecycle scripts; trust the project before starting Codex so that it loads the project configuration. Claude Code installs a local permission allowlist for the same lifecycle-script command prefix without granting general Bash access. Use `--force --yes` only for an initial installation when replacing an unmanaged conflicting file is intentional.

Confirm the installed project locally:

```sh
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow status .
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow doctor . --strict
```

## Documentation

The detailed documentation is organised by task and audience:

- [Documentation index](./docs/README.md) — choose the right guide.
- [Operating the workflow](./docs/operating-workflow.md) — lifecycle, state, gates, and blocked work.
- [Configuration](./docs/configuration.md) — project configuration, profiles, rules, and adapters.
- [Command reference](./docs/command-reference.md) — every package CLI command and safety constraint.
- [Development](./docs/development.md) — local contributor setup, source layout, and implementation rules.
- [Testing and release](./docs/testing-and-release.md) — verification, evaluator, package smoke test, and release readiness.
- [Architecture](./docs/architecture.md) — package boundaries and the source-to-installed flow.
- [AI-DLC Coordination service](./docs/coordination-service.md) — opt-in Docker/remote coordination, security, and polling contract.

## Safety note

Only a human may initiate or apply a workflow upgrade. `upgrade` rejects `--yes` and `--force`, requires an interactive terminal, and asks the human to type the target package version. See the [command reference](./docs/command-reference.md#upgrade) before changing an existing installation.

## License

MIT
