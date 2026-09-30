# Operations guide

Deploying, backing up, upgrading and monitoring TeXCollab with Docker
Compose. Configuration reference: [configuration.md](configuration.md).
Security background: [security-model.md](security-model.md).

## 1. Sizing

For about 30 users (a handful compiling at the same time):

| Resource | Recommendation |
|---|---|
| CPU | 4 cores (compilations are the main load; each may use up to `COMPILE_MAX_CPUS`) |
| RAM | 8 GB (app ~300–600 MB, PostgreSQL ~200 MB, each running compilation up to its memory limit) |
| Disk | 30 GB for images (TeX Live ≈ 9 GB) + project data + backups; SSD recommended |
| OS | Any Linux with Docker Engine and Compose v2 |

To scale up, raise `COMPILE_MAX_CONCURRENCY` (and CPUs), or run more
compile workers (list them in `COMPILE_WORKERS`).

## 2. Production deployment

TeXCollab runs behind **Caddy**, which terminates TLS, redirects HTTP to
HTTPS, limits request sizes, and proxies WebSockets. The app itself is then
only reachable through Caddy.

```sh
git clone … && cd texcollab
cp .env.example .env
scripts/init-secrets.sh
docker compose --profile build build texlive     # once, ~9 GB
```

Edit `.env`:

```sh
COMPOSE_FILE=compose.yml:compose.prod.yml         # every docker compose command uses the proxy overlay
PUBLIC_URL=https://latex.example.org              # exactly what users type
TEXCOLLAB_DOMAIN=latex.example.org
TRUST_PROXY_HOPS=1
DOCKER_GID=…                                      # stat -c %g /var/run/docker.sock
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=…                          # remove after the first start
```

Choose how Caddy gets a certificate with `TEXCOLLAB_TLS`:

| Situation | `TEXCOLLAB_TLS` |
|---|---|
| Public DNS name, ports 80 and 443 reachable from the internet | *(empty)* — automatic Let's Encrypt; or `tls you@example.org` to register a contact address |
| Internal network, you have certificates from your organisation's CA | `tls /certs/cert.pem /certs/key.pem`, with the files in `deploy/certs/` (full chain in `cert.pem`) |
| Internal network, no CA | `tls internal` — Caddy's own CA; install its root certificate (`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`) on client machines |

Start:

```sh
docker compose up -d --build
docker compose ps          # all services "healthy"
```

Open `https://latex.example.org`, sign in as the initial admin, and change
the password. Then remove `INITIAL_ADMIN_*` from `.env`. Alternatively
create administrators with the CLI:
`docker compose exec app node server/dist/cli.js create-admin <username>`
(password on stdin).

**Firewall:** only 80 and 443 need to be reachable (80 for redirects and
Let's Encrypt). Everything else stays on internal Docker networks.

### Trying it out without a domain

Without `compose.prod.yml` the app listens on plain HTTP at
`127.0.0.1:3000` (`PUBLIC_URL=http://localhost:3000`, `TRUST_PROXY_HOPS=0`).
For a quick test from other machines on a trusted LAN, set
`APP_BIND=0.0.0.0` and `PUBLIC_URL=http://<server>:3000`. Passwords then
travel unencrypted; do not use this for real work.

### Common problems

| Symptom | Cause |
|---|---|
| "Cross-origin request rejected. This site is configured for …" | `PUBLIC_URL` differs from the address in the browser (scheme, host or port). Fix `.env`, then `docker compose up -d` (a plain `restart` does not re-read `.env`). |
| Signed in, but immediately signed out again | `PUBLIC_URL` is `https://…` while the site is served over plain `http` (the browser drops the secure cookie). |
| "permission denied … docker.sock" from the worker, or compilation unavailable | Wrong `DOCKER_GID`. |
| Every compilation fails with a system error | Check `docker compose logs compile-worker`; most often the TeX Live image was not built (`docker compose --profile build build texlive`) or `COMPILE_IMAGE` names a missing image. |
| Real-time editing does not connect | A proxy in front of Caddy does not pass WebSockets (`/collab`). |

## 3. Backups

`scripts/backup.sh` backs up a running deployment without downtime:

```sh
scripts/backup.sh                      # → backups/texcollab-YYYYmmdd-HHMMSS/
scripts/backup.sh --dest /mnt/backup --keep 30
```

Each backup holds `db.dump` (PostgreSQL), `data.tar.gz` (files, Git
history, recent PDFs), `config.tar.gz` (`.env` and `secrets/`), checksums and
a manifest. The database is dumped before the files, which keeps the pair
consistent (see the comment in the script). The files are readable only by
the user running the script.

**Protect backups like the server itself:** `config.tar.gz` contains
`APP_SECRET`, which decrypts stored LDAP and Git credentials. Use
`--no-config` if you back up `.env` and `secrets/` separately.

Run it daily, for example with cron (as a user in the `docker` group):

```cron
15 2 * * *  cd /opt/texcollab && scripts/backup.sh --dest /srv/backups/texcollab >> /var/log/texcollab-backup.log 2>&1
```

…and copy the backup directory off the server (e.g. `rsync`, restic, borg).

## 4. Restore and disaster recovery

```sh
scripts/restore.sh backups/texcollab-20260930-104305 --yes
```

This verifies the checksums, stops the app and worker, recreates the
database from the dump, replaces all files, and starts everything again.
**Current data is replaced.**

On a **new server**: install Docker, check out the same TeXCollab version
(see `manifest.txt`), copy the backup, build the images, then:

```sh
scripts/restore.sh /path/to/backup --yes --with-config
```

`--with-config` restores `.env` and `secrets/` from the backup (without
them, stored LDAP/Git credentials cannot be decrypted, and you must re-enter
them). Update `PUBLIC_URL`/DNS if the address changed.

The procedure was tested by deleting every Docker volume and restoring:
database content, files (including ownership), sign-in, full version
history and compilation were all back.

Test your restores regularly, for example into a scratch VM.

## 5. Upgrades

```sh
scripts/backup.sh                         # always first
git pull                                  # or check out a release tag
docker compose build                      # app and worker images
docker compose up -d                      # migrations run automatically at start
docker compose ps && docker compose logs app | tail
```

* Database migrations are applied at startup (serialised with a lock) and
  are forward-only. **Rollback = restore the backup taken before the
  upgrade**, then check out the previous version.
* Rebuild the TeX Live image when you want a newer TeX distribution (yearly
  release, package updates): `docker compose --profile build build --pull texlive`.
  Compile a few real projects afterwards; new package versions occasionally
  change output.
* Update base images (PostgreSQL minor versions, Caddy, Node) by rebuilding
  / `docker compose pull` regularly. A PostgreSQL **major** upgrade (16 → 17)
  needs dump and restore: take a backup, change the image, remove the
  `pgdata` volume, start, and `scripts/restore.sh`.

## 6. Monitoring

### Health checks

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | The app process is alive (used by the container health check) |
| `GET /readyz` | The app can reach the database |
| *Admin → System status* / *Compilation & limits* | Database, memory, sessions and collaboration; compile worker health and queues |

Point an external uptime monitor at `https://<domain>/readyz`.

### Metrics

The app serves Prometheus metrics on port `9464` (`METRICS_PORT`) on the
internal network only: HTTP requests by route and status, request latency,
compilations by result and duration, compile worker health and queue,
collaboration connections, database pool usage, user and project counts,
and Node.js process metrics.

The optional overlay `compose.monitoring.yml` runs Prometheus with alert
rules (`deploy/alerts.yml`): app down, compile worker down, compile backlog,
compilations failing for system reasons, server error rate, database pool
saturation, memory. Enable it with

```sh
COMPOSE_FILE=compose.yml:compose.prod.yml:compose.monitoring.yml
```

The Prometheus UI listens on `127.0.0.1:9090` on the server
(`ssh -L 9090:127.0.0.1:9090 server`). To receive notifications, add an
Alertmanager (see the comment in `deploy/prometheus.yml`). For host metrics
(disk space!), add node_exporter or use your existing host monitoring.
Watch the free space on the Docker data directory in particular.

## 7. Logs

All services log to stdout in JSON (`docker compose logs -f app`). The
compose files rotate container logs (5 × 20 MB per service). The admin UI
shows recent application logs (*Admin → Application logs*) and the audit
log (sign-ins, sharing, administrative changes). Passwords, tokens, cookies
and CSRF headers are redacted from logs.

To ship logs elsewhere, change the Docker logging driver (e.g. `journald`,
`syslog`, `fluentd`) in the compose files.

## 8. Security checklist

* [ ] `PUBLIC_URL` is `https://…`; the app is not published directly (`compose.prod.yml`).
* [ ] `INITIAL_ADMIN_*` removed from `.env` after the first start.
* [ ] Self-registration is off (*Admin → Settings*) unless you want it.
* [ ] LDAP uses LDAPS or StartTLS (enforced unless explicitly overridden).
* [ ] Backups run daily, are copied off the server, and a restore was tested.
* [ ] Host: automatic security updates, SSH keys only, firewall with only 80/443 open.
* [ ] Optional stronger sandbox: install gVisor and set `COMPILE_DOCKER_RUNTIME=runsc`
      ([compilation.md](compilation.md)).
* [ ] The compile worker has access to the Docker daemon (needed to start
      sandboxes). Do not run other untrusted workloads on the same host.
