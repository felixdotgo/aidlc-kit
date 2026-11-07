/**
 * In-app documentation: the package's own `docs/*.md` (shipped via package.json `files`),
 * served read-only by slug from a fixed whitelist — never by a request-supplied path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DocPage { slug: string; label: string }

/** Sidebar order; the first entry is the landing page of `/docs`. */
export const DOC_PAGES: readonly DocPage[] = [
  { slug: "loop-runbook", label: "Getting started" },
  { slug: "loop-local-run", label: "Local loop walkthrough" },
  { slug: "configuration", label: "Configuration" },
  { slug: "command-reference", label: "Command reference" },
  { slug: "troubleshooting", label: "Troubleshooting" },
  { slug: "operating-workflow", label: "Operating the workflow" },
  { slug: "architecture", label: "Architecture" },
];
export const DEFAULT_DOC = DOC_PAGES[0]?.slug ?? "loop-runbook";

/** `docs/` next to the package's `dist/` (dist/src/ui/docs.js → ../../../docs). */
const docsDir = (): string => fileURLToPath(new URL("../../../docs/", import.meta.url));

const cache = new Map<string, string>();

export const findDocPage = (slug: string): DocPage | undefined => DOC_PAGES.find((page) => page.slug === slug);

/** The markdown of a whitelisted page, or undefined (unknown slug or missing file). */
export const readDoc = (slug: string): { page: DocPage; markdown: string } | undefined => {
  const page = findDocPage(slug);
  if (!page) return undefined;
  let markdown = cache.get(slug);
  if (markdown === undefined) {
    try { markdown = readFileSync(join(docsDir(), `${page.slug}.md`), "utf8"); }
    catch { return undefined; }
    cache.set(slug, markdown);
  }
  return { page, markdown };
};
