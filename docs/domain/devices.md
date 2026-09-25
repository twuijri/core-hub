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
| params | json | capability-specific (`location`: `accuracy: coarse \| precise`) |
| session_id, run_id | ulid? | the conversation / run waiting for it, if any |
| job_id | ulid → audit.job | the `device_request` job; it carries only `{request_id, status}` |
| status | enum(pending, fulfilled, denied, failed, expired, cancelled) | only `pending` is not final |
| expires_at | ms | `created_at + timeout_ms` (default 30 s); after it, `expired` with `timeout` |
| result | json? | what the device sent; a location is `{latitude, longitude, accuracy_m, captured_at}` |
| error | json? | `{code, message}`, code from `permission_denied \| unavailable \| timeout \| cancelled \| failed` |
| answered_at | ms? | when it became final |

Lifecycle: `pending → fulfilled | denied | failed | expired | cancelled`, once. A capability
the device did not declare, or switched off, is `denied` with `unavailable` by the hub at
creation. Expiry runs on a timer and again on every read (a restarted hub has no timers).

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
