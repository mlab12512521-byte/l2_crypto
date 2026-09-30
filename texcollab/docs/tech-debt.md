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
