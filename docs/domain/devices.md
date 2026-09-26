# devices

Owns: `device`, `device_request`, `push_credential` (moved here from notify on 2026-09-25,
same table; contract decision §66). Schema:
`packages/server/src/modules/devices/schema.ts`. `devices` is global (a
device belongs to a user); `device_requests` is scoped. Base columns omitted.

Realtime namespace `/rt/devices`: `device.online`, `device.offline`, `device.updated`,
`device.linked`, `device.unlinked`, `request.created` (to the addressed device only: its
sockets join `device:<id>`), `request.completed` (to the person, whose sockets include the
device's).

The `device://` rule: an agent that needs the phone's camera, microphone,
clipboard or location asks the hub; the hub sends a capability request to one paired
device, the device answers, the result stays in the request for the waiting run
(contract decisions §14, §74).

## device (global)

| column | type | meaning |
|---|---|---|
| device_key | text(128) | stable id the device generated once; re-pairing updates the same row (unique with `owner_id`) |
| name | text(120) | "Pixel 9", "Work laptop" |
| platform | enum(android, ios, web, macos, windows, linux) | the contract's `DevicePlatform` |
| kind | enum(phone, tablet, computer, browser) | |
| brand, model | text? | |
| os_version, app_version | | shown in the devices screen; drives update checks |
| connection | enum(lan, relay) | how the device reaches the hub |
| push_provider | enum(none, fcm, apns, webpush) | |
| push_token | text? | **ENCRYPTED** (sealed with the data key as `{v,c,n,k}` JSON). FCM token, APNs hex token, or a Web Push subscription as JSON; refreshed by the client; cleared on revoke and when the service says it is dead |
| push_locale, push_registered_at | | the contract's `PushStatus` |
| capabilities | json<DeviceCapability[]> | `{ kind, enabled, consentAt }` per `CapabilityKind` (location, camera, microphone, notifications, clipboard, screen, files, apps, calendar, reminders, health) |
| profiles | json<string[]>? | the profiles whose agents may ask it; null = every profile of its person (DECISIONS §89). Only the person changes it |
| helper | json<DeviceHelper>? | what a computer's local helper offers agents, as the desktop app reported it: shared folders (the default `~/Core Hub` marked), opening allowed, programs switched on with their profiles and tools (ADR 0025). Only the device writes it; null while the helper is off |
| status | enum(paired, revoked) | |
| app_token_id | ulid? → auth.app_token, unique | the device token issued at pairing |
| paired_at, last_seen_at, revoked_at | | |

`owner_id` is the user the device belongs to. Indexes: (owner_id, status);
(owner_id, device_key) unique; `app_token_id` unique.

A browser (or the desktop app signed in with a web session) registers itself with
`devices.register`: `app_token_id` stays null and its `device_key` is one it keeps in local
storage. Created otherwise by the auth module's pairing claim through this module's public
`registerPairedDevice()`; revoked through `revokeDeviceByToken()` when the
pairing token is revoked (`packages/server/src/modules/devices/index.ts`).

Lifecycle: `paired → revoked` (terminal; revoking also revokes the app
token). Deleting a revoked device is allowed.

## device_request (scoped)

The contract's `DeviceRequest`. Replaced `device_command` (migration `0022`), a design that
was never written to.

| column | type | meaning |
|---|---|---|
| owner_id | ulid → user | the person who asked (only a device's own person may ask it) |
| device_id | ulid → device (FK, cascade) | the one device asked |
| capability | enum(`CapabilityKind`) | location, camera, microphone, … |
| purpose | text? | shown in the device's consent sheet |
| params | json | capability-specific (`location`: `accuracy: coarse \| precise`; `files`: `{tool, arguments}`; `apps`: `{op: call, program, tool, arguments}` or `{op: status, call_id}`, §89) |
| session_id, run_id | ulid? | the conversation / run waiting for it, if any |
| job_id | ulid → audit.job | the `device_request` job; it carries only `{request_id, status}` |
| status | enum(pending, fulfilled, denied, failed, expired, cancelled) | only `pending` is not final |
| expires_at | ms | `created_at + timeout_ms` (default per capability: `files` 60 s, `apps` 120 s, others 30 s); after it, `expired` with `timeout` |
| result | json? | what the device sent; a location is `{latitude, longitude, accuracy_m, captured_at}` |
| error | json? | `{code, message}`, code from `permission_denied \| unavailable \| timeout \| cancelled \| failed` |
| answered_at | ms? | when it became final |

Lifecycle: `pending → fulfilled | denied | failed | expired | cancelled`, once. A capability
the device did not declare, or switched off, is `denied` with `unavailable` by the hub at
creation; a `files`, `apps` or `screen` request to a device with no live socket is `failed` with
`unavailable` ("offline") at creation. An agent's run may ask its own person's device for
`files` and `apps` only (the request's `run_id` is the run's), from a profile the device serves
(§89). Expiry runs on a timer and again on every read (a restarted hub has no timers).

Indexes: (device_id, status, created_at) for the device's catch-up; (workspace, owner_id,
created_at).

## push_credential (global)

| column | type | meaning |
|---|---|---|
| provider | enum(fcm, apns, webpush), unique | |
| label | text(120) | |
| ciphertext | text | **ENCRYPTED**. FCM service-account JSON / APNs `.p8`; empty for Web Push |
| nonce | text(32) | **ENCRYPTED (metadata)** |
| key_id | text(32) | the data key version that sealed it |
| public_meta | json<Record<string,string>> | project id, client email, key id, team id, bundle id, environment; Web Push `subject` |
| enabled | bool | |
| last_error | text? | |

Settings only: the environment (`COREHUB_FCM_*`, `COREHUB_APNS_*`) wins over a row. The Web
Push keys are not here: they are the hub's own, in `${DATA_DIR}/keys/vapid.json`.

## push_relay (global, one row)

The Core Hub push relay as this hub knows it (ADR 0024, DECISIONS §82; migration `0027`).

| column | type | meaning |
|---|---|---|
| url | text(500)? | the relay this registration is with; another address registers again |
| hub_id | text(64)? | this hub's id at the relay (not a secret) |
| ciphertext / nonce / key_id | text? | **ENCRYPTED**. The secret the relay gave this hub; it signs every call |
| enabled | bool | the admin's switch (`devices.setPushRelay`); `COREHUB_PUSH_RELAY=off` wins |
| private_push | bool | only a generic title and the notice id go through the relay |
| state | enum(ready, not_registered, unreachable, blocked, rate_limited)? | what the last call said |
| last_error, checked_at | text?, ts? | |
| synced_at | ts? | when the hub last re-stated every token it wants bound (`/v1/tokens/sync`) |

FCM or APNs with no credentials on this hub (environment or Settings) is delivered through the
relay, unless it is off; local credentials always win. A phone's token is bound to this hub at
the relay when it registers; what the hub lets go of reaches the relay through the next sync
(on an unregister or unlink at once, otherwise within a minute when the set of tokens changed,
and once a day regardless).

## Linked hubs (ADR 0026, DECISIONS §101; migration `0031`)

| table | scope | what it holds |
|---|---|---|
| peer_identity | global, one row | this hub's hub id and Ed25519 key pair; the private key **ENCRYPTED** with the data key ring |
| peers | global | another hub: its hub id, names, HTTPS origin, `direction` (inbound/outbound), `status` (pending/waiting/linked), `enabled`, its **public** key and fingerprint, `asks_per_hour`, `last_seen_at`, `approved_at`. Deleting the row is revoking the link |
| peer_invites | global | an invite: only the SHA-256 of its code, `expires_at` (10 minutes), `used_at` (single use) |
| peer_nonces | global | nonces of signed calls taken, until their timestamp leaves the 5-minute window |
| peer_shares | scoped | an agent in a profile linked hubs may ask (`shared`, off unless a row says so) and the description they see; the row id is the id peers see |
| peer_events | global | the audit log per peer, kept after it is deleted; never a question's words |

## Push

`notify` hands a written notice to the push port when the kind's `push` switch is on and the
moment is outside quiet hours; `pushFor(app).sendToUser()` sends to every `paired` device of the
person with a push registration and answers per device. See contract decision §66.

## Queries the clients need

- Devices screen: `devices where owner_id = me` (owner/admin: all), with
  online state from the socket registry and the channel subscription
  (updates module).
- Device app on connect: `device_requests where device_id and status = pending` to catch
  up (`devices.listRequests?status=pending`), then subscribe.
- Requester: request by id; the job ends when the device answers.
- Revoke: set status/revoked_at, revoke the app token (auth API), emit
  `device.offline`.

## Not stored

- Socket ids, online/offline state: the socket registry in memory; the
  database keeps only `last_seen_at`.
- Media bytes: attachments (knowledge).
- Location history: a location result is returned to the requester and kept
  only inside that request row — never in its job, which every member of the profile sees.
