# syntax=docker/dockerfile:1

# The digest pins the exact base image; Dependabot proposes the update when the tag moves.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base

FROM base AS build
# better-sqlite3 ships prebuilt binaries; the toolchain is the fallback when none matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.34.9 --activate
WORKDIR /src

# Manifests first, so the dependency layer is reused until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/miniapp/package.json apps/miniapp/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/importers/package.json packages/importers/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm build

# Drop the Mini App's own packages and every development dependency: the runtime needs the server only.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --frozen-lockfile --prod --filter "@mon22r/server..."

FROM base AS runtime
ENV NODE_ENV=production \
  PORT=3000 \
  DATABASE_PATH=/data/mon22r.sqlite \
  BACKUP_DIR=/backups
WORKDIR /app

COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/domain/package.json packages/domain/
COPY --from=build /src/packages/domain/dist packages/domain/dist
COPY --from=build /src/packages/db/package.json packages/db/
COPY --from=build /src/packages/db/dist packages/db/dist
COPY --from=build /src/packages/db/node_modules packages/db/node_modules
COPY --from=build /src/packages/importers/package.json packages/importers/
COPY --from=build /src/packages/importers/dist packages/importers/dist
COPY --from=build /src/packages/importers/node_modules packages/importers/node_modules
COPY --from=build /src/apps/server/package.json apps/server/
COPY --from=build /src/apps/server/dist apps/server/dist
COPY --from=build /src/apps/server/node_modules apps/server/node_modules
COPY --from=build /src/apps/miniapp/dist apps/miniapp/dist

RUN mkdir -p /data /backups && chown node:node /data /backups
USER node

# Set by the pipeline to the commit the image was built from. /healthz reports it.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.title="mon22r" \
  org.opencontainers.image.revision="${APP_VERSION}"

EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "apps/server/dist/healthcheck.js"]
CMD ["node", "apps/server/dist/main.js"]
