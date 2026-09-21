# ADR 0011 — First-run setup in the browser, behind a claim token

Status: accepted (2026-09-22)

## Context
Until now the owner account came from one environment variable:
`HUB_ADMIN_PASSWORD` in `docker-compose.yml`, read once on first boot. That
means the owner's password is typed into a `.env` file on the server and stays
there, readable by anything that can read the file, present in backups, and
easy to forget and never change. The owner's direction (2026-09-22) is the
behaviour every professional self-hosted system has: install it, open the site,
and create the account there.

The constraint that makes this hard: a Majlis hub is published on a public
domain behind a reverse proxy. "No owner exists yet, so let whoever asks create
one" — open onboarding — means the first stranger who loads the URL becomes the
owner of the instance, with every agent, key and session that follows. Between
`docker compose up -d` and the operator opening the browser there is a window,
and on a crawled domain that window is not theoretical.

## Decision
First run is a **claim token**, the model Jenkins uses with
`initialAdminPassword`.

1. On boot, when no user exists **and** `HUB_ADMIN_PASSWORD` is unset, the hub
   generates 24 random bytes, writes them as hex to
   `<DATA_DIR>/setup-token.txt` with mode `0600`, and logs the token once at
   info level together with where to read it again. A new token is generated on
   every boot while setup is still pending, so a token that leaked into an old
   log stops working at the next restart. The file is deleted the moment an
   owner exists — on a successful setup, and at boot when the owner is already
   there (a leftover file from an earlier state is removed).
2. Two unauthenticated operations in the `auth` tag (contract decision §26):
   - `GET /auth/setup` → `{ required }`, one boolean and nothing else. It never
     reveals the token, and never says whether a token file exists.
   - `POST /auth/setup` takes the token, a username, a password, and optionally
     a display name and a workspace name; creates the owner and the `default`
     workspace in one transaction; deletes the token file; and answers the same
     `TokenPair` `auth.login` answers, so the client is signed in at once.
3. The token is compared in constant time (SHA-256 digests through
   `timingSafeEqual`, so no length is leaked). Failures count on the **same**
   per-IP `login_lockout` row as wrong passwords (`kind: password`): five
   failures in fifteen minutes lock the IP for fifteen minutes, visible in the
   admin's locked-IPs screen. Once an owner exists the operation is
   `409 conflict`, checked before the token is read, so a replay is
   indistinguishable from a guess.
4. The password policy is the one the rest of `auth` enforces (8 characters or
   more, Argon2id), and the username has the same shape as any other.
5. `HUB_ADMIN_PASSWORD` keeps working, unchanged, for unattended installs: with
   it set, the owner exists at the end of first boot, `auth.getSetup` answers
   `false`, and no token is ever written. **Precedence:** the variable wins; the
   wizard exists only where the variable is absent.
6. Clients: the web client gets a pre-auth `/setup` screen (Arabic first with
   full RTL, English beside it) that says in the screen itself where to read the
   token; sign-in redirects to it while setup is required, and it redirects to
   sign-in once it is not. The reference client gets `majlis setup --server URL`
   with the same flow. Neither accepts the token or the password as a command
   line argument or a URL parameter.

## Rejected
- **Open onboarding** ("first visitor creates the owner"). It hands a public
  instance to whoever loads it first, and the owner cannot tell it happened.
  Every mitigation for it is a worse version of the token: a time window after
  boot (a restart re-opens it, and a crash loop opens it repeatedly), an
  allow-list of source addresses (breaks behind Caddy, breaks for the owner on
  a phone), a first-visitor-wins cookie (no proof of anything).
- **Keeping `HUB_ADMIN_PASSWORD` as the only way.** It is the thing the owner
  asked to stop doing; it stays as the unattended path, not the normal one.
- **A second rate-limit mechanism** for setup attempts. The login lockout
  already exists, already has an admin screen and an API; setup reuses it.
- **A fifth environment variable** (`HUB_SETUP_TOKEN`, an operator-chosen
  token). It re-creates the problem — a secret in the compose file — and it
  would break ARCHITECTURE invariant 5's four variables.
- **Hiding the token prompt in the terminal.** The hub printed the token in its
  own log; a paste the operator cannot read back is a paste they cannot check.
  The password prompt is hidden, and asked twice.

## Consequences
- A fresh install needs no secret in `.env`: `docker compose up -d`, read the
  token from the log, open the site, create the account. `.env.example` and
  `docker-compose.yml` no longer set `HUB_ADMIN_PASSWORD`.
- Invariant 5 still holds with four variables, but the admin password is now
  optional: "a data directory, and for an unattended install an admin password".
- A hub whose data directory is unreadable to the operator (a volume they
  cannot exec into and whose logs they do not keep) cannot be set up. That is
  the point; `HUB_ADMIN_PASSWORD` remains for those installs.
- Setup failures and password failures share one lockout row per IP, so a burst
  of wrong tokens also delays sign-in from that IP for fifteen minutes. Accepted:
  it is the same attacker and the same protection, and the owner can clear it
  from the locked-IPs screen once signed in.
