import type { WorkflowState } from "../../model.js";
import { listTaskSummaries } from "../../state.js";
import { pendingFeedback, readUiState } from "../data.js";
import { escapeHtml } from "../http.js";
import { uiMode, type UiOptions } from "../options.js";
import { feedbackPill, gateLabel, gatePill, PHASES, phaseSteps, relativeTime, RISK_TONE, riskPill, STATUS_META, statusPill } from "./components.js";
import { liveRegion, pageHead, pageScripts, renderHeader, renderModals, reviewQueue } from "./layout.js";

/* ---------------------------------------------------------------------------
 * Dashboard: filters, kanban (default) + list toggle. The header (notifications,
 * daemon pill) lives in ./layout.ts.
 * ------------------------------------------------------------------------- */

interface CardTask { id: string; title: string; phase: string; gate: string; status: string; risk: string; areas: string[]; updatedAt?: string; feedbackPending?: number }

/** Per-status action: a paused task can be re-activated for the daemon; a task
 * waiting at a human gate links to the detail page that hosts gate approval. */
const taskAction = (task: { id: string; status: string }, handedOff = false): string => {
  if (handedOff) return `<a class="button is-small is-danger ad-soft" href="/tasks/${encodeURIComponent(task.id)}" title="handed off: follow the handoff actions">handoff</a>`;
  if (task.status === "paused") return `<button class="button is-small is-link ad-soft" data-resume="${escapeHtml(task.id)}">resume</button>`;
  if (task.status === "blocked_on_user") return `<a class="button is-small is-warning" href="/tasks/${encodeURIComponent(task.id)}" title="open the review: send feedback or approve">review</a>`;
  return "";
};

/** Upper bound on dashboard cards (matches the `listTaskSummaries` page cap). */
const DASHBOARD_LIMIT = 100;

/** Lower-cased haystack for client-side search (escaped when rendered). */
const searchText = (task: CardTask): string =>
  [task.id, task.title, task.phase, task.gate, gateLabel(task.gate), task.status, STATUS_META[task.status]?.label ?? "", task.risk, ...task.areas].join(" ").toLowerCase();

const itemAttrs = (task: CardTask, handedOff: boolean): string =>
  `data-task-item data-task-id="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status)}" data-risk="${escapeHtml(task.risk)}"${handedOff ? ' data-handoff="true"' : ""} data-search="${escapeHtml(searchText(task))}"`;

/** Statuses a kanban column cannot express (the column already says the phase, and
 * "needs review" is the card's attention ring plus its review button). */
const CARD_FLAG_STATUSES = new Set(["paused", "closed", "superseded"]);
const cardFlag = (status: string, handedOff: boolean): string =>
  handedOff || CARD_FLAG_STATUSES.has(status) ? statusPill(status, handedOff) : "";

/** Kanban card: the title leads; the column is the phase, so no id, phase bar, gate, or
 * routine status badge. The whole card is a click target (`data-card-href`): a plain
 * click opens the side panel, ctrl/cmd/middle-click a new tab, shift-click this tab. */
const renderTaskCard = (task: CardTask, handedOff = false): string => {
  const href = `/tasks/${encodeURIComponent(task.id)}`;
  const attention = task.status === "blocked_on_user" && !handedOff;
  const meta = [cardFlag(task.status, handedOff), task.risk !== "normal" ? riskPill(task.risk) : "", feedbackPill(task.feedbackPending ?? 0)].join("");
  return `<article class="ad-card${attention ? " is-attention" : ""}" data-key="card:${escapeHtml(task.id)}" data-card-href="${href}" ${itemAttrs(task, handedOff)}>
    <div class="ad-card-title"><a href="${href}" data-task-link="${escapeHtml(task.id)}" title="${escapeHtml(task.id)}">${escapeHtml(task.title)}</a></div>
    ${meta ? `<div class="ad-card-meta">${meta}</div>` : ""}
    <div class="ad-card-foot"><span class="ad-areas" title="areas: ${escapeHtml(task.areas.join(", "))}">${escapeHtml(task.areas.join(", "))}</span>${task.updatedAt ? `<span>· ${relativeTime(task.updatedAt)}</span>` : ""}${taskAction(task, handedOff)}</div>
  </article>`;
};

/** List row: the title is the link (id on hover); the id column is gone. */
const renderListRow = (task: CardTask, handedOff: boolean): string => `<tr data-key="row:${escapeHtml(task.id)}" data-card-href="/tasks/${encodeURIComponent(task.id)}" ${itemAttrs(task, handedOff)}>
  <td class="has-text-weight-semibold ad-row-title"><a href="/tasks/${encodeURIComponent(task.id)}" data-task-link="${escapeHtml(task.id)}" title="${escapeHtml(task.id)}">${escapeHtml(task.title)}</a></td>
  <td><div class="is-size-7 mb-1">${escapeHtml(task.phase)}</div>${phaseSteps(task.phase)}</td>
  <td>${gatePill(task.gate) || '<span class="has-text-grey">—</span>'}</td>
  <td>${statusPill(task.status, handedOff)}${feedbackPill(task.feedbackPending ?? 0)}</td>
  <td>${riskPill(task.risk)}</td>
  <td class="is-size-7">${escapeHtml(task.areas.join(", "))}</td>
  <td class="is-size-7 has-text-grey">${relativeTime(task.updatedAt)}</td>
  <td class="has-text-right">${taskAction(task, handedOff)}</td>
</tr>`;

const renderToolbar = (): string => `<div class="ad-toolbar">
  <div class="ad-search">
    <svg class="ad-search-icon" aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
    <input id="task-search" class="input" type="search" placeholder="Search title, id, area…" aria-label="Search tasks" autocomplete="off">
    <kbd>/</kbd>
  </div>
  <div class="select"><select id="filter-status" aria-label="Filter by status">
    <option value="">All statuses</option>
    ${Object.entries(STATUS_META).map(([value, meta]) => `<option value="${value}">${escapeHtml(meta.label)}</option>`).join("")}
  </select></div>
  <div class="select"><select id="filter-risk" aria-label="Filter by risk">
    <option value="">Any risk</option>
    ${Object.keys(RISK_TONE).map((risk) => `<option value="${risk}">${risk}</option>`).join("")}
  </select></div>
  <div class="ad-toolbar-end">
    <span id="result-count" class="ad-result-count" aria-live="polite"></span>
    <div class="ad-segmented" role="group" aria-label="View">
      <button type="button" data-view-toggle="kanban" aria-pressed="true">▦ Kanban</button>
      <button type="button" data-view-toggle="list" aria-pressed="false">☰ List</button>
    </div>
  </div>
</div>`;

/** The done column shows this many cards until "Show more" (or a filter) reveals the rest. */
export const DONE_COLUMN_LIMIT = 8;

/** Toolbar, kanban, and list (or the empty state): the dashboard's `board` live region. */
export const renderBoard = (state: WorkflowState): string => {
  /* Terminal tasks (done/closed/superseded) are moved to the archive catalog on
   * save; list them too so they survive a reload. Active tasks keep priority
   * within the display limit; archived ones fill the remaining room. */
  const active = listTaskSummaries(state, { limit: DASHBOARD_LIMIT }).items;
  const archived = active.length < DASHBOARD_LIMIT
    ? listTaskSummaries({ ...state, tasks: {} }, { includeArchive: true, limit: DASHBOARD_LIMIT - active.length }).items
    : [];
  const items: CardTask[] = [...active, ...archived].map((task) => {
    const full = state.tasks[task.id];
    return full ? { ...task, feedbackPending: pendingFeedback(full).length } : task;
  });
  const handedOff = new Set(Object.values(state.tasks).filter((task) => task.handoff).map((task) => task.id));

  if (!items.length) return `<div class="ad-empty">
      <div class="ad-empty-icon" aria-hidden="true">🌱</div>
      <h2>No tasks yet</h2>
      <p>Describe a requirement and the loop will create the task and drive it through clarify → plan → build → wrap.</p>
      <button class="button is-primary" data-open="new-task-drawer">＋ New task</button>
    </div>`;

  const kanban = PHASES.map((phase, index) => {
    const tasks = items.filter((task) => task.phase === phase);
    const cards = tasks.map((task) => renderTaskCard(task, handedOff.has(task.id))).join("\n");
    // The client hides cards past the limit (unless expanded or filtering) and labels the button.
    const collapse = phase === "done" ? ` data-collapse="${DONE_COLUMN_LIMIT}"` : "";
    const more = phase === "done" ? `<button type="button" class="ad-column-more" data-column-more${tasks.length > DONE_COLUMN_LIMIT ? "" : " hidden"}>Show ${Math.max(0, tasks.length - DONE_COLUMN_LIMIT)} more</button>` : "";
    return `<section class="ad-column" data-key="column:${phase}" data-phase-column="${phase}"${collapse}>
      <header class="ad-column-head"><span class="ad-step-index">${index + 1}</span><span class="ad-column-title">${escapeHtml(phase)}</span><span class="ad-count" data-column-count>${tasks.length}</span></header>
      <div class="ad-column-body">${cards}<p class="ad-column-empty" data-column-empty${tasks.length ? " hidden" : ""}>No tasks</p>${more}</div>
    </section>`;
  }).join("\n");

  const rows = items.map((task) => renderListRow(task, handedOff.has(task.id))).join("\n");

  return `${renderToolbar()}
    <div id="kanban-view"><div class="ad-board">${kanban}</div></div>
    <div id="list-view">
      <div class="ad-table-wrap"><table class="table ad-table is-fullwidth">
        <thead><tr><th>title</th><th>phase</th><th>gate</th><th>status</th><th>risk</th><th>areas</th><th>updated</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <p class="ad-no-match" data-no-match>No tasks match the current filters. <button type="button" id="filter-clear" class="button is-small is-text">Clear filters</button></p>`;
};

export const renderDashboard = async (options: UiOptions): Promise<string> => {
  const state = await readUiState(options);
  return `${pageHead("Loop")}
${renderHeader(options.root, uiMode(options), reviewQueue(state))}
<main class="section ad-main">
  <div class="container is-fluid">
    ${liveRegion("board", renderBoard(state))}
    <p class="ad-help">Click a card to open it in the side panel; ctrl/cmd-click or middle-click opens the full page in a new tab, shift-click in this tab. "New task" creates a loop-owned task and starts the daemon if it is not running; "resume" re-activates a paused task. The bell in the header lists tasks waiting at a human gate; pick one to open its detail page, where gate feedback and approval live (also on the trusted terminal <code>node .agents/aidlc/scripts/loop-gate.mjs &lt;task-id&gt;</code>). The page updates itself as the loop advances. Shortcuts: <kbd>N</kbd> new task · <kbd>/</kbd> search · <kbd>Esc</kbd> close panel or dialog. Setup and usage guides: <a href="/docs">Docs</a>.</p>
  </div>
</main>
${renderModals()}
${pageScripts("common", "dashboard", "live-log")}
</body>
</html>`;
};
