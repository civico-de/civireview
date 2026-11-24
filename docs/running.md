# Running civireview

Three ways to start a review, plus the stage subcommands for custom pipelines.

## GitHub workflow

For a repository you control, call the reusable workflow
[`.github/workflows/pr-review.yml`](../.github/workflows/pr-review.yml):

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
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The workflow runs four jobs with separate permissions (authorize, evidence, review,
publish); [security.md](security.md) explains the split. Who may trigger a review:
users with write access to the repository, plus `allowed_users` and members of
`allowed_orgs`. The workflow file documents all inputs.

A private repository may add `runs_on` (a self-hosted runner label) and `mcp_team_url`
with the secret `CIVICRM_KNOWLEDGE_MCP_TOKEN`; both are ignored for public
repositories.

## Comment flags

A comment on a PR that starts a review may carry flags. Open, closed and merged PRs
all work.

| Comment | Effect |
| --- | --- |
| `@civireview` | review the changes since the last civireview review of this PR |
| `@civireview --full` | review the whole PR |
| `@civireview --page civicrm/admin/extensions` | probe this route in the browser A/B; repeatable |
| `@civireview --include browser,ui` | run only these checks and lenses |
| `@civireview --exclude tests,lifecycle` | skip these checks and lenses |
| `@civireview --no-browser`, `--no-ab` | skip the browser A/B, or all instance checks |
| `@civireview --demo` | also record a demo run |
| `@civireview --preset cross-model` | use another model preset |
| `@civireview --model <provider:model>`, `--verifier <provider:model>` | override the specialist or verifier model |
| `@civireview --effort high` | fix the reasoning effort; from a comment only `auto`, `low`, `medium`, `high` are accepted |

Check keys and lens names are listed in [configuration.md](configuration.md).

Inside the thread of an inline review comment, `@civireview <question>` produces an
answer in that thread instead of a new review.

## Local CLI

```bash
# Whole pipeline; --dry-run prints the review instead of posting it
bun run bin/civireview.ts pr 12345 --repo civicrm/civicrm-core --dry-run

# Models through a local CLI subscription instead of an API key
bun run bin/civireview.ts pr 12345 --repo civicrm/civicrm-core --preset subscription

# Keep the A/B instances up for the models: interactive browser, read-only probes
bun run bin/civireview.ts pr 12345 --repo civicrm/civicrm-core --interactive-browser --live-prove

# Review a local branch against its base without GitHub
bun run bin/civireview.ts local --base master --preset local-gpu
```

Run it from a checkout of the repository under review or pass `--cwd`. The A/B checks
need Docker and CiviKitchen (`CIVIKITCHEN_PATH`). civireview creates its worktrees
under the home directory so that container runtimes that share only the home directory
can mount them.

## Stage subcommands

Each layer runs on its own and exchanges files with the next:

```bash
civireview evidence --repo owner/name --pr 123 --out ./evidence
civireview review   --evidence ./evidence --out ./review.json --preset cross-model
civireview publish  --review ./review.json --evidence ./evidence
civireview reply    --repo owner/name --pr 123 --comment-id 456 --evidence ./evidence --question "Why?"
```

`evidence` needs no model credentials and is the way to see what civireview would
measure for a PR: the profile, the probed routes, the gate results and the *Not
verified* list are all in `evidence.json`.

## Mention watcher

For a repository where you cannot install a workflow (an upstream project), `civireview
watch` polls for `@civireview` mentions and runs the pipeline for each.

```bash
bun run bin/civireview.ts watch \
  --mode search \
  --repos civicrm/civicrm-core \
  --allow-orgs civicrm \
  --max-per-hour 10 \
  --max-daily-usd 15 \
  --max-age-minutes 1440
```

| Option | Purpose |
| --- | --- |
| `--mode search` | find mentions through the search API with any token |
| `--mode notifications` | read the notifications of a dedicated bot account; an idle poll costs no rate limit |
| `--allow`, `--allow-orgs`, `--allow-associations` | who may trigger; at least one is required |
| `--max-per-hour`, `--max-daily-usd` | budget; mentions beyond it are deferred, not dropped |
| `--max-age-minutes` | ignore older mentions, so a first start does not replay history |
| `--lock-models` | ignore model and preset flags from comments |
| `--wait-for-ci` | defer a review while the PR's CI is still running |
| `--check-only` | print pending mentions as JSON without reviewing |
| `--once` | one poll pass instead of a loop |

The watcher keeps processed comment ids and the budget records in a state file
(`--state`, default `.civireview-state/seen.json`). A PR head that already carries a
review is skipped unless the mention says `--full`. A mention whose processing fails
counts against the budget and is given up after three attempts.

[`.github/workflows/watch-core.yml`](../.github/workflows/watch-core.yml) runs the
watcher on a schedule. It does nothing until the repository variable
`CIVIREVIEW_WATCH_ENABLED` is `true`; the token of the bot account goes into the secret
`CIVIREVIEW_GITHUB_TOKEN`. The other variables and their defaults are at the top of the
workflow's steps. [`scripts/external-cron-trigger.sh`](../scripts/external-cron-trigger.sh)
dispatches the workflow from an external scheduler for faster pickup.
