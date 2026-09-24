# @corehub/ui-tokens

The design tokens of every Core Hub client: `tokens.json` is the source of truth; `pnpm build`
generates `dist/tokens.css` (custom properties `--mj-*`, light/dark themes, the glass scale
0–3, `prefers-reduced-transparency` and `prefers-reduced-motion` handling) and a typed
`dist/tokens.js`. `tests/contrast.test.ts` fails when any declared text/background pair falls
under WCAG AA in either theme, including text over the glass chrome at every level.

Rules: colours are named by role, never by hue; glass (translucency + blur) applies only to
floating chrome (sidebar, composer, top bar, popovers) — content surfaces stay solid.
Kotlin and Swift exporters read the same JSON in a later phase.
