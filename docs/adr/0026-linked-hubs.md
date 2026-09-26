# ADR 0026 — Linked hubs: two Core Hubs that know each other, and what they may ask

Status: **proposed — owner to confirm** (2026-09-27). The owner parked hub peers on 2026-09-25
(«خلها بعدين اخاف تفتحلنا ثغرات», DECISIONS §80) and lifted it on 2026-09-26 («كل اللي قلت لك
خلها بعدين لا سوها ما عندي مشكلة»), security first. Everything below that he did not name is a
proposal. Contract: DECISIONS §101.

## Context
The contract carried five 501 operations for linking one Core Hub to another
(`devices.listPeers`, `requestPeer`, `updatePeer`, `deletePeer`, `createPeerInvite`), from the
owner's earlier apps, with no statement of what a link is for. A link is another hub reaching
into this one: every capability it gets is an attack surface on both sides. So this ADR starts
from the threat model and gives a first version as little as is useful.

## Threat model
Who may attack, and what they must not get:

- **Anyone on the internet** who can reach a hub's address. Must not link, must not read
  anything, must not make any agent do anything. They see the hub-to-hub routes, which answer
  nothing without a valid signature or a live invite code.
- **Someone who saw an invite link** (a leaked chat message). Must not link after it was used
  or after 10 minutes, and must not link silently: the inviting owner approves every link and
  sees the other hub's key fingerprint.
- **Someone who can watch or replay traffic** (a TLS-terminating proxy, a log that kept
  headers). Must not replay a call, change its body, send it to another path or another hub.
- **A linked hub that turns hostile** (compromised, or its owner changes their mind). Must get
  nothing beyond the names of the agents shared with it and single tool-free answers from them;
  must be rate-limited; must be cut off at once by the other owner.
- **A person on the other hub.** Acts only through their hub's link, so is bounded by the same
  limits; is named in the audit log by their hub's word, which this hub cannot verify.

Out of scope for v1: a hub whose owner account is compromised (it can link and share anything
it likes — as it can do anything else), and denial of service beyond the rate limits.

## Decision
1. **Pairing needs both owners.** Hub A's admin creates an invite (`createPeerInvite`): a
   26-character code from 128+ random bits, **single use, 10 minutes**, only its SHA-256 kept, at
   most 5 open at a time. The link carries A's key fingerprint (`?fp=`). Hub B's admin pastes it
   (`requestPeer`); B calls A's `peerJoin` over HTTPS with B's name, HTTPS origin, hub id and
   **Ed25519 public key**, signed with that key (proof that B holds it). A takes the code in one
   statement (so two redemptions cannot both win), keeps B's key, and answers with its own; B
   refuses unless A's key matches the fingerprint in the link. A's row is `pending` until A's
   admin approves (`updatePeer` with `approve`); B's is `waiting` until A tells it, signed, or
   answers its first signed call. Refusing is deleting.
2. **Every later call is signed.** Headers `X-Peer-Hub`, `X-Peer-Timestamp`, `X-Peer-Nonce`,
   `X-Peer-Signature`: Ed25519 over `corehub-peer-v1 / METHOD / path?query / timestamp / nonce /
   sha256(body) / recipient hub id`. The receiver checks the key it stored for that hub id, a
   timestamp within 5 minutes of its clock, and that the nonce is new (kept in the database for
   the window, so a restart does not reopen it). The order is signature first, nonce second, so
   forged calls cannot fill the nonce store. An unknown hub id is refused without a log line.
3. **HTTPS is required.** A hub creates an invite or redeems one only when it is reached over
   HTTPS itself; the peer's address must be `https:`; redirects are never followed. Private
   addresses (a LAN, a tailnet) are allowed: the peer's address is the one its owner gave, and
   an owner approves every link.
4. **What a link allows in v1 — two things only.**
   - **Read-only discovery:** each side lists the other's shared agents: an opaque share id, a
     name and a description. The agent's own id never leaves the hub.
   - **Ask a peer agent:** a person on A sends one prompt to one shared agent on B and gets the
     answer. B answers as its **peer guest**: through the agent runner's tool-free one-shot (the
     one the hub already uses to title conversations), on the shared agent's model in its
     profile, **without tools, files, memory, skills or conversation**, within 120 s and 2,000
     tokens. The peer guest is not a user and holds no token; it exists only inside the two
     signed routes. Nothing else crosses: no files, memory, tasks, schedules, rooms, providers
     or keys.
5. **Controls.** Per peer: on/off (`enabled`, which stops both directions), a name, and
   `asks_per_hour` (default 30, 1–1,000). Per agent in a profile: a share switch, **off by
   default**, for all enabled peers. Fixed limits: 60 signed calls per peer per minute, 10 invite
   redemptions per address per minute, 50 peers. `deletePeer` revokes at once — the key is gone
   before the other hub is told, best effort, to drop its side too.
6. **Audit on both sides.** `peer_events`: joined, requested, approved (by whom), changed,
   unlinked, each list and question in and out, and every refused call with its reason
   (signature, replay, clock, unshared agent, over the limit). Never a question's words. Kept
   after a peer is deleted.
7. **Admins only, on both sides**, including asking (a member-facing "ask a peer" is later).
8. **Where it lives.** The `devices` module (the contract's tag): `peers.ts` and
   `peer-crypto.ts`; this hub's identity (hub id and Ed25519 key pair, the private key sealed
   with the hub's data key ring) in `peer_identity`. The agents list and the one-shot are lent
   by the composition root. The web page is Settings → Linked hubs.

## Alternatives rejected
- **Shared secrets (HMAC) instead of key pairs:** a leaked database on either side would let
  its reader impersonate the other hub. With key pairs each side stores only the other's public
  key.
- **Mutual TLS:** needs a certificate authority or pinning at the proxy, which most owners'
  Caddy/Traefik/Cloudflare set-ups cannot do; signing at the application layer works behind
  any proxy that keeps the path.
- **Running the peer's prompt as a normal chat run** (tools, memory, the agent's home): a
  peer could make the agent read files or run commands. Tool-free is the only safe default;
  tools for a peer would need their own ADR.
- **Per-peer share lists:** more to understand and to get wrong for a first version with one or
  two peers. Proposed later if the owner wants hub-by-hub sharing.
- **A peer guest user with a token:** a token is a thing to leak and to scope; a principal that
  exists only inside two routes cannot be misused elsewhere.

## Consequences
- The five parked operations answer, with changed shapes (they were 501 and no client used
  them), plus `listPeerEvents`, `listPeerAgents`, `askPeerAgent`, `listPeerShares`,
  `setPeerShare` and the four hub-to-hub routes (`peerJoin`, `peerNotice`, `peerAgents`,
  `peerAsk`), which no client calls.
- A reverse proxy that rewrites the `/api/v1` path breaks the signature; one that keeps it (all
  the documented set-ups) does not.
- Clock skew over 5 minutes between two hubs refuses their calls, and says so in the log.
- The answer comes from the shared agent's model, not from the agent with its memory and tools:
  the page says so, so nobody expects more.
- Responses are trusted through HTTPS to the address recorded at pairing; signing responses
  too is a later step if an owner needs it.
