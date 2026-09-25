# Core Hub push relay

A Cloudflare Worker that delivers a self-hosted hub's notices to the official Core Hub apps
(iOS `com.twuijri.corehub`, Android) with the owner's APNs and FCM keys. The keys live only
here, as Worker secrets; hubs never see them. A hub with no APNs/FCM credentials of its own
registers itself on first need and pushes through the relay with nothing to set.
Why and how: [ADR 0024](../../docs/adr/0024-push-relay.md), DECISIONS §82.

- **Storage**: one D1 database (`corehub-push-relay`). It holds hubs (id, salt, blocked, limits),
  token bindings (a SHA-256 of each token, never the token), rate-limit counters and request
  nonces. No message, title, body or device token is ever stored or logged.
- **Hub secrets are never stored**: each is derived from `HUB_SECRET_KEY` and the hub's salt.
- **Logs**: counters only (`{"evt":"push","sent":1,…}`).

## API (for the hub; `packages/server/src/modules/devices/relay.ts` speaks it)

| Route | Signed | What |
|---|---|---|
| `GET /v1/health` | no | `{ok, apns, fcm, registration}`: which keys are set, never their values |
| `POST /v1/hubs` | no | registers a hub: `201 {hub_id, secret}`; 5 per address per hour, 500 a day |
| `GET /v1/hubs/me` | yes | the hub's token count, limits and use |
| `POST /v1/tokens` | yes | binds `{platform, token, proof?}` to the hub; `409 bound_elsewhere` |
| `DELETE /v1/tokens` | yes | lets go of `{platform, token}` |
| `POST /v1/tokens/sync` | yes | `{tokens: [{platform, hash}]}`: keeps those, drops the rest, names the missing |
| `POST /v1/push` | yes | `{messages: [...]}` (1–40): `sent`, `failed`, `gone` (forgotten) or `not_bound` each |
| `GET /v1/admin/hubs/:id`, `POST …/block`, `POST …/unblock`, `PUT …/limits` | `Authorization: Bearer ADMIN_TOKEN` | the owner's switches |

Signed = headers `x-corehub-hub`, `x-corehub-timestamp` (±5 min), `x-corehub-nonce` (never
reused) and `x-corehub-signature`: hex HMAC-SHA256 with the hub's secret over
`corehub-relay-v1`, method, path, timestamp, nonce and the body's hex SHA-256, joined by `\n`.

## Deploy (the owner)

What the repository already has: the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
The token needs exactly: **Account → Workers Scripts: Edit**, **Account → D1: Edit**, and, for a
custom domain, **Zone → Workers Routes: Edit** on that domain's zone. Workers KV is not used.

1. **Choose the address.** Either a custom domain on a zone the token covers — set the repository
   variable `PUSH_RELAY_DOMAIN` to the hostname (Settings → Secrets and variables → Actions →
   Variables), with no DNS record at that name yet (Cloudflare makes it) — or nothing, for
   `https://corehub-push-relay.<your-subdomain>.workers.dev` (register the workers.dev subdomain
   once in the dashboard: Workers & Pages → your subdomain).
2. **Deploy.** Actions → **Push relay** → Run workflow (the `custom_domain` box overrides the
   variable). It runs the tests, creates the D1 database the first time, applies
   `migrations/`, and deploys. Run it again after any change to this folder.
3. **Set the keys, once**, from a machine with Node (the values go straight to Cloudflare; they
   are never in the repository or in GitHub):

   ```sh
   cd packages/push-relay
   export CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_ACCOUNT_ID=…
   W="npx --yes wrangler@4"
   $W secret put APNS_KEY_P8 < AuthKey_XXXXXXXXXX.p8
   printf %s 'XXXXXXXXXX'          | $W secret put APNS_KEY_ID      # the key's id
   printf %s 'YYYYYYYYYY'          | $W secret put APNS_TEAM_ID     # the Apple team id
   printf %s 'com.twuijri.corehub' | $W secret put APNS_BUNDLE_ID
   printf %s 'production'          | $W secret put APNS_ENV         # sandbox only for Xcode builds
   $W secret put FCM_SERVICE_ACCOUNT_JSON < firebase-service-account.json
   openssl rand -base64 32 | $W secret put HUB_SECRET_KEY           # never change it afterwards
   openssl rand -base64 32 | tee ~/corehub-relay-admin-token | $W secret put ADMIN_TOKEN
   ```

   A secret takes effect at once; no redeploy. `HUB_SECRET_KEY` derives every hub's secret:
   changing it cuts off every registered hub. To stop one hub, block it (below).
4. **Check it**: `curl https://<address>/v1/health` answers
   `{"ok":true,"apns":true,"fcm":true,"registration":true}`.
5. **Point the hubs at it.** Put the address in `DEFAULT_RELAY_URL`
   (`packages/server/src/modules/devices/relay.ts`) in a PR: every hub built after that pushes to
   phones with nothing to set. Until then, or for another relay, a hub sets
   `COREHUB_PUSH_RELAY_URL=https://<address>`. `COREHUB_PUSH_RELAY=off` turns it off on a hub.

## Running it

- Block a hub (its id is on that hub's Push senders status):
  `curl -X POST -H "Authorization: Bearer $(cat ~/corehub-relay-admin-token)" -d '{"reason":"spam"}' https://<address>/v1/admin/hubs/<hub_id>/block`;
  `…/unblock` to undo; `PUT …/limits` with `{"per_minute":300,"per_day":20000}` (or `null`) to
  change one hub's limits.
- Default limits (`[vars]` in `wrangler.toml`, proposed): 120 pushes a minute and 5000 a day per
  hub, 60 bindings a minute, 5 registrations per address per hour and 500 a day, and a binding
  unused for 30 days may be taken by another hub.
- Cost: on the free plan D1 allows 100,000 row writes a day; a push writes about three rows
  (two counters and a nonce), so roughly 30,000 pushes a day. Workers Paid lifts that.

## Develop

`pnpm --filter @corehub/push-relay test` runs the Worker in Node (it uses web APIs only) with D1
played by `node:sqlite` and APNs/FCM by a recording `fetch`; every key is generated in the test.
`wrangler dev` works for everything but APNs on some machines: APNs speaks HTTP/2 only, which a
deployed Worker's `fetch` negotiates and a local run may not.
