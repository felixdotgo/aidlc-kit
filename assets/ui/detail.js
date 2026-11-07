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
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const feedback = target.closest("#feedback-button");
  if (feedback) { onFeedbackSend(feedback); return; }
  if (target.closest("#approve-button")) { onApproveOpen(); return; }
  const confirm = target.closest("#approve-confirm");
  if (confirm) onApproveConfirm(confirm);
});
