import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createWorkerSnapshot, inspectWorkerSnapshot } from "./loop-worker-snapshot.mjs";
import { OPENCODE_CONTAINER_ERROR, workerDockerInvocation } from "./loop-worker-docker.mjs";
import { isLoopProvider, runAgentTurn } from "./loop-drivers.mjs";
import { claimLocalAssignment, heartbeatLocalAssignment, reportLocalAssignment, releaseLocalAssignment } from "./assignment-store.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
const lines = (value) => value.split("\0").filter(Boolean);
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const safePath = (path) => typeof path === "string" && path.length > 0 && !isAbsolute(path) && !path.includes("\\") && !path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".agents") && !/[\x00-\x1f]/.test(path);
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const scoped = (paths, scopes) => paths.every((path) => safePath(path) && scopes.some((scope) => path === scope || path.startsWith(`${scope}/`)));
const statusPaths = (root) => {
  // --no-renames yields one entry per path, including both sides of a rename.
  return lines(git(root, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all")).map((row) => row.slice(3));
};
const commitPaths = (root, base, head) => lines(git(root, "diff", "--name-only", "-z", "--no-renames", base, head, "--"));
// Workflow state and assignment records are lead-owned and never in worker
// scopes. Their ordinary updates must not block integrating code-only commits.
const clean = (root) => { if (statusPaths(root).some((path) => !path.startsWith(".agents/data/"))) throw new Error("Local integration worktree must be clean outside workflow data"); };

/**
 * Execute a batch of independent local jobs in isolated worktrees, then integrate
 * verified scoped commits sequentially. Assignment metadata is not lifecycle
 * state: the caller alone marks canonical items done after inspecting results.
 * A failed batch is deliberately left for reconciliation, not auto-retried.
 */
export async function runLocalWorkerBatch({ root: inputRoot, taskId, jobs, worktreesRoot: inputWorktreesRoot, docker, timeoutMs = 600000, leaseMs = 300000, maxTurns = 12, maxStallTurns = 2, claim = claimLocalAssignment, heartbeat = heartbeatLocalAssignment, report = reportLocalAssignment, release = releaseLocalAssignment, onEvent = () => {} }) {
  const root = resolve(inputRoot), worktreesRoot = resolve(inputWorktreesRoot);
  if (!identifier(taskId) || !Array.isArray(jobs) || !jobs.length) throw new Error("Valid task and non-empty jobs are required");
  if (root === worktreesRoot || worktreesRoot.startsWith(`${root}${sep}`)) throw new Error("Worker worktree root must be outside the integration checkout");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw new Error("Invalid timeout or lease");
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000 || !Number.isSafeInteger(maxStallTurns) || maxStallTurns < 1 || maxStallTurns > 20) throw new Error("Invalid worker turn or stall limit");
  const ids = new Set(), workers = new Set(), scopes = [];
  for (const job of jobs) {
    if (!identifier(job.itemId) || !identifier(job.workerId) || !isLoopProvider(job.agent) || typeof job.prompt !== "string" || !job.prompt.trim() || !Array.isArray(job.ownedPaths) || !job.ownedPaths.length || job.ownedPaths.length > 64 || !job.ownedPaths.every(safePath)) throw new Error("Invalid local job");
    if (ids.has(job.itemId) || workers.has(job.workerId)) throw new Error("Items and workers must be distinct within a batch");
    ids.add(job.itemId); workers.add(job.workerId);
    for (const path of job.ownedPaths) { if (scopes.some((prior) => overlaps(path, prior))) throw new Error(`Overlapping assignment scope: ${path}`); scopes.push(path); }
  }
  if (jobs.some((job) => job.agent === "opencode")) throw new Error(OPENCODE_CONTAINER_ERROR);
  if (process.platform !== "linux" || !docker || typeof docker.image !== "string" || !docker.credentials || typeof docker.credentials !== "object") throw new Error("Linux Docker worker isolation and explicit image and provider credentials are required");
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (!uid || !gid) throw new Error("Docker workers require a non-root host user");
  for (const job of jobs) {
    const keys = docker.credentials[job.agent];
    workerDockerInvocation({ workspace: root, image: docker.image, command: job.agent, args: [], credentialEnv: keys, hostEnv: process.env, uid, gid });
  }
  const dockerEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const dockerCheck = (...args) => execFileSync("docker", args, { env: dockerEnv, stdio: "ignore", timeout: 30000 });
  let image;
  try {
    dockerCheck("info");
    image=execFileSync("docker",["image","inspect","--format","{{.Id}}",docker.image],{env:dockerEnv,encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:30000}).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Docker worker image lacks immutable image ID");
    for (const agent of new Set(jobs.map((job) => job.agent))) dockerCheck("run", "--rm", "--network", "none", "--read-only", "--user", `${uid}:${gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", agent, image, "--version");
  } catch { throw new Error("Docker engine, image, or provider CLI preflight failed"); }
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
  const execute = async ({ job, assignment, workspace, snapshot, baseline, branch }) => {
    let renewalError;
    const controller = new AbortController();
    const timer = setInterval(() => { Promise.resolve().then(() => heartbeat(root, taskId, assignment.id, leaseMs)).catch((error) => { renewalError = error; controller.abort(); }); }, Math.max(500, Math.floor(leaseMs / 3)));
    try {
      const home=mkdtempSync(join(tmpdir(), "aidlc-local-home-")); chmodSync(home,0o700);
      let sessionId, previousFingerprint, stalls=0, result;
      try {
        for (let turn=0; turn<maxTurns; turn++) {
          if (renewalError || controller.signal.aborted) throw renewalError ?? new Error("Worker lease lost");
          const containerName = `aidlc-worker-${randomUUID()}`;
          const spawnProcess = (command, args, options) => {
            const invocation = workerDockerInvocation({ workspace: snapshot, image, command, args, credentialEnv: docker.credentials[job.agent], hostEnv: process.env, uid, gid, containerName, sessionHome:home });
            return spawn(invocation.command, invocation.args, { ...options, cwd: snapshot, env: invocation.env, shell: false });
          };
          try { result = await runAgentTurn({ agent: job.agent, root: "/workspace", sessionId, spawnProcess, prompt: `${job.prompt}\n\nOnly modify assigned paths: ${job.ownedPaths.join(", ")}. Do not modify AI-DLC lifecycle state or approve gates. End with AI-DLC-ITEM-COMPLETE on its own line.`, timeoutMs, signal: controller.signal, onSessionId: async (id) => { await heartbeat(root, taskId, assignment.id, leaseMs, id); } }); }
          finally {
            try { dockerCheck("rm", "-f", containerName); }
            catch {
              try { dockerCheck("info"); } catch { throw new Error("Docker cleanup uncertain: engine unavailable"); }
              try { dockerCheck("inspect", containerName); throw new Error("Docker cleanup uncertain: container remains"); }
              catch (error) { if (error.message === "Docker cleanup uncertain: container remains") throw error; }
            }
          }
          if (renewalError || controller.signal.aborted) throw renewalError ?? new Error("Worker lease lost");
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
      if (renewalError || controller.signal.aborted) throw renewalError ?? new Error("Worker lease lost");
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
      if (git(workspace, "diff", "--cached", "--name-only").trim()) git(workspace, "-c", "user.name=AI-DLC worker", "-c", "user.email=aidlc-worker@localhost", "commit", "-m", `AI-DLC ${taskId}/${job.itemId}`);
      const commit = git(workspace, "rev-parse", "HEAD").trim(), committed = commitPaths(workspace, base, commit);
      if (commit === base || !committed.length || !scoped(committed, job.ownedPaths)) throw new Error("Worker commit is outside assignment scope");
      await report(root, taskId, assignment.id, { commit, changedPaths: committed, checkpoint: `provider=${job.agent}` });
      return { assignmentId: assignment.id, itemId: job.itemId, workerId: job.workerId, agent: job.agent, baseCommit: base, branch, commit, changedPaths: committed, workspace };
    } finally { clearInterval(timer); }
  };
  const results = await Promise.allSettled(prepared.map(execute));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw new Error(`Local worker batch requires reconciliation: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`);
  const completed = results.map((result) => result.value);
  let expectedHead = base;
  for (const result of completed) {
    clean(root);
    if (git(root, "symbolic-ref", "--short", "HEAD").trim() !== initialBranch) throw new Error("Integration branch changed during worker run");
    if (git(root, "rev-parse", "HEAD").trim() !== expectedHead) throw new Error("Integration HEAD changed during worker run");
    if (!scoped(commitPaths(root, base, result.commit), jobs.find((job) => job.itemId === result.itemId).ownedPaths)) throw new Error("Worker scope changed before integration");
    git(root, "-c", "user.name=AI-DLC integrator", "-c", "user.email=aidlc-integrator@localhost", "cherry-pick", result.commit);
    result.integrationCommit = git(root, "rev-parse", "HEAD").trim();
    expectedHead = result.integrationCommit;
    await onEvent({ type: "job_integrated", taskId, itemId: result.itemId, assignmentId: result.assignmentId, commit: result.integrationCommit });
  }
  return completed;
}
