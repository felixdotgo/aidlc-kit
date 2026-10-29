import type { FileSpec } from "./model.js";

export const managedBlock = (spec: Pick<FileSpec, "owner" | "strategy">, content: string): string | undefined => {
  if (spec.strategy !== "managed-block") return content;
  const start = `<!-- aidlc-installer:${spec.owner}:start -->`;
  const end = `<!-- aidlc-installer:${spec.owner}:end -->`;
  return content.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0];
};

export const mergeManagedBlock = (spec: FileSpec, current: string): string => {
  const start = `<!-- aidlc-installer:${spec.owner}:start -->`;
  const end = `<!-- aidlc-installer:${spec.owner}:end -->`;
  const block = spec.content.trimEnd();
  const matches = new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "g");
  const withoutOwnedBlocks = current.replace(matches, "").replace(/\n{3,}/g, "\n\n").trim();
  const next = `${withoutOwnedBlocks}${withoutOwnedBlocks ? "\n\n" : ""}${block}`;
  return `${next.trimEnd()}\n`;
};
