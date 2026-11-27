# Reading a review

A posted review has a fixed order. The unfolded part is meant to be enough for a
decision; everything else sits in disclosure elements below it.

## Header

```text
CiviReview: 🔴 Issues found · 1 high, 1 check failed
Fixes the contact lookup. A/B testing proved 1 test(s) failed on base, passed on PR.

To address (2)
- [ ] HIGH  CRM/Contact/BAO/Contact.php:11 — Inline bug
- [ ] Check failed  CI: 1 check failed

Questions (1)
- [ ] MEDIUM  CRM/Contact/Page/View.php:40 — Untouched caller mismatch

✅ CI · ❌ Proof of fix · ⚠️ Surface · ❔ Browser
▸ Findings outside the diff (1)
▸ Verification (6 checks, 1 not verified)
▸ Reviewer threads (1 open)
▸ More: Walkthrough · standards · blast radius · related (2)
```

The first line holds the verdict and, for *Issues found*, the confirmed findings by
severity and the number of failed checks. The second says what the PR changes and
what the A/B run proved. *To address* lists every condition the PR description states
for merging (a release, a date, another PR), every confirmed finding (severity, location,
title), every failed check and every conflicting or duplicate PR, one checkbox each.
*Questions* lists what is not confirmed: every `NEEDS_QUESTION` finding and every open
reviewer thread. The checks line has one icon per check that applies
(✅ pass, ⚠️ warning, ❌ failed, ❔ not verified); the details are in *Verification*.

**Verdict**

The verdict says what the checks turned up, not whether the PR should be merged. *No
issues found* means the PR is ready for a human to review; the approach, the timing and
everything listed under *Outside this review* are theirs to judge.

| Verdict | Condition |
| --- | --- |
| No issues found | no posted finding, no failed check, no unanswered reviewer thread, and for a code PR a runtime check with a result or none that applies |
| Not verified | nothing found, but the runtime checks of a code PR (proof of fix, base-test regression, version matrix, browser A/B) should have run and none gave a result, whether the run broke or A/B or its tests were switched off; A/B never applies to a repository that is neither core nor an extension |
| Questions only | nothing confirmed: only `NEEDS_QUESTION` findings or an unanswered reviewer thread, and no failed check |
| Issues found | a `PROVEN` or `CONFIRMED` finding of any severity, or a failed check among CI, proof of fix, base-test regression, version matrix, browser A/B, CMS browser A/B, taint delta, demo |

The verdict names the strongest thing found; the severity beside it and in the lists
says how much it weighs. With `review.reviewEvent: REQUEST_CHANGES` a review requests
changes only for a failed check or a confirmed critical or high finding.

**Reaction.** The comment that asked for the review gets 👀 while the review runs, then
👍 for *No issues found* and 😕 for every other verdict.

**Profile and kind.** The PR, profile, kind and commits line opens *Verification*. The profile says where the change could be verified
([profiles.md](profiles.md)); the kind is the triage model's classification of the
change.

## Score

The rationale opens *Verification*. The score starts at 5. Each rule below caps it; the lowest cap wins. The rationale lists
up to three reasons, the deciding one first.

| Cap | Reason |
| --- | --- |
| 1 | a confirmed critical finding; two or more confirmed high findings |
| 2 | one confirmed high finding; the change fails on a CMS other than Standalone; a critical question; CI failed; taint delta found new errors; browser A/B found regressions; the demo reported errors; proof of fix found regressions |
| 3 | a confirmed medium finding; a high question; proof of fix did not run cleanly; a new test passes on the unfixed base; base-test regression failed; the version matrix failed; not verified at runtime (the Not verified case above) |
| 4 | any other finding; code of a CMS integration that did not run on its CMS, or ran there only as a login and page loads; CI failure that looks like an unrelated flake; proof of fix without a fail-to-pass transition; warnings in base-test regression, surface diff or browser A/B; unanswered reviewer feedback; neither proof of fix nor base-test regression ran a test (except for docs-only and refactoring PRs) |

A test that civireview leaves out without a check of its own (an extension's browser
tests with the browser check switched off) only shows under *Not verified*; the review
can then still be No issues found, with the cap of 4 when no A/B test ran.

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
| CMS Browser A/B | on each CMS whose integration the PR changes, a login, the dashboard and the contact search work without and with the change, and the change logs no new script error; it fails when a page that loads on the base shows no CiviCRM with the change |
| Reviewer Thread | questions of human reviewers in the PR are answered by the current head |

A row is absent when the check does not apply to the profile.

**Browser A/B and the dashboard.** If no route of the changed screen could be found,
only the dashboard is loaded, or a route the diff names on an unchanged line. A clean result is then `NOT_VERIFIED` with a hint to name
a route (`@civireview --page civicrm/…`). A regression on the dashboard still fails.
A `PASS` always lists the routes it covers under *Standalone browser A/B* in
*Verification*; this check loads pages and does not operate forms. Forms and dialogs are
clicked through by the review stages where they judge it necessary, and a finding proven
that way quotes its steps.

**Code of one CMS integration.** Files named after a CMS (`CRM/Utils/System/Joomla.php`,
`css/wordpress.css`) do not run on Standalone. civireview records the PR on that CMS
with `ck demo --cms`, on civikitchen's image of that CMS with core master from its last
daily build; a PR that does not apply to it gives `NOT_VERIFIED` with that reason. When the PR changes nothing but
such files and no run on the CMS gave a result, the review is Not verified with a
score of at most 3, and the Standalone browser row is left out. When it also
changes shared code, the confidence is at most 4. A clean run on the CMS is a login and
page loads; it does not reach an installer or a user sync, so the confidence stays at
most 4 then too.

**Outside this review.** *Verification* ends with what no check looks at: other CMS than
those named, other viewports than 1280×800, whether the approach suits the project, and
when to merge. A merge condition from the PR description is repeated under *To address*
and does not change verdict or confidence.

## Not verified

Inside *Verification*, below the matrix: everything the run could not establish: checks that were skipped, timed out or disabled,
schema and upgrade changes the profile cannot execute, a truncated diff. Read it
together with the matrix. A finding labelled `CONFIRMED` on code that also appears here
has not been exercised by anything.

## Folded sections

| Section | Content |
| --- | --- |
| Findings outside the diff | each such finding with defect, fix, failure scenario and evidence |
| Verification | score rationale, PR/profile/kind/commits, the matrix, *Not verified*, standalone browser A/B (probed routes, counts per regression type, screenshots) |
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
