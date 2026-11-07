/**
 * Local web UI for the AI-DLC loop and task status.
 *
 * Read-only over canonical local state (`.agents/data/state/aidlc-state.json`).
 * Loop start/resume are thin facades that spawn the installed `loop-entry.mjs`
 * exactly as `aidlc-kit loop` does; gate approval is a thin facade that spawns
 * the same atomic `state.mjs gate approve` command, and gate feedback spawns the
 * audited `state.mjs task status … --status active --mode audited` cancel (the
 * task stays at its gate; the loop lead revises and re-presents it). This module
 * never mutates lifecycle state itself and never bypasses the fail-closed gate
 * channel.
 *
 * Built on `node:http` only; Bulma CSS, the dashboard theme layer, and the
 * client scripts are vendored static assets (no CDN, no runtime npm dependency).
 * Mutating actions (loop start/resume, gate feedback, gate approve) require a
 * per-session token generated at server start and printed once to the terminal.
 *
 * The implementation lives in `./ui/` (see `./ui/server.ts` for the route
 * table); this module is the stable public entry point.
 */
export { openBrowser, readUiTokenFile, resolveUiMode, scrubbedEnv, type UiAuthorityMode, type UiOptions } from "./ui/options.js";
export { requestAllowed } from "./ui/security.js";
export { daemonHealth, daemonStatus, type DaemonError, type DaemonStatus } from "./ui/daemon.js";
export { markdownToHtml } from "./ui/markdown.js";
export { NOTIFY_PAGE } from "./ui/views/layout.js";
export { DONE_COLUMN_LIMIT } from "./ui/views/board.js";
export { SSE_REPLAY_LINES } from "./ui/sse.js";
export { createUiHandler, startUiServer } from "./ui/server.js";
