#!/usr/bin/env bash
# Generate the secret files used by compose.yml. Existing files are kept.
set -euo pipefail
cd "$(dirname "$0")/.."
# The directory is private to the host user (0700). The files themselves are
# world-readable (0644) because Compose bind-mounts them into containers that
# run as unprivileged users; the 0700 directory keeps other host users out.
mkdir -p secrets
chmod 700 secrets
gen() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c 48; }
for name in app_secret db_password worker_secret; do
  if [ ! -s "secrets/$name" ]; then
    gen > "secrets/$name"
    chmod 644 "secrets/$name"
    echo "created secrets/$name"
  else
    echo "kept existing secrets/$name"
  fi
done
