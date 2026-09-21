# `majlis` — the reference client

`packages/cli` is the Phase 0 reference client (`docs/ROADMAP.md`, ADR 0007): a small terminal
client built from `packages/contracts` and nothing else, with which the owner proves the server
end to end — sign in, pair a device, list agents, open a session and stream a reply. It is a
client like the web and the phones will be, so it obeys the same rules: every HTTP call goes
through the generated client (`createHubClient`), every realtime message is the envelope of
`packages/contracts/events`, errors are the contract's `{ error, code }`, and every string it
prints exists in Arabic and English.

## Install and run

```bash
pnpm install
pnpm build                       # builds contracts, server and the CLI
node packages/cli/dist/bin.js --help
alias majlis='node /path/to/majlis/packages/cli/dist/bin.js'
```

Node 24 (`.nvmrc`). There is no global install yet; the package is private until Phase 0 ships.

## Commands

| Command | What it does | Contract operations |
|---|---|---|
| `majlis setup --server URL [--username NAME] [--display-name N] [--workspace-name N]` | First run only (ADR 0011): creates the owner account on a hub that has none. Asks for the hub's setup token (printed in its log, and in `<DATA_DIR>/setup-token.txt`) and for the password, twice and hidden. Ends signed in. | `auth.getSetup`, `auth.completeSetup` |
| `majlis login --server URL [--username NAME]` | Signs in; the password is always prompted (hidden on a terminal, read from stdin otherwise). Stores the tokens. | `meta.get`, `auth.login` |
| `majlis logout` | Revokes the token on the hub and forgets it locally. | `auth.logout` |
| `majlis whoami` | The signed-in user, hub, workspace and token kind. | `auth.getMe` |
| `majlis pair [--ttl S] [--connection lan\|relay] [--no-qr]` | Creates a pairing, prints the code, the QR and the exact `pair claim` line, then waits for `pairing.claimed` on `/rt/devices` (polling `auth.getPairing` as a fallback). | `auth.createPairing`, `auth.getPairing` |
| `majlis pair claim '<QR JSON>'` or `majlis pair claim CODE --pairing-id ID --server URL` | The device side: claims the pairing as this computer and stores the app token. | `auth.claimPairing` |
| `majlis agents list [--kind K]` / `get ID` | The registry. | `agents.list`, `agents.get` |
| `majlis agents install ID` / `remove ID` | Start the install/uninstall job. | `agents.install`, `agents.uninstall` |
| `majlis sessions list [--limit N] [--cursor C] [--archived true\|false\|all] [--agent ID] [--q TEXT]` | Sessions of the workspace, paged. | `sessions.list` |
| `majlis sessions new --agent ID [--title T] [--working-dir D] [--model M]` | Creates a session and prints the `chat` command for it. | `sessions.create` |
| `majlis sessions show ID` / `delete ID` | The live session document / delete. | `sessions.get`, `sessions.delete` |
| `majlis chat ID [--message TEXT] [--once] [--reasoning] [--approve D] [--timeout S]` | The streamed conversation (below). | `sessions.get`, `sessions.createRun`, `sessions.cancelRun`, `sessions.respondApproval`, `sessions.getRun` |

Global options, valid anywhere on the line: `--server URL`, `--profile SLUG` (the `X-Hub-Profile`
scope for this call), `--json`, `--strict`, `--lang ar|en`, `--config PATH`, `--no-color`,
`--help`, `--version`.

`--json` prints the contract's document (or, for `chat` and `pair`, one JSON document per line)
on stdout; prompts and notices go to stderr, so `majlis sessions list --json | jq` works.

`--password`, `--token` and friends are refused on the command line; secrets are prompted for.

## Exit codes

`0` ok · `1` error (including a `501 not_implemented` answer) · `2` usage · `3` not signed in
(no stored token, or the hub answered `401`/`403`).

## Where the token lives

`$XDG_CONFIG_HOME/majlis/config.json`, or `~/.config/majlis/config.json` (override with
`--config PATH` or `MAJLIS_CONFIG`). The directory is created `0700`, the file is written `0600`
atomically. It holds the hub origin, the workspace slug, the access token, the refresh token and
the user's id and name; a web session refreshes itself once on `401 token_expired` and
proactively near expiry, an app token (from `pair claim`) renews when less than seven days remain
(`auth.refresh` with the bearer and no body, as the contract says). The device key this computer
presents when pairing is kept across sign-outs so re-pairing updates the same device row.

## `chat`

```
$ majlis chat 01J8QK3ZR2W7M5N4P6T8V9X0YA
خطة إطلاق التطبيق · agent 01J8QK3ZR2W7M5N4P6T8V9X0AG · idle
Type a message and press Enter. Ctrl+C stops the run; a second Ctrl+C exits.
> شغّل اختبارات الخادم
Hermes: سأشغّل الاختبارات الآن.
  * tool shell
  = tool shell finished (1.2 s)
    30 passed
 نجحت.
2300 in · 410 out · 0.013100 USD
>
```

- The message goes over HTTP (`sessions.createRun`); the reply arrives on `/rt/sessions`.
  On connect the client sends `subscribe { session_id }`; after a drop it reconnects with
  backoff (30 s cap) and sends `subscribe { session_id, after_seq }` with the last `seq` it
  processed, so the hub replays what was missed (`events/README.md` §Resuming). When the hub
  answers `truncated: true` the client re-reads `sessions.get` and, if the run it was following
  has ended meanwhile, reads it with `sessions.getRun` and reports its final status.
- `message.delta` streams inline; `reasoning.delta` is shown dimmed with `--reasoning`;
  `tool.started/completed/failed` become one line each; `run.completed` prints the usage;
  `run.failed` prints the run's error envelope and exits `1` in `--once` mode.
- `approval.requested` pauses the transcript and asks: `[1] once [2] this session [3] always
  [4] deny` for tool calls and writes (`3` only when the hub says `allow_always`), or a free
  answer / choice number for questions; the answer goes through `sessions.respondApproval`.
  Without a terminal, or with `--approve once|session|always|deny`, the decision is automatic
  and printed on stderr — a script never hangs on a question, and the default without a
  terminal is `deny`.
- Ctrl+C while a run is active calls `sessions.cancelRun`; a second Ctrl+C exits. Ctrl+C at
  the prompt exits.
- `--message TEXT --once` sends one message and exits when its run ends: `0` succeeded,
  `1` failed or cancelled. `--timeout S` gives up waiting (the run stays on the hub).
- `--strict` validates every incoming envelope against its JSON Schema in
  `packages/contracts/events/<namespace>/<event>.schema.json` and stops at the first mismatch;
  the tests always run strict.
- `MAJLIS_DEBUG=1` logs the socket lifecycle (connect, subscribe acks, drops) on stderr.

## What is 501-bound today

The hub answers `501 not_implemented` for every operation no module implements yet; the CLI
prints which one (`The hub declares agents.list in the contract but does not implement it yet`)
and exits `1`. As of this page: `agents.*` (the `agents` module lands in its own branch),
`meta.get` (login tolerates it and continues). Everything under `auth` and `sessions` that the
CLI uses is implemented.

## Tests

- `packages/cli/tests/*.test.ts` — argument parsing (including the refusal of secrets),
  config store permissions, output widths and tables, the QR matrix, prompts on a pipe, the
  token-refresh wrapper against a fake `fetch`, and the transcript reducer.
- `packages/cli/tests/integration/setup.test.ts` — boots a real hub with **no** owner and no
  `HUB_ADMIN_PASSWORD`, then runs `setup`: a secret refused on the command line (exit 2), a
  wrong token (exit 3), a mistyped confirmation (exit 1, nothing sent), the real token read
  from the file the server wrote (exit 0, signed in, the file deleted), and a second run that
  says the hub is already set up.
- `packages/cli/tests/integration/cli.test.ts` — boots the real server in-process with the
  scripted fake runner from `packages/server/src/modules/sessions/testing/`, then runs
  `login`, `whoami` (text, JSON, Arabic), `agents list` (501), `sessions new|list|show`,
  `chat --message --once --strict` (text and NDJSON, every envelope validated), approvals
  (`--approve` and the no-terminal default), a failed run, a socket drop mid-run with
  `after_seq` replay, `--timeout`, `pair` + `pair claim` end to end, `sessions delete`,
  `logout`, and the exit-3 path afterwards.

Run `pnpm --filter @majlis/cli test`; `docs/harness/validation.md` lists the rest.
