# syntax=docker/dockerfile:1.7
# TeXCollab compile worker: receives signed compile requests from the app and
# runs each one in a fresh, isolated sandbox container (docker/texlive).
#
# This container talks to the Docker daemon, which is root-equivalent on the
# host. It therefore holds no database access, no application secrets (only
# WORKER_SECRET) and no project storage. See docs/security-model.md.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:28-cli

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
COPY apps/compile-worker apps/compile-worker
RUN npm run build -w packages/shared && npm run build -w apps/compile-worker

FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080 WORKER_TMP_DIR=/tmp
WORKDIR /app
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /src/packages/shared/package.json ./node_modules/@texcollab/shared/package.json
COPY --from=build /src/packages/shared/dist ./node_modules/@texcollab/shared/dist
COPY --from=build /src/apps/compile-worker/package.json ./package.json
COPY --from=build /src/apps/compile-worker/dist ./dist
# The shared package depends on zod (only its browser-side validators use it);
# the worker imports only @texcollab/shared/node, which has no dependencies.
# /work-tmp holds incoming project archives; a named volume mounted here
# inherits this ownership.
RUN mkdir -p /work-tmp && chown node:node /work-tmp
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
