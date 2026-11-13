#!/usr/bin/env bash
# Keeps yt-dlp on its newest release: Kick and YouTube break old versions often.
# clipfarm-ytdlp-update.timer runs it once a day, as root.
#
# It downloads the newest release (checked against the release's SHA-256 list), keeps the old
# program next to it as yt-dlp.previous, and tests the new one: a short download of a known public
# video, and clipfarm-ops test-keys. If a test that passed with the old program fails with the new
# one, the old program is put back and the manager gets a push notification.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=ops/clipfarm/common.sh
. "$here/common.sh"

RELEASES="${YTDLP_RELEASES_URL:-https://github.com/yt-dlp/yt-dlp/releases}"
# "Me at the zoo": 19 seconds, public since 2005. One ready-made file, so no ffmpeg runs.
PROBE_URL="${YTDLP_PROBE_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"
PROBE_TIMEOUT="${YTDLP_PROBE_TIMEOUT:-120}"

say() { echo "clipfarm yt-dlp update: $*"; }
die() { echo "clipfarm yt-dlp update: $*" >&2; exit 1; }

# The program the service uses: YT_DLP_BIN in its env file.
bin="$(sed -n 's/^YT_DLP_BIN=\(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$ENV_FILE" 2> /dev/null | tail -n 1)"
bin="${bin:-/usr/local/bin/yt-dlp}"
[ -x "$bin" ] || die "$bin is missing (RUNBOOK.md step 2)."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 755 "$work"

# 0 when this yt-dlp downloads the test video, as the app's user.
probe() { # program
  local dir="$work/probe"
  rm -rf "$dir"
  install -d -m 777 "$dir"
  as_app timeout "$PROBE_TIMEOUT" "$1" --quiet --no-warnings --no-playlist --no-cache-dir \
    -f 'worst[ext=mp4]/worst' --max-filesize 20M -o "$dir/probe.%(ext)s" "$PROBE_URL" > /dev/null 2>&1 || return 1
  [ -n "$(find "$dir" -type f -size +0 | head -n 1)" ]
}

current="$("$bin" --version)"
latest="$(curl -fsSL --max-time 30 -o /dev/null -w '%{url_effective}' "$RELEASES/latest")" || die "could not ask GitHub for the newest release."
latest="${latest##*/}"
[[ "$latest" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$ ]] || die "GitHub named an unexpected release: '$latest'."
[ "$latest" != "$current" ] || exit 0

say "installed $current, newest $latest"
curl -fsSL --max-time 300 -o "$work/yt-dlp" "$RELEASES/download/$latest/yt-dlp" || die "could not download yt-dlp $latest."
curl -fsSL --max-time 60 -o "$work/sums" "$RELEASES/download/$latest/SHA2-256SUMS" || die "could not download the checksums of $latest."
want="$(awk '$2 == "yt-dlp" {print $1}' "$work/sums")"
have="$(sha256sum "$work/yt-dlp" | awk '{print $1}')"
if [ -z "$want" ] || [ "$want" != "$have" ]; then die "the download of $latest does not match its checksum; nothing was changed."; fi
chmod 755 "$work/yt-dlp"

# What works now, so only a test the update broke counts.
probe_before=0
probe "$bin" || probe_before=1
keys_before=0
test_keys > /dev/null || keys_before=1

cp -p "$bin" "$bin.previous"
install -m 755 "$work/yt-dlp" "$bin.new"
mv "$bin.new" "$bin"

broke=''
if [ "$("$bin" --version 2> /dev/null)" != "$latest" ]; then
  broke="it does not start"
elif [ "$probe_before" = 0 ] && ! probe "$bin"; then
  broke="it could not download the test video"
elif [ "$keys_before" = 0 ] && ! test_keys > /dev/null; then
  broke="the key test failed with it"
fi

if [ -n "$broke" ]; then
  mv "$bin.previous" "$bin"
  notify 'yt-dlp update rolled back' "yt-dlp $latest was put aside ($broke). $current is in use again."
  die "$latest was put aside: $broke. $current is in use again."
fi
[ "$probe_before" = 0 ] || say "the test video could not be downloaded before the update either, so that test was left out."
say "yt-dlp $latest is in use ($current is kept as $bin.previous)."
