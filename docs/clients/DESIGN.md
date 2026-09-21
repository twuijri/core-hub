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
