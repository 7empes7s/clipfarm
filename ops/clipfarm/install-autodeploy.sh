#!/usr/bin/env bash
# Sets up auto-deploy on the box. IT runs it once, as root (RUNBOOK.md, "Auto-deploy"); after
# that autodeploy.sh runs it again after every deploy, so scripts and units follow the code and
# nothing is installed by hand. Safe to run at any time: a second run changes nothing.
#
# It installs:
#   /usr/local/lib/clipfarm/ops     a root-owned copy of ops/ (root never runs a file the app's user can change)
#   /usr/local/sbin/clipfarm-{deploy,backup,ops}
#   clipfarm-autodeploy.timer       every 5 minutes: CI-green main goes live (autodeploy.sh)
#   clipfarm-ytdlp-update.timer     once a day: the newest yt-dlp (ytdlp-update.sh)
#   the clipfarm units that are already on the box, when the code changed them
#   /etc/clipfarm/pending-keys/     drop Postiz platform key files here (root only)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$(cd "$here/.." && pwd)"

OPS_LIB="${CLIPFARM_OPS_LIB:-/usr/local/lib/clipfarm/ops}"
SBIN="${CLIPFARM_SBIN:-/usr/local/sbin}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
STATE="${CLIPFARM_AUTODEPLOY_STATE:-/var/lib/clipfarm-autodeploy}"
PENDING_KEYS="${CLIPFARM_PENDING_KEYS:-/etc/clipfarm/pending-keys}"
TOKEN_FILE="${CLIPFARM_GH_TOKEN_FILE:-/etc/keel/gh.env}"
NODE="${CLIPFARM_NODE:-/usr/bin/node}"

say() { echo "clipfarm install-autodeploy: $*"; }
die() { echo "clipfarm install-autodeploy: $*" >&2; exit 1; }

[ -w "$SYSTEMD_DIR" ] || die "cannot write to $SYSTEMD_DIR: run it as root"
for tool in gh jq; do
  command -v "$tool" > /dev/null || apt-get install -y "$tool" > /dev/null || die "$tool is missing and could not be installed"
done
for tool in git curl flock systemctl systemd-run sha256sum; do
  command -v "$tool" > /dev/null || die "$tool is not installed"
done
"$NODE" -e 'process.exit(process.features.typescript ? 0 : 1)' 2> /dev/null \
  || die "$NODE is missing or older than 22.18 (RUNBOOK.md step 2)"
[ -r "$TOKEN_FILE" ] || die "the GitHub token file $TOKEN_FILE is missing: auto-deploy reads the checks of a commit with it"

# --- The root-owned copy of ops/.
if [ "$src" != "$OPS_LIB" ] && ! diff -rq "$src" "$OPS_LIB" > /dev/null 2>&1; then
  install -d -m 755 "$(dirname "$OPS_LIB")"
  rm -rf "$OPS_LIB.new" "$OPS_LIB.old"
  cp -r "$src" "$OPS_LIB.new"
  chmod -R go-w "$OPS_LIB.new"
  [ ! -e "$OPS_LIB" ] || mv "$OPS_LIB" "$OPS_LIB.old"
  mv "$OPS_LIB.new" "$OPS_LIB"
  rm -rf "$OPS_LIB.old"
  say "updated $OPS_LIB"
fi

# --- The commands root runs.
for pair in deploy.sh:clipfarm-deploy backup.sh:clipfarm-backup ops.sh:clipfarm-ops; do
  from="$here/${pair%%:*}"
  to="$SBIN/${pair##*:}"
  if ! cmp -s "$from" "$to"; then
    install -m 755 "$from" "$to"
    say "updated $to"
  fi
done

# --- Units. A unit that is already on the box keeps the node path IT gave it (RUNBOOK.md step 2).
units_changed=0
restart_clipfarm=0
install_unit() { # file name
  local to="$SYSTEMD_DIR/$1" new node_path=''
  new="$(mktemp "$to.XXXXXX")"
  [ ! -f "$to" ] || node_path="$(sed -n 's/^ExecStart=\([^ ]*\/node\) .*/\1/p' "$to" | head -n 1)"
  if [ -n "$node_path" ]; then
    sed "s#^ExecStart=/usr/bin/node #ExecStart=$node_path #" "$here/$1" > "$new"
  else
    cat "$here/$1" > "$new"
  fi
  if cmp -s "$new" "$to"; then
    rm -f "$new"
    return 0
  fi
  chmod 644 "$new"
  mv "$new" "$to"
  units_changed=1
  [ "$1" != clipfarm.service ] || restart_clipfarm=1
  say "updated $to"
}
for unit in clipfarm-autodeploy.service clipfarm-autodeploy.timer clipfarm-ytdlp-update.service clipfarm-ytdlp-update.timer; do
  install_unit "$unit"
done
# The timers of the backup and the cleanup are left alone: their time may have been moved on this box.
for unit in clipfarm.service clipfarm-backup.service clipfarm-media-cleanup.service; do
  [ ! -f "$SYSTEMD_DIR/$unit" ] || install_unit "$unit"
done
[ "$units_changed" = 0 ] || systemctl daemon-reload

install -d -m 700 "$PENDING_KEYS" "$STATE"
systemctl enable --now clipfarm-autodeploy.timer clipfarm-ytdlp-update.timer > /dev/null 2>&1 \
  || die "the timers did not start (systemctl status clipfarm-autodeploy.timer)"
if [ "$restart_clipfarm" = 1 ]; then
  systemctl try-restart clipfarm.service
  say "restarted clipfarm on its new unit"
fi
say "auto-deploy is on: CI-green main goes live within 10 minutes, yt-dlp updates once a day."
