# Core Hub server image. Build from the repository root:
#   docker build -f packages/server/Dockerfile -t core-hub .
# One process, one container, one data directory (/data). Non-root. Healthcheck on /api/v1/health.
# The image also carries the built web client, served by the hub from /.
# The image holds the hub and the Hermes runtime only (ADR 0006); the hub starts and supervises
# `hermes gateway run` itself (ADR 0008). Works with the legacy builder and BuildKit alike.
#
# Size discipline (docs/changes/2026-09-21-twuijri-slim-image.md): every stage that lands in the
# runtime image prunes what nothing loads at runtime — and only that. Keep the prune lists next to
# the reason for each entry; when in doubt, keep the file.

FROM node:24-bookworm AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /app

# The version being released, stamped into both halves of the image: the web bundle prints it
# before the hub answers, and the hub reports it on /api/v1/health and /api/v1/meta. The default
# is the root package.json's version (`pnpm version:check` keeps the two equal); release.yml
# passes the tag's version, or `<version>-preview.<run>` for a manual preview.
ARG COREHUB_VERSION=1.1.0

# ---- all dependencies + build -------------------------------------------------------------
FROM base AS build
ARG COREHUB_VERSION
ENV COREHUB_VERSION=${COREHUB_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY packages/server packages/server
COPY packages/cli packages/cli
COPY packages/ui-tokens packages/ui-tokens
COPY packages/web packages/web
# The web client bundles the navigation manifest at build time (docs/clients/README.md).
COPY docs/clients/navigation.json docs/clients/navigation.json
RUN pnpm build \
 && mkdir -p packages/server/drizzle packages/contracts/events

# ---- production dependencies only (native modules built here, on the full image) ----------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile --prod
# better-sqlite3 ships the SQLite amalgamation, its C++ sources and a prebuilt binary for every
# platform it supports (~25 MB). At runtime lib/binding.js loads prebuilds/<platform>-<arch>.node
# (build/Release/ holds only node-gyp's stamp here), so keep the Linux glibc binaries — the two
# platforms release.yml builds — and drop the rest. The require() proves the kept binary loads.
RUN set -eu; \
    for pkg in node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3; do \
      rm -rf "$pkg/deps" "$pkg/src" "$pkg/build" "$pkg/binding.gyp"; \
      find "$pkg/prebuilds" -type f ! -name 'linux-x64.node' ! -name 'linux-arm64.node' -delete; \
    done; \
    cd packages/server && node -e "const db=require('better-sqlite3')(':memory:'); if (db.prepare('select 1 as ok').get().ok!==1) process.exit(1)"
# node-pty (MIT) is the owner's web terminal (DECISIONS §70). It ships prebuilt binaries only for
# macOS and Windows (~58 MB), so on Linux `pnpm install` above compiled it with node-gyp — the
# build tools (python3, make, g++) come with this node:24-bookworm stage and never reach the
# runtime image. At runtime lib/utils.js loads build/Release/pty.node; everything else — the
# foreign prebuilds, the winpty/conpty sources, node-gyp's intermediates — goes. The script
# spawns a shell on a real PTY and reads its output, so a binary that does not load or work fails
# the build rather than a terminal session.
RUN set -eu; \
    for pkg in node_modules/.pnpm/node-pty@*/node_modules/node-pty; do \
      rm -rf "$pkg/prebuilds" "$pkg/deps" "$pkg/src" "$pkg/third_party" "$pkg/scripts" \
             "$pkg/binding.gyp" "$pkg/typings" "$pkg/build/Makefile" "$pkg/build/config.gypi" \
             "$pkg"/build/*.mk "$pkg/build/Release/obj.target" "$pkg/build/Release/.deps"; \
      find "$pkg/lib" -name '*.test.js*' -delete; \
      test -f "$pkg/build/Release/pty.node"; \
    done; \
    cd packages/server && node -e "const p=require('node-pty').spawn('/bin/sh',['-c','echo pty-ok'],{cols:80,rows:24,cwd:'/',env:{PATH:'/usr/bin:/bin'}});let o='';p.onData(d=>o+=d);p.onExit(()=>process.exit(o.includes('pty-ok')?0:1))"

# ---- Hermes Agent (MIT), pinned to a release tag ------------------------------------------
# A standalone CPython managed by uv plus a venv, both under /opt/hermes so the runtime stage
# copies one tree. Hermes refuses to build a wheel ("distributed via the shell installer,
# Docker image, or Nix"); the supported route is an editable install from a checkout, so the
# pinned tag is cloned to /opt/hermes/src and stays there. Core dependencies only, plus what
# the API server (aiohttp), cron and MCP need, plus the channels the hub links whose libraries
# fit (Telegram, Discord, Slack, WhatsApp — below): no dashboard, TUI, browsers, ffmpeg or other
# messaging extras — the hub is the UI.
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
 && git clone --depth 1 --branch "${HERMES_REF}" https://github.com/NousResearch/hermes-agent /opt/hermes/src \
 && rm -rf /opt/hermes/src/.git \
 && cd /opt/hermes/src \
 && uv pip install --python /opt/hermes/.venv/bin/python -e ".[cron,mcp]" "aiohttp==3.14.3" \
 && /opt/hermes/.venv/bin/hermes --version
# The messaging channels whose libraries fit the image-size budget ship in the image, so linking
# one downloads nothing at runtime (docs/changes/2026-09-25-twuijri-image-channel-deps.md,
# docs/changes/2026-09-25-twuijri-more-channels.md). Matrix's (mautrix with encryption, ~9 MB
# compressed) did not fit and is still installed by Hermes on first use; Mattermost and Email need
# nothing beyond Hermes itself.
#
# Telegram, Discord, Slack: Hermes installs each client on first use (tools/lazy_deps.py,
# `platform.<name>`) from PyPI. The specs are read from that table here, so the image carries
# exactly what Hermes would install and the pins cannot drift from Hermes's own. The venv's
# current versions are the constraints — the rule Hermes itself applies to a lazy install — so no
# core package moves; a conflict fails the build instead. The last line is Hermes's own question:
# is_available is what ensure() asks before it installs anything.
ARG IMAGE_CHANNELS="platform.telegram platform.discord platform.slack"
RUN set -eu; cd /opt/hermes/src; \
    py=/opt/hermes/.venv/bin/python; \
    specs=$("$py" -c "import sys; from tools.lazy_deps import LAZY_DEPS; print(' '.join(s for f in sys.argv[1:] for s in LAZY_DEPS[f]))" $IMAGE_CHANNELS); \
    uv pip freeze --python "$py" | grep -E '^[A-Za-z0-9._-]+==' > /tmp/core-constraints.txt; \
    echo "$IMAGE_CHANNELS: $specs"; \
    uv pip install --python "$py" --constraint /tmp/core-constraints.txt $specs; \
    rm /tmp/core-constraints.txt; \
    "$py" -c "import importlib, sys; from tools import lazy_deps; mods = {'platform.telegram': 'telegram.ext', 'platform.discord': 'discord', 'platform.slack': 'slack_bolt'}; [importlib.import_module(mods[f]) for f in sys.argv[1:] if f in mods]; missing = [f for f in sys.argv[1:] if not lazy_deps.is_available(f)]; assert not missing, [lazy_deps.feature_missing(f) for f in missing]" $IMAGE_CHANNELS
# WhatsApp: Hermes's bridge (scripts/whatsapp-bridge, Baileys) runs `npm install` the first time
# a phone is linked. Its locked dependencies are installed here instead, read-only in the image;
# the hub points each profile's copy of the bridge at them (modules/agents/whatsapp-bridge.ts).
# The stamp is the one Hermes's adapter compares before it would install again
# (plugins/platforms/whatsapp/adapter.py §_ensure_bridge_deps), written with Hermes's own hash.
RUN set -eu; cd /opt/hermes/src/scripts/whatsapp-bridge; \
    npm ci --omit=dev --no-audit --no-fund; \
    rm -rf /root/.npm; \
    /opt/hermes/.venv/bin/python -c "import sys; sys.path.insert(0, '/opt/hermes/src'); from pathlib import Path; from plugins.platforms.whatsapp.adapter import _file_content_hash as h; Path('node_modules/.hermes-pkg-hash').write_text(h(Path('package.json')), encoding='utf-8')"; \
    test -s node_modules/.hermes-pkg-hash; \
    node --input-type=module -e "await Promise.all(['@whiskeysockets/baileys', 'express', 'pino', 'qrcode-terminal', '@hapi/boom'].map((m) => import(m)))"
# Prune the checkout to what the editable install and Hermes's runtime actually read. The
# packages come from pyproject [tool.setuptools.packages.find] plus the root modules; the data
# directories are the ones Hermes resolves relative to its source root (locales, skills,
# optional-skills, optional-mcps, plugin-catalog, scripts/, uv.lock, cli-config.yaml.example,
# website/static/api/model-catalog.json). Everything removed here has no reference from
# non-test code: the test suites, the desktop app, the docs site, the TUI and dashboard
# sources (never built in this image, ADR 0008 §3), evals, Nix/Docker packaging, installers.
RUN set -eu; cd /opt/hermes/src; \
    mv website/static/api/model-catalog.json /tmp/model-catalog.json; \
    rm -rf tests tests-js apps website ui-tui web evals contributors nix docker .github \
           flake.nix flake.lock install.sh setup-hermes.sh docker-compose.yml \
           docker-compose.windows.yml Dockerfile eslint.config.shared.mjs constraints-termux.txt \
           README.es.md README.ur-pk.md README.zh-CN.md CONTRIBUTING.md CONTRIBUTING.es.md \
           SECURITY.md SECURITY.es.md COMPAT_MANIFEST.md; \
    mkdir -p website/static/api && mv /tmp/model-catalog.json website/static/api/; \
    /opt/hermes/.venv/bin/hermes --version
# Prune the standalone CPython to an interpreter: the python3.12 binary is statically linked
# (ldd lists no libpython), no wheel in the venv links libpython either, so the 32 MB embedding
# library goes, along with Tcl/Tk (+ tkinter, IDLE, turtledemo — nothing in Hermes imports
# them), the C headers, pkg-config and *-config scripts (no compiler in the image), the man
# pages, and the base interpreter's own pip (invisible to the venv, which has
# include-system-site-packages=false). ensurepip stays: tools/lazy_deps.py falls back to it.
RUN set -eu; \
    for py in /opt/hermes/python/cpython-3.12.*-linux-*-gnu; do \
      rm -rf "$py/include" "$py/share/man" "$py/lib/pkgconfig" \
             "$py"/lib/libpython3*.so* "$py"/lib/libtcl9* "$py"/lib/tcl9* "$py"/lib/tk9* \
             "$py"/lib/itcl* "$py"/lib/thread* \
             "$py/lib/python3.12/tkinter" "$py/lib/python3.12/idlelib" "$py/lib/python3.12/turtledemo" \
             "$py"/lib/python3.12/config-3.12-* "$py"/lib/python3.12/lib-dynload/_tkinter* \
             "$py"/lib/python3.12/site-packages/* \
             "$py"/bin/2to3* "$py"/bin/idle3* "$py"/bin/pip* "$py"/bin/pydoc3* "$py"/bin/*-config; \
    done; \
    /opt/hermes/.venv/bin/python -c "import ssl, sqlite3, ensurepip, curses, zoneinfo; import hermes_cli" \
 && /opt/hermes/.venv/bin/hermes --version
# Compile the bytecode now: at runtime /opt/hermes is read-only (below) and Python writes no
# __pycache__ (PYTHONDONTWRITEBYTECODE), so without this every `hermes` command recompiles its
# imports — measured ~600 ms per command against ~200 ms. unchecked-hash: the sources never
# change inside the image, so Python need not stat them to trust the cache. Costs ~34 MB
# compressed (docs/changes/2026-09-23-twuijri-sealed-image.md). A file Python cannot compile
# (a stray Python 2 test in a wheel) is skipped, which is why the exit code is not the check —
# the import below is.
#
# pip goes into the venv here, not later: the image has no uv at runtime, so Hermes installs an
# optional package with `python -m pip install --target /data/hermes-packages`, and with the
# venv sealed it could not bootstrap pip into it (ensurepip) the way an open venv does.
# go-w last: uv leaves world-writable .lock files, and nothing here may be writable by `hub`.
RUN /opt/hermes/.venv/bin/python -m ensurepip --default-pip >/dev/null \
 && { /opt/hermes/.venv/bin/python -m compileall -q -j0 --invalidation-mode unchecked-hash \
        /opt/hermes/src /opt/hermes/.venv/lib/python3.12/site-packages /opt/hermes/python >/dev/null || true; } \
 && chmod -R go-w /opt/hermes \
 && /opt/hermes/.venv/bin/python -m pip --version \
 && PYTHONDONTWRITEBYTECODE=1 /opt/hermes/.venv/bin/hermes --version

# ---- runtime ------------------------------------------------------------------------------
# debian:bookworm-slim is the base of node:24-bookworm-slim; taking it directly and copying the
# node binary and npm from the build image leaves out yarn, corepack, the node headers and the
# node image's own apt layer (wget, gnupg) — nothing here uses them. npm stays: the hub installs
# catalog agents with `npm install --global --prefix` (modules/agents/installer.ts).
FROM debian:bookworm-slim AS runtime
ARG COREHUB_VERSION
# Who this image is, for a registry or `docker inspect`. A release adds the tag and revision on
# top (docker/metadata-action in .github/workflows/release.yml).
LABEL org.opencontainers.image.title="Core Hub" \
      org.opencontainers.image.description="Core Hub: a self-hosted hub for AI agents, with Hermes inside." \
      org.opencontainers.image.source="https://github.com/twuijri/core-hub" \
      org.opencontainers.image.url="https://github.com/twuijri/core-hub" \
      org.opencontainers.image.version="${COREHUB_VERSION}"
ENV COREHUB_VERSION=${COREHUB_VERSION} \
    NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HERMES_HOME=/data/hermes \
    HOME=/data/home \
    NPM_CONFIG_CACHE=/tmp/.npm \
    PATH=/opt/hermes/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    HERMES_LAZY_INSTALL_TARGET=/data/hermes-packages
# HOME is inside the volume (decision §78): the coding agents read their own config files from
# it (`~/.claude/CLAUDE.md`, `~/.codex/config.toml` …), edited from the web, and an upgrade that
# replaces the container must not drop them. The hub makes the folder on the first boot of a
# volume that predates it. npm's cache stays outside the volume, where it always was.
# The code is sealed (docs/changes/2026-09-23-twuijri-sealed-image.md): /app and /opt/hermes are
# root's and read-only to `hub`, so nothing the hub or an agent runs can change the hub's or
# Hermes's code — a change comes with a new image. Everything that is written lives in /data.
# The two HERMES_* lines are Hermes's own switch for a sealed image (tools/lazy_deps.py, the
# same pair its upstream Dockerfile sets): the optional packages Hermes installs the first time
# a feature needs them (Edge voices, Bedrock, Vertex …) go to /data/hermes-packages instead of
# its venv, appended to sys.path so they can add modules but never replace a core one, and
# they survive a container being recreated.
# git and ripgrep are what Hermes's own tools shell out to (tools/checkpoint_manager.py,
# tools/working_diff.py, tools/subagent_worktree.py; tools/file_operations_search.py); curl is
# how Hermes fetches its managed uv (hermes_cli/managed_uv.py); ca-certificates for provider calls.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 hub \
 && useradd --uid 10001 --gid hub --create-home --shell /usr/sbin/nologin hub \
 && mkdir -p /data && chown hub:hub /data
# `python3` for the scripts skills run (Core Hub's library, decision §71, and Hermes's own —
# xlsx, pdf, docx …). Hermes's terminal runs a login shell, and Debian's /etc/profile resets PATH
# for a non-root user, dropping /opt/hermes/.venv/bin: `python3` was "command not found" there
# (skill-library.real.test.ts). A wrapper, not a symlink, so the venv — and the Pillow in it — is
# the one that runs; the venv stays read-only to `hub`.
RUN printf '#!/bin/sh\nexec /opt/hermes/.venv/bin/python3 "$@"\n' > /usr/local/bin/python3 \
 && chmod 0755 /usr/local/bin/python3 \
 && ln -s python3 /usr/local/bin/python
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=base /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version
WORKDIR /app
COPY --from=hermes /opt/hermes /opt/hermes
# The whole prod-deps tree: root node_modules plus whatever per-package node_modules pnpm made.
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/contracts/openapi.yaml ./packages/contracts/openapi.yaml
COPY --from=build /app/packages/contracts/events ./packages/contracts/events
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/drizzle ./packages/server/drizzle
# Core Hub's own skills, installed into every Hermes profile's skills/core-hub/ (decision §71).
COPY --from=build /app/packages/server/skill-library ./packages/server/skill-library
# The web client: static files the hub serves from / (packages/server/src/app/web.ts).
COPY --from=build /app/packages/web/dist ./packages/web/dist
USER hub
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
