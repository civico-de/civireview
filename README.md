<p align="center">
  <img src="assets/logo.png" alt="CiviReview logo" width="140" />
</p>

# civireview

**CiviCRM-native, multi-model AI pull request reviewer** built on deterministic **CiviKitchen Standalone A/B verification** (including automated real-browser A/B screenshots + a11y) and **civicrm-knowledge MCP**.

`civireview` separates empirical truth from LLM reasoning:

1. **Layer 1 — Deterministic Evidence (`evidence`)**: Collects PR metadata, glob-filtered unified diffs, CiviCRM surface changes (APIv4, routes, Afform, permissions, schema, upgrades), Jenkins/Duderino CI status, and live **CiviKitchen Standalone** A/B runs (`ck ab --json --surface`) comparing base (`A`) vs. head (`B`) containers — including PHPUnit proof-of-fix (mounting new extension tests into `A` as well), `ck taint` A-vs-B delta, `ck lifecycle` / `ck schema`, and automated **Standalone Browser A/B** (console, page, network, accessibility, and before/after PNG screenshots).
2. **Layer 2 — Multi-Model Adversarial Review (`review`)**: Runs a cached-prefix triage stage, parallel specialist lenses (`correctness`, `security`, `tests`, `ui` with multimodal screenshots), and a sceptical adversarial verifier in a fresh context (with optional Tier 2 Playwright MCP or `--live-prove` read-only A/B probes) to filter out false positives, duplicates, and style nits.
3. **Layer 3 — Safe GitHub Publisher (`publish`)**: Maps findings to valid diff hunk lines (demoting out-of-diff findings to the summary rather than dropping them), validates GitHub `suggestion` blocks, posts a single batched PR review (automatically using `COMMENT` on closed/merged PRs and falling back cleanly on HTTP 422), supports in-thread `@civireview` replies (`civireview reply`), and appends a CiviCRM `AGENTS.md`-compliant AI disclosure footer plus an incremental SHA marker.

---

## Launch Modes

### 1. GitHub Action (`@civireview` on Open, Closed, or Merged PRs)

Use the 4-job privilege-isolated reusable workflow in [`.github/workflows/pr-review.yml`](.github/workflows/pr-review.yml):

```yaml
name: CiviReview
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions: {}

jobs:
  civireview:
    if: >
      github.event.issue.pull_request != null ||
      github.event_name == 'pull_request_review_comment'
    uses: civico-de/civireview/.github/workflows/pr-review.yml@main
    with:
      preset: sonnet-opus
      civireview_repository: civico-de/civireview
      # Private repos only (ignored/refused on public repos):
      # runs_on: self-hosted
      # mcp_team_url: https://your-team-mcp.example.com/mcp
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CIVICRM_KNOWLEDGE_MCP_TOKEN: ${{ secrets.CIVICRM_KNOWLEDGE_MCP_TOKEN }}
```

Comment on any open, closed, or merged PR (or reply inside an inline review thread with `@civireview why?` to trigger a focused in-thread answer):

- `@civireview` — incremental review since the last `<!-- civireview:v1 ... -->` marker
- `@civireview --full` — ignore incremental marker and review the entire PR diff
- `@civireview --preset cross-model` — use mixed providers (e.g. Anthropic specialists + OpenAI verifier)
- `@civireview --effort high` — override dynamic `auto` reasoning effort in PR comments (capped to `auto`, `low`, `medium`, `high`; `xhigh`/`max` are local CLI & repo config only)
- `@civireview --include browser,ui` / `--exclude tests,matrix` — run only selected checks/lenses or skip specific ones
- `@civireview --page civicrm/admin/extensions` — probe explicit Standalone route(s) in browser A/B
- `@civireview --no-browser` / `--no-ab` / `--demo` — toggle browser A/B, CiviKitchen A/B, or `ck demo`
- `@civireview --model anthropic:claude-sonnet-5-5 --verifier openai:gpt-5.2`

### 2. Local CLI (API, Subscription, or Local GPU)

```bash
# Install dependencies
bun install

# Review a GitHub PR end-to-end (open, closed, or merged; add --dry-run to preview)
bun run bin/civireview.ts pr https://github.com/civicrm/civicrm-core/pull/12345 --dry-run

# Review using Tier 2 interactive Playwright MCP + bounded live A/B verifier probes
bun run bin/civireview.ts pr 12345 --repo civicrm/civicrm-core --interactive-browser --live-prove

# Review using your Claude Code CLI subscription (no API key needed)
bun run bin/civireview.ts pr 12345 --repo civicrm/civicrm-core --preset subscription

# Review using a local OpenAI-compatible GPU endpoint + opencode-cli
bun run bin/civireview.ts local --base master --preset local-gpu
```

### 3. Cross-Repo Mention Watcher (`civireview watch` — e.g. `civicrm/civicrm-core`)

For upstream repositories such as `civicrm/civicrm-core` where you cannot install a GitHub Action workflow directly, run `civireview watch` with an authorization policy (`--allow-orgs`, `--allow`, or `--allow-associations`) plus rate/budget guardrails:

- **All `civicrm` GitHub org members (public & private)**: `--allow-orgs civicrm` checks GitHub's server-computed `author_association` (`MEMBER` / `OWNER`) on `civicrm/*` repos in zero extra API calls — covering both public and private org members — and falls back to cached GitHub org-membership checks on other repos.
- **Inline thread replies**: replying `@civireview <question>` inside an inline PR review thread automatically routes to `civireview reply` (fast, zero-Docker follow-up answer) instead of re-running a full PR review.
- **Duplicate & cost safeguards**: pre-flight checks existing `<!-- civireview:v1 ... -->` / `<!-- civireview:reply ... -->` markers before booting Docker, skips already-reviewed `headSha`s unless `--full` is passed, ignores mentions older than `--max-age-minutes`, and defers excess requests once `--max-per-hour` or `--max-daily-usd` is reached.

```bash
# Enable @civireview for all members of the civicrm GitHub org on civicrm/civicrm-core
bun run bin/civireview.ts watch \
  --mode search \
  --repos civicrm/civicrm-core \
  --allow-orgs civicrm \
  --preset sonnet \
  --max-per-hour 10 \
  --max-daily-usd 15 \
  --max-age-minutes 1440 \
  --interval 60

# Notifications mode (with a dedicated @civireview bot account; HTTP 304 zero-cost polling)
bun run bin/civireview.ts watch \
  --mode notifications \
  --repos civicrm/civicrm-core \
  --allow-orgs civicrm \
  --max-per-hour 10 \
  --max-daily-usd 15 \
  --once
```

**Turnkey GitHub Action (`.github/workflows/watch-core.yml`)**:

This repository ships a ready-to-enable scheduled watcher workflow ([`.github/workflows/watch-core.yml`](.github/workflows/watch-core.yml)) that polls `civicrm/civicrm-core` every 5 minutes (using `--check-only` to finish idle ticks in ~10s without cloning CiviCRM or CiviKitchen). It stays **off by default** until you configure:

1. **Secrets**: `CIVIREVIEW_GITHUB_TOKEN` (classic PAT on the `@civireview` account with **`public_repo`** + **`notifications`** scopes for default `notifications` mode, or `public_repo` with `CIVIREVIEW_WATCH_MODE=search`) and `ANTHROPIC_API_KEY` (plus `OPENAI_API_KEY` if using `cross-model`).
2. **Repository Variables**:
   - `CIVIREVIEW_WATCH_ENABLED` = `true` (kill-switch to turn scheduled polling on/off)
   - Optional overrides: `CIVIREVIEW_ALLOW_ORGS` (`civicrm`), `CIVIREVIEW_ALLOW_ASSOCIATIONS` (`OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR` — covers private org members & established core contributors), `CIVIREVIEW_ALLOW_USERS`, `CIVIREVIEW_PRESET` (`sonnet-opus`), `CIVIREVIEW_EFFORT` (`auto`), `CIVIREVIEW_MAX_PER_HOUR` (`10`), `CIVIREVIEW_MAX_DAILY_USD` (`15`), `CIVIREVIEW_WATCH_MODE` (`notifications` default, or `search`), `CIVIKITCHEN_REF` (`v1`).

Processed comment IDs and rolling hourly/daily budget records are persisted in `.civireview-state/seen.json` (and cached across GitHub Actions runs).

### 4. Agent / CI Stage Subcommands

Each layer can be invoked independently for custom pipelines or agent skills:

```bash
civireview evidence --repo owner/name --pr 123 --out ./evidence
civireview review   --evidence ./evidence --out ./review.json --preset cross-model
civireview reply    --repo owner/name --pr 123 --comment-id 456 --evidence ./evidence --question "Why?"
civireview publish  --review ./review.json --evidence ./evidence
```

---

## Standalone Browser A/B & Include/Exclude Controls

- **Tier 1 (Default ON)**: Automatically discovers CiviCRM Standalone routes from live `surface-diff.json` (`routes`, `afform`, including `anonymousPages` for public Afforms), `xml/Menu/*.xml`, `*.aff.json`, diff/PR mentions, or falls back to `civicrm/dashboard?reset=1` when frontend assets change. Runs `ck ab ... --page <route> --anon-page <route> --expose`, copies before/after PNG screenshots into `<evidence>/screenshots/`, and feeds them into the `ui` specialist and Stage 2 `verifier`.
- **Tier 2 (Opt-In Local)**: `--interactive-browser` keeps A/B stacks alive (`--keep --expose`) and attaches Playwright MCP (`npx -y @playwright/mcp@latest`); `--live-prove` attaches the bounded read-only `live_probe_ab` tool (localhost HTTP GET + `cv api4 <Entity>.get|getActions|getFields`) to the Verifier so findings can be upgraded to `PROVEN` with exact live proof output.
- **Configurable Filtering (`civireview.yaml` & CLI)**:
  - `checks`: toggle `abTests`, `surface`, `staticDelta`, `lifecycle`, `browser`, `a11y`, `interactiveBrowser`, `matrix`, `liveProve`.
  - `review.include` / `review.exclude` (`--include` / `--exclude`): filter check keys and specialist lenses (`correctness`, `security`, `tests`, `ui`).
  - `review.paths.include` / `review.paths.exclude`: filter diff files with glob patterns (`*`, `**`, `?`).

See [`civireview.example.yaml`](civireview.example.yaml) for the full configuration schema.

### CiviKitchen A/B Resilience (Image Fallback, Staleness Overlay, Timeouts & Retries)

- **Pre-flight image tag check & fallback:** Before launching `ck ab`, `civireview` checks `docker image inspect` (local cache) and `docker manifest inspect` (GHCR) for the target branch's image tag. If a newly-cut release branch (e.g. `standalone-6.21`) has not been published yet, it automatically falls back (`standalone-X.Y` → `standalone-beta` → `standalone-master` → `standalone-latest` → `standalone`) instead of failing.
- **Fast git-delta staleness overlay (`civicrm-core`):** Prebuilt nightly images (`standalone-master`, `standalone-beta`) can lag upstream `master` by up to 24 hours. Before mounting PR files, `civireview` reads the local image's `.Created` timestamp (or falls back to a 36-hour window on fresh CI runners), runs `git log --since=... --name-only <baseSha>`, and bind-mounts up to 50 recently-merged base files from `worktreeA` into both A and B (skipping `DAO/` and PR-modified paths). This bridges nightly image lag in `< 0.1s` with zero Docker rebuilds; rare Composer/schema-only mismatches still degrade gracefully to `NOT_VERIFIED` and defer to Jenkins CI.
- **Per-target timeouts, transient retry & diagnostic tail:** Multi-target container runs wrap each test file in a `120s` `timeout` so a table-lock hang on unfixed Base A exits `124` cleanly instead of killing the outer `ck ab` run at `600s`. Transient non-timeout runner errors retry once (deterministic missing-image and mount errors are never retried), and failures log exit code, duration, timeout flag, and the last 10 non-progress lines of container output.

---

## Model Mixing & Presets

Every stage accepts `<provider>:<modelId>` (`anthropic`, `openai`, `google`, `openrouter`, `openai-compat`, `claude-cli`, `codex-cli`, `opencode-cli`).

| Preset | Triage | Specialists | Verifier |
| --- | --- | --- | --- |
| `sonnet` | `anthropic:claude-sonnet-5-5` | `anthropic:claude-sonnet-5-5` | `anthropic:claude-sonnet-5-5` |
| `sonnet-opus` | `anthropic:claude-sonnet-5-5` | `anthropic:claude-sonnet-5-5` | `anthropic:claude-opus-5-5` |
| `cross-model` | `anthropic:claude-haiku-5-5` | `anthropic:claude-sonnet-5-5` | `openai:gpt-5.2` |
| `subscription` | `claude-cli:haiku` | `claude-cli:sonnet` | `claude-cli:opus` |
| `local-gpu` | `openai-compat:local` | `opencode-cli:local` | `opencode-cli:local` |

### Review Depth, Dynamic Effort (`effort: auto`) & Confidence Gate

- **Depth profiles (`--depth fast|balanced|deep`, default `deep`):**
  - `deep`: `maxSteps: 35`, `triageMaxSteps: 10`, `maxOutputTokens: 16384`, `stageTimeoutMs: 360s`, `maxFollowUpRounds: 2`, with Triage, all active Specialists (`correctness`, `security`, `tests`, `ui`), and Verifier running at `effort: high`. Stage 2 Verifier **always runs** in `deep` mode (even when Stage 1 reports 0 candidates) to audit the PR, emit targeted `followUpLeads`, and produce `reconciledWalkthrough` bullets.
  - `balanced`: `maxSteps: 18`, `triageMaxSteps: 6`, `maxOutputTokens: 12288`, `stageTimeoutMs: 240s`, `maxFollowUpRounds: 1` (`triage: low`, `specialists: medium`, `verifier: medium/high`).
  - `fast`: `maxSteps: 12`, `triageMaxSteps: 4`, `maxOutputTokens: 8192`, `stageTimeoutMs: 180s`, `maxFollowUpRounds: 0`.
- **Confidence gate & collapsed `Lower-Confidence Notes`:**
  - Non-`REJECTED` findings with `confidence >= 80` (configurable via `review.confidenceThreshold`) are posted as inline/summary findings and drive the verdict and 1–5 merge confidence score.
  - Non-`REJECTED` findings scoring **50%–79%** are preserved in a collapsed-by-default `<details>` section (`Lower-Confidence Notes`) so reviewers can optionally inspect borderline observations without adding inline noise.
  - Disproved `REJECTED` findings are dropped completely.
- **External 1-minute watcher trigger:** For instant mention pickup without burning GitHub Actions cron minutes while idle, see [`scripts/external-cron-trigger.sh`](scripts/external-cron-trigger.sh).

Override effort globally with `--effort <low|medium|high|xhigh|max>` or per stage via `review.stageEffort` in `civireview.yaml`.

---

## Security Model & Private/Public Isolation

1. **4-Job Privilege Isolation** (`.github/workflows/pr-review.yml`):
   - `authorize` (`issues: write`, `pull-requests: read`): verifies collaborator write access or `allowed_users`, parses `@civireview` flags via `env:` (zero shell interpolation), pins immutable `base_sha` & `head_sha`, and refuses self-hosted runners on public repos.
   - `evidence` (`contents: read` only): checks out pinned `head_sha` with **zero LLM secrets** and **zero write tokens**; refuses self-hosted runners on public repos.
   - `review` (`contents: read` only): runs with **zero PR code execution** and **zero write tokens**; holds LLM API keys and scoped MCP URL/token.
   - `publish` (`pull-requests: write`, `issues: write`): validates `review.json` / `reply.json` and posts to GitHub with **zero LLM secrets** and **zero PR execution**.
2. **MCP Scope Isolation** (`src/mcp/scope.ts`):
   - Public repositories (`isPrivateRepo === false`) ALWAYS connect only to `mcp.publicUrl` (`https://mcp.civico.de/mcp`) and **never** receive `teamUrl`, `CIVICRM_MCP_URL`, or `CIVICRM_MCP_TOKEN` / `CIVICRM_KNOWLEDGE_MCP_TOKEN`.
3. **Anti-Injection & Safe Repo Tools**:
   - Untrusted PR titles, bodies, comments, linked issues, and diffs are wrapped in `<untrusted_pr_data>` tags with closing-tag escaping.
   - Repo read/grep tools enforce strict workspace containment and reject path traversal and symlink escapes.
4. **Watcher Authorization & Budget Guardrails**:
   - `civireview watch` refuses to run without an explicit authorization policy (`--allow`, `--allow-orgs`, or `--allow-associations`), blocks `[bot]` accounts from wildcard policies, ignores comments containing `<!-- civireview:`, and enforces optional `--max-per-hour`, `--max-daily-usd`, and `--max-age-minutes` caps.

---

## Development

```bash
bun install
bun run typecheck
bun test
bun run bin/civireview.ts --help
```

## License

AGPL-3.0-or-later — see [`LICENSE.md`](LICENSE.md).
