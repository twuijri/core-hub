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

## The conversation (owner decision, 2026-09-22)

The owner opened a chat and could not tell his own message from the reply: both sat
against the same edge, so the transcript read as one column of identical text. The fix is
a rule, not a tweak, and it is written here so it is not re-litigated:

> **The person is always on the right. The agent is always on the left. In every locale.**

That is a *physical* rule. It does not turn with the UI language and it does not turn with
the content's language: an Arabic sentence from the person is on the right, an English
sentence from the agent is on the left, and an Arabic interface does not mirror either of
them. The side says *who is speaking*, and who is speaking does not change when the
language does.

How it is built (`packages/web/src/styles/chat.css`): the row that carries a message fixes
its own `direction: ltr`, and everything that decides an edge — the justification, the
tightened corner, the side the avatar is on — then resolves against that fixed direction
with ordinary logical properties. The *content* still decides its own direction: every
bubble carries `dir="auto"` and isolates its text, so an Arabic sentence reads
right-to-left inside a bubble that is itself on the right. Any mixed string inside a row
(a token count, a duration) carries its own `dir="auto"`, because a fixed-direction row
would otherwise reorder its numbers.

| | The person | The agent |
|---|---|---|
| Side | right, always | left, always |
| Surface | a filled bubble (`user-bubble`) | a distinct card (`agent-bubble`) — not a shade of the same fill |
| Width | at most `layout.bubble-max` (70% of the column) | the whole column: code and tables need it |
| Shape | rounded, no tail, the corner nearest its own side tightened | the same, mirrored |
| Header | "You", once per turn | the agent's name and small avatar, once per turn |

**Grouping.** Consecutive messages from the same speaker are one turn: the name and the
avatar are drawn once, and the gap above a grouped message (`layout.group-gap`) is tighter
than the gap between turns (`layout.turn-gap`). That difference in spacing is the whole of
what makes a turn read as one thing. `chat/turns.ts` decides it, and decides it from the
role and the speaker's name — never from the content.

A message with nothing in it is not a turn. The hub opens a run by creating an empty
assistant message; until text or a tool lands in it there is nothing to draw, and drawing
it would wedge an empty bubble between two messages from the same person and stop them
grouping.

### The thinking indicator

Reasoning used to be a fold in the transcript, which read as the agent writing prose about
itself. While a run is alive it is not prose, it is a **state**, and it lives above the
composer where the person is already looking:

```
●●●  Thinking · 12s · shell
```

Three things, always together, and never fewer: something moving, the word, and the
**elapsed seconds counting up**. A spinner with no elapsed time cannot tell a person
whether the agent is thinking or stuck, so the count is not optional — this is the one
rule of the indicator. The current step is added when the agent reports one (a tool name).
`prefers-reduced-motion` stops the dots; the seconds keep counting, because the count is
information and not decoration.

When the run ends the line collapses into one quiet sentence — "thought for 12s" — with
the reasoning itself behind a closed disclosure. It is history now, so it is not allowed
to look like the reply. When no duration is known the sentence says only "Reasoning": a
made-up number is worse than none.

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

### The kit (owner decision, 2026-09-22)

`src/ui/` is no longer a handful of wrappers: it is a **complete component set**, in the
shadcn/ui manner — the code lives in our repository, it is styled by our tokens alone, and
the behaviour underneath is Radix's, because a focus trap and a roving tabindex are not
things to write twice. Nothing was copied: shadcn/ui is a way of working, and we adopted
the way, not the files (`docs/inspirations/shadcn-ui.md`).

One import (`src/ui/index.ts`) reaches all of it:

| Group | Components |
|---|---|
| Action | `Button` (5 variants × 3 sizes, icon-only, loading, a disabled reason), `buttonClass()` for a link that must look like one |
| Form | `Input`, `Textarea`, `Label`, `Field`, `Select`, `Combobox`, `Checkbox`, `Radio`, `Switch`, `Segmented` |
| Overlay | `Dialog`, `Sheet`, `AlertDialog`, `useConfirm()`, `Menu`, `ContextMenu`, `Popover`, `Tooltip`, `Toast` + `useToast()` |
| Display | `Card` + `CardHeader`/`CardFooter`/`cardClass()`, `Badge`, `Avatar`, `Separator`, `Table`, `ScrollArea`, `Skeleton`, `EmptyState`, `Notice`, `Spinner`, `Breadcrumb`, `Tabs`/`TabPanel` |
| Shell | `SidebarFrame`/`Brand`/`Group`/`Row`/`Body`/`Footer`, `SidebarPanel` (the same rows inside a page — the settings list), `UiDirection` |

Three rules keep it a kit and not a folder, each one a test in
`packages/web/tests/ui-layer.test.ts`:

1. **one barrel** — every component is exported from `src/ui/index.ts`;
2. **every component is used by at least one screen** — an unused component is a design
   that was never tested against a real page;
3. **no literal colour in `styles/kit.css`** — a hex there would be a colour the themes
   cannot reach and the WCAG contrast test cannot see.

The paint lives in three stylesheets, and the split is the point: `styles/kit.css` paints
the controls, `styles/chat.css` the conversation, `styles/screens.css` only *arrangement* —
where things sit on a particular page. A rule in `screens.css` that started painting a
control would be the drift the policy exists to prevent.

### The wrappers that exist

| Component | Over | Used for |
|---|---|---|
| `Segmented` / `SegmentedTrack` + `SegmentedItem` | our own keyboard, our own fit rule | the one row-of-choices: agents, sections, tabs, display preferences, the session filter. Two densities and a More overflow (`segmented-fit.ts`) |
| `Select` | Radix Select | a short, fixed list — grouped options, a check on the chosen row |
| `Combobox` | Radix Popover + `@tanstack/react-virtual` | a list too long to scan: a field that filters as you type, virtualized rows, sticky provider headers, Recent. **Every model picker uses it.** |
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
