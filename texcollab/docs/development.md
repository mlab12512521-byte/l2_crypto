# Local development

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- Docker with Compose v2 (for PostgreSQL and, later, the compile sandbox)

## First-time setup

```sh
npm ci                                   # installs all workspaces
docker compose -f compose.dev.yml up -d  # PostgreSQL on 127.0.0.1:5432
npm run build -w packages/shared         # the server consumes the compiled shared package
```

## Running

Two terminals:

```sh
# 1. API server on :3000 (auto-reloads)
cd apps/server
PUBLIC_URL=http://localhost:5173 \
DATABASE_URL=postgres://texcollab:texcollab@127.0.0.1:5432/texcollab \
APP_SECRET=dev-secret-dev-secret-dev-secret-dev \
DATA_DIR=../../.dev-data \
INITIAL_ADMIN_USERNAME=admin INITIAL_ADMIN_PASSWORD=admin-password-123 \
LOG_LEVEL=debug \
npm run dev

# 2. SPA on :5173 with hot reload; proxies /api and /collab to :3000
npm run dev:web
```

Open <http://localhost:5173>. `PUBLIC_URL` must be the URL in the browser's
address bar (the Vite port during development), otherwise CSRF Origin checks
reject state-changing requests.

Migrations run automatically on server start. To run them explicitly:
`npm run migrate -w apps/server` (same environment variables).

## Tests

```sh
npm test                 # all workspaces
npm test -w apps/server  # API integration tests (need PostgreSQL)
npm test -w apps/web     # SPA component tests (jsdom)
npm run typecheck
npm run lint             # Biome
npm run format           # Biome formatter (writes)
```

Server integration tests create a throw-away database per test file on the
server given by `TEST_DATABASE_URL`
(default `postgres://texcollab:texcollab@127.0.0.1:5432/postgres`, i.e. the
dev compose database) and drop it afterwards. The user needs `CREATEDB`.

Tests that need Docker images are skipped when the image is missing:

```sh
docker build -t texcollab/texlive:dev docker/texlive      # compile-worker sandbox tests
docker build -t texcollab/test-ldap:dev docker/test-ldap  # LDAP tests (apps/server/src/modules/ldap)
```

## Conventions

- TypeScript strict mode everywhere; no `any`.
- All request input is validated with Zod (`apps/server/src/http/validation.ts`).
- Database access only through Kysely (parameterised); schema changes only via
  new files in `apps/server/migrations/` (never edit an applied migration — the
  migrator refuses changed checksums).
- Errors meant for clients are `AppError`s; anything else becomes a generic 500
  with details only in the server log.
- Secrets never appear in logs (pino redaction) or API responses.
- Each server module (`apps/server/src/modules/<name>`) owns its routes,
  service and tests.

## Building images in restricted networks

`scripts/sandbox-docker-build.sh` builds a Dockerfile when outbound traffic
must go through an HTTPS-intercepting proxy (CI sandboxes). Normal hosts do
not need it.
