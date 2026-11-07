/** Markdown renderer (minimal, escaping-first, no runtime dependency). */
import { escapeHtml } from "./http.js";

const safeUrl = (raw: string): string => {
  const url = raw.trim();
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1] ?? "")) return "#";
  return escapeHtml(url);
};

const renderInline = (text: string): string => {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\s][^*]*)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[^\w])_([^_\s][^_]*)_(?![\w])/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${safeUrl(url)}">${label}</a>`);
  return out;
};

const splitRow = (line: string): string[] => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");

const isTableSeparator = (line: string): boolean => /^[\s|:-]+$/.test(line.trim()) && line.includes("-");

/** Renders a small subset of Markdown to escaped HTML. Exported for tests. */
export const markdownToHtml = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let listKind: "ul" | "ol" | null = null;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length) { html.push(`<p>${renderInline(paragraph.join(" "))}</p>`); paragraph = []; }
  };
  const closeList = (): void => {
    if (listKind) { html.push(`</${listKind}>`); listKind = null; }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph(); closeList();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) { codeLines.push(lines[i] ?? ""); i += 1; }
      i += 1;
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph(); closeList();
      const level = (heading[1] ?? "#").length;
      html.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^([-*_])(\s*\1){2,}\s*$/.test(trimmed)) { flushParagraph(); closeList(); html.push("<hr>"); i += 1; continue; }

    if (trimmed.startsWith(">")) {
      flushParagraph(); closeList();
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith(">")) { quote.push((lines[i] ?? "").trim().replace(/^>\s?/, "")); i += 1; }
      html.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
      continue;
    }

    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      flushParagraph(); closeList();
      const header = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().includes("|")) { rows.push(splitRow((lines[i] ?? "").trim())); i += 1; }
      const cols = header.length;
      const ths = header.map((c) => `<th>${renderInline(c.trim())}</th>`).join("");
      const trs = rows.map((r) => `<tr>${Array.from({ length: cols }, (_x, k) => `<td>${renderInline((r[k] ?? "").trim())}</td>`).join("")}</tr>`).join("");
      html.push(`<table class="table is-fullwidth is-striped is-bordered"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushParagraph();
      const kind = ol ? "ol" : "ul";
      if (listKind !== kind) { closeList(); html.push(`<${kind}>`); listKind = kind; }
      html.push(`<li>${renderInline((ul?.[1] ?? ol?.[1] ?? "").trim())}</li>`);
      i += 1;
      continue;
    }

    if (trimmed === "") { flushParagraph(); closeList(); i += 1; continue; }

    closeList();
    paragraph.push(trimmed);
    i += 1;
  }
  flushParagraph(); closeList();
  return html.join("\n");
};
