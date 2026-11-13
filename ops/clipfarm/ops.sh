#!/usr/bin/env bash
# clipfarm-ops: runs clipfarm on the live box without a browser: test the keys, add a source, turn
# a video into clips, list clips, show the queue. Installed as /usr/local/sbin/clipfarm-ops
# (RUNBOOK.md, "IT ops"). It works on the same database and keys as the service, so it runs as
# the service's user with the service's settings:
#
#   systemd-run --uid=clipfarm --gid=clipfarm --pipe --wait --collect --quiet \
#     -p EnvironmentFile=/etc/clipfarm/clipfarm.env -p MemoryMax=3072M -p UMask=0027 -p PrivateTmp=true \
#     /usr/local/sbin/clipfarm-ops <command>
#
# Commands: clipfarm-ops help
set -euo pipefail

ROOT="${CLIPFARM_ROOT:-/opt/clipfarm-live}"
APP_USER="${CLIPFARM_USER:-clipfarm}"
ENV_FILE="${CLIPFARM_ENV_FILE:-/etc/clipfarm/clipfarm.env}"
NODE="${CLIPFARM_NODE:-/usr/bin/node}"
HOW="systemd-run --uid=$APP_USER --gid=$APP_USER --pipe --wait --collect --quiet -p EnvironmentFile=$ENV_FILE -p MemoryMax=3072M -p UMask=0027 -p PrivateTmp=true $0 $*"

die() { echo "clipfarm-ops: $*" >&2; exit 2; }

# As another user (root included) it would leave files in the data folder the service cannot read.
[ "$(id -un)" = "$APP_USER" ] || die "run it as the $APP_USER user: $HOW"
# Without the service's settings it would work on an empty database of its own.
[ -n "${DATA_DIR:-}" ] || die "DATA_DIR is not set, so the service's settings are missing. Run: $HOW"
[ -f "$ROOT/current/dist/server/ops/cli.js" ] || die "the live release at $ROOT/current has no clipfarm-ops yet. Update first: clipfarm-deploy origin/main"

cd "$ROOT/current"
exec "$NODE" dist/server/ops/cli.js "$@"
