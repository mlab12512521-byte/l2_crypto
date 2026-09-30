#!/usr/bin/env bash
# Back up a TeXCollab Docker Compose deployment while it is running.
#
#   scripts/backup.sh [--dest DIR] [--keep N] [--no-config]
#
# Creates DIR/texcollab-YYYYmmdd-HHMMSS/ (default DIR: ./backups) containing
#   db.dump          PostgreSQL custom-format dump (pg_restore)
#   data.tar.gz      the app data volume: files, Git history, build outputs
#   config.tar.gz    .env and secrets/ (needed to decrypt stored credentials;
#                    omit with --no-config and back them up separately)
#   SHA256SUMS, manifest.txt
# and deletes all but the newest N backups in DIR (default 14).
#
# Order matters: the database is dumped first, then the files. Blobs are only
# garbage-collected 24 h after they stop being referenced, and Git commits are
# written before the database refers to them, so everything the dump refers
# to is guaranteed to be in the file archive.
set -euo pipefail
cd "$(dirname "$0")/.."

dest=./backups keep=14 config=1
while [ $# -gt 0 ]; do
  case $1 in
    --dest) dest=$2; shift 2 ;;
    --keep) keep=$2; shift 2 ;;
    --no-config) config=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

compose() { docker compose "$@"; }
project=$(compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])' 2>/dev/null || echo texcollab)
volume="${project}_appdata"
docker volume inspect "$volume" >/dev/null 2>&1 || { echo "volume $volume not found; is the stack deployed?" >&2; exit 1; }

umask 077
stamp=$(date -u +%Y%m%d-%H%M%S)
out="$dest/texcollab-$stamp"
mkdir -p "$out"
out=$(cd "$out" && pwd)
echo "Backing up to $out"

echo "- database"
compose exec -T db pg_dump -U texcollab -d texcollab --format=custom --compress=6 > "$out/db.dump.partial"
mv "$out/db.dump.partial" "$out/db.dump"

echo "- data volume"
# A throw-away container reads the volume; temporary import files are skipped.
app_image=$(compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["db"]["image"])')
docker run --rm --network none -v "$volume:/data:ro" -v "$out:/backup" "$app_image" \
  sh -c 'tar -C /data --exclude=./tmp -czf /backup/data.tar.gz.partial . && chmod 600 /backup/data.tar.gz.partial'
mv "$out/data.tar.gz.partial" "$out/data.tar.gz"

if [ "$config" = 1 ]; then
  echo "- configuration and secrets"
  tar -czf "$out/config.tar.gz" .env secrets
fi

{
  echo "created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "project: $project"
  echo "git: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "migrations: $(compose exec -T db psql -U texcollab -d texcollab -Atc 'SELECT max(name) FROM schema_migrations' 2>/dev/null || echo unknown)"
} > "$out/manifest.txt"
(cd "$out" && sha256sum -- * > SHA256SUMS)
chmod 600 "$out"/*

echo "- pruning, keeping the newest $keep"
ls -1d "$dest"/texcollab-* 2>/dev/null | sort | head -n "-$keep" | while read -r old; do
  echo "  removing $old"
  rm -rf -- "$old"
done

du -sh "$out" | awk '{print "Done: " $2 " (" $1 ")"}'
