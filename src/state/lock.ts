import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertNoSymlinkPath } from "./shared.js";

interface LockRecord { token: string; pid: number; createdAt: number; }

export interface StateLockOptions { timeoutMs?: number; retryMs?: number; staleMs?: number; }

const sleep = (milliseconds: number): void => {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const lockRecord = (path: string): LockRecord | undefined => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    return typeof value.token === "string" && typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value as LockRecord : undefined;
  } catch { return undefined; } /* intentional: unreadable lock record is treated as absent */
};

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

const tryCreateLock = (path: string, record: LockRecord): boolean => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const descriptor = openSync(path, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8"); }
    finally { closeSync(descriptor); }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
};

const removeOwnedLock = (path: string, token: string): void => {
  if (lockRecord(path)?.token === token) unlinkSync(path);
};

const lockExpired = (record: LockRecord | undefined, now: number, staleMs: number): boolean => Boolean(record && now - record.createdAt >= staleMs && !processAlive(record.pid));

const releaseOwnedLock = (lockRecordOrNull: LockRecord | undefined, lockPath: string, token: string): void => {
  if (!lockRecordOrNull) {
    if (existsSync(lockPath)) throw new Error("Cannot release AI-DLC state lock because its owner record is unreadable");
    return;
  }
  if (lockRecordOrNull.token !== token) return;
  try { unlinkSync(lockPath); }
  catch (error) { throw new Error(`Failed to release owned AI-DLC state lock: ${error instanceof Error ? error.message : String(error)}`); }
};

/** Serializes lifecycle script mutations across local Node.js processes. */
export const acquireStateLock = (root: string, options: StateLockOptions = {}): (() => void) => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryMs = options.retryMs ?? 25;
  const staleMs = options.staleMs ?? 30_000;
  const lockPath = join(resolve(root), ".agents/data/state/.aidlc-state.lock");
  const guardPath = join(resolve(root), ".agents/data/state/.aidlc-state.lock.guard");
  assertNoSymlinkPath(root, ".agents/data/state/.aidlc-state.lock");
  assertNoSymlinkPath(root, ".agents/data/state/.aidlc-state.lock.guard");
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const acquireGuard = (): string | undefined => {
    const guardToken = randomUUID();
    const now = Date.now();
    const existing = lockRecord(guardPath);
    if (lockExpired(existing, now, staleMs)) removeOwnedLock(guardPath, existing!.token);
    return tryCreateLock(guardPath, { token: guardToken, pid: process.pid, createdAt: now }) ? guardToken : undefined;
  };
  while (Date.now() <= deadline) {
    const guardToken = acquireGuard();
    if (!guardToken) { sleep(retryMs); continue; }
    try {
      const now = Date.now();
      const existing = lockRecord(lockPath);
      if (lockExpired(existing, now, staleMs)) removeOwnedLock(lockPath, existing!.token);
      if (tryCreateLock(lockPath, { token, pid: process.pid, createdAt: now })) {
        return () => releaseOwnedLock(lockRecord(lockPath), lockPath, token);
      }
    } finally { removeOwnedLock(guardPath, guardToken); }
    sleep(retryMs);
  }
  throw new Error(`Timed out waiting for AI-DLC state lock after ${timeoutMs}ms`);
};
