/**
 * Resolve the repository HEAD commit for lifecycle wrappers (state.mjs, remote-state.mjs).
 * The lifecycle core never runs git; wrappers call this and then store.mjs#recordTaskCommit.
 */
import { execFileSync } from "node:child_process";

const shaPattern = /^[0-9a-f]{40,64}$/;

/**
 * Returns the full HEAD commit SHA of the git repository at `root`, or `undefined` when git is
 * unavailable, `root` is not inside a repository, or the repository has no commits. Never throws.
 */
export const headCommit = (root, { timeout = 5000 } = {}) => {
  if (typeof root !== "string" || !root.trim()) return undefined;
  try {
    const output = execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root, shell: false, timeout, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 4096 });
    const sha = String(output).trim().toLowerCase();
    return shaPattern.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
};
