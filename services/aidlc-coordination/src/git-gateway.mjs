import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const id = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }).trim();

/**
 * Gateway core. The deployment must deny every other writer to protected refs.
 * Authority persists an intent before entering the same lease lock used by claims;
 * a callback may update the ref only while that lock is held. A crash after Git's
 * CAS but before authority commit leaves a pending intent and requires reconciliation.
 */
export function createGitGateway({ repo, protectedRefs, authority }) {
  const root = realpathSync(repo);
  if (git(root, "rev-parse", "--is-bare-repository") !== "true") throw new Error("Git gateway requires a bare repository");
  if (!Array.isArray(protectedRefs) || !protectedRefs.length || new Set(protectedRefs).size !== protectedRefs.length) throw new Error("Explicit protected refs are required");
  const permitted = new Set(protectedRefs);
  for (const ref of protectedRefs) {
    if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || ref.includes("\0")) throw new Error("Invalid protected ref");
    git(root, "check-ref-format", ref);
  }
  if (typeof authority?.prepareGitOperation !== "function" || typeof authority?.withGitFence !== "function") throw new Error("Fenced authority with durable operations is required");
  return {
    async update({ workspace, taskId, epoch, ownerToken, operationId, ref, oldCommit, newCommit }) {
      if (!id(workspace) || !id(taskId) || !id(operationId) || !Number.isSafeInteger(epoch) || epoch < 1 || typeof ownerToken !== "string" || ownerToken.length < 32 || ownerToken.length > 256 || !permitted.has(ref) || !sha(oldCommit) || !sha(newCommit) || oldCommit === newCommit) throw new Error("Invalid protected Git update");
      // resolve a commit object before creating the durable intent; no refs are changed.
      if (git(root, "cat-file", "-t", newCommit) !== "commit") throw new Error("Git update requires a commit object");
      try { git(root, "merge-base", "--is-ancestor", oldCommit, newCommit); }
      catch { throw new Error("Protected Git updates must fast-forward"); }
      const operation = { workspace, taskId, operationId, ref, oldOid:oldCommit, newOid:newCommit, epoch };
      const prepared = await authority.prepareGitOperation({ ...operation, ownerToken });
      if (prepared?.status === "complete") return { status: "complete", operationId, ref, newCommit };
      if (prepared?.status !== "pending") throw new Error("Durable Git operation intent unavailable");
      return authority.withGitFence({ workspace, taskId, epoch, ownerToken, operationId }, async (transaction) => {
        if (typeof transaction?.assertValid !== "function" || typeof transaction?.complete !== "function" || transaction.record?.ref !== ref || transaction.record?.oldOid !== oldCommit || transaction.record?.newOid !== newCommit) throw new Error("Atomic fenced operation intent mismatch");
        const current = git(root, "rev-parse", "--verify", ref);
        if (current !== oldCommit) throw new Error(current === newCommit ? "Git update outcome uncertain; reconcile pending intent" : "Protected Git ref conflict");
        // Recheck expiry while the same lease lock is held immediately before CAS.
        await transaction.assertValid();
        // oldCommit is passed to Git itself: competing ref updates fail atomically.
        try { git(root, "update-ref", ref, newCommit, oldCommit); }
        catch { throw new Error("Protected Git ref compare-and-swap failed; reconcile intent"); }
        try { await transaction.complete(); }
        catch { throw new Error("Git ref updated but authority commit uncertain; reconcile pending intent"); }
        return { status: "complete", operationId, ref, newCommit };
      });
    }
  };
}
