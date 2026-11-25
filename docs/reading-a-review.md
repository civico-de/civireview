# Reading a review

A posted review has a fixed order. The unfolded part is meant to be enough for a
decision; everything else sits in disclosure elements below it.

## Header

```text
CiviReview: 🔴 Needs Changes · 2/5 ★★☆☆☆
Fixes the contact lookup. A/B testing proved 1 test(s) failed on base, passed on PR.

To address (2)
- [ ] HIGH  CRM/Contact/BAO/Contact.php:11 — Inline bug
- [ ] Check failed  CI: 1 check failed

✅ CI · ❌ Proof of fix · ⚠️ Surface · ❔ Browser
▸ Findings outside the diff (1)
▸ Verification (6 checks, 1 not verified)
▸ Reviewer threads (1 open)
▸ More: Walkthrough · standards · blast radius · related (2)
```

The first line holds verdict and merge confidence, the second what the PR changes and
what the A/B run proved. *To address* lists every posted finding (severity, location,
title), every failed check, every conflicting or duplicate PR and every open reviewer
thread, one checkbox each. The checks line has one icon per check that applies
(✅ pass, ⚠️ warning, ❌ failed, ❔ not verified); the details are in *Verification*.

**Verdict**

| Verdict | Condition |
| --- | --- |
| Ready | no posted finding, no failed check, and for a code PR a runtime check with a result or none that applies |
| Questions Only | findings, but none of them a `PROVEN` or `CONFIRMED` critical or high one, and no failed check; also an unanswered reviewer thread without findings, or a code PR whose runtime checks (proof of fix, base-test regression, version matrix, browser A/B) should have run but none gave a result, whether the run broke or A/B or its tests were switched off; A/B never applies to a repository that is neither core nor an extension |
| Needs Changes | a `PROVEN` or `CONFIRMED` critical or high finding, or a failed check among CI, proof of fix, base-test regression, browser A/B, taint delta, demo |

**Profile and kind.** The PR, profile, kind and commits line opens *Verification*. The profile says where the change could be verified
([profiles.md](profiles.md)); the kind is the triage model's classification of the
change.

## Merge confidence

The rationale opens *Verification*. The score starts at 5. Each rule below caps it; the lowest cap wins. The rationale lists
up to three reasons, the deciding one first.

| Cap | Reason |
| --- | --- |
| 1 | a confirmed critical finding; two or more confirmed high findings |
| 2 | one confirmed high finding; a critical question; CI failed; taint delta found new errors; browser A/B found regressions; the demo reported errors; proof of fix found regressions |
| 3 | a confirmed medium finding; a high question; proof of fix did not run cleanly; a new test passes on the unfixed base; base-test regression failed; the version matrix failed; not verified at runtime (the Questions Only case above) |
| 4 | any other finding; CI failure that looks like an unrelated flake; proof of fix without a fail-to-pass transition; warnings in base-test regression, surface diff or browser A/B; unanswered reviewer feedback; neither proof of fix nor base-test regression ran a test (except for docs-only and refactoring PRs) |

A test that civireview leaves out without a check of its own (an extension's browser
tests with the browser check switched off) only shows under *Not verified*; the review
can then still be Ready, with the cap of 4 when no A/B test ran.

"Confirmed" in this table covers `PROVEN` and `CONFIRMED`. When the finding that
decides the score is only `CONFIRMED`, the rationale adds "from reading the code, not
reproduced in a run". A 2/5 with that suffix means: a model read a defect and a second
model could not disprove it. A 2/5 without it means an instance showed the defect.

A score of 5 does not mean the PR is correct. It means no finding passed the gate and no
check failed; what was not checked is listed under *Not verified*.

## Findings

Each finding is tagged `[SEVERITY | VERDICT]` and carries a confidence.

| Verdict | Established by |
| --- | --- |
| `PROVEN` | a run: the A/B evidence, the extension gates or a live probe show the defect. When no run produced a result, a `PROVEN` from the verifier is lowered to `CONFIRMED` |
| `CONFIRMED` | reading the code; the verification evidence names the lines read and ends with what was not run |
| `NEEDS_QUESTION` | plausible, but depends on intent; phrased as a question to the author |

**Severity** is the verifier's, not the specialist's; the verifier often downgrades.

**Confidence** is the probability that the finding is true, not how much it matters. A
cosmetic defect that is plainly there has a high confidence and a low severity.
Findings below `review.confidenceThreshold` (default 80) are not posted as action
items; those from 50 upwards are kept under *Lower-confidence notes*.

A finding has four parts: the defect, a concrete failure scenario (input or state that
leads to a wrong result), the verification evidence, and a suggested fix. A
`suggestion` block is only offered when it would replace exactly the commented lines.

Findings on lines of the diff are inline comments: title, defect and suggested fix are
visible, failure scenario and evidence are folded under *Evidence*. Findings elsewhere
in the file tree are in *Findings outside the diff* with path and line.

## Empirical verification matrix

One row per deterministic check from the evidence layer.

| Status | Meaning |
| --- | --- |
| `PASS` | ran, nothing found |
| `WARN` | ran, found something that does not block (a11y violations, a permission change, a schema difference) |
| `FAIL` | ran, found a regression or an error |
| `NOT_VERIFIED` | did not run, or ran without covering the change |

| Row | A `PASS` means |
| --- | --- |
| CI / Jenkins | all commit statuses succeeded |
| A/B Proof-of-Fix | at least one test of the PR fails on the base and passes on the head |
| Base-Test Regression | existing tests pass on both sides |
| Version Matrix | extension repositories with `matrix` on: the head's tests pass on the floor image and on the beta image |
| Live Surface Diff | the runtime surface was captured on both sides and no risk flag was raised; without a capture the row is `NOT_VERIFIED`, or `WARN` when the diff itself touches the surface (routes, API classes, schema, upgrader, managed entities, dependencies, templates, permission checks, hooks) |
| Static / Taint Delta | the extension gates ran and found nothing new on the head |
| Browser A/B (Standalone) | the listed routes load on both sides without new errors, failed requests, a11y violations or render differences |
| Demo | the recording with the PR logged no script error the base recording lacks (opt-in) |
| Reviewer Thread | questions of human reviewers in the PR are answered by the current head |

A row is absent when the check does not apply to the profile.

**Browser A/B and the dashboard.** If no route of the changed screen could be found,
only the dashboard is loaded. A clean result is then `NOT_VERIFIED` with a hint to name
a route (`@civireview --page civicrm/…`). A regression on the dashboard still fails.
A `PASS` always lists the routes it covers under *Standalone browser A/B* in
*Verification*; the browser loads pages and does not operate forms.

## Not verified

Inside *Verification*, below the matrix: everything the run could not establish: checks that were skipped, timed out or disabled,
schema and upgrade changes the profile cannot execute, a truncated diff. Read it
together with the matrix. A finding labelled `CONFIRMED` on code that also appears here
has not been exercised by anything.

## Folded sections

| Section | Content |
| --- | --- |
| Findings outside the diff | each such finding with defect, fix, failure scenario and evidence |
| Verification | merge confidence rationale, PR/profile/kind/commits, the matrix, *Not verified*, standalone browser A/B (probed routes, counts per regression type, screenshots) |
| Reviewer threads | open questions of human reviewers and whether the head answers them |
| More | the parts below, each under its own heading; the summary names the ones present |

| Part of *More* | Content |
| --- | --- |
| Walkthrough | what the PR does and what each claim rests on, reconciled by the verifier |
| CiviCRM core standards | verdict per review standard (`r-explain`, `r-test`, `rg-upgrades`, …) |
| Ecosystem blast radius | other code the change affects |
| Related open PRs and issues | other open work touching the same files or topic, with a confidence and the reason |
| Lower-confidence notes | findings between 50 and the gate |
| Rejected or below 50% confidence | candidates the verifier rejected or rated below 50, each with its verdict and reason |

The last line of *More* gives the number of candidates that are not listed at all:
duplicates of a listed finding, and lower-confidence notes beyond the five shown. The
footer names the preset and token count; the marker after it carries `format=<n>`, the
layout version.

## Disagreeing with a finding

Reply in the thread of the inline comment with `@civireview` and the objection or
question. The answer is posted into the same thread from the PR, its diff and the
thread; it does not run the checks. To re-run everything on a new commit, comment `@civireview` on
the PR.
