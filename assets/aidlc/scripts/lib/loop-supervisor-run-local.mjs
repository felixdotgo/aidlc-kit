import { createHash } from "node:crypto";
import { requireLocalAuthority } from "./authority.mjs";
import { runAgentTurn } from "./loop-drivers.mjs";
import { readLoopRecord, runLoop, validateRoot } from "./loop-runtime.mjs";
import { runSupervisor } from "./loop-supervisor.mjs";
import { createLocalSupervisorAdapter } from "./loop-supervisor-local.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Bind the canonical local store, distinct supervisor lease and the existing
 * leased runner. The caller owns process supervision and human gate approval.
 * Abort stops polling or the next turn; the current runLoop call is bounded by
 * its existing timeouts and is not cancelled by this wrapper.
 */
export function createLocalLoopSupervisor({ root: rootInput, taskId, agent, limits, driver = runAgentTurn, preflight = true, pollMs, signal, onEvent = () => {}, runner = runLoop } = {}) {
  requireLocalAuthority();
  const root = validateRoot(rootInput);
  if (!["codex", "claude"].includes(agent)) throw new Error("local lead agent must be codex or claude");
  if (typeof driver !== "function" || typeof runner !== "function" || typeof onEvent !== "function") throw new Error("invalid local supervisor callbacks");
  const adapter = createLocalSupervisorAdapter({ root, taskId });
  const getRecord = () => readLoopRecord(root, taskId);
  const execute = async (mode) => {
    requireLocalAuthority();
    const record = getRecord();
    if (mode === "run" && record) throw new Error("Local loop record already exists; use resume");
    if (mode === "resume" && !record) throw new Error("Local loop record missing; use start");
    if (record && record.agent !== agent) throw new Error("Resume must use the recorded lead agent");
    let nextMode = mode;
    return runSupervisor({ taskId, authority: "local", ...adapter, pollMs, signal, onEvent,
      runTurn: async ({ precondition }) => {
        if (signal?.aborted) return { status: "stopped", taskId };
        requireLocalAuthority();
        let expected = precondition;
        if (!expected) {
          const snapshot = await adapter.readTask({ taskId });
          if (snapshot.task.status !== "active" || snapshot.nextAction.classification !== "run_phase") return { status: "blocked", taskId, reason: "Canonical state changed before runner acquired lease" };
          expected = { taskId, phase: snapshot.task.phase, taskHash: digest(snapshot.task), evidenceHash: digest(snapshot.task.evidence), evidenceCount: snapshot.task.evidence.length };
        }
        const result = await runner({ root, taskId, agent, mode: nextMode, limits, driver, preflight, precondition: expected, onEvent });
        nextMode = "resume";
        return result;
      }
    });
  };
  return {
    start: () => execute("run"),
    resume: () => execute("resume"),
    async status() {
      requireLocalAuthority();
      const snapshot = await adapter.readTask({ taskId });
      return { taskId, authority: "local", record: getRecord(), nextAction: snapshot.nextAction };
    }
  };
}
