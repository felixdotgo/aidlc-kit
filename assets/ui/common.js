/*
 * Loop dashboard: client script shared by every page (classic script, loaded
 * before any page-specific script). Session token, POST helper, toasts, modals,
 * live-region polling and morphing (/api/live), header bell, task side panel,
 * login link, shared delegated handlers (cards, copy), and the new-task panel
 * with its Markdown editor.
 * Client-built text (toasts, log lines) uses textContent. HTML only ever comes
 * from the server's own escaping renderers (live regions, side-panel fragment).
 */
const storedToken = () => (localStorage.getItem("aidlc-token") || "");
const setStoredToken = (value) => localStorage.setItem("aidlc-token", value);
const post = async (url, body) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": storedToken() }, body: JSON.stringify(body) });
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
  toast(message, "danger", res.status === 401 ? "Open the login link printed by aidlc-kit ui (or paste the token in Settings) and retry." : "HTTP " + res.status);
};
const withLoading = async (button, work) => {
  if (button) { button.classList.add("is-loading"); button.disabled = true; }
  try { return await work(); }
  catch (error) { toast("Request failed", "danger", String(error && error.message || error)); return undefined; }
  finally { if (button) { button.classList.remove("is-loading"); button.disabled = false; } }
};
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/* Overlay timings match the CSS transitions (dashboard.css "Overlays"). */
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
  if (reducedMotion()) finish(); else el._hideTimer = setTimeout(finish, DRAWER_CLOSE_MS);
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
  if (reducedMotion()) el.classList.remove("is-active");
  else { el.classList.add("is-closing"); el._hideTimer = setTimeout(() => el.classList.remove("is-active", "is-closing"), MODAL_CLOSE_MS); }
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
const LIVE_INTERVAL_MS = 1500;
// Page size for header notifications; the server owns the value (body data-notify-page).
const NOTIFY_PAGE = Number(document.body.getAttribute("data-notify-page")) || 1;
const live = { notify: NOTIFY_PAGE, timer: 0, inflight: null, again: false, failures: 0, reviews: null, hooks: [] };
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
const setLiveStatus = (ok) => { const el = document.getElementById("live-status"); if (el) el.hidden = ok; };
const baseTitle = document.title.replace(/^\(\d+\) /, "");
const onReviews = (reviews) => {
  if (!reviews) return;
  document.title = reviews.count ? "(" + reviews.count + ") " + baseTitle : baseTitle;
  const ids = new Set(reviews.items.map((item) => item.id));
  // The first poll only seeds the set: toast reviews that arrive while the page is open.
  if (live.reviews) for (const item of reviews.items) {
    if (!live.reviews.has(item.id)) toast("Review needed: " + item.title, "warning", item.gate + " · " + item.id, "/tasks/" + encodeURIComponent(item.id));
  }
  live.reviews = ids;
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
      setLiveStatus(true);
    } catch (error) {
      live.failures += 1;
      setLiveStatus(false);
    } finally { live.inflight = null; }
  })();
  await live.inflight;
  if (live.again) { live.again = false; await liveRefresh(); }
};
// Polls every 1.5s; backs off to 12s while the server is unreachable.
const scheduleLive = () => {
  clearTimeout(live.timer);
  const delay = live.failures ? Math.min(12000, LIVE_INTERVAL_MS * 2 ** Math.min(live.failures, 3)) : LIVE_INTERVAL_MS;
  live.timer = setTimeout(async () => { await liveRefresh(); scheduleLive(); }, delay);
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) { liveRefresh().then(scheduleLive); } });

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
// Login link: `aidlc-kit ui` prints /#token=<token>. Store it and drop it from the address bar
// (a fragment is never sent to the server or in Referer).
(() => {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (!match) return;
  try { setStoredToken(decodeURIComponent(match[1])); } catch (error) { /* malformed link */ }
  history.replaceState(history.state, "", location.pathname + location.search);
})();

/* ---- Cards: the whole kanban card / list row opens its task. Plain click → side
 * panel; ctrl/cmd-click or middle-click → full page in a new tab; shift-click →
 * full page in this tab. ---- */
const openCard = (card, event) => {
  const href = card.getAttribute("data-card-href");
  if (!href) return;
  if (event.ctrlKey || event.metaKey || event.button === 1) { window.open(href, "_blank", "noopener"); return; }
  if (event.shiftKey) { location.href = href; return; }
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
  if (opener) { openModal(opener.getAttribute("data-open")); return; }
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

document.addEventListener("DOMContentLoaded", () => {
  const tokenInput = document.getElementById("settings-token-input");
  if (tokenInput) tokenInput.value = storedToken();
  const tokenState = document.getElementById("settings-token-state");
  const renderTokenState = () => { if (tokenState) tokenState.textContent = storedToken() ? "Token saved in this browser" : "No token saved"; };
  renderTokenState();
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
  const saveBtn = document.getElementById("settings-token-save");
  if (saveBtn) saveBtn.addEventListener("click", () => { if (tokenInput) setStoredToken(tokenInput.value.trim()); renderTokenState(); closeModal("settings-modal"); toast("Token saved", "success"); });
  const clearBtn = document.getElementById("settings-token-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => { setStoredToken(""); if (tokenInput) tokenInput.value = ""; renderTokenState(); toast("Token cleared", "info"); });

  const requirement = document.getElementById("new-task-requirement");
  const counter = document.getElementById("new-task-count");
  const startBtn = document.getElementById("new-task-submit");
  const preview = document.getElementById("new-task-preview");
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
      note.textContent = res.status === 401 ? "Preview needs the session token: open the login link printed by the server, or paste it in Settings." : (res.body.error || "Preview failed");
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
    const res = await post("/api/loop/start", { requirement: value });
    if (res.status >= 200 && res.status < 300) {
      const daemon = res.body.daemon || {};
      toast("Task " + res.body.taskId + " created", "success", daemon.started ? "Started the loop daemon (pid " + daemon.pid + ")" : "Picked up by the running daemon", "/tasks/" + encodeURIComponent(res.body.taskId));
      hideDrawer(document.getElementById("new-task-drawer"));
      if (requirement) { requirement.value = ""; updateCounter(); saveDraft(); setEditorTab("write"); }
      await liveRefresh();
    } else failureToast(res, "Could not create the task");
  }));

  const initialTask = drawerTaskFromUrl();
  if (initialTask && drawerEl()) openTaskDrawer(initialTask, { push: false });
  liveRefresh().then(scheduleLive);
});
