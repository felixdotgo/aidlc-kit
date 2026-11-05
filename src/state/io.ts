import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveProjectPathWithoutSymlinks } from "../project-path.js";

export const assertNoSymlinkPath = (root: string, relative: string): void => {
  resolveProjectPathWithoutSymlinks(root, relative, "Unsafe state path", "State path crosses a symlink");
};

export const writeAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
};

export const parseJsonText = (content: string, label: string, recovery = ""): unknown => {
  try { return JSON.parse(content); }
  catch (error) { throw new Error(`${label} is corrupted or unreadable: ${error instanceof Error ? error.message : String(error)}${recovery ? `; ${recovery}` : ""}`); }
};

export const parseJsonFile = (path: string, label: string, recovery = ""): unknown => parseJsonText(readFileSync(path, "utf8"), label, recovery);

/** Resolves a project-relative state path to its absolute form, rejecting symlink-crossing variants first. */
export const safeResolvedPath = (root: string, relative: string): string => {
  assertNoSymlinkPath(root, relative);
  return join(resolve(root), relative);
};

/** Loads and validates a canonical JSON state file, or produces the fallback when the file does not exist. */
export const loadJsonOr = <T>(root: string, relative: string, validate: (value: unknown) => T, fallback: () => T, label: string, recovery = ""): T => {
  const path = safeResolvedPath(root, relative);
  return existsSync(path) ? validate(parseJsonFile(path, label, recovery)) : fallback();
};

/** Persists a JSON state file atomically in the canonical 2-space, trailing-newline formatting. */
export const saveJson = (root: string, relative: string, value: unknown): void => {
  writeAtomic(safeResolvedPath(root, relative), `${JSON.stringify(value, null, 2)}\n`);
};
