/*
 * Task detail page: gate feedback and approval. Handlers are delegated (the
 * controls are re-rendered by live updates) and read the task and gate from the
 * current DOM, never from values baked in at page load. Loaded after common.js.
 */
const detailTask = () => document.body.getAttribute("data-task") || "";
// Feedback: keeps the task at this gate; the lead revises and re-presents it.
const onFeedbackSend = (button) => {
  const panel = document.getElementById("feedback-panel");
  const field = document.getElementById("feedback");
  const result = document.getElementById("feedback-result");
  if (!panel || !field) return;
  if (result) result.textContent = "";
  if (!field.value.trim()) { toast("Write the feedback first", "warning", "It is sent to the loop lead as guidance; the task stays at this gate."); field.focus(); return; }
  const label = panel.getAttribute("data-gate-label") || "";
  withLoading(button, async () => {
    const res = await post("/api/gate/feedback", { taskId: detailTask(), feedback: field.value });
    if (res.status >= 200 && res.status < 300) {
      field.value = "";
      toast("Feedback sent — task stays at " + label, "success", "The lead will revise the review artifact and re-present this gate.");
      await liveRefresh();
    } else failureToast(res, "Feedback failed");
  });
};
// Approve: the button only opens the confirmation dialog; "Confirm approve" sends.
const onApproveOpen = () => {
  const note = document.getElementById("source");
  const result = document.getElementById("approve-result");
  if (!note) return;
  if (result) result.textContent = "";
  if (!note.value.trim()) { toast("Add an approval note first", "warning", "It is recorded as the approval source. To request changes, use Feedback instead."); note.focus(); return; }
  const quote = document.getElementById("approve-modal-note");
  if (quote) quote.textContent = note.value.trim();
  openModal("approve-modal");
};
const onApproveConfirm = (button) => {
  const panel = document.getElementById("approve-panel");
  const note = document.getElementById("source");
  if (!panel || !note) return;
  const gate = panel.getAttribute("data-gate") || "";
  const label = panel.getAttribute("data-gate-label") || gate;
  withLoading(button, async () => {
    // The gate shown is sent along; the server refuses if the task has moved on since.
    const res = await post("/api/gate/approve", { taskId: detailTask(), gate, source: note.value });
    closeAllModals();
    if (res.status >= 200 && res.status < 300) {
      const next = res.body && res.body.result && res.body.result.nextAction;
      note.value = "";
      toast("Approved " + label, "success", next && next.classification ? "Next: " + next.classification + (next.phase ? " · " + next.phase : "") : "");
      await liveRefresh();
    } else failureToast(res, "Approval failed");
  });
};
/* ---- Container log viewer (Containers panel) -------------------------------
 * The viewer (#container-log, [data-live-ignore]) is client-owned: a Log button
 * fetches the raw tail of that assignment's log and, while Follow is on and the row
 * still reports the container as running, re-fetches at the Settings live interval
 * (fallback 1.5 s; never while polling is paused). The running state is read from
 * the row's button on every tick, which live updates keep current. */
const containerLog = { assignment: "", timer: 0, inflight: null, follow: true };
const containerViewer = () => document.getElementById("container-log");
const containerSettings = () => (window.aidlcSettings && window.aidlcSettings.get()) || {};
const containerInterval = () => { const value = Number(containerSettings().livePoll); return Number.isFinite(value) ? value : 1500; };
const containerButton = () => {
  if (!containerLog.assignment) return null;
  for (const button of document.querySelectorAll("[data-container-log]")) if (button.getAttribute("data-container-log") === containerLog.assignment) return button;
  return null;
};
const containerRunning = () => { const button = containerButton(); return !!button && button.getAttribute("data-container-running") === "1"; };
const fetchContainerLog = async () => {
  const el = containerViewer();
  if (!el || !containerLog.assignment) return;
  if (containerLog.inflight) return containerLog.inflight;
  const assignment = containerLog.assignment;
  containerLog.inflight = (async () => {
    const body = el.querySelector("[data-container-log-body]");
    const state = el.querySelector("[data-container-log-state]");
    try {
      const kb = Number(containerSettings().logTailKb) || 64;
      const url = "/api/tasks/" + encodeURIComponent(detailTask()) + "/containers/" + encodeURIComponent(assignment) + "/log?tail=" + (kb * 1024);
      const response = await fetch(url, { cache: "no-store" });
      const text = await response.text();
      if (assignment !== containerLog.assignment) return;
      if (!response.ok) { if (body) body.textContent = text || ("HTTP " + response.status); if (state) state.textContent = "unavailable"; return; }
      const atBottom = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 8 : false;
      if (body) body.textContent = text || "(no output yet)";
      const size = Number(response.headers.get("x-aidlc-log-size")) || 0;
      if (state) state.textContent = (size >= 1024 ? Math.round(size / 1024) + " KiB" : size + " B") + (response.headers.get("x-aidlc-log-truncated") === "1" ? " · tail" : "") + (containerRunning() ? " · running" : " · ended");
      if (body && (containerLog.follow || atBottom)) body.scrollTop = body.scrollHeight;
    } catch (error) {
      if (state) state.textContent = "unreachable";
    } finally { containerLog.inflight = null; }
  })();
  return containerLog.inflight;
};
const scheduleContainerLog = () => {
  clearTimeout(containerLog.timer);
  containerLog.timer = 0;
  const el = containerViewer();
  if (!el || el.hidden || !containerLog.assignment || !containerLog.follow) return;
  const interval = containerInterval();
  if (!interval) return; // live updates paused in Settings
  if (!containerRunning()) return; // the container ended: the last fetch was final
  containerLog.timer = setTimeout(async () => { await fetchContainerLog(); scheduleContainerLog(); }, interval);
};
const openContainerLog = (button) => {
  const el = containerViewer();
  if (!el) return;
  containerLog.assignment = button.getAttribute("data-container-log") || "";
  containerLog.follow = true;
  const name = el.querySelector("[data-container-log-name]");
  if (name) name.textContent = (button.getAttribute("data-container-name") || containerLog.assignment) + " · " + containerLog.assignment;
  const follow = el.querySelector("[data-container-follow]");
  if (follow) follow.setAttribute("aria-pressed", "true");
  const body = el.querySelector("[data-container-log-body]");
  if (body) body.textContent = "loading…";
  el.hidden = false;
  el.scrollIntoView({ block: "nearest" });
  fetchContainerLog().then(scheduleContainerLog);
};
const closeContainerLog = () => {
  const el = containerViewer();
  clearTimeout(containerLog.timer);
  containerLog.timer = 0;
  containerLog.assignment = "";
  if (el) el.hidden = true;
};
const toggleContainerFollow = (button) => {
  containerLog.follow = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", containerLog.follow ? "true" : "false");
  if (containerLog.follow) fetchContainerLog().then(scheduleContainerLog); else scheduleContainerLog();
};
if (window.aidlcSettings) window.aidlcSettings.onChange((settings, changed) => { if (changed.includes("livePoll")) scheduleContainerLog(); });
// A live update that re-renders the row (container ended) stops the follow loop on the next tick.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const el = containerViewer();
  if (!el || el.hidden) return;
  // common.js answers Escape for the notifications dropdown, modals, and the side panel first.
  if (typeof notifyOpen === "function" && notifyOpen()) return;
  if (typeof modalOpen === "function" && modalOpen()) return;
  if (typeof drawerOpen === "function" && drawerOpen()) return;
  closeContainerLog();
});

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const feedback = target.closest("#feedback-button");
  if (feedback) { onFeedbackSend(feedback); return; }
  if (target.closest("#approve-button")) { onApproveOpen(); return; }
  const confirm = target.closest("#approve-confirm");
  if (confirm) { onApproveConfirm(confirm); return; }
  const log = target.closest("[data-container-log]");
  if (log && !log.disabled) { openContainerLog(log); return; }
  const follow = target.closest("[data-container-follow]");
  if (follow) { toggleContainerFollow(follow); return; }
  if (target.closest("[data-container-close]")) closeContainerLog();
});
