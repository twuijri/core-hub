# Mobile In-App Updates

The Core Hub Android test build can update itself from inside the app. The phone
never holds a GitHub token: it asks its own Core Hub server, and the server reads
the owner's private release with a token configured once, server side.

iOS is answered honestly rather than pretended: the check endpoint reports
`ios_not_supported`, and the download endpoint refuses with the same code.
TestFlight remains the iOS path.

## Endpoints

All four endpoints sit behind the normal authentication middleware, so the
device-bound App token the phone already carries is what authorizes them. No
separate update token exists.

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/api/studio/app-updates/mobile?platform=android&channel=test` | any authenticated caller |
| `GET` | `/api/studio/app-updates/mobile/download?platform=android&channel=test` | any authenticated caller |
| `GET` | `/api/studio/app-updates/settings?channel=test` | any authenticated caller (token masked) |
| `PUT` | `/api/studio/app-updates/settings?channel=test` | super administrator only |
| `DELETE` | `/api/studio/app-updates/settings/token?channel=test` | super administrator only |

`platform` defaults to `android`, `channel` defaults to `test`.

### Check

```json
{
  "available": true,
  "version": "1.4.0-test.37",
  "buildNumber": 37,
  "notes": "release body",
  "sizeBytes": 26214400,
  "publishedAt": "2026-09-18T10:00:00Z",
  "downloadPath": "/api/studio/app-updates/mobile/download?platform=android&channel=test"
}
```

`downloadPath` is always a server path. A GitHub URL is never handed to the
client, because the client has no credential for the private release.

When nothing is available the response is still HTTP 200 with
`available: false` and a `reason`:

| `reason` | Meaning |
| --- | --- |
| `not_configured` | The owner has not stored a GitHub token for this channel yet. |
| `no_build_published` | The release exists but carries no matching Android asset. |
| `ios_not_supported` | iOS cannot install a build from inside the app. |

### Download

Streams the APK as `application/vnd.android.package-archive` with
`Content-Length` and `Accept-Ranges: bytes`. A `Range` request is answered 206
with `Content-Range`, and an unsatisfiable range is answered 416, so a dropped
download resumes instead of restarting. The range is forwarded to GitHub and the
bytes are piped through; the file is never buffered in server memory. The
selected version and build number are also echoed as `X-Core-Hub-App-Version`
and `X-Core-Hub-App-Build`.

### Error codes

Failures carry a stable `code` the client can map to its own message. The update
source being unconfigured is never a 500.

| HTTP | `code` | Cause |
| --- | --- | --- |
| 409 | `updates_not_configured` | No GitHub token stored for the channel (download only). |
| 409 | `ios_not_supported` | Download requested for iOS. |
| 404 | `no_build_published` | No matching Android asset in the release. |
| 400 | `unsupported_platform` | `platform` is neither `android` nor `ios`. |
| 400 | `invalid_update_settings` | A rejected repository, tag, or channel on write. |
| 502 | `github_auth_failed` | GitHub answered 401/403 for the stored token. |
| 502 | `github_release_not_found` | GitHub answered 404 for repository or tag. |
| 502 | `github_unavailable` | Any other GitHub status, or GitHub was unreachable. |
| 503 | `github_rate_limited` | Rate limited; `retryAfterSeconds` and `Retry-After` are set. |

## Settings

Stored per update channel in the Studio database table `app_update_settings`,
next to the other Studio-owned settings. Secrets follow the same convention as
the STT and TTS provider settings: the stored value is returned only as the
`[stored]` marker, never echoed back.

| Key | Default | Notes |
| --- | --- | --- |
| `repository` | `twuijri/core-hub-test-builds` | `owner/name`; validated, no shell interpolation. |
| `releaseTag` | `latest-test-mobile` | The rolling tag the test track publishes to. |
| `githubToken` | — | Secret. A fine-grained token with read access to that private repository's contents. |

A channel counts as **configured** only once a token exists: the release is
private, so repository and tag alone cannot be read.

Writing:

```bash
curl -X PUT 'https://<server>/api/studio/app-updates/settings?channel=test' \
  -H 'Authorization: Bearer <super admin token>' \
  -H 'Content-Type: application/json' \
  -d '{"repository":"twuijri/core-hub-test-builds","releaseTag":"latest-test-mobile","githubToken":"<token>"}'
```

Sending `"[stored]"` (or omitting `githubToken`) keeps the stored token. Use
`DELETE /api/studio/app-updates/settings/token` to remove it.

## Asset selection

The Android build is published as `Core.Hub.Mobile-<version>-android.apk`. A
rolling release tag can end up holding more than one APK, so the server picks the
newest by version, then build number, then upload time — it never assumes a
single asset. The build number is the trailing counter of a prerelease segment
(`1.4.0-test.37` → `37`); a plain `1.4.0` reports `buildNumber: null` rather than
inventing one.

## Turning it on

1. Create a fine-grained GitHub token for the owner account with **Contents:
   read** on `twuijri/core-hub-test-builds` only.
2. `PUT /api/studio/app-updates/settings` as super administrator with that token.
3. Confirm with `GET /api/studio/app-updates/mobile?platform=android&channel=test`.

Nothing is stored in the image or in an environment variable, so the setting
survives an image replacement with the rest of the Studio database.
