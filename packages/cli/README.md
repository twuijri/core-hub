# @majlis/cli

The Phase 0 reference client: a terminal client generated from `packages/contracts` (ADR 0003,
ADR 0007). Usage, commands, exit codes and the chat protocol are documented in
`docs/clients/CLI.md`.

```bash
pnpm --filter @majlis/cli build && node packages/cli/dist/bin.js --help
pnpm --filter @majlis/cli test
```

Layout: `src/main.ts` (parse, dispatch, exit codes) · `src/args.ts` (the command table on
`node:util` parseArgs) · `src/client.ts` (the generated client with token refresh) ·
`src/realtime.ts` (Socket.IO namespaces and the envelope validator) · `src/chat/transcript.ts`
(the pure envelope-to-terminal reducer) · `src/commands/*` · `src/i18n/{ar,en}.json`.
