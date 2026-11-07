/**
 * Code changes of one task for `/tasks/:id/changes` and `/api/tasks/:id/changes`.
 *
 * Requests carry only a task id and an optional item id. Every commit comes from a
 * record (local assignments or the fleet gate snapshot), is validated as a hex SHA and
 * resolved with `rev-parse --verify` before git ever sees it; no URL value reaches git.
 * Sources, in order: local assignment records → fleet gate snapshot → the working tree
 * (tasks without loop records) → `none` (no git). git runs via `execFile` (no shell)
 * with a scrubbed environment, no external diff/textconv, a timeout, and output caps.
 */
import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskState, WorkflowState } from "../model.js";
import { fleetGate, readUiState, readUiTask } from "./data.js";
import { scrubbedEnv, uiMode, type UiOptions } from "./options.js";

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
export const MAX_FILES = 300;
export const MAX_PATCH_BYTES = 1024 * 1024;
/** Total patch bytes the whole-task view renders; further items list files only. */
export const MAX_TASK_PATCH_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15000;
const STATS_MAX_BUFFER = 8 * 1024 * 1024;

/** Pseudo item ids for sources without per-item records. */
export const WORKING_TREE_ITEM = "working-tree";
export const INTEGRATION_ITEM = "integration";

export type ChangeSource = "assignments" | "fleet" | "working-tree" | "none";
export interface ChangedFile { path: string; oldPath?: string; status: string; added: number; removed: number; binary: boolean }
export interface ChangeItem { itemId: string; workerId?: string; commit: string; base?: string; files: ChangedFile[]; patch: string; truncated: boolean; note?: string; patchOmitted?: boolean }
export interface ChangesPayload { ok: true; source: ChangeSource; items: ChangeItem[]; note?: string }
export type ChangesResult =
  | { status: 200; payload: ChangesPayload; task: TaskState; state: WorkflowState }
  | { status: 400 | 404; payload: { ok: false; error: string } };

/* ---------------------------------------------------------------------------
 * git execution
 * ------------------------------------------------------------------------- */

/** Variables that would point git at another repository, index, or diff program. */
const GIT_REDIRECT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_PAGER"];
const gitEnv = (): NodeJS.ProcessEnv => {
  const env = scrubbedEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
  for (const name of GIT_REDIRECT_ENV) delete env[name];
  return env;
};

interface GitResult { ok: boolean; stdout: Buffer; overflow: boolean; missing: boolean; timedOut: boolean }

const runGit = (root: string, args: string[], maxBuffer = STATS_MAX_BUFFER): Promise<GitResult> =>
  new Promise((done) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd: root, shell: false, env: gitEnv(), maxBuffer, timeout: GIT_TIMEOUT_MS, encoding: "buffer", windowsHide: true }, (error, stdout) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const overflow = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      done({
        ok: !error,
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
        overflow,
        missing: code === "ENOENT",
        timedOut: Boolean(error && !overflow && (error as { killed?: boolean }).killed),
      });
    });
  });

/** Full SHA of a recorded commit, or undefined when the value is not a SHA or the object is missing. */
const resolveCommit = async (root: string, sha: string): Promise<string | undefined> => {
  if (!SHA_PATTERN.test(sha)) return undefined;
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], 4096);
  const full = result.ok ? result.stdout.toString("utf8").trim() : "";
  return SHA_PATTERN.test(full) ? full : undefined;
};

/** First parent of a resolved commit (undefined for a root commit). */
const firstParent = async (root: string, full: string): Promise<string | undefined> => {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", `${full}^1`], 4096);
  const parent = result.ok ? result.stdout.toString("utf8").trim() : "";
  return SHA_PATTERN.test(parent) ? parent : undefined;
};

/* ---------------------------------------------------------------------------
 * Parsing `-z` output
 * ------------------------------------------------------------------------- */

const STATUS_NAMES: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed", U: "unmerged", X: "unknown" };

/** `--name-status -z`: `S\0path\0` or `R<score>\0old\0new\0`. */
export const parseNameStatus = (raw: string): Array<{ status: string; path: string; oldPath?: string }> => {
  const tokens = raw.split("\0");
  const entries: Array<{ status: string; path: string; oldPath?: string }> = [];
  for (let i = 0; i < tokens.length;) {
    const code = tokens[i++] ?? "";
    if (!code) continue;
    const status = STATUS_NAMES[code[0] ?? ""] ?? "modified";
    if (code[0] === "R" || code[0] === "C") {
      const oldPath = tokens[i++]; const path = tokens[i++];
      if (oldPath === undefined || path === undefined) break;
      entries.push({ status, path, oldPath });
    } else {
      const path = tokens[i++];
      if (path === undefined) break;
      entries.push({ status, path });
    }
  }
  return entries;
};

/** `--numstat -z`: `added\tremoved\tpath\0`, or `added\tremoved\t\0old\0new\0` for a rename; binary is `-\t-`. */
export const parseNumstat = (raw: string): Array<{ path: string; added: number; removed: number; binary: boolean }> => {
  const tokens = raw.split("\0");
  const entries: Array<{ path: string; added: number; removed: number; binary: boolean }> = [];
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i++] ?? "";
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (!match) continue;
    let path = match[3] ?? "";
    if (!path) { i++; path = tokens[i++] ?? ""; }
    const binary = match[1] === "-" && match[2] === "-";
    entries.push({ path, added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary });
  }
  return entries;
};

/** Untracked paths from `git status --porcelain=v1 -z` (`XY path\0`, renames carry an extra `\0orig`). */
const parseUntracked = (raw: string): string[] => {
  const tokens = raw.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i++] ?? "";
    if (token.length < 4) continue;
    const x = token[0]; const y = token[1];
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
    if (x === "?" && y === "?") paths.push(token.slice(3));
  }
  return paths;
};

/** Cuts a patch that hit the byte cap at its last complete file section. */
const cutAtFileBoundary = (partial: Buffer): string => {
  const text = partial.toString("utf8");
  const last = text.lastIndexOf("\ndiff --git ");
  return last > 0 ? text.slice(0, last + 1) : "";
};

/* ---------------------------------------------------------------------------
 * Diff collection
 * ------------------------------------------------------------------------- */

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

type DiffCommand = (output: string[]) => string[];
/** `git diff <base> <commit>` between two resolved commits. */
const rangeDiff = (base: string, commit: string): DiffCommand => (output) => ["diff", ...DIFF_FLAGS, ...output, base, commit, "--"];
/** A root commit against the empty tree. */
const rootDiff = (commit: string): DiffCommand => (output) => ["diff-tree", "-r", "--root", "--no-commit-id", ...DIFF_FLAGS, ...output, commit, "--"];
/** Tracked working-tree changes against the resolved HEAD commit. */
const headDiff = (head: string): DiffCommand => (output) => ["diff", ...DIFF_FLAGS, ...output, head, "--"];

interface Collected { files: ChangedFile[]; patch: string; truncated: boolean; note?: string }

const gitFailure = (result: GitResult, what: string): string =>
  result.missing ? "git is not available" : result.timedOut ? `git timed out while reading ${what}` : `git could not read ${what}`;

/** File list (numstat + name-status) and patch, within the file and byte caps. */
const collectDiff = async (root: string, command: DiffCommand, extra: ChangedFile[] = []): Promise<Collected> => {
  const numstat = await runGit(root, command(["--numstat", "-z"]));
  if (!numstat.ok && !numstat.overflow) return { files: [], patch: "", truncated: false, note: gitFailure(numstat, "the diff") };
  const names = await runGit(root, command(["--name-status", "-z"]));
  if (!names.ok && !names.overflow) return { files: [], patch: "", truncated: false, note: gitFailure(names, "the diff") };
  const stats = parseNumstat(numstat.stdout.toString("utf8"));
  const statuses = parseNameStatus(names.stdout.toString("utf8"));
  const count = Math.min(stats.length, statuses.length);
  const tracked: ChangedFile[] = [];
  for (let index = 0; index < count; index++) {
    const stat = stats[index]!; const entry = statuses[index]!;
    tracked.push({ path: entry.path, ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}), status: entry.status, added: stat.added, removed: stat.removed, binary: stat.binary });
  }
  const all = [...tracked, ...extra];
  let truncated = numstat.overflow || names.overflow || all.length > MAX_FILES;
  const files = all.slice(0, MAX_FILES);
  if (truncated || !tracked.length) return { files, patch: "", truncated };
  const patch = await runGit(root, command(["--patch"]), MAX_PATCH_BYTES);
  if (patch.overflow) { truncated = true; return { files, patch: cutAtFileBoundary(patch.stdout), truncated }; }
  if (!patch.ok) return { files, patch: "", truncated, note: gitFailure(patch, "the patch") };
  return { files, patch: patch.stdout.toString("utf8"), truncated };
};

const MISSING_NOTE = "commit not available in the local repository";

/** One recorded commit diffed against its first parent (empty tree for a root commit). */
const commitItem = async (root: string, itemId: string, recorded: string, extra: Partial<ChangeItem> = {}): Promise<ChangeItem> => {
  const full = await resolveCommit(root, recorded);
  if (!full) return { itemId, ...extra, commit: recorded, files: [], patch: "", truncated: false, note: MISSING_NOTE };
  const parent = await firstParent(root, full);
  const collected = await collectDiff(root, parent ? rangeDiff(parent, full) : rootDiff(full));
  return { itemId, ...extra, commit: full, ...(parent ? { base: parent } : {}), ...collected };
};

/* ---------------------------------------------------------------------------
 * Sources
 * ------------------------------------------------------------------------- */

interface AssignmentRecord { itemId?: unknown; workerId?: unknown; state?: unknown; attempt?: unknown; commit?: unknown; baseCommit?: unknown; integrationCommit?: unknown }

/** Local assignment records (read-only). Refuses symlinked path components like `assignmentPath`. */
const readAssignments = (root: string, taskId: string): { records: AssignmentRecord[] } | { error: string } | undefined => {
  let path = resolve(root);
  for (const part of [".agents", "data", "loop", "assignments", `${taskId}.json`]) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) return { error: "Assignment records path crosses a symlink; ignored" }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return { error: "Assignment records are unreadable" };
    }
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { taskId?: unknown; assignments?: unknown };
    if (value?.taskId !== taskId || !Array.isArray(value.assignments)) return { error: "Assignment records are malformed" };
    return { records: value.assignments.filter((entry): entry is AssignmentRecord => entry !== null && typeof entry === "object") };
  } catch {
    return { error: "Assignment records are unreadable" };
  }
};

/** Latest reported or integrated attempt per item, in first-seen order. */
const latestAssignments = (records: AssignmentRecord[]): AssignmentRecord[] => {
  const latest = new Map<string, AssignmentRecord>();
  for (const record of records) {
    if (typeof record.itemId !== "string" || !ID_PATTERN.test(record.itemId)) continue;
    if (record.state !== "reported" && record.state !== "integrated") continue;
    const attempt = (value: AssignmentRecord | undefined): number => Number.isSafeInteger(value?.attempt) ? value!.attempt as number : 0;
    const previous = latest.get(record.itemId);
    if (!previous || attempt(record) >= attempt(previous)) latest.set(record.itemId, record);
  }
  return [...latest.values()];
};

/** A recorded SHA field: absent, a valid hex SHA, or invalid (never passed to git). */
const recordedSha = (value: unknown): { sha?: string; invalid: boolean } =>
  value === undefined || value === null || value === "" ? { invalid: false }
    : typeof value === "string" && SHA_PATTERN.test(value) ? { sha: value, invalid: false }
      : { invalid: true };

const assignmentItem = async (root: string, record: AssignmentRecord): Promise<ChangeItem> => {
  const itemId = record.itemId as string;
  const extra: Partial<ChangeItem> = typeof record.workerId === "string" && ID_PATTERN.test(record.workerId) ? { workerId: record.workerId } : {};
  const integration = recordedSha(record.integrationCommit);
  const commit = recordedSha(record.commit);
  const base = recordedSha(record.baseCommit);
  const empty = (note: string, fields: Partial<ChangeItem> = {}): ChangeItem => ({ itemId, ...extra, commit: "", files: [], patch: "", truncated: false, ...fields, note });
  let integrationMissing = false;
  if (integration.sha) {
    const integrated = await commitItem(root, itemId, integration.sha, extra);
    // A rewritten integration branch can drop the recorded commit: fall back to the worker commit.
    if (integrated.note !== MISSING_NOTE || !commit.sha) return integrated;
    integrationMissing = true;
  }
  // An invalid integration commit is ignored (never passed to git); the worker commit is shown instead.
  const fallbackNote = integrationMissing ? "recorded integration commit is not in the local repository; showing the worker commit" : "recorded integration commit is not a valid SHA; showing the worker commit";
  const withNote = (item: ChangeItem): ChangeItem => (integration.invalid || integrationMissing) && !item.note ? { ...item, note: fallbackNote } : item;
  if (commit.invalid || base.invalid) return empty("recorded commit is not a valid SHA; ignored");
  if (!commit.sha) return empty(integration.invalid ? "recorded integration commit is not a valid SHA; ignored" : "no commit recorded for this item");
  if (!base.sha) return withNote(await commitItem(root, itemId, commit.sha, extra));
  const full = await resolveCommit(root, commit.sha);
  const baseFull = await resolveCommit(root, base.sha);
  if (!full || !baseFull) return empty(MISSING_NOTE, { commit: commit.sha, base: base.sha });
  return withNote({ itemId, ...extra, commit: full, base: baseFull, ...await collectDiff(root, rangeDiff(baseFull, full)) });
};

const workingTreeItem = async (root: string): Promise<ChangeItem> => {
  // The literal `HEAD` is the only fixed revision used; its resolved SHA is validated like any other.
  const resolved = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], 4096);
  const headSha = resolved.ok ? resolved.stdout.toString("utf8").trim() : "";
  const head = SHA_PATTERN.test(headSha) ? headSha : undefined;
  const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok && !status.overflow) return { itemId: WORKING_TREE_ITEM, commit: head ?? "", files: [], patch: "", truncated: false, note: gitFailure(status, "the working tree") };
  const untracked: ChangedFile[] = parseUntracked(status.stdout.toString("utf8")).map((path) => ({ path, status: "untracked", added: 0, removed: 0, binary: false }));
  if (!head) {
    const truncated = status.overflow || untracked.length > MAX_FILES;
    return { itemId: WORKING_TREE_ITEM, commit: "", files: untracked.slice(0, MAX_FILES), patch: "", truncated, note: "the repository has no commits yet; only untracked files are listed" };
  }
  const collected = await collectDiff(root, headDiff(head), untracked);
  return { itemId: WORKING_TREE_ITEM, commit: head, ...collected, truncated: collected.truncated || status.overflow };
};

/* ---------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------- */

/**
 * Whole-task budget: keep patches until MAX_TASK_PATCH_BYTES is spent (the focused
 * item is always kept and counted first); the rest list their files only and are
 * marked `patchOmitted` so the page can load them one at a time.
 */
export const capTaskPatch = (items: ChangeItem[], focus: string | null): ChangeItem[] => {
  let budget = MAX_TASK_PATCH_BYTES;
  const omitted = new Set<ChangeItem>();
  const order = [...items].sort((left, right) => Number(right.itemId === focus) - Number(left.itemId === focus));
  for (const item of order) {
    const size = Buffer.byteLength(item.patch);
    if (item.itemId !== focus && size > budget) omitted.add(item);
    else budget -= size;
  }
  return items.map((item) => omitted.has(item)
    ? { ...item, patch: "", patchOmitted: true }
    : item);
};

/**
 * Changes of `taskId` (optionally one item). 400 for a malformed id, 404 for an unknown
 * task or item; git problems are reported as notes inside a 200 payload, never as a 500.
 */
export const taskChanges = async (options: UiOptions, taskId: string, itemId: string | null, known?: WorkflowState, focusItem: string | null = null): Promise<ChangesResult> => {
  if (!ID_PATTERN.test(taskId)) return { status: 400, payload: { ok: false, error: "Invalid task id" } };
  if (itemId !== null && !ID_PATTERN.test(itemId)) return { status: 400, payload: { ok: false, error: "Invalid item id" } };
  const state = known ?? await readUiState(options);
  const task = readUiTask(options, taskId, state);
  if (!task) return { status: 404, payload: { ok: false, error: `Task not found: ${taskId}` } };
  const root = options.root;
  const done = (payload: Omit<ChangesPayload, "ok">): ChangesResult => {
    if (itemId !== null && !payload.items.some((item) => item.itemId === itemId)) return { status: 404, payload: { ok: false, error: `Item not found: ${itemId}` } };
    return { status: 200, payload: { ok: true, ...payload }, task, state };
  };

  const repo = await runGit(root, ["rev-parse", "--is-inside-work-tree"], 4096);
  if (!repo.ok || repo.stdout.toString("utf8").trim() !== "true") {
    const note = repo.missing ? "git is not available" : repo.timedOut ? "git timed out" : "the project is not a git repository";
    if (itemId !== null) return { status: 404, payload: { ok: false, error: `Item not found: ${itemId}` } };
    return done({ source: "none", items: [], note });
  }

  if (uiMode(options) === "fleet") {
    let recorded: unknown;
    let note = "No integration commit in the current review snapshot yet (it is recorded at the code review gate)";
    try { recorded = (await fleetGate(options, taskId)).snapshot?.integrationCommit; }
    catch { note = "The fleet review snapshot is unavailable"; }
    const sha = recordedSha(recorded);
    if (sha.invalid) return done({ source: "fleet", items: [], note: "The snapshot's integration commit is not a valid SHA; ignored" });
    if (!sha.sha) return done({ source: "fleet", items: [], note });
    if (itemId !== null && itemId !== INTEGRATION_ITEM) return done({ source: "fleet", items: [] });
    return done({ source: "fleet", items: [await commitItem(root, INTEGRATION_ITEM, sha.sha)] });
  }

  const records = readAssignments(root, taskId);
  const latest = records && "records" in records ? latestAssignments(records.records) : [];
  if (latest.length) {
    const wanted = itemId === null ? latest : latest.filter((record) => record.itemId === itemId);
    const items: ChangeItem[] = [];
    for (const record of wanted) items.push(await assignmentItem(root, record));
    return done({ source: "assignments", items: itemId === null ? capTaskPatch(items, focusItem) : items });
  }
  const note = records && "error" in records ? `${records.error}; showing the working tree instead`
    : records ? "No reported or integrated assignments for this task yet; showing the working tree instead"
      : undefined;
  if (itemId !== null && itemId !== WORKING_TREE_ITEM) return done({ source: "working-tree", items: [] });
  return done({ source: "working-tree", items: [await workingTreeItem(root)], ...(note ? { note } : {}) });
};
