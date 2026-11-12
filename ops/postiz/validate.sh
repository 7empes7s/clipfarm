#!/usr/bin/env bash
# Checks docker-compose.yml without starting anything: fills .env.example's empty secrets with
# placeholders and runs `docker compose config`. Used by CI; safe to run anywhere.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT

sed -E 's/^(JWT_SECRET|POSTIZ_DB_PASSWORD|TEMPORAL_DB_PASSWORD)=$/\1=placeholder/' "$here/.env.example" > "$env_file"
docker compose --env-file "$env_file" -f "$here/docker-compose.yml" config --quiet
echo "docker-compose.yml is valid"
