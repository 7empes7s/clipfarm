#!/usr/bin/env bash
# Dumps Postiz's Postgres into /opt/backups/YYYY-MM-DD/postiz.sql.gz (next to the daily
# mimule-backup) and keeps the 3 newest Postiz dumps. Run by postiz-backup.timer; see RUNBOOK.md.
# Restore: RUNBOOK.md, "Restore from a backup".
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/opt/backups}"
POSTIZ_DIR="${POSTIZ_DIR:-/opt/postiz}"
KEEP="${KEEP:-3}"
day="${BACKUP_DAY:-$(date +%F)}"

dest="$BACKUP_ROOT/$day"
mkdir -p "$dest"
tmp="$(mktemp "$dest/.postiz.sql.gz.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

docker compose --project-directory "$POSTIZ_DIR" exec -T postiz-postgres \
  pg_dump -U postiz -d postiz --clean --if-exists --no-owner | gzip -9 > "$tmp"
gzip -t "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$dest/postiz.sql.gz"
echo "postiz backup: $dest/postiz.sql.gz ($(du -h "$dest/postiz.sql.gz" | cut -f1))"

# Keep the newest $KEEP Postiz dumps; never touch other files in the day folders.
mapfile -t dumps < <(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -path "$BACKUP_ROOT/????-??-??/postiz.sql.gz" | sort -r)
for old in "${dumps[@]:$KEEP}"; do
  rm -f "$old"
  rmdir --ignore-fail-on-non-empty "$(dirname "$old")"
  echo "postiz backup: removed $old"
done
