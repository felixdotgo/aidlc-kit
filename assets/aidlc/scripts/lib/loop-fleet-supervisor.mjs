import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { explainFleetConflict } from "./loop-holder.mjs";
import { runFleetCoordinator, validateFleetLimits } from "./loop-fleet.mjs";

const taskDigest = (task) => createHash("sha256").update(JSON.stringify(task)).digest("hex");
const targets = { G0_confirm: "plan", G1_review: "build", G2_codereview: "wrap" };

/** The service owns the checkpoint and atomically binds each run claim to this
 * supervisor. An unavailable or ambiguous checkpoint never authorizes work.
 *
 * `signal` stops at the next turn boundary; `cancelSignal` also aborts the
 * in-flight lead turn. Both end as `{ status: "stopped" }`.
 *
 * `untilStop: true` (daemon mode) never polls a human gate: a newly published
 * gate returns `{ status: "gate", taskId, gate, snapshotId, gateView }` and an
 * already pending checkpoint returns `{ status: "waiting", taskId, gate,
 * snapshotId }`. The supervisor lease is released either way; the service
 * accepts the reviewer approval against the pending checkpoint, and a later
 * supervisor resumes from the `approved` checkpoint. */
export async function runFleetSupervisor({ repository, taskId, limits: inputLimits, pollMs = 5000, signal, cancelSignal, untilStop = false, onEvent = () => {}, coordinator = runFleetCoordinator, ...options }) {
  const limits = validateFleetLimits(inputLimits);
  if (!repository || typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 300000) throw new Error("Invalid fleet supervisor configuration");
  for (const name of ["claimSupervisor", "renewSupervisor", "releaseSupervisor", "readGateCheckpoint", "readTask", "claimLead"]) if (typeof repository[name] !== "function") throw new Error(`Fleet supervisor requires ${name}`);
  await repository.claimSupervisor({ taskId, leaseMs: limits.leaseMs, idempotencyKey: randomUUID() });
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, cancelSignal, controller.signal].filter(Boolean));
  let failure; let pending = Promise.resolve();
  const timer = setInterval(() => { pending = pending.then(() => repository.renewSupervisor({ taskId, leaseMs: limits.leaseMs })).catch((error) => { failure = error; controller.abort(error); }); }, limits.heartbeatMs);
  timer.unref?.();
  try {
    while (!combined.aborted) {
      const snapshot = await repository.readTask({ taskId });
      const checkpoint = await repository.readGateCheckpoint({ taskId });
      if (!snapshot?.task || snapshot.task.id !== taskId || !Number.isSafeInteger(snapshot.revision)) throw new Error("Invalid fleet canonical snapshot");
      const task = snapshot.task;
      if (task.status === "paused" || task.handoff || ["blocked", "terminal"].includes(snapshot.nextAction?.classification)) return { status: "blocked", taskId, reason: "Task is paused, blocked, or terminal" };
      if (snapshot.nextAction?.classification === "complete") return { status: "complete", taskId };
      if (checkpoint?.status === "pending") {
        if (task.status !== "blocked_on_user" || task.gate !== checkpoint.gate || taskDigest(task) !== checkpoint.taskDigest || snapshot.nextAction?.classification !== "await_user") return { status: "blocked", taskId, reason: "Pending checkpoint does not match canonical gate" };
        await onEvent({ type: "waiting", taskId, gate: checkpoint.gate, snapshotId: checkpoint.snapshotId });
        if (untilStop) return { status: "waiting", taskId, gate: checkpoint.gate, snapshotId: checkpoint.snapshotId };
        try { await sleep(pollMs, undefined, { signal: combined }); } catch (error) { if (error?.name !== "AbortError") throw error; }
        continue;
      }
      if (checkpoint?.status === "consumed") return { status: "blocked", taskId, reason: "Consumed checkpoint requires reconciliation before restart" };
      if (checkpoint?.status === "rejected") {
        if (task.status !== "active" || task.phase !== checkpoint.phase || task.gate !== checkpoint.gate || snapshot.nextAction?.classification !== "run_phase") return { status: "blocked", taskId, reason: "Rejected checkpoint does not match canonical state" };
      } else if (checkpoint && checkpoint.status !== "approved") {
        return { status: "blocked", taskId, reason: "Approved checkpoint does not match canonical state" };
      }
      if (checkpoint?.status === "approved") {
        // A task snapshot older than the atomic approval is a read race between
        // the two reads, not a mismatch: re-read the canonical task immediately.
        if (Number.isSafeInteger(checkpoint.approvalRevision) && checkpoint.approvalRevision > snapshot.revision) { await onEvent({ type: "resync", taskId, gate: checkpoint.gate }); continue; }
        if (task.phase !== targets[checkpoint.gate] || task.status !== "active" || !Number.isSafeInteger(checkpoint.approvalRevision)) return { status: "blocked", taskId, reason: "Approved checkpoint does not match canonical state" };
      }
      if (snapshot.nextAction?.classification !== "run_phase" || task.status !== "active") return { status: "blocked", taskId, reason: "Task is not actionable or gate checkpoint is missing" };
      await repository.renewSupervisor({ taskId, leaseMs: limits.leaseMs });
      if (combined.aborted) break;
      const claim = await repository.claimLead({ taskId, leaseMs: limits.leaseMs, expectedStateRevision: snapshot.revision, expectedTaskDigest: taskDigest(task), checkpoint, idempotencyKey: randomUUID() });
      const result = await coordinator({ ...options, repository, taskId, limits, claimedLead: claim, supervisorSignal: controller.signal, stopSignal: signal, cancelSignal, onEvent });
      if (failure) throw failure;
      if (result?.status !== "gate") return result;
      // gate_snapshot_put stores snapshot and checkpoint in one service transaction.
      await onEvent({ type: "gate", taskId, gate: result.gate, snapshotId: result.snapshotId, gateView: result.gateView });
      if (untilStop) return { status: "gate", taskId, gate: result.gate, snapshotId: result.snapshotId, gateView: result.gateView };
    }
    if (failure) throw new Error(`Supervisor lease renewal failed: ${explainFleetConflict(failure.message)}`);
    return { status: "stopped", taskId };
  } finally {
    clearInterval(timer); await pending;
    await repository.releaseSupervisor({ taskId });
  }
}
