import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWorkerSnapshot, inspectWorkerSnapshot } from "./loop-worker-snapshot.mjs";

const SHA = /^[0-9a-f]{40,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function validId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function validSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function validBranch(value) {
  if (typeof value !== "string" || !BRANCH.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.split("/").some((part) => part.startsWith("."))) throw new Error("Invalid Git branch");
  return value;
}
function validPath(value, label = "path") {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.split("/").some((part, index, parts) => (!part && index !== parts.length - 1) || part === "." || part === "..") || value === ".git" || value.startsWith(".git/")) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}
function scopes(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Assignment requires nonempty ownedPaths");
  return [...new Set(input.map((path) => validPath(path, "owned path")))].sort();
}
function inScope(path, ownedPaths) { return ownedPaths.some((scope) => path === scope || (scope.endsWith("/") && path.startsWith(scope))); }
function changedPaths(root, base, head) {
  const raw = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, head], { cwd: root, encoding: "buffer", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return raw.toString("utf8").split("\0").filter(Boolean).map((path) => validPath(path, "changed path")).sort();
}
function worktreePaths(root) {
  const unstaged = execFileSync("git", ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z"], { cwd: root, encoding: "buffer", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const staged = execFileSync("git", ["diff", "--cached", "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD"], { cwd: root, encoding: "buffer", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "buffer", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return [...new Set(Buffer.concat([unstaged, staged, untracked]).toString("utf8").split("\0").filter(Boolean).map((path) => validPath(path, "changed path")))].sort();
}
function worktreeFingerprint(root, paths) {
  // Hash the index as well as the worktree: a staged edit may differ from both
  // HEAD and the current file, even when the latter has been restored to HEAD.
  const index = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "buffer", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const files = paths.map((path) => {
    try {
      const target = join(root, path);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) return [path, "symlink", stat.mode, createHash("sha256").update(readlinkSync(target)).digest("hex")];
      if (!stat.isFile()) throw new Error(`Unsupported changed path type: ${path}`);
      return [path, "file", stat.mode, createHash("sha256").update(readFileSync(target)).digest("hex")];
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [path, "deleted"];
      throw error;
    }
  });
  return createHash("sha256").update(git(root, "rev-parse", "HEAD")).update(index).update(JSON.stringify(files)).digest("hex");
}
function checkScope(paths, ownedPaths) {
  const outside = paths.filter((path) => !inScope(path, ownedPaths));
  if (outside.length) throw new Error(`Worker changed paths outside assignment: ${outside.join(", ")}`);
}
function remoteRef(remote, branch) { return `refs/remotes/${remote}/${branch}`; }
function fetchBranch(root, remote, branch) {
  validBranch(branch);
  git(root, "fetch", "--no-tags", remote, `refs/heads/${branch}:${remoteRef(remote, branch)}`);
  return git(root, "rev-parse", remoteRef(remote, branch));
}
function ancestor(root, base, head) {
  try { git(root, "merge-base", "--is-ancestor", base, head); return true; } catch { return false; }
}
function assertClean(root) {
  if (git(root, "status", "--porcelain=v1", "--untracked-files=all")) throw new Error("Git worktree must be clean before handoff or integration");
}
function normaliseReport(job) {
  const report = job.report ?? job;
  const commitSha = validSha(report.commitSha, "reported commit SHA");
  const changed = Array.isArray(report.changedPaths) ? [...new Set(report.changedPaths.map((path) => validPath(path, "reported path")))].sort() : null;
  if (!changed) throw new Error("Report lacks changedPaths");
  return { commitSha, changed };
}

/** The coordinator calls this from its protected integration checkout. */
export function createLeadGitHandoff({ root: inputRoot, integrationBranch, remote = "origin", agent = "codex" }) {
  const root = resolve(inputRoot);
  validBranch(integrationBranch); validId(remote, "remote");
  if (!["codex", "claude"].includes(agent)) throw new Error("Invalid worker agent");
  const current = () => { const branch = git(root, "symbolic-ref", "--short", "HEAD"); if (branch !== integrationBranch) throw new Error(`Expected integration branch ${integrationBranch}, found ${branch}`); return git(root, "rev-parse", "HEAD"); };
  const syncCurrent = () => {
    assertClean(root);
    const localHead = current();
    const remoteHead = fetchBranch(root, remote, integrationBranch);
    if (localHead === remoteHead || ancestor(root, remoteHead, localHead)) return localHead;
    if (!ancestor(root, localHead, remoteHead)) throw new Error("Integration branch diverged from remote; reconcile before dispatch");
    git(root, "merge", "--ff-only", remoteHead);
    return current();
  };
  return {
    async currentCommit() {
      const localHead = syncCurrent();
      const remoteHead = fetchBranch(root, remote, integrationBranch);
      if (localHead !== remoteHead) throw new Error("Integration commit is not published to the remote branch");
      return localHead;
    },
    async prepare({ taskId, item }) {
      validId(taskId, "task ID"); validId(item?.id, "item ID");
      const ownedPaths = scopes(item.ownedPaths);
      const baseCommit = syncCurrent();
      const branch = validBranch(`aidlc/${taskId}/${item.id}/${randomUUID()}`);
      return { baseCommit, branch, ownedPaths, agent: item.agent ?? agent };
    },
    async verify({ job }) {
      try {
        const branch = validBranch(job.branch);
        const baseCommit = validSha(job.baseCommit, "base commit");
        const ownedPaths = scopes(job.ownedPaths);
        const { commitSha, changed } = normaliseReport(job);
        const fetched = fetchBranch(root, remote, branch);
        if (fetched !== commitSha) throw new Error("Reported commit does not match remote worker branch");
        git(root, "cat-file", "-e", `${baseCommit}^{commit}`);
        if (!ancestor(root, baseCommit, commitSha) || baseCommit === commitSha) throw new Error("Worker commit is not descended from assigned base");
        const actualPaths = changedPaths(root, baseCommit, commitSha);
        checkScope(actualPaths, ownedPaths);
        if (JSON.stringify(actualPaths) !== JSON.stringify(changed)) throw new Error("Reported changed paths do not match Git commit");
        const currentHead = syncCurrent();
        if (!ancestor(root, baseCommit, currentHead)) throw new Error("Integration branch no longer contains assigned base");
        return { valid: true, commitSha, baseCommit, branch, changedPaths: actualPaths, ownedPaths, alreadyIntegrated: ancestor(root, commitSha, currentHead) };
      } catch (error) { return { valid: false, reason: error.message }; }
    },
    async recover({ job }) {
      try {
        const branch = validBranch(job.branch);
        const baseCommit = validSha(job.baseCommit, "base commit");
        const ownedPaths = scopes(job.ownedPaths);
        try { git(root, "ls-remote", "--exit-code", remote, `refs/heads/${branch}`); }
        catch (error) {
          if (error?.status === 2) return { recovered: false, retryable: true, reason: "Assigned remote branch has no pushed commit" };
          throw error;
        }
        const commitSha = fetchBranch(root, remote, branch);
        git(root, "cat-file", "-e", `${baseCommit}^{commit}`);
        if (baseCommit === commitSha) return { recovered: false, retryable: true, reason: "Assigned remote branch remains at base commit" };
        if (!ancestor(root, baseCommit, commitSha)) throw new Error("Worker branch is not descended from assigned base");
        const changed = changedPaths(root, baseCommit, commitSha);
        if (!changed.length) throw new Error("Worker branch has no changed paths");
        checkScope(changed, ownedPaths);
        const report = { commitSha, changedPaths: changed };
        const verified = await this.verify({ job: { ...job, report } });
        if (!verified.valid) throw new Error(verified.reason);
        return { recovered: true, report, ...verified };
      } catch (error) { return { recovered: false, reason: error.message }; }
    },
    async integrate({ job }) {
      // A prior verification result is advisory: re-fetch the ref at integration
      // time so a rewritten worker branch or stale report cannot be trusted.
      const verified = await this.verify({ job });
      if (!verified.valid) throw new Error(`Git artifact verification failed: ${verified.reason}`);
      const before = syncCurrent();
      if (ancestor(root, verified.commitSha, before)) {
        try { git(root, "push", remote, `HEAD:refs/heads/${integrationBranch}`); }
        catch (error) { throw new Error(`Integrated locally at ${before}, but remote push failed: ${error.message}`); }
        return { integrated: false, alreadyIntegrated: true, commitSha: verified.commitSha, integrationCommit: before, changedPaths: verified.changedPaths };
      }
      try {
        git(root, "-c", "user.name=AI-DLC lead", "-c", "user.email=aidlc-lead@localhost", "merge", "--no-ff", "--no-edit", verified.commitSha);
      } catch (error) {
        try { git(root, "merge", "--abort"); } catch { /* The original merge error is authoritative. */ }
        throw new Error(`Git integration conflict or failure: ${error.message}`);
      }
      const integrationCommit = current();
      try { git(root, "push", remote, `HEAD:refs/heads/${integrationBranch}`); }
      catch (error) { throw new Error(`Integrated locally at ${integrationCommit}, but remote push failed: ${error.message}`); }
      return { integrated: true, alreadyIntegrated: false, commitSha: verified.commitSha, integrationCommit, changedPaths: verified.changedPaths };
    }
  };
}

/** Workers receive only assignment metadata and never write the integration branch. */
export function createWorkerGitHandoff({ root: inputRoot, worktreesRoot: inputWorktreesRoot, remote = "origin" }) {
  const root = resolve(inputRoot);
  const worktreesRoot = resolve(inputWorktreesRoot);
  validId(remote, "remote");
  if (worktreesRoot === root || worktreesRoot.startsWith(`${root}/`)) throw new Error("Worker worktree directory must be outside the source checkout");
  return {
    async prepare(job) {
      validId(job.assignmentId, "assignment ID");
      const base = validSha(job.baseCommit, "base commit");
      const branch = validBranch(job.branch);
      scopes(job.ownedPaths);
      mkdirSync(worktreesRoot, { recursive: true });
      const workspace = join(worktreesRoot, job.assignmentId);
      if (existsSync(workspace)) {
        const actualBranch = git(workspace, "symbolic-ref", "--short", "HEAD");
        if (actualBranch !== branch || !ancestor(workspace, base, "HEAD")) throw new Error("Existing worker worktree does not match assignment");
        return { root: workspace, branch };
      }
      git(root, "fetch", "--no-tags", remote, base);
      git(root, "worktree", "add", "-b", branch, workspace, base);
      return { root: workspace, branch };
    },
    async observe({ job, workspace, result }) {
      const changed = worktreePaths(workspace.root);
      checkScope(changed, scopes(job.ownedPaths));
      const done = typeof result?.resultText === "string" && result.resultText.split(/\r?\n/).some((line) => line.trim() === "AI-DLC-ITEM-COMPLETE");
      return { done, fingerprint: worktreeFingerprint(workspace.root, changed) };
    },
    async finish({ job, workspace }) {
      const branch = validBranch(job.branch);
      if (git(workspace.root, "symbolic-ref", "--short", "HEAD") !== branch) throw new Error("Worker switched away from assigned branch");
      const ownedPaths = scopes(job.ownedPaths);
      const dirty = worktreePaths(workspace.root);
      checkScope(dirty, ownedPaths);
      if (dirty.length) {
        git(workspace.root, "add", "-A", "--", ...dirty);
        git(workspace.root, "-c", "user.name=AI-DLC worker", "-c", "user.email=aidlc-worker@localhost", "commit", "-m", `AI-DLC ${validId(job.taskId, "task ID")}/${validId(job.itemId, "item ID")} ${validId(job.assignmentId, "assignment ID")}`);
      }
      const commitSha = git(workspace.root, "rev-parse", "HEAD");
      const base = validSha(job.baseCommit, "base commit");
      if (commitSha === base) throw new Error("Worker produced no commit");
      const changed = changedPaths(workspace.root, base, commitSha);
      checkScope(changed, ownedPaths);
      git(workspace.root, "push", remote, `HEAD:refs/heads/${branch}`);
      return { commitSha, changedPaths: changed };
    },
    async discard({ workspace }) {
      const path = resolve(workspace.root);
      if (!path.startsWith(`${worktreesRoot}/`)) throw new Error("Invalid worker worktree path");
      git(root, "worktree", "remove", "--force", path);
      rmSync(path, { recursive: true, force: true });
    }
  };
}

/** Worker sees only a checked source snapshot. Git and credentials remain on host. */
export function createIsolatedWorkerGitHandoff(options) {
  const host = createWorkerGitHandoff(options);
  return {
    async prepare(job) {
      const checkout = await host.prepare(job);
      if (worktreePaths(checkout.root).length || git(checkout.root, "rev-parse", "HEAD") !== job.baseCommit) throw new Error("Existing worker checkout requires reconciliation");
      const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: checkout.root, encoding: "utf8", timeout: 30000 }).split("\0").filter((path) => path && path !== ".agents/data" && !path.startsWith(".agents/data/"));
      const snapshot = mkdtempSync(join(resolve(options.worktreesRoot), "snapshot-"));
      try { const baseline = createWorkerSnapshot(checkout.root, snapshot, tracked); return { root: snapshot, checkout, baseline }; }
      catch (error) { rmSync(snapshot, {recursive:true,force:true}); throw error; }
    },
    async observe({job, workspace, result}) {
      const changed = inspectWorkerSnapshot(workspace.root, workspace.baseline, job.ownedPaths);
      const fingerprint = createHash("sha256").update(JSON.stringify(changed.map((path) => { const full=join(workspace.root,path); return existsSync(full) ? [path,createHash("sha256").update(readFileSync(full)).digest("hex"),lstatSync(full).mode] : [path,null]; }))).digest("hex");
      const done = typeof result?.resultText === "string" && result.resultText.split(/\r?\n/).some((line) => line.trim() === "AI-DLC-ITEM-COMPLETE");
      return {done, fingerprint};
    },
    async finish({job, workspace}) {
      const changed=inspectWorkerSnapshot(workspace.root, workspace.baseline, job.ownedPaths);
      if (!changed.length) throw new Error("Worker produced no changes");
      if (worktreePaths(workspace.checkout.root).length || git(workspace.checkout.root,"rev-parse","HEAD") !== job.baseCommit) throw new Error("Host checkout changed during worker run");
      for (const path of changed) {
        const source=join(workspace.root,path), target=join(workspace.checkout.root,path);
        let parent = workspace.checkout.root;
        for (const segment of path.split("/").slice(0,-1)) {
          parent = join(parent,segment);
          try { const info=lstatSync(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe integration directory"); }
          catch(error) { if (error.code !== "ENOENT") throw error; mkdirSync(parent); }
        }
        try { const info=lstatSync(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe integration target"); }
        catch(error) { if (error.code !== "ENOENT") throw error; }
        if (!existsSync(source)) { rmSync(target,{force:true}); continue; }
        copyFileSync(source,target); chmodSync(target,lstatSync(source).mode & 0o777);
      }
      const result=await host.finish({job,workspace:workspace.checkout});
      rmSync(workspace.root,{recursive:true,force:true}); return result;
    },
    async discard({workspace}) { rmSync(workspace.root,{recursive:true,force:true}); return host.discard({workspace:workspace.checkout}); }
  };
}
