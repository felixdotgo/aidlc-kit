import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const TARGET = { G0_confirm: "plan", G1_review: "build", G2_codereview: "wrap" };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const required = (value, name) => { if (typeof value !== "function") throw new Error(`${name} is required`); return value; };
const validId = (value, name) => { if (typeof value !== "string" || !ID.test(value)) throw new Error(`invalid ${name}`); };

function validateSnapshot(snapshot, taskId) {
  if (!snapshot || snapshot.task?.id !== taskId || !Array.isArray(snapshot.task.evidence) || !snapshot.nextAction || !["run_phase", "await_user", "blocked", "terminal", "complete"].includes(snapshot.nextAction.classification)) throw new Error("invalid canonical task snapshot");
  return snapshot;
}

/** Checkpoints contain a digest, not the task evidence or user-provided approval text. */
export function makeGateCheckpoint({ taskId, authority, snapshot, result }) {
  validId(taskId, "task ID");
  if (!["local", "fleet"].includes(authority)) throw new Error("invalid authority");
  validateSnapshot(snapshot, taskId);
  const gate = result?.gate ?? result?.nextAction?.gate;
  if (!TARGET[gate] || snapshot.task.gate !== gate || snapshot.task.status !== "blocked_on_user" || snapshot.nextAction.classification !== "await_user" || (result.taskId && result.taskId !== taskId)) throw new Error("gate changed before supervisor checkpoint; inspect state manually");
  if (authority === "fleet" && (!result.snapshotId || !Number.isSafeInteger(snapshot.revision))) throw new Error("fleet gate requires snapshot ID and revision");
  return { version: 1, taskId, authority, gate, phase: snapshot.task.phase, taskHash: hash(snapshot.task), evidenceCount: snapshot.task.evidence.length, evidenceHash: hash(snapshot.task.evidence), ...(authority === "fleet" ? { snapshotId: result.snapshotId, revision: snapshot.revision } : {}) };
}

/** Return wait/resume/blocked only from fresh canonical state, never grant approval. */
export async function checkGateCheckpoint({ checkpoint, snapshot, verifyFleetApproval, verifyLocalApproval }) {
  if (!checkpoint || checkpoint.version !== 1 || !TARGET[checkpoint.gate] || !["local", "fleet"].includes(checkpoint.authority) || !Number.isSafeInteger(checkpoint.evidenceCount) || checkpoint.evidenceCount < 0 || typeof checkpoint.evidenceHash !== "string" || typeof checkpoint.taskHash !== "string") throw new Error("invalid gate checkpoint");
  validId(checkpoint.taskId, "checkpoint task ID");
  validateSnapshot(snapshot, checkpoint.taskId);
  const { task, nextAction } = snapshot;
  if (task.evidence.length < checkpoint.evidenceCount || hash(task.evidence.slice(0, checkpoint.evidenceCount)) !== checkpoint.evidenceHash) return { status: "blocked", reason: "gate evidence changed since checkpoint" };
  if (task.status === "paused" || task.handoff || ["blocked", "terminal", "complete"].includes(nextAction.classification)) return { status: "blocked", reason: "task is paused, blocked, or terminal" };
  if (task.phase === checkpoint.phase && task.gate === checkpoint.gate && task.status === "blocked_on_user" && nextAction.classification === "await_user") {
    if (checkpoint.authority === "fleet" && hash(task) !== checkpoint.taskHash) return { status: "blocked", reason: "fleet review snapshot is stale" };
    return { status: "wait" };
  }
  const appended = task.evidence.slice(checkpoint.evidenceCount);
  const approvals = appended.filter((entry) => entry.kind === "approval" && entry.gate === checkpoint.gate && entry.result === "pass" && typeof entry.source === "string" && entry.source.trim());
  if (task.phase !== TARGET[checkpoint.gate] || task.status !== "active" || nextAction.classification !== "run_phase" || approvals.length !== 1) return { status: "blocked", reason: "gate changed without its matching approval" };
  if (checkpoint.authority === "local" && verifyLocalApproval && !await verifyLocalApproval({ checkpoint, snapshot })) return { status: "blocked", reason: "local approval lacks the matching host receipt" };
  if (checkpoint.authority === "fleet") {
    if (!checkpoint.snapshotId || !Number.isSafeInteger(checkpoint.revision) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision <= checkpoint.revision) return { status: "blocked", reason: "fleet gate revision is stale" };
    if (!await required(verifyFleetApproval, "verifyFleetApproval")({ checkpoint, snapshot })) return { status: "blocked", reason: "fleet approval does not match review snapshot" };
  }
  return { status: "resume", precondition: { taskId: checkpoint.taskId, gate: checkpoint.gate, phase: task.phase, taskHash: hash(task), evidenceCount: task.evidence.length, evidenceHash: hash(task.evidence), ...(checkpoint.authority === "fleet" ? { revision: snapshot.revision, snapshotId: checkpoint.snapshotId } : {}) } };
}

/**
 * Supervises short runner invocations. runTurn MUST acquire its existing exclusive
 * loop lease/lead epoch, reread canonical state, and enforce the supplied precondition
 * before doing any work; if no precondition is supplied it MUST still verify
 * run_phase under the lease. It MUST release the lease before returning a gate. Fleet
 * runTurn additionally reconciles uncertain jobs and Git before dispatch. The
 * checkpoint adapter MUST persist atomically, be scoped to task+authority, and be
 * concurrency safe. acquireSupervisor MUST provide an independently fenced,
 * renewable exclusive supervisor lease that does not block human gate approval.
 * No callback is allowed to approve a human gate.
 */
export async function runSupervisor({ taskId, authority, acquireSupervisor, readTask, runTurn, loadCheckpoint, saveCheckpoint, clearCheckpoint, verifyFleetApproval, verifyLocalApproval, pollMs = 5000, signal, onEvent = () => {} }) {
  validId(taskId, "task ID");
  if (!["local", "fleet"].includes(authority)) throw new Error("invalid authority");
  for (const [name, value] of Object.entries({ acquireSupervisor, readTask, runTurn, loadCheckpoint, saveCheckpoint, clearCheckpoint, onEvent })) required(value, name);
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 300000) throw new Error("invalid poll interval");
  const ownership = await acquireSupervisor({ taskId, authority, signal });
  if (!ownership || typeof ownership.assertOwned !== "function" || typeof ownership.release !== "function") throw new Error("supervisor ownership must provide assertOwned and release");
  try {
  let checkpoint = await loadCheckpoint({ taskId, authority });
  if (checkpoint && (checkpoint.taskId !== taskId || checkpoint.authority !== authority)) throw new Error("checkpoint authority or task mismatch");
  while (!signal?.aborted) {
    const snapshot = validateSnapshot(await readTask({ taskId }), taskId);
    let precondition;
    if (checkpoint) {
      const verdict = await checkGateCheckpoint({ checkpoint, snapshot, verifyFleetApproval, verifyLocalApproval });
      if (verdict.status === "blocked") return { status: "blocked", taskId, reason: verdict.reason };
      if (verdict.status === "wait") {
        try { await sleep(pollMs, undefined, { signal }); } catch (error) { if (error?.name !== "AbortError") throw error; }
        continue;
      }
      precondition = verdict.precondition;
    } else if (snapshot.nextAction.classification !== "run_phase") {
      return { status: snapshot.nextAction.classification === "await_user" ? "blocked" : snapshot.nextAction.classification, taskId, reason: snapshot.nextAction.classification === "await_user" ? "gate checkpoint missing; inspect the gate before resuming" : snapshot.nextAction.reason };
    }
    // Leave the durable gate checkpoint intact until the next stop is saved. A
    // crash during a turn then cannot cause an unverified automatic restart.
    await ownership.assertOwned();
    const result = await runTurn({ taskId, authority, precondition, signal });
    if (result?.status !== "gate") {
      if (checkpoint && ["complete", "terminal"].includes(result?.status)) await clearCheckpoint({ taskId, authority, checkpoint });
      return result;
    }
    const fresh = validateSnapshot(await readTask({ taskId }), taskId);
    const next = makeGateCheckpoint({ taskId, authority, snapshot: fresh, result });
    await ownership.assertOwned();
    await saveCheckpoint({ taskId, authority, checkpoint: next, previous: checkpoint });
    checkpoint = next;
    await onEvent({ type: "gate", taskId, gate: next.gate, ...(next.snapshotId ? { snapshotId: next.snapshotId } : {}), gateView: result.gateView });
  }
  return { status: "stopped", taskId };
  } finally { await ownership.release(); }
}
