# ADR 0030 — Subscription sign-ins through the bundled CLIProxyAPI

Status: **Accepted** by the owner, 2026-09-30 (his explicit decision after the research in
`docs/research/cliproxy-signin-2026-09.md`, PR #230). The details are DECISIONS §143; those listed
there as "proposed — owner to confirm" are the implementer's choices inside this decision. Amends
ADR 0029 §1 ("no OAuth credential is ever given to it"; "Hermes-held subscriptions are not lent").

## Context
Before this, a provider used by signing in to an account (a ChatGPT, xAI, MiniMax or Nous
subscription) was signed in to through Hermes (DECISIONS §55): Hermes kept the credential, the
hub's own `direct` agent borrowed it for one turn (§118), and the model gateway of ADR 0029 never
served it to another agent. The owner wants one place for every account he signs in to, with the
tooling CLIProxyAPI already has: usage, what is left, when it resets, each account's errors, many
accounts per vendor, renew and sign in again.

The research found that CLIProxyAPI 8.0.4 signs in to Claude, ChatGPT/Codex, Google Antigravity,
xAI, Kimi (both), Meta and Devin; by a short code only for xAI, Kimi and Meta through its
management API, ChatGPT by a short code only as a command-line flag, the rest by a browser
redirect to a `localhost` address. It also set out the vendors' terms. The owner's answer: every
provider connected by signing in moves to CLIProxyAPI; providers connected by key stay as they
are; the hub does not block or judge any vendor — at most one short neutral sentence says some
vendors limit subscription use outside their own apps; people decide.

## Decision

### 1. CLIProxyAPI's management API is on, for the hub alone
The process the hub already runs for the gateway (ADR 0029 §7) now has its management API on:
loopback only (`allow-remote: false`), a random secret the hub makes at start and keeps in
memory, its control panel and its panel updater off. Everything else stays as ADR 0029 set it.
The hub's `models` module wraps it (`gateway/cliproxy-management.ts`) and is the only caller.

### 2. A subscription is a provider row; its accounts are CLIProxyAPI's
A subscription picked in "Add a provider" (since DECISIONS §146 in the one provider list, tagged
«Subscription»; first a tab of its own) adds a provider row from a gateway preset (`chatgpt-subscription`,
`claude-subscription`, …). Its sign-in is CLIProxyAPI's own:
- **a short code** where CLIProxyAPI has one — xAI, Kimi, Meta through the management API, and
  ChatGPT by running `cli-proxy-api -codex-device-login -no-browser` as a child process, the way
  the hub runs an agent's own device-code sign-in (§106);
- **a link** otherwise — Claude, Google Antigravity, Devin: the person opens the vendor's page,
  signs in, and pastes the `localhost` address the browser lands on back into the hub
  (`models.completeProviderSignIn`), which works on a server with no browser.

Each approved sign-in adds an account to CLIProxyAPI's store (one `0600` file per account under
`<DATA_DIR>/gateway/cliproxy-auth/`); the hub marks it as the row's (`prefix` `h<row>`, a `note`)
so the gateway's `h<row>/<model>` reaches exactly that row's accounts, round-robin, an account
that hit its limit cooling until its reset while the others answer. No token passes through the
hub. The row's models are the ones CLIProxyAPI serves its accounts; they reach every agent through
the gateway, and the hub's own `direct` agent too.

### 3. The provider's dialog reads CLIProxyAPI
Per account: status, the last error in the vendor's words, when it is tried again, request counts
(totals and 10-minute buckets), and — for Claude and ChatGPT — the usage windows with reset times
the vendor's own answers carried. "Check now" asks the vendor's usage address through
CLIProxyAPI's `api-call` (the account's token is put in by CLIProxyAPI and never leaves it); those
addresses are the vendors' undocumented ones, so a reading that fails says so and changes
nothing. Actions: renew, turn off/on, sign out, sign in another account.

### 4. Hermes uses the hub's models
Amended 2026-09-30 by DECISIONS §144: there is no switch; every hub whose gateway is available
routes Hermes through it, and the native route at the end of the fallback chain is gone. As
first written ("Hermes uses Core Hub's models", one switch per hub): each provider row the gateway serves becomes
one `providers:` block at that row's own gateway address, on the model's own wire (Anthropic
Messages for Claude models, so Hermes keeps prompt caching; Responses for OpenAI and ChatGPT;
Chat Completions otherwise), with a long-lived per-profile token signed by the hub. A new hub
with a gateway starts on it; a hub that already has providers keeps Hermes as it is until the
owner switches. Switching back removes only the blocks the hub wrote.

### 5. Hermes's own sign-ins are legacy
They keep working for every row already added. ChatGPT and xAI rows offer "Move to Core Hub's
gateway" (a new sign-in — a refresh token is never copied between two holders — and the model
choices follow once it is approved). Nous Portal and MiniMax stay Hermes's: CLIProxyAPI cannot
sign in to them. The borrowed-credential paths (`signed-in-chat.ts`, the Hermes half of
`live-models.ts`, the `codex` protocol of the image scripts, most of `sign-in.ts`) are removed in
a later change once the owner's live hubs have moved (§143 "Removal plan").

## Consequences
- The hub runs vendor sign-ins it did not run before, with the vendors' own CLI clients as
  CLIProxyAPI presents them. Terms are the person's call; the hub says one neutral sentence.
- CLIProxyAPI now starts at boot when a subscription is signed in (it renews tokens only while it
  runs) and, since §144, on every hub whose gateway is available, because Hermes uses it.
- A pin bump of CLIProxyAPI must keep the management calls the hub makes; the real-binary test
  (`subscriptions.real.test.ts`, in the required `model-gateway-real` job) drives each of them.
- No image or installer size change: CLIProxyAPI is already in both (ADR 0029).

## Alternatives
- **Keep sign-ins in Hermes** (as before): no usage, quota or per-account errors, one account per
  row, and other agents cannot use them.
- **Offer only the vendors whose terms are clear** (the research's recommendation C): refused by
  the owner — the hub does not judge vendors.
- **The hub's own OAuth clients**: weeks per vendor and client IDs the hub does not have; possible
  later for ChatGPT's official "Sign in with ChatGPT" program.
