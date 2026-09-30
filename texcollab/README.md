# TeXCollab

A self-hosted, collaborative, browser-based LaTeX editor for small
organisations: real-time co-editing, server-side sandboxed compilation, PDF
preview, project history backed by Git, and local or LDAP accounts.

> **Status:** under active development, built in phases (see
> [docs/architecture.md §14](docs/architecture.md#14-implementation-phases)).
> Completed phases are listed below.

| Phase | Scope | State |
|---|---|---|
| 1 | Foundation: server, SPA shell, PostgreSQL, local auth, admin user management, containers | ✅ done |
| 2 | Projects, file tree, uploads, ZIP import/export | ✅ done |
| 3 | Editor | planned |
| 4 | Sandboxed LaTeX compilation, PDF viewer | planned |
| 5 | Real-time collaboration | planned |
| 6 | Sharing and permissions | planned |
| 7 | Git history, automatic versions, external remotes | planned |
| 8 | LDAP | planned |
| 9 | Hardening | planned |
| 10 | Production deployment | planned |

## Repository layout

```
apps/server      Node.js/TypeScript API (Fastify) — later also the collaboration hub
apps/web         React SPA (Vite)
packages/shared  Types and validation shared by server and SPA
docs/            Architecture, development and operations documentation
scripts/         Operational helper scripts
Dockerfile       Application image (API + SPA)
compose.yml      Docker Compose deployment
compose.dev.yml  PostgreSQL for local development
```

## Quick start (Docker Compose)

```sh
cp .env.example .env            # set PUBLIC_URL and the initial admin
scripts/init-secrets.sh         # generates ./secrets/*
docker compose up -d --build
```

Open `PUBLIC_URL` (by default the app listens on `127.0.0.1:3000`), sign in
with the initial admin, and choose a new password when prompted.

## Documentation

- [Architecture and implementation plan](docs/architecture.md)
- [Local development](docs/development.md)
- [Configuration reference](docs/configuration.md)
- [Technical debt log](docs/tech-debt.md)
