import { isAbsolute, normalize } from "node:path";

/** Rejects artifact paths that escape the project-owned tasks directory. */
export const assertTaskArtifactPath = (id: string, path: string): void => {
  const separator = process.platform === "win32" ? "\\" : "/";
  const cleaned = normalize(path);
  if (isAbsolute(cleaned) || cleaned === ".." || cleaned.startsWith(`..${separator}`) || !cleaned.startsWith(`.agents${separator}data${separator}tasks${separator}`)) {
    throw new Error(`Invalid artifact path for ${id}: ${path}`);
  }
};
