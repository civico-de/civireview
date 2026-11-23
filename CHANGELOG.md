# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
