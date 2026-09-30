# Configuration reference

The app is configured with environment variables (in Compose: `.env` plus
secret files). Any variable marked *secret* may instead be given as
`<NAME>_FILE=/path/to/file` (Docker secrets convention). Invalid configuration
stops the app at startup with a message naming the variable (never its value).

## Core

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | — (required) | URL users open in the browser, e.g. `https://latex.example.org`. Used for CSRF Origin checks and to decide whether cookies are `Secure` (https ⇒ yes). |
| `APP_SECRET` *secret* | — (required, ≥ 32 chars) | Master key from which encryption keys for secrets stored in the database are derived. Changing it makes stored secrets (LDAP bind password, Git credentials) unreadable. |
| `DATABASE_URL` *secret* | — | Full PostgreSQL connection string. Alternative to the `DB_*` variables. |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_NAME` | `db` / `5432` / `texcollab` / `texcollab` | Used when `DATABASE_URL` is not set. |
| `DB_PASSWORD` *secret* | — | Database password (with `DB_*`). |
| `DATABASE_POOL_SIZE` | `20` | Maximum PostgreSQL connections per app instance. |
| `DATA_DIR` | `/data` | Persistent storage root (binary files, Git repositories, build output). |
| `WEB_DIST_DIR` | `` (image: `/app/web`) | Directory with the built SPA; empty disables static serving. |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Listen address. |
| `TRUST_PROXY_HOPS` | `0` | Number of reverse proxies whose `X-Forwarded-For` is trusted (1 behind the bundled Caddy). Needed for correct client IPs in rate limiting and audit logs. |
| `LOG_LEVEL` | `info` | `fatal`…`trace`, or `silent`. |
| `RUN_MIGRATIONS_ON_START` | `true` | Apply pending database migrations at startup (serialised with an advisory lock). |

## Sessions and login protection

| Variable | Default | Description |
|---|---|---|
| `SESSION_IDLE_TIMEOUT_MINUTES` | `10080` (7 days) | Session ends after this much inactivity. |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `720` (30 days) | Session ends this long after login regardless of activity. |
| `LOGIN_MAX_FAILURES` | `10` | Consecutive failed logins before a temporary lock. |
| `LOGIN_LOCKOUT_MINUTES` | `15` | Duration of the temporary lock. |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `20` | Requests per minute per client IP to login/registration/password endpoints. |

## Bootstrap

| Variable | Description |
|---|---|
| `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD` *secret*, `INITIAL_ADMIN_EMAIL` | If set and the database has no users, an administrator is created at startup who must change the password at first login. Remove the values afterwards. Alternatively use the CLI: `docker compose exec app node server/dist/cli.js create-admin <username>` (password on stdin). |

## Settings managed in the UI

Stored in the database (`system_settings`), editable under
*Administration → Settings*:

| Key | Default | Meaning |
|---|---|---|
| `registration.enabled` | `false` | Allow self-service creation of local accounts. |
| `projectLimits.maxFileSizeMb` | `100` | Largest single uploaded file. |
| `projectLimits.maxTextFileSizeMb` | `5` | Largest text file opened in the editor (bigger ones are stored as binary). |
| `projectLimits.maxProjectSizeMb` | `1024` | Total size of one project's files (also caps ZIP imports by decompressed size). |
| `projectLimits.maxEntitiesPerProject` | `5000` | Files + folders per project. |
