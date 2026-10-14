# Work intake

Accept one or more manual messages/source envelopes. Preserve source, externalId, threadId, author, timestamp, URL and body; unknown provenance is null rather than invented. Source namespaces remain separate from destination configuration.

Classify every message: ACTIONABLE, CONTEXT, DECISION, QUESTION, REFERENCE or NOISE. Interpret goal, expected outcome and next action. ACTIONABLE can enrich an existing item. Related messages should share a source/thread/reference or a transient groupId determined from their actual meaning; unrelated messages must not be grouped merely by title similarity.

Submit `intake` with `{idempotencyKey,messages:[{classification,source,item?,references?,groupId?,selectedRef?,patch?,contextSummary?}]}`. `source` is a source envelope, not a string. An unmatched actionable message needs a complete normalized `item`. `references` are source-qualified issue/ticket/PR identities or canonical URLs; use consistent namespaces. Non-actionable messages need no item. Optional patch updates only the current projection; ordinary findings append context. When raw preservation is disabled, provide a useful contextSummary.

The runtime processes actionable messages first so earlier related context can append to newly established groups. It resolves exact source identity, thread identity, explicit references and linked task before weak keyword/title candidates. Weak candidates yield AMBIGUOUS, even when only one exists; request explicit selection. Use selectedRef only for an item the user selects and whose target the runtime validates. Contradictory identities must not be silently merged.

Results are CREATE, UPDATE, APPEND_CONTEXT, IGNORE or AMBIGUOUS per input message. Capture returns a current summary plus append-only source context; stable-source replay appends nothing twice. Noisy/unrelated informational messages create no unnecessary work. If an operation fails after earlier effects, report the partial-work risk and reconcile before retrying. Do not label an interrupted batch as fully synchronized.

Present created/enriched refs and concise next actions. AutoReady may advance fully described incoming work, but never move to DOING from perceived importance. Intake alone neither creates an AI-DLC task nor starts implementation.
