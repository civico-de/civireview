# Configuration

civireview reads `civireview.yaml` or `.civireview.yaml` from the root of the reviewed
repository. Every key is optional. Command line flags override the file; the file
overrides the defaults. Unknown keys are an error.
[`civireview.example.yaml`](../civireview.example.yaml) shows every key. Its values are
the defaults except in the `watch` block, which is an example policy: by default no
repository is watched, nobody is allowed and no limit is set.

## Models

A model is written `<provider>:<model>`. Providers: `anthropic`, `openai`, `google`,
`openrouter`, `openai-compat` (any OpenAI-compatible endpoint), and the CLI-backed
`claude-cli`, `codex-cli`, `opencode-cli`.

`botLogin` is the GitHub login the reviews are posted as. When set, only comments of
that login count as the marker of an earlier review; without it a marker in anyone's
comment is accepted. `--bot-login` sets it on the command line; the watch workflow
passes the repository variable `CIVIREVIEW_BOT_LOGIN`. A wrong login makes the tool
ignore its own markers, so every mention starts a full review.

`preset` picks a model per stage:

| Preset | Triage | Specialists | Verifier | Needs |
| --- | --- | --- | --- | --- |
| `sonnet` (default) | Sonnet | Sonnet | Sonnet | `ANTHROPIC_API_KEY` |
| `sonnet-opus` | Sonnet | Sonnet | Opus | `ANTHROPIC_API_KEY` |
| `cross-model` | Haiku | Sonnet | an OpenAI model | both keys |
| `subscription` | `claude-cli` models | `claude-cli` | `claude-cli` | a logged-in `claude` CLI |
| `local-gpu` | `openai-compat:local` | `opencode-cli:local` | `opencode-cli:local` | `OPENAI_COMPAT_BASE_URL`, `opencode` |

The exact model ids are pinned in `PRESETS` in
[`src/config/schema.ts`](../src/config/schema.ts). `models.triage`,
`models.specialists.<lens>`, `models.verifier` and `models.threadReply` override single
stages; `--model` overrides all specialists, `--verifier` and `--triage` one stage.

Using a different model for the verifier than for the specialists is the point of the
two-model presets: a finding has to convince a model that did not produce it.

## Depth and effort

`review.depth` (`--depth`) sets how far the model stages go:

| Depth | Verifier | Follow-up rounds | Use |
| --- | --- | --- | --- |
| `fast` | only when specialists report candidates | 0 | quick pass, small PRs |
| `balanced` | only when specialists report candidates | 1 | |
| `deep` (default) | whenever a specialist ran | 2 | full review |

Depth also sets the step, token and time budget per stage; the values are in
`REVIEW_DEPTH_PROFILES` in the same file. `review.maxSteps`, `triageMaxSteps`,
`maxOutputTokens`, `maxFollowUpRounds` and `stageTimeoutMs` override single values, so
leave them out unless a profile value needs changing.

`review.maxBudgetUsd` caps one review: before each specialist and verifier call the
estimated cost so far is compared with it, and the review fails without posting once
the cap is reached. The watcher does not retry such a review and counts its cost
against `watch.maxDailyUsd`. The cap follows the cost estimate in the review footer: a run through a CLI
subscription is counted at API prices. The check runs before a call, so a review can
end above the cap by the cost of one call. A model without a known price is not
capped. A runner that reports no token usage (`codex-cli`, `opencode-cli`) cannot be
capped at all: a config that sets the cap and uses such a model is rejected.

`review.effort` (`--effort`) is the reasoning effort passed to the models. `auto`
derives it per stage from the depth and, at `balanced`, from the risk of the PR.
`review.stageEffort` fixes it for one stage.

## Checks and lenses

`checks` switches the evidence checks:

| Key in `checks` | Name in `include`/`exclude` | Default | Check |
| --- | --- | --- | --- |
| `abTests` | `ab-tests` | on | proof of fix and base-test regression |
| `surface` | `surface` | on | live surface diff |
| `staticDelta` | `static-delta` | on | taint delta |
| `lifecycle` | `lifecycle` | on | lifecycle and upgrade parity |
| `browser` | `browser` | on | browser A/B |
| `a11y` | `a11y` | on | accessibility scan within the browser A/B |
| `interactiveBrowser` | `interactive-browser` | off | browser the `ui` lens and the verifier can drive |
| `liveProve` | `live-prove` | off | read-only probes of both instances for the verifier |
| `matrix` | `matrix` | off | extension repositories: run the head's tests on the floor image and on the beta image |

`ab.enabled: false` (`--no-ab`) switches all instance checks off at once.

`review.include` and `review.exclude` (`--include`, `--exclude`) take check names and
the lens names `correctness`, `security`, `tests`, `ui`. A non-empty `include` runs
only what it lists; `exclude` always wins.

The two opt-in checks that keep the instances running change what a finding can be:
with `live-prove` the verifier may issue HTTP GET requests and APIv4 `get`,
`getActions` and `getFields` calls against A and B and attach the output, which turns a
`CONFIRMED` finding into a `PROVEN` one.

## Browser

| Key | Default | Meaning |
| --- | --- | --- |
| `browser.pages` | none | routes always probed as a logged-in user |
| `browser.anonymousPages` | none | routes probed without a login |
| `browser.maxAutoPages` | 5 | limit for discovered routes |
| `browser.sendScreenshotsToLlm` | on | hand the screenshots to the `ui` lens and the verifier |

For a repository whose main screens are known, list them in `browser.pages`; route
discovery ([how-it-works.md](how-it-works.md#26-which-routes-the-browser-probes)) then
only adds to them.

## Diff

`review.paths.include` and `review.paths.exclude` are globs (`*`, `**`, `?`) over the
changed paths. `review.maxDiffBytes` limits what the models receive.

## Posting

| Key | Default | Meaning |
| --- | --- | --- |
| `review.confidenceThreshold` | 80 | minimum confidence of a posted finding |
| `review.maxInlineComments` | 10 | further findings go to the summary |
| `review.reviewEvent` | `COMMENT` | or `REQUEST_CHANGES`, `APPROVE` |
| `review.autoPost` | on | when off, `civireview pr` prints the review instead of posting it |
| `review.mentionUsers` | off | when off, `@name` in the review is written as code so nobody is notified |

## Knowledge server

`mcp.publicUrl` is a search server over CiviCRM core, extensions and documentation that
the models may query. A private repository can set `mcp.teamUrl` with a token read from
the environment variable named in `mcp.tokenEnv`; a public repository never receives
the team URL or the token. `mcp.enabled: false` runs without it.

## CiviKitchen

`ab.civikitchenPath` (or `CIVIKITCHEN_PATH`) points at a CiviKitchen checkout;
`ab.ckCommand` names a `ck` binary instead. Which image is used follows from the
profile ([profiles.md](profiles.md)). For an extension repository the CiviCRM version
comes from `policy.civicrm` in the repository's `civikitchen.yaml`; that file belongs
to CiviKitchen and civireview reads nothing else from it.

## Watcher

The `watch` block mirrors the options of `civireview watch`
([running.md](running.md#mention-watcher)).
