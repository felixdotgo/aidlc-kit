/*
 * Task changes page. The diff is server-rendered (and escaped); this script only
 * filters the item sections in place when the selector changes (the form still
 * works without it), scrolls smoothly to a file, and applies the diff display
 * settings from aidlcSettings: `diffWrap` toggles `is-wrapped` on the diff
 * containers; `diffIgnoreWs` reloads the page with `?ws=ignore`, which the server
 * maps to `git diff -w`. Loaded after common.js.
 */
(() => {
  const settings = window.aidlcSettings;
  const select = document.querySelector("[data-changes-select]");
  const submit = document.querySelector("[data-changes-submit]");
  const showItem = (item) => {
    document.querySelectorAll("[data-change-item]").forEach((section) => {
      section.hidden = Boolean(item) && section.getAttribute("data-change-item") !== item;
    });
  };
  /* The URL with `?ws=ignore` set or cleared (other params and the hash are kept). */
  const wsUrl = (ignore) => {
    const params = new URLSearchParams(location.search);
    if (ignore) params.set("ws", "ignore"); else params.delete("ws");
    const query = params.toString();
    return location.pathname + (query ? "?" + query : "") + location.hash;
  };
  const wsInUrl = () => new URLSearchParams(location.search).get("ws") === "ignore";
  const applyWrap = (wrap) => {
    document.querySelectorAll(".ad-changes-diff").forEach((diff) => diff.classList.toggle("is-wrapped", Boolean(wrap)));
  };

  if (settings) {
    const current = settings.get();
    applyWrap(current.diffWrap);
    // The whitespace mode is a server-side diff option: the saved setting wins over the URL.
    if (current.diffIgnoreWs !== wsInUrl()) { location.replace(wsUrl(current.diffIgnoreWs)); return; }
    const options = document.querySelector("[data-changes-options]");
    const wrapToggle = document.querySelector("[data-changes-wrap]");
    const wsToggle = document.querySelector("[data-changes-ws]");
    if (options) options.hidden = false;
    if (wrapToggle) {
      wrapToggle.checked = current.diffWrap;
      wrapToggle.addEventListener("change", () => settings.set({ diffWrap: wrapToggle.checked }));
    }
    if (wsToggle) {
      wsToggle.checked = current.diffIgnoreWs;
      wsToggle.addEventListener("change", () => settings.set({ diffIgnoreWs: wsToggle.checked }));
    }
    // Covers the toggles here, the Settings dialog, and another tab saving.
    settings.onChange((next, changed) => {
      if (changed.includes("diffWrap")) { applyWrap(next.diffWrap); if (wrapToggle) wrapToggle.checked = next.diffWrap; }
      if (changed.includes("diffIgnoreWs")) {
        if (wsToggle) wsToggle.checked = next.diffIgnoreWs;
        if (next.diffIgnoreWs !== wsInUrl()) location.assign(wsUrl(next.diffIgnoreWs));
      }
    });
  }

  if (select) {
    if (submit) submit.hidden = true;
    select.addEventListener("change", () => {
      const item = select.value;
      const params = new URLSearchParams(location.search);
      if (item) params.set("item", item); else params.delete("item");
      const query = params.toString();
      const url = location.pathname + (query ? "?" + query : "");
      // An item whose patch was left out of the whole-task view is loaded from the server.
      const section = item ? document.querySelector('[data-change-item="' + CSS.escape(item) + '"]') : null;
      if (section && section.hasAttribute("data-patch-omitted")) { location.assign(url); return; }
      showItem(item);
      history.replaceState(history.state, "", url);
    });
  }
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[data-changes-file]") : null;
    if (!link) return;
    const target = document.getElementById((link.getAttribute("href") || "").slice(1));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(history.state, "", location.pathname + location.search + "#" + target.id);
    target.classList.add("is-target");
    setTimeout(() => target.classList.remove("is-target"), 1500);
  });
})();
