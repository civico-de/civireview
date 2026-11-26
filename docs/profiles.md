# Profiles

A profile describes where a change lives and therefore what civireview can run against
it. It is detected, not configured, and shown in the review header as
`Profile: core-extension`.

The profile is independent of the PR *kind* that triage assigns (`core-bugfix`,
`extension-pr`, `ui-change`, …). The kind describes what the change is and steers the
models; the profile decides which instances are built and which checks run.

## Detection

| Step | Rule |
| --- | --- |
| 1 | The checkout has `xml/version.xml` and `CRM/` → civicrm-core. |
| 2 | Otherwise it has `info.xml` or `civikitchen.yaml` → `extension`. |
| 3 | Otherwise → `generic`. |
| 4 | civicrm-core only: each changed path under `ext/` is mapped to the nearest parent directory with an `info.xml` in the PR's head. One hit or more → `core-extension`, none → `core`. |

A core PR that changes both `CRM/…` and `ext/<name>/…` is `core-extension`: it gets
everything the `core` profile runs plus the extension gates for the bundled extension.
The gates run for at most two bundled extensions per PR.

## What runs

| Check | `core` | `core-extension` | `extension` | `generic` |
| --- | --- | --- | --- | --- |
| CI status | yes, Jenkins down to failed test names | as `core` | commit statuses | commit statuses |
| Static surface diff | yes | yes | yes | yes |
| Proof of fix (tests the PR changes) | yes | yes | yes | no |
| Base-test regression | tests next to the changed code | as `core` | the extension's `tests/phpunit` | no |
| Live surface diff | yes | yes | yes | no |
| Browser A/B | yes | yes, extension enabled first | yes | no |
| Taint delta | no | yes | yes | no |
| Lifecycle | no | when schema, upgrader or managed files change | same | no |
| Upgrade parity | no | when schema or upgrader files change and the extension exists at the base | same | no |
| Model review | yes | yes | yes | yes |

Every check can be switched off ([configuration.md](configuration.md)); a check that
is off or cannot run is listed under *Not verified*.

## `core`

**Instance.** The image follows the base branch: `master` uses the nightly master image,
a release branch `6.x` the image of that minor. If the tag is not published yet (a
freshly cut release branch), the beta, master and stable images are tried in turn.

**Code.** Changed files are bind-mounted one by one over the image's core tree, base
files into A and head files into B. Files merged to the base branch after the image was
built are mounted into both sides, to bring A close to the PR's base commit rather than
last night's build. This looks back 40 commits at most, so an older image can still
differ from the base. A PR that deletes or renames core files, or changes more than 40, mounts
the affected top-level directories instead.

**Tests.** PHPUnit files the PR adds or changes are run on both sides, limited to the
changed methods where possible. For regression, civireview picks existing tests that
belong to the changed classes. Browser-driven end-to-end tests are not run.

**Never verified in this profile**

- The upgrade path. Mounting files does not run `CRM/Upgrade/*`; a changed upgrade step
  is reviewed by reading it.
- Schema changes. The instance keeps the schema of the image; a new column in
  `xml/schema` or an entity definition does not exist in the database of either side, so
  tests that need it fail on both.
- Composer changes. `vendor/` is the image's.
- Other CMS integrations, apart from a login and page loads on the CMS whose files the
  PR changes ([reading-a-review.md](reading-a-review.md#empirical-verification-matrix)).
  Tests and the other checks run on Standalone.

Each of these appears under *Not verified* when the PR touches the corresponding files.

## `core-extension`

A bundled extension is reviewed by core's rules (core standards, core PR kinds, core
CI), but its lifecycle is an extension's: it has its own `info.xml`, its own upgrader and
often its own schema and admin screens. This profile adds the extension checks to
everything in `core`.

**Enabling.** Many bundled extensions ship disabled in the image. For the browser probe
and the lifecycle check the extension is enabled on both sides first, so its routes and
entities exist.

**Routes.** If the PR changes UI files of the extension, the routes it defines in
`xml/Menu/*.xml` and in `ang/*.aff.json` / `ang/*.aff.php` are probed. Without this a
change to an admin form would only ever load the dashboard.

**Extension gates.** Taint delta, lifecycle and upgrade parity run from the extension's
directory inside the core tree. For upgrade parity the base version of the extension
directory is installed, replaced by the head version and upgraded with the extension
upgrader; the resulting schema is compared with a fresh install of the head. This is
the only check that executes a new `upgrade_N` step.

**Never verified in this profile**

- Everything listed for `core`, for the parts of the PR outside `ext/`.
- Upgrade parity for an extension the PR adds: there is no base version to upgrade from.
  The browser probe is not verified for it either, since the extension cannot be enabled
  on the base.
- Upgrade parity for a PR that is mounted as whole directories (it deletes or renames
  core files, or changes more than 40): the extension directory is then read-only.
- Data migrations inside an upgrade step. Parity compares schemas, not the content of
  the tables.

## `extension`

**Instance.** The image follows the CiviCRM floor in the repository's `civikitchen.yaml`
(`policy.civicrm`); without one the stable image is used. The extension is reviewed
against that one CiviCRM version.

**Code.** The base worktree is mounted as the extension directory into A, the head
worktree into B. The directory name comes from `<file>` in `info.xml`.

**Tests.** Changed tests under the extension run on both sides for proof of fix; the
extension's `tests/phpunit` directory is the regression suite.

**Extension gates.** As for `core-extension`, from the extension's root.

**Never verified in this profile**

- Other CiviCRM versions than the floor image, and other CMS integrations.
- Dependencies on extensions that are not part of the image.
- Composer dependencies of the extension, unless they are committed.
- Data migrations inside an upgrade step.

## `generic`

No instance is started. The review consists of the PR context, CI statuses, the static
surface diff and the model stages; every finding is at best `CONFIRMED`. The review
says so under *Not verified*.

## Reading the gates

| Gate | Passed | Finding | Not verified |
| --- | --- | --- | --- |
| Taint delta | no issue on the head beyond those of the base | each new issue with file and line; error for a blocking taint class, info for an advisory one | the analysis timed out, failed without reporting an issue, or the tool is missing |
| Lifecycle | the lifecycle report ends without a failed step | error with the tail of the report | the tool never reached its report (precondition failed, timeout) |
| Upgrade parity | upgraded and fresh schema are identical | warning with the schema diff | a step before the comparison failed; the note names the step |

A schema difference is a warning, not an error, because a different column order
between an upgraded and a new site is common and harmless. A missing column or a
different type in the same diff is not. The diff is in the finding.

The taint delta compares issues by type, file and message, not by line, so an existing
issue that the PR merely moves is not reported as new.

Each gate runs in its own instance. An instance left behind by a gate that timed out is
removed before the next gate starts.
