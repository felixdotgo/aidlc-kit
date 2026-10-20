# Model collaboration contract

Use this managed baseline with any AI model. It standardizes communication; it does not replace canonical state, executable verification, human gates, or approved task decisions. Project-specific additions belong in `.agents/project/rules/`.

## COSTARS — task context

Express the applicable parts of a task in this order:

1. **Context** — current phase, task state, relevant files/spec anchors, constraints, and known risks.
2. **Objective** — the concrete result to produce and the boundary of responsibility.
3. **Style** — required reasoning/implementation style, such as evidence-first or minimal diff.
4. **Tone** — concise, direct, and calibrated to the intended reader.
5. **Audience** — human reviewer, implementer, or another model; state their assumed context.
6. **Response format** — exact headings, structured data, file paths, or commands expected.
7. **Success criteria** — observable acceptance conditions, required evidence, and when to stop/escalate.

Omit fields that the active phase packet already makes explicit; never invent a spec, approval, or passing result to complete the format.

## Phase mapping

| phase | required COSTARS emphasis | output |
|-------|---------------------------|--------|
| clarify | Context, Objective, Audience, Success criteria | intent, assumptions, open questions, scope |
| plan | Context, Objective, Response format, Success criteria | design, explicit decisions, workplan, verification plan |
| build | Context, Objective, Style, Success criteria | smallest approved diff and executable verification evidence |

Use CRITICS during clarify or plan only when risk is elevated, requirements are ambiguous, or models disagree.

## CRITICS — adversarial review

Before recording passing review evidence for Review implementation, report these sections against the approved decisions, cited anchors, and task diff:

1. **Criteria** — acceptance criteria, invariants, and exact spec anchors checked.
2. **Risks** — regression, safety, compatibility, and unverified assumptions.
3. **Issues** — each finding with severity (`critical`, `high`, `medium`, `low`) and evidence; state `none found` when applicable.
4. **Tests / evidence** — commands or inspections run, results, and residual gaps.
5. **Improvements** — required fixes or explicitly deferred follow-ups, each tied to an issue.
6. **Conclusion** — `pass`, `needs changes`, or `escalate`; a pass requires no unresolved critical/high issue.
7. **Stop / escalate** — reopen the Approve plan step for a structural/spec conflict; otherwise defer to the human gate when authority is needed.

CRITICS is a review record, not approval. Only the state machine, recorded evidence, and human Review implementation approval advance the task.
