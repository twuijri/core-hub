# ADR 0024 — A central push relay on Cloudflare Workers holds the owner's APNs and FCM keys

Status: **accepted in direction, details proposed — owner to confirm** (2026-09-26). The owner
chose a central relay on Cloudflare Workers («ايه ابدا ونعتمد على Cloudflare Workers»); the
choices below marked *proposed* are the implementer's. Builds on DECISIONS §66 (push is the
devices module's).

## Context
Core Hub is self-hosted. The iOS app (`com.twuijri.corehub`) and the Android app are the
owner's: they receive pushes only through his Apple team's APNs key and his Firebase project.
Until now a hub could push to phones only if its admin pasted those two credentials into it,
which means the owner sending his keys to every person who runs a hub. He does not want that
(«لا ابيه جاهز للناس مهب كل مره برسله لهم»): other people's hubs must get phone push with no
setup, and his keys must never leave his control. Baking them into the image is out: anyone
could extract them and push to every user of the apps.

This is the problem Bitwarden's, Home Assistant's and Mattermost's push proxies solve: the app
vendor runs one small service that holds the keys; self-hosted servers ask it to deliver.

## Decision
1. **A relay the owner runs on Cloudflare Workers** (`packages/push-relay`, a workspace package
   so the repository's lint, typecheck and tests cover it). His APNs `.p8`, key id, team id,
   bundle id and environment, and his FCM service account are **Worker secrets** he sets with
   `wrangler secret put`. They exist nowhere else.
2. **APNs from a Worker.** APNs accepts HTTP/2 only. A deployed Worker's `fetch` negotiates
   HTTP/2 with `api.push.apple.com` (reported working in production by others, e.g.
   `cloudflare/workerd` issue 4841, whose failure was `wrangler dev` on macOS only), so the relay
   uses plain `fetch` with an ES256 provider token signed by WebCrypto — no library, no TCP
   socket. *Not verified by us against Apple yet*: nothing was deployed in this change; the
   owner's first deploy is the check (README §Deploy step 4, then a test push from a hub).
   FCM HTTP v1 uses an RS256 assertion (WebCrypto) exchanged for an OAuth token, cached until a
   minute before it ends.
3. **Storage: D1** (*proposed*). What the relay keeps needs strong consistency and atomic
   first-come-wins: token bindings under a primary key, rate-limit counters incremented with an
   upsert, and request nonces that must be refused the second time. KV is eventually consistent
   (a binding or a nonce written in one place may not be visible in another for up to a minute),
   allows one write per key per second, and its free plan writes 1,000 keys a day. D1 is SQLite:
   one consistent primary, `INSERT … ON CONFLICT`, 100,000 row writes a day free.
4. **Zero-setup registration.** `POST /v1/hubs` gives any hub an id and a secret, with no approval,
   limited to 5 per address per hour and 500 a day (*proposed*). **The secret is never stored**:
   it is `HMAC(HUB_SECRET_KEY, id + salt)`, and D1 keeps only the salt, so a copy of the database
   cannot sign anything. (The brief said "stored hashed"; a hash cannot verify an HMAC, and
   deriving is stronger than storing a hash — *proposed*.) The address is kept only as a keyed
   hash inside an hourly counter.
5. **Every hub call is signed**: HMAC-SHA256 with the hub's secret over a fixed prefix, method,
   path, a unix timestamp (±5 minutes), a nonce (refused if seen in the last ten minutes) and the
   body's SHA-256. The hub keeps its secret sealed with its data key, like every other secret.
6. **Binding.** A token is bound to the first hub that binds it (*first come wins*); another
   hub's bind is `409 bound_elsewhere` and its pushes to it answer `not_bound`. The relay keeps
   only `SHA-256(platform:token)`. A binding moves to another hub when:
   - the hub that holds it lets it go — it does on unregister, unlink, and through
     **`/v1/tokens/sync`**: a hub states every token it still wants, the relay drops the rest.
     Every clean-up on the hub (sign-out, revoked sign-in, disabled person, re-pair, a token
     FCM/APNs called dead; docs/changes/2026-09-26-twuijri-push-cleanup-mobile-logs.md) reaches
     the relay this way, on the next registration change or, while it sends, every 10 minutes;
   - **the device proves itself** (*proposed*): the app makes a P-256 key once per install and
     signs `corehub-push-bind-v1`, platform, token and a timestamp; the hub forwards it
     (`PushRegistration.relay_proof`). The first proof recorded for a token fixes its key; a newer
     proof from the **same key** moves the binding (the most recent registration wins), an older
     one or another key does not. The iOS and Android apps send it since 2026-09-27
     (DECISIONS §107);
   - or the binding went **30 days** without a push or a sync from its hub (a hub that is gone
     for good) (*proposed*).

   *Risk, documented*: a hub that is still running and was the first to learn a token (the
   phone signed in to it) can keep that token until it lets go, the device proves itself with a
   key the first hub never recorded, or 30 days pass. A malicious hub could also record a key of
   its own invention on first bind, so the device's real key cannot move it before the 30 days.
   Both cost only push to that one phone from its next hub, and only from a hub its owner
   chose to sign in to. Closing it fully needs device attestation (App Attest / Play Integrity),
   which is not worth it now.
7. **Sending**: a hub pushes only to tokens bound to it, at most 40 per request, within per-hub
   limits of 120 a minute and 5,000 a day (*proposed*; the owner can change one hub's limits).
   A refused request does not count. APNs `410`/`Unregistered` and FCM `UNREGISTERED`/404 (and
   `INVALID_ARGUMENT` about the token itself) forget the binding and answer `gone`, and the hub
   forgets the token too. `BadDeviceToken` does not (a sandbox build's token on a production
   relay).
8. **The owner's switches**: `ADMIN_TOKEN` guards `/v1/admin/hubs/:id` (read), `block`, `unblock`
   and `limits`; without it those routes do not exist. A blocked hub's calls answer `403
   blocked`; the hub shows it and stops offering FCM/APNs to its apps.
9. **Privacy**: the relay never stores or logs a payload, title, body, data or token; its logs
   are counters. By default (*proposed*) the hub sends the notice's title and body so a
   notification is readable. **Private push** (a hub setting, off by default) sends only a
   generic «إشعار جديد في كور هب» / "New notice in Core Hub", the notice id and its kind; the app
   opens the notice from its hub.
10. **The hub** uses the relay for FCM or APNs exactly when it has no credentials of its own for
    that platform (environment or Settings); local credentials always win, so the owner's hub may
    keep its keys. The relay's address is built in (`DEFAULT_RELAY_URL`, empty until the owner
    deploys) and overridable with `COREHUB_PUSH_RELAY_URL`; `COREHUB_PUSH_RELAY=off` or the
    admin's switch turn it off. Its status (ready / not registered / unreachable / blocked /
    rate-limited / off / no address) and private push are on each FCM/APNs row of
    `devices.listPushSenders`; `devices.setPushRelay` changes them.
11. **Deploy** is a manual `workflow_dispatch` in `.github/workflows/push-relay.yml` with the
    repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the relay's tests run on
    every PR that touches it. The owner's hostname is not committed: the workflow takes it from an
    input or the repository variable `PUSH_RELAY_DOMAIN`.

## Alternatives rejected
- **Keys in the image**: extractable by anyone; one leak pushes to every user.
- **Each admin brings keys**: impossible for the official apps (they are the owner's) and the
  thing the owner asked to end.
- **A server the owner hosts himself**: another machine to keep up; Workers has no server,
  scales to zero and is free at this size.
- **KV**: see 3. **Durable Objects**: consistent, but more moving parts than one SQL database
  for counters and bindings this small.
- **The relay auto-binding on first push** (no bind step): simpler, but a hub could claim any
  token it learned by pushing to it; an explicit bind with the same rules is no harder.

## Consequences
- A hub with no keys gets phone push once `DEFAULT_RELAY_URL` holds the owner's address, with
  nothing to set; a hub with keys is unchanged.
- The owner runs one Worker and one D1 database, and can see (counts) and block any hub.
- Notice titles and bodies pass through Cloudflare and Apple/Google in transit unless private
  push is on — as they already pass through Apple/Google for a hub with its own keys.
- A phone that moves hubs without signing out of the old one gets push from the new hub at once
  when its app sends the device proof (DECISIONS §107) and the old binding recorded that key; an
  older app, or a binding made without a proof, waits until the old hub lets go or 30 days pass.
