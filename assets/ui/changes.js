/*
 * Task changes page. The diff is server-rendered (and escaped); this script only
 * filters the item sections in place when the selector changes (the form still
 * works without it) and scrolls smoothly to a file. Loaded after common.js.
 */
(() => {
  const select = document.querySelector("[data-changes-select]");
  const submit = document.querySelector("[data-changes-submit]");
  const showItem = (item) => {
    document.querySelectorAll("[data-change-item]").forEach((section) => {
      section.hidden = Boolean(item) && section.getAttribute("data-change-item") !== item;
    });
  };
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
  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[data-changes-file]") : null;
    if (!link) return;
    const target = document.getElementById((link.getAttribute("href") || "").slice(1));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
    history.replaceState(history.state, "", location.pathname + location.search + "#" + target.id);
    target.classList.add("is-target");
    setTimeout(() => target.classList.remove("is-target"), 1500);
  });
})();
