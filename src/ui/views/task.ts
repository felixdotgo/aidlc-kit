import type { TaskState, WorkflowState } from "../../model.js";
import { taskContainers, type ContainerEntry } from "../containers.js";
import { ARTIFACT_NAMES, artifactPayload, pendingFeedback, readUiState, readUiTask, taskGatePayload } from "../data.js";
import { escapeHtml } from "../http.js";
import { markdownToHtml } from "../markdown.js";
import { uiMode, type UiOptions } from "../options.js";
import { DECISION_TONE, feedbackPill, GATE_LABELS, gateLabel, gatePill, ITEM_TONE, phaseStepper, pill, relativeTime, renderGateViewHtml, RESULT_TONE, riskPill, statusPill } from "./components.js";
import { changesHref } from "./changes.js";
import { liveRegion, pageHead, pageScripts, renderHeader, renderModals, reviewQueue } from "./layout.js";

/* ---------------------------------------------------------------------------
 * Task detail (page and side-panel fragment share the same body).
 * ------------------------------------------------------------------------- */

/** The artifact a reviewer most likely needs at each gate opens by default. */
const GATE_ARTIFACT: Record<string, string> = { G0_confirm: "intent", G1_review: "design", G2_codereview: "workplan" };
/** Lines kept by the task page's live log and shown by the side panel's compact one. */
const FULL_LOG_LINES = 2000;
export const DRAWER_LOG_LINES = 20;

/** Task id as a copy-to-clipboard button (handled by the delegated \`[data-copy]\` click in common.js). */
export const copyIdButton = (id: string): string =>
  `<button type="button" class="ad-copy" data-copy="${escapeHtml(id)}" title="Copy task ID" aria-label="Copy task ID ${escapeHtml(id)}"><code>${escapeHtml(id)}</code><svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/></svg></button>`;

const panel = (title: string, body: string, extra = "", flush = false): string =>
  `<section class="ad-panel" data-key="panel:${escapeHtml(title)}"><header class="ad-panel-head"><h2>${escapeHtml(title)}</h2>${extra}</header><div class="ad-panel-body${flush ? " is-flush" : ""}">${body}</div></section>`;

/* ---------------------------------------------------------------------------
 * Containers panel (worker containers recorded under the task's runtime data)
 * ------------------------------------------------------------------------- */

const UUID_PATTERN = /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** `aidlc-worker-3f2a1b9c-…` → `3f2a1b9c`; names without a uuid are shown whole. */
export const shortContainerName = (name: string): string => UUID_PATTERN.exec(name)?.[1] ?? name;

/** `endedAt - startedAt` as `4s`, `3m 12s`, or `1h 05m`; empty when either timestamp is unusable. */
export const durationText = (startedAt: string | undefined, endedAt: string | undefined): string => {
  const start = Date.parse(startedAt ?? ""); const end = Date.parse(endedAt ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
};

const containerStatusPill = (entry: ContainerEntry): string => {
  if (entry.running) return pill("running", "is-success is-live", "the container is running");
  if (!entry.endedAt) return pill("unknown", "is-warning", "no end recorded and docker does not list the container");
  if (entry.exitCode === null || entry.exitCode === undefined) return pill("signal", "is-warning", "ended without an exit code (signal or finalized)");
  return pill(`exited ${entry.exitCode}`, entry.exitCode === 0 ? "is-ghost" : "is-danger", `exit code ${entry.exitCode}`);
};

/** The Containers panel: a table of the task's recorded worker containers (newest first) and the log viewer. */
export const renderContainersPanel = (entries: ContainerEntry[], docker: "ok" | "unavailable"): string => {
  const rows = [...entries].reverse().map((entry) => {
    const logButton = entry.local
      ? `<button type="button" class="button is-small" data-container-log="${escapeHtml(entry.assignmentId)}" data-container-name="${escapeHtml(entry.name)}" data-container-running="${entry.running ? "1" : "0"}" title="Show the raw container output">Log</button>`
      : `<button type="button" class="button is-small" disabled title="log is on another host">Log</button>`;
    return `<tr data-key="container:${escapeHtml(entry.name)}:${escapeHtml(String(entry.turn ?? ""))}">
      <td><code title="${escapeHtml(entry.name)}">${escapeHtml(shortContainerName(entry.name))}</code>${entry.local || !entry.host ? "" : `<div class="is-size-7 has-text-grey" title="recorded on another host">${escapeHtml(entry.host)}</div>`}</td>
      <td class="is-size-7">${escapeHtml(entry.workerId ?? "")}${entry.agent ? `<div class="has-text-grey">${escapeHtml(entry.agent)}</div>` : ""}</td>
      <td><code>${escapeHtml(entry.itemId ?? "")}</code></td>
      <td class="is-size-7">${entry.turn === undefined ? "" : escapeHtml(String(entry.turn))}</td>
      <td>${containerStatusPill(entry)}</td>
      <td class="is-size-7 has-text-grey">${relativeTime(entry.startedAt)}${entry.endedAt ? `<div title="duration">${escapeHtml(durationText(entry.startedAt, entry.endedAt))}</div>` : ""}</td>
      <td>${logButton}</td>
    </tr>`;
  });
  const table = rows.length
    ? `<table class="table ad-table is-fullwidth"><thead><tr>${["container", "worker", "item", "turn", "status", "started", ""].map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("\n")}</tbody></table>`
    : `<div class="ad-empty-line"><p>No worker containers recorded for this task</p><p class="is-size-7 mt-1">Containers appear here while the loop builds the task's work items; a task driven from the terminal without the loop never starts any.</p></div>`;
  /* The viewer is client-owned (detail.js): live updates never morph inside it, so an open log survives polling. */
  const viewer = `<section class="ad-terminal ad-container-log" id="container-log" data-live-ignore hidden>
    <div class="ad-terminal-head"><strong>Container log</strong><span class="ad-log-state" data-container-log-name></span><span class="ad-log-state" data-container-log-state></span>
      <div class="ad-terminal-tools"><button type="button" data-container-follow aria-pressed="true" title="Re-fetch the tail while the container runs">Follow</button><button type="button" data-container-close>Close</button></div>
    </div>
    <pre class="log-panel" data-container-log-body role="log" aria-live="off"></pre>
  </section>`;
  const tools = `<span class="ad-panel-tools">${pill(`docker · ${docker}`, docker === "ok" ? "is-ghost" : "is-warning", docker === "ok" ? "docker ps answers; running state is live" : "docker did not answer; running state follows the index only", false)}<span class="ad-count">${entries.length}</span></span>`;
  return panel("Containers", table + viewer, tools, true);
};

/**
 * Task detail body shared by the full page (`detail` live region), the side
 * panel (`fragment`, `drawer` live region), and `/api/live`. Undefined when the
 * task does not exist. Keyed panels (`id`/`data-key`) let the client morph them
 * in place: open artifacts, typed feedback, and the live log survive updates.
 */
export const renderTaskBody = async (options: UiOptions, state: WorkflowState, id: string, fragment: boolean, maxAgeMs = 0): Promise<{ task: TaskState; html: string } | undefined> => {
  const task = readUiTask(options, id, state);
  const fleet = uiMode(options) === "fleet";
  if (!task) return undefined;

  const waiting = task.status === "blocked_on_user" && task.gate !== "none";
  // A gate whose structural checks now fail (e.g. an artifact edited after the
  // wait was set) makes gateView throw; show the diagnostics instead of a 500.
  let gateBlock = "";
  // At code review the reviewer needs the diff: link the changes page from the gate panel.
  const gateChanges = task.gate === "G2_codereview"
    ? `<p class="mt-3"><a class="button is-small is-link is-light" href="${changesHref(task.id)}" data-changes-link="gate">View code changes →</a></p>`
    : "";
  if (waiting) {
    try {
      const gate = await taskGatePayload(options, id, state, maxAgeMs);
      if (gate.ok && gate.view) gateBlock = renderGateViewHtml(gate.view, gateChanges);
      else if (gate.ok && gate.snapshot) gateBlock = `<section class="ad-panel is-warning" data-key="gate-view"><header class="ad-panel-head"><h2>${escapeHtml(gateLabel(task.gate))} · review snapshot</h2><span class="ad-pill is-ghost ad-panel-tools">${escapeHtml(gate.snapshot.id ?? "")}</span></header><div class="ad-panel-body"><div class="content artifact">${markdownToHtml(gate.snapshot.reviewText ?? "")}</div>${gateChanges}</div></section>`;
      else if (fleet) gateBlock = `<section class="ad-panel is-warning" data-key="gate-view"><header class="ad-panel-head"><h2>${escapeHtml(gateLabel(task.gate))}</h2></header><div class="ad-panel-body"><p>${escapeHtml(gate.error ?? "No review snapshot yet")}</p></div></section>`;
    } catch (error) {
      const problems = (error instanceof Error ? error.message : String(error)).split("; ").filter(Boolean);
      gateBlock = `<section class="ad-panel is-danger" data-key="gate-view">
        <header class="ad-panel-head"><span aria-hidden="true">⚠</span><h2>${escapeHtml(gateLabel(task.gate))} · gate check failing</h2><span class="ad-pill is-danger ad-panel-tools">${escapeHtml(task.gate)}</span></header>
        <div class="ad-panel-body">
          <p class="mb-3">The task waits at this gate, but its structural checks no longer pass. Approval will be rejected until these are fixed:</p>
          <ul class="ad-plain-list">${problems.map((problem) => `<li>${pill("ERROR", "is-danger")} ${escapeHtml(problem)}</li>`).join("")}</ul>
          <p class="is-size-7 has-text-grey mt-3">Re-check with <code>node .agents/aidlc/scripts/gate-check.mjs ${escapeHtml(task.id)} --gate ${escapeHtml(task.gate)}</code>.</p>
        </div>
      </section>`;
    }
  }

  /* Pending feedback: `Cancelled gate wait` evidence with no later approval of
   * that gate. While the task is active the lead is revising for it; while it
   * waits again, the reviewer should check the revision reflects it. */
  const pending = pendingFeedback(task);
  const pendingBlock = !fragment && pending.length
    ? `<section class="ad-panel is-info" id="feedback-pending-panel">
        <header class="ad-panel-head"><h2>Feedback pending</h2><span class="ad-pill is-info ad-panel-tools">${pending.length}</span></header>
        <div class="ad-panel-body">
          <p class="mb-2">${waiting
            ? "This gate was re-presented after human feedback. Check that the review artifact reflects it before approving; approving records the feedback as handled."
            : "The task stays at its gate. The loop lead is revising the review artifact for this feedback and will re-present the same gate."}</p>
          <ul class="ad-plain-list">${pending.map((entry) => `<li>${pill(gateLabel(entry.gate), "is-info", `gate: ${entry.gate}`, false)} ${escapeHtml(entry.text)} <span class="is-size-7 has-text-grey">· ${relativeTime(entry.recordedAt)}</span></li>`).join("")}</ul>
        </div>
      </section>`
    : "";

  /* Feedback never needs the fleet reviewer credential (it never approves), so
   * the block renders in both modes whenever the task waits at a gate. */
  const feedbackBlock = !fragment && waiting
    ? `<section class="ad-panel is-info" id="feedback-panel" data-gate="${escapeHtml(task.gate)}" data-gate-label="${escapeHtml(gateLabel(task.gate))}">
        <header class="ad-panel-head"><h2>Feedback · ${escapeHtml(gateLabel(task.gate))}</h2><span class="ad-pill is-ghost ad-panel-tools">stays at this gate</span></header>
        <div class="ad-panel-body">
          <p class="mb-2">Not ready to approve? Send guidance back to the loop. The task stays at <strong>${escapeHtml(gateLabel(task.gate))}</strong>; the lead revises the review artifact and re-presents this gate.</p>
          <div class="field">
            <label class="label is-small" for="feedback">Feedback <span class="has-text-grey has-text-weight-normal">(required, sent to the loop lead)</span></label>
            <div class="control"><textarea id="feedback" class="textarea" rows="3" placeholder="e.g. the scope misses the fleet path; split item B; the assumption about X is wrong"></textarea></div>
          </div>
          <div class="is-flex is-align-items-center" style="gap:0.75rem">
            <button id="feedback-button" class="button is-info">✎ Send feedback (stay at gate)</button>
            <span id="feedback-result" class="help m-0" role="status"></span>
          </div>
        </div>
      </section>`
    : "";

  const approveBlock = !fragment && waiting && fleet && !options.reviewerToken
    ? `<section class="ad-panel" id="approve-panel">
        <header class="ad-panel-head"><h2>Approve · ${escapeHtml(gateLabel(task.gate))}</h2><span class="ad-pill is-ghost ad-panel-tools">${escapeHtml(task.gate)}</span></header>
        <div class="ad-panel-body">
          <p class="mb-2">This dashboard has no fleet reviewer credential. Approve from a reviewer terminal, or restart <code>aidlc-kit ui</code> with <code>AIDLC_FLEET_REVIEWER_TOKEN</code> or <code>--reviewer-token-file</code>. Feedback above needs no reviewer credential.</p>
          <pre class="is-size-7">node .agents/aidlc/scripts/remote-state.mjs gate inbox
node .agents/aidlc/scripts/remote-state.mjs gate approve ${escapeHtml(task.id)} --snapshot &lt;snapshot-id&gt; --source "&lt;explicit approval&gt;"</pre>
        </div>
      </section>`
    : !fragment && waiting
    ? `<section class="ad-panel is-success" id="approve-panel" data-gate="${escapeHtml(task.gate)}" data-gate-label="${escapeHtml(gateLabel(task.gate))}">
        <header class="ad-panel-head"><h2>Approve · ${escapeHtml(gateLabel(task.gate))}</h2><span class="ad-pill is-ghost ad-panel-tools">${escapeHtml(task.gate)}</span></header>
        <div class="ad-panel-body">
          <p class="mb-2">Approving moves the task to the next phase. To request changes instead, use <strong>Feedback</strong> above — the note below is provenance only, not guidance for the loop.</p>
          ${pending.length ? `<p class="help is-warning mb-3" id="approve-pending-warning">⚠ ${pending.length} feedback item${pending.length === 1 ? "" : "s"} still pending — make sure the revised review addresses ${pending.length === 1 ? "it" : "them"} before approving.</p>` : ""}
          <div class="field">
            <label class="label is-small" for="source">Approval note <span class="has-text-grey has-text-weight-normal">(required, recorded as provenance)</span></label>
            <div class="control"><textarea id="source" class="textarea" rows="2" placeholder="e.g. reviewed intent and scope — ok"></textarea></div>
          </div>
          <div class="is-flex is-align-items-center" style="gap:0.75rem">
            <button id="approve-button" class="button is-success">✓ Approve</button>
            <span id="approve-result" class="help m-0" role="status"></span>
          </div>
        </div>
      </section>`
    : "";

  /* Confirmation dialog: the only control that sends the approve request. */
  const approveModal = !fragment && waiting && !(fleet && !options.reviewerToken)
    ? `<div id="approve-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="approve-modal-title" data-live-preserve="class">
  <div class="modal-background" data-close></div>
  <div class="modal-card">
    <header class="modal-card-head">
      <p class="modal-card-title" id="approve-modal-title">Approve ${escapeHtml(gateLabel(task.gate))}?</p>
      <button class="delete" aria-label="close" data-close></button>
    </header>
    <section class="modal-card-body">
      <p>This approves <strong>${escapeHtml(gateLabel(task.gate))}</strong> (<code>${escapeHtml(task.gate)}</code>) for <code>${escapeHtml(task.id)}</code> and moves the task to the next phase. It cannot be undone from the dashboard.</p>
      <p class="mt-2">To request changes instead, cancel and use <strong>Feedback</strong> — the task then stays at this gate.</p>
      <p class="is-size-7 has-text-grey mt-3 mb-1">Approval note</p>
      <blockquote id="approve-modal-note" class="box is-size-7 py-2 px-3 mb-0"></blockquote>
    </section>
    <footer class="modal-card-foot">
      <button class="button" data-close data-autofocus>Cancel</button>
      <button id="approve-confirm" class="button is-success">✓ Confirm approve</button>
    </footer>
  </div>
</div>`
    : "";

  const openArtifact = waiting ? GATE_ARTIFACT[task.gate] : undefined;
  const artifacts = ARTIFACT_NAMES.map((name) => {
    const artifactPath = task.artifacts?.[name];
    if (!artifactPath) return "";
    const payload = artifactPayload(options.root, id, name, task);
    const content = payload.ok && payload.content !== undefined
      ? `<div class="content artifact">${markdownToHtml(payload.content)}</div>`
      : `<p class="help is-danger px-5 pb-4">${escapeHtml(payload.error ?? "unavailable")}</p>`;
    return `<details class="ad-artifact" data-key="artifact:${name}"${name === openArtifact ? " open" : ""}><summary>${escapeHtml(name)}<code>${escapeHtml(artifactPath)}</code></summary>${content}</details>`;
  }).join("\n");

  const table = (head: string[], rows: string[], empty: string): string => rows.length
    ? `<table class="table ad-table is-fullwidth"><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("\n")}</tbody></table>`
    : `<p class="ad-empty-line">${escapeHtml(empty)}</p>`;

  const decisions = table(["decision", "status", "resolution"], task.decisions.map((decision) =>
    `<tr><td><code>${escapeHtml(decision.id)}</code><div class="is-size-7 has-text-grey mt-1">${escapeHtml(decision.label ?? "")}</div></td><td>${pill(decision.status, DECISION_TONE[decision.status] ?? "")}</td><td class="is-size-7">${escapeHtml(decision.resolution ?? "")}</td></tr>`), "No decisions recorded");

  const doneItems = task.tasks.filter((item) => item.status === "done").length;
  const workItems = table(["item", "status", "label"], task.tasks.map((item) =>
    `<tr><td><code>${escapeHtml(item.id)}</code></td><td>${pill(item.status.replace("_", " "), ITEM_TONE[item.status] ?? "")}</td><td class="is-size-7">${escapeHtml(item.label ?? "")}</td></tr>`), "No work items yet");
  const workProgress = task.tasks.length
    ? `<div class="px-5 pt-4 pb-1"><progress class="progress is-small is-primary mb-0" value="${doneItems}" max="${task.tasks.length}" aria-label="work items done">${doneItems}/${task.tasks.length}</progress></div>`
    : "";

  const evidence = table(["kind", "result", "gate", "source", "recorded"], task.evidence.map((entry) =>
    `<tr><td><strong>${escapeHtml(entry.kind)}</strong>${entry.area ? `<div class="is-size-7 has-text-grey">${escapeHtml(entry.area)}</div>` : ""}</td><td>${pill(entry.result, RESULT_TONE[entry.result] ?? "")}</td><td class="is-size-7">${escapeHtml(entry.gate ?? "")}</td><td class="is-size-7">${escapeHtml(entry.source ?? "")}${entry.detail ? `<div class="has-text-grey mt-1">${escapeHtml(entry.detail)}</div>` : ""}</td><td class="is-size-7 has-text-grey">${relativeTime(entry.recordedAt)}</td></tr>`), "No verification evidence yet");

  /* Worker containers (full page only): the task's runtime record, the same in every
   * mode; `docker ps` only refines `running` and is shared across live polls. */
  let containersPanel = "";
  if (!fragment) {
    const containers = await taskContainers(options, id);
    containersPanel = containers.status === 200 ? renderContainersPanel(containers.payload.containers, containers.payload.docker) : renderContainersPanel([], "unavailable");
  }

  const handoff = task.handoff
    ? `<section class="ad-panel" data-key="handoff" style="box-shadow:0 0 0 1px var(--bulma-danger)"><header class="ad-panel-head"><h2>Handed off · ${escapeHtml(task.handoff.kind)}</h2></header><div class="ad-panel-body"><p>${escapeHtml(task.handoff.reason)}</p><p class="is-size-7 has-text-grey mt-2">Follow the handoff actions from <code>node .agents/aidlc/scripts/state.mjs task next ${escapeHtml(task.id)}</code>.</p></div></section>`
    : "";

  const meta = `<dl class="ad-meta">
    <dt>Status</dt><dd>${statusPill(task.status, Boolean(task.handoff))}</dd>
    <dt>Gate</dt><dd>${task.gate === "none" ? '<span class="has-text-grey">none</span>' : `${escapeHtml(gateLabel(task.gate))}<div class="is-size-7 has-text-grey">${escapeHtml(task.gate)}</div>`}</dd>
    <dt>Risk</dt><dd>${riskPill(task.risk)}</dd>
    <dt>Type</dt><dd>${escapeHtml(task.type)}</dd>
    <dt>Language</dt><dd>${escapeHtml(task.language)}</dd>
    <dt>Areas</dt><dd>${escapeHtml(task.areas.join(", "))}</dd>
    <dt>Branch</dt><dd><code>${escapeHtml(task.branch)}</code></dd>
    <dt>Created</dt><dd>${relativeTime(task.createdAt)}</dd>
    <dt>Updated</dt><dd>${relativeTime(task.updatedAt)}</dd>
  </dl>`;

  /* Live log (assets/ui/live-log.js): client-owned SSE lines, so live updates never
   * morph inside it ([data-live-ignore]). The full page gets the grouped log with its
   * filter and Raw JSON switch; the side panel a compact tail of recent lines keyed by
   * task, so switching tasks replaces it and a re-render keeps it. */
  const logAttrs = (mode: "full" | "compact", limit: number): string =>
    `data-live-log data-log-mode="${mode}" data-log-limit="${limit}" data-task-id="${escapeHtml(task.id)}" data-gate-labels="${escapeHtml(JSON.stringify(GATE_LABELS))}"`;
  const liveLog = fragment
    ? `<section class="ad-terminal ad-live-log is-compact" data-key="drawer-log:${escapeHtml(task.id)}" data-live-ignore ${logAttrs("compact", DRAWER_LOG_LINES)}>
    <div class="ad-terminal-head"><strong>Live log</strong><span class="ad-log-state" data-log-state>connecting…</span>
      <div class="ad-terminal-tools"><a href="/tasks/${encodeURIComponent(task.id)}#live-log" data-log-open>Open full log →</a></div>
    </div>
    <div class="log-panel is-compact" data-log-body role="log" aria-live="off"><span class="ad-log-muted">connecting…</span></div>
  </section>`
    : `<section class="ad-terminal ad-live-log" id="live-log" data-live-ignore ${logAttrs("full", FULL_LOG_LINES)}>
    <div class="ad-terminal-head"><span class="ad-lights" aria-hidden="true"><span></span><span></span><span></span></span><strong>Live log</strong><span id="log-state" class="ad-log-state" data-log-state>connecting…</span>
      <div class="ad-terminal-tools">
        <span class="ad-log-switch" role="group" aria-label="Which events to show"><button type="button" data-log-filter="important" aria-pressed="true" title="Hide bookkeeping events; show the first line of agent messages">Important</button><button type="button" data-log-filter="all" aria-pressed="false" title="Every event, agent messages in full">All</button></span>
        <button type="button" data-log-raw aria-pressed="false" title="Show each event's original JSON">Raw JSON</button>
        <button type="button" id="log-follow" data-log-follow aria-pressed="true">Follow</button><button type="button" id="log-clear" data-log-clear>Clear</button>
      </div>
    </div>
    <div id="log" class="log-panel" data-log-body role="log" aria-live="off"><span class="ad-log-muted">connecting…</span></div>
  </section>`;

  /* The side panel stays read-only; when a human action is due, point at the
   * full page that hosts it right at the top. */
  const href = `/tasks/${encodeURIComponent(task.id)}`;
  const drawerCta = !fragment ? ""
    : task.handoff
      ? `<div class="ad-callout is-danger ad-drawer-cta" data-key="drawer-cta"><span>Handed off · ${escapeHtml(task.handoff.kind)} — follow the handoff actions on the full page.</span><a class="button is-small is-danger" href="${href}">Open task →</a></div>`
      : waiting
        ? `<div class="ad-callout ad-drawer-cta" data-key="drawer-cta"><span>Waiting at <strong>${escapeHtml(gateLabel(task.gate))}</strong>${pending.length ? ` · ${pending.length} feedback pending` : ""} — send feedback or approve on the full page.</span><a class="button is-small is-warning" href="${href}" data-review-cta>Open review →</a></div>`
        : "";

  const body = `${drawerCta}<h1 class="ad-page-title">${escapeHtml(task.title)}</h1>
<div class="ad-page-sub">${copyIdButton(task.id)}${statusPill(task.status, Boolean(task.handoff))}${gatePill(task.gate)}${riskPill(task.risk)}${feedbackPill(pending.length)}</div>
${phaseStepper(task.phase, task.gate, task.status, Boolean(task.handoff))}
${fragment ? liveLog : ""}
<div class="columns is-desktop">
  <div class="column is-8-desktop">
    ${handoff}
    ${pendingBlock}
    ${gateBlock}
    ${feedbackBlock}
    ${approveBlock}
    ${panel("Artifacts", artifacts || '<p class="ad-empty-line">No artifacts recorded</p>', `<span class="ad-count">${ARTIFACT_NAMES.filter((name) => task.artifacts?.[name]).length}</span>`, true)}
    ${panel("Decisions", decisions, `<span class="ad-count">${task.decisions.length}</span>`, true)}
    ${panel("Work items", workProgress + workItems, `<span class="ad-panel-tools"><a class="button is-small" href="${changesHref(task.id)}" data-changes-link="items" title="Code changes of this task">Changes</a><span class="ad-count">${doneItems}/${task.tasks.length}</span></span>`, true)}
    ${containersPanel}
    ${panel("Evidence", evidence, `<span class="ad-count">${task.evidence.length}</span>`, true)}
    ${fragment ? "" : liveLog}
  </div>
  <aside class="column is-4-desktop">
    <div class="ad-sticky">
      ${panel("Details", meta)}
    </div>
  </aside>
</div>`;

  return { task, html: fragment ? body : `${body}${approveModal}` };
};

export const taskNotFound = (options: UiOptions, id: string): string =>
  `<div class="ad-empty"><div class="ad-empty-icon" aria-hidden="true">🔍</div><h2>Task not found</h2><p><code>${escapeHtml(id)}</code> is not in the ${uiMode(options) === "fleet" ? "fleet" : "local"} canonical state.</p><a class="button" href="/">← Back to dashboard</a></div>`;
export const drawerNotFound = (id: string): string => `<p class="has-text-danger">Task not found: ${escapeHtml(id)}</p>`;

export const renderTaskDetail = async (options: UiOptions, id: string, fragment = false): Promise<string> => {
  const state = await readUiState(options);
  const rendered = await renderTaskBody(options, state, id, fragment);
  if (fragment) return rendered ? rendered.html : drawerNotFound(id);
  const reviews = reviewQueue(state);
  if (!rendered) return `${pageHead("Task not found · Loop")}${renderHeader(options.root, uiMode(options), reviews)}<main class="section ad-main"><div class="container is-fluid">${taskNotFound(options, id)}</div></main>${renderModals()}${pageScripts("common")}</body></html>`;
  return `${pageHead(`${rendered.task.title} · Loop`, rendered.task.id)}
${renderHeader(options.root, uiMode(options), reviews, rendered.task.id)}
<main class="section ad-main">
  <div class="container is-fluid">
    <a class="ad-breadcrumb" href="/">← Dashboard</a>
    ${liveRegion("detail", rendered.html)}
  </div>
</main>
${renderModals()}
${pageScripts("common", "detail", "live-log")}
</body>
</html>`;
};
