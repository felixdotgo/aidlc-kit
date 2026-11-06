# Web UI improvement proposal

## 1. Purpose and scope

This document describes the local web dashboard exposed by `aidlc-kit ui` and
scopes the remaining improvements. The dashboard has grown well beyond the
minimal task table of the original design: it now provides a server-rendered
kanban board and list view, a per-task detail page with rendered artifacts and a
live event log, a read-only JSON API, and token-gated loop actions and gate
approval. This proposal records that implemented state as the baseline and then
maps the approved UI decisions to concrete constraints and follow-up work. The
deliverable for this task remains **documentation only**; no source code, tests,
or lifecycle state are changed by this proposal.

The implementation lives in `src/task-ui.ts`, with vendored styles in
`assets/ui/` (Bulma plus a dashboard theme layer), and is documented in
`docs/command-reference.md` under the `ui` command. It is built on `node:http`
only — no CDN and no runtime npm dependency — and it remains a facade over the
same installed lifecycle scripts the terminal uses, not a second lifecycle
authority.

In scope:

- Dashboard information architecture: kanban/list views, filtering, and a review
  queue for tasks waiting at a human gate.
- A per-task detail page with rendered artifacts, decisions, work items,
  evidence, and a live event log.
- A read-only JSON API for polling and programmatic clients.
- Token-gated loop actions (start/resume) and gate approval as thin facades.
- Realtime event streaming over Server-Sent Events.
- Vendored styling (Bulma plus a dashboard theme), accessibility, responsive
  layout, and error/empty states.

Out of scope:

- Mutating canonical lifecycle state directly: every mutating action is a thin
  facade over the installed `loop-entry.mjs` or `state.mjs` scripts.
- Replacing or bypassing the terminal gate channel: browser approval runs the
  same atomic `state.mjs gate approve` command and stays fail-closed.
- Fleet/remote control actions; remote task status, when shown, is read-only.
- A UI localization framework or new runtime dependencies.

## 2. Current state

The implementation in `src/task-ui.ts` provides a server-rendered dashboard and a
read-only JSON API, styled by vendored Bulma and a dashboard theme layer in
`assets/ui/` (no CDN, no runtime npm dependency).

The dashboard (`GET /`) renders a kanban board by default, with one column per
phase (clarify → plan → build → wrap → done) and a list/table toggle. The header
shows whether the loop daemon is running and hosts the Settings and New task
modals; summary stats and a review queue surface tasks that are `blocked_on_user`.
Free-text search and status/risk filters run client-side over the rendered cards,
and keyboard shortcuts are available (`N` new task, `/` search, `Esc` close).
Clicking a task opens a quick-view modal; ctrl/cmd-click or middle-click opens the
full detail page.

The task detail page (`GET /tasks/:id`, with `GET /partial/tasks/:id` returning
the same body as an HTML fragment for the modal) renders:

- The recorded `intent`/`design`/`workplan` artifacts as HTML through an
  escaping-first Markdown renderer.
- Decisions, work items (with progress), and verification evidence as tables.
- A structured gate view while the task is `blocked_on_user`, including
  diagnostics when the gate check no longer passes.
- An approve form (full page only) that submits to the token-gated approve
  proxy.
- A live log that streams that task's events over Server-Sent Events.
- A phase timeline, detail metadata, and the derived loop status.

The JSON API exposes:

- `GET /api/tasks` — paginated/filtered task summaries (`?archive=1`,
  `?statuses=`, `?query=`, `?limit=`, `?cursor=`).
- `GET /api/tasks/:id` — one task object.
- `GET /api/tasks/:id/gate` — the gate payload for a task waiting at a gate.
- `GET /api/tasks/:id/artifact/:name` — raw `intent`/`design`/`workplan`
  content for programmatic clients.
- `GET /api/loop/status?task-id=` — the loop run record and derived next action.
- `GET /api/events?task-id=` — a Server-Sent Events stream of the JSONL
  event-log sidecar; it replays the last 200 matching lines on connect, follows
  rotation and truncation, and resumes from `Last-Event-ID`.
- `POST /api/loop/start` — runs loop intake to create a loop-owned task and
  starts the daemon if none is running.
- `POST /api/loop/resume` — re-activates a `paused` task.
- `POST /api/gate/approve` — runs the atomic `state.mjs gate approve` command.
- `GET /assets/bulma.css` and `GET /assets/dashboard.css` — the vendored
  stylesheets.

The mutating endpoints (`start`, `resume`, `gate approve`) require a per-session
token generated at server start and printed once to the terminal; it is entered
through the Settings modal, stored in `localStorage`, and compared with a
timing-safe hash. All three actions are thin facades that spawn the installed
`loop-entry.mjs` or `state.mjs` scripts — the module never mutates lifecycle
state itself. HTML output is escaped, request bodies are limited to 8192 bytes,
and the server binds `127.0.0.1` by default on port 4173 (`--host 0.0.0.0` is an
explicit opt-in), so canonical state is not exposed to the network.

The unit tests in `test/unit/ui.test.ts` cover dashboard and detail rendering,
the read-only JSON and SSE endpoints, artifact and gate payloads, escaping,
token-gated fail-closed behavior, and validation of start/resume/approve
requests.

## 3. Approved decisions applied

| Decision ID | Label | Status | Constraint applied by this proposal |
| --- | --- | --- | --- |
| `ui-proposal-deliverable` | Deliverable scope of this task | approved | This task produces a proposal document only; implementation remains separate. |
| `ui-proposal-path` | Placement of proposal | approved | The proposal lives at `docs/web-ui-improvement-proposal.md`. |
| `ui-proposal-language` | Language of proposal | approved | The proposal and UI copy remain in English. |
| `ui-gate-approval` | Browser gate approval (approve proxy) | changed | Browser gate approval runs through a token-gated approve proxy (`POST /api/gate/approve`) that executes the atomic `state.mjs gate approve`; terminal approval remains available and the action stays fail-closed. |
| `ui-realtime` | Realtime transport (SSE log streaming) | changed | Realtime transport uses Server-Sent Events (`GET /api/events?task-id=`); the stream replays the last 200 matching lines on connect, follows rotation and truncation, and resumes from `Last-Event-ID`. |
| `ui-fleet` | Fleet/remote read-only status | changed | Fleet/remote task status is read-only when shown; no remote control actions and no remote gate approval from the browser. |
| `ui-styling` | Styling approach (vendored Bulma) | approved | Styling is vendored Bulma plus a dashboard theme layer in `assets/ui/` (`GET /assets/bulma.css`, `GET /assets/dashboard.css`); no CDN and no runtime npm dependency. |
| `ui-i18n` | UI internationalization | approved | Display task language (`vi` or `en`) as data; do not add a localization framework. |

Three decisions changed during re-evaluation: gate approval moved from
terminal-only display to a token-gated approve proxy, realtime transport moved
from visibility-aware polling to SSE log streaming, and fleet/remote task status
became read-only instead of a deferred follow-up. Styling was added as a new
decision (vendored Bulma, no CDN).

The mutating actions (new task, resume, gate approve) share a token-auth model:
a per-session token generated at server start and printed once to the terminal,
entered through the Settings modal, stored in `localStorage`, and compared with
a timing-safe hash. Each action is a thin facade that spawns the installed
`loop-entry.mjs` or `state.mjs` scripts; the module never mutates lifecycle
state itself.

These decisions are consistent with `docs/design-decisions.md` D10, which
restricts task language to `vi` or `en` and defers broader internationalization.

## 4. Remaining improvements and follow-ups

Sections 2 and 3 record the implemented baseline and the approved decisions it
applies. Most of the original proposal is already implemented and covered by
`test/unit/ui.test.ts`; the improvements below are the parts that remain.

### 4.1 Read-only API ergonomics

1. Add conditional-request support for polling clients using `ETag` or
   `Last-Modified` derived from canonical state file metadata, so `/api/tasks`
   and `/api/tasks/:id` can return `304 Not Modified`.
2. Add machine-readable error codes to the JSON error payload so browser and CLI
   clients can distinguish validation, not-found, gateway, and server errors
   without matching error strings. (The current `{ ok: false, error }` payloads
   are uniform but carry no stable code.)
3. Preserve the existing read-only semantics, request-body limits, and strict
   parsing for `start`, `resume`, and `gate approve`; these are already
   implemented and tested.

### 4.2 Realtime transport

The original plan proposed visibility-aware polling and explicitly deferred
Server-Sent Events. That decision was reversed during re-evaluation: realtime
transport is now Server-Sent Events over `GET /api/events?task-id=`, which
replays the last 200 matching lines on connect, follows rotation and truncation,
and resumes from `Last-Event-ID`. No client-side polling loop remains.

Remaining follow-up (optional): client-side auto-reconnect with backoff when the
stream drops mid-rotation. This is hardening, not a transport change.

### 4.3 Accessibility and responsive design

The dashboard already uses semantic markup, associated labels, keyboard-operable
controls, keyboard shortcuts (`N`, `/`, `Esc`), non-color status labels, and a
card-based layout that stays usable on small screens. Server-rendered board and
detail pages remain navigable without JavaScript; filters, modals, and shortcuts
are progressive enhancements. No further work is planned beyond applying these
standards to any new UI.

### 4.4 Security and trust boundaries

The proposal preserves these invariants, updated to match the implemented
approve proxy:

1. The UI remains read-only over canonical local state; the module never mutates
   lifecycle state itself.
2. Gate approval is available on the trusted terminal through
   `node .agents/aidlc/scripts/loop-gate.mjs <task-id>` and, additionally,
   through the token-gated browser approve proxy (`POST /api/gate/approve`),
   which runs the same atomic `state.mjs gate approve` command and stays
   fail-closed.
3. Loop start/resume remain thin facades over `loop-entry.mjs`.
4. Default host binding remains `127.0.0.1`; `--host 0.0.0.0` remains an
   explicit opt-in.
5. HTML output remains escaped, and request bodies remain size-limited (8192
   bytes).
6. No credentials, tokens, or secrets are rendered in dashboard HTML or JSON;
   the session token is compared with a timing-safe hash and never echoed.

### 4.5 Fleet and remote mode

The UI remains scoped to local canonical state. Fleet and remote task status are
valuable, but they introduce credential, network, and authority concerns that
should be handled in a separate, explicitly scoped follow-up. When shown, that
follow-up will:

1. Display fleet/remote task status read-only, clearly marked as remote and not
   locally authoritative.
2. Offer no remote control actions and no remote gate approval from the browser.

### 4.6 Internationalization

The UI remains English. Task language is project data and may be `vi` or `en`;
the dashboard displays that value without translating task content or adding a
localization framework. This follows D10 and avoids expanding the scope beyond
the approved language decision.

## 5. Implementation phases and remaining work

### Phase 1 — Usability and accessibility (complete)

- Layout, empty/loading/error states, and responsive behavior.
- Filters, search, keyboard shortcuts, and the review queue.
- Unit tests for rendered controls, filtering, and escaping.

### Phase 2 — Task detail and derived status (complete)

- Task detail page (`/tasks/:id`) and modal fragment (`/partial/tasks/:id`).
- Inline derived loop status and the structured gate view.
- Rendered artifacts, decisions, work items, and evidence.

### Phase 3 — Realtime transport (complete)

- Server-Sent Events log streaming over `/api/events?task-id=`, with replay,
  rotation/truncation following, and `Last-Event-ID` resume. This supersedes the
  original visibility-aware polling plan.

### Phase 4 — Read-only API hardening (remaining)

- Conditional requests (`ETag`/`Last-Modified`) for polling clients.
- Machine-readable error codes in JSON error payloads.

### Phase 5 — Fleet status follow-up (remaining)

- Read-only fleet/remote status display, designed and tested separately for
  remote-state handling and failure modes.

## 6. Verification plan

Implementation of this proposal should be verified with:

1. `npm run build` and `npm run lint`.
2. `node --test dist/test/unit/ui.test.js`.
3. Additional unit tests for:
   - filter rendering and query forwarding,
   - task detail rendering,
   - conditional request headers,
   - visibility-aware polling behavior where testable,
   - absence of gate-approval controls.
4. Manual checks:
   - dashboard renders with no tasks,
   - filters and pagination work,
   - polling pauses when the tab is hidden,
   - remote host binding requires explicit opt-in,
   - no gate approval action is available in the UI.

## 7. Risks and open questions

1. Polling every five seconds may add avoidable load for large task sets; the
   interval and conditional requests should be tuned during implementation.
2. Inline task detail can make the dashboard dense; progressive disclosure may
   be needed.
3. Fleet status display must not imply that the UI can approve or mutate remote
   state.
4. Browser-only enhancements must not become required for core read-only access.

## 8. Acceptance criteria

The proposal is complete when:

1. `docs/web-ui-improvement-proposal.md` exists and is reviewable.
2. The document maps each approved UI decision to a concrete constraint.
3. The document preserves read-only state access, terminal-only gate approval,
   local-first binding, and English-only UI copy.
4. A later implementation task can derive work items and tests from sections 4
   through 6.