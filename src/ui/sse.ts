/** `/api/events`: the loop event logs as a Server-Sent Events stream. */
import { lstatSync, statSync, type Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readRange } from "./files.js";
import { sendJson } from "./http.js";
import { join } from "node:path";
import { eventsLogPath, legacyTaskEventsDir, legacyTaskEventsLogPath, loopDataDir, TASK_ID_PATTERN, taskEventsLogPath, taskRuntimeDir, tasksDataDir, type UiOptions } from "./options.js";

/** On a fresh connection the SSE stream replays at most this many lines. */
export const SSE_REPLAY_LINES = 200;
const SSE_REPLAY_BYTES = 256 * 1024;
const SSE_CHUNK_BYTES = 1024 * 1024;

/** Read position in one log file; `discarding` is set inside an oversized line that was skipped. */
interface Cursor { position: number; discarding: boolean }

/**
 * Calls `onLine(line, endOffset)` for each complete (newline-terminated) line of
 * `path` after `cursor.position`, reading at most one chunk, and advances the
 * cursor past them. A half-written last line waits for the next call; a line
 * longer than a chunk is skipped.
 */
const readLines = (path: string, size: number, cursor: Cursor, noFollow: boolean, onLine: (line: string, end: number) => void): void => {
  if (size <= cursor.position) return;
  const end = Math.min(size, cursor.position + SSE_CHUNK_BYTES);
  let buffer = readRange(path, cursor.position, end, noFollow);
  if (cursor.discarding) {
    // Drop the rest of an oversized line up to and including its newline.
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) { cursor.position = end; return; }
    cursor.position += newline + 1;
    buffer = buffer.subarray(newline + 1);
    cursor.discarding = false;
  }
  const last = buffer.lastIndexOf(0x0a);
  if (last < 0) { if (buffer.length >= SSE_CHUNK_BYTES) { cursor.position = end; cursor.discarding = true; } return; }
  for (let start = 0; start <= last;) {
    const newline = buffer.indexOf(0x0a, start);
    if (newline > start) onLine(buffer.subarray(start, newline).toString("utf8"), cursor.position + newline + 1);
    start = newline + 1;
  }
  cursor.position += last + 1;
};

/** Complete lines in the last `budget` bytes of `path` (a cut-off first line is dropped) and the
 * offset just after the last newline (the window start when there is none). */
const tailLines = (path: string, size: number, budget: number, noFollow: boolean): { lines: string[]; end: number; whole: boolean } => {
  const start = Math.max(0, size - budget);
  const buffer = readRange(path, start, size, noFollow);
  const last = buffer.lastIndexOf(0x0a);
  if (last < 0) return { lines: [], end: start, whole: start === 0 };
  let lines = buffer.subarray(0, last).toString("utf8").split("\n");
  if (start > 0) lines = lines.slice(1);
  return { lines: lines.filter((line) => line.length > 0), end: start + last + 1, whole: start === 0 };
};

type Send = (line: string, id: string) => void;
type Tick = () => void;

/**
 * The global sidecar (`ui-events.jsonl`), optionally filtered to one task id
 * (logs written before per-task files existed). Event ids are `<inode>:<offset>`.
 * A stale Last-Event-ID (rotated-away file) replays the tail like a fresh
 * connection; a rotation seen while streaming follows the new file from 0.
 */
const globalLogTicker = (root: string, taskFilter: string, lastEventId: string, send: Send): Tick => {
  const path = eventsLogPath(root);
  const resume = /^(\d+):(\d+)$/.exec(lastEventId);
  let inode: number | null = resume ? Number(resume[1]) : null;
  const cursor: Cursor = { position: resume ? Number(resume[2]) : -1, discarding: false };
  let firstTick = true;
  const matches = (line: string): boolean => {
    if (!taskFilter) return true;
    try { return (JSON.parse(line) as { taskId?: unknown }).taskId === taskFilter; } catch { return false; }
  };
  return () => {
    let stat;
    try { stat = statSync(path); } catch { return; }
    if (inode !== null && stat.ino !== inode) { cursor.position = firstTick ? -1 : 0; cursor.discarding = false; }
    firstTick = false;
    inode = stat.ino;
    const ino = stat.ino;
    if (cursor.position < 0) {
      const tail = tailLines(path, stat.size, SSE_REPLAY_BYTES, false);
      cursor.position = tail.end;
      for (const line of tail.lines.filter(matches).slice(-SSE_REPLAY_LINES)) send(line, `${ino}:${cursor.position}`);
      return;
    }
    if (stat.size < cursor.position) { cursor.position = 0; cursor.discarding = false; }
    readLines(path, stat.size, cursor, false, (line, end) => { if (matches(line)) send(line, `${ino}:${end}`); });
  };
};

/** lstat of a real directory / regular file; undefined when missing, a symlink, or another kind. */
const realDirectory = (path: string): boolean => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const regularFile = (path: string): Stats | undefined => { try { const stat = lstatSync(path); return stat.isFile() ? stat : undefined; } catch { return undefined; } };

/** The per-task log files, refusing symlinked directories or files (like the
 * writer does). The task's `runtime/events.jsonl` wins when it (or its `.1`
 * generation) exists; otherwise the pre-runtime `.agents/data/loop/events/`
 * copy is read until `loop migrate-data` has moved it. */
const taskLogFiles = (root: string, taskId: string): { path: string; rotated: string; stat: (path: string) => Stats | undefined } => {
  const runtime = taskRuntimeDir(root, taskId);
  const runtimeDirs = (): boolean => realDirectory(tasksDataDir(root)) && realDirectory(join(tasksDataDir(root), taskId)) && realDirectory(runtime);
  const legacyDirs = (): boolean => realDirectory(loopDataDir(root)) && realDirectory(legacyTaskEventsDir(root));
  const current = taskEventsLogPath(root, taskId);
  if (runtimeDirs() && (regularFile(current) || regularFile(`${current}.1`))) return { path: current, rotated: `${current}.1`, stat: (file) => runtimeDirs() ? regularFile(file) : undefined };
  const legacy = legacyTaskEventsLogPath(root, taskId);
  if (legacyDirs() && (regularFile(legacy) || regularFile(`${legacy}.1`))) return { path: legacy, rotated: `${legacy}.1`, stat: (file) => legacyDirs() ? regularFile(file) : undefined };
  return { path: current, rotated: `${current}.1`, stat: (file) => runtimeDirs() ? regularFile(file) : undefined };
};

/**
 * One task's own history (`events/<taskId>.jsonl`, one rotated `.1` generation).
 * Event ids are `t:<inode>:<offset>` (never confused with global-log ids). A fresh
 * connection, or a Last-Event-ID naming neither generation, sends a `reset` event
 * (the client clears its lines) and replays the tail of `.1` then the current file.
 * A Last-Event-ID inside `.1` (or a rotation seen while streaming) finishes the
 * old generation first, then follows the new file from 0.
 */
const taskLogTicker = (root: string, taskId: string, lastEventId: string, send: Send, reset: () => void): Tick => {
  const { path, rotated, stat: fileStat } = taskLogFiles(root, taskId);
  const id = (ino: number, offset: number): string => `t:${ino}:${offset}`;
  let inode: number | null = null;
  const cursor: Cursor = { position: -1, discarding: false };
  let drain: { inode: number; cursor: Cursor } | null = null;
  const resume = /^t:(\d+):(\d+)$/.exec(lastEventId);
  if (resume) {
    const ino = Number(resume[1]);
    const offset = Number(resume[2]);
    if (fileStat(path)?.ino === ino) { inode = ino; cursor.position = offset; }
    else if (fileStat(rotated)?.ino === ino) { drain = { inode: ino, cursor: { position: offset, discarding: false } }; cursor.position = 0; }
  }
  const replay = (): void => {
    const current = fileStat(path);
    let lines: string[] = [];
    let used = 0;
    let whole = true;
    inode = current ? current.ino : null;
    cursor.position = 0;
    cursor.discarding = false;
    if (current) {
      const tail = tailLines(path, current.size, SSE_REPLAY_BYTES, true);
      ({ lines, whole } = tail);
      cursor.position = tail.end;
      used = Math.min(current.size, SSE_REPLAY_BYTES);
    }
    if (whole && lines.length < SSE_REPLAY_LINES && used < SSE_REPLAY_BYTES) {
      const old = fileStat(rotated);
      if (old) lines = [...tailLines(rotated, old.size, SSE_REPLAY_BYTES - used, true).lines, ...lines];
    }
    reset();
    const at = id(inode ?? 0, cursor.position);
    for (const line of lines.slice(-SSE_REPLAY_LINES)) send(line, at);
  };
  const tick = (): void => {
    if (cursor.position < 0) { replay(); return; }
    if (drain) {
      const old = fileStat(rotated);
      const before = drain.cursor.position;
      if (old && old.ino === drain.inode && old.size > before) {
        readLines(rotated, old.size, drain.cursor, true, (line, end) => send(line, id(old.ino, end)));
        // More of the old generation next tick; a trailing partial line never completes.
        if (drain.cursor.position < old.size && drain.cursor.position !== before) return;
      }
      drain = null;
    }
    const current = fileStat(path);
    if (!current) return;
    if (inode !== null && current.ino !== inode) {
      // Rotated while streaming: finish the old generation (now `.1`) first, then the new file.
      const previous = inode;
      drain = fileStat(rotated)?.ino === previous ? { inode: previous, cursor: { ...cursor } } : null;
      inode = null;
      cursor.position = 0;
      cursor.discarding = false;
      if (drain) { tick(); return; }
    }
    inode = current.ino;
    if (current.size < cursor.position) { cursor.position = 0; cursor.discarding = false; }
    readLines(path, current.size, cursor, true, (line, end) => send(line, id(current.ino, end)));
  };
  return tick;
};

/**
 * Streams loop events as SSE. Tracks byte offsets (no full re-read per tick),
 * emits only newline-terminated lines (a half-written line waits for the next
 * tick), handles truncation and rotation (inode change), and replays only the
 * last SSE_REPLAY_LINES on a fresh connection. `?task-id=<id>` (a canonical task
 * id, else 400) reads that task's own history file when it exists, and falls
 * back to filtering the global sidecar (older logs) when it does not. Event ids
 * let EventSource reconnects (`Last-Event-ID`) resume exactly.
 */
export const streamEvents = (options: UiOptions, res: ServerResponse, req: IncomingMessage, url: URL): void => {
  const taskId = url.searchParams.get("task-id") ?? "";
  if (taskId && !TASK_ID_PATTERN.test(taskId)) return sendJson(res, 400, { ok: false, error: "task-id must be a canonical task id" });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
  });
  // Flush headers immediately (an empty log would otherwise leave the client
  // waiting for the first event) and keep idle connections alive.
  res.write(": connected\n\n");
  const lastEventId = String(req.headers["last-event-id"] ?? "");
  const send: Send = (line, id) => { res.write(`id: ${id}\ndata: ${line}\n\n`); };
  const files = taskId ? taskLogFiles(options.root, taskId) : undefined;
  const tick = files && (files.stat(files.path) || files.stat(files.rotated))
    ? taskLogTicker(options.root, taskId, lastEventId, send, () => res.write("event: reset\ndata: replay\n\n"))
    : globalLogTicker(options.root, taskId, lastEventId, send);
  const emit = (): void => {
    try { tick(); } catch { /* transient read errors are ignored until the next poll */ }
  };
  let idleTicks = 0;
  emit();
  const timer = setInterval(() => {
    emit();
    idleTicks += 1;
    if (idleTicks >= 30) { idleTicks = 0; res.write(": keep-alive\n\n"); }
  }, 500);
  const cleanup = (): void => clearInterval(timer);
  req.on("close", cleanup);
  res.on("close", cleanup);
};
