# Web UI improvement proposal

## 1. Purpose and scope

This document proposes improvements to the minimal local web dashboard exposed by
`aidlc-kit ui`. The deliverable for this task is **documentation only**; no
source code, tests, or lifecycle state are changed by this proposal.

The current dashboard is defined by `src/task-ui.ts` and documented in
`docs/command-reference.md` under the `ui` command. It is intentionally small:
it renders a task table, exposes read-only JSON endpoints, and can start or
resume the loop as a thin facade over `loop-entry.mjs`. This proposal keeps those
boundaries and improves usability, operability, and safety without turning the UI
into a second lifecycle authority.

In scope:

- Dashboard information architecture and task navigation.
- Read-only API ergonomics for polling clients.
- Visibility-aware status refresh.
- Accessibility, responsive layout, and error/empty states.
- Preservation of the existing trust and safety boundaries.

Out of scope:

- Approving any gate from the browser.
- Mutating canonical lifecycle state through the UI.
- Fleet/remote control actions in v1.
- A UI localization framework or new runtime dependencies.

## 2. Current state

The implementation in `src/task-ui.ts` currently provides:

- `GET /` — an HTML task table with id, title, phase, gate, status, risk, areas,
  and per-task resume controls.
- `GET /api/tasks` — paginated/filtered task summaries.
- `GET /api/tasks/:id` — one task object.
- `GET /api/loop/status?task-id=` — loop run record and derived next action.
- `POST /api/loop/start` — starts a loop from a requirement.
- `POST /api/loop/resume` — resumes a paused/blocked task.
- HTML escaping, request-body size limiting, and `127.0.0.1` binding by
  default.

The unit tests in `test/unit/ui.test.ts` cover dashboard rendering, read-only
JSON endpoints, not-found handling, and validation of bad start/resume requests.

## 3. Approved decisions applied

| Decision ID | Label | Status | Constraint applied by this proposal |
| --- | --- | --- | --- |
| `ui-proposal-deliverable` | Deliverable scope of this task | approved | This task produces a proposal document only; implementation remains separate. |
| `ui-proposal-path` | Placement of proposal | approved | The proposal lives at `docs/web-ui-improvement-proposal.md`. |
| `ui-proposal-language` | Language of proposal | approved | The proposal and UI copy remain in English. |
| `ui-gate-approval` | Gate approval from UI | approved | Gate approval stays on the trusted terminal; the UI only displays gate state. |
| `ui-realtime` | Realtime update mechanism | approved | Use visibility-aware polling in v1; do not add push transport yet. |
| `ui-fleet` | Fleet/remote mode in UI | approved | v1 remains local canonical state only; fleet status is a documented follow-up. |
| `ui-i18n` | UI internationalization | approved | Display task language (`vi` or `en`) as data; do not add a localization framework. |

These decisions are consistent with `docs/design-decisions.md` D10, which
restricts task language to `vi` or `en` and defers broader internationalization.

## 4. Proposed improvements

### 4.1 Information architecture

1. Add a task detail route or expandable row that links to the existing
   `GET /api/tasks/:id` response, showing title, phase, gate, status, risk,
   areas, artifacts, decisions, and recent evidence.
2. Show the derived next action and loop status inline for the selected task
   instead of requiring a separate manual status request.
3. Add filter controls for status, phase, gate, risk, and free-text query,
   reusing the existing `/api/tasks` query parameters.
4. Add clear empty, loading, and error states for the dashboard and for failed
   loop status requests.
5. Keep the start form, but make validation and submission feedback explicit in
   the page rather than relying only on browser form behavior.

### 4.2 Read-only API ergonomics

1. Preserve the current JSON endpoints and their read-only semantics.
2. Add stable response envelopes and error codes so browser and CLI clients can
   distinguish validation, not-found, and server errors.
3. Support conditional requests for polling clients using `ETag` or
   `Last-Modified` based on canonical state file metadata.
4. Keep request body limits and strict parsing for `start` and `resume`.
5. Document all query parameters and response shapes in `docs/command-reference.md`.

### 4.3 Realtime updates

1. Refresh task and loop status with visibility-aware polling every five
   seconds while the tab is visible.
2. Pause polling while the tab is hidden and resume on visibility change.
3. Provide a manual refresh control.
4. Do not introduce WebSockets or Server-Sent Events in v1. The state changes
   originate from separate loop processes, and polling is simpler, dependency-free,
   and consistent with the local-first model. Revisit SSE only if polling proves
   insufficient.

### 4.4 Accessibility and responsive design

1. Use semantic table markup, associated labels, and keyboard-operable controls.
2. Do not convey status by color alone; include text labels.
3. Ensure focus management for filters, forms, and refresh controls.
4. Make the table horizontally scrollable or card-based on small screens.
5. Keep the page usable without JavaScript where practical, while allowing
   enhanced polling behavior when JavaScript is available.

### 4.5 Security and trust boundaries

The proposal must preserve these invariants:

1. The UI remains read-only over canonical local state.
2. Gate approval remains on the trusted terminal through
   `node .agents/aidlc/scripts/loop-gate.mjs <task-id>`.
3. The UI never mutates lifecycle state or approves a gate.
4. Loop start/resume remain thin facades over `loop-entry.mjs`.
5. Default host binding remains `127.0.0.1`; `--host 0.0.0.0` remains an
   explicit opt-in.
6. HTML output remains escaped, and request bodies remain size-limited.
7. No credentials, tokens, or secrets are rendered in dashboard HTML or JSON.

### 4.6 Fleet and remote mode

v1 of the UI improvement should remain scoped to local canonical state. Fleet
and remote status are valuable, but they introduce credential, network, and
authority concerns that should be handled in a separate, explicitly scoped
follow-up. That follow-up may add:

1. Read-only display of fleet/remote task status when configured.
2. Clear indication that the displayed state is remote and not locally
   authoritative.
3. No remote control actions and no gate approval from the browser.

### 4.7 Internationalization

The UI should remain English. Task language is project data and may be `vi` or
`en`; the dashboard should display that value without translating task content
or adding a localization framework. This follows D10 and avoids expanding the
scope beyond the approved language decision.

## 5. Proposed implementation phases

### Phase 1 — Usability and accessibility

- Improve layout, empty/loading/error states, and responsive behavior.
- Add filters and manual refresh.
- Add unit tests for rendered controls and query handling.

### Phase 2 — Task detail and derived status

- Add task detail rendering using existing task data.
- Show derived next action and loop status inline.
- Add conditional-request support for polling.

### Phase 3 — Fleet status follow-up

- Design read-only fleet status display separately.
- Add tests for remote-state handling and failure modes.

### Phase 4 — Optional transport review

- Evaluate Server-Sent Events only if polling latency or load becomes a
  demonstrated problem.

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