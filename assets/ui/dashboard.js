/*
 * Loop dashboard page: kanban/list view toggle, client-side filters, and the
 * collapsible done column. Loaded after common.js (uses its `live` hooks).
 */
/* ---- Dashboard view state (re-applied after every live update) ---- */
const viewKey = "aidlc-view";
const applyView = (view) => {
  document.documentElement.setAttribute("data-view", view === "list" ? "list" : "kanban");
  document.querySelectorAll("[data-view-toggle]").forEach((el) => {
    const active = el.getAttribute("data-view-toggle") === view;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-pressed", String(active));
  });
};
const currentView = () => (localStorage.getItem(viewKey) === "list" ? "list" : "kanban");
const expandedColumns = new Set();
// Client-side filtering over server-rendered cards and rows (no extra API calls).
// Columns with data-collapse show that many cards unless expanded or filtering.
const applyFilter = () => {
  const search = document.getElementById("task-search");
  const statusFilter = document.getElementById("filter-status");
  const riskFilter = document.getElementById("filter-risk");
  const resultCount = document.getElementById("result-count");
  const terms = (search ? search.value : "").toLowerCase().split(/\s+/).filter(Boolean);
  const status = statusFilter ? statusFilter.value : "";
  const risk = riskFilter ? riskFilter.value : "";
  const filtered = !!(terms.length || status || risk);
  const matches = (el) => (!status || el.getAttribute("data-status") === status) && (!risk || el.getAttribute("data-risk") === risk) && terms.every((term) => (el.getAttribute("data-search") || "").includes(term));
  let visible = 0;
  document.querySelectorAll("#kanban-view [data-task-item]").forEach((el) => { const show = matches(el); el.hidden = !show; if (show) visible += 1; });
  document.querySelectorAll("#list-view [data-task-item]").forEach((el) => { el.hidden = !matches(el); });
  document.querySelectorAll("[data-phase-column]").forEach((column) => {
    const shown = [...column.querySelectorAll("[data-task-item]")].filter((el) => !el.hidden);
    const limit = Number(column.getAttribute("data-collapse") || 0);
    const expanded = expandedColumns.has(column.getAttribute("data-phase-column"));
    const extra = limit && !filtered ? Math.max(0, shown.length - limit) : 0;
    if (extra && !expanded) shown.slice(limit).forEach((el) => { el.hidden = true; });
    const more = column.querySelector("[data-column-more]");
    if (more) { more.hidden = extra === 0; more.textContent = expanded ? "Show less" : "Show " + extra + " more"; more.setAttribute("aria-expanded", String(expanded)); }
    const badge = column.querySelector("[data-column-count]");
    if (badge) badge.textContent = String(shown.length);
    const empty = column.querySelector("[data-column-empty]");
    if (empty) empty.hidden = shown.length > 0;
  });
  const total = document.querySelectorAll("#kanban-view [data-task-item]").length;
  if (resultCount) resultCount.textContent = filtered ? visible + " of " + total + " tasks" : total + (total === 1 ? " task" : " tasks");
  document.querySelectorAll("[data-no-match]").forEach((el) => el.classList.toggle("is-visible", filtered && visible === 0));
};
const clearFilters = () => {
  ["task-search", "filter-status", "filter-risk"].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
  applyFilter();
};
live.hooks.push(() => { applyView(currentView()); applyFilter(); });

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const viewToggle = target.closest("[data-view-toggle]");
  if (viewToggle) { const view = viewToggle.getAttribute("data-view-toggle"); localStorage.setItem(viewKey, view); applyView(view); return; }
  const columnMore = target.closest("[data-column-more]");
  if (columnMore) {
    const column = columnMore.closest("[data-phase-column]");
    const name = column ? column.getAttribute("data-phase-column") : "";
    if (expandedColumns.has(name)) expandedColumns.delete(name); else expandedColumns.add(name);
    applyFilter();
    return;
  }
  if (target.closest("#filter-clear")) { clearFilters(); return; }
});
document.addEventListener("input", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target && target.matches("#task-search, #filter-status, #filter-risk")) applyFilter();
});
document.addEventListener("DOMContentLoaded", () => {
  applyView(currentView());
  applyFilter();
});
