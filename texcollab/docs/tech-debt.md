# Technical debt log

Items knowingly deferred, with the phase expected to address them.

| # | Item | Why deferred | Planned |
|---|---|---|---|
| TD1 | No `/metrics` endpoint yet (`METRICS_PORT` is parsed but unused). | Monitoring is part of the production phase. | Phase 10 |
| TD2 | `compose.yml` publishes the app directly on localhost without TLS; no reverse proxy yet. | Proxy/TLS belongs to production deployment. | Phase 10 |
| TD3 | Admin "delete user" does not yet check for owned projects. | Projects do not exist yet. | Phase 2 |
| TD4 | Login rate limiting is per app instance (in-memory store). | Single instance by design (architecture §3.3); account lockout in the DB covers multi-instance brute force. | Revisit if scaling out |
| TD5 | Styles are a single global stylesheet. | Small UI so far; will be split per feature as the editor lands. | Phase 3 |
