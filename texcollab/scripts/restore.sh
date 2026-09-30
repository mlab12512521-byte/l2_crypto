#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh. DESTROYS the current data.
#
#   scripts/restore.sh BACKUP_DIR --yes [--with-config]
#
#   --with-config   also restore .env and secrets/ from the backup (moving to a
#                   new server). Without it the current .env/secrets are kept;
#                   APP_SECRET must then be the one the backup was made with,
#                   or stored LDAP/Git credentials cannot be decrypted.
#
# Steps: verify checksums, stop app and worker, recreate the database from
# the dump, replace the data volume, start everything again.
set -euo pipefail
cd "$(dirname "$0")/.."

src=${1:-} ; shift || true
yes=0 config=0
while [ $# -gt 0 ]; do
  case $1 in
    --yes) yes=1; shift ;;
    --with-config) config=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$src" ] && [ -f "$src/db.dump" ] && [ -f "$src/data.tar.gz" ] || { echo "usage: $0 BACKUP_DIR --yes [--with-config]" >&2; exit 2; }
src=$(cd "$src" && pwd)
[ "$yes" = 1 ] || { echo "This replaces ALL current TeXCollab data with $src. Re-run with --yes to continue." >&2; exit 2; }

echo "Verifying checksums"
(cd "$src" && sha256sum --quiet -c SHA256SUMS)

compose() { docker compose "$@"; }

if [ "$config" = 1 ]; then
  [ -f "$src/config.tar.gz" ] || { echo "backup has no config.tar.gz" >&2; exit 1; }
  echo "Restoring .env and secrets/"
  tar -xzf "$src/config.tar.gz"
  chmod 700 secrets && chmod 644 secrets/*
fi

project=$(compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
volume="${project}_appdata"
db_image=$(compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["db"]["image"])')

echo "Stopping the application"
compose stop app compile-worker caddy 2>/dev/null || compose stop app compile-worker
compose up -d --wait db

echo "Restoring the database"
psql_admin() { compose exec -T db psql -U texcollab -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_admin -c 'DROP DATABASE IF EXISTS texcollab WITH (FORCE)' -c 'CREATE DATABASE texcollab OWNER texcollab'
compose exec -T db pg_restore -U texcollab -d texcollab --no-owner --exit-on-error < "$src/db.dump"
# The cluster may have been initialised with another password (new server, or
# secrets restored above): make it match the secret the app will use.
{ printf '\\set pw %s\n' "$(cat secrets/db_password)"; echo "ALTER USER texcollab PASSWORD :'pw';"; } | psql_admin

echo "Restoring files"
docker volume create "$volume" >/dev/null
docker run --rm --network none -v "$volume:/data" -v "$src:/backup:ro" "$db_image" \
  sh -c 'find /data -mindepth 1 -delete && tar -xzf /backup/data.tar.gz -C /data'

echo "Starting"
compose up -d
echo "Restore finished. Sessions from before the backup are still valid; ask users to sign in again if in doubt."
