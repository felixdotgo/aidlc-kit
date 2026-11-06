# Configuration

Each installed project owns its workflow configuration at `.agents/config.json`. It selects topology profiles, specification roots, safe verification commands, and local rules without changing the package-managed kernel. The package supports Codex, Claude Code, and OpenCode.

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

Commands are stored as executable and argument arrays. Do not replace them with shell strings: this keeps execution inspectable and avoids accidental shell interpretation.

## Optional `$schema` key

The generated `.agents/config.json` includes an optional top-level `$schema` key pointing at the relative path `./aidlc/schemas/config.schema.json` (the schema installed under `.agents/aidlc/schemas/`). Editors use it for autocompletion and validation of the configuration file, and it has no runtime effect. New installs receive it automatically through `init`; existing installs can add it manually:

```json
{
  "$schema": "./aidlc/schemas/config.schema.json"
}
```

The value must be a string of at most 512 characters. The path is relative so validation works offline without a network dependency.

G0, G1, and G2 always require explicit human approval. Configuration cannot auto-pass a gate.

## Configuration layers

Values resolve in this order, with the later applicable layer taking precedence:

```text
kernel → built-in topology → local profile parents/child → project config/rules → approved task decisions
```

Built-in topology profiles are:

- `topology/generic`
- `topology/single`
- `topology/workspace`
- `topology/git-submodules`

Arrays are stable-deduplicated. Command keys are last-wins, so a project can replace a profile command intentionally. Validate the resolved profile chain with:

```sh
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit profile validate .
```

This command uses the npm package at version `0.2.0`. To run from a source checkout instead, see the [development guide](./development.md).

## Rules, project data, and managed assets

| Location | Ownership | Use it for |
| --- | --- | --- |
| `.agents/aidlc/` | Package managed | Kernel contracts, phases, schemas, and dependency-free runtime scripts. |
| `.agents/data/` | Project owned | Lifecycle state, task artifacts, indexes, memory, and evidence. |
| `.agents/project/` | Project owned | Profiles, rules, and project-specific evaluation material. |

Keep business/domain rules in `.agents/project/rules/`. Do not edit managed kernel files to customise a project; a later installation or human-run upgrade may report conflicts for modified managed content.

## Agent permissions

The Codex adapter installs `.codex/config.toml` with `approval_policy = "on-request"` and `sandbox_mode = "workspace-write"`, plus `.codex/rules/aidlc.rules`. The execpolicy allowlists only the six lifecycle entry points under `node .agents/aidlc/scripts/`, allowing AI-DLC state transitions without granting general command approval. Each allowed lifecycle command must be run as its own exec invocation: joining commands with `&`, `&&`, `;`, or `|` creates shell command segments that are not covered by a single prefix rule. Codex loads this project config only after the user trusts the project; network access stays disabled unless the project separately enables it. Claude Code installs `.claude/settings.local.json` and phase skills that allow only `node .agents/aidlc/scripts/*`, so lifecycle state updates do not require repeated confirmation while general Bash commands remain unapproved.

The OpenCode adapter installs only an owner-scoped managed block in `AGENTS.md` and reads `.opencode/` solely to detect the adapter. It writes no OpenCode configuration, MCP, or permission file, so user and project OpenCode settings are not overridden. Codex and OpenCode blocks are independently owned and merge in the same `AGENTS.md` when both adapters are installed.

## Context and risk

`context.maxChars` bounds a phase packet. The runtime preserves lifecycle instructions, approved decisions, and mandatory invariants; it fails clearly rather than silently truncating required contract content.

Set the default risk level deliberately. Planning, migrations, cross-service contracts, and security-sensitive changes deserve a stronger reviewer or an explicit human decision even when the configuration default is normal.

## Optional AI-DLC Coordination

`mcp` is absent (or `{ "enabled": false }`) by default. An enabled configuration requires an HTTP(S) `endpoint` and non-empty `workspace`; it may also name a token environment variable, polling interval from 1,000 to 3,600,000 ms, and the enabled Jira/Trello/GitHub Issues preflight providers. See [AI-DLC Coordination service](./coordination-service.md) for the remote-authority and deployment contract. The coordination service (and fleet mode) is **experimental and still under active development** (known bugs included), and it can change incompatibly in any release before `1.0.0`.

## Optional loop configuration

> [!WARNING]
> The loop is **experimental** and pre-1.0 (`0.x`): the `loop.*` fields, provider mappings, and environment variables can change incompatibly in any release before `1.0.0`. **Local mode is usable** today; **fleet mode is still under active development**.

`loop.mode` can be `off`, `local`, or `fleet`; an absent `loop` field means `off`. Both enabled modes run the loop as the same persistent multi-task daemon (one per project, enforced by a lock): `loop start` launches it, and it polls the configured authority — canonical local state, or the coordination service in `fleet` mode — auto-picking every actionable **loop-owned** task without prompting for a requirement. A task is loop-owned when it was created through loop intake (the web dashboard **New task**, `aidlc-kit loop intake`, or `loop-entry.mjs intake`) or, locally, already has a loop run record; fleet ownership is recorded by the intake file `.agents/data/tasks/<id>/loop-intake.json` with `authority: "fleet"`. Tasks created by an interactive lead are never picked up. The optional `loop.agents` maps one lead and named workers to `codex`, `claude`, or `opencode`, independently of `mcp.providers`:

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

The optional `loop.pollMs` (integer, `1000`–`300000`, default `5000`) sets the daemon's poll interval. The optional `loop.limits` bounds each supervised lead run: `maxTurns` (`1`–`1000`, default `12`) is the turn budget of **one run** — a resumed run starts a fresh budget, so a long multi-gate task is not permanently re-paused — `turnTimeoutMs` (`1`–`3600000`, default `600000`) caps a single agent turn, and `maxStallTurns` (`1`–`20`, default `2`) pauses after that many consecutive turns without observable progress. `loop.pollMs` and `loop.limits` apply to `fleet` mode as well: `loop start` passes them to the fleet supervisor as `AIDLC_FLEET_MAX_TURNS`, `AIDLC_FLEET_TURN_TIMEOUT_MS`, `AIDLC_FLEET_MAX_STALL_TURNS`, and `AIDLC_FLEET_POLL_MS`, and an explicitly exported value of any of those variables overrides the config.

The optional `loop.workerImage` maps a provider to a worker Docker image tag (for example `{ "opencode": "aidlc-worker-opencode:local" }`). `aidlc-kit loop worker-image` records it; local build dispatch and fleet worker machines use it, falling back to `aidlc-worker-<provider>:local`, which is auto-built from the packaged Dockerfile when missing. `AIDLC_WORKER_DOCKER_IMAGE` overrides it.

With `loop.mode` set to `local` or `fleet`, the Approve plan gate check enforces a parallel work partition: every open build item needs owned paths (`PARTITION_SCOPE`), and items that can run concurrently must not own overlapping paths (`PARTITION_OVERLAP`). With the loop `off` the same findings are warnings and the gate still passes. See [Troubleshooting](./troubleshooting.md#parallel-work-partition-partition_overlap--partition_scope).

When any selected provider is `opencode`, set `AIDLC_OPENCODE_MODEL` to a `provider/model[#variant]` value such as `opencode-go/gpt-6-luna`. The provider turn fails closed without a valid value. The container-isolated lead rejects OpenCode with `OpenCode workers require file-based credentials and are not available in isolated containers yet`; it does not fall back to the host. Local Docker worker batches and fleet worker containers accept OpenCode: they authenticate from the environment key matching the model prefix (`openai/` → `OPENAI_API_KEY`, `anthropic/` → `ANTHROPIC_API_KEY`, otherwise `OPENCODE_API_KEY`) and redirect OpenCode's XDG data/config roots into the worker's ephemeral HOME.

Configure this field through the init or human-run upgrade preview, or edit the project-owned config deliberately. Provider credentials do not belong in this object. The configuration is an opt-in selection; it does not install or start a service, authorize an upgrade, or grant gate approval. Selecting a mode alone does not start the loop — run `aidlc-kit loop start` to launch the daemon. Existing fleet operations and storage requirements are documented in [Coordination service](./coordination-service.md).
