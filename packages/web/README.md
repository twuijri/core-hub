# @majlis/web

The web client of Majlis: Vite 8 + React 19 + TypeScript strict, generated from
`packages/contracts` (every HTTP call goes through `createHubClient`; every realtime message
is the envelope of `packages/contracts/events`), implementing `docs/clients/NAVIGATION.md`
one destination = one screen.

## Run

```bash
pnpm dev                       # the hub on :8080 (HUB_ADMIN_PASSWORD set)
pnpm web:dev                   # Vite on :5173, proxying /api and /rt to the hub
pnpm build                     # builds tokens, contracts, the client (packages/web/dist) and the server
node packages/server/dist/main.js   # serves the built client from /
```

`MAJLIS_HUB=http://host:port` points the dev proxy at another hub. In production the app is
same-origin with the hub (`packages/server/src/app/web.ts`).

## Layout

- `src/design/` — theme, glass level, language and text size (local first, mirrored to
  `auth.setPreferences`); the tokens themselves live in `packages/ui-tokens`.
- `src/navigation/` — the manifest reader and the route registry built from
  `docs/clients/navigation.json` (`surfaceRoutes.web`).
- `src/auth/` — token store (localStorage), the refreshing client, the auth context.
- `src/realtime/` — Socket.IO namespaces under `/rt`, the envelope.
- `src/hub/queries.ts` — TanStack Query hooks; every key carries the workspace slug.
- `src/shell/` — sidebar, top bar, centred column, the split pane.
- `src/chat/` — the transcript reducer (pure), the stream hook (subscribe / `after_seq`
  resume / resync), markdown, tool cards, approvals, the composer.
- `src/sessions/`, `src/agents/`, `src/settings/`, `src/screens/` — the screens.
- `src/i18n/{ar,en}.json` — every string, checked by `pnpm i18n:check` and `tests/i18n.test.ts`.

## Tests

- `pnpm --filter @majlis/web test` — Vitest: navigation parity against the manifest
  (docs/clients/README.md rules 1–8), the logical-CSS guard (no `left`/`right`), i18n key
  coverage, the transcript reducer, the refreshing client, display preferences, approvals.
- `pnpm --filter @majlis/web test:e2e` — Playwright, three journeys against the real hub
  with a scripted agent (`e2e/hub.ts`): login → new session → streamed reply; approvals
  once/session/always/deny; resume after a socket drop. Needs `pnpm build` first and
  `playwright install chromium`. Screenshots go to `MAJLIS_SHOTS` (default `e2e/shots`).

## Rules

- Logical CSS properties only (`ms-`, `pe-`, `start-`, `text-start`); a test greps for the rest.
- Glass (translucency + blur) only on floating chrome through the `.glass` class; content
  surfaces are solid.
- One drag-and-drop library (`@dnd-kit`); every drag has a keyboard equivalent.
- No hand-typed `/api/` path; no business rule — the server decides.
