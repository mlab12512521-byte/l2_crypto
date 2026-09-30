# Technical debt log

Items knowingly deferred, with the phase expected to address them.

| # | Item | Why deferred | Planned |
|---|---|---|---|
| TD1 | No `/metrics` endpoint yet (`METRICS_PORT` is parsed but unused). | Monitoring is part of the production phase. | Phase 10 |
| TD2 | `compose.yml` publishes the app directly on localhost without TLS; no reverse proxy yet. | Proxy/TLS belongs to production deployment. | Phase 10 |
| ~~TD3~~ | ~~Admin "delete user" does not check for owned projects.~~ Resolved in phase 2 (409 unless `deleteOwnedProjects=true`). | — | done |
| TD4 | Login rate limiting is per app instance (in-memory store). | Single instance by design (architecture §3.3); account lockout in the DB covers multi-instance brute force. | Revisit if scaling out |
| TD5 | Styles are a single global stylesheet. | Small UI so far; will be split per feature as the editor lands. | Phase 3 |
| TD6 | ZIP import holds the uploaded archive in a temporary file and imports entries one quota query at a time (O(n) queries). | Adequate for thousands of files; simpler than batching. | Revisit if imports get slow |
| TD7 | Directory upload on the client sends one request per file (max 3 concurrent). | Gives per-file progress/errors and bounded memory. | — (by design) |
| TD8 | Upload bodies that exceed limits are drained, not aborted, so bandwidth is wasted until the reverse proxy's body limit. | Aborting resets the connection and the browser never sees the error. | Phase 10: set proxy body limit |
| ~~TD9~~ | ~~REST saving in the editor~~ Resolved in phase 5: the editor uses Yjs; the REST text API remains for scripts and uses optimistic concurrency. | — | done |
| TD10 | The SPA ships as one ~870 kB (270 kB gzip) bundle. | Acceptable on a LAN; split editor/PDF code later. | Phase 9 |
| ~~TD11~~ | ~~No PDF refresh for collaborators~~ Resolved in phase 5 (`compiled` notification). | — | done |
| TD12 | Compile outputs are per project (shared by all members), not per user. | Simpler; matches small teams. Per-user drafts could be added later. | — |
| TD13 | `openin_any=p` does not stop `\input` of absolute paths inside the sandbox (documented in the security model). | Harmless while the container holds only TeX Live + the project; relies on never mounting anything else. | Keep in mind |
| TD14 | Compile requests run synchronously in the HTTP request (up to the time limit). | Fine for ~30 users; a job queue with push notifications would scale better. | Revisit if scaling out |
| TD15 | `RestDocumentSession` (single-user REST editing) is kept but unused by the SPA. | Useful fallback if WebSockets are blocked by a proxy; small. | Decide in phase 9 |
| TD16 | Hocuspocus runs in the app process; horizontal scaling needs the Redis extension and sticky sessions. | Single instance by design for ~30 users. | If scaling out |
