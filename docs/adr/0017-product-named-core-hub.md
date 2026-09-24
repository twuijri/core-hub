# ADR 0017 — The product is named Core Hub

Status: accepted (2026-09-24, owner: «وريبو المجلس نخليه هو كور هب ونغير كل شي الى كور هب
داخليا وحتى الريد مي», then «المجلس خلاص يختفي اسم المجلس ونخلي الامج اسمها core-hub»).
Supersedes: the product-name decision of `docs/changes/2026-09-23-twuijri-product-name.md`
(the name Majlis, the three frozen identifiers, and "no compatibility layer").
Builds on: ADR 0004 (clean room) — only the name is shared with the owner's older product.

## Context
The product was called Majlis («مجلس»). On 2026-09-24 the owner renamed the repository to
`twuijri/core-hub` and asked for everything else to follow: the name people read, the code's
own identifiers, the docs, and the image, which the release workflow already publishes as
`ghcr.io/twuijri/core-hub` because it is named after the repository.

The owner's older app used the same name. This is a name only: nothing of that app's code
is used here (ADR 0004 still holds, word for word).

The 2026-09-23 record had prepared a rename as "one edit" with **no** compatibility layer,
because the owner was the only user. By 2026-09-24 there is a test stack running an image,
with Hermes configs, browser sessions and archives written under the old names; the owner
asked that an image-only upgrade keeps booting and keeps working.

## Decision
1. **The name.** English **Core Hub**, Arabic **«كور هب»**. Every screen, page title, the
   CLI's help, notifications, `meta.get`'s default name, the OpenAPI `info` and the docs say
   it. In Arabic UI text that means "the hub" generically, the word is «المركز», as the
   English says "the hub".
2. **The identifiers.** One lowercase id, `corehub`, drives the conventions
   (`packages/contracts/src/product.ts` §`derived`): packages `@corehub/*`, the command
   `corehub`, environment variables `COREHUB_*`, browser keys `corehub.*`, the config folder
   `~/.config/corehub`, the run-files folder `.corehub/`, the webhook header
   `X-CoreHub-Signature`, the pairing type `corehub.pairing`, Hermes provider blocks
   `corehub-<slug>` and the minted key variables `COREHUB_PROVIDER_<SLUG>_API_KEY`. The
   repository, the image and the Compose container are `core-hub`. Design tokens use the
   `ch` prefix (`--ch-*`) instead of `mj`.
3. **Every old name keeps working** (`LEGACY` in the same file), read and never written:
   - `MAJLIS_*` environment variables are read when the new name is unset, and the hub or
     the CLI says once which name to change;
   - the CLI keeps `majlis` as an alias command, moves `~/.config/majlis/config.json` on its
     first read, and accepts a `majlis.pairing` code;
   - the web client moves `majlis.*` browser keys to `corehub.*` once, before anything reads
     them, so nobody is signed out and no preference is lost;
   - access tokens signed under the issuer `majlis` are accepted (new ones say `corehub`);
   - Hermes `config.yaml` blocks named `majlis-*` are still the hub's: every write replaces
     them with the `corehub-*` block and rewrites every value that named the old block
     (`model.provider`, a fallback, an auxiliary task…), so a profile whose model says
     `majlis-custom-cli-proxy-api` keeps answering; the `.env` loses `MAJLIS_PROVIDER_*` and
     the old marker line in the same write, at boot or on the next save;
   - a profile archive carrying `majlis-providers.json` (format `majlis-providers`) imports.
4. **One identifier stays `majlis` for good:** `STABLE.idNamespace`, the seed of the
   deterministic profile and owner ids. Changing it changes every derived id silently. It is
   a hash seed nobody reads.
5. **What does not move:** Hermes session refs already stored (`majlis-<session>`) stay as
   Hermes knows them; new conversations get `corehub-<session>`. A run's old `.majlis/`
   folder in a working directory is left where it is; new runs write `.corehub/`. The data
   volume's name (`hub-data`) never carried the product name and is unchanged.
6. **History is not rewritten.** Change records and earlier ADRs keep the name they were
   written under.

## Alternatives rejected
- **Rename with no compatibility layer** (the 2026-09-23 plan). It signs everyone out and,
  worse, leaves a profile whose model names `majlis-…` answering "Unknown provider" until a
  person finds and edits the file.
- **Keep the internal identifiers as `majlis` and rename only the display name.** The owner
  asked for the internal names to change too, so that nobody working on the code meets two
  names for one product.
- **Change the id seed too.** Every profile would get a new id on the next boot and the hub
  would stop finding its own rows, without an error.

## Consequences
- An image-only upgrade boots with an existing `/data`. A stack that sets `MAJLIS_*`
  variables keeps working and is told once, in the log, which names to change. Its Compose
  file should say `ghcr.io/twuijri/core-hub` and may rename the container to `core-hub`.
- Webhook receivers must verify `X-CoreHub-Signature`; webhooks deliver only the test event
  today, so no receiver depends on the old header.
- The compatibility code is listed in `LEGACY`; removing an entry removes the code that reads
  it, once nothing can still say the old name.
