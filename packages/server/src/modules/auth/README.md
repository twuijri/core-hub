# auth

Owns users, roles (`owner`, `admin`, `member`), passwords, sign-in sessions, app tokens, QR
pairing, workspaces (the contract calls them profiles) and per-user preferences. Every operation
of the `auth` tag in `packages/contracts/openapi.yaml` is served here (`routes.ts`). Domain
model: `docs/domain/auth.md`.

## What other modules import (from `index.ts` only)

| Export                                                                   | Use                                                                                                                                                         |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requireUser`                                                            | preHandler: a signed-in person (JWT) **or** a valid app token; `401` otherwise                                                                              |
| `requireRole('admin' \| 'owner')`                                        | preHandler after `requireUser`; `admin` is satisfied by owner and admin; `403 forbidden` with `details.required_role`                                       |
| `requireAppToken`                                                        | preHandler: only a `hub_at_…` bearer (paired device / integration), never a web session                                                                     |
| `requireScope('read' \| 'write' \| 'device' \| 'admin')`                 | preHandler: JWT sessions hold every scope; app tokens must list it (`admin` implies all)                                                                    |
| `requireWorkspace`                                                       | preHandler: resolves `X-Hub-Profile` (slug or id) into `request.workspace` and checks the caller may enter it (ADR 0005); `404 profile_not_found` otherwise |
| `request.principal`                                                      | `{ kind: 'user' \| 'app_token', user: { id, username, role, status, locale }, tokenId, tokenKind, deviceId, scopes }` or `null`                             |
| `request.workspace`                                                      | `{ id, slug, name, isDefault }` after `requireWorkspace`; filter every scoped query by `.id`                                                                |
| `resolvePrincipal(ctx, bearer, ip)`                                      | the same resolution for non-HTTP entry points                                                                                                               |
| `findWorkspace`, `listWorkspacesFor`, `canEnter`, `resolveWorkspaceFor`  | workspace lookups without a request                                                                                                                         |
| `findUser`, `presentUser`                                                | existence check / contract `User` for a user id                                                                                                             |
| `registerWorkspaceStatsProvider(fn)`                                     | `agents`/`sessions` fill `Profile.agent_count` / `session_count`                                                                                            |
| `emitToUser(io, userId, namespace, event, payload, now)`, `userRoom(id)` | send a contract-shaped realtime envelope to one person's sockets                                                                                            |

Typical route in another module:

```ts
app.get('/sessions', { preHandler: [requireUser, requireWorkspace] }, async (request) => {
  const { workspace, principal } = request; // both non-null here
  …
});
```

Realtime: every namespace accepts `auth: { token }` in the Socket.IO handshake (the same
bearer as HTTP). An authenticated socket has `socket.data.principal` and is in the room
`user:<id>`; a socket without a token connects but joins no room; an invalid token is refused
with `connect_error` `unauthorized`.

## How it works

- **First boot** (`users.ts` `bootstrap`): with no user and `HUB_ADMIN_PASSWORD` set, the user
  `admin` (role `owner`) and the `default` workspace are created. The HS256 key for access
  tokens is created at `<DATA_DIR>/keys/jwt.secret` (mode 0600).
- **First run without that variable** (`setup.ts`, ADR 0011): the hub writes a random claim
  token to `<DATA_DIR>/setup-token.txt` (mode 0600) and logs it once with where to read it
  again; a fresh token on every boot until an owner exists, and the file is deleted the moment
  one does (on success, and at boot if it was left behind). `GET /auth/setup` answers
  `{ required }` and nothing more; `POST /auth/setup` compares the token in constant time
  (SHA-256 digests through `timingSafeEqual`), creates the owner and the `default` workspace in
  one transaction, deletes the file and answers the `TokenPair` of `auth.login`. Wrong tokens
  count on the **password** lockout row of the caller's IP — one throttle, one admin screen —
  and once an owner exists the operation is `409 conflict`, checked before the token is read.
  Sign-in on a hub with no user answers `401` with `auth.setup_required`.
- **Passwords**: Argon2id (`passwords.ts`, OWASP parameters).
- **Sign-in** (`POST /auth/login`): a `web` row in `app_tokens` is the rotating refresh token
  (SHA-256 stored, 30 days); the access token is a 15-minute JWT whose `sid` is that row. A
  revoked row (logout, password change on other sessions, admin reset) kills its access tokens
  immediately. `POST /auth/refresh` with a body rotates the refresh token in place; with an app
  token bearer and no body it renews a device token for 90 days and answers `refresh_token: null`.
- **App tokens** (`hub_at_…`): `personal` (created by the user with scopes) and `device`
  (issued by pairing, scopes `read write device`, 90 days). Plain text is returned once.
- **Pairing** (`pairing.ts`): `POST /auth/pairings` returns the code (`XXXX-XXXX`, no
  ambiguous characters) and the exact `qr_payload`; the phone calls
  `POST /auth/pairings/{id}/claim` once. One transaction creates the device row (through the
  `devices` module's `registerPairedDevice`), the device token and marks the code consumed;
  `pairing.claimed` and `device.linked` go to the creator's `user:<id>` room on `/rt/devices`.
  Re-pairing the same `device_key` updates the same device row and revokes its previous token.
- **Lockouts** (`lockouts.ts`): per IP and flow (`password`, `token`, `pairing`): five failures
  inside 15 minutes lock for 15 minutes; `429 rate_limited` with `Retry-After`; admins list and
  clear them.
- **Workspaces**: `X-Hub-Profile` carries the slug (or id). Owner and admin enter every
  workspace; a member enters exactly the ones in `workspace_members` — **none** when they have
  no rows (owner, 2026-09-24; contract decision §28). Nothing enrolls anyone implicitly: a new
  workspace is nobody's until an admin grants it. A member cannot be created, or an admin made
  a member, without a list (`auth.member_needs_profile`); a member refused for having no
  workspace at all hears `profile_not_found` with `details.reason = no_profile_granted`
  (`workspaceRefusal`). Deleting a workspace archives it and drops memberships, so a member
  whose only workspace it was is left with none; the cross-module purge is the owner-only job
  in `docs/domain/README.md`. Hubs from before the rule: `drizzle/0010_member_profiles_explicit.sql`.
- **Avatars** live under `<DATA_DIR>/avatars/{users,workspaces}/<id>` (PNG/JPEG ≤ 512 KB), not as
  knowledge attachments (those are workspace-scoped; users are global).
- **Audit**: `auth.login`, `auth.login_failed`, `auth.logout`, `auth.pairing_created`,
  `auth.pairing_claimed`, `auth.token_created`, `auth.token_revoked`, `auth.user_*`,
  `auth.password_changed`, `auth.profile_*` rows in `audit_events`.

## Temporary pieces (remove when their owner module lands)

- `audit-stub.ts`: writes `audit_events` and queues `jobs` rows with plain SQL because the
  `audit` module does not export `record()` / `createJob()` yet. `POST /profiles/{id}/export`
  and `POST /profile-imports` answer `202 { job_id }` with a `queued` job that no worker runs
  yet.
- `Profile.agent_count` / `session_count` are `0` until `agents` / `sessions` register a stats
  provider. `ProfileSettingsResult.restart_job_id` is `null` until agent runtimes exist.
- `Device.online` is `false` until the devices module keeps a socket registry.

## Errors this module adds

`token_expired` (401), `profile_not_found` (404), and the `auth.*` message keys in
`src/i18n/{ar,en}.json`; the `code` stays one of the contract's `ErrorCode` values.
