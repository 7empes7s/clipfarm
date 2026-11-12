#!/usr/bin/env bash
# Deploys clipfarm on the live box. Run as root; see RUNBOOK.md ("First deploy", "Update", "Roll back").
#
#   deploy.sh [commit]     build that commit (default origin/main) into a fresh folder under
#                          releases/, point "current" at it, restart, check /api/health.
#                          If the check fails, "current" goes back to the release that was live.
#   deploy.sh --rollback   switch to the other kept release without building.
#
# The last 2 releases are kept. Layout under /opt/clipfarm-live:
#   repo/                 git clone, only read (git archive)
#   releases/<UTC time>-<commit>/
#   current -> releases/<the live one>
set -euo pipefail

ROOT="${CLIPFARM_ROOT:-/opt/clipfarm-live}"
REPO="$ROOT/repo"
RELEASES="$ROOT/releases"
SERVICE="${CLIPFARM_SERVICE:-clipfarm}"
APP_USER="${CLIPFARM_USER:-clipfarm}"
ENV_FILE="${CLIPFARM_ENV_FILE:-/etc/clipfarm/clipfarm.env}"
HEALTH_TRIES="${CLIPFARM_HEALTH_TRIES:-30}"
HEALTH_WAIT="${CLIPFARM_HEALTH_WAIT:-2}"

say() { echo "clipfarm deploy: $*"; }
die() { echo "clipfarm deploy: $*" >&2; exit 1; }

# git and npm run as the app's user, never as root: package install scripts get no root rights.
# HOME is the deploy folder, so they find a home they can read (and npm keeps its cache there).
as_app() {
  if [ "$(id -un)" = "$APP_USER" ]; then
    "$@"
  else
    runuser -u "$APP_USER" -- env HOME="$ROOT" "$@"
  fi
}

# The port the service listens on: PORT in the env file the unit reads.
port="$(sed -n 's/^PORT=\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$ENV_FILE" 2>/dev/null | tail -n 1)"
HEALTH_URL="http://127.0.0.1:${port:-5310}/api/health"

live_release() { # name of the release "current" points at, or nothing
  [ -L "$ROOT/current" ] && basename "$(readlink "$ROOT/current")" || true
}

point_current_at() { # atomic: the link is replaced in one rename
  ln -s "releases/$1" "$ROOT/current.new"
  mv -T "$ROOT/current.new" "$ROOT/current"
}

healthy() {
  local try
  for try in $(seq "$HEALTH_TRIES"); do
    if curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    [ "$try" = "$HEALTH_TRIES" ] || sleep "$HEALTH_WAIT"
  done
  return 1
}

# Restart on release $1 and check it. When it does not answer, go back to release $2 (may be empty).
go_live() {
  local new="$1" previous="$2"
  point_current_at "$new"
  systemctl restart "$SERVICE"
  if healthy; then return 0; fi

  echo "clipfarm deploy: $new did not answer at $HEALTH_URL. Its log: journalctl -u $SERVICE -n 50" >&2
  if [ -n "$previous" ]; then
    point_current_at "$previous"
    systemctl restart "$SERVICE"
    if healthy; then
      echo "clipfarm deploy: went back to $previous, which is live and healthy again." >&2
    else
      echo "clipfarm deploy: went back to $previous, but it does not answer either. Check: systemctl status $SERVICE" >&2
    fi
  else
    rm -f "$ROOT/current"
    systemctl stop "$SERVICE"
    echo "clipfarm deploy: there is no earlier release to go back to, so $SERVICE is stopped." >&2
  fi
  return 1
}

[ "$#" -le 1 ] || die "Usage: deploy.sh [commit] | deploy.sh --rollback"
[ -d "$REPO" ] || die "$REPO is missing. Do RUNBOOK.md step 3 first."
previous="$(live_release)"

if [ "${1:-}" = "--rollback" ]; then
  target=""
  for dir in "$RELEASES"/*/; do
    name="$(basename "$dir")"
    [ "$name" = "$previous" ] || target="$name"
  done
  [ -n "$target" ] && [ -d "$RELEASES/$target" ] || die "there is no other release to switch to."
  say "switching from ${previous:-nothing} to $target"
  go_live "$target" "$previous" || exit 1
  say "$target is live. The release it replaced is kept: run --rollback again to return to it."
  exit 0
fi

ref="${1:-origin/main}"
[[ "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "'$ref' is not a commit. Usage: deploy.sh [commit] | deploy.sh --rollback"
if [ -n "$(as_app git -C "$REPO" remote)" ]; then
  as_app git -C "$REPO" fetch --quiet --prune origin
fi
sha="$(as_app git -C "$REPO" rev-parse --verify --quiet --end-of-options "$ref^{commit}")" || die "'$ref' is not a commit in $REPO."

new="$(date -u +%Y%m%d-%H%M%S)-${sha:0:12}"
release="$RELEASES/$new"
[ ! -e "$release" ] || die "$release already exists."
as_app mkdir -p "$release"
built=""
trap '[ -n "$built" ] || rm -rf "$release"' EXIT

say "building $sha in $release"
as_app git -C "$REPO" archive "$sha" | as_app tar -x -C "$release"
(
  cd "$release"
  export npm_config_update_notifier=false
  as_app npm ci             # with dev packages: the build needs TypeScript and Vite
  as_app npm run build
  as_app npm ci --omit=dev  # then only what the server needs at run time
)
[ -f "$release/dist/server/index.js" ] && [ -f "$release/dist/client/index.html" ] || die "the build left no dist/server/index.js or dist/client/index.html."

if ! go_live "$new" "$previous"; then
  exit 1 # the trap removes the failed release
fi
built=1

# Keep the live release and the one before it.
for dir in "$RELEASES"/*/; do
  name="$(basename "$dir")"
  if [ "$name" != "$new" ] && [ "$name" != "$previous" ]; then
    rm -rf "${dir%/}"
    say "removed old release $name"
  fi
done
say "$new is live and healthy at $HEALTH_URL."
