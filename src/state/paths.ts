import { join, resolve } from "node:path";

export const statePathRelative = ".agents/data/state/aidlc-state.json";
export const lessonIndexPathRelative = ".agents/data/lessons/index.json";
export const memoryRegistryPathRelative = ".agents/data/memory/agentic-memory.json";
export const stateLockPathRelative = ".agents/data/state/.aidlc-state.lock";
export const stateLockGuardPathRelative = ".agents/data/state/.aidlc-state.lock.guard";

export const statePath = (root: string): string => join(resolve(root), statePathRelative);
export const lessonIndexPath = (root: string): string => join(resolve(root), lessonIndexPathRelative);
export const memoryRegistryPath = (root: string): string => join(resolve(root), memoryRegistryPathRelative);
export const stateLockPath = (root: string): string => join(resolve(root), stateLockPathRelative);
export const stateLockGuardPath = (root: string): string => join(resolve(root), stateLockGuardPathRelative);
export const archiveRecordPath = (id: string): string => `.agents/data/state/archive/${id}.json`;
