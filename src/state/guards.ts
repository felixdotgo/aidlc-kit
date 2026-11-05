import { isAbsolute, normalize } from "node:path";

export const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
export const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
export const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const audited = (reason: string, source: string): void => {
  if (!text(reason) || !text(source)) throw new Error("Lifecycle mutation requires non-empty --reason and --source");
};

export const tokens = (value: string): string[] => [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((item) => item.length > 1))];

/** Rejects artifact paths that escape the project-owned tasks directory. */
export const assertTaskArtifactPath = (id: string, path: string): void => {
  const separator = process.platform === "win32" ? "\\" : "/";
  const cleaned = normalize(path);
  if (isAbsolute(cleaned) || cleaned === ".." || cleaned.startsWith(`..${separator}`) || !cleaned.startsWith(`.agents${separator}data${separator}tasks${separator}`)) {
    throw new Error(`Invalid artifact path for ${id}: ${path}`);
  }
};
