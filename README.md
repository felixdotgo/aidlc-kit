# aidlc-kit

[![version](https://img.shields.io/badge/version-0.2.0-blue)](https://www.npmjs.com/package/@felixdotgo/aidlc-kit)
[![license](https://img.shields.io/npm/l/@felixdotgo/aidlc-kit)](https://github.com/felixdotgo/aidlc-kit/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@felixdotgo/aidlc-kit)](https://nodejs.org/)

Installs an AI-DLC workflow into an existing project: a shared task lifecycle, explicit human review gates, and project-owned state for Codex, Claude Code, and OpenCode. Optionally, a loop daemon runs tasks end-to-end on one machine or across a fleet.

> [!WARNING]
> Pre-1.0 (`0.x`). The local loop is usable; fleet mode and the coordination service are still in development. See [Status and stability](./docs/loop-runbook.md#status-and-stability).

## Quick start

Requires Node.js 20.17+ and Codex, Claude Code, or OpenCode (Linux/macOS; Windows is best-effort).

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit init .          # previews, then installs after you confirm
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit doctor . --strict
```

In a terminal, `init` asks for the adapter (unless exactly one is detected or you pass `--agent codex|claude|opencode` / `--all`) and the loop mode (unless `--loop-mode …`), previews the files, then asks you to confirm; `--yes` skips the confirmation, `--dry-run` writes nothing. The installed lifecycle scripts run locally and never contact a registry.

Then ask your agent for a change:

```text
Add rate limiting to the login endpoint using the AI-DLC workflow.
```

The agent creates a task and stops at three review steps — Confirm requirements, Approve plan, Review implementation — each needing your explicit reply. The Codex and Claude Code adapters pre-approve only the lifecycle scripts, and OpenCode gets instructions only ([Agent permissions](./docs/configuration.md#agent-permissions)); for Codex, trust the project first.

## Run the loop (optional)

A daemon drives tasks end-to-end on a Linux host with Docker, stopping at every review step for you:

1. In `.agents/config.json`: `"loop": { "mode": "local", "agents": { "lead": "opencode", "workers": { "worker-a": "opencode" } } }` (providers: `codex`, `claude`, `opencode`).
2. Put credentials in the git-ignored `.agents/loop.env`; keys your tools already store are detected.
3. `./.agents/aidlc/scripts/loop.sh up` checks the environment, starts the daemon, and serves the dashboard (`--open` launches the browser); `loop.sh down` stops both.

Setup: [Loop setup runbook](./docs/loop-runbook.md). Daily use: [Local loop walkthrough](./docs/loop-local-run.md).

## Documentation

[Index](./docs/README.md) · [Operating the workflow](./docs/operating-workflow.md) · [Configuration](./docs/configuration.md) · [Command reference](./docs/command-reference.md) · [Troubleshooting](./docs/troubleshooting.md) · [Coordination service (fleet)](./docs/coordination-service.md) · [Contributing](./DEVELOPMENT.md)

## Safety note

Only a human may upgrade: `upgrade` rejects `--yes` and `--force`, needs an interactive terminal, and asks you to type the target version ([details](./docs/command-reference.md#upgrade)).

## License

MIT
