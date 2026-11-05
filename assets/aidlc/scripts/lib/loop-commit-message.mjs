/**
 * Conventional Commit message extraction for worker Git commits.
 *
 * The worker may author the commit message by ending its final answer with a
 * dedicated line (`AI-DLC-COMMIT: type(scope): subject`) next to the existing
 * `AI-DLC-ITEM-COMPLETE` completion marker. The supervisor parses and validates
 * that message; when it is absent or malformed it derives a deterministic,
 * conventional fallback from the item id and owned paths instead of reusing the
 * legacy `AI-DLC <task>/<item>` form. This module is dependency-free like the
 * rest of the installed loop runtime.
 */

const COMMIT_LINE = /^AI-DLC-COMMIT:\s*(.+?)\s*$/m;
const TYPE = "(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)";
const SCOPE = "\\([^()\\r\\n]{1,64}\\)";
const MESSAGE = new RegExp(`^${TYPE}(${SCOPE})?!?: [^\\r\\n]{1,200}$`);
const CONTROL = /[\u0000-\u001f\u007f]/;

function fallbackScope(ownedPaths) {
  if (!Array.isArray(ownedPaths) || !ownedPaths.length) return "";
  const topLevels = ownedPaths.map((path) => String(path).split("/")[0]);
  const unique = [...new Set(topLevels)];
  // Use a scope only when every owned path sits under one real top-level
  // directory; a bare file (no "/") or a split across directories is ambiguous.
  if (unique.length !== 1 || !ownedPaths.every((path) => String(path).includes("/"))) return "";
  return unique[0];
}

/**
 * Return a Conventional Commits message for a worker commit. When the worker's
 * final answer carries a valid `AI-DLC-COMMIT:` line that message is used
 * verbatim; otherwise a fallback `chore(<scope>): <item-id>` is derived.
 */
export function extractCommitMessage(resultText, { itemId, ownedPaths = [] } = {}) {
  if (typeof resultText === "string") {
    const match = resultText.match(COMMIT_LINE);
    if (match) {
      const message = match[1].trim();
      if (MESSAGE.test(message) && !CONTROL.test(message)) return message;
    }
  }
  const scope = fallbackScope(ownedPaths);
  const subject = typeof itemId === "string" && itemId.trim() ? itemId.trim() : "update";
  return scope ? `chore(${scope}): ${subject}` : `chore: ${subject}`;
}
