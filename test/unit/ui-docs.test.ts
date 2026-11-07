import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_DOC, DOC_PAGES, readDoc } from "../../src/ui/docs.js";
import { headingSlug, renderDocHtml, renderDocsPage } from "../../src/ui/views/docs.js";

test("every whitelisted guide ships in docs/ and unknown or path-like slugs are refused", () => {
  for (const page of DOC_PAGES) assert.ok(readDoc(page.slug)?.markdown.startsWith("# "), `${page.slug}.md is readable`);
  assert.equal(DEFAULT_DOC, "loop-runbook");
  for (const slug of ["../package", "..%2Fpackage", "README", "development", "", "loop-runbook.md"]) assert.equal(readDoc(slug), undefined, slug);
});

test("headingSlug matches GitHub anchors used by the guides", () => {
  assert.equal(headingSlug("5.1 Set environment variables"), "51-set-environment-variables");
  assert.equal(headingSlug("Run the loop in <code>local</code> mode"), "run-the-loop-in-local-mode");
  assert.equal(headingSlug("Step 2 — Set the environment"), "step-2--set-the-environment");
  assert.equal(headingSlug("Parallel work partition (PARTITION_OVERLAP / PARTITION_SCOPE)"), "parallel-work-partition-partition_overlap--partition_scope");
});

test("renderDocHtml adds heading ids and a contents list, keeps links in-app, and styles callouts", () => {
  const { html, toc } = renderDocHtml([
    "# Title",
    "## Check configuration & sync",
    "## Setup",
    "### Setup",
    "See [config](./configuration.md#loop) and [dev](./development.md).",
    "",
    "> [!WARNING]",
    "> Experimental.",
  ].join("\n"));
  assert.match(html, /<h2 id="setup">/);
  assert.match(html, /<h3 id="setup-1">/, "duplicate headings get unique ids");
  assert.deepEqual(toc.map((entry) => entry.id), ["check-configuration--sync", "setup", "setup-1"]);
  assert.equal(toc[0]?.text, "Check configuration &amp; sync", "already-escaped text, not escaped twice");
  assert.match(html, /href="\/docs\/configuration#loop"/);
  assert.match(html, /href="https:\/\/github\.com\/felixdotgo\/aidlc-kit\/blob\/main\/docs\/development\.md" target="_blank" rel="noopener"/);
  assert.match(html, /<blockquote class="ad-doc-callout is-warning"><strong class="ad-doc-callout-title">Warning<\/strong> Experimental\./);
});

test("renderDocsPage renders the sidebar with the active guide, or undefined for unknown slugs", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-docs-"));
  try {
    const html = await renderDocsPage({ root, host: "127.0.0.1", port: 0 }, "configuration");
    assert.ok(html);
    assert.match(html, /<a href="\/docs\/configuration" class="is-active" aria-current="page">Configuration<\/a>/);
    assert.match(html, /<a href="\/docs\/loop-runbook">Getting started<\/a>/);
    assert.match(html, /On this page/);
    assert.match(html, /<title>Configuration · Docs · Loop<\/title>/);
    assert.equal(await renderDocsPage({ root, host: "127.0.0.1", port: 0 }, "nope"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
