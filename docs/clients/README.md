# Clients

Every client — `packages/web`, `apps/desktop`, `apps/android`, `apps/ios` — renders the same
contract (`packages/contracts`) and the same navigation map (`NAVIGATION.md`). Two files in
this directory are binding:

- `navigation.json` — the machine-readable navigation manifest: `terms` (ar/en labels),
  `destinations`, the ordered lists `rail`, `segments`, `footer`, `settingsTabs`,
  `settingsTools`, `agentLevel`, the explicitly allowed `secondaryEntries`, `preAuth` — the
  screens shown before anyone is signed in (`login`, `setup`), which are not destinations —
  and `surfaceRoutes`, the URL (web) or screen id of every destination per surface.
- `NAVIGATION.md` — the rules the manifest encodes, in prose (Arabic, the owner's language).

`pnpm nav:check` validates the manifest itself. Each client must add a **parity test** that
validates the client against it.

## The parity test every client implements

The test lives in the client's own test suite (Vitest for web/desktop, JUnit for Android,
XCTest for iOS) and reads `docs/clients/navigation.json` from the repository (copy it into
the test resources at build time if the platform cannot read outside its module; never
hand-maintain a second copy).

It must assert all of the following, and fail on the first difference:

1. **Every destination has a screen.** For each `destinations[].id` whose `surfaces` include
   this client (absent `surfaces` means all), a route/screen/fragment with that id exists.
2. **Every screen has a destination.** The client exposes its registry of routes/screens;
   each one maps to a destination id. Nothing is reachable that the manifest does not list.
   The pre-auth screens are the one exception and are listed too, under `preAuth`: the test
   asserts the client's sign-in and first-run-setup paths are exactly the manifest's and that
   neither id is a destination.
3. **One primary entry per destination.** The client's rail, segments, footer, settings tabs,
   settings tools and agent-level menu contain exactly the ids of the corresponding manifest
   lists, **in the same order**, and nothing else.
4. **Entry label equals screen title.** The label rendered for an entry and the title rendered
   on the screen it opens both come from `terms[destination.title]` through the client's
   locale file, under the same key. The test compares the client's `ar` and `en` locale
   entries with `terms` for every key the manifest uses.
5. **Secondary entries only where allowed.** Any additional way to reach a destination
   (a link, a search result, a card action) is listed under `secondaryEntries[target]`.
6. **Roles and surfaces.** Entries with `roles: ["admin"]` are hidden from members;
   entries with a `surfaces` list do not exist on other surfaces.
7. **Agent level is capability-driven.** Agent-level entries render only when the agent's
   `capabilities` (from the server registry) include `destination.capability`; the test
   feeds a fake agent with a subset and checks the menu.
8. **Workspace is a filter.** Switching the workspace chip changes the `X-Hub-Profile`
   header on the next request and never changes the current route.

Suggested shape (web, Vitest):

```ts
import manifest from '../../../docs/clients/navigation.json';
import { routes } from '../src/router';           // the client's registry
import ar from '../src/i18n/ar.json';
import en from '../src/i18n/en.json';

test('navigation parity', () => {
  const ids = new Set(manifest.destinations.filter(forThisSurface).map((d) => d.id));
  expect(new Set(routes.map((r) => r.name))).toEqual(ids);
  expect(rail.map((e) => e.id)).toEqual(manifest.rail);
  for (const d of manifest.destinations) {
    expect(en[d.title]).toBe(manifest.terms[d.title].en);
    expect(ar[d.title]).toBe(manifest.terms[d.title].ar);
  }
});
```

Changing `navigation.json` is a contract change: it needs the clients' parity tests updated in
the same PR (or a follow-up recorded in the change record) and the owner's review.

## The web client

`packages/web` implements this manifest (`docs/clients/web.md` is not needed: the package
README says how it is laid out). Its parity test is
`packages/web/tests/navigation.parity.test.tsx` (rules 1–7) and
`packages/web/tests/workspace.test.tsx` (rule 8); its router is built from
`surfaceRoutes.web` in the manifest, so a destination without a route fails `pnpm nav:check`
before the test even runs.

## The iOS client

`apps/ios` implements this manifest on iPhone and iPad (`apps/ios/README.md`). Its registry is
`apps/ios/CoreHub/Navigation/` (`Destinations.swift`, and `Routes.swift` for `surfaceRoutes.ios`,
whose paths are also those of `corehub://open/<path>` links); its parity test is
`apps/ios/CoreHubTests/NavigationParityTests.swift` (rules 1–8), which reads this file copied
into the test bundle at build time.

## The reference client

`packages/cli` is the terminal client that proves the server end to end in Phase 0 (ADR 0007):
it is generated from the contract, has no screens and therefore no navigation parity test, and
is documented in `CLI.md`.
