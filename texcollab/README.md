# TeXCollab

A self-hosted, collaborative, browser-based LaTeX editor for small
organisations: real-time co-editing, server-side sandboxed compilation, PDF
preview, project history backed by Git, and local or LDAP accounts.

> **Status:** all planned phases are implemented (see
> [docs/architecture.md §14](docs/architecture.md#14-implementation-phases)).
> Known limitations are listed in the [technical debt log](docs/tech-debt.md).

| Phase | Scope | State |
|---|---|---|
| 1 | Foundation: server, SPA shell, PostgreSQL, local auth, admin user management, containers | ✅ done |
| 2 | Projects, file tree, uploads, ZIP import/export | ✅ done |
| 3 | Editor | ✅ done |
| 4 | Sandboxed LaTeX compilation, PDF viewer | ✅ done |
| 5 | Real-time collaboration | ✅ done |
| 6 | Sharing and permissions | ✅ done |
| 7 | Git history, automatic versions, external remotes | ✅ done |
| 8 | LDAP | ✅ done |
| 9 | Hardening | ✅ done |
| 10 | Production deployment | ✅ done |

## Repository layout

```
apps/server          Node.js/TypeScript API (Fastify) and the collaboration hub (Hocuspocus/Yjs)
apps/web             React SPA (Vite)
apps/compile-worker  Runs each compilation in an isolated Docker container
docker/texlive       The TeX Live sandbox image
packages/shared  Types and validation shared by server and SPA
docs/            Architecture, development and operations documentation
scripts/         Operational helper scripts
Dockerfile       Application image (API + SPA)
compose.yml      Docker Compose deployment
compose.dev.yml  PostgreSQL for local development
```

## Quick start (Docker Compose)

Local trial on one machine (plain HTTP on `http://localhost:3000`):

```sh
cp .env.example .env            # set PUBLIC_URL=http://localhost:3000, TRUST_PROXY_HOPS=0,
                                # DOCKER_GID and the initial admin
scripts/init-secrets.sh         # generates ./secrets/*
docker compose --profile build build texlive   # TeX Live sandbox image (large, ~9 GB)
docker compose up -d --build
```

Open `PUBLIC_URL` — it must be exactly the address in the browser — sign
in with the initial admin, and choose a new password when prompted.

For production (HTTPS via Caddy, backups, upgrades, monitoring) follow the
[operations guide](docs/operations.md).

## Documentation

- [Architecture and implementation plan](docs/architecture.md)
- [Local development](docs/development.md)
- [Configuration reference](docs/configuration.md)
- [Security model and threat model](docs/security-model.md)
- [LaTeX compilation](docs/compilation.md)
- [Editor features](docs/editor.md)
- [Real-time collaboration](docs/collaboration.md)
- [Sharing and permissions](docs/sharing.md)
- [History, versions and Git](docs/git-integration.md)
- [Directory sign-in (LDAP)](docs/ldap.md)
- [Operations: deployment, backups, upgrades, monitoring](docs/operations.md)
- [Technical debt log](docs/tech-debt.md)
