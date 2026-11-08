/**
 * Page chrome shared by the dashboard and task pages: document head, live-region
 * wrappers, header (daemon pill, review bell), dialogs, and client script tags.
 */
import { createHash } from "node:crypto";
import type { WorkflowState } from "../../model.js";
import { scriptTag, stylesheetTag, type ClientScript } from "../assets.js";
import { daemonHealth, daemonStatus, type DaemonError } from "../daemon.js";
import { pendingFeedback } from "../data.js";
import { escapeHtml } from "../http.js";
import type { UiAuthorityMode } from "../options.js";
import { feedbackPill, gateLabel, pill, relativeTime } from "./components.js";

/** `task` marks a task detail page: live updates refresh that task's regions. The
 * inline head scripts apply the saved kanban/list view and the saved theme
 * (`localStorage["aidlc-settings"].theme`, see `assets/ui/common.js`) before first
 * paint; `system` leaves `data-theme` unset so the OS preference applies. */
export const pageHead = (title: string, task = ""): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="color-scheme" content="light dark">
${stylesheetTag("bulma")}
${stylesheetTag("dashboard")}
<script>try { document.documentElement.setAttribute("data-view", localStorage.getItem("aidlc-view") === "list" ? "list" : "kanban"); } catch (error) { /* storage disabled */ }</script>
<script>try { const theme = JSON.parse(localStorage.getItem("aidlc-settings") || "{}").theme; if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme); } catch (error) { /* storage disabled or malformed */ }</script>
</head>
<body${task ? ` data-task="${escapeHtml(task)}"` : ""} data-notify-page="${NOTIFY_PAGE}">`;

/** Classic `<script src>` tags in load order (`common` first; page scripts after it). */
export const pageScripts = (...names: ClientScript[]): string => names.map(scriptTag).join("\n");

/* ---------------------------------------------------------------------------
 * Live regions: server-rendered fragments the client polls and morphs in place.
 * Each region carries a content hash; `/api/live` returns only regions whose
 * hash differs from the one the client already shows.
 * ------------------------------------------------------------------------- */

/** Region names `/api/live` can render; anything else in `known` is ignored. */
export const LIVE_REGIONS = ["notify", "daemon", "board", "detail", "drawer"] as const;
export type LiveRegion = (typeof LIVE_REGIONS)[number];
export const regionHash = (html: string): string => createHash("sha1").update(html).digest("base64url").slice(0, 16);
/** Wrapper is `display: contents`, so it never affects layout (e.g. header flex items). */
export const liveRegion = (name: LiveRegion, html: string): string => `<div class="ad-live" data-live="${name}" data-live-hash="${regionHash(html)}">${html}</div>`;

/** Daemon state for the header: running/stopped, plus unresolved turn or poll
 * errors (from the event log) while it runs, so failures are not buried in logs. */
export const renderDaemonPill = (root: string): string => {
  const daemon = daemonStatus(root);
  if (!daemon.running) return `<span class="ad-pill is-ghost" data-daemon="stopped" title="start it with: aidlc-kit loop start (or New task)"><span class="ad-dot"></span>daemon stopped</span>`;
  const errors = daemonHealth(root);
  if (!errors.length) return `<span class="ad-pill is-success is-live" data-daemon="running" title="started ${escapeHtml(daemon.startedAt ?? "")}"><span class="ad-dot"></span>daemon running · pid ${daemon.pid}</span>`;
  const describe = (error: DaemonError): string => `${error.taskId ? `${error.taskId}: ` : "poll: "}${error.message}${error.retryInMs ? ` (retry in ${Math.round(error.retryInMs / 1000)}s)` : ""}`;
  const title = `daemon running · pid ${daemon.pid}\n${errors.map(describe).join("\n")}`;
  const label = `<span class="ad-dot"></span>daemon · ${errors.length} error${errors.length === 1 ? "" : "s"}`;
  const only = errors.length === 1 ? errors[0]?.taskId : undefined;
  return only
    ? `<a class="ad-pill is-warning is-live" data-daemon="error" href="/tasks/${encodeURIComponent(only)}" title="${escapeHtml(title)}">${label}</a>`
    : `<span class="ad-pill is-warning is-live" data-daemon="error" title="${escapeHtml(title)}">${label}</span>`;
};

/** A task waiting at a human gate (not handed off): shown as a header notification. */
export interface ReviewItem { id: string; title: string; gate: string; updatedAt?: string; feedbackPending: number }

/** Every task waiting at a human gate, newest first. Handed-off tasks follow their
 * handoff actions instead, and terminal (archived) tasks never wait at a gate. */
export const reviewQueue = (state: WorkflowState): ReviewItem[] =>
  Object.values(state.tasks)
    .filter((task) => task.status === "blocked_on_user" && task.gate !== "none" && !task.handoff)
    .map((task) => ({ id: task.id, title: task.title, gate: task.gate, updatedAt: task.updatedAt, feedbackPending: pendingFeedback(task).length }))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

/** Notifications shown at first; "Load more" adds this many at a time. The client
 * reads it from `<body data-notify-page>` (see pageHead). */
export const NOTIFY_PAGE = 5;
const NOTIFY_MAX = 100;
export const notifyLimit = (raw: string | null): number => {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(NOTIFY_MAX, Math.max(NOTIFY_PAGE, value)) : NOTIFY_PAGE;
};

/** Header bell: a count badge plus a dropdown whose items open the task detail
 * page (where gate feedback and approval live). Shows `limit` items and a
 * "Load more" button for the rest. The panel's `hidden` and the toggle's
 * `aria-expanded` are client state that live updates preserve. */
export const renderNotifications = (reviews: ReviewItem[], currentTask = "", limit = NOTIFY_PAGE): string => {
  const count = reviews.length;
  const shown = reviews.slice(0, limit);
  const remaining = count - shown.length;
  const label = count ? `${count} task${count === 1 ? "" : "s"} waiting for your review` : "Nothing waiting for your review";
  const items = count
    ? `<ul class="ad-notify-list">${shown.map((task) => `<li data-key="review:${escapeHtml(task.id)}"><a class="ad-notify-item" href="/tasks/${encodeURIComponent(task.id)}" data-review-item="${escapeHtml(task.id)}"${task.id === currentTask ? ' aria-current="page"' : ""}>
        <span class="ad-notify-row">${pill(gateLabel(task.gate), "is-warning", `gate: ${task.gate}`, false)}${task.feedbackPending ? feedbackPill(task.feedbackPending) : ""}<span class="ad-notify-time">${relativeTime(task.updatedAt)}</span></span>
        <span class="ad-notify-title">${escapeHtml(task.title)}</span>
        <code class="ad-notify-id">${escapeHtml(task.id)}</code>
      </a></li>`).join("")}</ul>${remaining > 0 ? `<button type="button" class="ad-notify-more" data-notify-more>Load more <span class="has-text-grey">(${remaining} more)</span></button>` : ""}`
    : '<p class="ad-notify-empty">Nothing waiting for your review.</p>';
  return `<div class="ad-notify" data-notify>
      <button type="button" class="button is-small ad-notify-toggle${count ? " has-reviews" : ""}" id="notify-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="notify-panel" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" data-live-preserve="aria-expanded">
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 1.5 5.5h-13S5 12 5 8Z"/><path d="M8.5 16.5a1.6 1.6 0 0 0 3 0"/></svg>
        ${count ? `<span class="ad-notify-badge" data-review-count="${count}">${count}</span>` : ""}
      </button>
      <div class="ad-notify-panel" id="notify-panel" role="region" aria-label="Needs your review" hidden data-live-preserve="hidden">
        <header class="ad-notify-head"><strong>Needs your review</strong><span class="ad-count">${count}</span></header>
        ${items}
      </div>
    </div>`;
};

export const renderHeader = (root: string, mode: UiAuthorityMode = "local", reviews: ReviewItem[] = [], currentTask = ""): string => `<header class="ad-header">
  <div class="container is-fluid ad-header-inner">
    <a class="ad-brand" href="/" title="Loop · AI-DLC dashboard"><span class="ad-logo" aria-hidden="true">L</span>Loop</a>
    <span class="ad-pill ${mode === "fleet" ? "is-link" : "is-ghost"}" data-authority="${mode}" title="${mode === "fleet" ? "Canonical state lives in the coordination service" : "Canonical state lives in this checkout"}">authority · ${mode}</span>
    ${liveRegion("daemon", renderDaemonPill(root))}
    <span id="live-status" class="ad-pill is-warning" role="status" title="Live updates paused: the dashboard server is unreachable; retrying" hidden><span class="ad-dot"></span>reconnecting…</span>
    <div class="ad-header-actions">
      ${liveRegion("notify", renderNotifications(reviews, currentTask))}
      <a class="button is-small" href="/docs" title="Guides: setup, configuration, commands, troubleshooting">?<span class="ad-hide-mobile ml-1">Docs</span></a>
      <button class="button is-small" data-open="settings-modal" title="Settings">⚙<span class="ad-hide-mobile ml-1">Settings</span></button>
      <button class="button is-small is-primary" data-open="new-task-drawer">＋ New task<kbd class="ad-hide-mobile">N</kbd></button>
    </div>
  </div>
</header>`;

/** Settings dialog: client-side preferences stored in this browser (`aidlc-settings`,
 * see `assets/ui/common.js` `aidlcSettings`). The form is read and written by the
 * client; every control id is `settings-<key>`. */
export const renderModals = (): string => `
<div id="settings-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
  <div class="modal-background" data-close></div>
  <div class="modal-card">
    <header class="modal-card-head">
      <p class="modal-card-title" id="settings-title">Settings</p>
      <button class="delete" aria-label="close" data-close></button>
    </header>
    <section class="modal-card-body">
      <form id="settings-form" class="ad-settings" novalidate>
        <fieldset class="ad-settings-group">
          <legend class="label">Appearance</legend>
          <div class="field">
            <div class="control ad-settings-radios" role="radiogroup" aria-label="Theme">
              <label class="radio"><input type="radio" name="settings-theme" id="settings-theme-system" value="system" data-autofocus> System</label>
              <label class="radio"><input type="radio" name="settings-theme" id="settings-theme-light" value="light"> Light</label>
              <label class="radio"><input type="radio" name="settings-theme" id="settings-theme-dark" value="dark"> Dark</label>
            </div>
            <p class="help">System follows the operating system's light/dark preference.</p>
          </div>
        </fieldset>
        <fieldset class="ad-settings-group">
          <legend class="label">Live updates</legend>
          <div class="field">
            <label class="label is-small" for="settings-livePoll">Refresh every</label>
            <div class="control"><div class="select is-small"><select id="settings-livePoll"><option value="1500">1.5 seconds</option><option value="3000">3 seconds</option><option value="0">Paused</option></select></div></div>
            <p class="help">How often the page asks the server for changes. Paused keeps the page as it is until you reload or change this.</p>
          </div>
          <div class="field">
            <label class="checkbox"><input type="checkbox" id="settings-notify"> Browser notification when a task waits for your review</label>
            <p class="help" id="settings-notify-state"></p>
          </div>
        </fieldset>
        <fieldset class="ad-settings-group">
          <legend class="label">Live log</legend>
          <div class="field">
            <label class="label is-small" for="settings-logFilter">Default filter</label>
            <div class="control"><div class="select is-small"><select id="settings-logFilter"><option value="important">Important</option><option value="all">All events</option></select></div></div>
          </div>
          <div class="field">
            <label class="checkbox"><input type="checkbox" id="settings-logRaw"> Show raw JSON by default</label>
            <p class="help">Used when a page has no log preference of its own yet.</p>
          </div>
        </fieldset>
        <fieldset class="ad-settings-group">
          <legend class="label">Code changes</legend>
          <div class="field">
            <label class="checkbox"><input type="checkbox" id="settings-diffWrap"> Wrap long lines</label>
          </div>
          <div class="field">
            <label class="checkbox"><input type="checkbox" id="settings-diffIgnoreWs"> Ignore whitespace changes</label>
          </div>
        </fieldset>
        <fieldset class="ad-settings-group">
          <legend class="label">Containers</legend>
          <div class="field">
            <label class="label is-small" for="settings-logTailKb">Container log tail</label>
            <div class="control"><div class="select is-small"><select id="settings-logTailKb"><option value="64">64 KiB</option><option value="256">256 KiB</option><option value="1024">1024 KiB</option></select></div></div>
          </div>
        </fieldset>
        <fieldset class="ad-settings-group">
          <legend class="label">Board</legend>
          <div class="field">
            <label class="label is-small" for="settings-openCards">Clicking a card opens</label>
            <div class="control"><div class="select is-small"><select id="settings-openCards"><option value="panel">The side panel</option><option value="page">The task page</option></select></div></div>
            <p class="help">Ctrl/Cmd-click and middle-click always open the task page in a new tab; shift-click in this tab.</p>
          </div>
        </fieldset>
      </form>
    </section>
    <footer class="modal-card-foot">
      <span class="ad-foot-start">Stored in this browser only</span>
      <button type="button" id="settings-reset" class="button is-light">Reset to defaults</button>
      <button type="button" id="settings-save" class="button is-primary">Save</button>
    </footer>
  </div>
</div>
<div id="new-task-drawer" class="ad-drawer is-compose" role="dialog" aria-modal="true" aria-labelledby="new-task-title" hidden>
  <div class="ad-drawer-backdrop" data-drawer-close></div>
  <aside class="ad-drawer-panel" tabindex="-1">
    <header class="ad-drawer-head">
      <h2 id="new-task-title" class="ad-drawer-heading">New task</h2>
      <button type="button" class="delete" aria-label="Close the new task panel" data-drawer-close></button>
    </header>
    <div class="ad-drawer-body">
      <p class="ad-compose-intro">Describe the feature, bug fix, or change. The first line becomes the task title; the loop creates the task and starts the daemon if it is not running.</p>
      <div class="ad-editor" data-editor>
        <div class="ad-editor-bar">
          <div class="ad-editor-tabs" role="tablist" aria-label="Editor mode">
            <button type="button" role="tab" id="new-task-tab-write" aria-selected="true" aria-controls="new-task-requirement" data-editor-tab="write">Write</button>
            <button type="button" role="tab" id="new-task-tab-preview" aria-selected="false" aria-controls="new-task-preview" data-editor-tab="preview">Preview</button>
          </div>
          <div class="ad-editor-tools" role="toolbar" aria-label="Formatting"><button type="button" class="ad-editor-tool" data-md="heading" title="Heading" aria-label="Heading">H</button><button type="button" class="ad-editor-tool" data-md="bold" title="Bold (Ctrl+B)" aria-label="Bold"><b>B</b></button><button type="button" class="ad-editor-tool" data-md="italic" title="Italic (Ctrl+I)" aria-label="Italic"><i>I</i></button><button type="button" class="ad-editor-tool" data-md="code" title="Inline code" aria-label="Inline code">&lt;/&gt;</button><button type="button" class="ad-editor-tool" data-md="codeblock" title="Code block" aria-label="Code block">{ }</button><button type="button" class="ad-editor-tool" data-md="ul" title="Bulleted list" aria-label="Bulleted list">•≡</button><button type="button" class="ad-editor-tool" data-md="ol" title="Numbered list" aria-label="Numbered list">1≡</button><button type="button" class="ad-editor-tool" data-md="quote" title="Quote" aria-label="Quote">❝</button><button type="button" class="ad-editor-tool" data-md="link" title="Link (Ctrl+K)" aria-label="Link">🔗</button></div>
        </div>
        <label class="is-sr-only" for="new-task-requirement">Requirement (Markdown)</label>
        <textarea id="new-task-requirement" class="ad-editor-input" rows="16" spellcheck="true" placeholder="Short title on the first line&#10;&#10;What should change, why, and how to tell it works. Markdown is supported." data-autofocus></textarea>
        <div id="new-task-preview" class="ad-editor-preview content artifact" role="tabpanel" aria-labelledby="new-task-tab-preview" hidden></div>
      </div>
      <div class="ad-field-hint"><span>Markdown · <kbd>Ctrl</kbd>+<kbd>B</kbd> <kbd>I</kbd> <kbd>K</kbd> · the draft is kept in this browser</span><span id="new-task-count">0 / 8192 bytes</span></div>
    </div>
    <footer class="ad-drawer-foot">
      <span class="ad-foot-start"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to create</span>
      <button type="button" class="button" data-drawer-close>Cancel</button>
      <button type="button" id="new-task-submit" class="button is-primary">Create task</button>
    </footer>
  </aside>
</div>
<div id="task-drawer" class="ad-drawer" role="dialog" aria-modal="true" aria-labelledby="task-drawer-title" hidden>
  <div class="ad-drawer-backdrop" data-drawer-close></div>
  <aside class="ad-drawer-panel" tabindex="-1">
    <header class="ad-drawer-head">
      <button type="button" id="task-drawer-title" class="ad-copy ad-drawer-id" data-copy="" title="Copy task ID"><code>Task</code><svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/></svg></button>
      <a id="task-drawer-open" class="button is-small" href="#" target="_blank" rel="noopener">Open full page ↗</a>
      <button type="button" class="delete" aria-label="Close task panel" data-drawer-close></button>
    </header>
    <div class="ad-drawer-body" id="task-drawer-body" data-live="drawer" data-live-hash=""><p class="has-text-grey">Loading…</p></div>
  </aside>
</div>
<div id="toasts" class="ad-toasts" aria-live="polite"></div>`;
