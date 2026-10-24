# Gemini Desktop's native protocol — keeping one conversation (research, 2026-10-24)

Why: the owner's plugin for CLIProxyAPI (`twuijri/cpa-plugin-api-key-manager`,
`plugins/gemini-desktop` `0.2.0-preview`, MIT) folds the whole history into one text and sends each
message as a new native request, so **every message opened a new chat** in the account's Gemini
history (the owner's screenshot of the Gemini app, 2026-10-24). The plugin says so itself: "native
conversation resumption" is not implemented. The owner's requirement for Core Hub: a message in a
Core Hub chat goes to the **same** Gemini chat; a new Core Hub chat opens a new Gemini chat. Where the
native service takes the conversation was not in the plugin, so it was looked for on a live account.

How: the owner signed in once with his test account in a research script (the app's own OAuth
client, PKCE, a pasted callback); scripts written for this research sent `ProcessQuery` round trips
over HTTP/2 and decoded every server frame as a protobuf tree. No token, frame dump or account
detail is kept in this repository.

## What the server frames carry (`ProcessQuery`)

| Path | What it is |
|---|---|
| `1003.1.2.1` | the conversation id, `c_…` (also early, in `1014.1.1`) |
| `1003.1.2.2` | the answer id, `r_…` (in the last answer frame) |
| `1003.1.1.1` | the chosen candidate id, `rc_…` |
| `1003.1.1.2.1` | the answer so far (growing snapshots) |
| `1003.1.4.1` | the conversation's title, as the Gemini app shows it |
| `1003.1.30` | "Used 3.5 Flash-Lite model" |
| `1003.1.41` | the mode category that answered |

## Continuing a conversation

The initial frame's template (extension 1000 → extension 1001 → field 1) **field 4** is a message
`{1: c_, 2: r_, 3: rc_}` — the ids of the turn the new one follows.

- **All three are needed.** With only `c_` the server answers under the same conversation id but
  without its history (it could not quote the first message).
- **Chaining.** Each turn sends the previous turn's three ids; the server answers with the same
  `c_` and a new `r_` / `rc_`. A three-turn check: the third turn quoted the first message word for
  word, under one `c_`.
- **The model can change mid-conversation.** Field 47 (the mode category) with field 4 kept the
  conversation: Flash-Lite, then Flash, then Pro answered «TEAL/OTTER» from the first two turns.
- **An older turn's ids branch.** Sending turn 1's ids after turn 2 answered from turn 1 only
  («TEAL/UNKNOWN») — the shape an edit or a regenerate needs.
- **Google's own app agrees.** All four turns of that check appear in **one** chat in the Gemini app
  (titled after the first message; the owner's screenshot, 2026-10-24).
- **Bisect.** With `{c_, r_, rc_}` placed in template fields 1–90 one at a time (bisected), field 4 is
  the only one that keeps the conversation; fields 1, 10, 13, 19, 20, 22, 28, 36, 46, 51, 53, 60,
  63 and 68 refuse that shape with `INVALID_ARGUMENT`.

## Limitations found

- **A branch shows inline in the Gemini app.** The app's chat view is linear: after a branch (an edit
  or a regenerate in Core Hub), the same chat in the Gemini app shows the old and the new turns one
  after the other, not as alternatives. The model's context is right (it answers from the branch);
  only the app's display mixes them.
- **Gemini remembers across chats on this account.** Asking "what is the code word" is not a test of
  continuity: a brand-new chat answered it from the account's memory of earlier chats. The tests
  that count are the same `c_`, the word-for-word quote of the first message, and the branch.
- **Test chats.** The bisect left about 45 short test chats in the test account's Gemini history.

## The account's modes (`GetUserStatus`)

Read as the plugin reads them (policy `34 → 2 → 1`: category 3, disabled 4, title 14 / short title 6,
variant 5; the older list 17 only without a policy). The test account offered 3.5 Flash-Lite (6),
3.8 Flash (1), 3.1 Pro (3) and 4 Argon (8) — examples of one account, not a global list.

## Checked again with the hub's own code

After the provider was written (`packages/server/src/modules/models/gemini-desktop/`), one live run
of its TypeScript code on the same sign-in: the token renewed through the hub's refresh, the four
modes listed, and a two-turn chat on Flash-Lite answered «NOTED» and then quoted the first message
word for word, both turns under one `c_`.
