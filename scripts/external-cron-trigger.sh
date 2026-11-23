#!/usr/bin/env bash
# Notification-mode external trigger for civireview's watch-core.yml.
#
# Polls the @civireview GitHub notifications inbox from an Uberspace cron and
# dispatches civico-de/civireview's watch-core.yml only when participating
# "mention" threads change. After each change it re-dispatches every 5 minutes
# for RECHECK_MINUTES (default 90 = the --wait-for-ci-max-minutes default) so
# reviews deferred on pending CI are retried once Jenkins finishes. Watch-core
# deduplicates itself (seen.json), and a pre-flight run with pending_count=0
# exits after ~30s, so the follow-up dispatches are cheap.
#
# The workflow's own mark-as-read bumps a thread's updated_at once after a
# processed review, which costs one extra idle pre-flight per mention. The
# inbox is polled with all=true, so viewing it in a browser never drops a
# queued mention.
#
# Config (~/.config/civireview-dispatch.env, chmod 600):
#   GH_NOTIFY_TOKEN="ghp_..."         # Classic PAT on @civireview, 'notifications' scope only
#   GH_DISPATCH_TOKEN="github_pat_..." # Fine-grained PAT: civico-de/civireview -> Actions: Read & write
#   # Optional:
#   # WORKFLOW_REPO="civico-de/civireview"
#   # WORKFLOW_FILE="watch-core.yml"
#   # WORKFLOW_REF="main"
#   # RECHECK_MINUTES="90"
#
# Setup (once, on the cron host, creates the state dir before the first cron run):
#   mkdir -p ~/bin ~/.cache/civireview-cron
#   $HOME/bin/trigger-civireview.sh        # cold start
#
# Crontab (runs every minute, zero Actions runs when idle):
#   * * * * * $HOME/bin/trigger-civireview.sh 2>>"$HOME/.cache/civireview-cron/cron.log" >/dev/null

set -euo pipefail

ENV_FILE="${CIVIREVIEW_ENV_FILE:-$HOME/.config/civireview-dispatch.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [ -z "${GH_NOTIFY_TOKEN:-}" ] || [ -z "${GH_DISPATCH_TOKEN:-}" ]; then
  echo "Missing GH_NOTIFY_TOKEN and/or GH_DISPATCH_TOKEN in $ENV_FILE" >&2
  exit 1
fi

WORKFLOW_REPO="${WORKFLOW_REPO:-civico-de/civireview}"
WORKFLOW_FILE="${WORKFLOW_FILE:-watch-core.yml}"
WORKFLOW_REF="${WORKFLOW_REF:-main}"
RECHECK_MINUTES="${RECHECK_MINUTES:-90}"
GITHUB_API="${GITHUB_API:-https://api.github.com}"

STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/civireview-cron"
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/lock"
# Best-effort overlap guard; the in-progress-run check covers hosts without flock.
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || exit 0
fi

NOW="${NOW_EPOCH:-$(date +%s)}" # test seam for deterministic window tests
LAST_POLL_FILE="$STATE_DIR/last-poll"
SEEN_FILE="$STATE_DIR/seen-threads"
ACTIVE_UNTIL_FILE="$STATE_DIR/active-until"

log() { echo "[$(date -u +%FT%TZ)] $*" >&2; }

# Cold start: begin watching from now, never from historical notifications.
if [ ! -f "$LAST_POLL_FILE" ]; then
  echo "$NOW" > "$LAST_POLL_FILE"
  : > "$SEEN_FILE"
  echo 0 > "$ACTIVE_UNTIL_FILE"
  log "cold start: watching $WORKFLOW_REPO/$WORKFLOW_FILE from $(date -u -d "@$NOW" +%FT%TZ 2>/dev/null || echo "$NOW")"
  exit 0
fi

# Re-poll a 5-minute overlap and deduplicate by (thread, updated_at) pairs, so
# clock skew between this host and GitHub can never hide a mention.
OVERLAP=300
SINCE_ISO="$(python3 -c 'import sys,time;print(time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime(int(sys.argv[1]))))' \
  "$(( $(cat "$LAST_POLL_FILE") - OVERLAP ))")"

curl -fsSg --max-time 30 \
  -H "Authorization: Bearer $GH_NOTIFY_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -o "$STATE_DIR/notifications.json" \
  "$GITHUB_API/notifications?all=true&participating=true&per_page=50&since=$SINCE_ISO"

NEW="$(python3 - "$SEEN_FILE" "$STATE_DIR/notifications.json" <<'PY'
import json, sys
seen_path, notifs_path = sys.argv[1], sys.argv[2]
with open(seen_path) as f:
    seen = {tuple(l.split()) for l in f if l.strip()}
with open(notifs_path) as f:
    items = json.load(f)
new = 0
for it in items:
    # participating=true would also surface author/ci_activity events; only
    # @-mentions may trigger a review.
    if it.get("reason") != "mention":
        continue
    pair = (str(it["id"]), it["updated_at"])
    if pair not in seen:
        new = 1
    seen.add(pair)
with open(seen_path, "w") as f:
    for pair in sorted(seen, key=lambda p: p[1])[-500:]:
        f.write("%s %s\n" % pair)
print(new)
PY
)"
echo "$NOW" > "$LAST_POLL_FILE"

ACTIVE_UNTIL="$(cat "$ACTIVE_UNTIL_FILE" 2>/dev/null || echo 0)"
should_dispatch=0
if [ "$NEW" = "1" ]; then
  ACTIVE_UNTIL=$((NOW + RECHECK_MINUTES * 60))
  echo "$ACTIVE_UNTIL" > "$ACTIVE_UNTIL_FILE"
  should_dispatch=1
  log "new mention activity detected"
elif [ "$NOW" -lt "$ACTIVE_UNTIL" ] && [ $(( (NOW / 60) % 5 )) -eq 0 ]; then
  # wait-for-ci recheck slot: keep the workflow polling while CI may still run
  should_dispatch=1
  log "wait-for-ci recheck slot"
fi

if [ "$should_dispatch" -ne 1 ]; then
  exit 0
fi

API="$GITHUB_API/repos/$WORKFLOW_REPO/actions/workflows/$WORKFLOW_FILE"
DISPATCH_HDR=(
  -H "Authorization: Bearer $GH_DISPATCH_TOKEN"
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2022-11-28"
)

curl -fsSg --max-time 30 "${DISPATCH_HDR[@]}" \
  -o "$STATE_DIR/runs.json" \
  "$API/runs?per_page=5"

ACTIVE_RUN="$(python3 - "$STATE_DIR/runs.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
active = any(
    r.get("status") in ("in_progress", "queued", "waiting", "pending", "requested")
    for r in data.get("workflow_runs", [])
)
print("1" if active else "0")
PY
)"
if [ "$ACTIVE_RUN" = "1" ]; then
  log "workflow already queued or running, skipping dispatch"
  exit 0
fi

curl -fsSg --max-time 30 -o /dev/null -X POST "${DISPATCH_HDR[@]}" "$API/dispatches" \
  -d "{\"ref\":\"$WORKFLOW_REF\",\"inputs\":{\"dry_run\":false}}"
log "dispatched $WORKFLOW_REPO/$WORKFLOW_FILE@$WORKFLOW_REF"
