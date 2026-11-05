# Run the AI-DLC Loop (local) for the aidlc-kit repo

End-to-end guide for running the loop on the `aidlc-kit` repo itself (dogfooding),
single machine (`local` mode). All lead/workers use **OpenCode**.

> The loop and coordination service are **experimental** (pre-1.0). Flags, `loop.*`
> fields, environment variables, and diagnostics can change incompatibly before `1.0.0`.

> **npx vs. source.** The run commands below show **both** forms: `npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit …` (the published package — primary for end users) and `node dist/src/cli.js …` (dogfooding the `aidlc-kit` repo from a source checkout, after `npm run build`). Both drive the same installed `loop-entry.mjs`. Gate approval (§5.4) always stays on the trusted terminal via the installed `loop-gate.mjs` script and is never an `npx` command.

---

## 1. What the loop is (summary)

The loop runs an AI-DLC task from start to finish:

- The **lead** agent runs the `clarify`, `plan`, and `wrap` phases (on the host).
- **Workers** only run build items (in Docker, isolated).
- Each loop iteration reads `state.mjs task next` → gets `nextAction` → passes context to
  the agent → runs one turn → re-reads canonical state → updates checkpoint/fingerprint.
- The loop **stops at every gate** and **never self-approves** — approval happens only
  through the trusted terminal.
- The loop also stops on its own when: `--max-turns` is exhausted, `max-stall-turns`
  consecutive turns show no change, or the state is `blocked`/`terminal`/`complete`.

Setting the config alone **does not run anything** — the loop only runs when you call
`loop start`.

---

## 2. Current configuration (already set up)

`.agents/config.json`:

```json
{
  "loop": {
    "mode": "local",
    "agents": {
      "lead": "opencode",
      "workers": { "worker-a": "opencode", "worker-b": "opencode" }
    }
  }
}
```

Quick check:

```sh
node -e 'const c=JSON.parse(require("fs").readFileSync(".agents/config.json","utf8")); console.log(JSON.stringify(c.loop,null,2))'
```

---

## 3. Prerequisites

| Item | Requirement | Notes |
| --- | --- | --- |
| Linux host | required | Loop/fleet needs Docker + POSIX shell. |
| Node | ≥ 20.17 | The repo is currently on v24. |
| Docker engine | for build/worker | `docker info` must pass. |
| OpenCode CLI | `opencode` on PATH | `opencode --version` (currently v2.2.5). |
| Valid model | `AIDLC_OPENCODE_MODEL` | **Must be present in `opencode models`.** |
| Worker image | for build phase | Image containing the real `opencode` CLI (see §7). |
| Credentials | per model | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` for workers. |

---

## 4. Check configuration & sync

### 4.1 Check for drift (installed `.agents/` vs source `assets/`)

```sh
diff -rq assets/aidlc/scripts .agents/aidlc/scripts
```

If it produces output → the installed copy is stale. A typical error when drifted:

```
loop: Isolated local worker dispatcher is not integrated; loop execution is unavailable
```

### 4.2 Re-sync (human-only — requires a TTY)

```sh
npm run build
node dist/src/cli.js upgrade . --dry-run   # preview the plan
node dist/src/cli.js upgrade .             # apply, type "0.1.1" when prompted
```

Then re-run `diff -rq ...` (should be empty) and a quick test:

```sh
node dist/src/cli.js loop status --root . --task-id <task-id>
```

---

## 5. Run the loop end-to-end (local)

### 5.1 Set environment variables

```sh
# REQUIRED — use a model that is actually in the list:
export AIDLC_OPENCODE_MODEL=opencode-go/deepseek-v4-pro

# No need to set AIDLC_WORKER_DOCKER_IMAGE — the loop builds the image itself (see §7).
# Only the worker credential is needed when it reaches the build phase:
# export OPENAI_API_KEY=...   or   export ANTHROPIC_API_KEY=...  (per model)
```

List available models:

```sh
opencode models
```

### 5.2 Start (create a new task + run)

The requirement is read from stdin (never passed as an argument), max 8192 bytes:

```sh
# via npx (published package):
echo "Add PDF report export" | npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit loop start --root .

# or from a source checkout (after `npm run build`):
echo "Add PDF report export" | node dist/src/cli.js loop start --root .
```

Or run interactively (it will prompt for the requirement):

```sh
# via npx:
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit loop start --root .

# or from source:
node dist/src/cli.js loop start --root .
```

### 5.3 Watch status

```sh
# via npx:
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit loop status --task-id <task-id> --root .

# or from source:
node dist/src/cli.js loop status --task-id <task-id> --root .
```

Prints `authority`, `record` (run record), and `nextAction`
(`classification` = `run_phase` / `await_user` / `blocked` / `complete`...).

### 5.4 Approve a gate (ONLY from the trusted terminal)

```sh
node .agents/aidlc/scripts/loop-gate.mjs <task-id>
# type: approve
```

Never approve from the lead/worker, and never pipe input.

### 5.5 Resume after stopping at a gate / pause

```sh
# via npx:
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit loop resume --task-id <task-id> --root .

# or from source:
node dist/src/cli.js loop resume --task-id <task-id> --root .
```

### 5.6 Streaming log — see what the lead is doing

The loop prints progress to **stderr** (stdout remains the final JSON), so you can see
what the lead is doing during a long turn:

```
━━ turn 1 · phase clarify · agent opencode ━━
  › tool: grep
  › tool: read
  › command completed (exit 0)
<stream text from the lead>
━━ turn done ━━
```

When the lead reaches a gate, the loop immediately prints the **gate view** (approval
instructions) instead of polling silently. After printing, the supervisor **keeps running
in the foreground and polls (~5s)** waiting for you to approve in a second terminal via
`loop-gate.mjs <id>` — this is by design: the loop neither self-approves nor exits at a
gate.

Streamed events: `turn_start`/`turn_end` (turn boundary + phase + agent), `agent_text`
(lead text, capped at 4096 chars/chunk), `agent_tool` (tool being used such as
`grep`/`read`/`glob`/`shell`), `lifecycle_command` (shell result + exit code), and `gate`
(gate view).

---

## 6. Lifecycle (phases / gates)

| Phase | Who runs it | Stops at gate |
| --- | --- | --- |
| clarify | lead | `G0_confirm` |
| plan | lead | `G1_review` |
| build | workers (Docker) | `G2_codereview` |
| wrap | lead | → `complete` |

`clarify`, `plan`, `wrap` run on the host, **no Docker needed**.
Only `build` needs the worker image + credentials (§7).

---

## 7. Worker Docker image (build phase only)

The build phase fans workers out into isolated Docker containers and needs an image
containing the worker provider CLI (`opencode`/`codex`/`claude`). **You no longer need to
build it by hand following a guide**:

- The official worker image is **shipped with the package**
  (`assets/aidlc/docker/Dockerfile.<provider>`).
- Run a single command to build it (default provider `opencode`):

```sh
npx @felixdotgo/aidlc-kit loop worker-image --provider opencode
# --provider codex | --provider claude ; default tag aidlc-worker-<provider>:local
```

- The build command **records the image name into `.agents/config.json`**
  (`loop.workerImage`); the supervisor reads it automatically, so you **don't need to
  `export AIDLC_WORKER_DOCKER_IMAGE`** manually.
- When the loop reaches the build phase and an image is missing, the supervisor
  **auto-builds** the image for the right provider before preflight, so you usually don't
  need to run the command above proactively.

The `aidlc-worker-*-test:local` images on your machine **only contain a fake CLI for
tests**; the real image is built from the shipped Dockerfile (base `node:24-bookworm-slim`,
CLI installed via `npm install -g`).

Notes:
- Debian/glibc base because the `opencode` binary is a dynamically linked ELF; the driver
  runs non-root + `--read-only`, so the CLI must be on the system `PATH` (npm global →
  `/usr/local/bin`).
- `opencode` uses `@opencode/cli` (OpenCode 2), **not** `opencode-ai` (OpenCode 1).
- Worker credentials still need to be exported (per model): `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` / `OPENCODE_API_KEY`.
- Preflight runs `docker run ... --entrypoint <cli> --version`; a missing or invalid
  binary fails before any worker starts.

---

## 8. Quick lead-only run (no Docker, no workers)

Run the loop right away with a single lead, no Docker/workers needed:

```sh
export AIDLC_OPENCODE_MODEL=opencode-go/deepseek-v4-pro

node .agents/aidlc/scripts/loop.mjs run <task-id> --agent opencode --max-turns 12 --root .
node .agents/aidlc/scripts/loop.mjs status <task-id> --root .
node .agents/aidlc/scripts/loop.mjs resume <task-id> --root .
```

JSON output returns `status` ∈ `gate | paused | blocked | complete` with `stopReason` and
`nextAction`.

---

## 9. Troubleshooting

### 9.1 Loop stops immediately / no approve prompt

First check the evidence to see why the loop stopped:

```sh
node .agents/aidlc/scripts/state.mjs task show <task-id>
```

In the streaming build (after sync), the error appears directly in `stopReason` instead of
`opencode exited 1:` (empty stderr). Example — model unavailable:

```
"agent transport failure: opencode reported an error: Model unavailable: opencode-go/flint-40b-free"
```

→ Wrong/unavailable model. Check `opencode models`, set `AIDLC_OPENCODE_MODEL` again, then
`loop resume`.

Raw OpenCode log (full stacktrace) if needed:

```sh
grep -n "ModelUnavailableError\|Failed to drain Session" ~/.local/share/opencode/log/opencode.log | tail -20
```

> Note: if the lead runs for a long time without output, it is **not hanging** — a
> clarify/plan turn with a free model can take a few minutes. Streaming (§5.6) now lets
> you see each tool/text the lead is running.

### 9.2 `Isolated local worker dispatcher is not integrated`

The installed `.agents/` is stale (missing `createIsolatedLocalSupervisor`). Re-sync per
§4.2.

### 9.3 `Loop requires a configured lead and worker providers`

`loop.mode` is enabled but `loop.agents.lead` or `loop.agents.workers` is missing. Check §2.

### 9.4 `Requested mode does not match configured authority`

The `--mode` passed in differs from `loop.mode` in config. Drop `--mode` to use the config
value.

### 9.5 `opencode provider requires AIDLC_OPENCODE_MODEL`

`AIDLC_OPENCODE_MODEL` is unset or in the wrong `provider/model[#variant]` format. See §5.1.

---

## 10. References

- [Loop setup runbook](./loop-runbook.md) — the official runbook.
- [Configuration](./configuration.md#optional-loop-configuration) — `loop.*` fields.
- [Command reference](./command-reference.md#loop) — full flags & env.
- [Coordination service](./coordination-service.md) — fleet (multi-machine).
