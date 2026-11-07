/**
 * `/tasks/:id/changes`: a task's code changes, rendered server-side (every diff line
 * and file name escaped) so the page works without JavaScript; `changes.js` only
 * filters items in place and scrolls to files.
 */
import { ID_PATTERN, INTEGRATION_ITEM, MAX_FILES, MAX_PATCH_BYTES, MAX_TASK_PATCH_BYTES, taskChanges, WORKING_TREE_ITEM, type ChangedFile, type ChangeItem, type ChangesPayload } from "../changes.js";
import { readUiState } from "../data.js";
import { escapeHtml } from "../http.js";
import { uiMode, type UiOptions } from "../options.js";
import { gatePill, statusPill } from "./components.js";
import { pageHead, pageScripts, renderHeader, renderModals, reviewQueue } from "./layout.js";

/** Link to a task's changes page (task detail, G2 gate panel, side panel). */
export const changesHref = (taskId: string): string => `/tasks/${encodeURIComponent(taskId)}/changes`;

const SOURCE_LABEL: Record<ChangesPayload["source"], string> = {
  assignments: "loop assignments",
  fleet: "fleet review snapshot",
  "working-tree": "working tree",
  none: "unavailable",
};

const STATUS_TONE: Record<string, string> = { added: "is-success", deleted: "is-danger", modified: "is-info", renamed: "is-link", copied: "is-link", untracked: "is-warning" };

const statusBadge = (status: string): string => `<span class="ad-pill ad-diff-status ${STATUS_TONE[status] ?? ""}" title="${escapeHtml(status)}">${escapeHtml(status)}</span>`;

const itemTitle = (item: ChangeItem): string =>
  item.itemId === WORKING_TREE_ITEM ? "Working tree (uncommitted, not task-scoped)"
    : item.itemId === INTEGRATION_ITEM ? "Integration commit"
      : `Item · ${item.itemId}`;

const lineClass = (line: string): string =>
  line.startsWith("@@") ? "ad-diff-hunk"
    : line.startsWith("+++ ") || line.startsWith("--- ") || line === "+++" || line === "---" ? "ad-diff-meta"
      : line.startsWith("+") ? "ad-diff-add"
        : line.startsWith("-") ? "ad-diff-del"
          : line.startsWith(" ") || line === "" ? "ad-diff-ctx"
            : "ad-diff-meta";

/** Splits a unified patch into per-file sections (each starts at `diff --git`). */
export const patchSections = (patch: string): string[][] => {
  const sections: string[][] = [];
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ") || !sections.length) sections.push([]);
    sections[sections.length - 1]!.push(line);
  }
  return sections;
};

const renderLines = (lines: string[]): string =>
  `<div class="ad-diff" role="presentation">${lines.map((line) => `<div class="ad-diff-line ${lineClass(line)}">${escapeHtml(line)}</div>`).join("")}</div>`;

const fileBody = (file: ChangedFile, section: string[] | undefined, truncated: boolean, omitted = false): string => {
  if (file.status === "untracked") return '<p class="ad-diff-note">Untracked file: not in git yet, content not shown.</p>';
  if (file.binary) return '<p class="ad-diff-note">Binary file changed.</p>';
  if (!section && omitted) return '<p class="ad-diff-note">Diff not loaded in the whole-task view: select this item to see it.</p>';
  if (!section) return `<p class="ad-diff-note">${truncated ? "Diff not shown: the patch exceeds the display limit." : "No textual changes."}</p>`;
  const changed = section.some((line) => line.startsWith("@@"));
  return changed ? renderLines(section) : `${renderLines(section)}<p class="ad-diff-note">No textual changes (mode or metadata only).</p>`;
};

const renderItem = (item: ChangeItem, index: number, hidden: boolean): string => {
  const sections = patchSections(item.patch);
  const added = item.files.reduce((sum, file) => sum + file.added, 0);
  const removed = item.files.reduce((sum, file) => sum + file.removed, 0);
  const anchor = (fileIndex: number): string => `c-${index}-${fileIndex}`;
  const commit = item.commit ? `<code title="${escapeHtml(item.commit)}">${escapeHtml(item.commit.slice(0, 12))}</code>` : "";
  const base = item.base ? `<code title="${escapeHtml(item.base)}">${escapeHtml(item.base.slice(0, 12))}</code> → ` : "";
  const worker = item.workerId ? `<span class="ad-pill is-ghost" title="worker">${escapeHtml(item.workerId)}</span>` : "";
  const banner = item.patchOmitted
    ? `<div class="ad-callout is-info ad-changes-banner" data-changes-omitted><span aria-hidden="true">ℹ</span><span>Patch omitted: the whole-task view shows at most ${MAX_TASK_PATCH_BYTES / (1024 * 1024)} MiB of diff. Select this item to see it.</span></div>`
    : item.truncated
    ? `<div class="ad-callout ad-changes-banner" data-changes-truncated><span aria-hidden="true">⚠</span><span>Diff truncated: this item exceeds the display limit (${MAX_FILES} files or ${MAX_PATCH_BYTES / (1024 * 1024)} MiB of patch). ${item.commit ? `Inspect it locally with <code>git show ${escapeHtml(item.commit)}</code>.` : "Inspect it locally with git."}</span></div>`
    : "";
  const note = item.note ? `<div class="ad-callout is-info ad-changes-banner" data-changes-note><span aria-hidden="true">ℹ</span><span>${escapeHtml(item.note)}</span></div>` : "";
  const list = item.files.length
    ? `<ul>${item.files.map((file, fileIndex) => `<li><a href="#${anchor(fileIndex)}" data-changes-file>${statusBadge(file.status)}<span class="ad-diff-path" title="${escapeHtml(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)}">${escapeHtml(file.path)}</span>${file.binary ? '<span class="ad-diff-stat">binary</span>' : file.status === "untracked" ? "" : `<span class="ad-diff-stat"><span class="ad-diff-plus">+${file.added}</span> <span class="ad-diff-minus">−${file.removed}</span></span>`}</a></li>`).join("")}</ul>`
    : '<p class="ad-empty-line">No changed files.</p>';
  // Untracked files never have a patch section; tracked files keep git's order.
  let sectionIndex = 0;
  const blocks = item.files.map((file, fileIndex) => {
    const section = file.status === "untracked" ? undefined : sections[sectionIndex++];
    const head = `${statusBadge(file.status)}<code class="ad-diff-path">${file.oldPath ? `${escapeHtml(file.oldPath)} → ` : ""}${escapeHtml(file.path)}</code>`;
    return `<article class="ad-diff-file" id="${anchor(fileIndex)}"><header class="ad-diff-file-head">${head}</header>${fileBody(file, section, item.truncated, item.patchOmitted)}</article>`;
  }).join("");
  return `<section class="ad-panel ad-changes-item" data-change-item="${escapeHtml(item.itemId)}"${item.patchOmitted ? " data-patch-omitted" : ""}${hidden ? " hidden" : ""}>
  <header class="ad-panel-head"><h2>${escapeHtml(itemTitle(item))}</h2>${worker}<span class="ad-changes-commit">${base}${commit}</span><span class="ad-count ad-panel-tools">${item.files.length} file${item.files.length === 1 ? "" : "s"} · +${added} −${removed}</span></header>
  <div class="ad-panel-body is-flush">
    ${banner}${note}
    <div class="ad-changes">
      <nav class="ad-changes-files" aria-label="Changed files">${list}</nav>
      <div class="ad-changes-diff">${blocks || '<p class="ad-empty-line">Nothing to show.</p>'}</div>
    </div>
  </div>
</section>`;
};

const errorPage = (options: UiOptions, title: string, message: string, reviews: ReturnType<typeof reviewQueue>): string =>
  `${pageHead(`${title} · Loop`)}${renderHeader(options.root, uiMode(options), reviews)}<main class="section ad-main"><div class="container is-fluid"><div class="ad-empty"><div class="ad-empty-icon" aria-hidden="true">🔍</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><a class="button" href="/">← Back to dashboard</a></div></div></main>${renderModals()}${pageScripts("common")}</body></html>`;

/** The full changes page and its HTTP status (400 malformed id, 404 unknown task/item). */
export const renderChangesPage = async (options: UiOptions, taskId: string, itemId: string | null): Promise<{ status: number; html: string }> => {
  const state = await readUiState(options);
  const reviews = reviewQueue(state);
  if (itemId !== null && !ID_PATTERN.test(itemId)) return { status: 400, html: errorPage(options, "Invalid request", "Invalid item id", reviews) };
  // The page always renders every item; `?item=` only selects which one is visible.
  const result = await taskChanges(options, taskId, null, state, itemId);
  if (result.status !== 200) return { status: result.status, html: errorPage(options, result.status === 400 ? "Invalid request" : "Task not found", result.payload.error, reviews) };
  const { payload, task } = result;
  if (itemId !== null && !payload.items.some((item) => item.itemId === itemId)) return { status: 404, html: errorPage(options, "Item not found", `No changes recorded for item ${itemId}`, reviews) };
  const taskHref = `/tasks/${encodeURIComponent(task.id)}`;
  const itemOptions = payload.items.map((item) => `<option value="${escapeHtml(item.itemId)}"${item.itemId === itemId ? " selected" : ""}>${escapeHtml(itemTitle(item))}${item.workerId ? ` · ${escapeHtml(item.workerId)}` : ""}</option>`).join("");
  const selector = payload.items.length > 1 || itemId !== null
    ? `<form class="ad-changes-toolbar" method="get" action="${changesHref(task.id)}" data-changes-form>
      <label class="label is-small mb-0" for="changes-item">Show</label>
      <div class="select is-small"><select id="changes-item" name="item" data-changes-select><option value=""${itemId === null ? " selected" : ""}>Whole task</option>${itemOptions}</select></div>
      <button type="submit" class="button is-small" data-changes-submit>Apply</button>
    </form>`
    : "";
  const note = payload.note ? `<div class="ad-callout is-info ad-changes-banner" data-changes-note><span aria-hidden="true">ℹ</span><span>${escapeHtml(payload.note)}</span></div>` : "";
  const items = payload.items.length
    ? payload.items.map((item, index) => renderItem(item, index, itemId !== null && item.itemId !== itemId)).join("\n")
    : '<div class="ad-empty"><div class="ad-empty-icon" aria-hidden="true">∅</div><h2>No changes to show</h2><p>No commits are recorded for this task yet.</p></div>';
  const html = `${pageHead(`Changes · ${task.title} · Loop`, task.id)}
${renderHeader(options.root, uiMode(options), reviews, task.id)}
<main class="section ad-main">
  <div class="container is-fluid">
    <a class="ad-breadcrumb" href="${taskHref}">← Task</a>
    <h1 class="ad-page-title">Changes · ${escapeHtml(task.title)}</h1>
    <div class="ad-page-sub"><code>${escapeHtml(task.id)}</code>${statusPill(task.status, Boolean(task.handoff))}${gatePill(task.gate)}<span class="ad-pill is-ghost" data-changes-source="${payload.source}" title="where these changes come from">source · ${escapeHtml(SOURCE_LABEL[payload.source])}</span><a class="button is-small ml-auto" href="${taskHref}">Back to task</a></div>
    ${note}
    ${selector}
    ${items}
  </div>
</main>
${renderModals()}
${pageScripts("common", "changes", "live-log")}
</body>
</html>`;
  return { status: 200, html };
};
