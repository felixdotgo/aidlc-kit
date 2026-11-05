import type { FileSpec } from "./model.js";

/** Canonical managed-block markers; every emitter and detector must build them through these helpers. */
export const managedStartMarker = (owner: string): string => `<!-- aidlc-installer:${owner}:start -->`;
export const managedEndMarker = (owner: string): string => `<!-- aidlc-installer:${owner}:end -->`;
/** Single-marker block emitted by the frozen v0.2.1 baseline; upgrade and uninstall still detect it. */
export const legacyManagedMarker = (owner: string): string => `<!-- aidlc-installer:${owner} -->`;

export const managedBlock = (spec: Pick<FileSpec, "owner" | "strategy">, content: string): string | undefined => {
  if (spec.strategy !== "managed-block") return content;
  const start = managedStartMarker(spec.owner);
  const end = managedEndMarker(spec.owner);
  return content.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0];
};

export const mergeManagedBlock = (spec: FileSpec, current: string): string => {
  const start = managedStartMarker(spec.owner);
  const end = managedEndMarker(spec.owner);
  const block = spec.content.trimEnd();
  const matches = new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "g");
  const withoutOwnedBlocks = current.replace(matches, "").replace(/\n{3,}/g, "\n\n").trim();
  const next = `${withoutOwnedBlocks}${withoutOwnedBlocks ? "\n\n" : ""}${block}`;
  return `${next.trimEnd()}\n`;
};

/** Removes every block owned by `owner` from `current` and normalizes the leftover blank-line runs. */
export const removeManagedBlock = (current: string, owner: string): string => {
  const start = managedStartMarker(owner);
  const end = managedEndMarker(owner);
  return current.replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "g"), "").replace(/\n{3,}/g, "\n\n").trimEnd();
};
