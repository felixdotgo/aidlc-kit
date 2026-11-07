/**
 * `/docs` and `/docs/<slug>`: the packaged guides rendered with the dashboard's markdown
 * renderer, a page sidebar, and an on-page table of contents.
 */
import { DOC_PAGES, readDoc } from "../docs.js";
import { readUiState } from "../data.js";
import { escapeHtml } from "../http.js";
import { markdownToHtml } from "../markdown.js";
import { uiMode, type UiOptions } from "../options.js";
import { pageHead, pageScripts, renderHeader, renderModals, reviewQueue } from "./layout.js";

const REPO_DOCS = "https://github.com/felixdotgo/aidlc-kit/blob/main/docs/";

/** GitHub-style heading anchor, so the docs' own `#section` links resolve in-app. */
export const headingSlug = (text: string): string =>
  text.replace(/<[^>]+>/g, "").replace(/&[a-z]+;|&#\d+;/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");

export interface TocEntry { level: number; id: string; text: string }

const CALLOUTS: Record<string, string> = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };

/** Markdown → HTML plus heading ids, in-app links, and GitHub-style callouts. */
export const renderDocHtml = (markdown: string): { html: string; toc: TocEntry[] } => {
  const toc: TocEntry[] = [];
  const seen = new Map<string, number>();
  let html = markdownToHtml(markdown).replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_match, level: string, inner: string) => {
    const base = headingSlug(inner) || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    // `inner` is already escaped by the renderer; the tags are dropped, the entities kept as-is.
    if (level === "2" || level === "3") toc.push({ level: Number(level), id, text: inner.replace(/<[^>]+>/g, "") });
    return `<h${level} id="${id}"><a class="ad-doc-anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${level}>`;
  });
  // Relative links between guides stay in the app; other repo docs open on GitHub.
  html = html.replace(/href="(?:\.\/)?([A-Za-z0-9-]+)\.md(#[^"]*)?"/g, (_match, slug: string, hash = "") =>
    DOC_PAGES.some((page) => page.slug === slug) ? `href="/docs/${slug}${hash}"` : `href="${REPO_DOCS}${slug}.md${hash}" target="_blank" rel="noopener"`);
  html = html.replace(/<blockquote>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/g, (_match, kind: string) =>
    `<blockquote class="ad-doc-callout is-${kind.toLowerCase()}"><strong class="ad-doc-callout-title">${CALLOUTS[kind] ?? kind}</strong> `);
  return { html, toc };
};

/** The full docs page, or undefined for an unknown slug (the route answers 404). */
export const renderDocsPage = async (options: UiOptions, slug: string): Promise<string | undefined> => {
  const doc = readDoc(slug);
  if (!doc) return undefined;
  const { html, toc } = renderDocHtml(doc.markdown);
  const state = await readUiState(options);
  const nav = DOC_PAGES.map((page) => `<li><a href="/docs/${page.slug}"${page.slug === slug ? ' class="is-active" aria-current="page"' : ""}>${escapeHtml(page.label)}</a></li>`).join("");
  const contents = toc.length
    ? `<p class="ad-docs-nav-title">On this page</p><ul class="ad-docs-toc">${toc.map((entry) => `<li class="is-level-${entry.level}"><a href="#${entry.id}">${entry.text}</a></li>`).join("")}</ul>`
    : "";
  return `${pageHead(`${doc.page.label} · Docs · Loop`)}
${renderHeader(options.root, uiMode(options), reviewQueue(state))}
<main class="section ad-main">
  <div class="container is-fluid">
    <nav class="breadcrumb is-small mb-3" aria-label="breadcrumbs"><ul><li><a href="/">Loop</a></li><li><a href="/docs">Docs</a></li><li class="is-active"><a href="/docs/${doc.page.slug}" aria-current="page">${escapeHtml(doc.page.label)}</a></li></ul></nav>
    <div class="ad-docs">
      <aside class="ad-docs-nav" aria-label="Documentation">
        <p class="ad-docs-nav-title">Guides</p>
        <ul class="ad-docs-pages">${nav}</ul>
        ${contents}
      </aside>
      <article class="ad-panel ad-docs-body"><div class="content artifact">${html}</div></article>
    </div>
  </div>
</main>
${renderModals()}
${pageScripts("common")}
</body>
</html>`;
};
