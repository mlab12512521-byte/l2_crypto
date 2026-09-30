# TeXCollab — Architecture and Implementation Plan

Status: **v1.0 — agreed baseline for implementation.** Changes to anything in
this document should be made here first, then in code.

TeXCollab is a self-hosted, collaborative, browser-based LaTeX editor in the
spirit of Overleaf, sized for a small organisation (~30 users initially)
without architectural choices that stop it growing beyond that.

---

## 1. Requirements analysis

The functional requirements group into eight capabilities:

| Capability | Key requirements |
|---|---|
| Identity | Local + LDAP/AD accounts, sessions, admin-managed users, disable users |
| Projects | Multi-file trees, folders, uploads (files, directories, drag & drop), ZIP import/export |
| Editing | Professional code editor, LaTeX highlighting, autocomplete, search, folding, tabs, error markers |
| Compilation | Server-side pdflatex/xelatex/lualatex, BibTeX/Biber, multi-pass, error → source line mapping, auto + manual |
| Sandbox | Compilation treated as hostile code execution; strict isolation and resource limits |
| Collaboration | Real-time concurrent editing (CRDT/OT), cursors, selections, presence, reconnection |
| Sharing | Owner/editor/viewer roles, invitations, ownership transfer |
| History | Internal Git per project, automatic meaningful versions, diff, restore, external Git push/pull |
| Operations | Admin UI, Docker Compose, backups, upgrades, logging, health checks, monitoring |

Non-functional drivers, in priority order: **security** (untrusted LaTeX,
multi-tenant data) → **correctness of collaboration** (no lost edits) →
**operability by a small team** → **performance** (~30 concurrent users is
small; one well-sized host suffices) → **extensibility**.

## 2. Ambiguities and decisions

These are points where the brief allows several readings. Each has a chosen
default; all of them are cheap to revisit except where noted.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Where does the code live? | In `texcollab/` inside this repository. | The repository already holds an unrelated project; a self-contained subdirectory avoids clobbering it and is trivial to extract into its own repo. |
| D2 | Self-registration? | **Off by default**; admins create local accounts; LDAP users are auto-provisioned on first successful login. An admin setting can enable open local registration. | Small organisation, secure default. |
| D3 | Invitations without e-mail infrastructure | Sharing targets existing users directly (username/e-mail search). Invitations to an e-mail address with no account become *pending* and are claimed automatically when a user with that e-mail first logs in (e.g. LDAP auto-provisioning). No SMTP dependency. | The brief does not require e-mail; SMTP adds operational burden. Can be added later behind the same `invitations` table. |
| D4 | Canonical store for text files | **Yjs CRDT state in PostgreSQL** (`doc_contents`, with a plain-text copy); binary files in a content-addressed blob store on the filesystem. Git is the *history* store, not the live store. | Live collaborative state must be updated many times a minute; committing each keystroke to Git is wrong (brief §11). Text sources are small (bounded, default 5 MB/file), and keeping them transactional with the file-tree metadata avoids a whole class of consistency bugs. Large binaries stay out of PostgreSQL (brief §15). |
| D5 | Filesystem paths | Project files are **never** stored at user-controlled paths. The tree lives in PostgreSQL (`project_entities`), binaries are stored by SHA-256. Paths are only materialised inside compile sandboxes and ZIP/Git exports, through one validated function. | Eliminates path traversal on the host by construction. |
| D6 | File-name case sensitivity | Case-sensitive, like TeX on Linux. Names are validated (no `/`, `\`, NUL, control chars, `.`/`..`, max 255 bytes, no leading/trailing whitespace). | Matches compile semantics. |
| D7 | Versioning cadence | A version is committed when a project has unsaved-to-history changes **and** has been idle for 5 min, or after 30 min of continuous editing, plus explicit "save a named version", before any restore, and on import/pull. Contributors of the window are recorded. | Avoids per-keystroke commits while bounding lost history to ≤30 min. Values are admin-configurable. |
| D8 | Restore semantics | Restore never rewrites history: it snapshots the current state, then creates a *new* version whose content equals the old one, and pushes the content into live collaborative documents so connected users see it immediately. | Safe and reversible. |
| D9 | External Git "pull" | Fetch + merge. Fast-forward or clean 3-way merges (`git merge-tree --write-tree`) are applied; conflicts are reported per file and nothing is changed. | A conflict-resolution UI is out of scope for the initial version; refusing is safe. |
| D10 | Engines | Default **pdflatex** (widest package compatibility, fastest); xelatex and lualatex selectable per project; `latexmk` drives passes and BibTeX/Biber automatically. | Mature, standard. |
| D11 | TeX distribution | Official **TeX Live** (`scheme-full`) image, pinned by year. Admins may substitute a smaller image. | "Arbitrary normal LaTeX packages" requires the full scheme. |
| D12 | Shell escape | **Disabled, not configurable per project.** Restricted mode is also off (`shell_escape=f`). Packages needing it (`minted`, `svg` conversion) will not work — documented. | Security over convenience; the sandbox is defence-in-depth, not the only control. |
| D13 | Redis | **Not included** initially. The single app process holds the collaboration hub and presence. Horizontal scaling is enabled later by adding Redis and the Hocuspocus Redis extension (no data model change). | "Do not introduce unnecessary services". |

## 3. Architecture

### 3.1 Component view

```
                 Browser (React SPA: CodeMirror 6 + Yjs + pdf.js)
                        │  HTTPS (REST + WebSocket /collab)
                        ▼
              ┌───────────────────┐
              │  Caddy (reverse   │  TLS termination, HTTP→HTTPS, security headers,
              │  proxy)           │  request size limits
              └─────────┬─────────┘
                        ▼
┌────────────────────────────────────────────────────────────────────┐
│ app  (Node.js / TypeScript, one process, modular monolith)         │
│                                                                    │
│  HTTP API (Fastify)        Collaboration hub (Hocuspocus / Yjs)    │
│  ├─ auth (local, LDAP)     ├─ per-file Y.Doc, awareness (cursors)  │
│  ├─ users / admin          ├─ per-project presence channel         │
│  ├─ projects / files       └─ persistence → doc_contents           │
│  ├─ sharing / permissions                                          │
│  ├─ compile orchestration ─────────────── HTTP (internal net, HMAC)│──┐
│  ├─ versions / git (git CLI on bare repos)                         │  │
│  └─ jobs (auto-versioning, GC, session cleanup)                    │  │
│  Static SPA assets                                                 │  │
└───────┬──────────────────────────────┬─────────────────────────────┘  │
        │                              │                                │
        ▼                              ▼                                ▼
 ┌─────────────┐          ┌─────────────────────────┐   ┌──────────────────────────┐
 │ PostgreSQL  │          │ /data volume            │   │ compile-worker (Node)    │
 │ metadata,   │          │  blobs/  (binary files) │   │  no DB, no app secrets,  │
 │ sessions,   │          │  git/    (bare repos)   │   │  no project storage.     │
 │ doc state,  │          │  builds/ (PDF, logs)    │   │  Spawns one ephemeral    │
 │ versions    │          └─────────────────────────┘   │  sandbox container per   │
 └─────────────┘                                         │  compile via Docker API  │
                                                         └────────────┬─────────────┘
                                                                      ▼
                                                   ┌──────────────────────────────────┐
                                                   │ sandbox container (TeX Live)     │
                                                   │ --network none, read-only root,  │
                                                   │ tmpfs /work, cap-drop ALL,       │
                                                   │ non-root, pids/mem/cpu/time caps │
                                                   │ stdin: project tar → stdout: out │
                                                   └──────────────────────────────────┘
```

### 3.2 Why a modular monolith plus one worker

* ~30 users do not justify microservices. One `app` process is simplest to
  operate, debug and back up.
* Collaboration lives **in the same process** as the API because file
  operations (rename, delete, upload-over, version restore, Git pull) must
  coordinate with live collaborative documents: e.g. a restore must be
  applied to the in-memory Y.Doc that connected clients are editing. Doing
  this across a process boundary would require a distributed protocol for no
  benefit at this scale.
* Compilation is the one component that **must** be separate, for security:
  the worker needs to create containers (Docker API access), which is
  root-equivalent on the host. It is therefore isolated in its own container
  holding *no* database credentials, *no* session secret, *no* storage
  volume — only a shared HMAC key for authenticating the app's requests.
  It is also the component most likely to need horizontal scaling (CPU bound),
  and several workers can be listed in configuration.

Internally the app is split into modules with explicit boundaries
(`auth`, `users`, `admin`, `projects`, `files`, `collab`, `compile`,
`versions`, `git`, `jobs`), each with its own routes, service layer and
tests. Modules talk through service interfaces, not each other's tables.

### 3.3 Scaling path (not built now)

1. More compile workers → add URLs to `COMPILE_WORKERS`.
2. More app instances → add Redis, enable the Hocuspocus Redis extension,
   sticky sessions for `/collab` on the proxy; move `/data` to shared storage
   (NFS) or blobs to S3-compatible storage (the blob store is behind an
   interface). Background jobs already use PostgreSQL advisory locks, so
   they are safe with multiple instances.

## 4. Technology choices

| Area | Choice | Why | Alternatives considered |
|---|---|---|---|
| Language | **TypeScript** (Node.js 22 LTS) everywhere | One language across SPA, API, collaboration and worker; shared types/validators. The best CRDT ecosystem (Yjs) is JavaScript-native. | Python/Go backends would need a separate Yjs implementation (y-py/yrs) with a thinner ecosystem. |
| HTTP framework | **Fastify 5** | Mature, fast, first-class TypeScript, schema validation, `inject()` for tests, good plugin ecosystem (cookies, multipart, rate limiting). | Express (weaker typing, slower), NestJS (heavier than needed). |
| Validation | **Zod** | Runtime validation of every input, shared with the frontend. | JSON Schema only (less ergonomic types). |
| Database | **PostgreSQL 16** | Required/preferred; transactional, robust. | — |
| DB access | **Kysely** (typed SQL query builder) + plain SQL migrations | Fully parameterised queries with compile-time checked types, no ORM magic, migrations are reviewable SQL. | Prisma (heavy engine, weaker for complex SQL), Drizzle (fine, but Kysely is closer to SQL). |
| Password hashing | **Argon2id** via `@node-rs/argon2` | Current OWASP recommendation, prebuilt binaries. | bcrypt. |
| LDAP | **ldapts** | Maintained, promise-based, TypeScript, supports LDAPS/StartTLS. | ldapjs (decommissioned). |
| CRDT | **Yjs** | Most widely deployed CRDT for text; proven CodeMirror binding with cursors; offline/reconnect resilience built in; no central transform server needed. | ShareDB/OT (requires server-side transform, less mature CM6 support), Automerge (heavier for text editing). |
| Collab server | **Hocuspocus** | Yjs WebSocket server with authentication hooks, read-only connections, debounced persistence hooks, multiplexing several documents over one socket, Redis scaling extension. | Raw `y-websocket` (would need to re-implement auth, persistence and read-only). |
| Editor | **CodeMirror 6** | Modular and fast on large files, excellent extension API (linting/diagnostics, autocomplete, folding, search), official Yjs binding (`y-codemirror.next`) with remote cursors, used by Overleaf itself. | Monaco: heavier, awkward in multi-panel layouts, weaker LaTeX support, collaborative cursors less mature. |
| LaTeX language | `codemirror-lang-latex` (Lezer grammar: highlighting, folding, autocomplete) with fallback to the legacy `stex` mode. | Structured parse enables folding and completion. | — |
| Frontend | **React 19 + Vite**, React Router, TanStack Query, `react-resizable-panels` | Mainstream, maintainable, fast builds. Server state via TanStack Query keeps components simple. | Vue/Svelte are fine too; React has the largest hiring pool. |
| PDF viewer | **pdf.js** (`pdfjs-dist`) | De-facto standard, text layer for search/selection, runs in the browser. | Browser built-in viewer (no SyncTeX hooks, inconsistent). |
| SyncTeX | Engines run with `-synctex=1`; `synctex.gz` parsed server-side by our own bounded TypeScript parser. | Avoids starting a container per click. | Running the `synctex` binary in a sandbox per query (slow). |
| Git | **git CLI** on bare repositories, via `execFile` (no shell), hardened environment | The reference implementation, complete, fast; plumbing commands let us commit without working trees. | isomorphic-git (incomplete merges, slower), nodegit (native build pain). |
| Compile sandbox | **Ephemeral Docker container per compile**, optional **gVisor (`runsc`)** runtime | Namespaces + cgroups + seccomp + read-only root + no network; gVisor adds a user-space kernel against kernel exploits. | In-process `bubblewrap`/`nsjail` inside the worker (needs privileged worker anyway, harder to operate). |
| Reverse proxy | **Caddy 2** | Automatic HTTPS (ACME) or supplied certificates, trivial config, WebSocket support. | nginx (fine, more config). |
| Logging | **pino** JSON logs to stdout with redaction | Docker-native log collection; fast. | — |
| Metrics | **prom-client** (`/metrics`, internal only) | Standard Prometheus format; optional to scrape. | — |
| Tests | **Vitest** (unit/integration, real PostgreSQL), **Playwright** (end-to-end, Chromium) | Fast, TypeScript-native. | Jest. |
| Deployment | **Docker Compose** | Required/preferred, easy on one Linux host. | Kubernetes (overkill). |

## 5. Data model (PostgreSQL)

All primary keys are UUIDv4 generated in the database
(`gen_random_uuid()`), so IDs are unguessable and never sequential.
Timestamps are `timestamptz`.

```
users
  id uuid PK
  username citext UNIQUE NOT NULL          -- login name; LDAP uid/sAMAccountName
  email citext UNIQUE NULL
  display_name text NOT NULL
  auth_source text NOT NULL CHECK IN ('local','ldap')
  password_hash text NULL                  -- argon2id; NULL for LDAP users
  ldap_dn text NULL
  is_admin boolean NOT NULL DEFAULT false
  is_disabled boolean NOT NULL DEFAULT false
  must_change_password boolean NOT NULL DEFAULT false
  failed_login_count int NOT NULL DEFAULT 0
  locked_until timestamptz NULL
  created_at, updated_at, last_login_at

sessions
  id bytea PK                              -- SHA-256 of the random cookie token
  user_id uuid FK users ON DELETE CASCADE
  csrf_token text NOT NULL
  created_at, last_seen_at, expires_at (absolute), idle_expires_at
  ip inet, user_agent text

projects
  id uuid PK
  name text NOT NULL (1..200 chars)
  root_folder_id uuid NULL FK project_entities   -- set after creation
  main_file_id uuid NULL FK project_entities     -- the file to compile
  compiler text NOT NULL DEFAULT 'pdflatex' CHECK IN ('pdflatex','xelatex','lualatex')
  created_at, updated_at
  last_modified_at, last_modified_by uuid NULL FK users

project_members
  project_id uuid FK projects ON DELETE CASCADE
  user_id uuid FK users ON DELETE CASCADE
  role text CHECK IN ('owner','editor','viewer')
  created_at, added_by
  PK (project_id, user_id)
  UNIQUE (project_id) WHERE role = 'owner'       -- exactly one owner

project_invitations                              -- pending, by e-mail
  id uuid PK, project_id FK, email citext, role, invited_by, created_at, expires_at
  UNIQUE (project_id, email)

project_user_state                               -- "recently opened"
  project_id, user_id, last_opened_at  PK(project_id,user_id)

project_entities                                 -- the file tree
  id uuid PK
  project_id uuid FK projects ON DELETE CASCADE
  parent_id uuid NULL FK project_entities ON DELETE CASCADE   -- NULL only for the root folder
  kind text CHECK IN ('folder','doc','file')     -- doc = editable text (collaborative), file = binary blob
  name text NOT NULL                             -- validated single path segment
  blob_hash text NULL                            -- for kind='file'
  size bigint NOT NULL DEFAULT 0
  created_at, updated_at, created_by
  UNIQUE (parent_id, name)

doc_contents                                     -- live state of 'doc' entities
  entity_id uuid PK FK project_entities ON DELETE CASCADE
  yjs_state bytea NOT NULL                       -- Y.encodeStateAsUpdate
  text text NOT NULL                             -- plain-text mirror for compile/search/export
  content_hash text NOT NULL
  updated_at

blobs                                            -- content-addressed binaries (files on disk)
  hash text PK (sha256 hex), size bigint, created_at

project_changes                                  -- who changed what since last version
  project_id, user_id, first_change_at, last_change_at  PK(project_id,user_id)

versions
  id uuid PK, project_id FK, commit_sha text NOT NULL
  kind text CHECK IN ('auto','named','restore','import','git-pull','initial')
  label text NULL
  created_at, created_by uuid NULL
  contributors uuid[] NOT NULL

compile_builds
  id uuid PK, project_id FK, requested_by, engine
  status text CHECK IN ('queued','running','success','failure','error','timeout')
  started_at, finished_at, duration_ms
  output_files jsonb (names + sizes), diagnostics jsonb (parsed errors/warnings)

git_remotes
  project_id PK FK, url text, auth_type ('none','token','ssh-key'),
  username text NULL, secret_encrypted bytea NULL, branch text,
  last_push_at, last_pull_at, last_error text

system_settings
  key text PK, value jsonb, updated_at, updated_by
  -- 'ldap', 'registration', 'compile_limits', 'versioning', ...
  -- secrets inside (LDAP bind password) are AES-256-GCM encrypted with a key
  -- derived from APP_SECRET and never returned by the API.

audit_log
  id bigserial PK, at, actor_id NULL, action text, target_type, target_id,
  ip inet, details jsonb      -- never contains secrets

schema_migrations (managed by the migrator)
```

## 6. API structure

REST/JSON under `/api`, cookie-authenticated. All state-changing requests
(`POST/PUT/PATCH/DELETE`) require the `X-CSRF-Token` header matching the
session's token and an `Origin` matching the configured public URL.
Errors are `{ "error": { "code": "…", "message": "…" } }` with appropriate
HTTP status codes; IDs in URLs are validated as UUIDs before touching the DB.
Access to a project that exists but is not shared with the user returns
`404`, not `403`, to avoid leaking existence.

```
Auth       POST /api/auth/login              {username, password}
           POST /api/auth/logout
           GET  /api/auth/me                 → user + csrfToken
           POST /api/auth/password           {currentPassword, newPassword}
           POST /api/auth/register           (only if enabled)
Users      GET  /api/users/search?q=         → [{id, username, displayName}]  (for sharing)
Admin      GET/POST        /api/admin/users
           PATCH/DELETE    /api/admin/users/:id        (disable, admin flag, reset password)
           GET/PUT         /api/admin/settings/:key
           GET/PUT         /api/admin/ldap, POST /api/admin/ldap/test
           GET             /api/admin/status, /api/admin/workers, /api/admin/storage
           GET             /api/admin/logs, /api/admin/audit
Projects   GET  /api/projects?filter=owned|shared|all&q=&sort=
           POST /api/projects                 {name, template?}
           POST /api/projects/import          (multipart ZIP)
           GET/PATCH/DELETE /api/projects/:id
           GET  /api/projects/:id/export.zip
Files      GET  /api/projects/:id/tree
           POST /api/projects/:id/entities    {parentId, kind, name}
           PATCH /api/projects/:id/entities/:eid  {name?, parentId?}
           DELETE /api/projects/:id/entities/:eid
           POST /api/projects/:id/upload      (multipart; relative paths for directory upload)
           GET  /api/projects/:id/entities/:eid/content
Compile    POST /api/projects/:id/compile     {draft?, engine?}
           GET  /api/projects/:id/builds/:bid/:file   (output.pdf, output.log …)
           GET  /api/projects/:id/builds/:bid/synctex/pdf?page&x&y   → {file,line}
           GET  /api/projects/:id/builds/:bid/synctex/code?file&line  → {page,x,y}
Sharing    GET  /api/projects/:id/members
           POST /api/projects/:id/members     {userId | email, role}
           PATCH/DELETE /api/projects/:id/members/:uid
           POST /api/projects/:id/transfer    {userId}
Versions   GET  /api/projects/:id/versions
           POST /api/projects/:id/versions    {label}
           GET  /api/projects/:id/versions/:vid/diff?against=:vid2|current
           GET  /api/projects/:id/versions/:vid/files?path=
           POST /api/projects/:id/versions/:vid/restore
Git        GET/PUT/DELETE /api/projects/:id/git/remote
           POST /api/projects/:id/git/push, /api/projects/:id/git/pull
           GET  /api/projects/:id/git/commits, /api/projects/:id/git/commits/:sha
Realtime   WS   /collab                        (Hocuspocus; cookie + Origin checked)
Ops        GET  /healthz (liveness), /readyz (DB + storage + worker), /metrics (internal port)
```

## 7. Frontend architecture

* **SPA** (React 19, Vite, TypeScript strict), served by the app as static files.
* **Routing:** `/login`, `/` (dashboard), `/project/:id` (editor), `/account`,
  `/admin/*`.
* **Server state:** TanStack Query; one typed API client module wraps
  `fetch`, attaches the CSRF header and normalises errors.
* **Editor page layout:** `react-resizable-panels` — file tree | editor (tabs) |
  PDF viewer, with collapsible side panels (history, sharing, chat-free
  presence list). Layout persisted per user in `localStorage`.
* **Editor:** one CodeMirror `EditorView` per open tab, each bound to a
  Yjs `Y.Text` via `y-codemirror.next`; language, autocomplete (commands,
  environments, `\ref`/`\cite` keys from the project), search panel,
  folding, bracket matching, diagnostics from the last compile.
* **Collaboration client:** one `HocuspocusProviderWebsocket` per project
  multiplexing a presence document plus one document per open file.
* **PDF:** pdf.js `PDFViewer` with zoom, page navigation, find, download,
  SyncTeX double-click.
* **Security:** no `dangerouslySetInnerHTML`; strict CSP (`script-src 'self'`),
  compile logs rendered as text.

## 8. Collaboration architecture

* **Model:** each editable text file (`doc`) is one Y.Doc named
  `doc:<entityId>` holding a `Y.Text('content')`. Each project also has a
  presence document `project:<projectId>` used only for awareness (who is
  in the project, which file each user has open) and server → client
  notifications ("tree changed", "compile finished", "version restored").
* **Transport:** Hocuspocus over WebSocket at `/collab`, multiplexed.
* **Authentication:** the session cookie is sent on the WebSocket upgrade;
  `onAuthenticate` resolves the session, verifies `Origin`, loads the
  entity, checks it belongs to a project the user is a member of.
  Viewers get `readOnly` connections (server drops their updates).
  Permission changes and user disabling close affected connections.
* **Persistence:** `onLoadDocument` reads `doc_contents.yjs_state`;
  `onStoreDocument` (debounced 2 s, max 10 s) writes the state and the
  plain-text mirror in one transaction and records the contributors in
  `project_changes`. On shutdown all dirty documents are flushed.
* **Server-side edits** (restore, pull, upload over an existing file) use
  a direct server connection to apply a Yjs transaction, so connected
  clients receive them like any remote edit.
* **Reconnection:** the provider reconnects with exponential backoff; Yjs
  state-vector sync means edits made while offline are merged, not lost.
  The UI shows connection state and disables nothing (edits are buffered).
* **Identity in cursors:** awareness carries only `{userId, displayName,
  colour}`; colour is derived deterministically from the user ID. No
  e-mail addresses are exposed to collaborators.
* **Limits:** max doc size (default 5 MB), max message size, max connections
  per user.

## 9. LaTeX compilation and security architecture

(Full detail in `docs/security-model.md` once Phase 4 lands.)

**Flow:** `app` materialises the project into an in-memory tar (validated
relative paths only, size-capped) → `POST /compile` to a worker with an HMAC
signature → worker enqueues (bounded concurrency, bounded queue, per-project
de-duplication) → `docker run` of the TeX Live sandbox image with the tar on
stdin → the container's fixed entrypoint extracts into a tmpfs, runs
`latexmk` with a fixed, trusted configuration, and writes a tar of whitelisted
outputs (`output.pdf`, `output.log`, `output.synctex.gz`, `.blg`) to stdout →
worker returns it → app parses the log into diagnostics and stores outputs
under `/data/builds/<project>/<build>/`.

**Sandbox container flags (not user-controllable):**

```
--network none                  no network at all
--read-only                     immutable root filesystem
--tmpfs /work:size=…,mode=1777  scratch space, capped
--tmpfs /tmp:size=64m
--user 1000:1000                non-root
--cap-drop ALL
--security-opt no-new-privileges
--security-opt seccomp=<default or stricter profile>
--pids-limit 256
--memory … --memory-swap …      same value → no swap
--cpus …
--ulimit nofile=…, fsize=…
--runtime runsc                 optional gVisor
--rm, stop timeout + docker kill on wall-clock timeout
no volumes, no host paths, no environment secrets
```

**TeX-level hardening (defence in depth):** `-no-shell-escape`,
`shell_escape=f`, `openout_any=p`, `openin_any=p` via a read-only
`texmf.cnf` override; `latexmk -norc` plus our own rc file so a
project-supplied `latexmkrc` (Perl code) is ignored; `-interaction=nonstopmode
-halt-on-error=false`; output size caps.

**Worker isolation:** the worker is the only component with the Docker
socket. It has no DB access, no storage volume, and no secrets other than
the HMAC key; it builds container arguments itself from a fixed template and
a small validated request (engine enum, timeout clamp). The recommended
hardening for exposed deployments is rootless Docker or a dedicated compile
host (the worker is reached over HTTP, so it can live elsewhere).

## 10. Git and versioning architecture

* One **bare repository** per project at `/data/git/<projectId>.git`
  (path built from a validated UUID only). No hooks, no working tree.
* Snapshots are written with plumbing (`hash-object -w`, `mktree`,
  `commit-tree`, `update-ref`) from the database state, so no filesystem
  checkout of user paths ever happens on the host.
* Every `versions` row points at a commit on `refs/heads/main`; commit
  author is the triggering user (or "TeXCollab" for automatic versions with
  `Co-authored-by` trailers for all contributors).
* **Diff:** `git diff-tree` / `git diff` between commits, or between a commit
  and a fresh snapshot of the current state; rendered as side-by-side text
  diffs, binary changes summarised.
* **External remotes:** `GitRemoteProvider` interface with a generic
  implementation for any HTTPS (token/basic) or SSH (deploy key) remote —
  GitHub, GitLab, Gitea and plain servers all work through it. Credentials
  are encrypted at rest and passed to git via `GIT_ASKPASS` / a temporary
  `GIT_SSH_COMMAND` identity file, never on the command line or in URLs.
  `protocol.allow` restricts transports to `https`/`ssh`
  (no `file://`, no `ext::`); remote URLs are validated; admins can
  restrict allowed hosts.

## 11. Deployment architecture

```
docker-compose.yml
  proxy           caddy:2          ports 80/443 → app:3000
  app             texcollab/app    /data volume, DATABASE_URL, APP_SECRET, WORKER_SECRET
  db              postgres:16      pgdata volume
  compile-worker  texcollab/worker /var/run/docker.sock (only here), WORKER_SECRET
  (image)         texcollab/texlive  pulled/built, never a long-running service
networks
  frontend        proxy ↔ app
  backend         app ↔ db, app ↔ compile-worker   (internal: true)
```

Configuration through a `.env` file (documented `.env.example`); secrets can
be supplied as Docker secrets/files (`*_FILE` variants). Migrations run
automatically on app start under an advisory lock (and can be run manually).
Health checks for every service; JSON logs to Docker's logging driver;
`/metrics` on an internal port. Backups: `pg_dump` + `/data` archive script,
documented restore and upgrade procedures.

## 12. Security overview (summary; full model in Phase 9 docs)

| Threat | Control |
|---|---|
| Credential stuffing / brute force | Argon2id, per-IP and per-account rate limiting, temporary lockout, generic error messages |
| Session theft | Random 256-bit tokens, only hash stored, `HttpOnly; Secure; SameSite=Lax` cookie, idle + absolute expiry, rotation on login, server-side revocation |
| CSRF | SameSite cookie + per-session CSRF header + Origin check on state changes and WebSocket upgrades |
| XSS | React escaping, no HTML injection, strict CSP, uploaded files served with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` (except the PDF served for the viewer, which is `application/pdf` from a sandboxed response) |
| SQL injection | Parameterised queries only (Kysely) |
| Path traversal / arbitrary file access | No user-controlled host paths (D5); single validated path builder for sandbox/ZIP/Git; zip-slip checks; symlinks rejected on import |
| Malicious uploads / zip bombs | Size limits per file/project/request, entry-count and expansion-ratio limits on ZIP import |
| Authorization bugs | Central `requireProjectRole()` used by every project route and by the collaboration hub; 404 on no access; tests per route |
| LDAP injection / insecure LDAP | RFC 4515 filter escaping, DN escaping, LDAPS/StartTLS with certificate validation by default, empty-password binds rejected |
| Compile escape / resource exhaustion | §9 sandbox, queue limits, timeouts |
| Git abuse | Transport allow-list, no hooks, credentials never in args/logs, per-project repos addressed by UUID |
| Secrets exposure | Secrets only via env/files, encrypted at rest in DB, pino redaction, write-only fields in admin UI |
| DoS | Body size limits, rate limits, WebSocket message size limits, compile concurrency limits |

## 13. Testing strategy

| Level | Tooling | What |
|---|---|---|
| Unit | Vitest | Path validation, name rules, LDAP filter escaping, log parser, SyncTeX parser, permission matrix, crypto helpers |
| Integration (API) | Vitest + Fastify `inject` + real PostgreSQL (throw-away database per test file) | Auth flows, sessions, CSRF, admin, projects, files, uploads, ZIP import/export, sharing, versions, Git |
| Collaboration | Vitest with real Hocuspocus server + providers in Node | Convergence under concurrent edits, read-only enforcement, auth failures, reconnection after dropped sockets, persistence |
| Compile / sandbox | Vitest against the real worker + Docker (skipped automatically when Docker is unavailable) | Successful builds for each engine, BibTeX/Biber, error diagnostics, **isolation tests**: network access fails, `\write18` fails, reading host files fails, fork bombs/timeouts/memory hogs are contained |
| LDAP | Vitest against an OpenLDAP container (skipped without Docker) + unit tests with a stubbed client | Bind/search, group filters, escaping, disabled users |
| End-to-end | Playwright (Chromium) against the compose stack | Login → create project → edit → compile → PDF visible; two browsers editing simultaneously |
| Security | Dedicated test suite | IDOR attempts across all project routes, CSRF missing/invalid, path traversal names, zip-slip archives, oversized inputs |

CI entry point: `npm test` (unit + integration with a local PostgreSQL),
`npm run test:docker` (sandbox + LDAP), `npm run test:e2e`.

## 14. Implementation phases

Each phase ends with: tests green, review of the diff, technical-debt notes
in `docs/tech-debt.md`, documentation updated, commit.

| Phase | Scope |
|---|---|
| 1 Foundation | Monorepo (npm workspaces: `apps/server`, `apps/web`, `apps/compile-worker`, `packages/shared`), config loading, logging, PostgreSQL + migrations, local auth (Argon2id, sessions, CSRF, rate limiting, lockout), admin user management API + UI, SPA shell (login, dashboard shell, account, admin users), Dockerfiles and dev compose |
| 2 Projects | Projects CRUD, dashboard, file tree model, blob store, file/folder operations, uploads (files, directories, drag & drop), ZIP import/export |
| 3 Editor | Editor page layout, CodeMirror 6 with LaTeX support, tabs, file tree UI |
| 4 Compilation | Worker, sandbox image, queue, log parsing, diagnostics in editor, PDF viewer, auto-compile, SyncTeX |
| 5 Collaboration | Hocuspocus hub, Yjs persistence, cursors, presence, reconnection |
| 6 Sharing | Membership management, invitations, ownership transfer, role enforcement in UI and hub |
| 7 Git & versions | Bare repos, auto-versioning job, history UI, diff, restore, external remotes |
| 8 LDAP | Admin LDAP configuration, search-bind authentication, provisioning, test connection |
| 9 Hardening | Security review, sandbox isolation test suite, dependency audit, CSP/headers, limits |
| 10 Production | Production compose, Caddy, TLS docs, backup/restore scripts, monitoring, upgrade and DR docs |
