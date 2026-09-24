# ADR 0019 — First-run setup is open for an hour after boot; a reset takes the hub back

Status: accepted (2026-09-25). Supersedes the token-only rule of ADR 0011; the
rest of ADR 0011 (the token itself, its file, its lockout, `HUB_ADMIN_PASSWORD`)
stands.

## Context
ADR 0011 made the claim token the only way to create the owner: the hub writes it
to `<DATA_DIR>/setup-token.txt`, logs it, and `/setup` asks for it. In practice
reading a token from a container log or a file is the hard part of installing Core
Hub for many people — the ones who install from a hosting panel and never open a
terminal. Big self-hosted products leave the first registration open instead.

The owner's direction (2026-09-25):

> «ابي طريقة … التسجيل الاول مفتوح … اول ما تخلص حتى لو ثواني ولقطه بوت انت الي
> تتحكم تقدر تطفيه»

— first registration open; if a bot grabs it in the seconds before you finish, you
control the server and can switch it off. On how long it stays open:

> «ايه خله ساعة»

ADR 0011 rejected exactly this ("a time window after boot … a restart re-opens it").
What changed is the recovery: whoever controls the server can now take the hub back
with one variable and a restart, without losing data. With that, the risk ADR 0011
guarded against becomes an inconvenience the operator can undo, and the token stays
as the fallback.

## Decision
1. **The open window.** When the hub process starts and there is no owner, setup
   is open for `COREHUB_SETUP_OPEN_MINUTES` (default **60**): `POST /auth/setup`
   creates the owner from a username and a password, with **no token**. The web
   screen and `corehub setup` ask for no token inside it.
2. **After the window** setup needs the claim token, exactly as ADR 0011 describes.
   The token is still generated on every such boot, written to the file and logged,
   so it is there when the window has ended. **Restarting the container opens a
   fresh window** — that is the no-terminal way back into setup.
3. **One setting.** `COREHUB_SETUP_OPEN_MINUTES=0` is the strict mode: token only,
   from the first second. There is no separate `COREHUB_SETUP_MODE`; one number
   covers both (0–1440).
4. **Clients know the mode.** `meta.get` (unauthenticated) gains `setup_open` and
   `setup_open_until`; `setup_required` remains the "needs an owner" bit. The setup
   screen shows either the open form — saying it is open to whoever opens the page
   first, «التسجيل مفتوح لأول شخص يفتح هذه الصفحة — أكمله الآن», with the time left —
   or the token field with where to find the token. When the countdown ends the
   screen asks the hub again and switches to the token. Contract decision §44.
5. **Once an owner exists** setup is closed for good (`409`). Two setups racing
   inside the window are serialized: "no owner yet" is checked again inside the
   transaction that creates the owner, so exactly one wins.
6. **Recovery: `COREHUB_RESET_OWNER=1` and a restart.** On that boot, before
   anything else asks whether an owner exists:
   - every owner account is **disabled** and stepped down to **admin**, and every
     token and session it holds is revoked. Nothing is deleted. The step down is
     what lets the new owner re-enable or delete the old account from Users — an
     owner row cannot be changed by anyone;
   - setup is open again, with a fresh window;
   - the hub logs it at warning level, naming the disabled accounts;
   - it runs **once**: a marker `<DATA_DIR>/owner-reset.json` records when it ran
     and which owner ids it disabled. While the marker exists the variable is
     ignored (and the log says so), so the new owner is not reset by a variable
     left in the compose file. A boot without the variable removes the marker,
     arming it for a future reset. The marker is written even when there was no
     owner to disable, so a variable set on the very first boot cannot reset the
     owner who is created next.
   - Other accounts (admins, members) stay as they were. Until the new owner
     exists the hub is in setup: sign-in answers `auth.setup_required`.
7. **`HUB_ADMIN_PASSWORD` is unchanged**: on an empty hub it creates `admin` as the
   owner on first boot, and no window or token exists. It acts only on an empty
   hub — after a reset the old accounts are still there, so setup is the way.

## Rejected
- **Keeping token-only.** It is what the owner asked to stop making the default.
  It stays available as `COREHUB_SETUP_OPEN_MINUTES=0`.
- **Open for ever until an owner exists.** A hub installed and forgotten would stay
  claimable indefinitely; an hour covers "install, then open the site".
- **Two variables** (`COREHUB_SETUP_OPEN_MINUTES` plus `COREHUB_SETUP_MODE=token`).
  `0` minutes already says "token only"; a second switch could contradict the first.
- **Deleting the old owner on reset.** It is irreversible, and "somebody grabbed my
  hub" may be a misunderstanding; disabling is enough and the new owner decides.
- **A reset that runs on every boot while the variable is set.** The next boot
  would reset the rightful new owner; hence the marker.
- **A marker keyed only to the owner id.** After the reset the owner is a new id,
  so "reset whenever the current owner is not the one in the marker" would reset
  the new owner on the next boot. The marker's presence is the key; the ids in it
  are the record of what was done.

## Consequences
- A fresh install needs no terminal: `docker compose up -d`, open the site within
  the hour, create the account. Missed the hour: restart the container.
- The window is a real exposure for up to an hour on a public domain. The screen
  says so and asks to finish now; the operator who loses the race has the reset.
- Invariant 5 now counts six operator variables (`DATA_DIR`, `PORT`,
  `DATABASE_URL`, `HUB_ADMIN_PASSWORD`, `COREHUB_SETUP_OPEN_MINUTES`,
  `COREHUB_RESET_OWNER`; `COREHUB_VERSION` is stamped by the image); none of them
  is required.
- Docs: `docs/DEPLOY.md` §2 (first run, reset), `docs/STATUS.md` "First run", the
  README's quick start, `packages/server/src/modules/auth/README.md`.
