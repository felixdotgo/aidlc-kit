import { LIVE_FLEET_MAX_AGE_MS, readUiState } from "./data.js";
import { uiMode, type UiOptions } from "./options.js";
import { renderBoard } from "./views/board.js";
import { gateLabel } from "./views/components.js";
import { LIVE_REGIONS, notifyLimit, regionHash, renderDaemonPill, renderNotifications, reviewQueue, type LiveRegion } from "./views/layout.js";
import { drawerNotFound, renderTaskBody, taskNotFound } from "./views/task.js";

/** `/api/live`: re-renders the regions the client lists in `known` (name:hash)
 * from one state read and returns only those whose hash changed, plus the full
 * review list for the tab title and new-review toasts. */
export const livePayload = async (options: UiOptions, url: URL): Promise<unknown> => {
  const known = new Map<string, string>();
  for (const entry of (url.searchParams.get("known") ?? "").split(",")) {
    const at = entry.indexOf(":");
    const name = at < 0 ? entry : entry.slice(0, at);
    if ((LIVE_REGIONS as readonly string[]).includes(name)) known.set(name, at < 0 ? "" : entry.slice(at + 1));
  }
  const maxAgeMs = uiMode(options) === "fleet" ? LIVE_FLEET_MAX_AGE_MS : 0;
  const state = await readUiState(options, maxAgeMs);
  const task = url.searchParams.get("task") ?? "";
  const drawer = url.searchParams.get("drawer") ?? "";
  const reviews = reviewQueue(state);
  const render = async (name: LiveRegion): Promise<string | undefined> => {
    switch (name) {
      case "notify": return renderNotifications(reviews, task, notifyLimit(url.searchParams.get("notify")));
      case "daemon": return renderDaemonPill(options.root);
      case "board": return renderBoard(state);
      case "detail": return task ? (await renderTaskBody(options, state, task, false, maxAgeMs))?.html ?? taskNotFound(options, task) : undefined;
      case "drawer": return drawer ? (await renderTaskBody(options, state, drawer, true, maxAgeMs))?.html ?? drawerNotFound(drawer) : undefined;
      default: return undefined;
    }
  };
  const regions: Record<string, { hash: string; html: string }> = {};
  for (const [name, hash] of known) {
    const html = await render(name as LiveRegion);
    if (html === undefined) continue;
    const next = regionHash(html);
    if (next !== hash) regions[name] = { hash: next, html };
  }
  return { ok: true, ...(drawer ? { drawer } : {}), regions, reviews: { count: reviews.length, items: reviews.map((item) => ({ id: item.id, title: item.title, gate: gateLabel(item.gate) })) } };
};
