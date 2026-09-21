# Majlis server image. Build from the repository root:
#   docker build -f packages/server/Dockerfile -t majlis .
# One process, one container, one data directory (/data). Non-root. Healthcheck on /api/v1/health.
# The image holds the hub and the Hermes runtime only (ADR 0006); the hub starts and supervises
# `hermes gateway run` itself (ADR 0008). Works with the legacy builder and BuildKit alike.

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

# ---- Hermes Agent (MIT), pinned to a release tag ------------------------------------------
# A standalone CPython managed by uv plus a venv, both under /opt/hermes so the runtime stage
# copies one tree. Core dependencies only, plus what the API server (aiohttp), cron and MCP
# need: no dashboard, TUI, browsers, ffmpeg or messaging extras — the hub is the UI.
FROM node:24-bookworm AS hermes
ARG HERMES_REF=v2026.9.14
ARG UV_VERSION=0.11.6
ENV UV_PYTHON_INSTALL_DIR=/opt/hermes/python \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1
ADD https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-installer.sh /tmp/uv-installer.sh
RUN sh /tmp/uv-installer.sh \
 && install -m 0755 /root/.local/bin/uv /usr/local/bin/uv \
 && uv python install 3.12 \
 && uv venv --python 3.12 /opt/hermes/.venv \
 && uv pip install --python /opt/hermes/.venv/bin/python \
      "hermes-agent[cron,mcp] @ git+https://github.com/NousResearch/hermes-agent@${HERMES_REF}" \
      "aiohttp==3.14.3" \
 && /opt/hermes/.venv/bin/hermes --version

# ---- runtime ------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HERMES_HOME=/data/hermes \
    PATH=/opt/hermes/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# git and ripgrep are what Hermes's own tools shell out to; ca-certificates for provider calls.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 hub \
 && useradd --uid 10001 --gid hub --create-home --shell /usr/sbin/nologin hub \
 && mkdir -p /data && chown hub:hub /data
WORKDIR /app
COPY --from=hermes --chown=hub:hub /opt/hermes /opt/hermes
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
