# Deploying Majlis

One container, one data volume. The image holds the hub (Node) and the Hermes
runtime (Python) — nothing else (ADR 0006, ADR 0008). Coding agents are
installed later from the Agents screen into the same volume.

What the image weighs (linux/amd64, measured 2026-09-21): about 210 MB to
pull, about 710 MB unpacked. Roughly a third of that is Hermes's pinned
Python dependencies, a sixth is `git` (Hermes's checkpoint and worktree tools
shell out to it) and a sixth is the Node runtime. The Dockerfile keeps only
what the hub and Hermes load at runtime; the prune lists in
`packages/server/Dockerfile` say why each entry is safe to drop.

## 1. Run the image

```bash
git clone https://github.com/twuijri/majlis && cd majlis
cp .env.example .env            # set HUB_ADMIN_PASSWORD (8+ characters)
docker compose up -d            # pulls ghcr.io/twuijri/majlis:latest, or `--build` to build here
docker compose logs -f hub      # watch the first boot
```

`docker-compose.yml` in the repository root is the reference stack. What it
sets:

| Variable | Meaning |
|---|---|
| `HUB_ADMIN_PASSWORD` | First boot only: creates the owner account `admin`. Ignored afterwards; change the password from the UI. |
| `DATA_DIR` | `/data` in the container, the named volume `hub-data`. SQLite database, JWT and Hermes API keys, coding agents, and `hermes/` (Hermes's home) all live here. |
| `PORT` / `HUB_PORT` | The hub listens on `8080` inside; `HUB_PORT` publishes it on the host. |
| `DATABASE_URL` | Optional PostgreSQL instead of the SQLite file. |

These four are the whole configuration (ARCHITECTURE invariant 5). There is
no variable for model provider keys: they belong to Hermes, inside the
volume, never to the hub (§3).

Upgrading is `docker compose pull && docker compose up -d`; the volume is
untouched.

## 1b. Getting an image built

- **A release**: push a tag `v*` on `main`. The Release workflow builds for
  amd64 and arm64 and publishes `:<version>`, `:<major>.<minor>` and `:latest`.
- **A preview**: Actions → Release → *Run workflow*, pick the branch, give an
  image tag (`preview`, `test`, `0.1.0-rc.1` …) and the platforms. It
  publishes `ghcr.io/twuijri/majlis:<that tag>` and refuses to touch `latest`,
  which belongs to release tags on `main` alone.

The number to watch is the compressed pull size, not what `docker image ls`
prints (`docs/ROADMAP.md` §Sizes).

## 2. First login and pairing

1. Open `http://<host>:8080` — the hub serves the web client from `/` — or use
   the reference client. Sign in as `admin` with `HUB_ADMIN_PASSWORD`.
2. Change the password (`PATCH /auth/me`), create your workspace or keep
   `default`.
3. Pair a phone: `POST /auth/pairings` shows a QR; the phone claims it and
   receives an app token. Pairing codes expire in 5 minutes.

## 3. Hermes inside the container

On boot the hub looks for a Hermes gateway on `http://127.0.0.1:8642`. In the
image there is none, so it starts its own: `hermes gateway run` with
`HERMES_HOME=/data/hermes` and a generated API server key in
`/data/keys/hermes-api.secret`. The log line to look for:

```
agents: hermes runtime  mode=managed
hermes: gateway started (managed)
[API Server] API server listening on http://127.0.0.1:8642
```

Hermes needs a model provider before it can answer. Configure it **inside the
volume**, through Hermes's own commands, so no key ever passes through the hub:

```bash
docker compose exec hub hermes model                        # interactive provider + model picker
# or non-interactively:
docker compose exec hub hermes config set OPENROUTER_API_KEY sk-or-...
docker compose exec hub hermes config set model openrouter/anthropic/claude-sonnet-4.6
docker compose exec -T hub hermes doctor                    # what Hermes thinks of its setup
```

The hub's `hermes` command already has `HERMES_HOME=/data/hermes` in its
environment, so these edit `/data/hermes/.env` and `/data/hermes/config.yaml`.
Restart Hermes from the Agents screen (`agents.restart`) or
`docker compose restart hub` for the new key to take effect.

### Using a Hermes you already run

If a gateway answers `/health` at the endpoint when the hub boots, the hub
uses it and starts nothing (mode `external`). It must carry the same API key
the hub sends — either copy `/data/keys/hermes-api.secret` into that gateway's
`API_SERVER_KEY`, or write that gateway's key into the file before the first
boot. The endpoint is the Hermes agent's `gateway.endpoint` setting
(`agents.updateSettings`, section `gateway`).

### Where things live

| Path in the volume | What |
|---|---|
| `/data/hub.sqlite` | the hub's database |
| `/data/keys/jwt.secret` | access-token signing key |
| `/data/keys/hermes-api.secret` | the `API_SERVER_KEY` the hub sends to Hermes |
| `/data/hermes/` | Hermes's home: `.env`, `config.yaml`, memories, skills, sessions, cron |
| `/data/agents/<id>/` | coding agents installed from the catalog |

## 4. Smoke checklist

```bash
curl -fsS http://<host>:8080/api/v1/health                      # {"ok":true,...}
docker compose exec hub node -e "fetch('http://127.0.0.1:8642/health').then(r=>r.text()).then(console.log)"
                                                                 # {"status":"ok",...}
```

Then, signed in (`TOKEN` from `POST /auth/login`, `X-Hub-Profile: default`):

1. `GET /api/v1/agents` — Hermes is listed with `status: available` and
   `runtime.state: running`. `not_installed`/`stopped` means the gateway did
   not come up: read `docker compose logs hub` for the lines prefixed by
   Hermes.
2. `POST /api/v1/sessions { agent_id }` → 201.
3. `POST /api/v1/sessions/{id}/runs { content: [{ type: "text", text: "مرحبا" }] }`
   → 202; on `/rt/sessions` (`subscribe { session_id }`) the events arrive in
   the order `sessions.createRun` declares, ending in `run.completed` with the
   final message, or `run.failed` whose `error` is Hermes's own text (a
   missing provider key reads exactly like that).
4. `POST /api/v1/agents/{hermes id}/restart` → 202 and a `job.completed` on
   `/rt/jobs`; the gateway log shows a stop and a fresh start.
5. `docker compose restart hub` — the session list, the transcript and the
   Hermes home are all still there.

The same checklist runs in the repository against a real gateway with
`HERMES_E2E=1 HERMES_URL=http://127.0.0.1:8642 HERMES_API_KEY=… pnpm --filter @majlis/server exec vitest run --project unit src/modules/agents/hermes.e2e.test.ts`;
without those variables the test is skipped and says so.
