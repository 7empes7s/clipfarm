#!/usr/bin/env bash
# Installs Postiz on the box in one go, and is safe to run again at any time:
#   checks the box, writes /opt/postiz/.env with fresh secrets (only what is missing), merges
#   platform keys from a file, installs the unit, the Caddy block and the backup timer, starts
#   Postiz, waits until it answers, checks the API key and hands it to clipfarm.
# It never prints a secret. Run as root (RUNBOOK.md has the one-line card for IT):
#
#   install.sh [--keys-from <file>]... [--keep-source]
#
#   --keys-from <file>  KEY=VALUE lines with platform keys (YOUTUBE_CLIENT_ID, ...). They are merged
#                       into .env and the file is then emptied. Any other key is refused by name.
#   --keep-source       Do not empty the --keys-from files.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

POSTIZ_DIR="${POSTIZ_DIR:-/opt/postiz}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
CLIPFARM_ENV_FILE="${CLIPFARM_ENV_FILE:-/etc/clipfarm/clipfarm.env}"
MEMINFO="${MEMINFO:-/proc/meminfo}"
MIN_RAM_MB="${MIN_RAM_MB:-2500}"
MIN_DISK_MB="${MIN_DISK_MB:-10240}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-600}"
HEALTH_POLL="${HEALTH_POLL:-10}"

SITE_URL=https://postiz.techinsiderbytes.com
SITE_HOST="${SITE_URL#https://}"
ENV_FILE="$POSTIZ_DIR/.env"
SECRET_KEYS=(JWT_SECRET POSTIZ_DB_PASSWORD TEMPORAL_DB_PASSWORD)
PLATFORM_KEYS=(
  YOUTUBE_CLIENT_ID YOUTUBE_CLIENT_SECRET TIKTOK_CLIENT_ID TIKTOK_CLIENT_SECRET
  INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET FACEBOOK_APP_ID FACEBOOK_APP_SECRET X_API_KEY X_API_SECRET
)
CADDY_MARK='# Postiz (written by ops/postiz/install.sh)'

say() { echo "postiz-install: $*"; }
die() { echo "postiz-install: $*" >&2; exit 1; }

# --- .env helpers. Values only pass through bash builtins: never a command line, never the output.

# Prints the value of KEY in FILE (empty when missing), without surrounding single quotes.
get_kv() {
  local key="$1" file="$2" line value=''
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" == "$key="* ]] && value="${line#*=}"
  done < "$file"
  [[ "$value" == "'"*"'" && ${#value} -ge 2 ]] && value="${value:1:${#value}-2}"
  printf '%s' "$value"
}

has_key() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" == "$1="* ]] && return 0
  done < "$2"
  return 1
}

# Sets KEY=VALUE in FILE (replaces the line or adds one), keeping the file's owner and mode.
set_kv() {
  local key="$1" value="$2" file="$3" line found=0 tmp
  tmp="$(mktemp "$file.XXXXXX")"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == "$key="* ]]; then
      [ "$found" = 1 ] || printf '%s=%s\n' "$key" "$value"
      found=1
    else
      printf '%s\n' "$line"
    fi
  done < "$file" > "$tmp"
  [ "$found" = 1 ] || printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod --reference="$file" "$tmp"
  chown --reference="$file" "$tmp" 2>/dev/null || true
  mv "$tmp" "$file"
}

# --- 0. Arguments, and the keys files: read and checked before anything on the box changes.

key_files=()
keep_source=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keys-from)
      [ $# -ge 2 ] || die "--keys-from needs a file"
      key_files+=("$2")
      shift 2
      ;;
    --keys-from=*) key_files+=("${1#*=}"); shift ;;
    --keep-source) keep_source=1; shift ;;
    -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see: $0 --help)" ;;
  esac
done

new_names=()
new_values=()
refused=()
for file in "${key_files[@]}"; do
  [ -f "$file" ] || die "the keys file $file does not exist"
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] \
      || die "line $n of $file is not KEY=VALUE"
    name="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    if [[ " ${PLATFORM_KEYS[*]} " != *" $name "* ]]; then
      refused+=("$name")
      continue
    fi
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    [ -n "$value" ] || continue
    [[ "$value" != *"'"* ]] || die "the value of $name in $file has a ' in it, which .env cannot hold"
    new_names+=("$name")
    new_values+=("$value")
  done < "$file"
done
if [ ${#refused[@]} -gt 0 ]; then
  die "refused, not platform keys: ${refused[*]}. Allowed: ${PLATFORM_KEYS[*]}. Nothing was changed."
fi

# --- 1. Check the box.

[ -w "$SYSTEMD_DIR" ] || die "cannot write to $SYSTEMD_DIR: run it as root"
for tool in docker openssl systemctl curl ss caddy; do
  command -v "$tool" > /dev/null || die "$tool is not installed"
done
docker info > /dev/null 2>&1 || die "docker is not running (systemctl start docker)"
docker compose version > /dev/null 2>&1 || die "docker compose (v2) is not installed"
[ -f "$CADDYFILE" ] || die "no Caddyfile at $CADDYFILE"

port="$(get_kv POSTIZ_PORT "$ENV_FILE")"
[ -n "$port" ] || port="$(get_kv POSTIZ_PORT "$here/.env.example")"

postiz_running() {
  [ -n "$(docker ps -q --filter label=com.docker.compose.project=postiz --filter label=com.docker.compose.service=postiz 2> /dev/null)" ]
}

if ! postiz_running; then
  [ -z "$(ss -Hltn "sport = :$port")" ] \
    || die "port $port is taken by another program (ss -ltnp 'sport = :$port' shows which). Free it, or set POSTIZ_PORT in $ENV_FILE."
  avail_mb=$(($(awk '/^MemAvailable:/ {print $2}' "$MEMINFO") / 1024))
  [ "$avail_mb" -ge "$MIN_RAM_MB" ] \
    || die "only $avail_mb MB of memory is available and Postiz needs $MIN_RAM_MB MB. Nothing was started."
  disk_dir="$POSTIZ_DIR"
  [ -d "$disk_dir" ] || disk_dir="$(dirname "$POSTIZ_DIR")"
  disk_mb="$(df -Pm "$disk_dir" | awk 'NR == 2 {print $4}')"
  [ "$disk_mb" -ge "$MIN_DISK_MB" ] \
    || die "only $disk_mb MB of disk is free under $disk_dir and Postiz needs $MIN_DISK_MB MB. Nothing was started."
fi

# --- 2. Folders and files.

changed=0 # set when Postiz must be restarted to pick up a change

install -d -m 700 "$POSTIZ_DIR"
for dir in config uploads postgres redis temporal-postgres; do
  install -d -m 700 "$POSTIZ_DIR/$dir"
done
if [ -f "$POSTIZ_DIR/docker-compose.yml" ] && ! cmp -s "$here/docker-compose.yml" "$POSTIZ_DIR/docker-compose.yml"; then
  changed=1
fi
install -m 644 "$here/docker-compose.yml" "$POSTIZ_DIR/docker-compose.yml"
install -m 755 "$here/backup.sh" "$POSTIZ_DIR/backup.sh"

# --- 3. .env: created from .env.example when missing; otherwise only missing keys are added.

umask 077
if [ ! -f "$ENV_FILE" ]; then
  install -m 600 "$here/.env.example" "$ENV_FILE"
  say "wrote $ENV_FILE"
fi
chmod 600 "$ENV_FILE"
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
  if ! has_key "${BASH_REMATCH[1]}" "$ENV_FILE"; then
    set_kv "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$ENV_FILE"
    changed=1
  fi
done < "$here/.env.example"
for key in "${SECRET_KEYS[@]}"; do
  if [ -z "$(get_kv "$key" "$ENV_FILE")" ]; then
    set_kv "$key" "$(openssl rand -hex 32)" "$ENV_FILE"
    changed=1
    say "made a new $key"
  fi
done

# --- 4. Platform keys from --keys-from.

for i in "${!new_names[@]}"; do
  value="${new_values[$i]}"
  if [ "$(get_kv "${new_names[$i]}" "$ENV_FILE")" != "$value" ]; then
    # Anything unusual is single-quoted, which docker compose reads as is (no $ expansion).
    [[ "$value" =~ ^[A-Za-z0-9._~+/=:@-]+$ ]] || value="'$value'"
    set_kv "${new_names[$i]}" "$value" "$ENV_FILE"
    changed=1
    say "saved ${new_names[$i]}"
  fi
done
if [ "$keep_source" = 0 ]; then
  for file in "${key_files[@]}"; do
    : > "$file"
    say "emptied $file"
  done
fi

compose() { docker compose --project-directory "$POSTIZ_DIR" "$@"; }
compose config --quiet > /dev/null 2>&1 || die "docker compose does not accept $ENV_FILE with docker-compose.yml (run: cd $POSTIZ_DIR && docker compose config --quiet)"

# --- 5. Units and the Caddy block.

install -m 644 "$here/postiz.service" "$here/postiz-backup.service" "$SYSTEMD_DIR/"
# The timer's time may have been moved on this box (RUNBOOK.md, "Backups"): keep an existing one.
[ -f "$SYSTEMD_DIR/postiz-backup.timer" ] || install -m 644 "$here/postiz-backup.timer" "$SYSTEMD_DIR/"
systemctl daemon-reload

# The Caddyfile without any Postiz block (the 503 placeholder or ours), then ours at the end.
caddy_new="$(mktemp "$CADDYFILE.XXXXXX")"
trap 'rm -f "$caddy_new"' EXIT
awk -v site="http://$SITE_HOST {" -v mark="$CADDY_MARK" '
  skipping { if ($0 ~ /^}/) skipping = 0; next }
  index($0, site) == 1 { skipping = 1; next }
  $0 == mark || /^# Postiz placeholder/ { next }
  /^[[:space:]]*$/ { blanks = blanks $0 "\n"; next }
  { printf "%s%s\n", blanks, $0; blanks = "" }
' "$CADDYFILE" > "$caddy_new"
{
  printf '%s\n' "$CADDY_MARK"
  grep -v '^#' "$here/Caddyfile.postiz" | sed "s/127\.0\.0\.1:5300/127.0.0.1:$port/"
} >> "$caddy_new"
if ! cmp -s "$caddy_new" "$CADDYFILE"; then
  caddy_backup="$CADDYFILE.bak-postiz-$(date +%F-%H%M%S)"
  cp -p "$CADDYFILE" "$caddy_backup"
  cat "$caddy_new" > "$CADDYFILE"
  if ! caddy_says="$(caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1)"; then
    cat "$caddy_backup" > "$CADDYFILE"
    rm -f "$caddy_backup"
    echo "$caddy_says" >&2
    die "Caddy refused the new Postiz block, so the old Caddyfile was put back. Nothing was started."
  fi
  systemctl reload caddy
  say "Caddy now sends $SITE_HOST to 127.0.0.1:$port (old file: $caddy_backup)"
fi

# --- 6. Start (or restart after a change) and wait until Postiz answers.

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2> /dev/null || true; }
answers() { [[ "$(http_code "$@")" =~ ^[23] ]]; }

wait_for_postiz() {
  local waited=0
  until answers "http://127.0.0.1:$port/"; do
    [ "$waited" -lt "$HEALTH_TIMEOUT" ] \
      || die "Postiz did not answer on port $port within $HEALTH_TIMEOUT s. See: cd $POSTIZ_DIR && docker compose ps && docker compose logs --tail 100 postiz"
    sleep "$HEALTH_POLL"
    waited=$((waited + HEALTH_POLL))
  done
}

if systemctl is-active --quiet postiz.service; then
  if [ "$changed" = 1 ]; then
    say "settings changed: restarting Postiz"
    systemctl restart postiz.service
  fi
else
  say "pulling the images and starting Postiz (the first start takes 2-5 minutes)"
  compose pull --quiet > /dev/null 2>&1 || die "could not pull the Postiz images (cd $POSTIZ_DIR && docker compose pull shows why)"
fi
systemctl enable --now postiz.service > /dev/null 2>&1 || die "postiz.service did not start (journalctl -u postiz -n 50)"
wait_for_postiz
systemctl enable --now postiz-backup.timer > /dev/null 2>&1 || die "postiz-backup.timer did not start"

# --- 7. The API key. Postiz makes one per workspace when the first account signs up and keeps it
# in its database (the Authorization header is compared with that column as is). Once an account
# exists: check the key against Postiz, hand it to clipfarm, and close sign-ups.

api_state='not made yet: open the site, sign up (the first account is the admin), then run this again'
api_key="$(compose exec -T postiz-postgres psql -U postiz -d postiz -At \
  -c 'SELECT "apiKey" FROM "Organization" WHERE "deletedAt" IS NULL AND "apiKey" IS NOT NULL ORDER BY "createdAt" LIMIT 1' 2> /dev/null || true)"
api_key="${api_key%%$'\n'*}"
if [ -n "$api_key" ]; then
  [[ "$api_key" =~ ^[A-Za-z0-9._-]+$ ]] || die "Postiz's API key has an unexpected form; it was not handed to clipfarm"

  # check-cli.ts is TypeScript: it needs a node that runs it directly (22.18 or newer).
  node="${POSTIZ_NODE:-}"
  for candidate in /opt/node22/bin/node "$(command -v node || true)"; do
    [ -z "$node" ] || break
    if [ -x "$candidate" ] && "$candidate" -e 'process.exit(process.features.typescript ? 0 : 1)' 2> /dev/null; then
      node="$candidate"
    fi
  done
  [ -n "$node" ] || die "no node 22.18 or newer was found, so the API key could not be checked (set POSTIZ_NODE=/path/to/node)"
  # check-cli.ts reads the key from the environment and prints OK or what is wrong, never the key.
  (cd "$here" && POSTIZ_URL="http://127.0.0.1:$port" POSTIZ_API_KEY="$api_key" "$node" check-cli.ts) \
    || die "Postiz did not accept its own API key (above). It was not handed to clipfarm."
  api_state='works'

  if [ "$(get_kv DISABLE_REGISTRATION "$ENV_FILE")" != true ]; then
    set_kv DISABLE_REGISTRATION true "$ENV_FILE"
    say "an account exists: closing sign-ups and restarting Postiz"
    systemctl restart postiz.service
    wait_for_postiz
  fi

  if [ -f "$CLIPFARM_ENV_FILE" ]; then
    clipfarm_changed=0
    if [ -z "$(get_kv POSTIZ_URL "$CLIPFARM_ENV_FILE")" ]; then
      set_kv POSTIZ_URL "http://127.0.0.1:$port" "$CLIPFARM_ENV_FILE"
      clipfarm_changed=1
    fi
    if [ "$(get_kv POSTIZ_API_KEY "$CLIPFARM_ENV_FILE")" != "$api_key" ]; then
      set_kv POSTIZ_API_KEY "$api_key" "$CLIPFARM_ENV_FILE"
      clipfarm_changed=1
    fi
    if [ "$clipfarm_changed" = 1 ]; then
      systemctl try-restart clipfarm.service
      api_state="works, saved in $CLIPFARM_ENV_FILE (clipfarm restarted)"
    else
      api_state="works, already in $CLIPFARM_ENV_FILE"
    fi
  else
    api_state="works, but $CLIPFARM_ENV_FILE does not exist, so clipfarm did not get it"
  fi
fi

# --- 8. Summary (names only).

keys_set=()
for key in "${PLATFORM_KEYS[@]}"; do
  [ -z "$(get_kv "$key" "$ENV_FILE")" ] || keys_set+=("$key")
done
[ ${#keys_set[@]} -gt 0 ] || keys_set=(none)

echo
echo "Postiz is installed."
for unit in postiz.service postiz-backup.timer; do
  echo "  $unit: $(systemctl is-active "$unit" 2> /dev/null || true)"
done
echo "  http://127.0.0.1:$port/: answers ($(http_code "http://127.0.0.1:$port/"))"
public_code="$(http_code "$SITE_URL/")"
if [[ "$public_code" =~ ^[23] ]]; then
  echo "  $SITE_URL/: answers ($public_code)"
else
  echo "  $SITE_URL/: NOT answering ($public_code)"
fi
echo "  Platform keys set: ${keys_set[*]}"
echo "  API key for clipfarm: $api_state"
echo "  Sign-ups: $([ "$(get_kv DISABLE_REGISTRATION "$ENV_FILE")" = true ] && echo closed || echo "open until the first account exists")"
echo "Next: connect channels in Postiz ($SITE_URL → Add Channel), then clipfarm → Settings → Postiz → Test."

[[ "$public_code" =~ ^[23] ]] \
  || die "Postiz runs, but $SITE_URL does not answer from here: check the 'postiz' hostname of the Cloudflare tunnel (RUNBOOK.md)."
