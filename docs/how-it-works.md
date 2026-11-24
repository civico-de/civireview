# How a review is produced

This page follows one review from the trigger to the posted comment. The running
example is a PR against civicrm-core that adds a column and an admin form field to the
bundled extension `ext/oauth-client`; the profile is `core-extension`
(see [profiles.md](profiles.md)).

```text
trigger ─► evidence (no model) ─► review (models, no PR code) ─► publish (no model)
            evidence.json           review.json                    GitHub review
```

The three layers exchange files only. That is what allows the GitHub workflow to give
each layer a job of its own with different permissions ([security.md](security.md)).

## 1. Trigger

A review starts from `civireview pr`, from an `@civireview` comment handled by the
reusable workflow, or from the mention watcher ([running.md](running.md)). The comment is
parsed into flags; anything after the flags is treated as a question to the reviewer.

A PR that civireview has reviewed before carries a hidden marker with the reviewed head
commit. Without `--full`, only the changes since that commit are reviewed.

## 2. Evidence

`civireview evidence` collects everything that can be established without a model and
writes it to `evidence.json`. Nothing in this layer is an opinion.

### 2.1 PR context

- PR metadata, the unified diff, all comments, review comments and reviews.
- Issues the PR links to, plus open PRs and issues that touch the same files or topic
  (candidates only; the review stage decides whether they are related).
- Commit statuses. For civicrm-core the Jenkins result is read down to the names of the
  failed tests.

The diff is filtered before anything else looks at it: generated and vendored files are
dropped and listed as noise, `review.paths` globs are applied, and a diff larger than
`review.maxDiffBytes` is truncated with a "Diff truncated" entry under *Not verified*.

### 2.2 Profile

The checkout decides the repository kind (`xml/version.xml` plus `CRM/` is core,
`info.xml` or `civikitchen.yaml` is an extension). For core, every changed path under
`ext/` is mapped to the nearest directory that has an `info.xml`; if there is one, the
profile becomes `core-extension`. In the example all changed files sit under
`ext/oauth-client`, so the extension gates below apply to it.

### 2.3 Static surface diff

From the diff alone civireview derives which parts of the CiviCRM surface the PR
touches: APIv4 entities and actions, permissions, menu routes, Afform files, managed
entities, schema definitions, upgrade steps, settings. This list drives which checks
run and which instance routes are probed, and it is handed to the models.

### 2.4 The A/B instances

civireview creates two detached git worktrees, `A` at the base commit and `B` at the
head commit, and starts a CiviCRM Standalone instance for each from the same CiviKitchen
image. The image is chosen from the base branch (core) or the extension's CiviCRM floor
(extension); if that tag is not published yet, a fallback chain ending at the stable
image is tried.

How the code gets into the instance depends on the profile: for core, the changed files
are bind-mounted one by one over the image's core tree; for an extension repository the
whole worktree is mounted as an extension. A nightly core image can be older than the
PR's base commit, so files merged to the base branch since the image was built are
mounted into both sides as well.

Every check below runs the same command on A and on B and compares the outcome.

### 2.5 Checks

| Check | What runs | Result |
| --- | --- | --- |
| Proof of fix | PHPUnit files the PR adds or changes, limited to the changed test methods | A test that fails on A and passes on B proves the fix. A new test that already passes on A proves nothing and is reported as tautological. |
| Base-test regression | Existing tests next to the changed code | A test that passes on A and fails on B is a regression. |
| Live surface diff | APIv4 entities, actions and fields, APIv3, routes and Afforms as each instance reports them | What really changed at runtime, with risk flags for permission and route changes. |
| Browser A/B | A headless browser loads routes on both sides | New console errors, page errors, failed requests, accessibility violations and render differences; before/after screenshots. |
| Taint delta | Static taint analysis of the extension on A and B | Findings that exist only on B. |
| Lifecycle | Disable, enable, uninstall and reinstall of the extension on B | Whether the extension survives its own lifecycle. |
| Upgrade parity | Install the base version, switch to the head, run the extension upgrade; compare the schema with a fresh install of the head | Whether an upgraded site ends up with the schema a new site gets. |

The last three are the extension gates. They run for the `extension` and
`core-extension` profiles only, from the extension's own directory inside the instance.
Lifecycle and upgrade parity run only when the PR touches schema, upgrader or managed
entity files.

In the example, upgrade parity is the check that actually executes the new upgrade
step. It reports a schema difference: after the upgrade the new column sits before an
existing one, after a fresh install behind it. That is harmless, and the finding says
so, but it is measured rather than read from the upgrader code.

### 2.6 Which routes the browser probes

Routes are collected in this order, up to `browser.maxAutoPages`:

1. routes named with `--page` or in `browser.pages`,
2. routes and Afforms that the live surface diff reports as changed,
3. routes defined in menu XML or Afform files that the diff touches,
4. routes mentioned in the diff or the PR description,
5. for an extension whose UI files changed (templates, Angular, JS, CSS): the routes
   that extension defines in `xml/Menu/*.xml` and `ang/*.aff.json` or `ang/*.aff.php`.

If frontend files changed and none of this yields a route, the dashboard is loaded as a
smoke test. A clean smoke test is reported as `NOT_VERIFIED`, because it shows that
CiviCRM still boots and nothing about the changed screen. In the example the admin
screen `civicrm/admin/oauth` comes from step 5; the extension is enabled on both sides
before the probe so the route exists.

The browser loads pages. It does not fill in forms or click through a workflow; a
defect that needs interaction is found by reading the code, or with the opt-in
interactive browser ([configuration.md](configuration.md)).

### 2.7 A check that did not run

Every check distinguishes three outcomes: it ran and passed, it ran and found
something, or it did not run. "Did not run" covers a missing Docker daemon, a timeout,
a tool that refused its input, a disabled check. It never produces a finding and never
counts as passed; it produces a line under *Not verified*.

## 3. Review

`civireview review` reads `evidence.json` and the checkout. It executes no code from
the PR. Models can read files, search the repository and query the CiviCRM knowledge
server; they cannot write.

All stages share one prompt prefix (PR context, diff, evidence). Stages run one after
another so that the first one writes the provider's prompt cache and the later ones
read from it.

### 3.1 Triage

One call classifies the PR (`core-bugfix`, `core-feature`, `core-ref-nfc`,
`extension-pr`, `security-sensitive`, `ui-change`, `docs-only`), sets a risk level,
picks the lenses worth running and writes the summary. The kind describes the change;
the profile describes where it could be verified. A PR in a bundled core extension has a
`core-*` kind and the `core-extension` profile.

Triage can skip the specialists with a reason (a docs-only PR). Browser findings from
layer 1 force the `ui` lens regardless.

### 3.2 Specialists

Each active lens gets its own call with a lens-specific instruction:

| Lens | Looks for |
| --- | --- |
| `correctness` | logic errors, broken contracts, upgrade and data problems |
| `security` | permission gaps, injection, exposure of data |
| `tests` | missing or meaningless tests, what the A/B run does and does not prove |
| `ui` | defects in templates and forms; receives the before/after screenshots |

A specialist returns candidate findings with path, lines, severity, a failure scenario
and a suggested fix, plus its verdicts on the CiviCRM review standards and a list of
other code the change affects.

### 3.3 Verifier

A different call in a fresh context receives the candidates and is instructed to
disprove them. Depending on the preset it runs on a stronger model or on one from
another provider. For each candidate it returns:

| Verdict | Meaning |
| --- | --- |
| `PROVEN` | reproduced: the A/B evidence or a live probe shows the defect |
| `CONFIRMED` | established by reading the code; not reproduced in a run |
| `NEEDS_QUESTION` | plausible, depends on an intent only the author knows |
| `REJECTED` | disproved; dropped |

It also reassesses the severity, sets a confidence from 0 to 100 that the finding is
true, merges duplicates and reconciles the summary and the standards table with what
survived.

At depth `deep` the verifier runs even if the specialists found nothing, and it may hand
back leads ("check whether X also happens in Y"). Each lead goes to the matching
specialist for another round and the results come back to the verifier, for at most
`review.maxFollowUpRounds` rounds.

### 3.4 Gate, verdict and score

- Findings with a confidence of at least `review.confidenceThreshold` are posted.
- Findings between 50 and the threshold go into a collapsed *Lower-confidence notes*
  section.
- Everything else is dropped; the review states how many.

The verdict and the 1–5 score are then computed from the posted findings and the
verification matrix by fixed rules ([reading-a-review.md](reading-a-review.md)). No
model chooses them.

## 4. Publish

`civireview publish` turns `review.json` into one GitHub review:

- A finding whose lines are part of the diff becomes an inline comment; one outside the
  diff is listed in the summary instead of being dropped. At most
  `review.maxInlineComments` are posted inline, the rest move to the summary.
- A `suggestion` block is added only when the finding's lines map exactly to the diff,
  since applying it would otherwise replace the wrong lines.
- The review is posted as a comment by default (`review.reviewEvent`). If GitHub refuses
  a requested "request changes" or "approve", it is retried as a comment.
- The summary ends with a hidden marker holding base and head commit, which the next
  incremental review reads.

A reply to `@civireview <question>` inside a review thread takes a shorter path: one
model call with the thread and the saved evidence, posted into that thread. No instance
is started.
