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
| 3 | Editor | ✅ done |
| 4 | Sandboxed LaTeX compilation, PDF viewer | ✅ done |
| 5 | Real-time collaboration | ✅ done |
| 6 | Sharing and permissions | planned |
| 7 | Git history, automatic versions, external remotes | planned |
| 8 | LDAP | planned |
| 9 | Hardening | planned |
| 10 | Production deployment | planned |

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

```sh
cp .env.example .env            # set PUBLIC_URL, the initial admin, DOCKER_GID
scripts/init-secrets.sh         # generates ./secrets/*
docker compose --profile build build texlive   # TeX Live sandbox image (large, ~9 GB)
docker compose up -d --build
```

Open `PUBLIC_URL` (by default the app listens on `127.0.0.1:3000`), sign in
with the initial admin, and choose a new password when prompted.

## Documentation

- [Architecture and implementation plan](docs/architecture.md)
- [Local development](docs/development.md)
- [Configuration reference](docs/configuration.md)
- [Security model and threat model](docs/security-model.md)
- [LaTeX compilation](docs/compilation.md)
- [Editor features](docs/editor.md)
- [Real-time collaboration](docs/collaboration.md)
- [Technical debt log](docs/tech-debt.md)
