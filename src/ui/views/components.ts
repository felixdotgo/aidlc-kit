/**
 * Presentation helpers shared by the dashboard, task pages, and live regions:
 * labels, pills, phase stepper, relative time, and the structured gate view.
 */
import { escapeHtml } from "../http.js";

export const PHASES = ["clarify", "plan", "build", "wrap", "done"] as const;

export const summarize = (counts: Record<string, number> | undefined): string => Object.entries(counts ?? {}).map(([k, n]) => `${n} ${k}`).join(" · ") || "none";

/* ---------------------------------------------------------------------------
 * Presentation helpers: labels, pills, phase stepper, relative time.
 * Colour is never the only signal; every pill carries a text label.
 * ------------------------------------------------------------------------- */

export const GATE_LABELS: Record<string, string> = {
  G0_confirm: "Confirm requirements",
  G1_review: "Approve plan",
  G2_codereview: "Review implementation",
};
export const PHASE_GATE: Record<string, string> = { clarify: "G0_confirm", plan: "G1_review", build: "G2_codereview" };
export const STATUS_META: Record<string, { label: string; tone: string }> = {
  active: { label: "Active", tone: "is-info" },
  blocked_on_user: { label: "Needs review", tone: "is-warning" },
  paused: { label: "Paused", tone: "" },
  done: { label: "Done", tone: "is-success" },
  closed: { label: "Closed", tone: "is-danger" },
  superseded: { label: "Superseded", tone: "is-danger" },
};
export const RISK_TONE: Record<string, string> = { low: "is-success", normal: "", high: "is-warning", regulated: "is-danger" };
export const RESULT_TONE: Record<string, string> = { pass: "is-success", fail: "is-danger", skip: "is-warning" };
export const DECISION_TONE: Record<string, string> = { approved: "is-success", changed: "is-info", dropped: "is-ghost", unresolved: "is-warning" };
export const ITEM_TONE: Record<string, string> = { done: "is-success", in_progress: "is-info", todo: "", deferred: "is-warning" };

export const gateLabel = (gate: string): string => GATE_LABELS[gate] ?? gate;

export const pill = (label: string, tone = "", title = "", dot = true): string =>
  `<span class="ad-pill ${tone}"${title ? ` title="${escapeHtml(title)}"` : ""}>${dot ? '<span class="ad-dot"></span>' : ""}${escapeHtml(label)}</span>`;

export const statusPill = (status: string, handedOff = false): string => {
  if (handedOff) return pill("Handed off", "is-danger", `status: ${status} · handed off`);
  const meta = STATUS_META[status] ?? { label: status, tone: "" };
  return pill(meta.label, meta.tone, `status: ${status}`);
};

export const gatePill = (gate: string): string => gate && gate !== "none" ? pill(gateLabel(gate), "is-ghost", `gate: ${gate}`, false) : "";
/** Human feedback recorded at a gate and not yet followed by that gate's approval. */
export const feedbackPill = (count: number): string => count > 0 ? `<span class="ad-pill is-info" data-feedback-pending="${count}" title="${count} human feedback item${count === 1 ? "" : "s"} not yet followed by an approval">✎ feedback pending${count > 1 ? ` · ${count}` : ""}</span>` : "";

export const riskPill = (risk: string): string => pill(`${risk} risk`, RISK_TONE[risk] ?? "", `risk: ${risk}`);

export const phaseSteps = (phase: string): string => {
  const current = (PHASES as readonly string[]).indexOf(phase);
  const done = phase === "done";
  const bars = PHASES.map((name, index) => {
    const state = done || index < current ? "is-complete" : index === current ? "is-current" : "";
    return `<span class="${state}" title="${escapeHtml(name)}"></span>`;
  }).join("");
  return `<div class="ad-steps${done ? " is-done" : ""}" role="img" aria-label="Phase ${current + 1} of ${PHASES.length}: ${escapeHtml(phase)}">${bars}</div>`;
};

/** Terminal-but-not-done statuses: the task keeps its canonical phase, only the
 * presentation changes (last kanban column, closed-at hint). */
export const CLOSED_STATUSES = new Set(["closed", "superseded"]);
export const isClosedStatus = (status: string): boolean => CLOSED_STATUSES.has(status);

/** Visible hint text for a closed/superseded task: "closed at <phase>" ("" otherwise). */
export const closedAtText = (status: string, phase: string): string =>
  isClosedStatus(status) ? `${status} at ${escapeHtml(phase)}` : "";

/** Statuses whose current step shows the "radioactive" pulse: the task is moving
 * (`active`) or waiting for a human (`blocked_on_user`, pulsed in the warning tone). */
const PULSE_STATUSES = new Set(["active", "blocked_on_user"]);

/** Horizontal phase stepper shown above the artifacts (detail page and drawer). A pulse
 * ring marks the current step while the task is live; `stalled` (handed off) suppresses it. */
export const phaseStepper = (phase: string, gate: string, status: string, stalled = false): string => {
  const current = (PHASES as readonly string[]).indexOf(phase);
  const pulse = !stalled && phase !== "done" && PULSE_STATUSES.has(status)
    ? `<span class="ad-pulse${status === "blocked_on_user" ? " is-waiting" : ""}" aria-hidden="true"></span>`
    : "";
  return `<ol class="ad-stepper" aria-label="Progress">${PHASES.map((name, index) => {
    const complete = phase === "done" || index < current;
    const isCurrent = !complete && index === current;
    const phaseGate = PHASE_GATE[name];
    const note = isCurrent && status === "blocked_on_user" && gate !== "none"
      ? `waiting at ${gateLabel(gate)}`
      : phaseGate ? `gate · ${gateLabel(phaseGate)}` : name === "done" ? "complete" : "no gate";
    return `<li class="${complete ? "is-complete" : isCurrent ? "is-current" : ""}"${isCurrent ? ' aria-current="step"' : ""}><span class="ad-stepper-marker">${isCurrent ? pulse : ""}${complete ? "✓" : index + 1}</span><span class="ad-stepper-text"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(note)}</small></span></li>`;
  }).join("")}</ol>`;
};

/** Server-rendered relative time; the absolute ISO value stays in the title. */
export const relativeTime = (iso: string | undefined): string => {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return escapeHtml(iso);
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  const text = seconds < 60 ? "just now"
    : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${text}</time>`;
};

/* ---------------------------------------------------------------------------
 * Gate view and JSON tree renderers (structured HTML, not raw JSON dumps).
 * ------------------------------------------------------------------------- */

export interface GateViewData {
  icon?: string;
  title?: string;
  gate?: string;
  action?: string;
  task?: { id?: string; title?: string; status?: string; risk?: string; areas?: string[] };
  artifacts?: Array<{ name?: string; path?: string }>;
  decisions?: Record<string, number>;
  execution?: Record<string, number>;
  evidence?: Array<{ kind?: string; result?: string; source?: string }>;
  diagnostics?: Array<{ level?: string; code?: string; message?: string }>;
}

/** `actions`: extra trusted HTML (e.g. a link to the task's changes) shown above the action callout. */
export const renderGateViewHtml = (view: unknown, actions = ""): string => {
  const v = view as GateViewData;
  const task = v.task ?? {};
  const artifacts = v.artifacts ?? [];
  const evidence = v.evidence ?? [];
  const diagnostics = v.diagnostics ?? [];
  const levelTone = (level?: string): string => level === "ERROR" ? "is-danger" : level === "WARN" ? "is-warning" : "is-info";
  const cell = (label: string, value: string): string => `<div class="ad-gate-cell"><small>${escapeHtml(label)}</small><span>${value}</span></div>`;
  return `<section class="ad-panel is-warning" data-key="gate-view">
    <header class="ad-panel-head"><span aria-hidden="true">${escapeHtml(String(v.icon ?? ""))}</span><h2>${escapeHtml(String(v.title ?? ""))}</h2><span class="ad-pill is-warning ad-panel-tools" title="gate">${escapeHtml(String(v.gate ?? ""))}</span></header>
    <div class="ad-panel-body">
      <div class="ad-gate-grid">
        ${cell("Status", escapeHtml(task.status ?? ""))}
        ${cell("Risk", escapeHtml(task.risk ?? ""))}
        ${cell("Areas", escapeHtml((task.areas ?? []).join(", ")))}
        ${cell("Decisions", escapeHtml(summarize(v.decisions)))}
        ${cell("Execution", escapeHtml(summarize(v.execution)))}
      </div>
      <h3 class="ad-subhead">Review artifacts</h3>
      ${artifacts.length ? `<ul class="ad-plain-list">${artifacts.map((a) => `<li><strong>${escapeHtml(a.name ?? "")}</strong><code>${escapeHtml(a.path ?? "")}</code></li>`).join("")}</ul>` : '<p class="has-text-grey">none</p>'}
      <h3 class="ad-subhead">Verification evidence</h3>
      ${evidence.length ? `<ul class="ad-plain-list">${evidence.map((e) => `<li>${pill(e.result ?? "", RESULT_TONE[e.result ?? ""] ?? "")} <strong>${escapeHtml(e.kind ?? "")}</strong> <span class="has-text-grey">${escapeHtml(e.source ?? "")}</span></li>`).join("")}</ul>` : '<p class="has-text-grey">none yet</p>'}
      ${diagnostics.length ? `<h3 class="ad-subhead">Diagnostics</h3><ul class="ad-plain-list">${diagnostics.map((d) => `<li>${pill(d.level ?? "", levelTone(d.level))} <code>${escapeHtml(d.code ?? "")}</code> ${escapeHtml(d.message ?? "")}</li>`).join("")}</ul>` : ""}
      ${actions}
      <div class="ad-callout"><span aria-hidden="true">→</span><span>Action required: ${escapeHtml(String(v.action ?? ""))}</span></div>
    </div>
  </section>`;
};
