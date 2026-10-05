# Configuration

Each installed project owns its workflow configuration at `.agents/config.json`. It selects topology profiles, specification roots, safe verification commands, and local rules without changing the package-managed kernel. The package supports only Codex and Claude Code.

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
npx --package @felixdotgo/aidlc-kit@0.0.1 aidlc-workflow profile validate .
```

This command uses the npm package at version `0.0.1`. To run from a source checkout instead, see the [development guide](./development.md).

## Rules, project data, and managed assets

| Location | Ownership | Use it for |
| --- | --- | --- |
| `.agents/aidlc/` | Package managed | Kernel contracts, phases, schemas, and dependency-free runtime scripts. |
| `.agents/data/` | Project owned | Lifecycle state, task artifacts, indexes, memory, and evidence. |
| `.agents/project/` | Project owned | Profiles, rules, and project-specific evaluation material. |

Keep business/domain rules in `.agents/project/rules/`. Do not edit managed kernel files to customise a project; a later installation or human-run upgrade may report conflicts for modified managed content.

## Agent permissions

The Codex adapter installs `.codex/config.toml` with `approval_policy = "on-request"` and `sandbox_mode = "workspace-write"`, plus `.codex/rules/aidlc.rules`. The execpolicy allowlists only the six lifecycle entry points under `node .agents/aidlc/scripts/`, allowing AI-DLC state transitions without granting general command approval. Each allowed lifecycle command must be run as its own exec invocation: joining commands with `&`, `&&`, `;`, or `|` creates shell command segments that are not covered by a single prefix rule. Codex loads this project config only after the user trusts the project; network access stays disabled unless the project separately enables it. Claude Code installs `.claude/settings.local.json` and phase skills that allow only `node .agents/aidlc/scripts/*`, so lifecycle state updates do not require repeated confirmation while general Bash commands remain unapproved.

## Context and risk

`context.maxChars` bounds a phase packet. The runtime preserves lifecycle instructions, approved decisions, and mandatory invariants; it fails clearly rather than silently truncating required contract content.

Set the default risk level deliberately. Planning, migrations, cross-service contracts, and security-sensitive changes deserve a stronger reviewer or an explicit human decision even when the configuration default is normal.

## Optional AI-DLC Coordination

`mcp` is absent (or `{ "enabled": false }`) by default. An enabled configuration requires an HTTP(S) `endpoint` and non-empty `workspace`; it may also name a token environment variable, polling interval from 1,000 to 3,600,000 ms, and the enabled Jira/Trello/GitHub Issues preflight providers. See [AI-DLC Coordination service](./coordination-service.md) for the remote-authority and deployment contract.
