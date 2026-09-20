# notify

Owns: `notification`, `notification_delivery`, `notification_preference`,
`webhook`, `webhook_delivery`, `push_credential`. Schema:
`packages/server/src/modules/notify/schema.ts`. All scoped except
`push_credentials` (global). Base columns omitted.

Other modules never insert here; they call `notify.emit(kind, recipient,
entity, data)` and `notify.event(name, payload)`; notify fans out to in-app,
push (per device) and webhooks according to preferences and subscriptions.

## notification (scoped)

`owner_id` is the recipient.

| column | type | meaning |
|---|---|---|
| kind | enum(approval_requested, question_asked, run_completed, run_failed, task_assigned, task_moved, mention, handoff, schedule_failed, workflow_waiting, device_command, update_available, system) | |
| severity | enum(info, warning, error, action_required) | `action_required` = an approval or question is waiting |
| title | text(200) | localised to the recipient's locale at creation |
| body | text? | |
| entity_kind, entity_id | text(32)?, ulid? | deep-link target |
| data | json<NotificationData> | route, id, extras |
| read_at, dismissed_at | ms? | |

Indexes: (workspace, owner_id, read_at, created_at) for the inbox and badge;
(entity_kind, entity_id) to resolve a waiting approval when it is answered.

## notification_delivery (scoped)

| column | type | meaning |
|---|---|---|
| notification_id | ulid → notification (FK, cascade) | |
| channel | enum(in_app, push, webhook) | |
| device_id | ulid? → devices.device | push |
| status | enum(queued, sent, failed, skipped) | skipped = muted by preference |
| attempts | int | |
| provider_ref | text(200)? | FCM/APNs message id |
| last_error | text? | |
| sent_at | ms? | |

Lifecycle: `queued → sent | failed | skipped` (all three terminal; retries
increment `attempts` while queued).

Indexes: `notification_id`; (status, created_at) for the sender loop.

## notification_preference (scoped)

| column | type | meaning |
|---|---|---|
| kind | text(32) | a notification kind or `*` |
| in_app, push | bool | |
| muted_until | ms? | quiet period |

Unique (workspace, owner_id, kind).

## webhook (scoped)

| column | type | meaning |
|---|---|---|
| name | text(120) | |
| url | text | |
| signing_secret_id | ulid? → models.secret | HMAC-SHA256 key; null = unsigned |
| events | json<string[]> | realtime event names to forward |
| headers | json<Record<string,string>> | non-secret |
| enabled | bool | |
| failure_count | int | consecutive; auto-disable at a threshold |
| last_status | int? | HTTP status |
| last_delivered_at | ms? | |
| archived_at | ms? | |

## webhook_delivery (scoped)

| column | type | meaning |
|---|---|---|
| webhook_id | ulid → webhook (FK, cascade) | |
| event_name | text(64) | |
| payload | json | the event payload as sent |
| status | enum(queued, delivered, failed, dead) | dead = retries exhausted |
| attempts, response_status, last_error | | |
| next_attempt_at | ms? | exponential backoff cursor |
| delivered_at | ms? | |

Lifecycle: `queued → delivered`; `queued → failed → queued` (retry) `→ dead`.
Terminal: delivered, dead.

Indexes: (webhook_id, created_at); (status, next_attempt_at).

## push_credential (global)

| column | type | meaning |
|---|---|---|
| provider | enum(fcm, apns, webpush), unique | |
| label | text(120) | |
| ciphertext | text | **ENCRYPTED**. Service-account JSON / APNs .p8 / VAPID private key |
| nonce | text(32) | **ENCRYPTED (metadata)** |
| key_id | text(32) | |
| public_meta | json<Record<string,string>> | project id, team id, key id, bundle id, VAPID public key |
| enabled | bool | |
| last_error | text? | |

## Queries the clients need

- Inbox: `notifications where owner_id = me` in the workspace, unread first;
  badge = count unread with `severity = action_required` shown separately.
- Mark read / dismiss: by id, owner-checked.
- Preferences screen: rows for the user, defaults filled from `*`.
- Webhooks screen: webhooks with last status and recent deliveries; "redeliver"
  re-queues a delivery row.
- Admin push setup: one row per provider with `[stored]` masks.

## Not stored

- Push payload bodies (rebuilt from the notification at send time).
- Device push tokens (on `devices`).
- Webhook responses beyond status and error text.
