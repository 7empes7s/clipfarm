#!/usr/bin/env bash
# The one-command go-live (RUNBOOK.md, "Go live"). IT runs it as root, as one systemd-run card;
# safe to run again at any time. It installs or refreshes auto-deploy, deploys CI-green main,
# hands Postiz's API key and the waiting keys to clipfarm, then runs clipfarm-ops golive: posting
# accounts, test-keys, the proof and the drill, the TJR clips, one PRIVATE upload to Leonida Daily.
# It never posts in public and never prints a key. Exit code 1 with a plain list while anything is
# missing.
#
#   golive.sh [--campaign <TJR Whop link>] [--channel "Leonida Daily"] [--drill-minutes 15] [--url-wait 10]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
NODE="${CLIPFARM_NODE:-/usr/bin/node}"

die() { echo "clipfarm golive: $*" >&2; exit 2; }

[ "$(id -u)" = 0 ] || die "run it as root (RUNBOOK.md, \"Go live\", has the line)"
"$NODE" -e 'process.exit(process.features.typescript ? 0 : 1)' 2> /dev/null \
  || die "$NODE is missing or older than 22.18 (RUNBOOK.md step 2)"

exec "$NODE" "$here/golive-cli.ts" "$@"
