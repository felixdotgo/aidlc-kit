# Configuration

Each installed project owns `.agents/config.json`: topology profiles, specification roots, verification commands, local rules, and the optional `mcp` and `loop.*` settings. CLI flags and environment variables: [Command reference](./command-reference.md); loop setup: [Loop setup runbook](./loop-runbook.md).

## Minimal configuration

```json
{
  "schemaVersion": 2,
  "extends": ["topology/single"],
  "specs": { "roots": ["docs/specs"] },
  "commands": {
    "test": { "command": "npm", "args": ["test"] },
    "lint": { "command": "npm", "args": ["run", "lint"] }
  },
  "rules": { "include": [".agents/project/rules/*.md"] },
  "risk": { "default": "normal" },
  "context": { "maxChars": 16000 },
  "agentState": {}
}
```

- Commands are executable and argument arrays, never shell strings.
- G0, G1, and G2 always require explicit human approval; configuration cannot auto-pass a gate.

## Optional `$schema` key

- `init` writes a top-level `$schema` of `./aidlc/schemas/config.schema.json` (installed under `.agents/aidlc/schemas/`); existing installs can add it by hand.
- Editors use it for autocompletion and validation; it has no runtime effect.
- Must be a string of at most 512 characters; the relative path keeps validation offline.

## Configuration layers

Later applicable layers take precedence:

```text
kernel → built-in topology → local profile parents/child → project config/rules → approved task decisions
```

- Built-in topology profiles: `topology/generic`, `topology/single`, `topology/workspace`, `topology/git-submodules`.
- Arrays are stable-deduplicated; command keys are last-wins, so a project can replace a profile command.
- Validate the resolved chain with `npx --package @felixdotgo/aidlc-kit@0.5.0 aidlc-kit profile validate .` (source checkout: [development guide](./development.md)).

## Rules, project data, and managed assets

| Location | Ownership | Use it for |
| --- | --- | --- |
| `.agents/aidlc/` | Package managed | Kernel contracts, phases, schemas, and dependency-free runtime scripts. |
| `.agents/data/` | Project owned | Lifecycle state, task artifacts, indexes, memory, and evidence. |
| `.agents/project/` | Project owned | Profiles, rules, and project-specific evaluation material. |

Keep business/domain rules in `.agents/project/rules/`. Never edit managed kernel files; a later install or upgrade may report conflicts for modified managed content.

## Agent permissions

Each adapter grants only what the lifecycle needs; general commands stay unapproved.

| Adapter | Installed files | What is allowed | Notes |
| --- | --- | --- | --- |
| Codex | A managed block in `AGENTS.md`, `.codex/config.toml` (`approval_policy = "on-request"`, `sandbox_mode = "workspace-write"`), and `.codex/rules/aidlc.rules` | The execpolicy allowlists only the seven lifecycle entry points under `node .agents/aidlc/scripts/` (`state`, `task-next`, `context`, `gate-check`, `gate-view`, `render`, `assignment`). | Loaded only after the user trusts the project; network access stays disabled unless the project enables it. |
| Claude Code | A managed block in `CLAUDE.md`, `.claude/settings.local.json`, and phase skills | Only `node .agents/aidlc/scripts/*`. | Other Bash commands stay unapproved. |
| OpenCode | An owner-scoped managed block in `AGENTS.md` only | Nothing: no OpenCode configuration, MCP, or permission file is written. | Reads `.opencode/` only to detect the adapter; OpenCode settings are never overridden. |

- Codex allowlist rule: run each lifecycle command as its own exec invocation. Commands joined with `&`, `&&`, `;`, or `|` create shell segments that a single prefix rule does not cover.
- Codex and OpenCode blocks are independently owned and merge in the same `AGENTS.md` when both are installed.
- `init --force --yes` is only for an intentional initial install that replaces an unmanaged conflicting file, never an upgrade ([Command reference](./command-reference.md#init)).

## Context and risk

- `context.maxChars` bounds a phase packet. The runtime preserves lifecycle instructions, approved decisions, and mandatory invariants, and fails clearly rather than silently truncating them.
- Set `risk.default` deliberately: planning, migrations, cross-service contracts, and security-sensitive changes deserve a stronger reviewer or an explicit human decision even at `normal`.

## Optional AI-DLC Coordination

`mcp` is absent (or `{ "enabled": false }`) by default. Enabled, it requires an HTTP(S) `endpoint` and non-empty `workspace`, and may name a token environment variable, a polling interval from 1,000 to 3,600,000 ms, and the enabled Jira/Trello/GitHub Issues preflight providers. Experimental ([Status and stability](./loop-runbook.md#status-and-stability)); contract in [AI-DLC Coordination service](./coordination-service.md).

## Optional loop configuration

> [!WARNING]
> Experimental, pre-1.0. See [Status and stability](./loop-runbook.md#status-and-stability).

The `loop` object selects the loop mode, agents, and limits, set through `init`, the human-run upgrade preview, or a deliberate edit. It installs and starts nothing, authorizes no upgrade, grants no gate approval, and holds no provider credentials.

```json
{
  "loop": {
    "mode": "local",
    "agents": { "lead": "codex", "workers": { "worker-a": "codex", "worker-b": "opencode" } },
    "pollMs": 5000,
    "limits": { "maxTurns": 12, "turnTimeoutMs": 600000, "maxStallTurns": 2 }
  }
}
```

### Mode and agents

- `loop.mode` is `off`, `local`, or `fleet`; an absent `loop` means `off`. Selecting a mode starts nothing: run `./.agents/aidlc/scripts/loop.sh up` (or `aidlc-kit loop start`).
- Both enabled modes run one lock-enforced multi-task daemon per project. It polls its authority — canonical local state, or the coordination service in `fleet` mode — and auto-picks every actionable **loop-owned** task without prompting for a requirement.
- A task is loop-owned when created through loop intake (dashboard **New task**, `aidlc-kit loop intake`, `loop-entry.mjs intake`) or, locally, when it has a loop run record; fleet ownership is `.agents/data/tasks/<id>/runtime/intake.json` with `authority: "fleet"`. Interactive-lead tasks are never picked up.
- `loop.agents` maps one lead and named workers to `codex`, `claude`, or `opencode`, independently of `mcp.providers`.

### Polling and limits

| Field | Range | Default | Meaning |
| --- | --- | --- | --- |
| `loop.pollMs` | integer `1000`–`300000` | `5000` | Daemon poll interval. |
| `loop.limits.maxTurns` | `1`–`1000` | `12` | Turn budget of **one supervised lead run**; a resumed run starts a fresh budget. |
| `loop.limits.turnTimeoutMs` | `1`–`3600000` | `600000` | Caps a single agent turn. |
| `loop.limits.maxStallTurns` | `1`–`20` | `2` | Pauses after that many consecutive turns without observable progress. |

In `fleet` mode these become `AIDLC_FLEET_MAX_TURNS`, `AIDLC_FLEET_TURN_TIMEOUT_MS`, `AIDLC_FLEET_MAX_STALL_TURNS`, and `AIDLC_FLEET_POLL_MS`; an exported value overrides the config.

### Worker image

`loop.workerImage` maps a provider to a worker Docker image tag (for example `{ "opencode": "aidlc-worker-opencode:local" }`), recorded by `aidlc-kit loop worker-image`. Local dispatch and fleet workers fall back to `aidlc-worker-<provider>:local`, auto-built from the packaged Dockerfile when missing; `AIDLC_WORKER_DOCKER_IMAGE` overrides it.

### Provider credentials and OpenCode

Provider credentials go in the git-ignored `.agents/loop.env` (or the shell), never in this file; env-file and auto-detection rules are in [Command reference](./command-reference.md#loop).

- Any `opencode` provider needs `AIDLC_OPENCODE_MODEL` as `provider/model[#variant]` (for example `opencode-go/gpt-6-luna`) in `.agents/loop.env`, the shell, or `"model"` in `opencode.json` (detected locally). Without a valid value the provider turn fails closed and `loop start`/`loop up` stop before the daemon starts.
- **Isolated lead.** Rejects OpenCode with `OpenCode workers require file-based credentials and are not available in isolated containers yet`; no host fallback.
- **Docker workers.** Local worker batches and fleet worker containers accept OpenCode, authenticating from the key matching the model prefix (`openai/` → `OPENAI_API_KEY`, `anthropic/` → `ANTHROPIC_API_KEY`, otherwise `OPENCODE_API_KEY`) and redirecting OpenCode's XDG data/config roots into the worker's ephemeral HOME.

### Parallel work partition

With `loop.mode` `local` or `fleet`, the Approve plan gate check requires owned paths on every open build item (`PARTITION_SCOPE`) and no overlapping paths between items that can run concurrently (`PARTITION_OVERLAP`). With the loop `off` both are warnings and the gate passes; see [Troubleshooting](./troubleshooting.md#parallel-work-partition-partition_overlap--partition_scope).

## Related

- [Loop setup runbook](./loop-runbook.md) — loop setup.
- [Command reference](./command-reference.md#loop) — loop actions and environment.
- [AI-DLC Coordination service](./coordination-service.md) — fleet operations.
- [Operating the workflow](./operating-workflow.md) — lifecycle and gates.
