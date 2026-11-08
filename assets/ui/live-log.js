/*
 * Live log: streams /api/events?task-id=<task> (SSE) into every [data-live-log]
 * element. The task page shows the full log (data-log-mode="full": lines grouped
 * under turn headers, an Important/All filter, a Raw JSON switch); the task side
 * panel shows a compact one (data-log-mode="compact": the last data-log-limit
 * lines, Important only). Log elements are client-owned ([data-live-ignore]):
 * live morphs never touch them. A MutationObserver starts logs that appear later
 * (the side panel is injected and re-rendered), stops the stream of a log that is
 * removed or hidden (closed side panel), and restarts it when shown again.
 * Event data only ever reaches the DOM through textContent.
 * Loaded after common.js (uses its `liveRefresh` when present).
 */
(() => {
  /* ---- Formatting: event → human sentence (pure; exposed for tests) ---- */
  const DEFAULT_GATES = { G0_confirm: "Confirm requirements", G1_review: "Approve plan", G2_codereview: "Review implementation" };
  const str = (value) => typeof value === "string" ? value : "";
  const two = (n) => String(n).padStart(2, "0");
  const clock = (iso) => { const d = new Date(iso); return isNaN(d) ? "--:--:--" : two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds()); };
  const firstLine = (text) => (text.split("\n").find((line) => line.trim()) || "").trim();
  const shortSha = (sha) => str(sha).slice(0, 7);
  const duration = (ms) => { const s = Math.max(0, Math.round(Number(ms || 0) / 1000)); return s < 60 ? s + "s" : Math.floor(s / 60) + "m" + (s % 60 ? " " + (s % 60) + "s" : ""); };
  const code = (value) => ({ code: value });
  // Driver events without an actor (older logs) come from the lead's turn.
  const LEAD_TYPES = /^(agent_|turn_|lifecycle_command$)/;
  const actorOf = (e) => str(e.actor) || (LEAD_TYPES.test(e.type) ? "lead" : "loop");
  // Hidden in Important mode: bookkeeping that does not tell the reader what happened.
  const NOISE = new Set(["turn_completed", "daemon_poll", "agent_event", "resume", "context_changed", "jobs_active", "daemon_start", "resync"]);
  // Outcome and loop events stand on their own instead of nesting under a turn.
  const SYSTEM = new Set(["gate", "waiting", "daemon_turn", "daemon_turn_error", "loop_stopped", "job_integrated", "job_scheduled", "build_deferred", "diagnostic", "daemon_start", "daemon_poll", "daemon_poll_error", "worker_image_build", "resume", "context_changed", "jobs_active", "release_failed", "resync"]);
  const TOOL_VERBS = [
    [/^(bash|shell|command|command_execution|exec|run|local_shell)/i, "ran"],
    [/^(edit|multiedit|write|apply_patch|patch|notebookedit|file_change|str_replace)/i, "edited"],
    [/^(read|view|cat)/i, "read"],
    [/^(grep|glob|search|find|ls|list|websearch|webfetch|fetch)/i, "searched"],
  ];
  const toolSentence = (e) => {
    const tool = str(e.tool) || "tool";
    const summary = str(e.summary);
    if (!summary) return ["used tool ", code(tool)];
    const verb = (TOOL_VERBS.find(([pattern]) => pattern.test(tool)) || [])[1];
    return verb ? [verb + " ", code(summary)] : ["used " + tool + " ", code(summary)];
  };
  const toneOfStatus = (status) => /fail|error/.test(status) ? "error" : /pause|block|stop|stall|gate|handoff/.test(status) ? "warn" : /done|complete|success/.test(status) ? "ok" : "muted";

  /**
   * Describes one event: `parts` is the sentence (strings, `{code}` spans, `{link, href}`),
   * `tone` one of error|warn|ok|muted|"", `full` the untruncated text when `parts` shows
   * only its first line, `turn` the header label of a turn start, `noise` hides it in
   * Important mode, `system` keeps it out of turn groups.
   */
  const describe = (e, ctx = {}) => {
    const gates = ctx.gates || DEFAULT_GATES;
    const gateName = (gate) => gates[gate] || str(gate) || "a gate";
    const taskId = str(e.taskId) || str(ctx.taskId);
    const actor = actorOf(e);
    const info = { actor, parts: [], tone: "", noise: NOISE.has(e.type), system: SYSTEM.has(e.type) };
    const turnLabel = (agent) => ["Turn " + (Number(e.iteration || 0) + 1), str(e.phase), actor + (agent ? "/" + agent : ""), e.itemId ? "item " + e.itemId : ""].filter(Boolean).join(" · ");
    switch (e.type) {
      case "turn_start":
        info.turn = turnLabel(str(e.agent));
        info.parts = ["started turn " + (Number(e.iteration || 0) + 1) + (e.phase ? " · " + e.phase : "") + (e.agent ? " · " + e.agent : "")];
        break;
      case "worker_turn_start":
        info.turn = turnLabel(str(e.agent));
        info.parts = [e.summary ? "worker " + e.summary : "worker started turn " + (Number(e.iteration || 0) + 1)];
        break;
      case "turn_end": info.parts = ["turn " + (Number(e.iteration || 0) + 1) + " finished"]; info.tone = "ok"; break;
      case "turn_completed": info.parts = ["agent finished its reply"]; info.tone = "muted"; break;
      case "agent_text": {
        const text = str(e.text).trim();
        info.parts = [firstLine(text)];
        if (text !== firstLine(text)) info.full = text;
        break;
      }
      case "agent_tool": info.parts = toolSentence(e); break;
      case "lifecycle_command": {
        const exit = e.exitCode;
        const failed = (Number.isInteger(exit) && exit !== 0) || e.status === "failed";
        const outcome = Number.isInteger(exit) ? " → exit " + exit : e.status === "in_progress" ? " → running" : " → " + (str(e.status) || "unknown");
        info.parts = e.summary ? ["command ", code(str(e.summary)), outcome] : ["command" + outcome];
        info.tone = failed ? "error" : Number.isInteger(exit) ? "ok" : "";
        break;
      }
      case "gate":
      case "waiting":
        info.parts = ["waiting for your review at " + gateName(e.gate) + " · ", { link: "open review", href: "/tasks/" + encodeURIComponent(taskId) + "#approve-panel" }];
        info.tone = "warn";
        break;
      case "daemon_turn": {
        const status = str(e.status) || "unknown";
        info.parts = status === "gate" && e.gate ? ["loop paused at " + gateName(e.gate)] : ["loop run ended: " + status + (e.reason ? " · " + e.reason : "")];
        info.tone = toneOfStatus(status);
        break;
      }
      case "daemon_turn_error":
        info.parts = ["loop turn failed: " + (str(e.message) || "error") + " — retry" + (e.failures ? " #" + e.failures : "") + " in " + duration(e.retryInMs)];
        info.tone = "error";
        break;
      case "daemon_poll_error": info.parts = ["daemon poll failed: " + (str(e.message) || "error")]; info.tone = "error"; break;
      case "loop_stopped": info.parts = ["loop stopped" + (e.reason ? ": " + e.reason : "")]; info.tone = "warn"; break;
      case "build_deferred": info.parts = ["deferred item ", code(str(e.itemId) || "?"), e.reason ? ": " + e.reason : ""]; info.tone = "warn"; break;
      case "worker_image_build": info.parts = ["building worker image ", code(str(e.image) || "?"), e.provider ? " (" + e.provider + ")" : ""]; info.tone = "muted"; break;
      case "worker_reported": {
        const count = Array.isArray(e.changedPaths) ? e.changedPaths.length : 0;
        info.parts = ["worker reported " + count + " file" + (count === 1 ? "" : "s") + (e.commit ? " (" + shortSha(e.commit) + ")" : "")];
        if (count) info.title = e.changedPaths.filter((path) => typeof path === "string").join("\n");
        info.tone = "ok";
        break;
      }
      case "job_integrated": {
        const sha = shortSha(e.commit || e.commitSha);
        info.parts = ["integrated item ", code(str(e.itemId) || "?"), sha ? " (" + sha + ")" : ""];
        info.tone = "ok";
        break;
      }
      case "job_scheduled": info.parts = ["scheduled item ", code(str(e.itemId) || "?")]; info.tone = "muted"; break;
      case "diagnostic": info.parts = [str(e.message) || str(e.summary) || "diagnostic"]; info.tone = "warn"; break;
      case "daemon_start": info.parts = ["daemon started" + (e.pid ? " (pid " + e.pid + ")" : "")]; info.tone = "muted"; break;
      case "daemon_poll": info.parts = ["daemon poll · " + (Array.isArray(e.actionable) ? e.actionable.length : 0) + " actionable"]; info.tone = "muted"; break;
      case "resume": info.parts = ["resumed the loop"]; info.tone = "muted"; break;
      case "context_changed": info.parts = [str(e.message) || "task context changed"]; info.tone = "muted"; break;
      case "agent_event": info.parts = ["provider event"]; info.tone = "muted"; break;
      default:
        info.parts = [str(e.message) || str(e.summary) || String(e.type)];
        info.tone = /error|fail/.test(e.type) ? "error" : "";
    }
    return info;
  };
  window.aidlcLiveLog = { describe, clock };

  /* ---- Rendering ---- */
  // Page-level filter/raw choice; until the user picks one here, the Settings defaults
  // (`logFilter`, `logRaw` in window.aidlcSettings) apply.
  const PREFS_KEY = "aidlc-live-log";
  const settingsDefaults = () => {
    const settings = window.aidlcSettings && typeof window.aidlcSettings.get === "function" ? window.aidlcSettings.get() : {};
    return { filter: settings.logFilter === "all" ? "all" : "important", raw: settings.logRaw === true };
  };
  const readPrefs = () => {
    const fallback = settingsDefaults();
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      return {
        filter: saved.filter === "all" || saved.filter === "important" ? saved.filter : fallback.filter,
        raw: typeof saved.raw === "boolean" ? saved.raw : fallback.raw,
      };
    } catch (error) { return fallback; }
  };
  const prefs = readPrefs();
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (error) { /* storage disabled */ } };
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const appendParts = (target, parts) => {
    for (const part of parts) {
      if (typeof part === "string") { if (part) target.append(part); }
      else if (part && part.code !== undefined) target.append(node("code", "ad-log-code", part.code));
      else if (part && part.link) { const a = node("a", "ad-log-link", part.link); a.href = part.href; target.append(a); }
    }
  };
  const actorClass = (actor) => {
    if (actor === "lead") return "is-lead";
    if (actor === "loop") return "is-loop";
    let hash = 0;
    for (const char of actor) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return "is-worker-" + (hash % 4);
  };
  // Events that usually mean the canonical task changed: refresh the page regions
  // now (debounced) instead of waiting for the next poll.
  const STATE_EVENTS = new Set(["turn_end", "lifecycle_command", "gate", "waiting", "daemon_turn", "daemon_turn_error", "loop_stopped", "job_integrated"]);
  let refreshTimer = 0;
  const refreshSoon = () => {
    if (typeof liveRefresh !== "function") return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => liveRefresh(), 150);
  };

  const instances = new Map();
  const createLog = (root) => {
    const compact = root.getAttribute("data-log-mode") === "compact";
    const limit = Math.max(1, Math.min(2000, Number(root.getAttribute("data-log-limit")) || (compact ? 20 : 2000)));
    const taskId = root.getAttribute("data-task-id") || document.body.getAttribute("data-task") || "";
    let gates = DEFAULT_GATES;
    try { gates = Object.assign({}, DEFAULT_GATES, JSON.parse(root.getAttribute("data-gate-labels") || "{}")); } catch (error) { /* defaults */ }
    const body = root.querySelector("[data-log-body]");
    const stateEl = root.querySelector("[data-log-state]");
    const followBtn = root.querySelector("[data-log-follow]");
    let source = null;
    let follow = true;
    let entries = [];
    let block = null; // current turn group: { actor, body }
    const turns = new Map(); // actor -> label of its latest turn
    const view = () => compact ? { filter: "important", raw: false } : prefs;
    const setState = (text) => { if (stateEl) stateEl.textContent = text; };
    const placeholder = (text) => { body.textContent = ""; body.append(node("span", "ad-log-muted", text)); };
    const scroll = () => { if (follow) body.scrollTop = body.scrollHeight; };

    const lineFor = (entry, current) => {
      const line = node("div", "ad-log-line");
      if (!entry.event) { line.classList.add("is-unparsed"); line.textContent = entry.raw; return line; }
      const info = entry.info;
      if (info.tone) line.classList.add("is-" + info.tone);
      line.setAttribute("data-type", entry.event.type);
      const actor = node("span", "ad-log-actor " + actorClass(info.actor), info.actor);
      actor.title = "actor: " + info.actor;
      const text = node("span", "ad-log-text");
      if (current.raw) { text.classList.add("is-json"); text.textContent = entry.raw; }
      else if (info.full && current.filter === "all") text.textContent = info.full;
      else if (info.full && !compact) {
        const more = node("details", "ad-log-more");
        const summary = node("summary");
        appendParts(summary, info.parts);
        more.append(summary, node("div", "ad-log-full", info.full));
        text.append(more);
      } else appendParts(text, info.parts);
      if (info.title) text.title = info.title;
      line.append(node("span", "ad-log-time", clock(entry.event.at)), actor, text);
      return line;
    };
    const openGroup = (actor, label, entry) => {
      const group = node("div", "ad-log-turn");
      const head = node("div", "ad-log-turn-head");
      head.append(node("span", "ad-log-time", entry ? clock(entry.event.at) : ""), node("span", "ad-log-actor " + actorClass(actor), actor), node("span", "ad-log-turn-label", label));
      const groupBody = node("div", "ad-log-turn-body");
      group.append(head, groupBody);
      body.append(group);
      block = { actor, body: groupBody };
      return head;
    };
    // Appends one entry to the DOM (when the current view shows it); returns its node.
    const render = (entry) => {
      const current = view();
      const info = entry.info;
      if (info && info.noise && current.filter === "important") return null;
      if (compact || current.raw || !info) { const line = lineFor(entry, current); body.append(line); return line; }
      if (info.turn) { turns.set(info.actor, info.turn); return openGroup(info.actor, info.turn, entry); }
      if (info.system) { block = null; const line = lineFor(entry, current); body.append(line); return line; }
      if (!block || block.actor !== info.actor) openGroup(info.actor, (turns.get(info.actor) || info.actor) + " · continued", null);
      const line = lineFor(entry, current);
      block.body.append(line);
      if (entry.event.type === "turn_end") block = null;
      return line;
    };
    const drop = (entry) => {
      const el = entry.node;
      if (!el) return;
      const group = el.closest(".ad-log-turn");
      el.remove();
      if (group && !group.querySelector(".ad-log-line, .ad-log-turn-head")) group.remove();
    };
    const rerender = () => {
      body.textContent = "";
      block = null;
      turns.clear();
      for (const entry of entries) entry.node = render(entry);
      if (!entries.length) placeholder("No events for this task yet.");
      if (compact) trimCompact();
      scroll();
    };
    // Compact: only the last `limit` shown lines stay in the DOM.
    const trimCompact = () => { while (body.querySelectorAll(".ad-log-line").length > limit) body.querySelector(".ad-log-line").remove(); };
    const append = (raw) => {
      if (!entries.length) body.textContent = "";
      setState("streaming");
      let event = null;
      try { event = JSON.parse(raw); } catch (error) { event = null; }
      if (!event || typeof event !== "object" || typeof event.type !== "string") event = null;
      const entry = { raw, event, info: event ? describe(event, { taskId, gates }) : null, node: null };
      entries.push(entry);
      entry.node = render(entry);
      const cap = compact ? Math.max(limit * 10, 200) : limit;
      while (entries.length > cap) { const old = entries.shift(); if (!compact) drop(old); }
      if (compact) trimCompact();
      if (event && STATE_EVENTS.has(event.type)) refreshSoon();
      scroll();
    };
    const clear = () => { entries = []; block = null; turns.clear(); placeholder("No events for this task yet."); };

    const syncControls = () => {
      root.querySelectorAll("[data-log-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button.getAttribute("data-log-filter") === prefs.filter)));
      root.querySelectorAll("[data-log-raw]").forEach((button) => button.setAttribute("aria-pressed", String(prefs.raw)));
    };
    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const filter = target.closest("[data-log-filter]");
      if (filter) { prefs.filter = filter.getAttribute("data-log-filter") === "all" ? "all" : "important"; savePrefs(); instances.forEach((log) => log.refreshView()); return; }
      if (target.closest("[data-log-raw]")) { prefs.raw = !prefs.raw; savePrefs(); instances.forEach((log) => log.refreshView()); return; }
      if (target.closest("[data-log-follow]")) { follow = !follow; followBtn?.setAttribute("aria-pressed", String(follow)); scroll(); return; }
      if (target.closest("[data-log-clear]")) { clear(); }
    });
    syncControls();

    return {
      refreshView: () => { syncControls(); if (!compact) rerender(); },
      running: () => source !== null,
      start: () => {
        if (source || !body) return;
        clear();
        placeholder("connecting…");
        setState("connecting…");
        source = new EventSource("/api/events?task-id=" + encodeURIComponent(taskId));
        source.onopen = () => { if (!entries.length) { setState("connected · waiting for events"); placeholder("No events for this task yet."); } };
        source.onmessage = (message) => append(message.data);
        // The server replays the log from the start of its window: drop what is shown.
        source.addEventListener("reset", () => clear());
        source.onerror = () => {
          const closed = source && source.readyState === 2;
          setState(closed ? "unavailable" : entries.length ? "reconnecting…" : "unavailable");
          if (!entries.length) placeholder("Log stream unavailable (loop not running or log missing).");
        };
      },
      stop: () => { if (source) { source.close(); source = null; setState("paused"); } },
    };
  };

  // Starts logs that are attached and visible; stops removed or hidden ones.
  const scan = () => {
    document.querySelectorAll("[data-live-log]").forEach((root) => { if (!instances.has(root)) instances.set(root, createLog(root)); });
    for (const [root, log] of instances) {
      if (!root.isConnected) { log.stop(); instances.delete(root); continue; }
      if (root.closest("[hidden]")) log.stop(); else log.start();
    }
  };
  let scheduled = false;
  const scheduleScan = () => { if (scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; scan(); }); };
  // Mutations inside a log (its lines, its state text) never add or remove logs.
  const insideLog = (record) => { const el = record.target.nodeType === 1 ? record.target : record.target.parentElement; return !!el && !!el.closest("[data-live-log]"); };
  new MutationObserver((records) => { if (records.some((record) => !insideLog(record))) scheduleScan(); })
    .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("pagehide", () => instances.forEach((log) => log.stop()));
  window.addEventListener("pageshow", (event) => { if (event.persisted) scan(); });
  scan();
})();
