#!/usr/bin/env bash
# Usage: scripts/release.sh <x.y.z> [--dry-run]
#
# Releases the commit at origin/main: checks CI and the test suite, bumps package.json,
# dates the CHANGELOG's Unreleased section, commits, tags, pushes and creates the GitHub
# release from that section. --dry-run runs every check and prints the notes, changes nothing.
set -euo pipefail

die() { echo "release: $*" >&2; exit 1; }

version="${1:-}"
dry_run="${2:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/release.sh <x.y.z> [--dry-run]"
[[ -z "$dry_run" || "$dry_run" == "--dry-run" ]] || die "unknown option: $dry_run"

cd "$(git rev-parse --show-toplevel)"

[[ "$(git branch --show-current)" == "main" ]] || die "not on main"
[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean"
git fetch -q origin main --tags --force
head_sha="$(git rev-parse HEAD)"
[[ "$head_sha" == "$(git rev-parse origin/main)" ]] || die "HEAD differs from origin/main; push (or pull) first"
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && die "tag v$version already exists"

# CI must have finished green on exactly this commit; a run that is missing counts as not green.
runs="$(gh run list --commit "$head_sha" --json name,status,conclusion \
  --jq '.[] | "\(.name): \(.status) \(.conclusion)"')"
[[ -n "$runs" ]] || die "no CI run found for ${head_sha:0:7}"
if grep -qv ': completed success$' <<<"$runs"; then
  echo "$runs" >&2
  die "CI is not green on ${head_sha:0:7}"
fi

notes="$(awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f' CHANGELOG.md)"
[[ -n "${notes//[[:space:]]/}" ]] || die "CHANGELOG.md has no entries under [Unreleased]"

bun run typecheck
bun run lint
bun run format:check
bun test

if [[ "$dry_run" == "--dry-run" ]]; then
  printf 'Release v%s of %s would contain:\n\n%s\n' "$version" "${head_sha:0:7}" "$notes"
  exit 0
fi

bun -e 'const f = "package.json"; const p = await Bun.file(f).json(); p.version = process.argv[1]; await Bun.write(f, JSON.stringify(p, null, 2) + "\n");' "$version"
[[ "$(git diff --numstat -- package.json | cut -f1,2)" == $'1\t1' ]] || die "package.json changed by more than the version line"

tmp="$(mktemp)"
awk -v v="$version" -v d="$(date +%F)" \
  '/^## \[Unreleased\]/ && !done {print; print ""; print "## [" v "] - " d; done=1; next} {print}' \
  CHANGELOG.md > "$tmp"
mv "$tmp" CHANGELOG.md

notes_file="$(mktemp)"
printf '%s\n' "$notes" | sed '1{/^$/d;}' > "$notes_file"

git add package.json CHANGELOG.md
git commit -q -m "chore: release v$version"
git tag "v$version"
git push origin main "v$version"
gh release create "v$version" --title "v$version" --notes-file "$notes_file" --verify-tag
rm -f "$notes_file"
echo "Released v$version"
