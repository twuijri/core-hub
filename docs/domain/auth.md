# auth

Owns: `workspace`, `workspace_member`, `user`, `app_token`, `pairing_code`,
`login_lockout`. Schema: `packages/server/src/modules/auth/schema.ts`.

Global tables: all except `workspace_members`. Base columns (`id`,
`owner_id`, `created_at`, `updated_at`, and `workspace` on scoped tables) are
described in `README.md` and omitted below.

Types: `ulid` = text(26); `ms` = epoch milliseconds; `json<T>` = text holding
JSON; `enum(...)` = text + CHECK.

## workspace (global)

The scope every request names in `X-Hub-Profile` (ADR 0005).

| column | type | meaning |
|---|---|---|
| slug | text(64), unique | header-safe name; the header may carry the slug or the id, middleware resolves it once |
| name | text(120) | display name |
| description | text? | |
| color, icon | text? | client chrome |
| avatar_mime | text(64)? | MIME of the avatar file under `<DATA_DIR>/avatars/workspaces/<id>`; null = generated avatar |
| is_default | bool | the workspace a new token or device opens first; exactly one row is true |
| settings | json<WorkspaceSettings> | `defaultAgent`, `hermesProfile` (which Hermes profile this workspace drives), `defaultModel` (the contract's `Profile.default_model`), `hub` (the contract's `ProfileSettings`) |
| archived_at | ms? | archive |

Indexes: `workspaces_slug_uq`.

## user (global)

| column | type | meaning |
|---|---|---|
| username | text(64), unique | login name |
| display_name | text(120)? | |
| role | enum(owner, admin, member) | one owner (created at first start, invariant 5) |
| status | enum(active, disabled) | disabled users keep their rows and tokens are rejected |
| password_hash | text | Argon2id. Never returned, never logged |
| password_changed_at | ms? | informational; sessions are invalidated by revoking their `app_tokens` rows, which kills their access tokens at once |
| locale | enum(ar, en) | server-side localisation of notifications |
| avatar_mime | text(64)? | MIME of the avatar file under `<DATA_DIR>/avatars/users/<id>`; null = generated. Not a knowledge attachment: attachments are workspace-scoped, users are global |
| default_workspace_id | ulid? → workspace (FK, set null) | |
| preferences | json<UserPreferences> | the contract's `Preferences` object as stored by `PUT /auth/me/preferences` |
| last_login_at | ms? | shown in the users screen |

Indexes: `users_username_uq`.

## workspace_member (scoped)

Which members may use which workspace. Owner and admin need no rows.

The rows are the whole answer for a member (owner, 2026-09-24): **no rows means no
workspace**, never "every workspace". Nothing adds a row implicitly — creating a workspace
enrolls nobody, and archiving one deletes its rows, so a member whose last workspace is
archived is left with none. A member is created with at least one row (`POST /auth/users`
refuses an empty list for `role: member`), and turning an admin into a member names the
list in the same request. An admin may still withdraw every row explicitly (`PATCH` with
`profiles: []`): the member can sign in and enters nothing; every scoped request answers
`profile_not_found` with `details.reason = no_profile_granted`, and the web shows "ask an
admin". Hubs from before this rule were migrated by `drizzle/0010_member_profiles_explicit.sql`
(contract decision §29): each member with no rows was enrolled in every workspace that
existed and was not archived at upgrade time, and in nothing created afterwards.

| column | type | meaning |
|---|---|---|
| user_id | ulid → user (FK, cascade) | |

Indexes: unique (workspace, user_id); `user_id`.

## app_token (global)

Bearer tokens for every client. The token is shown once at creation.

| column | type | meaning |
|---|---|---|
| user_id | ulid → user (FK, cascade) | |
| kind | enum(personal, device, web) | `device` tokens are issued by pairing and bound to a device; `web` rows are the rotating refresh tokens of sign-in sessions (the access JWT's `sid` points at one) |
| name | text(120) | label in the list |
| token_hash | text(64), unique | SHA-256 of the bearer token |
| token_prefix | text(8) | display only |
| scopes | json<string[]> | empty = full access of the user's role |
| device_id | ulid? → devices.device | for `device` tokens |
| expires_at, last_used_at, revoked_at | ms? | revoked tokens are kept for the audit trail and deleted on demand |

Indexes: `token_hash` unique; (user_id, revoked_at).

## pairing_code (global)

One QR pairing attempt. The QR payload is `{ hubUrl, code }` and is never
stored.

| column | type | meaning |
|---|---|---|
| code | text(12), unique | short code, also typeable |
| created_by_user_id | ulid → user (FK, cascade) | who showed the QR |
| initial_workspace_id | ulid? → workspace (FK, set null) | what the phone opens first |
| connection | enum(lan, relay) | how the device reaches the hub (the contract's `PairingConnection`) |
| hub_url | text(512) | origin the web client used; the QR payload tells the phone to call it |
| expires_at | ms | typically 5 minutes (60–900 s) |
| consumed_at | ms? | set when a device redeems it |
| cancelled_at | ms? | set by `DELETE /auth/pairings/{id}` while pending |
| device_id | ulid? → devices.device | the device created on redeem |
| app_token_id | ulid? → app_token (FK, set null) | the device token issued |

Lifecycle: `pending → claimed | expired | cancelled` (the contract's `Pairing.status`, computed
from `consumed_at`, `cancelled_at`, `expires_at`); expired rows older than a day are deleted by a sweeper.

## login_lockout (global)

Also counts wrong first-run setup tokens under `kind = password` (ADR 0011): one
throttle for every guessable secret an unauthenticated caller can try.

| column | type | meaning |
|---|---|---|
| subject_kind | enum(ip, user) | |
| subject | text(128) | the IP or the user id |
| kind | enum(password, token, pairing) | which flow failed (the contract's `Lockout.kind`) |
| failures | int | consecutive failures inside the window (15 min); 5 lock for 15 min |
| last_failure_at, locked_until | ms? | |

Indexes: unique (subject_kind, subject, kind). Rows are deleted when unlocked.

## channel_identity (global)

A messaging account a person proved is theirs (contract decision §79): `user_id` (the person,
cascade), `platform` (`telegram` | `whatsapp`), `sender_id` (the account as Hermes names the
sender — Telegram's numeric id, WhatsApp's chat id), `last_used_at`. Unique on
(`platform`, `sender_id`): one link per account for the hub. The one-time link codes are not
stored: they live in memory (hashed, ten minutes, once, one per person).

## Queries the clients need

- Login: `users` by username → verify hash → issue `app_token`.
- Me: `users` by id + `workspace_members` for the member's workspaces (none when
  they have no rows; all workspaces for owner/admin), ordered by `is_default desc, name`.
- Users screen (admin): all users with `last_login_at`, plus each user's
  workspaces (one query on `workspace_members`).
- Locked IPs screen (admin): `login_lockouts where locked_until > now`.
- Tokens screen: `app_tokens where user_id = me and revoked_at is null`.
- Pairing: create code → device redeems → server creates `device`,
  `app_token(kind=device)` and marks the code consumed in one transaction.
- Every request: resolve `X-Hub-Profile` → workspace id (cached), check
  membership, attach `workspace` to the request context.

## Not in the database

The first-run claim token lives in `<DATA_DIR>/setup-token.txt` (mode 0600), never in a table:
it exists only while no user row does, and the file is deleted when the owner is created
(ADR 0011, `modules/auth/setup.ts`).

## Not stored

- Plain tokens and passwords (hashes only).
- Web login cookies (a `web` app token is the session).
- Client IPs beyond the throttled subject.
