# Developing Majlis

Everything runs from one pnpm workspace. Node is pinned in `.nvmrc`
(Node 24); `corepack enable` gives you the pinned pnpm.

```bash
nvm use            # reads .nvmrc
corepack enable
pnpm install --frozen-lockfile
```

The code map is committed and checked by CI (`docs/harness/knowledge-graph.md`):

```bash
uv tool install graphifyy==0.9.66   # once per machine
pnpm graph                          # before committing a code change, and after a pull
```

## Run the hub and the web client

```bash
pnpm --filter @majlis/server dev     # the hub on :8080, SQLite under ./.data
pnpm --filter @majlis/web dev        # Vite on :5173, proxying /api and /rt to :8080
```

The first boot has no account. The hub prints a one-time **setup token** and
writes it to `<DATA_DIR>/setup-token.txt`; open the client and create the owner
on `/setup`, or run `node packages/cli/dist/bin.js setup --server
http://127.0.0.1:8080` (ADR 0011). A new token is printed on every restart until
the account exists. To skip the screen — in a script, or when you want the same
account every time — set `HUB_ADMIN_PASSWORD` once
(`HUB_ADMIN_PASSWORD=… pnpm --filter @majlis/server dev`) and the hub creates
`admin` itself; afterwards the variable is ignored. `DATA_DIR` decides where the
database, the keys, Hermes's home and installed agents live. Those four
variables are the whole configuration (ARCHITECTURE invariant 5).

To use the built client instead of Vite, `pnpm build` and open the hub's own
port: the hub serves `packages/web/dist` at `/`.

The terminal client works against any hub:

```bash
pnpm --filter @majlis/cli build && node packages/cli/dist/bin.js login --server http://127.0.0.1:8080
```

## Checks

`docs/harness/validation.md` says which checks a given change needs. The full
set, as CI runs it:

```bash
pnpm lint typecheck test contract:test contracts:lint contracts:check-clients nav:check i18n:check build
pnpm db:generate && pnpm db:migrate
pnpm --filter @majlis/web test:e2e     # Playwright journeys against a real hub
```

Two rules that catch most mistakes early: an endpoint or event must exist in
`packages/contracts` before it is implemented, and every user-facing string
must exist in Arabic and English.

## Tests that must not depend on your machine

A Hermes gateway running on your own box must never change a result. The unit
helper (`packages/server/tests/unit/helpers.ts`) and the e2e hub
(`packages/web/e2e/hub.ts`) both override agent discovery with scripted fakes
for exactly this reason. If you add a test that talks to a real agent, gate it
on an environment variable and skip it honestly when unset — see
`hermes.e2e.test.ts`.

## Docker

`packages/server/Dockerfile` builds the hub, the web client and the Hermes
runtime into one image; `docker-compose.yml` is the reference stack and
`docs/DEPLOY.md` is the operator's guide. The number that matters is the
compressed pull size (see `docs/ROADMAP.md` §Sizes).
