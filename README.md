<p align="center">
  <img src="assets/cover.jpg" alt="The Siege of CiviCRM: maintainers review a pull request, shielded by a book bearing the CiviReview emblem, while an army of automatons buries them in sealed scrolls" width="100%" />
  <br />
  <em>The Siege of CiviCRM</em>
</p>

# civireview

A pull request reviewer for CiviCRM core and CiviCRM extensions. Before any model
reads the diff, civireview boots the base and the head of the PR in two disposable
CiviCRM Standalone instances and records what differs between them: test results,
API and route surface, schema, browser behaviour. The models then review the diff
with that evidence in hand, and a second model in a fresh context tries to disprove
every finding before it is posted.

The tool is in alpha. It misses defects and reports false ones; a review is input
for a human reviewer, not a merge decision.

## How a review is produced

Three layers, each usable on its own:

| Layer | Command | What it does | Uses a model |
| --- | --- | --- | --- |
| 1. Evidence | `civireview evidence` | Fetches PR, diff and CI status; runs the A/B checks in [CiviKitchen](https://github.com/civico-de/civikitchen); writes `evidence.json` | no |
| 2. Review | `civireview review` | Triage, specialist lenses (`correctness`, `security`, `tests`, `ui`), adversarial verifier, confidence gate; writes `review.json` | yes |
| 3. Publish | `civireview publish` | Maps findings to diff lines, posts one batched GitHub review | no |

`civireview pr` runs all three. Everything layer 1 measures is deterministic and ends
up in the review's verification matrix; everything a model claims is labelled with how
it was established (`PROVEN`, `CONFIRMED`, `NEEDS_QUESTION`).
[docs/how-it-works.md](docs/how-it-works.md) walks through one review stage by stage.

## Profiles

What civireview can verify depends on where the change lives. It detects one of four
profiles from the checkout and the diff and prints it in the review header:

| Profile | Applies to | Instance | Extension gates |
| --- | --- | --- | --- |
| `core` | civicrm-core, change outside `ext/` | changed files mounted over the image of the base branch | none |
| `core-extension` | civicrm-core, change inside a bundled extension (`ext/<name>`) | as `core`, the extension is enabled for the checks | taint, lifecycle, upgrade parity |
| `extension` | a repository with `info.xml` or `civikitchen.yaml` | whole checkout mounted as an extension | taint, lifecycle, upgrade parity |
| `generic` | anything else | none | none, the review is code reading only |

[docs/profiles.md](docs/profiles.md) lists per profile which checks run, how the
instance is built and what is never verified.

## Quick start

civireview runs on [Bun](https://bun.sh). The A/B checks need Docker and a CiviKitchen
checkout (`CIVIKITCHEN_PATH`, or `ab.civikitchenPath` in the config); without them the
review still runs and says which checks were skipped.

```bash
bun install

# Review a PR and print the result instead of posting it
bun run bin/civireview.ts pr https://github.com/civicrm/civicrm-core/pull/12345 --dry-run

# Collect evidence only: no model, no API key
bun run bin/civireview.ts evidence --repo civicrm/civicrm-core --pr 12345 --out ./evidence

# Review the current branch of a local checkout
bun run bin/civireview.ts local --base master
```

`pr` and `evidence` expect `--cwd` (default: current directory) to be a checkout of the
repository under review. GitHub access uses `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.
A model preset needs its provider's key in the environment (for example
`ANTHROPIC_API_KEY`); the `subscription` and `local-gpu` presets work without one.

<img src="assets/logo.png" alt="CiviReview logo" width="96" align="right" />

On GitHub, the civireview bot starts a review when a comment mentions it:

```text
@civireview                      review what changed since the last civireview review
@civireview --full               review the whole PR
@civireview --page civicrm/admin/extensions
                                 probe this route in the browser A/B
@civireview why?                 inside a review thread: answer in that thread
```

[docs/running.md](docs/running.md) covers the reusable GitHub workflow, the mention
watcher for repositories you cannot install a workflow in, and all comment flags.

## Reading the result

A review opens with a verdict (`Ready`, `Questions Only`, `Needs Changes`) and a merge
confidence from 1 to 5. The score is computed, not chosen by a model: each verified
finding and each failed check caps it, and the rationale names the strictest cap and
whether the deciding finding was reproduced in a run or only read in the code.

Below that:

- **Action items** — findings that passed the verifier with a confidence of at least
  `review.confidenceThreshold` (default 80).
- **Empirical verification matrix** — one row per deterministic check with `PASS`,
  `WARN`, `FAIL` or `NOT_VERIFIED`.
- **Not verified** — what the run could not check. `NOT_VERIFIED` in the matrix and an
  entry here mean the same thing: nobody looked.

[docs/reading-a-review.md](docs/reading-a-review.md) explains every section, the
verdict labels and the score caps.

## Documentation

| Document | Content |
| --- | --- |
| [docs/how-it-works.md](docs/how-it-works.md) | One review from mention to posted comment, stage by stage |
| [docs/profiles.md](docs/profiles.md) | The four profiles: detection, instance, checks, blind spots |
| [docs/reading-a-review.md](docs/reading-a-review.md) | Sections of a review, verdict labels, confidence, score caps |
| [docs/running.md](docs/running.md) | GitHub workflow, mention watcher, CLI subcommands, comment flags, live-instance eval |
| [docs/configuration.md](docs/configuration.md) | `civireview.yaml`, presets, depth and effort, check and path filters |
| [docs/security.md](docs/security.md) | Job isolation, secrets, untrusted PR content, watcher authorisation |
| [civireview.example.yaml](civireview.example.yaml) | Annotated configuration file |
| [CHANGELOG.md](CHANGELOG.md) | Changes per release |

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run format:check
bun test
```

Tests start no container and call no model: the A/B runner takes an injectable exec
function, the pipeline a mock runner. Releases go through `scripts/release.sh <x.y.z>`,
which checks CI on the commit, bumps the version and dates the changelog.

## License

AGPL-3.0-or-later — see [`LICENSE.md`](LICENSE.md).
