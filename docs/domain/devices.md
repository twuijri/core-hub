# devices

Owns: `device`, `device_command`. Schema:
`packages/server/src/modules/devices/schema.ts`. `devices` is global (a
device belongs to a user); `device_commands` is scoped. Base columns omitted.

Realtime namespace `/rt/devices`: `device.online`, `device.offline`,
`device_command.queued` (to the device), `device_command.completed` (to the
requester).

The `device://` rule: an agent that needs the phone's camera, microphone,
clipboard or location asks the hub; the hub queues a command for a paired
device, the device answers, the result becomes an attachment or a JSON
payload for the waiting run.

## device (global)

| column | type | meaning |
|---|---|---|
| name | text(120) | "Pixel 9", "Work laptop" |
| platform | enum(android, ios, web, desktop, cli) | |
| os_version, app_version | | shown in the devices screen; drives update checks |
| push_provider | enum(none, fcm, apns, webpush) | |
| push_token | text? | **ENCRYPTED**. Registration token; refreshed by the client |
| capabilities | json<DeviceCapabilities> | camera, microphone, location, clipboard, notifications, tts, localApps |
| status | enum(paired, revoked) | |
| app_token_id | ulid? → auth.app_token, unique | the device token issued at pairing |
| paired_at, last_seen_at, revoked_at | | |

`owner_id` is the user the device belongs to. Indexes: (owner_id, status);
`app_token_id` unique.

Lifecycle: `paired → revoked` (terminal; revoking also revokes the app
token). Deleting a revoked device is allowed.

## device_command (scoped)

| column | type | meaning |
|---|---|---|
| device_id | ulid → device (FK, cascade) | |
| kind | enum(capture_photo, record_audio, read_clipboard, write_clipboard, open_url, locate, speak, show_notification, custom) | |
| payload | json | kind-specific arguments |
| status | enum(queued, sent, acked, completed, failed, expired, cancelled) | |
| requested_by_kind | enum(user, agent, workflow) | |
| requested_by_id | ulid? | user, agent or workflow_run |
| run_id | ulid? → sessions.run | the run waiting for the answer |
| result | json? | |
| result_attachment_id | ulid? → knowledge.attachment | photo / recording |
| error | text? | |
| sent_at, completed_at | ms? | |
| expires_at | ms | after which the run gets a `device_timeout` error |

Lifecycle: `queued → sent → acked → completed | failed`; `queued | sent →
expired`; `queued | sent | acked → cancelled`. Terminal: completed, failed,
expired, cancelled.

Indexes: (device_id, status, created_at) for the device's queue; `run_id`.

## Queries the clients need

- Devices screen: `devices where owner_id = me` (owner/admin: all), with
  online state from the socket registry and the channel subscription
  (updates module).
- Device app on connect: `device_commands where device_id and status in
  (queued, sent)` to catch up, then subscribe.
- Requester: command by id; the run resumes when `completed`.
- Revoke: set status/revoked_at, revoke the app token (auth API), emit
  `device.offline`.

## Not stored

- Socket ids, online/offline state: the socket registry in memory; the
  database keeps only `last_seen_at`.
- Media bytes: attachments (knowledge).
- Location history: a `locate` result is returned to the requester and kept
  only inside that command row.
