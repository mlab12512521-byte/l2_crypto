# Technical debt log

Items knowingly deferred, with the phase expected to address them.

| # | Item | Why deferred | Planned |
|---|---|---|---|
| ~~TD1~~ | ~~No `/metrics` endpoint.~~ Resolved in phase 9 (Prometheus metrics on `METRICS_PORT`). | — | done |
| ~~TD2~~ | ~~No reverse proxy / TLS.~~ Resolved in phase 10: `compose.prod.yml` with Caddy (Let's Encrypt, internal CA or own certificates). | — | done |
| ~~TD3~~ | ~~Admin "delete user" does not check for owned projects.~~ Resolved in phase 2 (409 unless `deleteOwnedProjects=true`). | — | done |
| TD4 | Login rate limiting is per app instance (in-memory store). | Single instance by design (architecture §3.3); account lockout in the DB covers multi-instance brute force. | Revisit if scaling out |
| TD5 | Styles are a single global stylesheet. | Small UI so far; will be split per feature as the editor lands. | Phase 3 |
| TD6 | ZIP import holds the uploaded archive in a temporary file and imports entries one quota query at a time (O(n) queries). | Adequate for thousands of files; simpler than batching. | Revisit if imports get slow |
| TD7 | Directory upload on the client sends one request per file (max 3 concurrent). | Gives per-file progress/errors and bounded memory. | — (by design) |
| ~~TD8~~ | ~~Oversized upload bodies are drained, not aborted.~~ Mitigated in phase 10: Caddy caps request bodies (`TEXCOLLAB_MAX_BODY`, default 1100 MB) and answers 413. | — | done |
| ~~TD9~~ | ~~REST saving in the editor~~ Resolved in phase 5: the editor uses Yjs; the REST text API remains for scripts and uses optimistic concurrency. | — | done |
| ~~TD10~~ | ~~One large SPA bundle.~~ Resolved in phase 9: editor/PDF viewer and admin pages load on demand (login/dashboard ≈ 126 kB gzip; the editor chunk ≈ 420 kB gzip, mostly pdf.js). | — | done |
| ~~TD11~~ | ~~No PDF refresh for collaborators~~ Resolved in phase 5 (`compiled` notification). | — | done |
| TD12 | Compile outputs are per project (shared by all members), not per user. | Simpler; matches small teams. Per-user drafts could be added later. | — |
| TD13 | `openin_any=p` does not stop `\input` of absolute paths inside the sandbox (documented in the security model). | Harmless while the container holds only TeX Live + the project; relies on never mounting anything else. | Keep in mind |
| TD14 | Compile requests run synchronously in the HTTP request (up to the time limit). | Fine for ~30 users; a job queue with push notifications would scale better. | Revisit if scaling out |
| TD15 | `RestDocumentSession` (single-user REST editing) is kept but unused by the SPA. | Decided in phase 9 to keep it: small, tested, and the basis for a fallback if a site's proxy blocks WebSockets. | — (by design) |
| TD16 | Hocuspocus runs in the app process; horizontal scaling needs the Redis extension and sticky sessions. | Single instance by design for ~30 users. | If scaling out |
| TD17 | Invitations are not e-mailed; the inviter tells the invitee. Re-authorisation after role changes drops all of that user's live connections (they reconnect automatically). | No SMTP dependency (decision D3); simple and correct. | Add SMTP if wanted |
| TD18 | External remotes are HTTPS only; no SSH (decision D15). | Tokens cover all common hosts; SSH needs key/known-hosts management. | If requested |
| TD19 | Empty folders are not recorded in versions (Git cannot store empty directories); restoring removes folders that are empty. | Matches Git semantics; a placeholder file would pollute pushed repositories. | — |
| TD20 | `git fetch` from a remote is bounded by a timeout, not by size; a huge remote repository could fill the disk. | Git has no client-side fetch size limit; a fix needs a watchdog on the incoming pack. Mitigations: only owners configure remotes, admins can allow-list hosts, disk monitoring ([operations.md](operations.md)). | Open |
| TD21 | LDAP accounts are not de-provisioned when removed from the directory (they just cannot sign in; existing sessions last until they expire). | Would need a periodic directory sync with its own credentials/permissions. | If wanted: nightly sync job |
| TD22 | One directory server URL; no failover list. | Most sites use a load-balanced name. | If requested |
| TD23 | Backups are full copies each time (no incremental/deduplicated backups built in). | Data volumes for ~30 users are small; deduplicating tools (restic, borg) can take the backup directory. | — |
| TD24 | Horizontal scaling of the app (several instances) is not supported: collaboration state, compile concurrency counters and login rate limits are per process. | Sized for one instance (architecture §3.3). | If scaling out: Redis + Hocuspocus Redis extension |
