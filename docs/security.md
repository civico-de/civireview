# Security model

civireview handles three things that must not meet: code from a pull request by an
unknown author, credentials for model providers, and a token that can write to the
repository. The design keeps each pair apart.

## What a review executes

The evidence layer runs code from the PR: its tests, its upgrade steps, its pages in a
browser. This happens inside disposable CiviKitchen containers; the PR's files are
mounted read-only. The containers are removed after the run, or at the end of the
review when `live-prove` or `--interactive-browser` keeps them.

Models get three repository tools, all read-only and confined to the checkout: read a
file, search, list files. Path traversal and symlinks that leave the checkout are
rejected, and `.git/` cannot be read. With `live-prove` they can also run commands inside
the kept containers, through `docker compose exec` with an argument list, never a host
shell. The containers hold no credentials, and the PR's code already runs in them, so
this adds no access a PR author does not have.

The `claude` CLI works in the PR's worktree. The MCP servers it starts for these tools
(the live tool, the browser) run from civireview's own directory instead, so a
`bunfig.toml`, `.env` or `.npmrc` in the PR is not read on the host.

## Job isolation in the GitHub workflow

[`pr-review.yml`](../.github/workflows/pr-review.yml) splits a review into four jobs.
No job has both PR code and a secret worth stealing.

| Job | Runs PR code | Model credentials | GitHub permissions |
| --- | --- | --- | --- |
| `authorize` | no | no | read the PR, write a reaction or comment |
| `evidence` | yes, in containers | no | read contents |
| `review` | no | yes | read contents |
| `publish` | no | no | write pull requests and issues |

- `authorize` checks that the commenter may trigger a review, parses the flags, and
  pins the base and head commit. The later jobs use these two commits, so a push between
  the comment and the review does not change what is reviewed.
- The comment body reaches scripts as an environment variable, never interpolated into
  a shell command.
- `publish` receives `review.json`, validates it against the schema and posts it. It
  never sees the PR's code or a model.
- A public repository always runs on GitHub-hosted runners; a self-hosted runner label is
  refused there.

## Untrusted text in prompts

PR title, description, comments, linked issues and the diff are written by the PR's
author or by anyone who can comment. They are wrapped in a marked section whose closing
tag is escaped in the content, and every stage is instructed to treat that section as
data. This lowers the risk of prompt injection; it does not remove it. The limits that
hold regardless of what a model is talked into are structural: the review job cannot
write to GitHub, cannot run code and has no token for the repository beyond reading it.

## Knowledge server scope

For a public repository the models can reach only the public knowledge server, without
a team token, even if a team URL and token are configured or present in the
environment. A team server is used for private repositories only.

## Who may trigger a review

Every review costs money and posts under the bot's name.

- Workflow: users with write access to the repository, `allowed_users`, and members of
  `allowed_orgs`.
- Watcher: refuses to start without an explicit policy (`--allow`, `--allow-orgs` or
  `--allow-associations`). Bot accounts are not covered by organisation or association
  policies. Comments that carry a civireview marker are ignored, so the reviewer does
  not answer itself.
- `--max-per-hour` and `--max-daily-usd` bound the cost; `--max-age-minutes` keeps a
  fresh start from replaying old mentions; `--lock-models` stops commenters from
  selecting expensive models.
- Reasoning efforts above `high` cannot be requested from a comment.

## What is sent where

The diff, the PR context and the evidence go to the model provider of the configured
preset. For a private repository choose the preset accordingly; `local-gpu` keeps
everything on an endpoint you operate. Search queries go to the knowledge server.

## Reporting a vulnerability

Do not open a public issue. Write to security@civico.de with a description and, if
possible, a way to reproduce it.
