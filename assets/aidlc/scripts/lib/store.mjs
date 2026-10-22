import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

const phases = ["clarify", "plan", "build", "wrap", "done"];
const gates = ["none", "G0_confirm", "G1_review", "G2_codereview"];
const statuses = ["active", "blocked_on_user", "paused", "done", "closed", "superseded"];
const handoffKinds = ["repair_exhausted", "review_exhausted", "g2_failed", "release_failed", "structural_change", "other"];
const terminal = (task) => ["done", "closed", "superseded"].includes(task.status);
const separator = process.platform === "win32" ? "\\" : "/";
const phaseGate = (phase) => phase === "clarify" ? "G0_confirm" : phase === "plan" ? "G1_review" : phase === "build" ? "G2_codereview" : "none";
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const text = (value) => typeof value === "string" && Boolean(value.trim());
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const digest = (content) => createHash("sha256").update(content).digest("hex");
const archiveRecordPath = (id) => `.agents/data/state/archive/${id}.json`;
const taskRecordContent = (task) => `${JSON.stringify(task, null, 2)}\n`;
const assertNoSymlinkPath = (root, relative) => { let cursor = resolve(root); for (const part of normalize(relative).split(/[\\/]/).filter(Boolean)) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`State path crosses a symlink: ${relative}`); } };

const writeAtomic = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
};

const sleep = (milliseconds) => { if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); };
const lockRecord = (path) => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value.token === "string" && Number.isInteger(value.pid) && value.pid > 0 && Number.isFinite(value.createdAt) ? value : undefined;
  } catch { return undefined; }
};
const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
};
const tryCreateLock = (path, record) => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const descriptor = openSync(path, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8"); }
    finally { closeSync(descriptor); }
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
};
const removeOwnedLock = (path, token) => { if (lockRecord(path)?.token === token) unlinkSync(path); };
const lockExpired = (record, now, staleMs) => Boolean(record && now - record.createdAt >= staleMs && !processAlive(record.pid));

const validateLesson = (taskId, lesson) => {
  if (!lesson || !idPattern.test(lesson.id) || lesson.taskId !== taskId || !Array.isArray(lesson.areas) || !lesson.areas.length || lesson.areas.some((area) => !text(area)) || !text(lesson.summary) || !text(lesson.prevention) || !text(lesson.example) || !text(lesson.promotion) || !text(lesson.source) || !iso(lesson.recordedAt)) throw new Error(`Invalid lesson: ${taskId}`);
};

const validateTask = (id, task) => {
  if (!idPattern.test(id)) throw new Error(`Invalid task id: ${id}`);
  if (!task || task.id !== id || !phases.includes(task.phase) || !gates.includes(task.gate) || task.gate !== phaseGate(task.phase)) throw new Error(`Invalid task state: ${id}`);
  if (!Array.isArray(task.decisions) || !Array.isArray(task.tasks) || !Array.isArray(task.evidence) || (task.lessons !== undefined && !Array.isArray(task.lessons))) throw new Error(`Invalid task collections: ${id}`);
  if (!task.title || !["feature", "bug", "refactor", "infra"].includes(task.type) || !statuses.includes(task.status) || (task.phase === "done") !== (task.status === "done")) throw new Error(`Invalid task fields: ${id}`);
  if (!["vi", "en"].includes(task.language) || !["low", "normal", "high", "regulated"].includes(task.risk) || !Array.isArray(task.areas) || !task.areas.length || task.areas.some((area) => !text(area))) throw new Error(`Invalid task language, risk, or areas: ${id}`);
  if (task.decisions.some((item) => !item.id || !item.label || !["unresolved", "approved", "changed", "dropped"].includes(item.status) || (item.status === "changed" && !item.resolution))) throw new Error(`Invalid decisions: ${id}`);
  if (task.featureId !== undefined && !idPattern.test(task.featureId)) throw new Error(`Invalid feature id: ${id}`);
  if (task.tasks.some((item) => !item.id || !item.label || !["todo", "in_progress", "done", "deferred"].includes(item.status))) throw new Error(`Invalid execution tasks: ${id}`);
  readyTaskItems(task);
  if (task.evidence.some((item) => !["approval", "spec", "test", "lint", "review", "diagnostic"].includes(item.kind) || !["pass", "fail", "skip"].includes(item.result) || !item.source || !iso(item.recordedAt) || (item.area !== undefined && !text(item.area)) || (item.gate !== undefined && !gates.includes(item.gate)) || (item.kind === "approval" && (!item.gate || item.gate === "none")))) throw new Error(`Invalid evidence: ${id}`);
  const lessonIds = new Set();
  for (const lesson of task.lessons ?? []) { validateLesson(id, lesson); if (lessonIds.has(lesson.id)) throw new Error(`Duplicate lesson id: ${id}/${lesson.id}`); lessonIds.add(lesson.id); }
  if (task.lessonDisposition && (!["captured", "none"].includes(task.lessonDisposition.status) || !text(task.lessonDisposition.source) || !iso(task.lessonDisposition.recordedAt) || (task.lessonDisposition.status === "captured" && !(task.lessons?.length)) || (task.lessonDisposition.status === "none" && (Boolean(task.lessons?.length) || !text(task.lessonDisposition.reason))))) throw new Error(`Invalid lesson disposition: ${id}`);
  if (task.handoff && (!handoffKinds.includes(task.handoff.kind) || !text(task.handoff.reason) || !text(task.handoff.source) || !iso(task.handoff.recordedAt) || task.status !== "paused")) throw new Error(`Invalid task handoff: ${id}`);
  if (task.legacyG2Wait !== undefined && (typeof task.legacyG2Wait !== "object" || Array.isArray(task.legacyG2Wait) || !iso(task.legacyG2Wait.migratedAt) || !text(task.legacyG2Wait.source) || task.phase !== "build" || task.gate !== "G2_codereview" || task.status !== "blocked_on_user")) throw new Error(`Invalid legacy G2 wait marker: ${id}`);
  if ((["closed", "superseded"].includes(task.status)) !== Boolean(task.closure)) throw new Error(`Invalid task closure: ${id}`);
  if (task.closure && (!text(task.closure.reason) || !text(task.closure.source) || !iso(task.closure.recordedAt))) throw new Error(`Invalid task closure: ${id}`);
  if ((task.status === "superseded") !== Boolean(task.successorTaskId) || (task.status === "closed" && task.successorTaskId)) throw new Error(`Invalid task successor: ${id}`);
  if (task.predecessorTaskId !== undefined && !text(task.predecessorTaskId)) throw new Error(`Invalid task predecessor: ${id}`);
  for (const path of Object.values(task.artifacts ?? {})) if (path) {
    const cleaned = normalize(path);
    if (isAbsolute(cleaned) || cleaned === ".." || cleaned.startsWith(`..${separator}`) || !cleaned.startsWith(`.agents${separator}data${separator}tasks${separator}`)) throw new Error(`Invalid artifact path for ${id}: ${path}`);
  }
};

const validateArchiveSummary = (id, item) => {
  if (!idPattern.test(id) || !item || item.id !== id || !text(item.title) || !["feature", "bug", "refactor", "infra"].includes(item.type) || !phases.includes(item.phase) || !gates.includes(item.gate) || item.gate !== phaseGate(item.phase) || !["done", "closed", "superseded"].includes(item.status) || !["low", "normal", "high", "regulated"].includes(item.risk) || !Array.isArray(item.areas) || !item.areas.length || item.areas.some((area) => !text(area)) || item.record !== archiveRecordPath(id) || !/^[a-f0-9]{64}$/.test(item.digest) || !Number.isInteger(item.lessonCount) || item.lessonCount < 0 || !iso(item.createdAt) || !iso(item.updatedAt)) throw new Error(`Invalid archived task summary: ${id}`);
  if ((item.status === "superseded") !== Boolean(item.successorTaskId) || (item.status === "closed" && item.successorTaskId) || (item.predecessorTaskId !== undefined && !text(item.predecessorTaskId))) throw new Error(`Invalid archived task links: ${id}`);
};

export const validateState = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow state must be an object");
  if (![1, 2, 3, 4].includes(Number(value.schemaVersion)) || !value.tasks || typeof value.tasks !== "object" || Array.isArray(value.tasks)) throw new Error("Unsupported workflow state schema");
  if (Number(value.schemaVersion) >= 3 && (!value.archive || typeof value.archive !== "object" || Array.isArray(value.archive))) throw new Error("Schema v3+ requires an archive catalog");
  if (Number(value.schemaVersion) < 3 && value.archive !== undefined) throw new Error("Legacy workflow state cannot contain an archive catalog");
  if (Number(value.schemaVersion) < 4 && Object.values(value.tasks).some((task) => task?.legacyG2Wait !== undefined)) throw new Error("Legacy G2 wait markers require schema v4");
  for (const [id, task] of Object.entries(value.tasks)) validateTask(id, task);
  for (const [id, item] of Object.entries(value.archive ?? {})) { if (value.tasks[id]) throw new Error(`Task exists in active and archive state: ${id}`); validateArchiveSummary(id, item); }
  const references = { ...(value.archive ?? {}), ...value.tasks };
  for (const [id, item] of Object.entries(references)) {
    if (item.successorTaskId) { const successor = references[item.successorTaskId]; if (!successor || successor.id === id || successor.predecessorTaskId !== id) throw new Error(`Invalid successor link: ${id}`); }
    if (item.predecessorTaskId) { const predecessor = references[item.predecessorTaskId]; if (!predecessor || predecessor.id === id || predecessor.status !== "superseded" || predecessor.successorTaskId !== id) throw new Error(`Invalid predecessor link: ${id}`); }
    const seen = new Set([id]); let cursor = item;
    while (cursor.successorTaskId) { if (seen.has(cursor.successorTaskId)) throw new Error(`Cyclic successor link: ${id}`); seen.add(cursor.successorTaskId); cursor = references[cursor.successorTaskId]; }
  }
  return value;
};

const archivedSummary = (task, content = taskRecordContent(task)) => ({ id: task.id, title: task.title, type: task.type, phase: task.phase, gate: task.gate, status: task.status, risk: task.risk, areas: task.areas, record: archiveRecordPath(task.id), digest: digest(content), lessonCount: task.lessons?.length ?? 0, predecessorTaskId: task.predecessorTaskId, successorTaskId: task.successorTaskId, createdAt: task.createdAt, updatedAt: task.updatedAt });

export const statePath = (root) => join(resolve(root), ".agents/data/state/aidlc-state.json");
export const lessonIndexPath = (root) => join(resolve(root), ".agents/data/lessons/index.json");
export const memoryRegistryPath = (root) => join(resolve(root), ".agents/data/memory/agentic-memory.json");
export const stateLockPath = (root) => join(resolve(root), ".agents/data/state/.aidlc-state.lock");
const stateLockGuardPath = (root) => join(resolve(root), ".agents/data/state/.aidlc-state.lock.guard");
export const emptyState = () => ({ schemaVersion: 4, tasks: {}, archive: {} });
export const legacyG2WaitSource = "schema-v4-migration";
export const emptyMemoryRegistry = () => ({ schemaVersion: 1, entries: [], retired: [] });

export const acquireStateLock = (root, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryMs = options.retryMs ?? 25;
  const staleMs = options.staleMs ?? 30_000;
  const lockPath = stateLockPath(root); const guardPath = stateLockGuardPath(root); const token = randomUUID(); const deadline = Date.now() + timeoutMs;
  assertNoSymlinkPath(root, ".agents/data/state/.aidlc-state.lock"); assertNoSymlinkPath(root, ".agents/data/state/.aidlc-state.lock.guard");
  const acquireGuard = () => {
    const guardToken = randomUUID(); const now = Date.now(); const existing = lockRecord(guardPath);
    if (lockExpired(existing, now, staleMs)) removeOwnedLock(guardPath, existing.token);
    return tryCreateLock(guardPath, { token: guardToken, pid: process.pid, createdAt: now }) ? guardToken : undefined;
  };
  while (Date.now() <= deadline) {
    const guardToken = acquireGuard();
    if (!guardToken) { sleep(retryMs); continue; }
    try {
      const now = Date.now(); const existing = lockRecord(lockPath);
      if (lockExpired(existing, now, staleMs)) removeOwnedLock(lockPath, existing.token);
      if (tryCreateLock(lockPath, { token, pid: process.pid, createdAt: now })) return () => {
        const existing = lockRecord(lockPath);
        if (!existing) {
          if (existsSync(lockPath)) throw new Error("Cannot release AI-DLC state lock because its owner record is unreadable");
          return;
        }
        if (existing.token !== token) return;
        try { unlinkSync(lockPath); }
        catch (error) { throw new Error(`Failed to release owned AI-DLC state lock: ${error instanceof Error ? error.message : String(error)}`); }
      };
    } finally { removeOwnedLock(guardPath, guardToken); }
    sleep(retryMs);
  }
  throw new Error(`Timed out waiting for AI-DLC state lock after ${timeoutMs}ms`);
};
const memoryPhases = ["clarify", "plan", "build", "wrap", "*"];
const validateMemoryEntry = (entry) => {
  if (!entry || !idPattern.test(entry.id) || !text(entry.summary) || !text(entry.guidance) || !Array.isArray(entry.areas) || !entry.areas.length || entry.areas.some((area) => !text(area)) || !Array.isArray(entry.phases) || !entry.phases.length || entry.phases.some((phase) => !memoryPhases.includes(phase)) || !Number.isInteger(entry.priority) || entry.priority < 0 || entry.priority > 100 || !idPattern.test(entry.sourceTaskId) || !idPattern.test(entry.sourceLessonId) || !text(entry.approvedBy) || !iso(entry.approvedAt)) throw new Error(`Invalid agentic memory entry: ${entry?.id ?? "unknown"}`);
};
export const validateMemoryRegistry = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.retired)) throw new Error("Unsupported agentic memory registry schema");
  const ids = new Set();
  for (const entry of value.entries) { validateMemoryEntry(entry); if (ids.has(entry.id)) throw new Error(`Duplicate agentic memory entry: ${entry.id}`); ids.add(entry.id); }
  for (const entry of value.retired) { validateMemoryEntry(entry); if (!text(entry.retiredBy) || !text(entry.reason) || !iso(entry.retiredAt) || ids.has(entry.id)) throw new Error(`Invalid retired agentic memory entry: ${entry.id}`); ids.add(entry.id); }
  return value;
};
export const loadMemoryRegistry = (root) => { assertNoSymlinkPath(root, ".agents/data/memory/agentic-memory.json"); const path = memoryRegistryPath(root); return existsSync(path) ? validateMemoryRegistry(parseJsonFile(path, "Agentic memory registry")) : emptyMemoryRegistry(); };
export const saveMemoryRegistry = (root, registry) => { const normalized = validateMemoryRegistry(registry); assertNoSymlinkPath(root, ".agents/data/memory/agentic-memory.json"); writeAtomic(memoryRegistryPath(root), `${JSON.stringify(normalized, null, 2)}\n`); };
export const selectAgenticMemory = (registry, areas, phase, maxChars) => {
  const scoped = new Set(areas.map((area) => area.toLocaleLowerCase())); let used = 0;
  return registry.entries.filter((entry) => entry.phases.includes("*") || entry.phases.includes(phase)).filter((entry) => entry.areas.includes("*") || entry.areas.some((area) => scoped.has(area.toLocaleLowerCase()))).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)).filter((entry) => { const size = `- ${entry.id} — ${entry.summary} — guidance: ${entry.guidance} — source: ${entry.sourceTaskId}/${entry.sourceLessonId}\n`.length; if (used + size > maxChars) return false; used += size; return true; });
};
export const promoteAgenticMemory = (root, entry) => {
  validateMemoryEntry(entry); const source = loadTask(root, entry.sourceTaskId, loadState(root));
  if (!source?.lessons?.some((lesson) => lesson.id === entry.sourceLessonId)) throw new Error(`Agentic memory source lesson is missing: ${entry.sourceTaskId}/${entry.sourceLessonId}`);
  const registry = loadMemoryRegistry(root); const current = registry.entries.find((item) => item.id === entry.id);
  if (current) { if (JSON.stringify(current) === JSON.stringify(entry)) return current; throw new Error(`Agentic memory entry already exists with different content: ${entry.id}`); }
  if (registry.retired.some((item) => item.id === entry.id)) throw new Error(`Retired agentic memory id cannot be reused: ${entry.id}`);
  registry.entries.push(entry); registry.entries.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)); saveMemoryRegistry(root, registry); return entry;
};
export const retireAgenticMemory = (root, id, reason, retiredBy, retiredAt = new Date().toISOString()) => {
  if (!text(reason) || !text(retiredBy) || !iso(retiredAt)) throw new Error("Retiring agentic memory requires a reason, approver, and valid timestamp");
  const registry = loadMemoryRegistry(root); const index = registry.entries.findIndex((entry) => entry.id === id); if (index < 0) throw new Error(`Unknown active agentic memory entry: ${id}`);
  const [entry] = registry.entries.splice(index, 1); registry.retired.push({ ...entry, retiredBy, retiredAt, reason }); registry.retired.sort((left, right) => right.retiredAt.localeCompare(left.retiredAt) || left.id.localeCompare(right.id)); saveMemoryRegistry(root, registry); return entry;
};
const parseJsonText = (content, label, recovery = "") => { try { return JSON.parse(content); } catch (error) { throw new Error(`${label} is corrupted or unreadable: ${error instanceof Error ? error.message : String(error)}${recovery ? `; ${recovery}` : ""}`); } };
const parseJsonFile = (path, label, recovery = "") => parseJsonText(readFileSync(path, "utf8"), label, recovery);
export const loadState = (root) => { assertNoSymlinkPath(root, ".agents/data/state/aidlc-state.json"); return existsSync(statePath(root)) ? validateState(parseJsonFile(statePath(root), "AI-DLC state file", "restore it from git history or the archive records")) : emptyState(); };

export const loadTask = (root, id, state = loadState(root)) => {
  if (state.tasks[id]) return state.tasks[id];
  const summary = state.archive?.[id];
  if (!summary) return undefined;
  const path = join(resolve(root), summary.record);
  assertNoSymlinkPath(root, summary.record);
  if (!existsSync(path)) throw new Error(`Archived task record is missing: ${summary.record}`);
  const content = readFileSync(path, "utf8");
  if (digest(content) !== summary.digest) throw new Error(`Archived task digest mismatch: ${id}`);
  const task = parseJsonText(content, `Archived task record ${id}`);
  validateTask(id, task);
  if (!terminal(task) || task.status !== summary.status || task.updatedAt !== summary.updatedAt || (task.lessons?.length ?? 0) !== summary.lessonCount) throw new Error(`Archived task summary mismatch: ${id}`);
  return task;
};

export const saveState = (root, state) => {
  const normalized = validateState(structuredClone(state));
  const persisted = existsSync(statePath(root)) ? loadState(root) : undefined;
  const archived = [];
  if (normalized.schemaVersion >= 3) {
    normalized.archive ??= {};
    for (const task of Object.values(normalized.tasks)) if (terminal(task)) {
      const content = taskRecordContent(task); const summary = archivedSummary(task, content); const path = join(resolve(root), summary.record);
      assertNoSymlinkPath(root, summary.record);
      if (existsSync(path)) {
        const current = readFileSync(path, "utf8");
        if (digest(current) !== summary.digest) {
          let orphan;
          try { orphan = JSON.parse(current); validateTask(task.id, orphan); }
          catch { throw new Error(`Archived task record conflicts: ${task.id}`); }
          const authority = persisted?.tasks[task.id];
          if (persisted?.archive?.[task.id] || !authority || authority.createdAt !== task.createdAt || !terminal(orphan) || orphan.id !== task.id || orphan.createdAt !== task.createdAt) throw new Error(`Archived task record conflicts: ${task.id}`);
          writeAtomic(path, content);
        }
      } else writeAtomic(path, content);
      normalized.archive[task.id] = summary; delete normalized.tasks[task.id]; archived.push(task.id);
    }
    validateState(normalized);
  }
  assertNoSymlinkPath(root, ".agents/data/state/aidlc-state.json"); writeAtomic(statePath(root), `${JSON.stringify(normalized, null, 2)}\n`);
  state.tasks = normalized.tasks; state.archive = normalized.archive; state.schemaVersion = normalized.schemaVersion;
  return archived;
};

export const stampLegacyG2Waits = (state) => {
  const stamped = [];
  for (const task of Object.values(state.tasks)) {
    if (task.legacyG2Wait !== undefined) continue;
    if (task.phase !== "build" || task.gate !== "G2_codereview" || task.status !== "blocked_on_user") continue;
    if (!task.tasks.every((item) => ["done", "deferred"].includes(item.status)) || !hasVerification(task) || !hasReview(task)) continue;
    task.legacyG2Wait = { migratedAt: task.updatedAt, source: legacyG2WaitSource };
    stamped.push(task.id);
  }
  return stamped;
};

export const migrateState = (root, state = loadState(root)) => {
  if (state.schemaVersion === 4) return { migrated: false, archived: [], stamped: [] };
  const next = { schemaVersion: 4, tasks: {}, archive: {} }; const records = [];
  for (const task of Object.values(state.tasks)) {
    if (!terminal(task)) next.tasks[task.id] = task;
    else { const content = taskRecordContent(task); const summary = archivedSummary(task, content); next.archive[task.id] = summary; records.push({ path: summary.record, content }); }
  }
  for (const item of Object.values(state.archive ?? {})) next.archive[item.id] = item;
  const stamped = stampLegacyG2Waits(next);
  validateState(next);
  for (const record of records) { assertNoSymlinkPath(root, record.path); const path = join(resolve(root), record.path); if (existsSync(path)) { if (readFileSync(path, "utf8") !== record.content) throw new Error(`Archived task record conflicts: ${record.path}`); } else writeAtomic(path, record.content); }
  saveState(root, next); rebuildLessonIndex(root, next); return { migrated: true, archived: Object.keys(next.archive), stamped };
};

export const latestApproval = (task, gate) => { for (let index = task.evidence.length - 1; index >= 0; index -= 1) { const item = task.evidence[index]; if (item.kind === "approval" && item.gate === gate) return item; } return undefined; };
export const buildBoundary = (task) => { let boundary; for (let index = 0; index < task.evidence.length; index += 1) { const item = task.evidence[index]; if (item.kind === "approval" && item.gate === "G1_review" && item.result === "pass") boundary = index; } return boundary; };
export const hasApproval = (task, gate) => latestApproval(task, gate)?.result === "pass";
const currentBuildEvidence = (task) => { const boundary = buildBoundary(task); return boundary === undefined ? [] : task.evidence.slice(boundary + 1); };
const latestInOrder = (items, predicate) => { for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index])) return items[index]; return undefined; };
export const hasCurrentBuildApproval = (task, gate) => latestInOrder(currentBuildEvidence(task), (item) => item.kind === "approval" && item.gate === gate)?.result === "pass";
export const hasAreaVerification = (task, area) => { const evidence = currentBuildEvidence(task).filter((item) => ["test", "lint"].includes(item.kind) && (item.area === area || (!item.area && task.areas.length === 1))); const kinds = [...new Set(evidence.map((item) => item.kind))]; return kinds.length > 0 && kinds.every((kind) => latestInOrder(evidence, (item) => item.kind === kind)?.result === "pass"); };
export const hasVerification = (task) => task.areas.every((area) => hasAreaVerification(task, area));
export const hasReview = (task) => latestInOrder(currentBuildEvidence(task), (item) => item.kind === "review")?.result === "pass";
export const repairBounds = (task) => { const evidence = currentBuildEvidence(task); const verifyFailures = {}; for (const item of evidence) if (["test", "lint"].includes(item.kind) && item.result === "fail") { const area = item.area ?? (task.areas.length === 1 ? task.areas[0] : "unscoped"); verifyFailures[area] = (verifyFailures[area] ?? 0) + 1; } const reviewFailures = evidence.filter((item) => item.kind === "review" && item.result === "fail").length; const exhaustedAreas = Object.keys(verifyFailures).filter((area) => verifyFailures[area] >= 3).sort(); return { verifyFailures, reviewFailures, exhaustedAreas, verifyExhausted: exhaustedAreas.length > 0, reviewExhausted: reviewFailures >= 2 }; };
export const isLegacyG2Wait = (task) => task.legacyG2Wait !== undefined && task.phase === "build" && task.gate === "G2_codereview" && task.status === "blocked_on_user" && task.tasks.every((item) => ["done", "deferred"].includes(item.status)) && hasVerification(task) && hasReview(task);

export const transitionDiagnostics = (task, target) => {
  const diagnostics = []; const expected = phases.indexOf(task.phase) + 1;
  if (target === task.phase || phases.indexOf(target) !== expected) diagnostics.push({ level: "ERROR", code: "STATE_TRANSITION", message: `Cannot transition ${task.phase} → ${target}` });
  if (target === "plan" && !hasApproval(task, "G0_confirm")) diagnostics.push({ level: "ERROR", code: "G0_APPROVAL", message: "G0 approval evidence is required" });
  if (target === "build") { if (!hasApproval(task, "G1_review")) diagnostics.push({ level: "ERROR", code: "G1_APPROVAL", message: "G1 approval evidence is required" }); for (const decision of task.decisions) if (decision.status === "unresolved") diagnostics.push({ level: "ERROR", code: "UNRESOLVED_DECISION", message: `Decision ${decision.id} is unresolved` }); }
  if (target === "wrap") { if (!hasVerification(task)) diagnostics.push({ level: "ERROR", code: "VERIFY_EVIDENCE", message: "Latest current-build verification evidence must pass for every affected area" }); if (!hasReview(task)) diagnostics.push({ level: "ERROR", code: "REVIEW_EVIDENCE", message: "Latest current-build code-review evidence must pass" }); if (!hasCurrentBuildApproval(task, "G2_codereview")) diagnostics.push({ level: "ERROR", code: "G2_APPROVAL", message: "Current-build G2 approval evidence is required" }); }
  if (target === "done" && !task.lessonDisposition) diagnostics.push({ level: "ERROR", code: "LESSON_DISPOSITION", message: "Wrap must record lessons or an explicit no-lesson disposition" });
  return diagnostics;
};

export const transitionTask = (state, id, target) => {
  const task = state.tasks[id]; if (!task) throw new Error(`Unknown active task: ${id}`); if (terminal(task)) throw new Error(`Terminal task cannot transition: ${id}`);
  const errors = transitionDiagnostics(task, target).filter((item) => item.level === "ERROR"); if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
  task.phase = target; task.gate = phaseGate(target); task.status = target === "done" ? "done" : "active"; delete task.legacyG2Wait; task.updatedAt = new Date().toISOString(); return task;
};

export const readyTaskItems = (task) => {
  const byId = new Map(task.tasks.map((item) => [item.id, item]));
  if (byId.size !== task.tasks.length) throw new Error(`Duplicate execution item: ${task.id}`);
  const visiting = new Set(); const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`Cyclic execution dependency: ${task.id}/${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id || !byId.has(dep)) throw new Error(`Unknown execution dependency: ${task.id}/${id}/${dep}`);
      visit(dep);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const item of task.tasks) {
    if (item.dependsOn !== undefined && (!Array.isArray(item.dependsOn) || new Set(item.dependsOn).size !== item.dependsOn.length || item.dependsOn.some((dep) => typeof dep !== "string" || !dep))) throw new Error(`Invalid execution dependencies: ${task.id}/${item.id}`);
    if (item.ownedPaths !== undefined && (!Array.isArray(item.ownedPaths) || new Set(item.ownedPaths).size !== item.ownedPaths.length || item.ownedPaths.some((path) => typeof path !== "string" || !path || isAbsolute(path) || path === ".." || path.startsWith("../") || path.includes("\\") || path.split("/").includes("..")))) throw new Error(`Invalid owned paths: ${task.id}/${item.id}`);
    visit(item.id);
  }
  const ready = []; const blocked = [];
  for (const item of task.tasks) {
    const waitingOn = (item.dependsOn ?? []).filter((dep) => byId.get(dep)?.status !== "done");
    if (item.status === "done" && waitingOn.length) throw new Error(`Completed item has incomplete prerequisites: ${task.id}/${item.id}`);
    if (item.status !== "todo" && item.status !== "in_progress") continue;
    if (waitingOn.length) blocked.push({ id: item.id, waitingOn }); else ready.push(item.id);
  }
  return { ready, blocked };
};

export const nextAction = (task, root) => {
  const rootSuffix = root === undefined ? "" : ` --root ${JSON.stringify(resolve(root))}`;
  const script = (name) => root === undefined ? `node .agents/aidlc/scripts/${name}` : `node ${JSON.stringify(join(resolve(root), ".agents/aidlc/scripts", name))}`;
  const stateCommand = script("state.mjs"); const contextCommand = script("context.mjs");
  if (task.phase === "done") return { classification: "complete", phase: task.phase, gate: task.gate, reason: "Task is complete" };
  if (["closed", "superseded"].includes(task.status)) return { classification: "terminal", phase: task.phase, gate: task.gate, outcome: task.status, successorTaskId: task.successorTaskId, reason: task.closure?.reason ?? "Task ended without successful completion" };
  if (task.handoff) return { classification: "blocked", phase: task.phase, gate: task.gate, reason: task.handoff.reason, actions: [...(task.phase === "build" ? [{ id: "reopen_g1", command: `${stateCommand} task reopen ${task.id} --to plan --reason <reason> --source <explicit-user-request>${rootSuffix}` }] : []), { id: "create_successor", command: `${stateCommand} task create <new-task-id> --title <title>${rootSuffix}` }, { id: "supersede", command: `${stateCommand} task supersede ${task.id} --successor <new-task-id> --reason <reason> --source <explicit-user-request>${rootSuffix}` }, { id: "close", command: `${stateCommand} task close ${task.id} --reason <reason> --source <explicit-user-request>${rootSuffix}` }] };
  if (task.status === "paused") return { classification: "blocked", phase: task.phase, gate: task.gate, reason: "Task is paused", actions: [{ id: "resume", command: `${stateCommand} task status ${task.id} --status active${rootSuffix}` }, { id: "record_handoff", command: `${stateCommand} task handoff ${task.id} --kind <kind> --reason <reason> --source <source>${rootSuffix}` }] };
  if (task.phase === "build" && !isLegacyG2Wait(task)) { const bounds = repairBounds(task); if (bounds.verifyExhausted || bounds.reviewExhausted) { const kind = bounds.reviewExhausted ? "review_exhausted" : "repair_exhausted"; return { classification: "blocked", phase: task.phase, gate: task.gate, reason: `Repair bound exhausted (${bounds.verifyExhausted ? `3+ failed verify cycles in: ${bounds.exhaustedAreas.join(", ")}` : `${bounds.reviewFailures} failed review passes`}); record a durable handoff`, actions: [{ id: "record_handoff", command: `${stateCommand} task handoff ${task.id} --kind ${kind} --reason <summary-of-exhausted-repairs> --source <agent>${rootSuffix}` }] }; } }
  if (task.status === "blocked_on_user" && task.gate === "G1_review" && task.decisions.some((decision) => decision.status === "unresolved")) return { classification: "run_phase", phase: task.phase, gate: task.gate, command: `${contextCommand} ${task.id} --phase plan${rootSuffix}`, reason: "Invalid premature G1 wait; resolve every decision before presenting G1" };
  if (task.status === "blocked_on_user" && task.gate === "G2_codereview" && (task.tasks.some((item) => !["done", "deferred"].includes(item.status)) || !hasVerification(task) || !hasReview(task))) {
    const open = task.tasks.filter((item) => item.status === "in_progress" || item.status === "todo");
    const ready = new Set(readyTaskItems(task).ready);
    const item = open.find((entry) => entry.status === "in_progress" && ready.has(entry.id)) ?? open.find((entry) => ready.has(entry.id));
    if (item) return { classification: "run_phase", phase: task.phase, gate: task.gate, itemId: item.id, remainingItems: open.length, command: `${contextCommand} ${task.id} --phase build --item ${item.id}${rootSuffix}`, reason: `Invalid premature G2 wait; continue build item ${item.id}` };
    if (open.length) return { classification: "blocked", phase: task.phase, gate: task.gate, reason: `No dependency-ready build item: ${readyTaskItems(task).blocked.map((entry) => `${entry.id} waits for ${entry.waitingOn.join(",")}`).join("; ")}` };
    return { classification: "run_phase", phase: task.phase, gate: task.gate, remainingItems: 0, command: `${contextCommand} ${task.id} --phase build${rootSuffix}`, reason: "Invalid premature G2 wait; continue verification and adversarial review before presenting G2" };
  }
  if (task.status === "blocked_on_user" && task.gate === "none") return { classification: "run_phase", phase: task.phase, gate: task.gate, command: `${stateCommand} task status ${task.id} --status active${rootSuffix}`, reason: "Recover invalid wait at a gateless wrap phase before continuing wrap" };
  if (task.status === "blocked_on_user") return { classification: "await_user", phase: task.phase, gate: task.gate, command: `${stateCommand} gate approve ${task.id} --gate ${task.gate} --source <explicit-user-approval>${rootSuffix}`, reason: `Explicit human approval is required at ${task.gate}` };
  if (task.phase === "build") {
    const open = task.tasks.filter((item) => item.status === "in_progress" || item.status === "todo");
    const ready = new Set(readyTaskItems(task).ready);
    const item = open.find((entry) => entry.status === "in_progress" && ready.has(entry.id)) ?? open.find((entry) => ready.has(entry.id));
    if (item) return { classification: "run_phase", phase: task.phase, gate: task.gate, itemId: item.id, remainingItems: open.length, command: `${contextCommand} ${task.id} --phase build --item ${item.id}${rootSuffix}`, reason: `Continue build item ${item.id}; ${open.length} actionable item(s) remain before verification, review, and G2` };
    if (open.length) return { classification: "blocked", phase: task.phase, gate: task.gate, reason: `No dependency-ready build item: ${readyTaskItems(task).blocked.map((entry) => `${entry.id} waits for ${entry.waitingOn.join(",")}`).join("; ")}` };
    return { classification: "run_phase", phase: task.phase, gate: task.gate, remainingItems: 0, command: `${contextCommand} ${task.id} --phase build${rootSuffix}`, reason: "All build items are terminal; continue verification, adversarial review, and G2 preparation" };
  }
  return { classification: "run_phase", phase: task.phase, gate: task.gate, command: `${contextCommand} ${task.id} --phase ${task.phase}${rootSuffix}`, reason: `Continue ${task.phase} until the next human gate, real blocker, or completion` };
};

const audited = (reason, source) => { if (!text(reason) || !text(source)) throw new Error("Lifecycle mutation requires non-empty --reason and --source"); };
export const handoffTask = (state, id, kind, reason, source, recordedAt = new Date().toISOString()) => { const task = state.tasks[id]; if (!task || terminal(task) || !handoffKinds.includes(kind)) throw new Error(`Task cannot enter handoff: ${id}`); audited(reason, source); if (task.handoff) { if (task.handoff.kind === kind && task.handoff.reason === reason && task.handoff.source === source) return task; throw new Error(`Task already has a different handoff: ${id}`); } task.status = "paused"; task.handoff = { kind, reason, source, recordedAt }; delete task.legacyG2Wait; task.updatedAt = recordedAt; return task; };
export const closeTask = (state, id, reason, source, recordedAt = new Date().toISOString()) => { const task = state.tasks[id]; if (!task || task.status === "done" || task.status === "superseded") throw new Error(`Task cannot be closed: ${id}`); audited(reason, source); if (task.status === "closed") { if (task.closure?.reason === reason && task.closure.source === source) return task; throw new Error(`Task is already closed with different metadata: ${id}`); } task.status = "closed"; task.closure = { reason, source, recordedAt }; delete task.handoff; delete task.successorTaskId; delete task.legacyG2Wait; task.updatedAt = recordedAt; return task; };
export const supersedeTask = (state, id, successorId, reason, source, recordedAt = new Date().toISOString()) => { const task = state.tasks[id]; const successor = state.tasks[successorId]; audited(reason, source); if (!task || task.status === "done" || task.status === "closed" || !successor || id === successorId) throw new Error(`Task cannot be superseded: ${id}`); if (task.status === "superseded") { if (task.successorTaskId === successorId && task.closure?.reason === reason && task.closure.source === source) return task; throw new Error(`Task is already superseded with different metadata: ${id}`); } if (successor.phase !== "clarify" || successor.gate !== "G0_confirm" || terminal(successor) || hasApproval(successor, "G0_confirm") || (successor.predecessorTaskId && successor.predecessorTaskId !== id)) throw new Error(`Successor must be a fresh pre-G0 task: ${successorId}`); task.status = "superseded"; task.closure = { reason, source, recordedAt }; task.successorTaskId = successorId; delete task.handoff; delete task.legacyG2Wait; task.updatedAt = recordedAt; successor.predecessorTaskId = id; successor.updatedAt = recordedAt; validateState(state); return task; };
export const reopenTask = (state, id, target, reason, source, recordedAt = new Date().toISOString()) => { const task = state.tasks[id]; audited(reason, source); if (!task || target !== "plan" || task.phase !== "build" || task.status !== "paused" || !task.handoff) throw new Error(`Task cannot reopen G1: ${id}`); task.evidence.push({ kind: "approval", gate: "G1_review", result: "fail", source, detail: `Reopened G1: ${reason}`, recordedAt }); for (const item of task.tasks) if (item.status !== "deferred") item.status = "todo"; task.phase = "plan"; task.gate = "G1_review"; task.status = "active"; delete task.handoff; task.updatedAt = recordedAt; return task; };

export const recordLesson = (task, lesson, recordedAt = new Date().toISOString()) => { if (task.phase !== "wrap" || task.status !== "active") throw new Error(`Lessons can only be recorded during active wrap: ${task.id}`); const current = task.lessons?.find((item) => item.id === lesson.id); const next = { ...lesson, taskId: task.id, recordedAt }; validateLesson(task.id, next); if (current) { const strip = (item) => { const { recordedAt, ...rest } = item; return rest; }; if (JSON.stringify(strip(current)) === JSON.stringify(strip(next))) return current; throw new Error(`Lesson already exists with different content: ${task.id}/${lesson.id}`); } task.lessons ??= []; task.lessons.push(next); task.lessonDisposition = { status: "captured", source: lesson.source, recordedAt }; task.updatedAt = recordedAt; return next; };
export const recordNoLessons = (task, reason, source, recordedAt = new Date().toISOString()) => { if (task.phase !== "wrap" || task.status !== "active") throw new Error(`Lesson disposition can only be recorded during active wrap: ${task.id}`); audited(reason, source); if (task.lessons?.length) throw new Error(`Task already has captured lessons: ${task.id}`); task.lessonDisposition = { status: "none", reason, source, recordedAt }; task.updatedAt = recordedAt; };

const lessonEntry = (lesson) => ({ id: lesson.id, taskId: lesson.taskId, areas: lesson.areas, summary: lesson.summary, prevention: lesson.prevention, source: lesson.source, recordedAt: lesson.recordedAt });
export const lessonStateDigest = (state) => digest(JSON.stringify({ active: Object.values(state.tasks).flatMap((task) => task.lessons ?? []).sort((a, b) => `${a.taskId}:${a.id}`.localeCompare(`${b.taskId}:${b.id}`)), archive: Object.values(state.archive ?? {}).map((item) => ({ id: item.id, digest: item.digest, lessonCount: item.lessonCount })).sort((a, b) => a.id.localeCompare(b.id)) }));
export const createLessonIndex = (lessons, sourceDigest) => ({ schemaVersion: 1, sourceDigest: sourceDigest ?? digest(JSON.stringify(lessons)), lessons: lessons.map(lessonEntry).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.taskId.localeCompare(b.taskId) || a.id.localeCompare(b.id)) });
const allLessons = (root, state) => [...Object.values(state.tasks).flatMap((task) => task.lessons ?? []), ...Object.keys(state.archive ?? {}).flatMap((id) => loadTask(root, id, state)?.lessons ?? [])];
export const rebuildLessonIndex = (root, state = loadState(root)) => { const index = createLessonIndex(allLessons(root, state), lessonStateDigest(state)); assertNoSymlinkPath(root, ".agents/data/lessons/index.json"); writeAtomic(lessonIndexPath(root), `${JSON.stringify(index, null, 2)}\n`); return index; };
const tokens = (value) => [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((item) => item.length > 1))];
export const searchLessons = (root, state, query, areas = [], limit = 5) => { const path = lessonIndexPath(root); assertNoSymlinkPath(root, ".agents/data/lessons/index.json"); if (!existsSync(path)) { const hasLessons = Object.values(state.tasks).some((task) => Boolean(task.lessons?.length)) || Object.values(state.archive ?? {}).some((task) => task.lessonCount > 0); if (!hasLessons) return []; throw new Error("Lesson index is missing; run state.mjs lesson rebuild"); } const index = parseJsonFile(path, "Lesson index", "run state.mjs lesson rebuild"); if (index.schemaVersion !== 1 || !Array.isArray(index.lessons) || index.sourceDigest !== lessonStateDigest(state)) throw new Error("Lesson index is stale; run state.mjs lesson rebuild"); const queryTokens = tokens(query); const areaSet = new Set(areas.map((area) => area.toLocaleLowerCase())); return index.lessons.map((item) => { const haystack = new Set(tokens(`${item.summary} ${item.prevention} ${item.taskId} ${item.areas.join(" ")}`)); const areaScore = item.areas.some((area) => areaSet.has(area.toLocaleLowerCase())) ? 100 : 0; const tokenScore = queryTokens.filter((token) => haystack.has(token)).length; return { item, score: tokenScore + areaScore }; }).filter(({ score }) => score > 0 || (!queryTokens.length && !areaSet.size)).sort((a, b) => b.score - a.score || b.item.recordedAt.localeCompare(a.item.recordedAt)).slice(0, Math.max(1, Math.min(limit, 20))).map(({ item }) => item); };

export const listTaskSummaries = (state, options = {}) => { const active = Object.values(state.tasks).map((task) => ({ id: task.id, title: task.title, phase: task.phase, gate: task.gate, status: task.status, risk: task.risk, areas: task.areas, updatedAt: task.updatedAt, source: "active" })); const archived = options.includeArchive ? Object.values(state.archive ?? {}).map((task) => ({ id: task.id, title: task.title, phase: task.phase, gate: task.gate, status: task.status, risk: task.risk, areas: task.areas, updatedAt: task.updatedAt, source: "archive" })) : []; const queryTokens = tokens(options.query ?? ""); const statusSet = new Set(options.statuses ?? []); const filtered = [...active, ...archived].filter((item) => (!statusSet.size || statusSet.has(item.status)) && (!queryTokens.length || queryTokens.every((token) => tokens(`${item.id} ${item.title} ${item.areas.join(" ")}`).includes(token)))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)); const cursor = Math.max(0, options.cursor ?? 0); const limit = Math.max(1, Math.min(options.limit ?? 20, 100)); const items = filtered.slice(cursor, cursor + limit); return { items, nextCursor: cursor + items.length < filtered.length ? String(cursor + items.length) : null, total: filtered.length }; };

export const renderWorkplan = (task) => { const decisions = task.decisions.length ? task.decisions.map((item) => `- [${item.status === "approved" ? "x" : " "}] ${item.id} — ${item.label}${item.resolution ? ` — ${item.resolution}` : ""}`).join("\n") : "- None"; const tasks = task.tasks.length ? task.tasks.map((item) => `- [${item.status === "done" ? "x" : item.status === "in_progress" ? "~" : " "}] ${item.id} — ${item.label}`).join("\n") : "- None"; const lifecycle = [`- Status: \`${task.status}\``, task.handoff ? `- Handoff: \`${task.handoff.kind}\` — ${task.handoff.reason}` : "", task.closure ? `- Closure: ${task.closure.reason}` : "", task.predecessorTaskId ? `- Predecessor: \`${task.predecessorTaskId}\`` : "", task.successorTaskId ? `- Successor: \`${task.successorTaskId}\`` : "", task.lessonDisposition ? `- Lessons: \`${task.lessonDisposition.status}\`` : ""].filter(Boolean).join("\n"); return `# Workplan — ${task.title} (\`${task.id}\`)\n\n> Generated from canonical JSON state.\n\n## Lifecycle\n${lifecycle}\n\n## 🧩 Decisions (Approve plan — before implementation)\n${decisions}\n\n## 🧩 Tasks (Review implementation — work items)\n${tasks}\n`; };
export const renderViews = (root, state = loadState(root), selected = Object.values(state.tasks)) => { for (const task of selected) { if (!task.artifacts.workplan) continue; assertNoSymlinkPath(root, task.artifacts.workplan); writeAtomic(join(resolve(root), task.artifacts.workplan), renderWorkplan(task)); } };

const safeArtifactTarget = (root, path) => { assertNoSymlinkPath(root, path); return join(resolve(root), path); };
const artifactContent = (root, path) => { if (!path) return undefined; try { const target = safeArtifactTarget(root, path); return existsSync(target) ? readFileSync(target, "utf8") : undefined; } catch { return undefined; } };
const artifactDiagnostics = (root, task, names) => names.flatMap((name) => { const path = task.artifacts[name]; if (!path) return [{ level: "ERROR", code: "ARTIFACT_REFERENCE", message: `${name} artifact is not referenced` }]; try { return existsSync(safeArtifactTarget(root, path)) ? [] : [{ level: "ERROR", code: "ARTIFACT_MISSING", message: `${path} does not exist` }]; } catch (error) { return [{ level: "ERROR", code: "ARTIFACT_UNSAFE", message: error instanceof Error ? error.message : String(error) }]; } });
export const checkGate = (root, state, taskId, gate) => { const task = state.tasks[taskId]; if (!task) return [{ level: "ERROR", code: "TASK_UNKNOWN", message: `Unknown active task: ${taskId}` }]; const diagnostics = []; if (task.gate !== gate) diagnostics.push({ level: "ERROR", code: "GATE_STATE", message: `Task is at ${task.gate}, not ${gate}` }); if (["closed", "superseded"].includes(task.status)) diagnostics.push({ level: "ERROR", code: "TASK_TERMINAL", message: `Terminal task cannot approve ${gate}` }); if (task.handoff) diagnostics.push({ level: "ERROR", code: "TASK_HANDOFF", message: `Task has unresolved handoff: ${task.handoff.reason}` }); if (task.id !== taskId) diagnostics.push({ level: "ERROR", code: "TASK_ID", message: "Task key and id differ" }); if (!task.title.trim() || !task.areas.length) diagnostics.push({ level: "ERROR", code: "TASK_FIELDS", message: "Task title and affected areas are required" }); if (gate === "G0_confirm") { diagnostics.push(...artifactDiagnostics(root, task, ["intent"])); const content = artifactContent(root, task.artifacts.intent); if (content !== undefined) for (const heading of ["## 📋 Problem", "## 🗺️ Affected areas", "## 💭 Assumptions", "## ❓ Open questions", "## 🎯 Scope"]) if (!content.includes(heading)) diagnostics.push({ level: "ERROR", code: "INTENT_HEADING", message: `Intent is missing ${heading}` }); } if (gate === "G1_review") { diagnostics.push(...artifactDiagnostics(root, task, ["intent", "design", "workplan"])); diagnostics.push(...transitionDiagnostics(task, "build").filter((item) => item.code === "UNRESOLVED_DECISION")); const content = artifactContent(root, task.artifacts.design); if (content !== undefined) for (const heading of ["## 🧩 Solution per affected area", "## 📌 Spec traceability", "## 🔗 Cross-service contracts", "## ⚠️ Risks / edge cases"]) if (!content.includes(heading)) diagnostics.push({ level: "ERROR", code: "DESIGN_HEADING", message: `Design is missing ${heading}` }); } if (gate === "G2_codereview") { diagnostics.push(...artifactDiagnostics(root, task, ["intent", "design", "workplan"])); if (task.tasks.some((item) => !["done", "deferred"].includes(item.status))) diagnostics.push({ level: "ERROR", code: "TASKS_OPEN", message: "Build tasks remain open" }); for (const area of task.areas) if (!hasAreaVerification(task, area)) diagnostics.push({ level: "ERROR", code: "VERIFY_EVIDENCE", message: `Latest post-G1 verification evidence must pass for affected area: ${area}` }); if (!hasReview(task)) diagnostics.push({ level: "ERROR", code: "REVIEW_EVIDENCE", message: "Latest post-G1 code-review evidence must pass" }); const bounds = repairBounds(task); if (!isLegacyG2Wait(task) && (bounds.verifyExhausted || bounds.reviewExhausted)) diagnostics.push({ level: "ERROR", code: "REPAIR_BOUND", message: "Repair bound exhausted; record a durable handoff instead of presenting G2" }); } if (!diagnostics.length) diagnostics.push({ level: "INFO", code: "GATE_OK", message: `${gate} checks passed for ${taskId}` }); return diagnostics; };
const gateTarget = { G0_confirm: "plan", G1_review: "build", G2_codereview: "wrap" };
export const approveAndAdvance = (root, state, taskId, gate, source, recordedAt = new Date().toISOString()) => { const task = state.tasks[taskId]; if (!task) throw new Error(`Unknown active task: ${taskId}`); if (["closed", "superseded"].includes(task.status) || task.handoff) throw new Error(`Terminal or handed-off task cannot approve ${gate}`); const target = gateTarget[gate]; if (!target) throw new Error(`Gate ${gate} cannot be approved`); if (task.phase === target) return { task, nextAction: nextAction(task, root), idempotent: true }; if (task.gate !== gate || task.status !== "blocked_on_user") throw new Error(`Task must be blocked_on_user at ${gate}`); const errors = checkGate(root, state, taskId, gate).filter((item) => item.level === "ERROR"); if (errors.length) throw new Error(errors.map((item) => item.message).join("; ")); task.evidence.push({ kind: "approval", gate, result: "pass", source, recordedAt }); transitionTask(state, taskId, target); return { task, nextAction: nextAction(task, root), idempotent: false }; };
export const formatDiagnostics = (diagnostics) => diagnostics.map((item) => `${item.level} ${item.code}: ${item.message}`).join("\n");

const oneLine = (value) => value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").replace(/ACTION\s+REQUIRED/gi, "ACTION-REQUIRED").trim();
const markdownText = (value) => oneLine(value).replace(/([\\`*_{}\[\]()<>#+.!|>~])/g, "\\$1");
const gateMeta = { G0_confirm: { icon: "🟢", title: "Review step · Confirm requirements", action: "Reply `ok` to confirm requirements, or state changes." }, G1_review: { icon: "🔵", title: "Review step · Approve plan", action: "Reply `approve` to approve the plan and start implementation, or state decision changes." }, G2_codereview: { icon: "🟣", title: "Review step · Review implementation", action: "Approve the implementation to complete the task, or point out what to fix." } };
export const gateView = (task, diagnostics) => { if (task.gate === "none") throw new Error(`Task has no human gate: ${task.id}`); const errors = diagnostics.filter((item) => item.level === "ERROR"); if (errors.length) throw new Error(errors.map((item) => item.message).join("; ")); const meta = gateMeta[task.gate]; const counts = (items) => items.reduce((result, item) => ({ ...result, [item.status]: (result[item.status] ?? 0) + 1 }), {}); return { schemaVersion: 1, gate: task.gate, icon: meta.icon, title: meta.title, action: meta.action, task: { id: task.id, title: oneLine(task.title), status: task.status, risk: task.risk, areas: task.areas }, artifacts: Object.entries(task.artifacts).flatMap(([name, path]) => path ? [{ name: oneLine(name), path: oneLine(path) }] : []), decisions: counts(task.decisions), execution: counts(task.tasks), evidence: task.evidence.filter((item) => ["test", "lint", "review"].includes(item.kind)).slice(-5).map((item) => ({ kind: item.kind, result: item.result, source: oneLine(item.source) })), diagnostics: diagnostics.filter((item) => item.level !== "INFO").map((item) => ({ level: item.level, code: item.code, message: oneLine(item.message) })) }; };
const markdownLinkTarget = (value) => encodeURI(value).replace(/[()#?]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
export const formatGateView = (task, diagnostics, format = "markdown") => { const view = gateView(task, diagnostics); if (format === "json") return `${JSON.stringify(view, null, 2)}\n`; const artifacts = view.artifacts.length ? view.artifacts.map((item) => format === "markdown" ? `- **${markdownText(item.name)}:** [${markdownText(item.path)}](${markdownLinkTarget(item.path)})` : `- ${item.name}: ${item.path}`).join("\n") : "- none"; const decisions = Object.entries(view.decisions).map(([status, count]) => `${count} ${status}`).join(" · ") || "none"; const execution = Object.entries(view.execution).map(([status, count]) => `${count} ${status}`).join(" · ") || "none"; const evidence = view.evidence.length ? view.evidence.map((item) => `- ${item.kind}: ${item.result} — ${format === "markdown" ? markdownText(item.source) : item.source}`).join("\n") : "- none yet"; const warnings = view.diagnostics.length ? `\n\n${view.diagnostics.map((item) => `- ${item.level} ${item.code}: ${format === "markdown" ? markdownText(item.message) : item.message}`).join("\n")}` : ""; if (format === "plain") return [`[IMPORTANT] ${view.icon} ${view.title}`, `Task: ${view.task.id} — ${view.task.title}`, `Status: ${view.task.status} · Risk: ${view.task.risk} · Areas: ${view.task.areas.join(", ")}`, "", "Review artifacts", artifacts, "", `Decisions: ${decisions}`, `Execution: ${execution}`, "Evidence", evidence, warnings, "", `ACTION REQUIRED -> ${oneLine(view.action)}`].join("\n").replace(/\n{3,}/g, "\n\n") + "\n"; return ["> [!IMPORTANT]", `> ${view.icon} **${view.title}**`, `> **Task:** \`${view.task.id}\` — ${markdownText(view.task.title)}`, `> **Status:** \`${view.task.status}\` · **Risk:** \`${view.task.risk}\` · **Areas:** ${view.task.areas.map((area) => `\`${markdownText(area)}\``).join(", ")}`, "", "### Review artifacts", artifacts, "", `**Decisions:** ${decisions}  `, `**Execution:** ${execution}`, "", "### Verification evidence", evidence, warnings, "", `> **ACTION REQUIRED →** ${view.action}`].join("\n").replace(/\n{3,}/g, "\n\n") + "\n"; };
