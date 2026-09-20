# Core Hub server image. Build from the repository root:
#   docker build -f packages/server/Dockerfile -t corehub .
# One process, one container, one data directory (/data). Non-root. Healthcheck on /api/v1/health.
# Works with the legacy builder and BuildKit alike (no BuildKit-only mounts); CI adds layer caching.

FROM node:24-bookworm AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /app

# ---- all dependencies + build -------------------------------------------------------------
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY packages/server packages/server
RUN pnpm build \
 && mkdir -p packages/server/drizzle packages/contracts/events

# ---- production dependencies only (native modules built here, on the full image) ----------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod

# ---- runtime ------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
RUN groupadd --gid 10001 hub \
 && useradd --uid 10001 --gid hub --create-home --shell /usr/sbin/nologin hub \
 && mkdir -p /data && chown hub:hub /data
WORKDIR /app
# The whole prod-deps tree: root node_modules plus whatever per-package node_modules pnpm made.
COPY --from=prod-deps --chown=hub:hub /app ./
COPY --from=build --chown=hub:hub /app/packages/contracts/openapi.yaml ./packages/contracts/openapi.yaml
COPY --from=build --chown=hub:hub /app/packages/contracts/events ./packages/contracts/events
COPY --from=build --chown=hub:hub /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=hub:hub /app/packages/server/dist ./packages/server/dist
COPY --from=build --chown=hub:hub /app/packages/server/drizzle ./packages/server/drizzle
USER hub
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
