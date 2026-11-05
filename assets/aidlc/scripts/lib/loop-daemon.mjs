import { setTimeout as sleep } from "node:timers/promises";
import { requireLocalAuthority } from "./authority.mjs";
import { isLoopProvider, LOOP_PROVIDER_LIST } from "./loop-drivers.mjs";
import { validateRoot, readLoopRecord } from "./loop-runtime.mjs";
import { createIsolatedLocalSupervisor } from "./loop-supervisor-run-local.mjs";
import { loadState, nextAction } from "./store.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const DAEMON_POLL_MIN = 1000;
export const DAEMON_POLL_MAX = 300000;
export const DEFAULT_DAEMON_POLL_MS = 5000;

export function validateDaemonPollMs(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < DAEMON_POLL_MIN || n > DAEMON_POLL_MAX) throw new Error(`daemon pollMs must be an integer from ${DAEMON_POLL_MIN} to ${DAEMON_POLL_MAX}`);
  return n;
}

/** Enumerate actionable tasks from canonical state in a deterministic order:
 * every task whose derived nextAction classification is `run_phase`, sorted by
 * updatedAt then id so the daemon's round-robin is stable and starvation-free. */
export function actionableTasks(state, root) {
  return Object.values(state.tasks)
    .filter((task) => nextAction(task, root).classification === "run_phase")
    .sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")) || a.id.localeCompare(b.id));
}

/** Run one bounded lead turn for an existing task (no requirement intake).
 * A task with a loop run record is resumed; a task created by an agentic agent
 * or the web dashboard has no record, so its first turn runs in `run` mode. */
async function runTaskTurn({ root, taskId, agent, workers, workerImages, limits, pollMs, onEvent }) {
  const supervisor = createIsolatedLocalSupervisor({ root, taskId, agent, workers, workerImages, limits, pollMs, untilStop: true, onEvent });
  const record = readLoopRecord(root, taskId);
  return record ? supervisor.resume() : supervisor.start();
}

/**
 * Local multi-task daemon: a foreground long-running loop that polls canonical
 * state and, for every actionable task (nextAction === run_phase), runs one
 * bounded lead turn via the isolated local supervisor. A task that reaches a
 * gate, blocks, completes, or terminates simply stops being actionable and is
 * skipped on the next poll; it never terminates the daemon. Gate approval stays
 * human-only. Returns only when the signal is aborted (SIGINT/SIGTERM).
 */
export async function runLocalDaemon({ root: rootInput, agent, workers = {}, workerImages = {}, limits, pollMs = DEFAULT_DAEMON_POLL_MS, signal, onEvent = () => {} } = {}) {
  requireLocalAuthority();
  const root = validateRoot(rootInput);
  if (!isLoopProvider(agent)) throw new Error(`local lead agent must be ${LOOP_PROVIDER_LIST}`);
  if (!workers || typeof workers !== "object" || Array.isArray(workers) || !Object.keys(workers).length) throw new Error("Loop requires a configured lead and worker providers");
  for (const [id, provider] of Object.entries(workers)) if (!ID.test(id) || !isLoopProvider(provider)) throw new Error(`invalid local worker: ${id}`);
  const poll = validateDaemonPollMs(pollMs);

  for (;;) {
    if (signal?.aborted) return { status: "stopped" };
    const state = loadState(root);
    const actionable = actionableTasks(state, root);
    onEvent({ type: "daemon_poll", actionable: actionable.map((task) => task.id) });
    for (const task of actionable) {
      if (signal?.aborted) return { status: "stopped" };
      try {
        const result = await runTaskTurn({ root, taskId: task.id, agent, workers, workerImages, limits, pollMs: poll, onEvent });
        if (result?.status === "gate") onEvent({ type: "gate", taskId: task.id, gate: result.gate, gateView: result.gateView });
        onEvent({ type: "daemon_turn", taskId: task.id, status: result?.status ?? "unknown", ...(result?.gate ? { gate: result.gate } : {}) });
      } catch (error) {
        // A failing task must not take the daemon down; surface it and move on.
        onEvent({ type: "daemon_turn_error", taskId: task.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    try { await sleep(poll, undefined, { signal }); }
    catch (error) { if (error?.name === "AbortError") return { status: "stopped" }; throw error; }
  }
}
