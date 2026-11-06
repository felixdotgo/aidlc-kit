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

# OPTIONAL — required ONLY for the web dashboard live log when you start the
# daemon manually. Must point at the exact file the UI reads:
export AIDLC_LOOP_EVENT_LOG="$PWD/.agents/data/loop/ui-events.jsonl"

# No need to set AIDLC_WORKER_DOCKER_IMAGE — the loop builds the image itself (see §7).
# Only the worker credential is needed when it reaches the build phase:
# export OPENAI_API_KEY=...   or   export ANTHROPIC_API_KEY=...  (per model)
```

List available models:

```sh
opencode models
```

> [!IMPORTANT]
> Both variables must be exported **in the same shell that starts the daemon** — the
> daemon and every lead/worker turn it spawns inherit only that process's environment.
> A daemon started *before* you exported `AIDLC_OPENCODE_MODEL` will keep failing with
> `opencode provider requires AIDLC_OPENCODE_MODEL` until it is restarted.

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

In **local** mode there is **no one-shot `loop resume`** — the daemon is the only runner,
and it auto-resumes every task whose derived `nextAction` is `run_phase` (an *actionable*
task). What you do depends on why the task stopped:

- **After approving a gate** — nothing to do. Approval moves the task back to `active`, the
  daemon's next poll sees it as actionable, and it runs the next lead turn automatically.
- **After a pause** (e.g. an agent transport failure) — the loop marks the task `paused`
  (`nextAction` becomes `blocked`), which is **not** actionable, so the daemon skips it and
  `loop status` shows `actionable: []`. Fix the root cause, then set the task back to
  `active`:

  ```sh
  node .agents/aidlc/scripts/state.mjs task status <task-id> --status active
  ```

  The daemon picks it up on the next poll (default ~5s).

> `aidlc-kit loop resume`/`loop-entry.mjs resume` in local mode fails closed with
> `Local loop resume is removed; the daemon auto-resumes actionable tasks — run 'loop start'`.
> Use `state.mjs task status --status active` instead of trying to "resume the loop".

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

### 5.7 Web dashboard (`aidlc-kit ui`)

```sh
# via npx:
npx --package @felixdotgo/aidlc-kit@0.1.1 aidlc-kit ui --root .

# or from source:
node dist/src/cli.js ui --root .
```

Binds `127.0.0.1:4173` by default and prints a **one-time approve token** to the terminal.
Open the dashboard and paste that token into **⚙ Settings → save** before using any
mutating action (loop start, gate approve); it is stored in `localStorage`.

Where things live (this is the #1 source of confusion):

- **Gate approval button is only on the full task detail page** (`/tasks/<task-id>`), **not
  on the dashboard**. From the dashboard, click a task to open the quick modal and press
  **"open in page"**, or ctrl/cmd-click / middle-click the task link to jump straight to the
  detail page. On the detail page the **Approve `<gate>`** box (note field + green
  **approve** button) appears only while the task is `blocked_on_user`.
- **The dashboard "resume" button does not work in local mode** — it calls the removed
  one-shot `loop resume` (see §5.5). For a `blocked_on_user` task, approve the gate instead;
  for a `paused` task, set it back to `active` with `state.mjs`.
- **The live log (bottom of the detail page) reads a fixed file**
  `.agents/data/loop/ui-events.jsonl`. The daemon only writes there when `AIDLC_LOOP_EVENT_LOG`
  points at that exact path. Starting the loop via the dashboard's **New task → start loop**
  sets it automatically; a **manually started** daemon needs the export from §5.1, otherwise
  the live log stays empty even though the loop is running fine.

Gate approval stays equally available on the trusted terminal (`loop-gate.mjs`, §5.4), which
needs no token.

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
Remember the daemon must be (re)started *after* exporting the variable — a daemon started
without it keeps failing until restarted.

### 9.6 Web dashboard live log is empty / stuck on "connecting…"

- The live log reads a **fixed** file `.agents/data/loop/ui-events.jsonl`; the daemon only
  writes there when `AIDLC_LOOP_EVENT_LOG` points at that exact path. A manually started
  daemon without that export produces no events — see §5.1. Restart the daemon after setting
  it.
- The live log is only on the task **detail** page (`/tasks/<id>`), not the dashboard.
- A stopped daemon produces no events. Confirm it is alive with `ps` and `loop status`.
- Check `tail -f .agents/data/loop/ui-events.jsonl` directly: if the file grows with
  `daemon_poll` lines, the daemon is healthy and only the browser side is stale (hard refresh).

### 9.7 Task pauses immediately after I approve a gate; daemon polls `actionable: []`

Approval moved the task to `active`, the daemon picked it up and tried a lead turn, but the
turn failed — so the loop re-paused the task (`status: paused`, `nextAction: blocked`), and a
paused task is not actionable. Diagnose from the evidence:

```sh
node .agents/aidlc/scripts/state.mjs task show <task-id>
```

Look for a `diagnostic` with `Paused while active: agent transport failure: …`. The cause is
almost always the missing/invalid `AIDLC_OPENCODE_MODEL` (or an unavailable model). Then:

1. Fix the environment (`opencode models`, export `AIDLC_OPENCODE_MODEL`).
2. Kill and restart the daemon with the corrected environment (§5.1).
3. Set the task back to actionable:

   ```sh
   node .agents/aidlc/scripts/state.mjs task status <task-id> --status active
   ```

### 9.8 Clicking "approve" (or "resume") on the web UI does nothing

- The **approve** button exists only on the full detail page `/tasks/<id>`, not the
  dashboard. Click the task → **"open in page"** (or ctrl/cmd-click the link).
- Mutating actions need the session token pasted into **Settings** first; without it they
  return `401` (shown inline under the button).
- The dashboard **resume** button is a no-op in local mode (the one-shot `loop resume` was
  removed — §5.5). Approve the gate or use `state.mjs task status --status active` instead.
- If approve does *literally nothing* (no inline result, no error, no reload) and you are on
  an old build: open the browser DevTools console and look for
  `SyntaxError: Identifier 'post' has already been declared`. That was a UI bug (the detail
  page declared `const post` twice, silently disabling the approve handler) fixed in source —
  rebuild/repack from a checkout that includes the fix, restart `ui`, and hard-refresh
  (Ctrl+Shift+R) to drop the cached page.

---

## 10. References

- [Loop setup runbook](./loop-runbook.md) — the official runbook.
- [Configuration](./configuration.md#optional-loop-configuration) — `loop.*` fields.
- [Command reference](./command-reference.md#loop) — full flags & env.
- [Coordination service](./coordination-service.md) — fleet (multi-machine).
