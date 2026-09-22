# The look of every Majlis client

Owner direction, 2026-09-21. It binds web, desktop and phones alike; the
tokens in `packages/ui-tokens` are the single source they all read.

## Shape
Chat-centric, in the family of Claude and ChatGPT, not a dashboard:

- a sidebar for navigation and history;
- one centred reading column (~48rem) for the conversation;
- a floating composer at the bottom;
- a right-hand pane, resizable and collapsible, for artifacts: code,
  previews, tool output, Tasks.

## Glass, deliberately partial
The look is glass-inspired (translucency, blur, soft depth) but **only on
floating chrome**: sidebar, composer, top bar, popovers. Content surfaces —
message bubbles, cards, tables — stay solid.

Why partial: heavy blur behind Arabic text hurts legibility, costs battery and
GPU on phones, and fights the reduced-transparency setting people turn on for
a reason. One intensity scale (0 solid … 3 full) lives in the tokens; the
system settings `prefers-reduced-transparency` and `prefers-reduced-motion`
drop it automatically, and every text/background pair is asserted at WCAG AA
in both themes by `packages/ui-tokens/tests/contrast.test.ts`.

This is our own design in the spirit of glass, never a copy of another
vendor's design language.

## Drag and drop, where it means something
Covered: Tasks cards and columns, session order and pinning, files and images
into the composer and into Knowledge, agent and seat order in rooms, pane
width. Not covered: everything else — a drag with no meaning is a trap for
keyboard and screen-reader users.

Every drag has a keyboard equivalent, and one library serves the whole client.

## Language
Arabic first with full RTL, English beside it, both complete. Logical CSS
properties only (`inline-start`, never `left`). UI direction follows the UI
language; each piece of content decides its own direction (`dir="auto"`).

## Naming
The board section is **Tasks** («المهام»), never Kanban or Board
(owner decision, 2026-09-21; contract decision §25).

## UI policy (owner decision, 2026-09-22)

The owner opened two screens and got the browser's own dropdown — native blue highlight,
OS popup, nothing like the product. The fix is not to chase screens: **the system makes
the wrong thing impossible.**

**Every interactive surface comes from `packages/web/src/ui/`.** A screen never imports a
primitive and never uses the browser's own furniture. `src/ui/` is the one place allowed
to touch `radix-ui` and the raw elements, so restyling a control is one edit, in one file,
for the whole client.

Banned in a screen, and each one fails `pnpm lint`:

| Banned | Why | Use |
|---|---|---|
| `<select>`, `<option>`, `<optgroup>` | the OS paints the popup; no tokens, wrong in dark, wrong in RTL | `<Select>` |
| `<input type="checkbox">` / `type="radio"` | painted by the OS, keeps its own focus ring | `<Checkbox>` / `<Segmented>` |
| `<dialog>`, `alert()`, `confirm()`, `prompt()` | the browser's modal: says the hostname, freezes the tab, cannot be localised beside our type | `useConfirm()` |
| `title="…"` on a host element | the browser's tooltip: a delay nobody chose, invisible to touch, ignores the theme | `<Tooltip>` |
| `import … from 'radix-ui'` | two places to style one control | the wrapper in `src/ui/` |

A `title` **prop** on one of our components is fine — it reaches our tooltip. The ban is on
the HTML attribute.

### The wrappers that exist

| Component | Over | Used for |
|---|---|---|
| `Segmented` / `SegmentedTrack` + `SegmentedItem` | our own keyboard, our own fit rule | the one row-of-choices: agents, sections, tabs, display preferences, the session filter. Two densities and a More overflow (`segmented-fit.ts`) |
| `Select` | Radix Select | every picker; grouped options, a check on the chosen row |
| `Menu` / `MenuItem` / `MenuChoice` | Radix DropdownMenu | the composer's "+", a segmented control's overflow |
| `Popover` | Radix Popover | an anchored sheet (the working folder) |
| `Tooltip` | Radix Tooltip | every icon-only control, and the reason a disabled one is disabled |
| `Checkbox` | Radix Checkbox | every tick |
| `ConfirmDialog` (`useConfirm`) | Radix AlertDialog | every "are you sure" |
| `Direction` | Radix DirectionProvider | mounted once, so the primitives read Arabic as Arabic |
| `Notice`, `Spinner`, `icons` | ours | messages, waiting, iconography |

Adding a control means adding it here, once, with its tokens — never inline in a screen.

### How it is enforced

- `eslint.config.js` — `no-restricted-syntax` and `no-restricted-globals` on
  `packages/web/src/**`, with `packages/web/src/ui/**` the single exemption. A screen that
  breaks the policy fails `pnpm lint`, which is CI.
- `packages/web/tests/ui-layer.test.ts` — the same rules from the other side, plus a check
  that the lint config still carries them, so deleting a rule cannot quietly pass.

### One of everything

One focus ring (`:focus-visible` in `@layer base`; no control draws its own). One shadow
scale (`--mj-shadow-sm|md|lg`). Concentric radii — a control's inner radius is the track's
radius minus its padding. Controls come in three heights (`--mj-control-height-sm|md|lg`)
and nothing invents a fourth. A disabled control always says why, in its tooltip, hung off
a focusable wrapper — a disabled button takes no pointer events, so without one the reason
could never be read.
