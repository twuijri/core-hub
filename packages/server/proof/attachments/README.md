# The attachment path, proved against the real image

Not shipped: the `Dockerfile` copies `dist/`, `drizzle/` and the contract, never this
folder, and nothing in `src/` imports it. It exists so the next person can re-run the
proof in `docs/changes/2026-09-22-twuijri-chat-attachments.md` instead of trusting it.

What it proves, and what it does not. Everything below is the real thing — the built
image, the hub, sign-in, the multipart upload, the blob store, the run engine, the
`hermes` adapter over HTTP and SSE, and the download. Only the **model** is scripted:
`hermes-stub.mjs` speaks the surface ADR 0008 §1 documents (`GET /health`,
`POST /v1/runs`, `GET /v1/runs/{id}/events`) and behaves like an agent that uses files —
it reads the path out of the prompt and writes into the output folder it was given.
A real Hermes needs a provider key, which is the owner's to supply; with one, the same
`proof.mjs` runs unchanged against it.

```bash
docker build -f packages/server/Dockerfile -t core-hub:attachments .

docker run -d --name corehub-attach -p 127.0.0.1:18090:8080 \
  -e HUB_ADMIN_PASSWORD=attachments-proof-pw \
  -v corehub-attach-data:/data \
  -v "$PWD/packages/server/proof/attachments:/opt/proof:ro" \
  --entrypoint sh core-hub:attachments \
  -c 'node /opt/proof/hermes-stub.mjs & exec node packages/server/dist/main.js'

node packages/server/proof/attachments/proof.mjs http://127.0.0.1:18090 attachments-proof-pw

docker rm -f corehub-attach && docker volume rm corehub-attach-data
```

The hub finds the stub on 8642 and reports `mode: external` (ADR 0008's first mode), so
it drives it exactly as it would drive a gateway somebody else runs.
