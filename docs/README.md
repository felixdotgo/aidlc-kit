# Documentation

Pick a page by what you want to do. New here? Install with the [README](../README.md), then read [Operating the workflow](./operating-workflow.md).

> [!WARNING]
> The loop, fleet mode, and the coordination service are pre-1.0 and experimental. See [Status and stability](./loop-runbook.md#status-and-stability).

## Get started

| Page | Read it when… |
| --- | --- |
| [README](../README.md) | You are installing the workflow into a project. |
| [Loop setup runbook](./loop-runbook.md) | You want to enable the loop, locally or across machines. |
| [Local loop walkthrough](./loop-local-run.md) | The loop is set up and you want to add tasks, watch them, approve gates, and use the dashboard. |

## Use and operate

| Page | Read it when… |
| --- | --- |
| [Operating the workflow](./operating-workflow.md) | You want the lifecycle, task state, review gates, and handoffs. |
| [AI-DLC Coordination service](./coordination-service.md) | You are deploying remote state or fleet workers on several machines. |

## Reference

| Page | Read it when… |
| --- | --- |
| [Configuration](./configuration.md) | You are editing `.agents/config.json`: profiles, rules, agent permissions, loop settings. |
| [Command reference](./command-reference.md) | You need a command, flag, environment variable, or installed script. |
| [Troubleshooting](./troubleshooting.md) | You have an error code, a stuck or paused task, or a dashboard problem. |

## Contribute

| Page | Read it when… |
| --- | --- |
| [Development](./development.md) | You are setting up this repository, dogfooding its workflow, or changing source. |
| [Testing and release](./testing-and-release.md) | You are verifying a change or preparing a release. |
| [Architecture](./architecture.md) | You are changing a package boundary, installed runtime, migration, or asset layout. |
| [Design decisions](./design-decisions.md) | You need the reasoning behind a project-wide decision, or must record one. |

## Adding or changing a page

Pages are flat `docs/<slug>.md` files; the dashboard, tests, and external links depend on the names.

- **Shape:** `# Title`, a 1–2 sentence opening (purpose and audience), `##` headings by reader task, tables for lookups, `## Related` with 2–4 links.
- **One source of truth:** each fact lives on one page; other pages give one sentence and a link. Experimental features get only a one-line callout to [Status and stability](./loop-runbook.md#status-and-stability).
- **Links:** `./<slug>.md#anchor`. The dashboard keeps links to pages in `DOC_PAGES` (`src/ui/docs.ts`) in-app and opens the rest on GitHub. Don't rename a linked heading without updating the links.
- **Register it:** add the page to a table above; to show it in the dashboard, add it to `DOC_PAGES` and run `node --test dist/test/unit/ui-docs.test.js` after `npm run build`; if the package must always ship it, add it to the docs test in `test/unit/installer.test.ts`.
- **Versions:** pages with version-pinned commands go on the [version bump checklist](./testing-and-release.md#version-bump-checklist).

A public command, configuration field, or installed-layout change updates the relevant page and its test in the same change.
