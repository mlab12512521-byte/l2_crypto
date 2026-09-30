# syntax=docker/dockerfile:1.7
# TeXCollab application image: API + collaboration hub + static SPA.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: install all dependencies and compile every workspace ----
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/compile-worker/package.json apps/compile-worker/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build -w packages/shared \
 && npm run build -w apps/server \
 && npm run build -w apps/web

# ---- deps: production dependencies only ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/compile-worker/package.json apps/compile-worker/
RUN npm ci --omit=dev --no-audit --no-fund -w @texcollab/server -w @texcollab/shared --include-workspace-root=false \
 && rm -rf node_modules/@texcollab

# ---- runtime ----
# Ubuntu LTS base with the official Node.js binary: long security support and
# a current git for project history.
FROM ${NODE_IMAGE} AS node
FROM ubuntu:24.04 AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 texcollab \
 && useradd --uid 10001 --gid texcollab --home-dir /app --no-create-home --shell /usr/sbin/nologin texcollab
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/web \
    PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/packages/shared/package.json ./node_modules/@texcollab/shared/package.json
COPY --from=build /src/packages/shared/dist ./node_modules/@texcollab/shared/dist
COPY --from=build /src/apps/server/package.json ./server/package.json
COPY --from=build /src/apps/server/dist ./server/dist
COPY --from=build /src/apps/server/migrations ./server/migrations
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /data && chown texcollab:texcollab /data
USER texcollab
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
