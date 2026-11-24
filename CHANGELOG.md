# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Eval**: `bun run eval` checks the live instances on two real kept stacks; `--with-model` also replays a reminder PR and checks that a stage reproduced it live.
- **Telemetry**: each stage records its tool calls with shortened inputs and results in `review.json`, and the `[stage]` log line counts them per tool.

### Changed
- **Presets**: `subscription` runs the models of `sonnet-opus` (Sonnet triage and specialists, Opus verifier) through the `claude` CLI.
- **claude CLI runner**: models get the live tool and the interactive browser from local MCP servers, started from civireview's directory so a `bunfig.toml`, `.env` or `.npmrc` in the PR is never read; the run fails when the live tool's server does not start. MCP tools are loaded with their schema up front (no deferred tool search), as on the API path. Each stage records its turns and tool calls, and a failed run reports the CLI's error.

### Fixed
- **Live instances**: the tool description named a job that does not exist (`Job.process_action_schedule`); it now names `Job.send_reminder`.

## [0.5.0] - 2026-11-24

### Changed
- **Live instances**: `live-prove` is on by default. The specialists, follow-up rounds and verifier can run any command in the kept A/B containers, including `cv api4` writes and scheduled jobs, to reproduce a scenario on both sides; the verifier tries open *Not verified* points there before keeping them. The split `evidence` job switches it off.

### Removed
- **Config**: `ab.liveProve`; `checks.liveProve` is the only switch. A config that still sets `ab.liveProve` is refused.

## [0.4.1] - 2026-11-24

### Added
- **CLI**: `--bot-login` sets `botLogin` without a config file; the watch workflow passes the repository variable `CIVIREVIEW_BOT_LOGIN`, since the watched repository carries no `civireview.yaml`.

## [0.4.0] - 2026-11-24

### Added
- **Profiles**: a review states where its change could be verified: `core`, `core-extension` (a core PR inside a bundled extension, `ext/<name>`), `extension` or `generic`. The profile is in the review header and in the model context.
- **Bundled core extensions**: a core PR that touches `ext/<name>` gets the extension gates (taint delta, lifecycle, upgrade parity) for that extension, and the extension is enabled before the browser probe.
- **Upgrade parity**: when schema or upgrader files change, the base version of the extension is installed, switched to the head and upgraded; its schema is compared with a fresh install of the head. A difference is a warning with the schema diff.
- **Browser routes**: when UI files of an extension change, the routes it defines in `xml/Menu/*.xml` and `ang/*.aff.json` / `ang/*.aff.php` are probed.
- **Documentation**: `docs/` with how a review is produced, the profiles, how to read a review, running, configuration and the security model.
- **Review**: findings the verifier rejects or rates below 50% are listed in a collapsed "Rejected or below 50% confidence" section with the verifier's verdict and reason.
- **Logs**: every verifier verdict is logged as a `[finding]` line with its reason; retries and ignored unknown ids are logged as warnings.
- **Config**: `botLogin` names the login the reviews are posted as; only its comments then count as the marker of an earlier review. Without it a marker in any comment is accepted, so a commenter could make a mention skip or move the start of an incremental review.
- **Watcher**: `watch --out <dir>` saves each finished review of a public repository as `review.json`, and the watch workflow uploads them as an artifact kept for 90 days, so rejected candidates can be read later without running the review again.

### Changed
- **Config**: `browser.viewport` is removed; it was never passed to the browser probe. A config that still sets it is rejected.
- **Browser A/B**: a clean probe that loaded only the dashboard, because no route of the changed UI was found, is `NOT_VERIFIED` with a hint to pass `--page`, no longer `PASS`.
- **Merge confidence**: the rationale says when the deciding finding was read in the code and not reproduced in a run.
- **Not verified**: the notes about `xml/schema` and `CRM/Upgrade/*` are left out for a bundled extension that gets the extension gates.
- **Verifier**: confidence is the probability that a finding is true, independent of its severity; a defect is described once.

### Fixed
- **Verification matrix**: Live Surface Diff is `NOT_VERIFIED` when no live capture exists; it passed on the diff alone. A browser report that compared no route is `NOT_VERIFIED`.
- **Verdicts**: `PROVEN` is lowered to `CONFIRMED` when no run produced a result and the finding carries no live proof.
- **Upgrade parity**: a run counts only when the script reports the comparison itself; exit code 0 alone is not enough. An extension the PR adds is named as skipped.
- **Extension gates**: a detected extension without a usable `info.xml` in the head, or without mountable head files, is named under *Not verified*.
- **Taint delta**: an issue that turns from `INFO` into `ERROR` is new, the other direction is not; paths with spaces and issues written to stderr are read.
- **Browser A/B**: a run that leaves no report cannot show that the extension was enabled and is reported as failed setup. Public forms of an extension are probed anonymously too.
- **Proof of fix**: changed test files beyond the first five are named under *Not verified*.
- **Verification matrix**: an extension's version matrix is its own row, `Version Matrix`; it was reported as Base-Test Regression. Exit codes of a proof run that errored no longer count as proof. A tautological test stays an issue in the standards table of a review that is otherwise ready.
- **Triage**: a skip reason is honoured for a docs-only PR only; on a code PR the specialists run. A review whose lenses are all disabled says under *Not verified* that the code was not reviewed.
- **Findings**: two findings of the same specialist on overlapping lines are both kept; they were merged as duplicates.
- **Watcher**: thread replies count against `maxDailyUsd`. In `notifications` mode a failed mention with attempts left is fetched again; the cursor used to move past it.
- **GitHub limits**: a review with several oversized sections and a long thread reply are cut to fit.
- **Workflows**: unchecking `ab_enabled` on a manual watcher run disables A/B; an inline comment with review flags starts a review in the reusable workflow, as it does in the watcher.
- **Watcher**: a review that fails midway counts the cost of its finished stages against `maxDailyUsd`.
- **Merge confidence**: capped at 4 whenever neither proof of fix nor base-test regression ran a test; a skipped or missing row escaped the cap.
- **A/B results**: a report that lists no test is no result. A run where only the PR side wrote results is not a proof of fix; it was reported as passed.
- **Proof of fix**: a test file with a new and a changed existing test runs both; a change in a helper runs the whole file.
- **Taint delta**: an unchanged blocking issue that moved is not paired with an advisory one of the base.
- **Triage**: a docs-only skip also requires that every changed file is documentation.
- **Findings**: a finding repeated by the same specialist under the same title is one finding.
- **Demo**: script errors of the recording are read; the row passed without looking. Errors the base recording shows too do not count.
- **Budget**: `review.maxBudgetUsd` together with a `codex-cli` or `opencode-cli` model is rejected, since those runs report no usage and were silently uncapped.
- **Live probe**: two responses differ when their bodies differ anywhere, not only in the first 1500 characters.
- **A/B clean-up**: worktrees and the work directory are removed when the run fails midway or only one worktree could be created.
- **CI status**: up to 100 commit statuses are read; the default page held 30.
- **Verifier**: a candidate is rejected as disproved only on a fact read or run in the review; recalled knowledge about unreadable code yields a question.
- **Example config**: `civireview.example.yaml` loads as it is; the empty `models:` block was rejected.
- **Extension gates**: taint and lifecycle run from the extension's directory. Started from the web root, lifecycle stopped at its precondition and was reported as a failed lifecycle, and taint scanned the whole instance until it timed out. A gate that does not reach its check is now listed as not verified and never becomes a finding.
- **Taint delta**: only issue lines of the analysis are read. Timing and type-coverage lines, which differ between any two runs, and the trace lines of an issue were reported as new findings; an existing issue moved to another line was reported as new. A run that fails without an issue is listed as not verified.
- **Extension gates**: each gate runs in an instance of its own name, and an instance left behind by a gate that timed out is removed. Before, one timeout made every later gate refuse to start. A failed analysis on the base, more bundled extensions than the gates cover, an extension that cannot be enabled for the browser probe and a PR mounted as whole directories are reported under *Not verified*.
- **Schema gate**: the former call of a non-existent `ck schema` command, whose usage error was reported as a schema failure, is replaced by upgrade parity.
- **Surface diff**: a diff that touches `setCheckPermissions(...)` is flagged as a permission-check change; the marker only matched the lower-case array key before.
- **Budget**: `review.maxBudgetUsd` is enforced. The review stops before the next specialist or verifier call once its estimated cost reaches the cap; before, the key was accepted and ignored.
- **Verifier coverage**: every candidate finding gets a verdict. The verifier is asked again, up to 3 times, for candidates it returned no verdict for; a verdict for an unknown id does not count. If one is still missing, the review fails instead of dropping the candidate silently.

## [0.3.3] - 2026-11-23

### Fixed
- **Watcher**: a mention whose processing fails (e.g. publishing returns 403 after the models ran) counts against `maxReviewsPerHour`/`maxDailyUsd`, no longer aborts the pass, and is given up after 3 attempts. `watch --once` exits non-zero when a mention failed.
- **Watcher state**: `seen.json` is written atomically, and an unreadable file is an error instead of an empty state that re-processes every old mention.
- **`@civireview` parser**: apostrophes in the question (`doesn't`) no longer swallow the flags that follow.
- **Suggestions**: no `suggestion` block when the finding's lines were snapped, shortened or collapsed, since applying it would replace the wrong lines.
- **Evidence**: all PR comments, review comments and reviews are fetched (previously only the first 100, dropping the newest). The "already reviewed" marker is only read from the last line of a comment, so a quote-reply or marker text in prose no longer suppresses a review, and Windows line endings are accepted.
- **Dirty checkout**: when the checked-out HEAD equals the PR head but has uncommitted changes to tracked files, the review reads a clean detached worktree instead of those edits.
- **Model CLIs**: `claude`, `codex` and `opencode` runs are killed after `review.stageTimeoutMs` instead of hanging the pass; `OPENCODE_BIN` overrides the binary like `CLAUDE_BIN`/`CODEX_BIN`.
- **MCP**: an unreachable `civicrm-knowledge` or stdio MCP server logs a warning before the stage continues without its tools.
- **API runner**: a model answer wrapped in prose or a code fence is recovered instead of failing the stage, and unparseable answers report stage, model and finish reason.
- **Merge confidence**: the rationale names the strictest cap first, so a red CI is no longer hidden behind weaker findings when it decides the score.
- **Image selection**: an unquoted `policy.civicrm: 6.10` in `civikitchen.yaml` is read as `6.10`, not `6.1`.
- **CI**: inline thread replies run in their own concurrency group per comment, so a reply no longer cancels a running full review of the same PR, nor another reply.
- **Inline cap**: findings beyond `maxInlineComments` are moved to the summary instead of being dropped.
- **Repo tools**: `read_file` can no longer read `.git/` (remote URLs may carry credentials); `grep_repo` reports an invalid pattern instead of an empty result.
- **Publishing**: a refused `REQUEST_CHANGES`/`APPROVE` is retried as `COMMENT` before inline comments are folded into the summary; review and comment bodies are kept below GitHub's size limit; proof output with backticks no longer breaks the markdown.
- **Triage**: no active lens without a skip reason is an error, and a PR whose selected lenses are all disabled by config says so instead of reporting a plain READY.

## [0.3.2] - 2026-11-23

### Changed
- **`review.mentionUsers` option (default `false`) — never ping PR commenters by default**: Reviewer usernames in `Reviewer Thread`, `Action Items`, `Reviewer Questions & Thread Resolution`, and any LLM prose (`summaryBody` and `inlineComments`) now render in backticks (`` `username` ``) by default via `sanitizeGitHubMentions` (while preserving `@param`/`@return`/`@todo` code annotations) so posted reviews never send unsolicited GitHub mention notifications unless `review.mentionUsers: true` is explicitly configured.

## [0.3.1] - 2026-11-23

### Fixed
- **Deduplicated `Action Items` between inline findings and `[OPEN REVIEWER FEEDBACK]`**: When an open `threadResolutions` entry refers to the same file already covered by a surviving `CONFIRMED`/`PROVEN` finding in `Action Items`, the redundant `[OPEN REVIEWER FEEDBACK]` checklist item is omitted (while preserving the full entry in the `Reviewer Questions & Thread Resolution` table).

## [0.3.0] - 2026-11-23

### Added
- **First-class `Reviewer Thread` check & `threadResolutions` tracking**: Stage 2 Verifier now audits every substantive question or change request raised by human reviewers in `pr_comments` (`addressed`, `answered`, or `open`):
  - Adds a **`Reviewer Thread`** row to the `Empirical Verification Matrix` (`✅ PASS | All N reviewer question/request(s) addressed or answered.` or `⚠️ WARN | M open question/request(s) (@reviewer) · K addressed/answered`).
  - Emits a top-level **`[OPEN REVIEWER FEEDBACK]`** Action Item for each unaddressed human reviewer question/request.
  - Deterministically upgrades the verdict from `READY` to **`QUESTIONS_ONLY`** and caps merge confidence at **`4/5`** whenever any human reviewer question/request is still open.
  - Renders a `<details><summary>Reviewer Questions & Thread Resolution (...)</summary>` breakdown table in Zone 2.

## [0.2.9] - 2026-11-23

### Changed
- **Consistent 2-zone review layout**:
  - **Zone 1 (Top — always visible, actionable)**: Header + alpha notice + Summary + Merge Confidence, `Action Items` (with 220-char word-boundary hints), full `Findings (Out-of-Diff / Summary)` rendered right below Action Items (no longer buried at the bottom below reference tables), `Empirical Verification Matrix`, and `Related Open PRs & Issues`.
  - **Zone 2 (Bottom — all reference details consistently in collapsed `<details>` blocks)**: `Detailed Walkthrough (N notes)`, `CiviCRM Core Standards (N checks — M ISSUE | all PASS/N/A)`, `Ecosystem Blast Radius (N items)`, `Standalone Browser A/B (N route(s), 0 regressions)`, and `Lower-Confidence Notes`.
- **Unaddressed human reviewer requests preserved as active findings**: Updated `EVIDENCE_DISCIPLINE_RULES` and the Stage 2 Verifier prompt so concrete code/design change requests from human reviewers in `pr_comments` that are still unaddressed in `headSha` (even when the author replied *"I will look into it"*) are preserved as `CONFIRMED` (`confidence >= threshold`) rather than rejected as "already acknowledged".
- **Stage 2 `reconciledBlastRadius`**: Stage 2 Verifier now reconciles Stage 1 `blastRadius` rows so disproved Stage 1 claims cannot leak into `Ecosystem Blast Radius`.
- **Suppressed duplicate `No added/modified PHPUnit tests` note on E2E-only PRs**: When `skippedE2eTests.length > 0`, `notVerified` no longer appends a redundant `No added/modified PHPUnit tests in PR` bullet.

## [0.2.8] - 2026-11-23

### Fixed
- **`git merge-tree` conflict filtering against older PRs**: Removed forced `--merge-base=<baseSha>` and filtered `git merge-tree` conflicts to `overlappingFiles` (files modified by *both* PRs) so base-branch history drift against an older open PR no longer triggers false merge conflicts in files the other PR never touched.
- **`Base-Test Regression` summary when pre-existing failures occur on both A and B**: Reported `${passedBoth.length} test(s) passed on A and B (${bothFail.length} pre-existing failure(s) on both)` instead of falling back to `ck ab (junit) exited with 0`.

## [0.2.7] - 2026-11-23

### Changed
- **Upfront AI-assisted alpha disclosure & feedback link**: Added a clear alpha notice right below the review title explaining that `civireview` is an experimental AI-assisted tool under active development, with a direct link to open an issue for feedback or false positives, plus an alpha feedback link in the footer.
- **Documentation**: Documented the 1–5 Merge Confidence Scale in `README.md`.

## [0.2.6] - 2026-11-23

### Added
- **Deterministic `git merge-tree` conflict check for related open PRs**: When overlapping open PRs share the same `baseBranch`, `collectRelatedOpenPrs` now fetches their head refs and runs read-only `git merge-tree --write-tree --merge-base=<baseSha> <headSha> <otherRef>` to distinguish real textual merge conflicts (`CONFLICTS` + exact conflicting filenames) from same-file PRs that merge cleanly (`CLEAN`, automatically downgraded from `conflicts` to `related` so no bogus `[CONFLICTS]` Action Item is emitted).

### Fixed
- **Exact filtered-findings count & word-boundary Action Item truncation**: Subtracted `uncertainFindings.length` (already shown in the collapsed `Lower-Confidence Notes` `<details>` block) from the `_Note: N ... filtered out_` footer count, and updated `truncateOneLine` to break on word boundaries instead of cutting mid-word.

## [0.2.5] - 2026-11-23

### Added
- **Fast git-delta staleness overlay for `civicrm-core` A/B runs**: Before running `ck ab` on `civicrm-core`, `civireview` now inspects the Docker image's `.Created` timestamp (or uses a 36-hour fallback window on fresh CI runners), queries `git log --since=... --name-only <baseSha>`, and bind-mounts up to 50 recently-merged base files from `worktreeA` into both A and B (skipping `DAO/` and PR-modified paths). PRs depending on classes/methods merged after the last nightly image build now run cleanly without waiting for a full Docker image rebuild.

## [0.2.4] - 2026-11-23

### Fixed
- **Pre-flight CiviKitchen Docker image tag resolution & fallback**: Before launching `ck ab`, `civireview` now probes `docker image inspect` / `docker manifest inspect` for the preferred tag and falls back cleanly (`standalone-X.Y` → `standalone-beta` → `standalone-master` → `standalone-latest` → `standalone`) when a newly-cut release branch (e.g. `6.21`) does not yet have a published GHCR image. Deterministic missing-image errors (`failed to resolve reference`, `manifest unknown`, `: not found`, `No such image`) are no longer retried.
- **Verifier–Gate confidence alignment & verdict telemetry**: Passed `confidenceThreshold` into the Verifier prompt, aligned `CONFIRMED` calibration to `${threshold}-95` so verified defects are not silently dropped at 75–79 while cited as `CONFIRMED:` in `reconciledWalkthrough`, added `[stage] verifier verdicts:` breakdown logging in `pipeline.ts`, and displayed the filtered-candidates note in `formatter.ts` even when 0 findings survive.
- **External cron `pipefail` + `grep -q` guard (`scripts/external-cron-trigger.sh`)**: Replaced `curl ... | grep -qE` under `set -euo pipefail` (which caused `SIGPIPE` on `curl` and dispatched duplicate cancelled runs on bash 4.2) with file-backed Python JSON inspection of active workflow runs.
- **Collapsed `Lower-Confidence Notes` `<details>` section**: Non-`REJECTED` findings scoring 50%–79% (below the 80% inline posting gate) are now preserved in a collapsed-by-default `<details>` block so reviewers can optionally inspect borderline observations without adding inline noise or affecting the verdict/score (`REJECTED` false positives remain fully hidden).
- **Deduplicated `Ecosystem Blast Radius` rows**: Merged blast-radius entries per normalized `(repo, path)`, keeping the richest impact description.

## [0.2.3] - 2026-11-23

### Added
- **Mandatory Stage 2 Verifier audit & walkthrough reconciliation in `deep` mode**: Even when Stage 1 specialists report 0 candidate findings, `deep` mode now runs Stage 2 (Opus Verifier) to perform an independent adversarial audit, emit `followUpLeads` if Stage 1 missed a concrete defect, and return `reconciledWalkthrough` bullets resolving early Stage 0 `NEEDS_QUESTION` guesses against verified code.
- **Step and tool-call count telemetry (`steps=X/Y tools=Z`)**: `[stage]` telemetry logs and `tokenUsage.byStage` now record exact AI SDK step count and tool-call count per stage.
- **External 1-minute cron poller script (`scripts/external-cron-trigger.sh`)**: Lightweight external cron trigger that polls `@civireview` notifications or public PR comments every minute with zero idle GitHub Actions runs.

### Changed
- **Expanded `deep` mode stage budgets and efforts**:
  - `deep`: `maxSteps: 35`, `triageMaxSteps: 10`, `maxOutputTokens: 16,384`, `stageTimeoutMs: 360s`, with Triage, **all** active Specialists (`correctness`, `security`, `tests`, `ui`), and Verifier running at `effort: high`.
  - `balanced`: `maxSteps: 18`, `triageMaxSteps: 6`, `maxOutputTokens: 12,288`, `stageTimeoutMs: 240s`.
  - `fast`: `maxSteps: 12`, `triageMaxSteps: 4`, `maxOutputTokens: 8,192`, `stageTimeoutMs: 180s`.
- **Hardened `ck ab` multi-target execution, retry, and diagnostic tail logging**:
  - Wrapped multi-target container test runs with a 120s per-target `timeout` so a table-lock hang on unfixed Base A fails cleanly in 120s instead of killing the outer `ck ab` runner at 600s (`exit 143`).
  - Added automatic 1-time retry on transient non-timeout `ck ab` runner failures and replaced first-line Docker Compose progress logging (`Network ... Creating`) with a stripped 10-line diagnostic tail + duration and timeout flag.

## [0.2.2] - 2026-11-23

### Added
- **Single-switch review depth profile (`--depth fast|balanced|deep`, `review.depth`, `vars.CIVIREVIEW_DEPTH`, default `deep`)**:
  - `deep` (new default): `maxSteps: 25`, `maxFollowUpRounds: 2`, `stageTimeoutMs: 300s`, Triage `medium`, `correctness`/`security` specialists `high`, Verifier `high`.
  - `balanced`: `maxSteps: 15`, `maxFollowUpRounds: 1`, `stageTimeoutMs: 240s`, Triage `low`, specialists `medium`, Verifier scales `medium` → `high`.
  - `fast`: `maxSteps: 12`, `maxFollowUpRounds: 0`, `stageTimeoutMs: 180s`, Triage `low`, specialists `low`, Verifier `medium`.

## [0.2.1] - 2026-11-23

### Fixed
- **Ignored same-author multi-branch backport PRs in Related PR discovery**: Open PRs targeting a different base branch (e.g. `6.20` vs `6.21` vs `master` release-branch backports by the same author) are no longer flagged as `duplicate` or `conflicts` or turned into bogus `[DUPLICATE]` Action Items.
- **Fixed both-non-zero `exit-status` A/B runs (`A=2, B=2`)**: Marked non-zero exit-status runs on both sides as `ERROR` → `NOT_VERIFIED` instead of `PASS`, and removed internal `ck ab mount` wording from `Not Verified` notes.

## [0.2.0] - 2026-11-23

### Added
- **Wait-for-CI gate (`--wait-for-ci` / `watch.waitForCi`, enabled by default in `watch-core.yml`)**: Zero-Docker pre-flight check defers full PR reviews while Jenkins/CI commit statuses on the head SHA are still `pending` (up to `--wait-for-ci-max-minutes`, default `90`, bypassed by `--full`), preserving notification cursors so the next poll reviews the PR once CI finishes.
- **Native Duderino → Jenkins `/testReport/api/json` + `CiviCRM-Style` CI evidence & flaky-CI assessment**: Parses failing jobs from `test.civicrm.org/duderino/batch/.../tasks?filter=failed`, reads public `CiviCRM-Style` bad-style files, fetches exact failed test names + stack traces when `CIVICRM_JENKINS_USER` + `CIVICRM_JENKINS_TOKEN` are configured (wired in `watch-core.yml`), and lets Stage 0 Triage distinguish PR-related CI failures from unrelated flaky CI runs.
- **Interactive Action Items (`- [ ] ...`) checklist in PR reviews**: Replaces static bullet lists with checkable GitHub task items for verified findings (with concise fix hints), failing empirical checks, and conflicting/duplicate open PRs (omitted on clean PRs).
- **Related Open PRs & Possible GitLab Issues discovery (fixes #1)**: Deterministically pre-filters open PRs (by overlapping files, shared issue refs, and component/title keywords) and searches open `lab.civicrm.org` `dev/*` issues in parallel with Layer 1 A/B runs; Stage 0 Triage classifies grounded candidates as `duplicate`, `conflicts`, or `related` with calibrated confidence (`>= 60%`) and renders a compact `### Related Open PRs & Issues` table when matches are found.
- **Bounded Verifier follow-up loop (`review.maxFollowUpRounds`, `0`–`2`, default `1`)**: The Stage 2 Verifier can now emit up to 2 targeted `followUpLeads` when it uncovers an uninvestigated adjacent defect, broken caller/hook contract, or edge case; each lead runs a focused follow-up specialist against the warm shared KV cache and is verified by a follow-up Verifier pass.
- **Per-stage and total telemetry logging**: Logs `[stage]` and `[telemetry]` lines with model, reasoning effort, duration, uncached input, `cache_write`, `cache_read` (with hit %), output tokens, and estimated USD cost for every pipeline stage.
- **Code quality tooling (`oxlint` + `oxfmt`)**: Added `.oxlintrc.json` (enforcing `max-lines: 1000` across all `bin/`, `src/`, and `test/` files), `.oxfmtrc.json`, `lint` / `format` / `format:check` scripts, and CI gates in `.github/workflows/ci.yml`.
- **Dynamic per-stage reasoning effort (`auto`, `low`, `medium`, `high`, `xhigh`, `max`)**: Automatically scales effort by stage and PR risk (Triage `low`, Specialists `medium`, Verifier `medium`/`high`), with PR comment `--effort` capped at `high` and `--lock-models` to prevent model overrides from comments.
- **Claude 5.5 presets and pricing**: Added `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-fable-5-2` pricing and defaulted `watch-core.yml` to `sonnet-opus`.
- **CiviReview branding**: Added `assets/logo.png` and updated `README.md`.

### Changed
- **Switched Stage 0 Triage to `claude-sonnet-5-5` in `sonnet` and `sonnet-opus` presets**: Warms the Sonnet KV cache before Stage 1 specialists start, improves TL;DR summaries and related PR/issue classification, and avoids `security-sensitive` over-classification.
- **Improved prompt caching across Stage 1 specialists**: Placed `sharedPrefix` ahead of lens-specific `systemPrompt` in Anthropic `instructions` and switched Stage 1 specialists to sequential execution so specialist #1 writes the KV cache once and specialists #2..N reuse it via warm `cache_read` hits.
- **Enabled top-level Anthropic automatic prompt caching**: Added top-level `providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` so multi-turn tool-call loops reuse cached history on every step.
- **Cleaner `civicrm-core` review formatting**: Replaced verbose `CiviKitchen A/B Proof-of-Fix` / `standalone-master vs standalone-master` jargon with plain `A/B Proof-of-Fix` and `failed on base, passed on PR`, deduplicated `Summary` vs. `Merge Confidence`, and compacted the footer to a single line.
- **Modularized codebase under 1,000 LOC per file**: Split `civikitchen-ab.ts`, `pipeline.ts`, `watcher.ts`, `pipeline.test.ts`, and `watcher.test.ts` into cohesive modules under `src/evidence/ab/`, `src/engine/`, `src/github/`, and `test/`.
- **Tuned review prompts**: Tightened `prKind: security-sensitive` in triage and added DDL/schema atomicity, hook/JS data-shape contract checks, and unresolved maintainer comment checks to the correctness specialist.

### Fixed
- **Eliminated remaining internal A/B test runner errors (`exit 2`)**: Handled `AbCommand` `only B wrote JUnit` (new class/method proof-of-fix) as `PASS`, `holds no test case` / `same mounts` as `SKIPPED`, bounded broad directory regression targets to up to 3 headless `*Test.php` files, mapped `Base-Test Regression` runner `ERROR`s to `NOT_VERIFIED` instead of `WARN`, and logged exact `ck ab` stderr lines on runner errors.
- **Fixed `ck ab` exit 2 on test-only `civicrm-core` PRs and replaced opaque error text**: Test-only PRs (0 production files changed, e.g. `#38219`) now mount base A's test with `--mount-a` and PR B's test with `--mount-b` instead of identical `--mount` arguments (which triggered `same mounts; nothing to compare`), and any internal A/B runner error is reported in plain English as `Internal A/B test runner error — not a PR failure`.
- **Prevented false `NEEDS_CHANGES` on `ck ab` runner errors and NFC/refactor PRs**: Marks `proof-of-fix` runner `ERROR`s as `NOT_VERIFIED` instead of `FAIL`, upgrades passed-both `A/B Proof-of-Fix` checks to `PASS` on `core-ref-nfc` PRs, and clarifies that `ext/*` inside `civicrm/civicrm-core` is not a standalone `extension-pr`.
- **Never report `READY` when empirical checks fail**: `computeFinalVerdict` now upgrades `READY` to `NEEDS_CHANGES` whenever `CI / Jenkins`, `A/B Proof-of-Fix`, `Base-Test Regression`, `Browser A/B (Standalone)`, or `Static / Taint Delta` fails.
- **Eliminated false `Base-Test Regression` failures on PR-modified tests**: `deriveRegressionTargets` excludes test files modified in the PR diff and runs unmodified sibling tests instead.
- **Excluded `tests/phpunit/E2E/` Mink tests from headless PHPUnit proof-of-fix**: Prevents Selenium-dependent E2E tests from failing on both base and PR in headless PHPUnit runs.
- **Prevented dropped mentions when notifications were viewed in browser**: Notification polling now queries `all: true` with a `since` window and relies on review markers + seen-state for deduplication.
- **Prevented `NoOutputGeneratedError` on max-step tool loops**: Forces `toolChoice: 'none'` on the final AI SDK step so structured output is always emitted.
- **Authorized private `civicrm` org members and core contributors**: Added `--allow-associations OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR` to `watch-core.yml`.

### Removed
- **Removed `AGENTS.md` disclosure boilerplate and extension-only clutter on `civicrm-core` PRs**: Omitted `Demo | SKIPPED`, unexecuted `Static / Taint Delta`, skipped `Browser A/B` / `Base-Test Regression` rows, redundant `Images:` metadata, and verbose per-stage model lists from posted core PR reviews.

## [0.1.0] - 2026-11-22

### Added
- Initial release of `civireview`: CiviCRM-native multi-model AI pull request reviewer with Layer 1 CiviKitchen A/B Proof-of-Fix, live surface diffing, Standalone Browser A/B screenshots & a11y checks, `civicrm-knowledge` MCP integration, GitHub Actions watcher (`watch-core.yml`), and inline thread replies.

[Unreleased]: https://github.com/civico-de/civireview/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/civico-de/civireview/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/civico-de/civireview/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/civico-de/civireview/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/civico-de/civireview/releases/tag/v0.1.0
