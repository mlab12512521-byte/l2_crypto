#!/usr/bin/env bash
# Build an image inside a network-restricted environment that only allows
# outbound HTTPS through an intercepting proxy (e.g. CI sandboxes).
# Not needed on normal hosts: use `docker build` / `docker compose build` directly.
#
# Usage: scripts/sandbox-docker-build.sh <dockerfile> <tag> [context]
# Requires HTTPS_PROXY and SANDBOX_CA_BUNDLE (PEM file) in the environment.
set -euo pipefail
dockerfile=$1 tag=$2 context=${3:-.}
: "${HTTPS_PROXY:?HTTPS_PROXY must be set}"
: "${SANDBOX_CA_BUNDLE:?SANDBOX_CA_BUNDLE must point to the proxy CA bundle}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; rm -f "$context/.sandbox-ca.crt"' EXIT
cp "$SANDBOX_CA_BUNDLE" "$context/.sandbox-ca.crt"
# After every FROM that is followed by apt usage, trust the proxy CA and route apt over HTTPS via the proxy.
python3 - "$dockerfile" "$tmp/Dockerfile" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
inject = r'''ARG HTTPS_PROXY
COPY .sandbox-ca.crt /usr/local/share/ca-certificates/sandbox-ca.crt
COPY .sandbox-ca.crt /etc/ssl/certs/ca-certificates.crt
RUN for f in /etc/apt/sources.list.d/*.sources /etc/apt/sources.list; do [ -f "$f" ] && sed -i 's#http://#https://#g' "$f"; done; \
    printf 'Acquire::https::Proxy "%s";\n' "$HTTPS_PROXY" > /etc/apt/apt.conf.d/99proxy || true
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/sandbox-ca.crt
'''
out = []
for line in open(src):
    out.append(line)
    if re.match(r'^FROM\s+\S+\s+AS\s+(runtime|worker|texlive)\b', line, re.I):
        out.append(inject)
open(dst, 'w').write(''.join(out))
PY
docker build --network host --build-arg "HTTPS_PROXY=$HTTPS_PROXY" -f "$tmp/Dockerfile" -t "$tag" "$context"
