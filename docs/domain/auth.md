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
| is_default | bool | the workspace a new token or device opens first; exactly one row is true |
| settings | json<WorkspaceSettings> | `defaultAgent`, `hermesProfile` (which Hermes profile this workspace drives) |
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
| password_changed_at | ms? | tokens issued before it are rejected |
| locale | enum(ar, en) | server-side localisation of notifications |
| avatar_attachment_id | ulid? → knowledge.attachment | |
| default_workspace_id | ulid? → workspace (FK, set null) | |
| preferences | json<UserPreferences> | theme, showReasoning, showCost, compact |
| last_login_at | ms? | shown in the users screen |

Indexes: `users_username_uq`.

## workspace_member (scoped)

Which members may use which workspace. Owner and admin need no rows.

| column | type | meaning |
|---|---|---|
| user_id | ulid → user (FK, cascade) | |

Indexes: unique (workspace, user_id); `user_id`.

## app_token (global)

Bearer tokens for every client. The token is shown once at creation.

| column | type | meaning |
|---|---|---|
| user_id | ulid → user (FK, cascade) | |
| kind | enum(personal, device, web) | `device` tokens are issued by pairing and bound to a device |
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
| expires_at | ms | typically 5 minutes |
| consumed_at | ms? | set when a device redeems it |
| device_id | ulid? → devices.device | the device created on redeem |
| app_token_id | ulid? → app_token (FK, set null) | the device token issued |

Lifecycle: `open → consumed | expired`; expired rows are deleted by a sweeper.

## login_lockout (global)

| column | type | meaning |
|---|---|---|
| subject_kind | enum(ip, user) | |
| subject | text(128) | the IP or the user id |
| failures | int | consecutive failures |
| last_failure_at, locked_until | ms? | |

Indexes: unique (subject_kind, subject). Rows are deleted when unlocked.

## Queries the clients need

- Login: `users` by username → verify hash → issue `app_token`.
- Me: `users` by id + `workspace_members` for the member's workspaces (or all
  workspaces for owner/admin), ordered by `is_default desc, name`.
- Users screen (admin): all users with `last_login_at`, plus each user's
  workspaces (one query on `workspace_members`).
- Locked IPs screen (admin): `login_lockouts where locked_until > now`.
- Tokens screen: `app_tokens where user_id = me and revoked_at is null`.
- Pairing: create code → device redeems → server creates `device`,
  `app_token(kind=device)` and marks the code consumed in one transaction.
- Every request: resolve `X-Hub-Profile` → workspace id (cached), check
  membership, attach `workspace` to the request context.

## Not stored

- Plain tokens and passwords (hashes only).
- Web login cookies (a `web` app token is the session).
- Client IPs beyond the throttled subject.
