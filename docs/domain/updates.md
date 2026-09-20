# updates

Owns: `release_channel`, `release`, `channel_subscription`. Schema:
`packages/server/src/modules/updates/schema.ts`. All global (ADR 0005:
updates are an admin surface). Base columns omitted.

The hub is the update source for its own clients: a device asks "latest for
my platform on my channel", compares versions, and downloads the artifact
from `artifact_url` (a GitHub release asset or a file the hub serves).

## release_channel (global)

| column | type | meaning |
|---|---|---|
| key | text(32), unique | `stable`, `test`, `dev` — what clients send |
| name, description | | |
| is_default | bool | channel for devices with no subscription |
| enabled | bool | |

## release (global)

| column | type | meaning |
|---|---|---|
| channel_id | ulid → release_channel (FK, cascade) | |
| platform | enum(android, ios, desktop_linux, desktop_macos, desktop_windows, web, server) | |
| version | text(32) | semver; unique (channel, platform, version) |
| build_number | int? | Android versionCode / iOS build |
| notes_ar, notes_en | text? | release notes in both languages (team rule §4) |
| artifact_url | text? | |
| artifact_sha256, artifact_size_bytes | | verified by the client after download |
| min_server_version | text(32)? | the client refuses to install if the hub is older |
| mandatory | bool | client blocks until updated |
| published_at | ms? | null = draft |
| yanked_at | ms? | pulled; never offered again, row kept |

Indexes: unique (channel_id, platform, version); (channel_id, platform,
published_at) for "latest".

## channel_subscription (global)

| column | type | meaning |
|---|---|---|
| device_id | ulid → devices.device, unique | |
| channel_id | ulid → release_channel (FK, cascade) | |
| last_reported_version | text(32)? | what the device last said it runs |
| last_checked_at | ms? | |

## Queries the clients need

- Check: subscription for the device (or default channel) → latest
  `published_at is not null and yanked_at is null` release for the platform →
  compare with the reported version → `{ update?: release }`.
- Admin releases screen: releases grouped by channel and platform, drafts
  and yanked marked.
- Device screen: which channel each device follows; switch = upsert the
  subscription.

## Not stored

- Artifact bytes (external URL or the data directory's `releases/` folder,
  referenced by URL).
- Download counts: an audit event per check is enough.
