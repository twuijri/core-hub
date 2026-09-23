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
cp .env.example .env            # nothing in it is required
docker compose up -d            # pulls ghcr.io/twuijri/majlis:latest, or `--build` to build here
docker compose logs -f hub      # watch the first boot — the setup token is printed here
```

No password goes into `.env`: the owner account is created from the browser on first run
(§2, ADR 0011).

`docker-compose.yml` in the repository root is the reference stack. What it
sets:

| Variable | Meaning |
|---|---|
| `HUB_ADMIN_PASSWORD` | **Optional, unattended installs only.** Set before the first boot it creates the owner account `admin` with that password and skips the setup screen entirely. Read once and ignored afterwards. Leave it empty (the default) and first run happens in the browser (§2). |
| `DATA_DIR` | `/data` in the container, the named volume `hub-data`. SQLite database, JWT and Hermes API keys, coding agents, and `hermes/` (Hermes's home) all live here. |
| `PORT` / `HUB_PORT` | The hub listens on `8080` inside; `HUB_PORT` publishes it on the host. |
| `DATABASE_URL` | Optional PostgreSQL instead of the SQLite file. |

These four are the whole configuration (ARCHITECTURE invariant 5). There is
no variable for model provider keys either — they are added once on the Models
screen and the hub carries them to every agent (§3).

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

## 2. First run: creating the owner account

A fresh hub has no account at all. It is reachable on a public domain, so it
does not let whoever loads the page first create one: on boot it writes a random
**setup token** to `/data/setup-token.txt` (mode 0600) and prints it once in its
log, and only someone holding that token can create the owner (ADR 0011). This
is the model Jenkins uses with `initialAdminPassword`.

```bash
docker compose logs hub                                 # the token, printed once at boot
docker compose exec hub cat /data/setup-token.txt       # or read the file directly
```

The log line looks like this:

```
auth: first-run setup is required — no owner account exists yet.
Open the hub in a browser and paste this setup token: 9f2c7a41…
It is also in the data directory: /data/setup-token.txt
  docker compose logs hub          # this line again
  docker compose exec hub cat /data/setup-token.txt
A new token is generated on every restart until the owner account exists.
```

1. Open `http://<host>:8080` — the hub serves the web client from `/`. It shows
   **إنشاء حساب المالك / Create the owner account**, not the sign-in screen.
2. Paste the token, choose a username and a password (8 characters or more),
   optionally a display name and a name for the first workspace, and submit.
   You are signed in immediately; the token file is deleted and the screen is
   gone for good — a second attempt answers `409 conflict`.
3. From a terminal instead of a browser, the reference client does the same:

   ```bash
   majlis setup --server http://<host>:8080      # asks for the token and the password
   ```

   Neither client accepts the token or the password as a command-line flag.

Good to know:

- A **new token on every restart** while setup is still pending, so a token that
  leaked into an old log stops working.
- Wrong tokens are throttled by the same per-IP lockout as wrong passwords: five
  in fifteen minutes lock that IP for fifteen minutes (`GET /auth/lockouts`
  lists them; the admin can clear them once signed in).
- **Unattended installs** keep the old behaviour: set `HUB_ADMIN_PASSWORD` in
  `.env` before the first boot and the hub creates `admin` itself, writes no
  token and never shows the setup screen. The variable wins wherever it is set.
- If the hub already has an owner, `GET /api/v1/auth/setup` answers
  `{"required": false}` and the setup screen redirects to sign-in.

## 2b. Pairing a phone

Signed in: `POST /auth/pairings` shows a QR; the phone claims it and receives an
app token. Pairing codes expire in 5 minutes.

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

Hermes needs a model provider before it can answer, and so does every coding
agent you install later. You add one **once, on the Models screen** — Models →
*Add provider* → pick a preset (or *Custom* for your own OpenAI-compatible
endpoint), give it a base URL and, if it needs one, a key. The hub stores the
key encrypted under `/data/keys/data.key`, writes it into Hermes's own
`/data/hermes/.env`, restarts the gateway, and hands it to every coding agent
that declares the same credential family (ADR 0010). Nobody pastes a key twice,
and `hermes config` keeps working for anything the hub does not own.

`majlis providers presets` and `majlis providers add <preset>` do the same from
a terminal.

**Back up `/data/keys/data.key`.** It is the one file that cannot be
regenerated: without it every stored key reads as "there was a secret here".

## 3b. A model server on your own machine (LM Studio, Ollama, LiteLLM)

This is the one that catches people. The hub runs **inside a container**, so
`http://127.0.0.1:1234/v1` — the address LM Studio prints in its own window —
is the *container's* loopback and there is nothing listening on it. The Models
screen says so when you type such an address and suggests the one that works;
it never rewrites what you typed.

Use the host's name instead:

| Your server | What to give the hub |
|---|---|
| LM Studio on the host | `http://host.docker.internal:1234/v1` |
| Ollama on the host | `http://host.docker.internal:11434` |
| LiteLLM in another container on the same network | `http://<service name>:4000/v1` |

On **Docker Desktop** (macOS, Windows) that name already resolves. On a
**Linux host** it does not exist until the stack maps it, which is this line —
already in the repository's `docker-compose.yml`:

```yaml
services:
  hub:
    extra_hosts:
      - 'host.docker.internal:host-gateway'
```

Then make sure the server itself listens on more than loopback: LM Studio's
"Serve on local network", and `OLLAMA_HOST=0.0.0.0` for Ollama. A local server
usually needs no key at all; if yours is behind one (a LiteLLM master key, a
proxy), type it in the same dialog — the key field is always there, and the hub
never demands a key it was not told to expect.

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
| `/data/keys/hermes-dashboard.secret` | the session token of Hermes's dashboard API, which the hub starts on demand on the loopback (ADR 0015) |
| `/data/hermes/` | Hermes's home: `.env`, `config.yaml`, memories, skills, sessions, cron |
| `/data/agents/<id>/` | coding agents installed from the catalog |
| `/data/hermes-packages/` | optional Python packages Hermes installs the first time a feature needs them (Edge voices, Bedrock, Vertex …) |
| `/data/workspaces/<profile>/` | each chat's working folder |

Everything else in the image is **read-only** to the hub and to every agent it runs: the
hub's code in `/app` and Hermes's in `/opt/hermes` belong to root. An agent cannot change
the hub or Hermes, by mistake or because a page it read told it to; a change to either
comes with a new image. Recreating the container drops nothing you need — every file that
is written lives in `/data`.

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
