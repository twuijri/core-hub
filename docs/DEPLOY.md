# Deploying Core Hub

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
git clone https://github.com/twuijri/core-hub && cd core-hub
cp .env.example .env            # nothing in it is required
docker compose up -d            # pulls ghcr.io/twuijri/core-hub:latest, or `--build` to build here
docker compose logs -f hub      # optional: watch the first boot
```

No password goes into `.env`, and no terminal is needed: open the hub in a browser within
the hour after it starts and create the owner account there (§2, ADR 0019).

`docker-compose.yml` in the repository root is the reference stack. What it
sets:

| Variable | Meaning |
|---|---|
| `HUB_ADMIN_PASSWORD` | **Optional, unattended installs only.** Set before the first boot it creates the owner account `admin` with that password and skips the setup screen entirely. Read once and ignored afterwards. Leave it empty (the default) and first run happens in the browser (§2). |
| `DATA_DIR` | `/data` in the container, the named volume `hub-data`. SQLite database, JWT and Hermes API keys, coding agents, and `hermes/` (Hermes's home) all live here. |
| `PORT` / `HUB_PORT` | The hub listens on `8080` inside; `HUB_PORT` publishes it on the host. |
| `DATABASE_URL` | Optional PostgreSQL instead of the SQLite file. |
| `COREHUB_SETUP_OPEN_MINUTES` | Optional. Minutes after the hub starts, while it has no owner, in which setup is open without the token. Default `60`; `0` = token only (§2). |
| `COREHUB_RESET_OWNER` | Optional, recovery only. `1` disables the owner on the next boot and reopens setup (§2). Remove it afterwards. |
| `COREHUB_TASK_AUTO_START_MAX` | Optional. How many task runs the hub starts **by itself** (a task's "Start automatically") at once in one profile; the rest wait their turn. Default `2`. A person's "Assign and start" is never held back by it. |
| `COREHUB_WEB_TERMINAL` | Optional, **off by default**. `1` gives the owner — and only the owner — a shell on this host from Settings → Terminal (§3c). Read the risk first. |
| `COREHUB_WEB_TERMINAL_IDLE_MINUTES` | Optional. A web terminal nobody types in closes after this many minutes. Default `15`. |

These nine are the whole configuration (ARCHITECTURE invariant 5). There is
no variable for model provider keys either — they are added once on the Models
screen and the hub carries them to every agent (§3).

**Push to phones (optional).** Browsers and the desktop app get notifications with nothing
to set: the hub makes its own Web Push keys in `/data/keys/vapid.json`. The official Android
(FCM) and iPhone (APNs) apps are reached through the **Core Hub push relay** (ADR 0024) once
the hub knows its address: nothing to set when the build has it built in, otherwise
`COREHUB_PUSH_RELAY_URL`. A hub that has its own credentials uses them instead — entered in
Device connections → Devices → Push senders, or these variables, which then win over Settings
(add them to the `environment:` of the service yourself; the reference file leaves them out):

| Variable | Meaning |
|---|---|
| `COREHUB_FCM_SERVICE_ACCOUNT` | The Firebase service-account JSON, or a path to the file inside the container. |
| `COREHUB_APNS_KEY_ID`, `COREHUB_APNS_TEAM_ID`, `COREHUB_APNS_BUNDLE_ID` | The APNs key's id, the Apple team id, the iOS app's bundle id (`com.twuijri.corehub`, docs/RELEASING.md). |
| `COREHUB_APNS_KEY` | The `.p8` key's contents, or a path to it. |
| `COREHUB_APNS_ENVIRONMENT` | `production` (default) or `sandbox` for development builds. |
| `COREHUB_PUSH_CONTACT` | A `mailto:` or `https:` contact push services may use (VAPID `sub`). |
| `COREHUB_PUSH_RELAY_URL` | The push relay's `https://` address, when it is not the one built in. |
| `COREHUB_PUSH_RELAY` | `off`: never use a push relay (phones then need the credentials above). |

Upgrading is `docker compose pull && docker compose up -d`; the volume is
untouched.

## 1a. Upgrading a stack from before the rename (Majlis → Core Hub)

The product was called Majlis until 2026-09-24 (ADR 0017). An existing stack upgrades by
replacing the image; `/data` is read as it is:

- **Image**: `ghcr.io/twuijri/core-hub:<tag>` (the old `ghcr.io/twuijri/majlis` gets no new
  tags). Change the `image:` line of the stack.
- **Container name**: the reference Compose file now says `container_name: core-hub`. Renaming
  it is optional; `docker compose up -d` recreates the container under the new name, and the
  volume (`hub-data`) is the same.
- **Environment**: nothing to change. A `MAJLIS_*` variable still works (the hub reads it when
  the `COREHUB_*` name is unset) and the log says once which name to use instead.
- **What the hub moves by itself** on its first boot: Hermes provider blocks `majlis-*` become
  `corehub-*`, with every `model.provider` (and fallback) that named them, in the root home and
  every profile; `MAJLIS_PROVIDER_*` keys in Hermes's `.env` become `COREHUB_PROVIDER_*`. The
  web keeps you signed in and keeps your preferences; the terminal client moves
  `~/.config/majlis/config.json` to `~/.config/corehub/` and still answers to `majlis`.

## 1b. Getting an image built

- **A release**: push a tag `v*` on `main`. The Release workflow builds for
  amd64 and arm64 and publishes `:<version>`, `:<major>.<minor>` and `:latest`.
- **A preview**: Actions → Release → *Run workflow*, pick the branch, give an
  image tag (`preview`, `test`, `0.1.0-rc.1` …) and the platforms. It
  publishes `ghcr.io/twuijri/core-hub:<that tag>` and refuses to touch `latest`,
  which belongs to release tags on `main` alone.

The number to watch is the compressed pull size, not what `docker image ls`
prints (`docs/ROADMAP.md` §Sizes).

## 2. First run: creating the owner account

A fresh hub has no owner. For the **first hour after the hub starts** (ADR 0019) setup
is open to whoever opens the site first — no token, no terminal:

1. Open `http://<host>:8080` (or your domain) — the hub serves the web client from `/`.
   It shows **إنشاء حساب المالك / Create the owner account** with a notice:
   **التسجيل مفتوح لأول شخص يفتح هذه الصفحة — أكمله الآن** / *Setup is open to whoever
   opens this page first — finish it now*, and the time left.
2. Choose a username and a password (8 characters or more), optionally a display name
   and a name for the first profile, and submit. You are signed in immediately, and setup
   is closed for good — a second attempt answers `409 conflict`, even inside the hour.
3. From a terminal instead of a browser, the reference client does the same (inside the
   hour it asks for no token):

   ```bash
   corehub setup --server http://<host>:8080
   ```

Finish it as soon as the stack is up: until the owner exists, anyone who reaches the
hub can create it. If somebody beats you to it, take the hub back (below).

**Missed the hour?** Restart the container (`docker compose restart hub`, or restart
it from your panel) — every start with no owner opens a fresh hour. Or use the setup
token: after the hour the screen asks for it and says where it is. The hub writes it
to `/data/setup-token.txt` (mode 0600) and prints it in its log on every start while
there is no owner:

```bash
docker compose logs hub                                 # the token, printed at boot
docker compose exec hub cat /data/setup-token.txt       # or read the file directly
```

```
auth: first-run setup is required — no owner account exists yet.
Setup is OPEN to whoever opens the hub first until 2026-09-25T10:00:00.000Z — finish it now.
After that the setup token below is required; restarting the hub opens a fresh window.
Setup token (when the window is closed): 9f2c7a41…
It is also in the data directory: /data/setup-token.txt
```

Good to know:

- `COREHUB_SETUP_OPEN_MINUTES` sets the window (default `60`). **`0` is the strict
  mode**: token only from the first second, as before ADR 0019.
- A **new token on every restart** while there is no owner, so a token that leaked into
  an old log stops working. Wrong tokens are throttled by the same per-IP lockout as
  wrong passwords: five in fifteen minutes lock that IP for fifteen minutes.
- Neither client accepts the token or the password as a command-line flag.
- **Unattended installs** keep the old behaviour: set `HUB_ADMIN_PASSWORD` in `.env`
  before the first boot and the hub creates `admin` itself, opens no window, writes no
  token and never shows the setup screen.
- `GET /api/v1/meta` says where first run stands: `setup_required` (no owner yet),
  `setup_open` and `setup_open_until` (the window).

### Somebody else created the owner first: take the hub back

You control the server, so you can switch the stranger off without losing anything:

1. Add `COREHUB_RESET_OWNER=1` to `.env` (the reference `docker-compose.yml` passes it
   through) or to the container's environment in your panel, and restart the hub.
2. On that boot the hub **disables the owner account** — it becomes a disabled admin, and
   every token and session it held is revoked; nothing is deleted — and logs it loudly
   (`*** auth: COREHUB_RESET_OWNER=1 — OWNER RESET ***`). Setup is open again for an hour.
3. Open the site and create the new owner, as above.
4. **Remove `COREHUB_RESET_OWNER`** and restart when convenient. Left in place it does not
   reset again — the marker `/data/owner-reset.json` records that the reset ran, and the log
   says the variable was ignored — but it should not stay set. A start without the
   variable removes the marker, so a future reset works again.

Other accounts (admins, members) are untouched; until the new owner exists nobody can
sign in. In **Settings → Users** the new owner can re-enable the old owner's account
(as an admin) or delete it.

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

`corehub providers presets` and `corehub providers add <preset>` do the same from
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
| `/data/hermes-packages/` | optional Python packages Hermes installs the first time a feature needs them (Edge voices, Bedrock, Vertex, and the Matrix, Feishu, DingTalk, Teams and Google Chat channels …). Telegram's, Discord's and Slack's clients are not among them: they ship in the image |
| `/data/hermes/…/scripts/whatsapp-bridge/` | a profile's copy of Hermes's WhatsApp bridge (about 220 KB), made by the hub before the profile's gateway or the pairing screen starts it; its `node_modules` is a link to the dependencies the image ships, so linking a phone downloads nothing |
| `/data/workspaces/<profile>/` | each chat's working folder |

Linking Telegram, WhatsApp, Discord or Slack needs no download from PyPI or npm: their
dependencies are in the image (docs/changes/2026-09-25-twuijri-image-channel-deps.md,
docs/changes/2026-09-25-twuijri-more-channels.md); Mattermost and Email need nothing beyond
Hermes. Matrix's library did not fit the image-size budget: Hermes downloads it once, the first
time a Matrix channel starts, so that first start needs PyPI. A
profile that linked WhatsApp before keeps the bridge Hermes installed in it until a new image
changes the bridge; then its copy is replaced by the link.

Everything else in the image is **read-only** to the hub and to every agent it runs: the
hub's code in `/app` and Hermes's in `/opt/hermes` belong to root. An agent cannot change
the hub or Hermes, by mistake or because a page it read told it to; a change to either
comes with a new image. Recreating the container drops nothing you need — every file that
is written lives in `/data`.

## 3c. The owner's web terminal (off by default)

Settings → Terminal («الطرفية») is a shell on the hub's host, in the browser. It exists only when
the stack sets it, and only the **owner** account sees it — not admins, not members (owner,
2026-09-25). To turn it on, add to the hub's environment and recreate the container:

```yaml
    environment:
      COREHUB_WEB_TERMINAL: '1'
      # COREHUB_WEB_TERMINAL_IDLE_MINUTES: '15'
```

Turn it off by removing the line: the page and the entry disappear, and the hub refuses every
attempt, even the owner's.

**The risk, plainly.** Whoever signs in as the owner from a browser gets a shell as the hub's own
user (`hub`, uid 10001 — never root) with everything that user can reach:

- all of `/data`: the database (users, conversations, audit log), the JWT signing key, the
  encrypted provider keys and the key that decrypts them, Hermes's home and its `.env`, every
  profile's files and every coding agent's home;
- the network the container is on, and whatever it can reach;
- the processes the hub runs — Hermes's gateways, agents — and their environment (the same user
  can read `/proc/<pid>/environ`).

It cannot change the hub's or Hermes's code (`/app` and `/opt/hermes` are root's and read-only;
`scripts/image-sealed-check.mjs` checks it from a terminal shell), cannot become root, and cannot
reach the host outside the container unless the stack mounted something into it (a Docker
socket, a host folder). So the owner's password is now as valuable as a shell on the server:
use a long one, keep the hub behind HTTPS, and leave the terminal off when you do not need it.

What limits it: the owner only, and only from a signed-in browser (an app token — a paired phone,
an integration — is refused); three terminals at once; each closes after the idle timeout; and
every start and end is written to the audit log (Settings → Logs, `terminal.opened` /
`terminal.closed`: who, when, in which folder, why it ended). What is typed is not recorded.

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
`HERMES_E2E=1 HERMES_URL=http://127.0.0.1:8642 HERMES_API_KEY=… pnpm --filter @corehub/server exec vitest run --project unit src/modules/agents/hermes.e2e.test.ts`;
without those variables the test is skipped and says so.
