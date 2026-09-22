# @majlis/web

The web client of Majlis: Vite 8 + React 19 + TypeScript strict, generated from
`packages/contracts` (every HTTP call goes through `createHubClient`; every realtime message
is the envelope of `packages/contracts/events`), implementing `docs/clients/NAVIGATION.md`
one destination = one screen.

## Run

```bash
pnpm dev                       # the hub on :8080 (first run: /setup, or HUB_ADMIN_PASSWORD)
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
- `src/ui/` — **our components**: icons, notices, and the wrappers around the headless
  primitives (`Menu`, `Select`, `Popover`). Nothing else in the client imports `radix-ui`.
- `src/shell/` — sidebar, top bar, centred column, the split pane.
- `src/chat/` — the transcript reducer (pure), the stream hook (subscribe / `after_seq`
  resume / resync), markdown, tool cards, approvals, the composer.
- `src/sessions/`, `src/agents/`, `src/settings/`, `src/screens/` — the screens.
- `src/i18n/{ar,en}.json` — every string, checked by `pnpm i18n:check` and `tests/i18n.test.ts`.

## Tests

- `pnpm --filter @majlis/web test` — Vitest: navigation parity against the manifest
  (docs/clients/README.md rules 1–8), the logical-CSS guard (no `left`/`right`), i18n key
  coverage, the transcript reducer, the refreshing client, display preferences, approvals.
- `pnpm --filter @majlis/web test:e2e` — Playwright, four journeys against two real hubs
  (the signed-in one, and one with no owner for the first-run setup journey)
  with a scripted agent (`e2e/hub.ts`): login → new session → streamed reply; approvals
  once/session/always/deny; resume after a socket drop. Needs `pnpm build` first and
  `playwright install chromium`. Screenshots go to `MAJLIS_SHOTS` (default `e2e/shots`).

## Third-party layers (owner decision, 2026-09-22)

We do not hand-roll interaction primitives, and we do not adopt a styled kit (MUI, Ant
Design, Chakra, Mantine): their look fights `docs/clients/DESIGN.md` and overriding it costs
more than owning our components. We stand on a headless layer and keep our own skin.

| Layer | Package | Licence | What it gives us |
|---|---|---|---|
| Interaction primitives | `radix-ui` 1.6.x (single package) | MIT | dialog, menu, popover, tooltip, tabs, select, toggle group, scroll area, focus management — behaviour, accessibility and RTL, no styling |
| Drag and drop | `@dnd-kit` | MIT | the one drag library; every drag keeps a keyboard equivalent |
| Markdown | `react-markdown` + `remark-gfm` | MIT | message rendering |

**Composition rule (binding):** a Radix primitive is always wrapped in our own component
under `src/ui/` that applies the tokens; screens import our wrapper, never the primitive
directly. That keeps one place to restyle everything. `Direction.DirectionProvider` is
mounted once in `src/i18n/context.tsx`, because Radix reads direction from context and not
from `<html dir>`.

Planned next, not yet adopted (they belong to the transcript and the settings forms, which
this branch does not otherwise touch): `shiki` for code highlighting driven by our tokens
and loaded lazily, `@tanstack/react-virtual` for the transcript list, and
`react-hook-form` + zod for the settings and provider forms.

## Rules

- Logical CSS properties only (`ms-`, `pe-`, `start-`, `text-start`); a test greps for the rest.
- Glass (translucency + blur) only on floating chrome through the `.glass` class; content
  surfaces are solid.
- One drag-and-drop library (`@dnd-kit`); every drag has a keyboard equivalent.
- No screen imports `radix-ui`; it imports the wrapper in `src/ui/`.
- No hand-typed `/api/` path; no business rule — the server decides.
