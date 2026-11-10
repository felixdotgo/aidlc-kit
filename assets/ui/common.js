/*
 * Loop dashboard: client script shared by every page (classic script, loaded
 * before any page-specific script). Settings store, POST helper, toasts, modals,
 * live-region polling and morphing (/api/live), header bell, task side panel,
 * shared delegated handlers (cards, copy), the Settings dialog, and the new-task
 * panel with its Markdown editor.
 * Client-built text (toasts, log lines) uses textContent. HTML only ever comes
 * from the server's own escaping renderers (live regions, side-panel fragment).
 */

/* ---- Settings (localStorage "aidlc-settings") -------------------------------
 * Client-side preferences shared by every page. `aidlcSettings.get()` returns a
 * normalised copy (unknown or malformed values fall back to the defaults),
 * `set(partial)` merges, persists, and notifies `onChange(fn)` listeners with
 * (settings, changedKeys); `reset()` restores the defaults. Other scripts read it
 * through `window.aidlcSettings`. The head script in layout.ts reads the same key
 * before first paint for the theme. */
const SETTINGS_KEY = "aidlc-settings";
const SETTINGS_DEFAULTS = Object.freeze({ theme: "system", logFilter: "important", logRaw: false, livePoll: 1500, notify: false, diffWrap: true, diffIgnoreWs: false, logTailKb: 64, openCards: "panel" });
const SETTINGS_CHOICES = { theme: ["system", "light", "dark"], logFilter: ["important", "all"], livePoll: [1500, 3000, 0], logTailKb: [64, 256, 1024], openCards: ["panel", "page"] };
const aidlcSettings = (() => {
  const listeners = [];
  const normalize = (raw) => {
    const out = Object.assign({}, SETTINGS_DEFAULTS);
    const source = raw && typeof raw === "object" ? raw : {};
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      const value = source[key];
      if (typeof SETTINGS_DEFAULTS[key] === "boolean") { if (typeof value === "boolean") out[key] = value; continue; }
      const choice = typeof SETTINGS_DEFAULTS[key] === "number" ? Number(value) : value;
      if (SETTINGS_CHOICES[key].includes(choice)) out[key] = choice;
    }
    return out;
  };
  const read = () => { try { return normalize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (error) { return normalize({}); } };
  let current = read();
  const get = () => Object.assign({}, current);
  const emit = (changed) => { if (changed.length) for (const fn of listeners) { try { fn(get(), changed); } catch (error) { /* a listener must not break the others */ } } };
  const set = (partial) => {
    const next = normalize(Object.assign({}, current, partial || {}));
    const changed = Object.keys(SETTINGS_DEFAULTS).filter((key) => next[key] !== current[key]);
    current = next;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(current)); } catch (error) { /* storage disabled */ }
    emit(changed);
    return get();
  };
  const onChange = (fn) => { listeners.push(fn); return () => { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); }; };
  // Another tab saved: adopt its values and notify listeners here too.
  window.addEventListener("storage", (event) => {
    if (event.key !== SETTINGS_KEY && event.key !== null) return;
    const next = read();
    const changed = Object.keys(SETTINGS_DEFAULTS).filter((key) => next[key] !== current[key]);
    current = next;
    emit(changed);
  });
  return { get, set, onChange, reset: () => set(SETTINGS_DEFAULTS), defaults: () => Object.assign({}, SETTINGS_DEFAULTS) };
})();
window.aidlcSettings = aidlcSettings;
// Theme: `light`/`dark` pin Bulma's scheme through html[data-theme]; `system` leaves it to the OS.
const applyTheme = (theme) => { if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme); else document.documentElement.removeAttribute("data-theme"); };
applyTheme(aidlcSettings.get().theme);
aidlcSettings.onChange((settings, changed) => { if (changed.includes("theme")) applyTheme(settings.theme); });

// Every state-changing request carries the custom header the server requires (it is not a
// "simple" header, so a cross-site page cannot send it without a CORS preflight).
const post = async (url, body) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-request": "1" }, body: JSON.stringify(body) });
  let parsed = {};
  try { parsed = await response.json(); } catch (error) { parsed = { error: "Unexpected response (" + response.status + ")" }; }
  return { status: response.status, body: parsed };
};
// Toasts; an optional same-origin href turns the message into a link.
const toast = (message, kind = "info", detail = "", href = "") => {
  const stack = document.getElementById("toasts");
  if (!stack) return;
  const icons = { success: "✓", danger: "!", warning: "!", info: "i" };
  const item = document.createElement("div");
  item.className = "ad-toast is-" + kind;
  item.setAttribute("role", kind === "danger" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "ad-toast-icon";
  icon.textContent = icons[kind] || "i";
  const body = document.createElement("div");
  body.className = "ad-toast-body";
  if (href && href.startsWith("/")) { const link = document.createElement("a"); link.href = href; link.textContent = message; body.appendChild(link); }
  else body.textContent = message;
  if (detail) { const small = document.createElement("small"); small.textContent = detail; body.appendChild(small); }
  const close = document.createElement("button");
  close.className = "ad-toast-close";
  close.setAttribute("aria-label", "dismiss");
  close.textContent = "×";
  const dismiss = () => { item.classList.add("is-leaving"); setTimeout(() => item.remove(), 220); };
  close.addEventListener("click", dismiss);
  item.append(icon, body, close);
  stack.appendChild(item);
  setTimeout(dismiss, kind === "danger" ? 9000 : href ? 8000 : 4500);
};
const failureToast = (res, fallback) => {
  const message = (res.body && res.body.error) || fallback;
  toast(message, "danger", res.status === 403 ? "The dashboard refused the request (HTTP 403): open it at the address printed by aidlc-kit ui." : "HTTP " + res.status);
};
const withLoading = async (button, work) => {
  if (button) { button.classList.add("is-loading"); button.disabled = true; }
  try { return await work(); }
  catch (error) { toast("Request failed", "danger", String(error && error.message || error)); return undefined; }
  finally { if (button) { button.classList.remove("is-loading"); button.disabled = false; } }
};
/* Overlay timings match the CSS transitions (dashboard.css "Overlays"). The dashboard
 * animates regardless of the OS reduced-motion setting, so these timers always run. */
const MODAL_CLOSE_MS = 160;
const DRAWER_CLOSE_MS = 240;
const modalOpen = () => !!document.querySelector(".modal.is-active:not(.is-closing)");
const openDrawers = () => [...document.querySelectorAll(".ad-drawer.is-open")];
const topDrawer = () => { const list = openDrawers(); return list.length ? list[list.length - 1] : null; };
const anyDrawerOpen = () => openDrawers().length > 0;
const releaseScroll = () => { if (!modalOpen() && !anyDrawerOpen()) document.documentElement.classList.remove("is-clipped"); };
// Side panels animate in: unhide, commit the off-screen state with a reflow, then add
// is-open so the transform/opacity transitions actually run (adding it in the same
// frame as unhiding skips the transition).
const showDrawer = (el) => {
  if (!el || el.classList.contains("is-open")) return false;
  if (el.hidden) el._returnFocus = document.activeElement;
  clearTimeout(el._hideTimer);
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add("is-open");
  document.documentElement.classList.add("is-clipped");
  const target = el.querySelector("[data-autofocus]") || el.querySelector(".ad-drawer-panel");
  if (target) setTimeout(() => target.focus(), 60);
  return true;
};
// A drawer mid-close counts as closed, so a quick reopen re-adds is-open instead of
// being hidden by the pending timer.
const hideDrawer = (el) => {
  if (!el || el.hidden || !el.classList.contains("is-open")) return false;
  el.classList.remove("is-open");
  const finish = () => { if (!el.classList.contains("is-open")) el.hidden = true; };
  el._hideTimer = setTimeout(finish, DRAWER_CLOSE_MS);
  releaseScroll();
  const back = el._returnFocus;
  el._returnFocus = null;
  if (back && typeof back.focus === "function") back.focus();
  return true;
};
const openModal = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.classList.contains("ad-drawer")) { showDrawer(el); return; }
  clearTimeout(el._hideTimer);
  el.classList.remove("is-closing");
  el.classList.add("is-active");
  document.documentElement.classList.add("is-clipped");
  const focusable = el.querySelector("[data-autofocus]");
  if (focusable) setTimeout(() => focusable.focus(), 30);
};
const closeModalEl = (el) => {
  if (!el.classList.contains("is-active") || el.classList.contains("is-closing")) return;
  el.classList.add("is-closing");
  el._hideTimer = setTimeout(() => el.classList.remove("is-active", "is-closing"), MODAL_CLOSE_MS);
};
const closeModal = (id) => { const el = document.getElementById(id); if (el) closeModalEl(el); releaseScroll(); };
const closeAllModals = () => { document.querySelectorAll(".modal").forEach(closeModalEl); releaseScroll(); };

/* ---- Reactive regions -------------------------------------------------------
 * The server renders each region ([data-live]) to HTML; the client polls
 * /api/live with the hash it shows per region, gets back only changed regions,
 * and morphs them into the DOM in place (keyed by id / data-key) instead of
 * reloading the page. Morphing keeps focus, typed input, open <details>, and
 * client state named in data-live-preserve; [data-live-ignore] subtrees (the
 * live log) are never touched. Hooks re-apply view state (filters, collapsed
 * columns) after every update. */
// Poll interval from Settings (`livePoll`: 1500 | 3000 | 0 = paused).
const liveInterval = () => aidlcSettings.get().livePoll;
const livePaused = () => liveInterval() === 0;
// Page size for header notifications; the server owns the value (body data-notify-page).
const NOTIFY_PAGE = Number(document.body.getAttribute("data-notify-page")) || 1;
const live = { notify: NOTIFY_PAGE, timer: 0, inflight: null, again: false, failures: 0, reviews: null, reviewCount: null, hooks: [] };
const keyOf = (node) => node.nodeType === 1 ? (node.id || node.getAttribute("data-key") || "") : "";
const sameNode = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
const preservedAttrs = (el) => {
  const names = (el.getAttribute("data-live-preserve") || "").split(/\s+/).filter(Boolean);
  if (el.tagName === "DETAILS") names.push("open");
  return names;
};
const syncAttrs = (from, to) => {
  const keep = preservedAttrs(from);
  for (const { name } of [...from.attributes]) if (!keep.includes(name) && !to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (!keep.includes(name) && from.getAttribute(name) !== value) from.setAttribute(name, value);
};
const morphNode = (from, to) => {
  if (from.nodeType === 3 || from.nodeType === 8) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
  if (from.nodeType !== 1 || from.hasAttribute("data-live-ignore")) return;
  syncAttrs(from, to);
  // Form controls keep what the user typed or picked.
  if (from.tagName === "INPUT" || from.tagName === "TEXTAREA" || from.tagName === "SELECT") return;
  morphChildren(from, to);
};
const morphChildren = (from, to) => {
  const keyed = new Map();
  for (const child of from.children) { const key = keyOf(child); if (key) keyed.set(key, child); }
  let cursor = from.firstChild;
  for (const next of [...to.childNodes]) {
    const key = keyOf(next);
    let match = null;
    if (key) { const found = keyed.get(key); if (found && sameNode(found, next)) { match = found; keyed.delete(key); } }
    else if (cursor && !keyOf(cursor) && sameNode(cursor, next)) match = cursor;
    if (match) {
      if (match === cursor) cursor = cursor.nextSibling; else from.insertBefore(match, cursor);
      morphNode(match, next);
    } else from.insertBefore(next, cursor);
  }
  while (cursor) { const after = cursor.nextSibling; cursor.remove(); cursor = after; }
};
const applyRegion = (name, html, hash) => {
  const el = document.querySelector("[data-live='" + name + "']");
  if (!el) return false;
  const template = document.createElement("template");
  template.innerHTML = html;
  morphChildren(el, template.content);
  el.setAttribute("data-live-hash", hash);
  return true;
};
let drawerTask = "";
const liveQuery = () => {
  const params = new URLSearchParams();
  const task = document.body.getAttribute("data-task");
  if (task) params.set("task", task);
  const known = [];
  document.querySelectorAll("[data-live]").forEach((el) => {
    const name = el.getAttribute("data-live");
    if (name === "drawer" && !(drawerOpen() && drawerTask)) return;
    known.push(name + ":" + (el.getAttribute("data-live-hash") || ""));
  });
  if (drawerOpen() && drawerTask) params.set("drawer", drawerTask);
  params.set("notify", String(live.notify));
  params.set("known", known.join(","));
  return params.toString();
};
// Header pill: hidden while live updates flow; "reconnecting…" while the server is
// unreachable; "live updates paused" while Settings has polling off.
const LIVE_STATUS = {
  reconnecting: ["reconnecting…", "Live updates paused: the dashboard server is unreachable; retrying"],
  paused: ["live updates paused", "Live updates are paused in Settings; actions still refresh the page"],
};
const setLiveStatus = (state) => {
  const el = document.getElementById("live-status");
  if (!el) return;
  if (state === "ok") { el.hidden = true; return; }
  const [text, title] = LIVE_STATUS[state] || LIVE_STATUS.reconnecting;
  [...el.childNodes].forEach((node) => { if (node.nodeType === 3) node.remove(); });
  el.append(text);
  el.title = title;
  el.hidden = false;
};
const baseTitle = document.title.replace(/^\(\d+\) /, "");
/* Browser notifications (Settings → notify): one when the number of tasks waiting for
 * review grows; clicking it brings this window back. `tag` collapses duplicates from
 * other open tabs. */
const notificationsSupported = () => typeof Notification === "function";
const notificationState = () => !notificationsSupported() ? "unsupported" : Notification.permission;
const requestNotifications = () => {
  if (!notificationsSupported() || Notification.permission !== "default") return Promise.resolve(notificationState());
  try { return Promise.resolve(Notification.requestPermission()).then(() => notificationState(), () => notificationState()); }
  catch (error) { return Promise.resolve(notificationState()); }
};
const notifyReview = (items) => {
  if (!aidlcSettings.get().notify || notificationState() !== "granted") return;
  try {
    const first = items[0];
    const body = items.length === 1 && first ? first.title + " · " + first.gate : items.length + " tasks are waiting for your review";
    const note = new Notification("Task waiting for your review", { body, tag: "aidlc-review" });
    note.onclick = () => { window.focus(); if (first && items.length === 1) location.href = "/tasks/" + encodeURIComponent(first.id); note.close(); };
  } catch (error) { /* notifications unavailable in this context */ }
};
aidlcSettings.onChange((settings, changed) => { if (changed.includes("notify") && settings.notify) requestNotifications(); });
const onReviews = (reviews) => {
  if (!reviews) return;
  document.title = reviews.count ? "(" + reviews.count + ") " + baseTitle : baseTitle;
  const ids = new Set(reviews.items.map((item) => item.id));
  // The first poll only seeds the set: toast reviews that arrive while the page is open.
  const fresh = [];
  if (live.reviews) for (const item of reviews.items) {
    if (!live.reviews.has(item.id)) { fresh.push(item); toast("Review needed: " + item.title, "warning", item.gate + " · " + item.id, "/tasks/" + encodeURIComponent(item.id)); }
  }
  if (live.reviewCount !== null && reviews.count > live.reviewCount) notifyReview(fresh.length ? fresh : reviews.items);
  live.reviews = ids;
  live.reviewCount = reviews.count;
};
const liveRefresh = async () => {
  if (live.inflight) { live.again = true; return live.inflight; }
  live.inflight = (async () => {
    try {
      const requestedDrawer = drawerOpen() ? drawerTask : "";
      const response = await fetch("/api/live?" + liveQuery(), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      const changed = [];
      for (const [name, region] of Object.entries(data.regions || {})) {
        // A drawer answer for a task the user has since switched away from is stale.
        if (name === "drawer" && (!drawerOpen() || drawerTask !== requestedDrawer || data.drawer !== drawerTask)) continue;
        if (applyRegion(name, region.html, region.hash)) changed.push(name);
      }
      if (changed.length) live.hooks.forEach((hook) => hook(changed));
      onReviews(data.reviews);
      live.failures = 0;
      setLiveStatus(livePaused() ? "paused" : "ok");
    } catch (error) {
      live.failures += 1;
      setLiveStatus("reconnecting");
    } finally { live.inflight = null; }
  })();
  await live.inflight;
  if (live.again) { live.again = false; await liveRefresh(); }
};
// Polls at the Settings interval (1.5s by default); backs off to 12s while the server
// is unreachable; does not poll at all while paused (actions still call liveRefresh).
const scheduleLive = () => {
  clearTimeout(live.timer);
  const interval = liveInterval();
  if (!interval) { setLiveStatus("paused"); return; }
  const delay = live.failures ? Math.min(12000, interval * 2 ** Math.min(live.failures, 3)) : interval;
  live.timer = setTimeout(async () => { await liveRefresh(); scheduleLive(); }, delay);
};
document.addEventListener("visibilitychange", () => { if (!document.hidden && !livePaused()) { liveRefresh().then(scheduleLive); } });
aidlcSettings.onChange((settings, changed) => {
  if (!changed.includes("livePoll")) return;
  if (settings.livePoll) { setLiveStatus(live.failures ? "reconnecting" : "ok"); liveRefresh().then(scheduleLive); }
  else scheduleLive();
});

// Header notifications: the bell toggles a dropdown of tasks waiting at a gate;
// each item is a plain link to the task detail page.
const notifyToggle = () => document.getElementById("notify-toggle");
const notifyOpen = () => { const panel = document.getElementById("notify-panel"); return !!panel && !panel.hidden; };
const setNotify = (open, options = {}) => {
  const button = notifyToggle();
  const panel = document.getElementById("notify-panel");
  if (!button || !panel) return;
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) { const first = panel.querySelector("a[href]"); if (first && options.focus) first.focus(); }
  else if (options.restore) button.focus();
};

// Task side panel (drawer): slides in from the right, mirrors ?task=<id> in the
// URL so refresh/share reopens it and Back closes it. Only the newest fetch
// may write the body when the user switches tasks quickly; live updates then
// morph it like any other region.
let drawerRequest = 0;
const drawerEl = () => document.getElementById("task-drawer");
const drawerOpen = () => { const el = drawerEl(); return !!el && el.classList.contains("is-open"); };
const drawerTaskFromUrl = () => new URLSearchParams(location.search).get("task");
const openTaskDrawer = async (id, options = {}) => {
  const el = drawerEl();
  if (!el || !id) return;
  const body = document.getElementById("task-drawer-body");
  const title = document.getElementById("task-drawer-title");
  const link = document.getElementById("task-drawer-open");
  if (title) { const code = title.querySelector("code"); if (code) code.textContent = id; else title.textContent = id; title.setAttribute("data-copy", id); }
  if (link) link.href = "/tasks/" + encodeURIComponent(id);
  showDrawer(el);
  if (options.push !== false && drawerTaskFromUrl() !== id) history.pushState({ task: id }, "", "?task=" + encodeURIComponent(id));
  const request = ++drawerRequest;
  const switching = drawerTask !== id;
  drawerTask = id;
  if (body && switching) { body.innerHTML = "<p class='has-text-grey'>Loading…</p>"; body.setAttribute("data-live-hash", ""); }
  let html;
  try {
    const response = await fetch("/partial/tasks/" + encodeURIComponent(id));
    html = response.ok ? await response.text() : "<p class='has-text-danger'>Failed to load task detail.</p>";
  } catch (error) {
    html = "<p class='has-text-danger'>Failed to load task detail.</p>";
  }
  if (request === drawerRequest && body) {
    if (switching) { body.innerHTML = html; body.scrollTop = 0; }
    else { const template = document.createElement("template"); template.innerHTML = html; morphChildren(body, template.content); }
    body.setAttribute("data-live-hash", "");
  }
};
const closeTaskDrawer = (options = {}) => {
  const el = drawerEl();
  if (!el || el.hidden) return;
  drawerRequest += 1;
  hideDrawer(el);
  // Replace (not push) the ?task entry so Back after closing does not reopen it.
  if (options.push !== false && drawerTaskFromUrl()) history.replaceState({}, "", location.pathname);
};
const closeDrawerEl = (el) => { if (el && el === drawerEl()) closeTaskDrawer(); else hideDrawer(el); };
window.addEventListener("popstate", () => {
  const id = drawerTaskFromUrl();
  if (id) openTaskDrawer(id, { push: false }); else closeTaskDrawer({ push: false });
});
const isTyping = (target) => !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const REQUIREMENT_LIMIT = 8192;

/* ---- Cards: the whole kanban card / list row opens its task. Plain click → side
 * panel, or the task page when Settings → Board says so; ctrl/cmd-click or
 * middle-click → full page in a new tab; shift-click → full page in this tab. ---- */
const openCard = (card, event) => {
  const href = card.getAttribute("data-card-href");
  if (!href) return;
  if (event.ctrlKey || event.metaKey || event.button === 1) { window.open(href, "_blank", "noopener"); return; }
  if (event.shiftKey || aidlcSettings.get().openCards === "page") { location.href = href; return; }
  openTaskDrawer(card.getAttribute("data-task-id"));
};
// Middle-click: links handle it natively; elsewhere on a card open a new tab, and
// suppress the autoscroll cursor that middle mousedown would start.
document.addEventListener("mousedown", (event) => {
  if (event.button !== 1 || !(event.target instanceof Element)) return;
  if (event.target.closest("[data-card-href]") && !event.target.closest("a")) event.preventDefault();
});
document.addEventListener("auxclick", (event) => {
  if (event.button !== 1 || !(event.target instanceof Element)) return;
  const card = event.target.closest("[data-card-href]");
  if (card && !event.target.closest("a, button")) { event.preventDefault(); openCard(card, event); }
});

/* ---- Copy to clipboard ([data-copy]): task ids on the detail page and side panel. ---- */
const copyToClipboard = async (text, button) => {
  if (!text) return;
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; }
  catch (error) {
    const area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    try { copied = document.execCommand("copy"); } catch (fallbackError) { copied = false; }
    area.remove();
  }
  if (!copied) { toast("Could not copy", "warning", text); return; }
  toast("Copied " + text, "success");
  if (button) { button.classList.add("is-copied"); setTimeout(() => button.classList.remove("is-copied"), 1200); }
};

/* ---- Delegated events: controls inside live regions are re-rendered, so no
 * handler is bound to an individual element. ---- */
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (notifyOpen() && !target.closest("[data-notify]")) setNotify(false);
  const bell = target.closest("#notify-toggle");
  if (bell) { setNotify(!notifyOpen(), { focus: event.detail === 0 }); return; }
  if (target.closest("[data-notify-more]")) {
    live.notify += NOTIFY_PAGE;
    liveRefresh();
    return;
  }
  const copy = target.closest("[data-copy]");
  if (copy) { event.preventDefault(); copyToClipboard(copy.getAttribute("data-copy") || "", copy); return; }
  const opener = target.closest("[data-open]");
  if (opener) { const id = opener.getAttribute("data-open"); if (id === "settings-modal") fillSettingsForm(aidlcSettings.get()); openModal(id); return; }
  if (target.closest("[data-close]")) { closeAllModals(); return; }
  const drawerClose = target.closest("[data-drawer-close]");
  if (drawerClose) { closeDrawerEl(drawerClose.closest(".ad-drawer")); return; }
  const taskLink = target.closest("[data-task-link]");
  const card = target.closest("[data-card-href]");
  if (taskLink) {
    if (event.button !== 0 || event.altKey) return;
    // Inside a card the link follows the card rules (shift = this tab); elsewhere
    // modifier clicks keep the browser's own behaviour.
    if (card && (event.shiftKey || event.ctrlKey || event.metaKey)) { event.preventDefault(); openCard(card, event); return; }
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    openTaskDrawer(taskLink.getAttribute("data-task-link"));
    return;
  }
  if (card && !target.closest("a, button, input, select, textarea, summary, label") && !String(window.getSelection() || "")) { openCard(card, event); return; }
  const resume = target.closest("[data-resume]");
  if (resume) {
    event.preventDefault();
    const taskId = resume.getAttribute("data-resume");
    withLoading(resume, async () => {
      const res = await post("/api/loop/resume", { taskId });
      if (res.status >= 200 && res.status < 300) { toast("Resumed " + taskId, "success", "The daemon will pick it up on its next poll"); await liveRefresh(); }
      else failureToast(res, "Could not resume " + taskId);
    });
  }
});

/* ---- Settings dialog: the form mirrors aidlcSettings; Save applies at once. ---- */
const settingsControl = (key) => document.getElementById("settings-" + key);
const NOTIFY_STATE_TEXT = {
  granted: "Notifications are allowed in this browser.",
  denied: "Notifications are blocked by the browser; allow them for this site in its settings.",
  default: "The browser will ask for permission when you save.",
  unsupported: "This browser does not offer notifications here (some need HTTPS or localhost).",
};
const renderNotifyState = () => {
  const el = document.getElementById("settings-notify-state");
  const box = settingsControl("notify");
  if (!el) return;
  const state = notificationState();
  el.textContent = box && !box.checked ? "" : NOTIFY_STATE_TEXT[state] || "";
  el.classList.toggle("is-danger", state === "denied" && !!box && box.checked);
};
const fillSettingsForm = (values) => {
  if (!document.getElementById("settings-form")) return;
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (key === "theme") { const radio = document.getElementById("settings-theme-" + values.theme); if (radio) radio.checked = true; continue; }
    const el = settingsControl(key);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = values[key] === true; else el.value = String(values[key]);
  }
  renderNotifyState();
};
const readSettingsForm = () => {
  const values = {};
  const theme = document.querySelector("input[name='settings-theme']:checked");
  if (theme) values.theme = theme.value;
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (key === "theme") continue;
    const el = settingsControl(key);
    if (!el) continue;
    values[key] = el.type === "checkbox" ? el.checked : (typeof SETTINGS_DEFAULTS[key] === "number" ? Number(el.value) : el.value);
  }
  return values;
};

document.addEventListener("DOMContentLoaded", () => {
  const settingsSave = document.getElementById("settings-save");
  if (settingsSave) settingsSave.addEventListener("click", () => {
    const values = readSettingsForm();
    aidlcSettings.set(values);
    // Permission prompts need a user gesture: ask here, then report the outcome.
    const asked = values.notify ? requestNotifications() : Promise.resolve(notificationState());
    asked.then((state) => {
      renderNotifyState();
      if (values.notify && state === "denied") toast("Notifications are blocked by the browser", "warning", "Allow them for this site in the browser's settings; the other settings were saved.");
    });
    closeModal("settings-modal");
    toast("Settings saved", "success");
  });
  const settingsReset = document.getElementById("settings-reset");
  if (settingsReset) settingsReset.addEventListener("click", () => { fillSettingsForm(aidlcSettings.reset()); toast("Settings reset to defaults", "info"); });
  const notifyBox = settingsControl("notify");
  if (notifyBox) notifyBox.addEventListener("change", renderNotifyState);
  // The theme radios preview immediately; closing without Save restores the saved value.
  document.querySelectorAll("input[name='settings-theme']").forEach((radio) => radio.addEventListener("change", () => applyTheme(radio.value)));
  const settingsModal = document.getElementById("settings-modal");
  if (settingsModal) new MutationObserver(() => { if (!settingsModal.classList.contains("is-active")) applyTheme(aidlcSettings.get().theme); }).observe(settingsModal, { attributes: true, attributeFilter: ["class"] });
  if (aidlcSettings.get().notify) requestNotifications();
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { if (notifyOpen()) setNotify(false, { restore: true }); else if (modalOpen()) closeAllModals(); else closeDrawerEl(topDrawer()); return; }
    if (event.key === "Tab" && anyDrawerOpen() && !modalOpen()) {
      const panel = topDrawer().querySelector(".ad-drawer-panel");
      const focusable = [...panel.querySelectorAll("a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex='-1'])")].filter((node) => node.offsetParent !== null);
      if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || modalOpen() || anyDrawerOpen()) return;
    if (event.key === "n" && document.getElementById("new-task-drawer")) { event.preventDefault(); openModal("new-task-drawer"); }
    else if (event.key === "/") { const search = document.getElementById("task-search"); if (search) { event.preventDefault(); search.focus(); search.select(); } }
  });
  const requirement = document.getElementById("new-task-requirement");
  const counter = document.getElementById("new-task-count");
  const startBtn = document.getElementById("new-task-submit");
  const preview = document.getElementById("new-task-preview");
  const titleField = document.getElementById("new-task-title-field");
  const DRAFT_KEY = "aidlc-new-task-draft";
  const saveDraft = () => { try { if (requirement.value) localStorage.setItem(DRAFT_KEY, requirement.value); else localStorage.removeItem(DRAFT_KEY); } catch (error) { /* storage disabled */ } };
  const updateCounter = () => {
    if (!requirement || !counter) return;
    const used = new TextEncoder().encode(requirement.value).length;
    counter.textContent = used + " / " + REQUIREMENT_LIMIT + " bytes";
    counter.classList.toggle("is-over", used > REQUIREMENT_LIMIT);
  };
  /* Markdown editor: toolbar actions edit the selection through insertText so the
   * browser's undo stack keeps working; setRangeText is the fallback. */
  const replaceSelection = (text, selectFrom, selectTo) => {
    const start = requirement.selectionStart;
    requirement.focus();
    if (!document.execCommand || !document.execCommand("insertText", false, text)) requirement.setRangeText(text, start, requirement.selectionEnd, "end");
    if (selectFrom !== undefined) requirement.setSelectionRange(start + selectFrom, start + selectTo);
    requirement.dispatchEvent(new Event("input"));
  };
  const wrapSelection = (before, after, placeholder) => {
    const selected = requirement.value.slice(requirement.selectionStart, requirement.selectionEnd) || placeholder;
    replaceSelection(before + selected + after, before.length, before.length + selected.length);
  };
  const prefixLines = (prefix) => {
    const value = requirement.value;
    const from = value.lastIndexOf("\n", requirement.selectionStart - 1) + 1;
    let to = value.indexOf("\n", requirement.selectionEnd);
    if (to < 0) to = value.length;
    requirement.setSelectionRange(from, to);
    const lines = value.slice(from, to).split("\n").map((line, index) => (typeof prefix === "function" ? prefix(index) : prefix) + line);
    replaceSelection(lines.join("\n"));
  };
  const MARKDOWN_ACTIONS = {
    heading: () => prefixLines("## "),
    bold: () => wrapSelection("**", "**", "bold text"),
    italic: () => wrapSelection("_", "_", "italic text"),
    code: () => wrapSelection("`", "`", "code"),
    codeblock: () => wrapSelection("\n```\n", "\n```\n", "code"),
    ul: () => prefixLines("- "),
    ol: () => prefixLines((index) => (index + 1) + ". "),
    quote: () => prefixLines("> "),
    link: () => {
      const selected = requirement.value.slice(requirement.selectionStart, requirement.selectionEnd) || "link text";
      replaceSelection("[" + selected + "](https://)", selected.length + 3, selected.length + 11);
    },
  };
  let previewRequest = 0;
  const setEditorTab = async (tab) => {
    if (!requirement || !preview) return;
    document.querySelectorAll("[data-editor-tab]").forEach((button) => button.setAttribute("aria-selected", String(button.getAttribute("data-editor-tab") === tab)));
    const previewing = tab === "preview";
    requirement.hidden = previewing;
    preview.hidden = !previewing;
    document.querySelectorAll("[data-md]").forEach((button) => { button.disabled = previewing; });
    if (!previewing) { requirement.focus(); return; }
    if (!requirement.value.trim()) { preview.innerHTML = "<p class='has-text-grey'>Nothing to preview yet.</p>"; return; }
    preview.innerHTML = "<p class='has-text-grey'>Rendering…</p>";
    const request = ++previewRequest;
    let res;
    try { res = await post("/api/markdown", { markdown: requirement.value }); }
    catch (error) { res = { status: 0, body: { error: "Preview failed: the dashboard server is unreachable" } }; }
    if (request !== previewRequest || preview.hidden) return; // a newer preview or the Write tab won
    // The server renders with the same escaping renderer as task artifacts.
    if (res.status === 200 && typeof res.body.html === "string") preview.innerHTML = res.body.html;
    else {
      preview.textContent = "";
      const note = document.createElement("p");
      note.className = "has-text-danger";
      note.textContent = res.body.error || "Preview failed";
      preview.appendChild(note);
    }
  };
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const action = target && target.closest("[data-md]");
    if (action && requirement && MARKDOWN_ACTIONS[action.getAttribute("data-md")]) { event.preventDefault(); MARKDOWN_ACTIONS[action.getAttribute("data-md")](); return; }
    const tab = target && target.closest("[data-editor-tab]");
    if (tab) { event.preventDefault(); setEditorTab(tab.getAttribute("data-editor-tab")); }
  });
  if (requirement) {
    try { const draft = localStorage.getItem(DRAFT_KEY); if (draft && !requirement.value) requirement.value = draft; } catch (error) { /* storage disabled */ }
    requirement.addEventListener("input", () => { updateCounter(); saveDraft(); });
    requirement.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === "Enter" && startBtn) { event.preventDefault(); startBtn.click(); return; }
      const shortcut = { b: "bold", i: "italic", k: "link" }[event.key.toLowerCase()];
      if (shortcut && !event.shiftKey && !event.altKey) { event.preventDefault(); MARKDOWN_ACTIONS[shortcut](); }
    });
    updateCounter();
  }
  if (startBtn) startBtn.addEventListener("click", () => withLoading(startBtn, async () => {
    const value = requirement ? requirement.value : "";
    if (!value.trim()) { toast("Describe the requirement first", "warning"); setEditorTab("write"); return; }
    const title = titleField && typeof titleField.value === "string" ? titleField.value.trim() : "";
    const res = await post("/api/loop/start", { requirement: value, ...(title ? { title } : {}) });
    if (res.status >= 200 && res.status < 300) {
      const daemon = res.body.daemon || {};
      toast("Task " + res.body.taskId + " created", "success", daemon.started ? "Started the loop daemon (pid " + daemon.pid + ")" : "Picked up by the running daemon", "/tasks/" + encodeURIComponent(res.body.taskId));
      hideDrawer(document.getElementById("new-task-drawer"));
      if (requirement) { requirement.value = ""; updateCounter(); saveDraft(); setEditorTab("write"); }
      if (titleField && typeof titleField.value === "string") titleField.value = "";
      await liveRefresh();
    } else failureToast(res, "Could not create the task");
  }));

  const initialTask = drawerTaskFromUrl();
  if (initialTask && drawerEl()) openTaskDrawer(initialTask, { push: false });
  liveRefresh().then(scheduleLive);
});
