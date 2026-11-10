import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createWorkerSnapshot, inspectWorkerSnapshot } from "./loop-worker-snapshot.mjs";
import { workerDockerInvocation } from "./loop-worker-docker.mjs";
import { isLoopProvider, runAgentTurn, summarize } from "./loop-drivers.mjs";
import { extractCommitMessage } from "./loop-commit-message.mjs";
import { pathOverlaps } from "./store.mjs";
import { claimLocalAssignment, heartbeatLocalAssignment, recordLocalIntegration, reportLocalAssignment, releaseLocalAssignment } from "./assignment-store.mjs";
import { openWorkerLog } from "./loop-worker-log.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
const lines = (value) => value.split("\0").filter(Boolean);
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const safePath = (path) => typeof path === "string" && path.length > 0 && !isAbsolute(path) && !path.includes("\\") && !path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".agents") && !/[\x00-\x1f]/.test(path);
const scoped = (paths, scopes) => paths.every((path) => safePath(path) && scopes.some((scope) => path === scope || path.startsWith(`${scope}/`)));
const statusPaths = (root) => {
  // --no-renames yields one entry per path, including both sides of a rename.
  return lines(git(root, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all")).map((row) => row.slice(3));
};
const commitPaths = (root, base, head) => lines(git(root, "diff", "--name-only", "-z", "--no-renames", base, head, "--"));
// Workflow state and assignment records are lead-owned and never in worker
// scopes. Their ordinary updates must not block integrating code-only commits.
// The dirty paths are named so an `integration_blocked` event tells the operator
// exactly what to clean before the next dispatch retries.
const clean = (root) => {
  const dirty = statusPaths(root).filter((path) => !path.startsWith(".agents/data/"));
  if (dirty.length) throw new Error(`Local integration worktree must be clean outside workflow data: ${dirty.join(", ")}`);
};
// A worker container that may still be running (and writing) must keep its claim.
const cleanupUncertain = (message) => Object.assign(new Error(message), { cleanupUncertain: true });
// Failure text plus the underlying command output when present (execFileSync
// attaches git's stderr, e.g. the `could not apply <commit>` conflict detail),
// flattened to one line so event and batch-error messages stay deterministic.
// execFileSync already embeds short stderr into the Error message, so append
// the captured stderr only when the message does not already contain it.
const reasonOf = (error) => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  const output = error instanceof Error && typeof error.stderr === "string" ? error.stderr.trim().replace(/\s+/g, " ") : "";
  return output && !message.includes(output) ? `${message}: ${output}` : message;
};

/**
 * Release the claims of failed jobs this batch itself stopped, so a timed-out,
 * stalled, or daemon-cancelled worker does not hold its item and owned paths
 * until a human runs `assignment.mjs release`. A claim is released only when the
 * job rejected before reporting and its container was removed for certain; a
 * reported (successful but unintegrated) job, an uncertain container cleanup,
 * or a failed release keeps the claim for reconciliation. Never throws: a
 * release error must not mask the batch failure.
 * `outcomes`: `[{ assignmentId, itemId, reported, settled }]`, `settled` being
 * the job's `Promise.allSettled` entry. Returns `{ released, held }`.
 */
export async function releaseFailedAssignments({ root, taskId, outcomes, release }) {
  const released = [], held = [];
  for (const { assignmentId, itemId, reported, settled } of outcomes) {
    if (settled.status === "fulfilled" || reported) { held.push({ itemId, reason: "reported, not integrated" }); continue; }
    if (settled.reason?.cleanupUncertain) { held.push({ itemId, reason: "container cleanup uncertain" }); continue; }
    try { await release(root, taskId, assignmentId); released.push(itemId); }
    catch (error) { held.push({ itemId, reason: `release failed: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  return { released, held };
}

/**
 * Execute a batch of independent local jobs in isolated worktrees, then integrate
 * verified scoped commits sequentially. Assignment metadata is not lifecycle
 * state: the caller alone marks canonical items done after inspecting results.
 * A rejected job never strands a sibling's good commit: every fulfilled result
 * is integrated in order even when another job failed, and an integration the
 * checkout blocks (dirty paths or a cherry-pick conflict) is reported through
 * an `integration_blocked` event while its reported claim stays held. The batch
 * throws only when nothing at all integrated, naming released and held claims;
 * on partial integration it returns the integrated results (with a
 * `build_partial` summary event) so the caller marks only those items done.
 * Claims of failed jobs the batch stopped for certain are released (see
 * releaseFailedAssignments); the rest are left for reconciliation.
 */
export async function runLocalWorkerBatch({ root: inputRoot, taskId, jobs, worktreesRoot: inputWorktreesRoot, docker, timeoutMs = 600000, leaseMs = 300000, maxTurns = 12, maxStallTurns = 2, claim = claimLocalAssignment, heartbeat = heartbeatLocalAssignment, report = reportLocalAssignment, release = releaseLocalAssignment, recordIntegration = recordLocalIntegration, onEvent = () => {}, signal } = {}) {
  const root = resolve(inputRoot), worktreesRoot = resolve(inputWorktreesRoot);
  if (!identifier(taskId) || !Array.isArray(jobs) || !jobs.length) throw new Error("Valid task and non-empty jobs are required");
  if (root === worktreesRoot || worktreesRoot.startsWith(`${root}${sep}`)) throw new Error("Worker worktree root must be outside the integration checkout");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw new Error("Invalid timeout or lease");
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000 || !Number.isSafeInteger(maxStallTurns) || maxStallTurns < 1 || maxStallTurns > 20) throw new Error("Invalid worker turn or stall limit");
  const ids = new Set(), workers = new Set(), scopes = [];
  for (const job of jobs) {
    if (Array.isArray(job.ownedPaths)) job.ownedPaths = [...new Set(job.ownedPaths.map((path) => (typeof path === "string" ? path.replace(/\/+$/, "") : path)).filter((path) => path))];
    if (!identifier(job.itemId) || !identifier(job.workerId) || !isLoopProvider(job.agent) || typeof job.prompt !== "string" || !job.prompt.trim() || !Array.isArray(job.ownedPaths) || !job.ownedPaths.length || job.ownedPaths.length > 64 || !job.ownedPaths.every(safePath)) throw new Error("Invalid local job");
    // Last-resort guards: the dispatcher partitions batches (selectBuildBatch),
    // so plan data should never reach these.
    if (ids.has(job.itemId) || workers.has(job.workerId)) throw new Error("Items and workers must be distinct within a batch");
    ids.add(job.itemId); workers.add(job.workerId);
    for (const path of job.ownedPaths) { if (scopes.some((prior) => pathOverlaps(path, prior))) throw new Error(`Overlapping assignment scope: ${path}`); scopes.push(path); }
  }
  const hasImages = docker && typeof docker.images === "object" && !Array.isArray(docker.images);
  if (process.platform !== "linux" || !docker || (typeof docker.image !== "string" && !hasImages) || !docker.credentials || typeof docker.credentials !== "object") throw new Error("Linux Docker worker isolation and explicit image and provider credentials are required");
  const resolveImage = (agent) => {
    const specific = hasImages && typeof docker.images[agent] === "string" && docker.images[agent] ? docker.images[agent] : undefined;
    return specific ?? docker.image;
  };
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (!uid || !gid) throw new Error("Docker workers require a non-root host user");
  const resolvedImages = {};
  for (const agent of new Set(jobs.map((job) => job.agent))) {
    const agentImage = resolveImage(agent);
    if (typeof agentImage !== "string" || !agentImage) throw new Error(`Worker Docker image is required for provider ${agent}`);
    resolvedImages[agent] = agentImage;
  }
  for (const job of jobs) {
    const keys = docker.credentials[job.agent];
    workerDockerInvocation({ workspace: root, image: resolvedImages[job.agent], command: job.agent, args: [], credentialEnv: keys, hostEnv: process.env, uid, gid });
  }
  const dockerEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const dockerCheck = (...args) => execFileSync("docker", args, { env: dockerEnv, stdio: "ignore", timeout: 30000 });
  // Run each provider CLI through workerDockerInvocation (not a bare `docker run`)
  // so OpenCode's HOME/XDG roots are redirected to a writable tmpfs. A raw
  // invocation fails under `--read-only` with `EROFS: mkdir '/home/node/.local'`.
  const preflightWorkspace = mkdtempSync(join(tmpdir(), "aidlc-worker-preflight-"));
  try {
    dockerCheck("info");
    for (const [agent, agentImage] of Object.entries(resolvedImages)) {
      const id=execFileSync("docker",["image","inspect","--format","{{.Id}}",agentImage],{env:dockerEnv,encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:30000}).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Docker worker image lacks immutable image ID");
      const invocation = workerDockerInvocation({ workspace: preflightWorkspace, image: agentImage, command: agent, args: ["--version"], credentialEnv: docker.credentials[agent], hostEnv: process.env, uid, gid });
      execFileSync(invocation.command, invocation.args, { env: invocation.env, stdio: "ignore", timeout: 30000 });
    }
  } catch { throw new Error("Docker engine, image, or provider CLI preflight failed"); }
  finally { rmSync(preflightWorkspace, { recursive: true, force: true }); }
  clean(root);
  const base = git(root, "rev-parse", "HEAD").trim();
  const initialBranch = git(root, "symbolic-ref", "--short", "HEAD").trim();
  mkdirSync(worktreesRoot, { recursive: true });
  const realRoot = realpathSync(root), realWorktreesRoot = realpathSync(worktreesRoot);
  if (realRoot === realWorktreesRoot || realWorktreesRoot.startsWith(`${realRoot}${sep}`)) throw new Error("Worker worktree root must be outside the integration checkout");
  const prepared = [];
  try {
    for (const job of jobs) {
      const token = randomUUID(), branch = `aidlc/local/${token}`, workspace = resolve(worktreesRoot, token), snapshot = resolve(worktreesRoot, `${token}-snapshot`);
      const assignment = await claim(root, { taskId, itemId: job.itemId, workerId: job.workerId, ownedPaths: job.ownedPaths, baseCommit: base, branch, leaseMs });
      prepared.push({ job, assignment, workspace, snapshot, branch, created: false });
      git(root, "worktree", "add", "-b", branch, workspace, base);
      prepared.at(-1).created = true;
      mkdirSync(snapshot);
      const tracked = lines(git(workspace, "ls-files", "-z")).filter((path) => path !== ".agents/data" && !path.startsWith(".agents/data/"));
      prepared.at(-1).baseline = createWorkerSnapshot(workspace, snapshot, tracked);
    }
  } catch (error) {
    // No worker was started; release only claims whose worktree was never run.
    for (const entry of prepared) { if (entry.created) git(root, "worktree", "remove", entry.workspace); rmSync(entry.snapshot, { recursive: true, force: true }); await release(root, taskId, entry.assignment.id); }
    throw error;
  }
  const execute = async (entry) => {
    const { job, assignment, workspace, snapshot, baseline, branch } = entry;
    // Live-log context: worker events name the worker, its item, and the build phase.
    // Worker output is never logged in full: agent text is reduced to a redacted
    // first-line summary (tool and command events already carry summaries only).
    const workerEvent = (event) => {
      if (!event || typeof event !== "object" || Array.isArray(event)) return onEvent(event);
      const brief = event.type === "agent_text" ? { type: "agent_text", text: summarize(String(event.text ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "") ?? "" } : event;
      return onEvent({ taskId, actor: job.workerId, phase: "build", itemId: job.itemId, ...brief });
    };
    let renewalError;
    // The worker's claim ended (renewal stopped or the turn was aborted) before it finished.
    const leaseLost = () => new Error(`Worker lease lost: the claim on assignment ${assignment.id} (item ${job.itemId}, worker ${job.workerId}, paths ${job.ownedPaths.join(", ")}) ended before the worker finished; its result is not integrated. Run node .agents/aidlc/scripts/assignment.mjs reconcile ${taskId}`);
    const controller = new AbortController();
    // An external cancel (daemon shutdown stage 2) aborts every worker turn the
    // same way a lost lease does; the batch then fails and is not integrated.
    const onCancel = () => { renewalError ??= new Error("Worker batch cancelled by daemon shutdown"); controller.abort(); };
    if (signal?.aborted) onCancel(); else signal?.addEventListener("abort", onCancel, { once: true });
    const timer = setInterval(() => { Promise.resolve().then(() => heartbeat(root, taskId, assignment.id, leaseMs)).catch((error) => { renewalError = error; controller.abort(); }); }, Math.max(500, Math.floor(leaseMs / 3)));
    // Container record and raw output tee under the task's runtime directory
    // (.agents/data/tasks/<task>/runtime/workers). Best-effort: a log failure is
    // reported once as a diagnostic and never fails or delays the worker.
    const logDiagnostic = (error) => { Promise.resolve().then(() => onEvent({ type: "diagnostic", taskId, itemId: job.itemId, message: `Worker log unavailable for assignment ${assignment.id}: ${error instanceof Error ? error.message : String(error)}` })).catch(() => {}); };
    let workerLog = null;
    try { workerLog = openWorkerLog({ root, taskId, assignmentId: assignment.id, itemId: job.itemId, workerId: job.workerId, agent: job.agent, mode: "local", onError: logDiagnostic }); }
    catch (error) { logDiagnostic(error); }
    const labels = { "aidlc.task": taskId, "aidlc.item": job.itemId, "aidlc.worker": job.workerId, "aidlc.assignment": assignment.id };
    try {
      const home=mkdtempSync(join(tmpdir(), "aidlc-local-home-")); chmodSync(home,0o700);
      let sessionId, previousFingerprint, stalls=0, result;
      try {
        for (let turn=0; turn<maxTurns; turn++) {
          if (renewalError || controller.signal.aborted) throw renewalError ?? leaseLost();
          const containerName = `aidlc-worker-${randomUUID()}`;
          const spawnProcess = (command, args, options) => {
            const invocation = workerDockerInvocation({ workspace: snapshot, image: resolvedImages[job.agent], command, args, credentialEnv: docker.credentials[job.agent], hostEnv: process.env, uid, gid, containerName, sessionHome:home, labels });
            const child = spawn(invocation.command, invocation.args, { ...options, cwd: snapshot, env: invocation.env, shell: false });
            if (workerLog) { workerLog.tee(child); child.once("close", (code) => workerLog.turnEnd(code)); }
            return child;
          };
          workerLog?.turnStart(containerName, turn + 1);
          await workerEvent({ type: "worker_turn_start", iteration: turn, agent: job.agent, summary: summarize(`turn ${turn + 1} on ${job.ownedPaths.join(", ")}`) });
          try { result = await runAgentTurn({ agent: job.agent, root: "/workspace", sessionId, spawnProcess, onEvent: workerEvent, prompt: `${job.prompt}\n\nOnly modify assigned paths: ${job.ownedPaths.join(", ")}. Do not modify AI-DLC lifecycle state or approve gates. End with a Conventional Commits message on its own line as AI-DLC-COMMIT: type(scope): subject (for example AI-DLC-COMMIT: docs(ui): add web UI improvement proposal), followed by AI-DLC-ITEM-COMPLETE on its own line.`, timeoutMs, signal: controller.signal, onSessionId: async (id) => { await heartbeat(root, taskId, assignment.id, leaseMs, id); } }); }
          finally {
            try { dockerCheck("rm", "-f", containerName); }
            catch {
              try { dockerCheck("info"); } catch { throw cleanupUncertain("Docker cleanup uncertain: engine unavailable"); }
              try { dockerCheck("inspect", containerName); throw cleanupUncertain("Docker cleanup uncertain: container remains"); }
              catch (error) { if (error.cleanupUncertain) throw error; }
            }
          }
          if (renewalError || controller.signal.aborted) throw renewalError ?? leaseLost();
          sessionId=result.sessionId;
          const changed=inspectWorkerSnapshot(snapshot,baseline,job.ownedPaths);
          if (result.resultText?.split(/\r?\n/).some((line) => line.trim() === "AI-DLC-ITEM-COMPLETE")) break;
          const fingerprint=createHash("sha256").update(JSON.stringify(changed.map((path) => { try { const full=join(snapshot,path), info=lstatSync(full); return [path,info.mode,createHash("sha256").update(readFileSync(full)).digest("hex")]; } catch (error) { if(error.code === "ENOENT") return [path,null]; throw error; } }))).digest("hex");
          stalls=fingerprint===previousFingerprint ? stalls+1 : 0; previousFingerprint=fingerprint;
          if (stalls >= maxStallTurns) throw new Error(`Worker ${job.workerId} stalled`);
          if (turn===maxTurns-1) throw new Error(`Worker ${job.workerId} exceeded turn limit`);
        }
      } finally { rmSync(home,{recursive:true,force:true}); }
      if (git(workspace, "rev-parse", "HEAD").trim() !== base || statusPaths(workspace).length) throw new Error("Host worker worktree changed during isolated execution");
      const snapshotChanges = inspectWorkerSnapshot(snapshot, baseline, job.ownedPaths);
      if (!snapshotChanges.length) throw new Error(`Worker ${job.workerId} changed no files`);
      await heartbeat(root, taskId, assignment.id, leaseMs);
      if (renewalError || controller.signal.aborted) throw renewalError ?? leaseLost();
      for (const path of snapshotChanges) {
        const destination = join(workspace, path), from = join(snapshot, path);
        let parent = workspace;
        for (const segment of path.split("/").slice(0, -1)) { parent = join(parent, segment); try { const info = lstatSync(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe integration directory"); } catch (error) { if (error.code !== "ENOENT") throw error; mkdirSync(parent); } }
        try { const info = lstatSync(destination); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe integration target"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        try { const info = lstatSync(from); copyFileSync(from, destination); chmodSync(destination, info.mode & 0o777); } catch (error) { if (error.code !== "ENOENT") throw error; rmSync(destination, { force: true }); }
      }
      if (git(workspace, "symbolic-ref", "--short", "HEAD").trim() !== branch) throw new Error("Worker changed its assigned branch");
      git(workspace, "merge-base", "--is-ancestor", base, "HEAD");
      const changed = [...new Set([...statusPaths(workspace), ...commitPaths(workspace, base, "HEAD")])];
      if (!changed.length || !scoped(changed, job.ownedPaths)) throw new Error(`Worker ${job.workerId} changed no files or files outside its scope`);
      // Fold any commits made by the agent into one scoped assignment commit.
      git(workspace, "reset", "--soft", base);
      git(workspace, "add", "-A", "--", ...changed);
      if (git(workspace, "diff", "--cached", "--name-only").trim()) {
        const message = extractCommitMessage(result?.resultText, { itemId: job.itemId, ownedPaths: job.ownedPaths });
        git(workspace, "-c", "user.name=AI-DLC worker", "-c", "user.email=aidlc-worker@localhost", "commit", "-m", message);
      }
      const commit = git(workspace, "rev-parse", "HEAD").trim(), committed = commitPaths(workspace, base, commit);
      if (commit === base || !committed.length || !scoped(committed, job.ownedPaths)) throw new Error("Worker commit is outside assignment scope");
      await report(root, taskId, assignment.id, { commit, changedPaths: committed, checkpoint: `provider=${job.agent}` });
      entry.reported = true;
      await workerEvent({ type: "worker_reported", commit, changedPaths: committed, summary: summarize(`changed ${committed.length} file(s): ${committed.join(", ")}`) });
      return { assignmentId: assignment.id, itemId: job.itemId, workerId: job.workerId, agent: job.agent, baseCommit: base, branch, commit, changedPaths: committed, workspace };
    } finally { clearInterval(timer); signal?.removeEventListener("abort", onCancel); workerLog?.close(); }
  };
  const results = await Promise.allSettled(prepared.map(execute));
  // Integrate every fulfilled, verified, scoped worker commit in order even when
  // another job in the batch rejected: a failed sibling must not strand a good
  // commit on its `aidlc/local/<uuid>` branch forever. A blocked integration
  // keeps its reported claim (the worker's work is real and recorded) and is
  // retried once the human resolves the blocker.
  const integrated = [], blocked = [];
  let expectedHead = base;
  for (const result of results) {
    if (result.status === "rejected") continue;
    const outcome = result.value;
    let picking = false;
    try {
      clean(root);
      if (git(root, "symbolic-ref", "--short", "HEAD").trim() !== initialBranch) throw new Error("Integration branch changed during worker run");
      if (git(root, "rev-parse", "HEAD").trim() !== expectedHead) throw new Error("Integration HEAD changed during worker run");
      if (!scoped(commitPaths(root, base, outcome.commit), jobs.find((job) => job.itemId === outcome.itemId).ownedPaths)) throw new Error("Worker scope changed before integration");
      picking = true;
      git(root, "-c", "user.name=AI-DLC integrator", "-c", "user.email=aidlc-integrator@localhost", "cherry-pick", outcome.commit);
      picking = false;
      outcome.integrationCommit = git(root, "rev-parse", "HEAD").trim();
      expectedHead = outcome.integrationCommit;
    } catch (error) {
      // A started cherry-pick that failed may have left the checkout conflicted;
      // reset it (best-effort: guard failures start no pick and `--abort` without
      // a pick in progress errors harmlessly) so the next result can integrate.
      if (picking) { try { git(root, "cherry-pick", "--abort"); } catch { /* no pick in progress to abort */ } }
      const message = reasonOf(error);
      blocked.push({ itemId: outcome.itemId, message });
      await onEvent({ type: "integration_blocked", taskId, itemId: outcome.itemId, assignmentId: outcome.assignmentId, message });
      continue;
    }
    integrated.push(outcome);
    // Best-effort: the cherry-pick already happened, so a failed record must not
    // fail the batch; the dashboard then falls back to the worker commit.
    try { await recordIntegration(root, taskId, outcome.assignmentId, outcome.integrationCommit); }
    catch (error) { await onEvent({ type: "diagnostic", taskId, itemId: outcome.itemId, message: `Could not record integration commit: ${error instanceof Error ? error.message : String(error)}` }); }
    await onEvent({ type: "job_integrated", taskId, actor: outcome.workerId, phase: "build", itemId: outcome.itemId, assignmentId: outcome.assignmentId, commit: outcome.integrationCommit, summary: summarize(`integrated ${outcome.changedPaths.length} file(s) as ${outcome.integrationCommit.slice(0, 12)}`) });
  }
  const rejected = results.filter((result) => result.status === "rejected");
  if (rejected.length || blocked.length) {
    const { released, held } = await releaseFailedAssignments({ root, taskId, release, outcomes: prepared.map((entry, index) => ({ assignmentId: entry.assignment.id, itemId: entry.job.itemId, reported: entry.reported === true, settled: results[index] })) });
    const causes = [
      ...rejected.map((result) => reasonOf(result.reason)),
      ...blocked.map(({ itemId, message }) => `integration blocked for ${itemId}: ${message}`),
    ];
    if (!integrated.length) {
      if (!held.length) throw new Error(`Local worker batch failed: ${causes.join("; ")}; released assignment(s) for retry: ${released.join(", ")}`);
      throw new Error(`Local worker batch requires reconciliation: ${causes.join("; ")}; released: ${released.join(", ") || "none"}; still held: ${held.map(({ itemId, reason }) => `${itemId} (${reason})`).join(", ")}`);
    }
    const failed = [
      ...results.map((result, index) => result.status === "rejected" ? `${prepared[index].job.itemId} (${reasonOf(result.reason)})` : null).filter(Boolean),
      ...blocked.map(({ itemId, message }) => `${itemId} (${message})`),
    ];
    await onEvent({ type: "build_partial", taskId, message: `Local worker batch partially integrated: ${integrated.length} of ${results.length} job(s) integrated; not integrated: ${failed.join("; ")}` });
  }
  return integrated;
}
