#!/usr/bin/env bash
# Copies clipfarm's SQLite database into /opt/backups/YYYY-MM-DD/clipfarm.db.gz (next to the daily
# mimule-backup and Postiz's dump) and keeps the 3 newest. Media is not backed up: clips can be
# rendered again. The keys pasted in Settings ($DATA_DIR/secrets.json) are left out on purpose:
# they are pasted again after a restore. Run by clipfarm-backup.timer; see RUNBOOK.md. Restore: RUNBOOK.md, "Restore".
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/opt/backups}"
DATA_DIR="${DATA_DIR:-/var/lib/clipfarm}"
APP_DIR="${CLIPFARM_APP_DIR:-/opt/clipfarm-live/current}"
APP_USER="${CLIPFARM_USER:-clipfarm}"
KEEP="${KEEP:-3}"
day="${BACKUP_DAY:-$(date +%F)}"

dest="$BACKUP_ROOT/$day"
mkdir -p "$dest"
tmp="$(mktemp "$dest/.clipfarm.db.gz.XXXXXX")"
snapshot="$DATA_DIR/.clipfarm-backup.db"
trap 'rm -f "$tmp" "$snapshot"' EXIT

# SQLite's online backup: a consistent copy even while the server is writing (the database is in
# WAL mode). It runs as the app's user, so root never leaves files of its own next to the database.
copy=(node "$APP_DIR/ops/clipfarm/backup-db.ts" "$DATA_DIR/clipfarm.db" "$snapshot")
if [ "$(id -un)" = "$APP_USER" ]; then "${copy[@]}"; else runuser -u "$APP_USER" -- "${copy[@]}"; fi
gzip -9 -c "$snapshot" > "$tmp"
gzip -t "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$dest/clipfarm.db.gz"
echo "clipfarm backup: $dest/clipfarm.db.gz ($(du -h "$dest/clipfarm.db.gz" | cut -f1))"

# Keep the newest $KEEP clipfarm backups; never touch other files in the day folders.
mapfile -t copies < <(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -path "$BACKUP_ROOT/????-??-??/clipfarm.db.gz" | sort -r)
for old in "${copies[@]:$KEEP}"; do
  rm -f "$old"
  rmdir --ignore-fail-on-non-empty "$(dirname "$old")"
  echo "clipfarm backup: removed $old"
done
