# Security model and threat model

This document describes what TeXCollab protects, against whom, and how. It is
maintained alongside the code; every control listed here is covered by an
automated test unless marked otherwise.

## 1. Assets

| Asset | Why it matters |
|---|---|
| Project contents (sources, figures, history) | Confidential research/business documents |
| Accounts and sessions | Access to all of a user's projects |
| Application secrets (`APP_SECRET`, DB password, `WORKER_SECRET`, LDAP bind password, Git credentials) | Full compromise of data or directory |
| The host and its Docker daemon | Root-equivalent control of the server |
| Availability | ~30 people depend on the service |

## 2. Adversaries

1. **Unauthenticated network attacker** — can reach the web port.
2. **Authenticated user (malicious or compromised account)** — has a normal
   account; may try to read other people's projects, escalate privileges, or
   attack the host through LaTeX compilation.
3. **Malicious document** — a project imported from elsewhere, or shared by a
   collaborator, containing hostile LaTeX, BibTeX, Lua, archive entries or
   file names. Compiling it must never harm the compiling user, other users
   or the host.
4. **Network observer** — between browser and server (mitigated by TLS at the
   reverse proxy).

Out of scope: a malicious *administrator* (they control the host), physical
access, and compromise of the host OS or Docker itself (partially mitigated
by the optional gVisor runtime, §5.4).

## 3. Trust boundaries

```
 browser ──TLS──▶ reverse proxy ──▶ app ──▶ PostgreSQL
                                    │  └──▶ /data (blobs, git, builds)
                                    └──signed HTTP──▶ compile worker ──docker API──▶ sandbox container
```

* Everything from the browser is untrusted: bodies, headers, IDs, file names,
  archive contents, LaTeX sources.
* The compile worker trusts only requests signed with `WORKER_SECRET`.
* The sandbox container is **hostile by assumption**; its output (PDF, logs,
  SyncTeX) is parsed defensively by the app.

## 4. Web application controls

| Threat | Control | Tests |
|---|---|---|
| Password guessing | Argon2id hashes; per-IP rate limit on auth endpoints; temporary account lockout after N failures; identical errors and timing for unknown users and wrong passwords | `auth.test.ts`, `rate-limit.test.ts` |
| Session theft / fixation | 256-bit random tokens; only SHA-256 stored; `HttpOnly`, `SameSite=Lax`, `Secure` + `__Host-` prefix on HTTPS; idle and absolute expiry; new session on every login; logout, password change, disabling and password reset revoke sessions server-side | `auth.test.ts`, `admin.test.ts` |
| CSRF | Per-session CSRF token header required on every state-changing request (including login); foreign `Origin` and `Sec-Fetch-Site: cross-site` rejected; no CORS | `security.test.ts` |
| XSS | React escaping only; strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`); user files served with `nosniff`, `Content-Security-Policy: sandbox`, attachment disposition; only raster images and PDF may be shown inline (never SVG/HTML) | `files.test.ts`, `security.test.ts` |
| SQL injection | All queries parameterised (Kysely); `LIKE` wildcards escaped | reviews + tests with hostile input |
| Broken access control / IDOR | One gate (`ProjectAccess.require`) for every project route; non-members get 404; entity and build IDs are always looked up *together with* the project ID; admins have no implicit access to projects | `files.test.ts` (IDOR matrix), `projects.test.ts`, `compile.test.ts` |
| Path traversal | Files are never stored at user-derived paths (tree in DB, blobs by SHA-256, build/git dirs by UUID). File names validated as single segments (no `/`, `\`, `..`, control or Windows-reserved characters) | `projects.test.ts` (shared), `files.test.ts` |
| Zip slip / zip bombs | Import validates every entry path, rejects symlinks and encrypted entries, counts *actual* decompressed bytes against limits, detects size-header lies, and never writes entries to the filesystem by name | `projects.test.ts` |
| Resource exhaustion (uploads) | Streaming uploads capped per file; per-project size and entry quotas; JSON body limit 1 MB | `files.test.ts` |
| Resource exhaustion (compilation) | One compilation per project and at most two per user at a time; per-user rate limit on the compile endpoint (keyed by account, not IP, so an office behind one address is not throttled together); bounded worker queue; per-compile CPU, memory, time and PID limits in the sandbox | `compile.test.ts`, `worker.test.ts` |
| Information leakage | Generic 500s with request IDs; secrets redacted from logs (pino redaction); audit log contains no secrets; config errors never print values | `admin.test.ts`, `config.test.ts` |
| Privilege escalation via admin API | Admin routes require `is_admin`; last active admin cannot be demoted, disabled or deleted; unknown fields rejected | `admin.test.ts` |
| LDAP injection / insecure directory access | Login names escaped per RFC 4515 in admin-defined filters; exactly one entry must match; empty passwords refused before binding; LDAPS or StartTLS required unless explicitly overridden; certificates always verified (custom CA possible); bind password encrypted, write-only and only reused for the same server and bind DN; local accounts cannot be taken over by directory entries; group sync never removes the last admin | `ldap.test.ts` (OpenLDAP container), `filter.test.ts` |

## 5. LaTeX compilation sandbox

Compiling LaTeX is **running untrusted code**: TeX is Turing-complete,
LuaTeX embeds a Lua interpreter, `\write18` runs shell commands when
enabled, latexmk configuration files are Perl, and BibTeX/Biber and
makeindex process attacker-controlled input. TeXCollab therefore treats
every compilation like a hostile program.

### 5.1 Architecture

* The **app never runs TeX** and never has access to the Docker daemon.
* The **compile worker** is a separate container with the Docker socket. It
  has no database credentials, no `APP_SECRET`, no project storage, sits on an
  internal network without Internet access, and accepts only HMAC-signed
  requests (method, path, all parameters, timestamp and body hash are signed;
  replays are rejected).
* For **each compilation** the worker starts a fresh container from the TeX
  Live image. The project enters as a tar on stdin; whitelisted outputs leave
  as a tar on stdout. There are **no volumes and no host paths** mounted.

### 5.2 Container restrictions (set by the worker, not configurable per request)

| Flag | Effect |
|---|---|
| `--network=none` | No network interfaces except loopback; no DNS |
| `--read-only` | Immutable root filesystem |
| `--tmpfs /work` (noexec,nosuid,nodev, size-capped) | Project and outputs; nothing can be executed from it |
| `--tmpfs /tmp` (noexec,nosuid,nodev) | TeX caches |
| `--tmpfs /par` (exec, size-capped) | Only for Biber's unpacked runtime (see below) |
| `--user 10000:10000` | Unprivileged user |
| `--cap-drop ALL`, `--security-opt no-new-privileges` | No capabilities, no setuid escalation |
| `--memory` = `--memory-swap`, `--cpus`, `--pids-limit` | Memory (no swap), CPU and process-count limits |
| `--ulimit nofile/nproc/fsize/core` | File-descriptor, process, file-size limits; no core dumps |
| `--log-driver none` | Output is not retained by the Docker daemon |
| Environment | Only `LANG`; no secrets are passed |
| `--runtime` (optional) | e.g. gVisor `runsc` for a user-space kernel |

Wall-clock limits: `timeout --signal=KILL` inside the container, plus an
outer `docker kill` by the worker after a grace period. The worker caps the
size of accepted input and of returned output and removes leftover
containers at start-up. Limits requested by the app are clamped to the
worker's own maximums.

### 5.3 TeX-level hardening (defence in depth)

* Shell escape fully disabled: `-no-shell-escape`, `shell_escape=f`, empty
  `shell_escape_commands`. `\write18` and piped `\input{|"cmd"}` do nothing.
* `latexmk -norc` with a fixed, read-only rc file: project `latexmkrc` files
  (Perl code) are never read; custom dependency rules are disabled.
* `openout_any=p`, `openin_any=p` (kpathsea "paranoid" mode).
* LuaTeX without shell escape has `os.execute`/`io.popen` disabled.
* Main-file path and engine are validated by the app, the worker and again
  by the container entrypoint.

**Important finding (verified by `worker.test.ts`):** kpathsea's
`openin_any=p` does **not** stop `\input{/absolute/path}`, and Lua's `io`
library can read any file readable by the process. A document can therefore
read files *inside the sandbox container*. This is acceptable only because
the container holds nothing but the public TeX Live distribution and the
project itself: no host files, no secrets, no other projects. Never mount
anything else into the sandbox.

**Biber** is a PAR-packed executable that must execute code it unpacks at
run time. The image pre-unpacks it; a small wrapper copies that runtime into
the dedicated `/par` tmpfs, the only writable mount that allows execution.
Because shell escape is disabled, documents have no way to execute files
they write there.

### 5.4 Residual risks and recommendations

| Risk | Recommendation |
|---|---|
| A Linux kernel or container-runtime vulnerability could allow escape from a normal container. | Keep the host kernel and Docker updated. For deployments reachable by untrusted users, set `COMPILE_DOCKER_RUNTIME=runsc` (gVisor), use rootless Docker for the worker's daemon, or run workers on a separate host (the worker is reached over HTTP and needs nothing else). |
| The Docker socket gives the worker root-equivalent power over its host. | The worker has a minimal surface (one signed endpoint), no secrets besides `WORKER_SECRET`, and builds container arguments itself from validated values. A dedicated compile host limits the blast radius. |
| TeX Live itself could have bugs exploitable by crafted input. | Rebuild the sandbox image regularly (pin a dated tag), see `docs/upgrading.md`. |
| Output files (PDF, logs, SyncTeX) are attacker-controlled. | Only whitelisted names are accepted; sizes are capped; logs and SyncTeX are parsed with bounded, non-evaluating parsers; PDFs are rendered by pdf.js in the browser with scripting and XFA disabled and served with a sandbox CSP. |
| Denial of service by many heavy compilations. | Per-project single-flight, worker concurrency and queue limits, per-compile CPU/memory/time limits. |

### 5.5 Isolation test suite

`apps/compile-worker/src/worker.test.ts` runs against real Docker and the
real image and checks: no network or DNS; uid 10000 with empty capability
sets and `NoNewPrivs`; read-only root and noexec scratch space; cgroup memory
and PID limits; no secrets or Docker socket visible; `\write18` and piped
input disabled; host files unreachable; Lua cannot execute programs or read
the worker's secrets; infinite loops stopped at the time limit; memory
exhaustion contained; no containers left behind; unsigned, tampered,
replayed and malformed requests rejected.

## 6. Secrets management

* Secrets come from files (`*_FILE`, Docker secrets) or environment
  variables, never from the database in plain text.
* Secrets stored in the database (LDAP bind password, Git credentials) are
  encrypted with AES-256-GCM using keys derived from `APP_SECRET` (HKDF, one
  key per purpose) and are write-only in the admin UI.
* Logs redact passwords, tokens, cookies and CSRF headers.
