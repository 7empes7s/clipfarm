#!/usr/bin/env bash
# Shared by autodeploy.sh and ytdlp-update.sh (sourced, never run): where things live on the box,
# and how root runs clipfarm-ops and sends a notification to the manager's phone.

ROOT="${CLIPFARM_ROOT:-/opt/clipfarm-live}"
APP_USER="${CLIPFARM_USER:-clipfarm}"
ENV_FILE="${CLIPFARM_ENV_FILE:-/etc/clipfarm/clipfarm.env}"
OPS_CLI="${CLIPFARM_OPS_CLI:-/usr/local/sbin/clipfarm-ops}"

# As the app's user, never as root (the same as deploy.sh).
as_app() {
  if [ "$(id -un)" = "$APP_USER" ]; then
    "$@"
  else
    runuser -u "$APP_USER" -- env HOME="$ROOT" "$@"
  fi
}

# clipfarm-ops as the service's user with the service's settings (RUNBOOK.md, "IT ops").
ops_cli() {
  systemd-run --uid="$APP_USER" --gid="$APP_USER" --pipe --wait --collect --quiet \
    -p EnvironmentFile="$ENV_FILE" -p MemoryMax=3072M -p UMask=0027 -p PrivateTmp=true \
    "$OPS_CLI" "$@"
}

# A push notification through the app (title, text). A missed one never stops the work.
notify() {
  ops_cli notify "$1" "$2" > /dev/null 2>&1 || echo "clipfarm: the notification \"$1\" could not be sent." >&2
}

# 0 when test-keys passes. Prints its lines (names and Working / Failed / Not set, never a key).
test_keys() {
  ops_cli test-keys 2>&1
}
