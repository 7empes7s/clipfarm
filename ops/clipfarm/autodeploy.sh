#!/usr/bin/env bash
# Puts the newest main live by itself. clipfarm-autodeploy.timer runs it every 5 minutes, as root,
# from the root-owned copy that install-autodeploy.sh keeps in /usr/local/lib/clipfarm/ops.
#
# One run, in order:
#   1. fetch origin/main. A commit that was already tried is left alone.
#   2. go on only when every GitHub check of that commit is green (red or still running: wait).
#   3. wait until clipfarm has no job running (at most 20 minutes, then go anyway).
#   4. deploy.sh <commit>: build, switch, restart, health check; it goes back by itself on failure.
#   5. on success: install-autodeploy.sh of that commit (scripts and units follow the code).
#   6. Postiz: ops/postiz/install.sh when ops/postiz changed, key files wait in
#      /etc/clipfarm/pending-keys, Postiz is not installed or not healthy, or clipfarm has no
#      Postiz API key yet (every half hour, until the first Postiz account exists).
#   7. clipfarm-ops test-keys and clipfarm:check, then /var/lib/clipfarm/deploy-status.json for the
#      Dashboard's "Live version" card. A failure or rollback sends a push notification.
#
# The GitHub token is read from a root-only file and handed to gh in its environment: it is never
# printed, logged or put on a command line.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=ops/clipfarm/common.sh
. "$here/common.sh"

REPO="$ROOT/repo"
GH_REPO="${CLIPFARM_GH_REPO:-7empes7s/clipfarm}"
TOKEN_FILE="${CLIPFARM_GH_TOKEN_FILE:-/etc/keel/gh.env}"
STATE="${CLIPFARM_AUTODEPLOY_STATE:-/var/lib/clipfarm-autodeploy}"
LOCK="${CLIPFARM_AUTODEPLOY_LOCK:-/run/lock/clipfarm-autodeploy.lock}"
OPS_LIB="${CLIPFARM_OPS_LIB:-/usr/local/lib/clipfarm/ops}"
STATUS_FILE="${CLIPFARM_DEPLOY_STATUS:-/var/lib/clipfarm/deploy-status.json}"
PENDING_KEYS="${CLIPFARM_PENDING_KEYS:-/etc/clipfarm/pending-keys}"
POSTIZ_DIR="${POSTIZ_DIR:-/opt/postiz}"
NODE="${CLIPFARM_NODE:-/usr/bin/node}"
IDLE_WAIT_MAX="${CLIPFARM_IDLE_WAIT_MAX:-1200}"
IDLE_POLL="${CLIPFARM_IDLE_POLL:-30}"
POSTIZ_RETRY_SEC="${CLIPFARM_POSTIZ_RETRY_SEC:-3600}"
POSTIZ_KEY_RETRY_SEC="${CLIPFARM_POSTIZ_KEY_RETRY_SEC:-1800}"

say() { echo "clipfarm autodeploy: $*"; }
die() { echo "clipfarm autodeploy: $*" >&2; exit 1; }

# Says a waiting reason once, not on every 5-minute run.
say_once() {
  [ "$(cat "$STATE/last-note" 2> /dev/null)" != "$1" ] || return 0
  echo "$1" > "$STATE/last-note"
  say "$1"
}

# Prints green, red or pending for a commit, from its GitHub check runs. Fails when GitHub
# cannot be asked.
ci_state() {
  local line token='' runs status conclusion state=green count=0
  [ -r "$TOKEN_FILE" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^(export[[:space:]]+)?GH_TOKEN=(.*)$ ]] && token="${BASH_REMATCH[2]}"
  done < "$TOKEN_FILE"
  token="${token%\"}" token="${token#\"}" token="${token%\'}" token="${token#\'}"
  [ -n "$token" ] || return 1
  runs="$(GH_TOKEN="$token" timeout 60 gh api --paginate "repos/$GH_REPO/commits/$1/check-runs?per_page=100" \
    --jq '.check_runs[] | [.status, (.conclusion // "none"), .name] | @tsv' 2> /dev/null)" || return 1
  while IFS=$'\t' read -r status conclusion _; do
    [ -n "$status" ] || continue
    count=$((count + 1))
    if [ "$status" != completed ]; then
      [ "$state" = red ] || state=pending
    elif [[ "$conclusion" != success && "$conclusion" != skipped && "$conclusion" != neutral ]]; then
      state=red
    fi
  done <<< "$runs"
  # No check yet: CI has not started on this commit.
  [ "$count" -gt 0 ] || state=pending
  echo "$state"
}

# Returns when clipfarm has no job running, or after IDLE_WAIT_MAX seconds. A restart puts a
# running job back in the queue, so going anyway loses time, not work.
wait_idle() {
  local waited=0 out
  [ -L "$ROOT/current" ] || return 0
  while :; do
    out="$(ops_cli status 2> /dev/null)" || return 0
    [[ "$out" =~ Queue:\ ([0-9]+)\ running ]] || return 0
    [ "${BASH_REMATCH[1]}" != 0 ] || return 0
    if [ "$waited" -ge "$IDLE_WAIT_MAX" ]; then
      say "a job is still running after $((waited / 60)) minutes: deploying anyway (the job goes back in the queue)"
      return 0
    fi
    [ "$waited" != 0 ] || say "a job is running: waiting for it, at most $((IDLE_WAIT_MAX / 60)) minutes"
    sleep "$IDLE_POLL"
    waited=$((waited + IDLE_POLL))
  done
}

postiz_healthy() {
  local port='' line code
  [ -f "$POSTIZ_DIR/.env" ] || return 1
  systemctl is-active --quiet postiz.service || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^POSTIZ_PORT=([0-9]+)$ ]] && port="${BASH_REMATCH[1]}"
  done < "$POSTIZ_DIR/.env"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:${port:-5300}/" 2> /dev/null || true)"
  [[ "$code" =~ ^[23] ]]
}

postiz_state() {
  if [ ! -f "$POSTIZ_DIR/.env" ]; then
    echo 'not installed'
  elif postiz_healthy; then
    echo healthy
  else
    echo 'not healthy'
  fi
}

pending_key_files() { # one per line: the key files that still hold something
  local file
  for file in "$PENDING_KEYS"/*; do
    if [ -f "$file" ] && [ -s "$file" ]; then echo "$file"; fi
  done
}

# Why the Postiz installer must run now, or nothing when Postiz is fine as it is.
postiz_reason() {
  local ops_sha postiz_sha
  ops_sha="$(cat "$STATE/ops-sha" 2> /dev/null || true)"
  postiz_sha="$(cat "$STATE/postiz-sha" 2> /dev/null || true)"
  if [ -n "$(pending_key_files)" ]; then
    echo 'new platform keys'
  elif [ ! -f "$POSTIZ_DIR/.env" ]; then
    echo 'Postiz is not installed'
  elif [ -n "$ops_sha" ] && [ "$ops_sha" != "$postiz_sha" ] \
    && { [ -z "$postiz_sha" ] || ! as_app git -C "$REPO" diff --quiet "$postiz_sha" "$ops_sha" -- ops/postiz 2> /dev/null; }; then
    echo 'ops/postiz changed'
  elif ! postiz_healthy; then
    echo 'Postiz is not healthy'
  elif ! has_postiz_key && ! lately "$STATE/postiz-no-key" "$POSTIZ_KEY_RETRY_SEC"; then
    # The installer hands the key over once the manager made the first Postiz account.
    echo 'clipfarm has no Postiz API key yet'
  fi
}

lately() { # file, seconds: the file was written less than that long ago
  [ -f "$1" ] && [ $(($(date +%s) - $(stat -c %Y "$1"))) -lt "$2" ]
}

has_postiz_key() { # names only: the value is never read into a variable that is printed
  grep -q '^POSTIZ_API_KEY=..*' "$ENV_FILE" 2> /dev/null
}

# After a failed install: not again for the same code within POSTIZ_RETRY_SEC, unless a key file is newer.
postiz_tried_lately() {
  local stamp="$STATE/postiz-failed" file
  [ -f "$stamp" ] || return 1
  [ "$(sed -n 1p "$stamp")" = "$(cat "$STATE/ops-sha" 2> /dev/null || true)" ] || return 1
  lately "$stamp" "$POSTIZ_RETRY_SEC" || return 1
  while IFS= read -r file; do
    if [ -n "$file" ] && [ "$file" -nt "$stamp" ]; then return 1; fi
  done <<< "$(pending_key_files)"
  return 0
}

postiz_detail=''
postiz_ran=0

run_postiz() { # reason
  local args=() file log code why before=''
  while IFS= read -r file; do
    [ -z "$file" ] || args+=(--keys-from "$file")
  done <<< "$(pending_key_files)"
  say "$1: running the Postiz installer"
  postiz_ran=1
  log="$(mktemp "$STATE/postiz.XXXXXX")"
  set +e
  bash "$OPS_LIB/postiz/install.sh" "${args[@]}" 2>&1 | tee "$log"
  code="${PIPESTATUS[0]}"
  set -e
  if [ "$code" = 0 ]; then
    rm -f "$log" "$STATE/postiz-failed"
    cp "$STATE/ops-sha" "$STATE/postiz-sha" 2> /dev/null || true
    has_postiz_key || touch "$STATE/postiz-no-key"
    # The installer emptied the key files it merged.
    for file in "$PENDING_KEYS"/*; do
      if [ -f "$file" ] && [ ! -s "$file" ]; then rm -f "$file"; fi
    done
    return 0
  fi
  why="$(grep '^postiz-install: ' "$log" | tail -n 1 | sed 's/^postiz-install: //')"
  rm -f "$log"
  postiz_detail="${why:-the installer stopped (journalctl -u clipfarm-autodeploy shows where)}"
  [ ! -f "$STATE/postiz-failed" ] || before="$(sed -n 2p "$STATE/postiz-failed")"
  printf '%s\n%s\n' "$(cat "$STATE/ops-sha" 2> /dev/null || true)" "$postiz_detail" > "$STATE/postiz-failed"
  # The same reason again an hour later is not news.
  [ "$before" = "$postiz_detail" ] || notify 'Postiz needs a look' "The Postiz installer stopped: $postiz_detail"
}

# Writes the status file in one move, readable by the app.
save_status() { # the new JSON on stdin
  local tmp
  tmp="$(mktemp "$STATUS_FILE.XXXXXX")"
  cat > "$tmp"
  chmod 644 "$tmp"
  chown --reference="$(dirname "$STATUS_FILE")" "$tmp" 2> /dev/null || true
  mv "$tmp" "$STATUS_FILE"
}

main() {
  local sha last ci='' result='' reason='' work code line keys_out keys_json check_out check_ok problems why

  mkdir -p "$STATE"
  exec 9> "$LOCK"
  flock -n 9 || exit 0 # a run is already going
  [ -d "$REPO" ] || die "$REPO is missing. Do RUNBOOK.md step 3 first."

  as_app git -C "$REPO" fetch --quiet --prune origin || die "could not fetch from GitHub."
  sha="$(as_app git -C "$REPO" rev-parse --verify --quiet 'origin/main^{commit}')" || die "$REPO has no origin/main."
  last="$(cat "$STATE/last-sha" 2> /dev/null || true)"

  if [ "$sha" != "$last" ]; then
    ci="$(ci_state "$sha")" || die "could not read the checks of ${sha:0:12} from GitHub (token file: $TOKEN_FILE)."
    case "$ci" in
      pending) say_once "${sha:0:12}: its checks are still running, waiting." ;;
      red) say_once "${sha:0:12}: a check failed, so it is not deployed." ;;
    esac
  fi

  if [ "$ci" = green ]; then
    work="$(mktemp -d "$STATE/ops.XXXXXX")"
    # shellcheck disable=SC2064
    trap "rm -rf '$work'" EXIT
    as_app git -C "$REPO" archive "$sha" ops | tar -x --no-same-owner -C "$work"
    wait_idle
    say "deploying ${sha:0:12}"
    set +e
    bash "$work/ops/clipfarm/deploy.sh" "$sha" 2>&1 | tee "$work/deploy.log"
    code="${PIPESTATUS[0]}"
    set -e
    echo "$sha" > "$STATE/last-sha" # tried: not again, whatever came of it
    line="$(grep '^clipfarm deploy: ' "$work/deploy.log" | tail -n 1 | sed 's/^clipfarm deploy: //')"
    if [ "$code" = 0 ]; then
      result=live
      if bash "$work/ops/clipfarm/install-autodeploy.sh"; then
        echo "$sha" > "$STATE/ops-sha"
      else
        say "the scripts and units of ${sha:0:12} could not be installed; the ones before stay in use."
      fi
    elif [ "$code" = 3 ]; then
      result='rolled back'
      reason="Update ${sha:0:7} did not start: ${line:-the version before it is live again.}"
    else
      result=failed
      reason="Update ${sha:0:7} could not be built. The version before it keeps running."
    fi
  fi

  why="$(postiz_reason)"
  if [ -n "$why" ] && [ -f "$OPS_LIB/postiz/install.sh" ] && ! postiz_tried_lately; then
    run_postiz "$why"
  fi

  if [ -n "$result" ]; then
    keys_out="$(test_keys)" || true
    keys_json="$(jq -Rn '[inputs | capture("^(?<name>[^:]+): (?<state>Working|Failed|Not set)")]' <<< "$keys_out")"
    check_ok=true
    check_out="$(CLIPFARM_ENV_FILE="$ENV_FILE" "$NODE" "$OPS_LIB/clipfarm/check-cli.ts" 2>&1)" || check_ok=false
    echo "$check_out"
    problems="$(grep -v '^OK: ' <<< "$check_out" || true)"
    jq -n --arg sha "$sha" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg result "$result" --arg reason "$reason" \
      --argjson keys "$keys_json" --argjson checkOk "$check_ok" --arg problems "$problems" \
      --arg postiz "$(postiz_state)" --arg postizDetail "$postiz_detail" '{
        sha: $sha, at: $at, result: $result, reason: $reason, keys: $keys,
        check: { ok: $checkOk, problems: ($problems | split("\n") | map(select(. != ""))) },
        postiz: { state: $postiz, detail: $postizDetail }
      }' | save_status
    if [ "$result" != live ]; then
      say "$reason"
      notify "clipfarm update ${result}" "$reason"
      exit 1
    fi
    say "${sha:0:12} is live."
    if [ "$check_ok" != true ]; then
      notify 'clipfarm is live, but a check failed' "$(head -n 1 <<< "$problems")"
    fi
  elif [ "$postiz_ran" = 1 ] && [ -f "$STATUS_FILE" ]; then
    jq --arg postiz "$(postiz_state)" --arg postizDetail "$postiz_detail" \
      '.postiz = { state: $postiz, detail: $postizDetail }' "$STATUS_FILE" | save_status
  fi
}

main "$@"
