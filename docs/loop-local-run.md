# Run the AI-DLC Loop (local) for the aidlc-kit repo

End-to-end guide for running the loop on the `aidlc-kit` repo itself (dogfooding),
single machine (`local` mode). All lead/workers use **OpenCode**.

> **Local loop mode is usable** today; **fleet mode is still under active development**. The loop is **experimental** (pre-1.0): flags, `loop.*` fields, environment variables, and diagnostics can change incompatibly before `1.0.0`.

> **npx vs. source.** The run commands below show **both** forms: `npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit …` (the published package — primary for end users) and `node dist/src/cli.js …` (dogfooding the `aidlc-kit` repo from a source checkout, after `npm run build`). Both drive the same installed `loop-entry.mjs`. Gate approval (§5.4) always stays on the trusted terminal via the installed `loop-gate.mjs` script and is never an `npx` command.

---

## 1. What the loop is (summary)

The loop runs an AI-DLC task from start to finish:

- The **lead** agent runs the `clarify`, `plan`, and `wrap` phases (on the host).
- **Workers** only run build items (in Docker, isolated).
- Each loop iteration reads `state.mjs task next` → gets `nextAction` → passes context to
  the agent → runs one turn → re-reads canonical state → updates checkpoint/fingerprint.
- The loop **stops at every gate** and **never self-approves** — approval happens only
  through the trusted terminal.
- The loop also stops on its own when: the per-run `maxTurns` budget is exhausted (it
  bounds one supervised run, not the task's lifetime — a resumed run gets a fresh budget),
  `maxStallTurns` consecutive turns show no change, or the state is
  `blocked`/`terminal`/`complete`. Both limits come from `loop.limits` (see
  [configuration](./configuration.md#optional-loop-configuration)).

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
node dist/src/cli.js upgrade .             # apply, type "0.2.0" when prompted
```

Then re-run `diff -rq ...` (should be empty) and a quick test:

```sh
node dist/src/cli.js loop status --root . --task-id <task-id>
```

---

## 5. Run the loop end-to-end (local)

### 5.1 Set environment variables

Put them in `.agents/loop.env` (installed as a commented template, git-ignored through
`.agents/.gitignore`). `loop start`/`loop up` and a daemon started by the dashboard load it;
anything exported in the shell wins.

```sh
# .agents/loop.env
# REQUIRED for opencode unless "model" is set in opencode.json — use a model from `opencode models`:
AIDLC_OPENCODE_MODEL=opencode-go/deepseek-v4-pro
# Worker key for the build phase; read from ~/.local/share/opencode/auth.json when unset:
# OPENCODE_API_KEY=...
```

`AIDLC_LOOP_EVENT_LOG` is set to `.agents/data/loop/ui-events.jsonl` automatically, and the
loop builds the worker image itself (see §7). Check what the daemon will see — secret
values are never printed:

```sh
./.agents/aidlc/scripts/loop.sh check
# or: node dist/src/cli.js loop env --root .
```

> [!IMPORTANT]
> A running daemon keeps the environment it started with. After editing `.agents/loop.env`,
> restart it (`loop.sh down`, then `loop.sh up`); `loop up` warns when the file changed after
> the daemon started.

Manual alternative: `export` the same variables in the shell that starts the daemon.

### 5.2 Start the daemon, then add tasks

One command checks the environment, starts the daemon in the background, and serves the
dashboard (`Ctrl-C` closes only the dashboard; `loop.sh down` stops both):

```sh
./.agents/aidlc/scripts/loop.sh up
# or from a source checkout: node dist/src/cli.js loop up --root .
```

The underlying commands follow. In **local** mode `loop start` launches the persistent daemon (one per project — a second
`loop start` fails with `Loop daemon already running (pid N)`). It does **not** read a
requirement:

```sh
# via npx (published package):
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop start --root .

# or from a source checkout (after `npm run build`):
node dist/src/cli.js loop start --root .
```

The daemon only runs **loop-owned** tasks — tasks created through loop intake (they have
`.agents/data/tasks/<id>/loop-intake.json`) or that already have a loop run record. A task
you create interactively (Claude Code/Codex/OpenCode via `state.mjs task create`) is never
picked up, so the daemon cannot race an interactive lead on the same task.

Add a loop-owned task in either way:

- **Web dashboard** → **New task** (§5.7): creates the task and starts the daemon if none is
  running.
- **Terminal** — the requirement is read from stdin (never an argument), max 8192 bytes; the
  task id/title are derived from its first line (override with `--task-id`/`--title`):

  ```sh
  echo "Add PDF report export" | npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop intake --root .
  echo "Add PDF report export" | node dist/src/cli.js loop intake --root .
  # or the installed entry point directly:
  echo "Add PDF report export" | node .agents/aidlc/scripts/loop-entry.mjs intake "" .
  ```

Intake refuses (and creates nothing) while an **interactive** task is actionable; finish or
pause it first. Other actionable loop-owned tasks are fine — the daemon runs them in turn.

Stopping the daemon (`Ctrl-C` or `SIGTERM`) is two-stage: the first signal stops after the
current turn, the second cancels the in-flight agent turn, the third exits immediately. A
stopped run is recorded as `stopped` (the task is **not** paused) and resumes on the next
`loop start`. Note that a terminal `Ctrl-C` is also delivered to the agent child process, so
the in-flight turn usually ends right away even on the first press; it is still recorded as
`stopped`, not as a transport failure. `aidlc-kit loop start` stays in the foreground for
the whole shutdown (it forwards `SIGTERM` to the daemon and lets the terminal deliver
`Ctrl-C`), so the second and third presses still reach the daemon.

### 5.3 Watch status

```sh
# via npx:
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit loop status --task-id <task-id> --root .

# or from source:
node dist/src/cli.js loop status --task-id <task-id> --root .
```

Prints `authority`, `record` (run record), and `nextAction`
(`classification` = `run_phase` / `await_user` / `blocked` / `complete`...).

### 5.4 Approve a gate, or send feedback (trusted terminal or dashboard — never the agent)

```sh
node .agents/aidlc/scripts/loop-gate.mjs <task-id>
# type: approve            -> approves this exact review and advances the phase
# type: <any other text>   -> feedback: the task stays at this gate
```

Approve is not the only answer at a gate. Typing anything other than `approve` is
**feedback**: it is recorded as evidence `Cancelled gate wait at <gate>: <feedback>`, the task
goes back to `active` at the same phase/gate, and the daemon's next lead turn revises the
review artifact and re-presents the **same** gate. Only `approve` moves the task forward.

Never approve from the lead/worker, and never pipe input. The signed-in dashboard (§5.7)
offers both actions on the task detail page: **Send feedback (stay at gate)** and
**✓ Approve** (behind a confirmation popup).

### 5.5 Resume after stopping at a gate / pause

There is **no `loop resume`** (in either mode) — the daemon is the only runner,
and it auto-resumes every task whose derived `nextAction` is `run_phase` (an *actionable*
task). What you do depends on why the task stopped:

- **After approving a gate** — nothing to do. Approval moves the task back to `active`, the
  daemon's next poll sees it as actionable, and it runs the next lead turn automatically.
- **After a pause** (e.g. an agent transport failure or the per-run turn limit) — the loop
  marks the task `paused` (`nextAction` becomes `blocked`), which is **not** actionable, so
  the daemon skips it. Fix the root cause, then set the task back to `active` (or press
  **resume** on the dashboard, which does exactly this):

  ```sh
  node .agents/aidlc/scripts/state.mjs task status <task-id> --status active
  ```

  The daemon picks it up on the next poll (default ~5s).

> `aidlc-kit loop resume`/`loop-entry.mjs resume` fails closed with
> `loop resume is removed; the daemon auto-resumes actionable tasks — run 'loop start', and re-activate a paused task from the dashboard (resume) or with the task status command`.
> Use `state.mjs task status --status active` (or `loop-entry.mjs resume-task <task-id> .`)
> instead of trying to "resume the loop".

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

When the lead reaches a gate, the daemon immediately prints the **gate view** (approval
instructions) and moves on to the next actionable task; after you approve in a second
terminal via `loop-gate.mjs <id>` (or on the dashboard), the next poll resumes that task.
The loop never self-approves.

Streamed events: `turn_start`/`turn_end` (turn boundary + phase + agent), `agent_text`
(lead text, capped at 4096 chars/chunk), `agent_tool` (tool being used such as
`grep`/`read`/`glob`/`shell`), `lifecycle_command` (shell result + exit code), and `gate`
(gate view), plus daemon events `daemon_start`, `daemon_poll`, `daemon_poll_error` (the task
list could not be read; the daemon keeps polling), `daemon_turn`, `daemon_turn_error`, and
`loop_stopped`. A task whose run throws, or ends `blocked`/`reconcile`, is retried with
exponential backoff (poll interval doubled per failure, capped at 10 minutes). In the build
phase, `build_deferred` names a ready item held back for a later batch (`reason`: overlaps
another item, a busy path held by an active assignment, an unresolved assignment, or
`capacity` — at most one item per configured worker per batch). Every event of a run
carries its `taskId`.

### 5.7 Web dashboard (`aidlc-kit ui`)

```sh
# via npx:
npx --package @felixdotgo/aidlc-kit@0.2.0 aidlc-kit ui .

# or from source:
node dist/src/cli.js ui .
```

The dashboard is branded **Loop**. It binds `127.0.0.1:4173` by default and prints a **login
URL** (`http://127.0.0.1:4173/#token=…`). Open it (or pass `--open` to launch the browser):
the page stores the token in `localStorage` and strips it from the address bar, so mutating
actions (new task, resume, gate feedback, gate approve) work without pasting anything. The token is new on
every start; use `--token-file ~/.aidlc-ui-token` (outside the project, mode `600`, created
if missing) to keep the browser signed in across restarts. **⚙ Settings** still
accepts a pasted token. Requests from another origin or with a foreign `Host` header are
rejected `403` (see [Command reference](./command-reference.md#dashboard-authentication)).
The header shows the authority (`authority · local`), the daemon state, and a bell listing tasks that need your review. The daemon pill turns amber (**daemon · N errors**) while a task turn or a poll keeps failing; hover it for the messages, and with a single failing task it links to that task. The page follows the system light/dark preference
automatically (Bulma plus the flat `assets/ui/dashboard.css` theme layer) and uses the full
window width; results of actions appear as toasts in the bottom-right corner.

**The dashboard updates itself.** Every open page polls the server about every 1.5 s and
patches only the parts that changed (board, bell, daemon pill, task detail, side panel); it
never reloads the whole page, so what you typed, open dialogs, the open bell dropdown,
collapsed artifacts, filters, and the live log stay as they are. On the detail page a
loop event (turn end, gate, lifecycle command) triggers an update right away. When the
loop reaches a new gate, the bell count, the browser tab title (`(2) Loop`), and a
**Review needed** toast (a link to the task) update without any action; nothing asks for
browser notification permission. If the server is unreachable a **reconnecting…** pill
appears in the header and polling backs off until it answers again. Shortcuts:
<kbd>N</kbd> new task, <kbd>/</kbd> search, <kbd>Esc</kbd> close the side panel or a dialog.

Where things live (this is the #1 source of confusion):

- **Gate approval button is only on the full task detail page** (`/tasks/<task-id>`), **not
  on the dashboard**. Tasks waiting at a gate appear under the **bell** in the header (on every
  page; the badge shows how many). The dropdown lists the 5 newest; **Load more** shows 5 more at
  a time. Click an entry to jump to its detail page. Otherwise click anywhere on a card to
  open it in the **side panel** (it slides in from the right and adds `?task=<task-id>` to the
  URL, so refresh or a shared link reopens it and Back closes it) and press **Open full page ↗**;
  ctrl/cmd-click or middle-click a card opens the full page in a new tab, shift-click in this
  tab. Cards show the title only (the id is on hover, in search, and as a copy button in the
  side panel and on the detail page). **New task** opens a side panel with a Markdown editor
  (toolbar, Write/Preview); **Docs** in the header opens these guides inside the dashboard. While the task waits at a gate the side panel
  starts with an **Open review →** button to the detail page (a handed-off task shows **Open task →**).
  Both the side panel and the detail page show a
  horizontal **progress** stepper (clarify → plan → build → wrap → done) above the artifacts. On the detail page the **`<review step>`** panel appears only while the task is
  `blocked_on_user` and has two blocks, in this order:
  - **Feedback** (textarea + **Send feedback (stay at gate)**): records
    `Cancelled gate wait at <gate>: <feedback>`, sets the task back to `active`, and the loop
    revises the review artifact and re-presents the same gate — the same mechanism as typing
    feedback in `loop-gate.mjs` (§5.4). Nothing advances.
  - **Approve** (required approval note + green **✓ Approve**): clicking the button opens a
    **confirmation popup** showing the review step and your note; only **Confirm approve** in
    that popup sends the request. The note is audit provenance, not feedback — text typed
    there does not reach the loop. If the task moved to another gate since the page showed
    it, the approval is refused (`409`) and the page shows the current gate instead.
  While feedback has been sent and that gate has not been approved since, the task card and
  the detail page show a **feedback pending** pill with the pending feedback, and the Approve
  block shows a warning (approval is still allowed). If the gate's
  structural checks no longer pass, the page lists the failing checks instead of the gate view.
- **New task → Create task** runs loop intake (§5.2) and starts the daemon only if none is
  running (its stderr goes to `.agents/data/loop/daemon.log`). A toast shows the new task id,
  or the real intake error (for example an actionable interactive task).
- **Search and the status/risk filters** narrow the Kanban and List views in the browser only;
  they never call the API or change state. The **done** column shows the 8 most recent tasks;
  **Show N more** expands it (filters always search every task).
- **Task buttons follow the status:** a `paused` task shows **resume** (sets it back to
  `active`); a `blocked_on_user` task shows **review**, which opens the detail page (where
  both feedback and approve live).
- **The live log (bottom of the detail page)** shows only that task's events as readable
  lines (`time · actor · what happened`, grouped by turn): which command the lead or a worker
  ran and its exit code, which files it edited, what a worker reported, which item was
  integrated, and when the task waits for your review. **Important** (default) hides
  bookkeeping events; **All** shows everything; **Raw JSON** shows the original events. The
  side panel shows the last 20 important lines. On connect it replays the last 200 events of
  the task's own history file `.agents/data/loop/events/<task-id>.jsonl` (1 MiB, one `.1`
  generation), then follows live; older tasks without that file fall back to the global
  `.agents/data/loop/ui-events.jsonl` (rotated to `.jsonl.1` at 5 MB). The daemon only writes
  events when `AIDLC_LOOP_EVENT_LOG` points at the global file, which every local daemon sets
  automatically unless the shell overrides it.
- **Changes** (work-items panel, side panel, and the Review implementation gate panel) opens
  `/tasks/<id>/changes`: the files each work item changed and their diff, taken from the
  commits the local workers recorded; a task without loop records shows the uncommitted
  working tree instead.

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

→ Wrong/unavailable model. Check `opencode models`, set `AIDLC_OPENCODE_MODEL` again, restart
the daemon, then re-activate the task (§5.5).

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

Run `./.agents/aidlc/scripts/loop.sh check`: it names the missing value and where to set it
(`.agents/loop.env` or `"model"` in `opencode.json`). `loop start`/`loop up` now stop on this
before the daemon starts.

`AIDLC_OPENCODE_MODEL` is unset or in the wrong `provider/model[#variant]` format. See §5.1.
A daemon keeps the environment it started with: restart it after changing the value
(`loop.sh down`, then `loop.sh up`).

### 9.6 Web dashboard live log is empty / stuck on "connecting…"

- The live log reads `.agents/data/loop/events/<task-id>.jsonl`, falling back to the
  **fixed** global file `.agents/data/loop/ui-events.jsonl`; the daemon only writes either
  when `AIDLC_LOOP_EVENT_LOG` points at that exact path. Every local daemon sets it
  automatically; if the shell exports a different path, unset it and restart the daemon.
- The full live log is on the task **detail** page (`/tasks/<id>`); the side panel shows only
  the last 20 important lines.
- A stopped daemon produces no events. The dashboard header shows whether it is running;
  check `.agents/data/loop/daemon.log` for start-up errors.
- The detail-page log is filtered to that task; daemon-wide events (`daemon_poll`, written
  only when the actionable set or error state changes) appear only in the global file. If
  **Important** shows little, switch to **All** or **Raw JSON**.
- Check `tail -f .agents/data/loop/events/<task-id>.jsonl` (or the global
  `ui-events.jsonl`) directly: if it grows while the page does not, only the browser side is
  stale (hard refresh). A quiet global file is normal when nothing changes, because idle
  polls are no longer logged.

### 9.7 Task pauses immediately after I approve a gate; daemon polls `actionable: []`

Approval moved the task to `active`, the daemon picked it up and tried a lead turn, but the
turn failed — so the loop re-paused the task (`status: paused`, `nextAction: blocked`), and a
paused task is not actionable. Diagnose from the evidence:

```sh
node .agents/aidlc/scripts/state.mjs task show <task-id>
```

Look for a `diagnostic` with `Paused while active: …`. For `agent transport failure: …` the
cause is almost always the missing/invalid `AIDLC_OPENCODE_MODEL` (or an unavailable model).
For `turn limit reached` the run used its whole per-run `maxTurns` budget without reaching a
gate; raise `loop.limits.maxTurns` if the phase legitimately needs more turns. Then:

1. Fix the environment (`opencode models`, export `AIDLC_OPENCODE_MODEL`).
2. Kill and restart the daemon with the corrected environment (§5.1).
3. Set the task back to actionable:

   ```sh
   node .agents/aidlc/scripts/state.mjs task status <task-id> --status active
   ```

### 9.8 Clicking "approve", "send feedback", or "resume" on the web UI does nothing

- The gate **feedback** and **approve** forms exist only on the full detail page
  `/tasks/<id>`; the dashboard's **review** button on a `blocked_on_user` card just opens
  that page.
- **✓ Approve** does not send anything by itself: it opens a confirmation popup, and only
  **Confirm approve** there sends the request. If you meant to give the loop guidance, use
  **Send feedback (stay at gate)** instead — the approval note is provenance only.
- **Send feedback** is blocked in the browser while the textarea is empty (the API returns `400`) and `409` when the task is not
  waiting at a gate (status other than `blocked_on_user`). After a successful send the task
  shows `active` with a **feedback pending** pill; it only runs again if a daemon is polling
  (§5.2) — the feedback itself is already recorded as evidence.
- Mutating actions need the session token; without it they return `401` (shown inline under
  the button). Open the login URL printed by `aidlc-kit ui` (the token changes on every
  restart unless you use `--token-file`), or paste the token into **Settings**.
- A `403` means the request was refused before the token check: the page was opened under a
  different host name than the one the server is bound to (use the printed URL; any loopback
  name works when bound to loopback), or the request came from another origin.
- **resume** only applies to a `paused` task; on any other status it returns `409` with the
  reason (a gate wait must be approved instead). A resumed task runs only if it is
  loop-owned and a daemon is running (§5.2).
- If approve does *literally nothing* (no toast, no error, no update) and you are on
  an old build: open the browser DevTools console and look for
  `SyntaxError: Identifier 'post' has already been declared`. That was a UI bug (the detail
  page declared `const post` twice, silently disabling the approve handler) fixed in source —
  rebuild/repack from a checkout that includes the fix, restart `ui`, and hard-refresh
  (Ctrl+Shift+R) to drop the cached page.

### 9.9 Build items wait (`build_deferred`) or the task pauses with `build dispatch failure`

`build_deferred` is normal: ready items whose owned paths overlap, or that exceed the number
of workers, run in a later batch. A pause with `build dispatch failure: Unresolved assignment …`
means an earlier assignment still holds the paths every ready item needs; the loop never
releases it on its own. See [Troubleshooting](./troubleshooting.md#build-items-deferred-or-build-dispatch-failure-unresolved-assignment).

---

## 10. References

- [Loop setup runbook](./loop-runbook.md) — the official runbook.
- [Configuration](./configuration.md#optional-loop-configuration) — `loop.*` fields.
- [Command reference](./command-reference.md#loop) — full flags & env.
- [Coordination service](./coordination-service.md) — fleet (multi-machine).
