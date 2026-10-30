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
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit profile validate .
```

This command uses the npm package at version `0.1.1`. To run from a source checkout instead, see the [development guide](./development.md).

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

`mcp` is absent (or `{ "enabled": false }`) by default. An enabled configuration requires an HTTP(S) `endpoint` and non-empty `workspace`; it may also name a token environment variable, polling interval from 1,000 to 3,600,000 ms, and the enabled Jira/Trello/GitHub Issues preflight providers. See [AI-DLC Coordination service](./coordination-service.md) for the remote-authority and deployment contract. The coordination service is **experimental and unfinished** (known bugs included), and it can change incompatibly in any release before `1.0.0`.

## Optional loop configuration

> [!WARNING]
> The loop and the coordination service are **experimental and unfinished**: they contain known bugs and rough edges, and — because the package is still pre-1.0 (`0.x`) — the `loop.*` fields, provider mappings, and environment variables can change incompatibly in any release before `1.0.0`.

`loop.mode` can be `off`, `local`, or `fleet`; an absent `loop` field means `off`. The optional `loop.agents` maps one lead and named workers to `codex`, `claude`, or `opencode`, independently of `mcp.providers`:

```json
{
  "loop": {
    "mode": "local",
    "agents": { "lead": "codex", "workers": { "worker-a": "codex", "worker-b": "opencode" } }
  }
}
```

When any selected provider is `opencode`, set `AIDLC_OPENCODE_MODEL` to a `provider/model[#variant]` value such as `opencode-go/gpt-6-luna`. The provider turn fails closed without a valid value. Docker-isolated lead turns, local Docker worker batches, and fleet worker containers reject OpenCode with `OpenCode workers require file-based credentials and are not available in isolated containers yet`; they do not fall back to the host.

Configure this field through the init or human-run upgrade preview, or edit the project-owned config deliberately. Provider credentials do not belong in this object. The configuration is an opt-in selection; it does not install or start a service, authorize an upgrade, or grant gate approval. Selecting a mode alone does not start the loop — run `aidlc-kit loop start` explicitly. Existing fleet operations and storage requirements are documented in [Coordination service](./coordination-service.md).
