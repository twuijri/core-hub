# One family: web, desktop, iPhone, Android

Owner direction, 2026-09-27:

> «أبي الويب وكل برامج سطح المكتب والآيفون والأندرويد يكونون عائلة وحدة، مهب كل واحد جو».
> «احترم إن الجوال لأنه صغير يحتاج تعيد توزيع الأشياء… مثل نقطة خضراء بدل كلمة أونلاين طويلة».
> «أبي أقوم أشوف تطبيقات كأنها حقة شركة عملاقة».

This is a living document. It lists what every Core Hub client draws **the same way**, and the
few things a phone draws **differently on purpose**. `docs/clients/DESIGN.md` stays the source
for the look itself (glass on chrome only, the conversation's sides, the UI kit policy); this
page is the checklist a new screen on any platform is held to. When a platform departs from it,
change this page in the same pull request, or change the platform.

Where each rule lives in code is named, so it can be checked rather than remembered.

## 1. One set of values

| What | Source | Web | iOS | Android |
|---|---|---|---|---|
| Colours (by role, light + dark) | `packages/ui-tokens/tokens.json` | `--ch-color-*` | `Tone.*` (generated `Palette`) | `ui/theme/Theme.kt` |
| Radii `sm 6 · md 10 · lg 16 · xl 24 · full` | tokens `radius` | `--ch-radius-*` | `Radius.*` | tokens |
| Spacing, a 4-point rhythm | tokens `space` | `--ch-space-*` | `Space.s1…s12` | tokens |
| Type `12 · 14 · 16 · 18 · 22 · 28` | tokens `font` | `--ch-font-size-*` | `FontSize.*` | tokens |
| Control heights `28 · 34 · 40` | tokens `control` | `--ch-control-height-*` | `Control.*` | tokens |
| Motion `120 · 200 · 320 ms`, one ease | tokens `motion` | `--ch-motion-*` | `Motion.*` | tokens |

No screen writes a colour, a radius or a duration of its own. Every text/background pair is
asserted at WCAG AA in both themes by `packages/ui-tokens/tests/contrast.test.ts`.

**Which radius for what:** chips, pills and the composer's round buttons — `full`; buttons,
fields, tool cards, code blocks — `md`; cards, bubbles, sheets' inner cards — `lg`; the floating
composer and sheets — `xl`. Nested corners stay concentric (inner = outer − padding).

## 2. Icons: Lucide, everywhere

Every client draws [Lucide](https://lucide.dev) outlines (ISC, `THIRD-PARTY-NOTICES.md`) from the
one pinned package `lucide-static`:

- web and desktop: `scripts/icons/lucide-web.mjs` → `packages/web/src/ui/lucide.generated.ts`;
  screens use the `Icon…` names in `packages/web/src/ui/icons.tsx`;
- iOS and Android: `scripts/icons/lucide-mobile.mjs` → template images / vector drawables;
  iOS draws them with `LucideIcon` / `LucideLabel` (`apps/ios/CoreHub/Theme/Icon.swift`).

Lucide's own stroke: 2 on a 24 grid, round caps and joins. **No SF Symbols, no Material icons**
for anything another client also shows (the iOS CI step rejects `systemName:`/`systemImage:`).
Brand marks of the agents are not icons: they come from `ui/brand/marks.tsx` and
`scripts/icons/agent-marks-mobile.mjs`.

One picture per place — `destinationIcons` (web), `Icons.lucide(for:)` (iOS), and Android reads
this table:

| Destination | Lucide | Destination | Lucide |
|---|---|---|---|
| new_chat | `square-pen` | models | `box` |
| search | `search` | device_connections | `qr-code` |
| agent_manager | `bot` | knowledge | `book-open` |
| tasks | `list-checks` | logs | `scroll-text` |
| schedules | `calendar-clock` | usage | `chart-column` |
| chat | `messages-square` | skills_usage | `activity` |
| rooms | `users` | performance | `gauge` |
| settings | `settings` | theme | `palette` |
| account | `circle-user` | workspaces (profiles) | `layout-grid` |
| users | `users` | updates | `circle-arrow-down` |
| webhooks | `webhook` | plugins, agent_plugins | `puzzle` |
| display | `type` | files | `folder` |
| notifications | `bell` | terminal | `square-terminal` |
| privacy | `shield-check` | agent_skills | `sparkles` |
| this_device | `monitor` on a computer, `smartphone` on a phone | agent_mcp | `server` |
| about | `info` | agent_memory | `brain` |
| global_agent | `globe` | agent_jobs | `rotate-ccw-clock` |
| agent_channels | `radio` | agent_settings | `sliders-horizontal` |
| agent_config_files | `file-cog` | | |

Shared controls: back `chevron-left`/`arrow-left` (mirrored in RTL), close `x`, more `ellipsis`,
send `arrow-up`, stop a filled square, attach `paperclip` / `plus`, copy `copy`, restart
`rotate-cw`, profile `layout-grid`, theme `sun` · `moon` · `sun-moon` (system), language `globe`,
sign out `log-out`, share `share`.

Every row of a navigation list carries its icon — the rail, the settings list, an agent's pages.

## 3. Components, the same shape

| Component | Shape | Web | iOS |
|---|---|---|---|
| Primary button | accent fill, `md` radius, one per view | `Button variant="primary"` | `.borderedProminent` tinted accent |
| Secondary | surface + hairline | `secondary` | `.bordered` |
| Destructive on a card or row | red words on the neutral surface; asks first | `danger-quiet` | `role: .destructive` |
| Destructive confirm | solid red, only inside the confirm dialog | `danger` / `useConfirm()` | alert's destructive button |
| Chip (a place to go, a filter) | capsule, `surface-2`, leading icon, sentence case | `.agent-menu-link`, `chip` | `ChipButtonStyle` |
| Status | a coloured dot + its words; words drop on a phone | `Badge dot narrow="dot"` | `StatusDot` (+ `StatusPill` when not healthy) |
| Field | surface, hairline, `md` radius, label above | `Field` + `Input` | SwiftUI field in a `Form`/card |
| Card | surface, hairline, `lg` radius, solid (never glass) | `Card` | list section / rounded surface |
| Person's bubble | `user-bubble`, right side always | `chat.css` | `MessageRow` |
| Agent's reply | `agent-bubble` card, left side, full column | `chat.css` | `MessageRow` |
| Composer | floating glass, `xl` radius, round send in accent | `Composer` | `Composer` (ChatParts.swift) |
| Agent face | own picture → catalog mark → initial, on `accent-soft` | `AgentFace` (`agents/identity.tsx`) | `AgentAvatar` |

## 4. States

- **Loading:** skeleton rows in the shape of what is coming, breathing gently; still under
  reduced motion. Never a lone spinner on an empty page (web `Skeleton`/`SkeletonGroup`,
  iOS `SkeletonList` inside `AsyncContent`).
- **Empty:** the page's own icon in a soft circle, one line saying what is missing, an optional
  sentence and at most one action (web `EmptyState`, iOS `EmptyStateView` / `EmptyRow`).
- **Error:** a plain title («حدث خطأ» / "Something went wrong"), the hub's own sentence under
  it, and one retry. Inline errors use `Notice` / `NoticeView` in the danger tone.
- **Working:** the thinking line always counts seconds (DESIGN.md, "The thinking indicator").

## 5. Voice

- Arabic first, English beside it, both complete; a workspace is «بروفايل» / "profile".
- Sentence case in English ("Skill commands", not "skill commands" or "Skill Commands").
- Name the agent: the composer says «راسل Hermes…» / "Message Hermes…"; a reply is signed with
  the agent's registry name, never the hub's placeholder «agent».
- No keyboard hints inside fields (Enter sends everywhere; on a phone a hint is noise).
- Counts agree: "1 task", "1 tool" — not "1 tasks".
- Buttons are verbs ("Link a platform", «أضف مزوّدًا»); a disabled control says why.
- The product's name appears once per screen (the sidebar's brand), not again in the top bar;
  the top bar names the hub only when the owner gave it a name of its own.

## 6. Phone adaptations — the same family, re-arranged

A phone (and any web window under 48rem) shows the same things in less room. Do this, not
a squeezed desktop:

| On a wide screen | On a phone |
|---|---|
| "Connected" badge in the footer | the dot alone; its words stay the accessible name |
| An agent's status pill "Available" | a green dot beside its name; a pill only when something is wrong |
| Inbox and background buttons always in the top bar | shown only when they hold something, with the count |
| A row of chat controls in the top bar | the agent stays, the rest go under ⋯ |
| "Back to chats" as the first row of the settings list | the back button in the navigation bar |
| Capabilities as chips | one quiet line of words |
| Many actions on a row | one primary action; the rest in a menu or a sheet |
| Hover tooltips | the words themselves, or a long-press menu |

Tap targets are at least 44 × 44 points. A control that must stay small in a dense row keeps its
drawn size and presses over a larger area (iOS `hitSlop`, `tapTarget`).

## 7. Motion

One ease (`motion.ease`), three durations. Things that change state cross-fade (loading →
content) or ease (a chevron turns 180°, a tick fills). Nothing bounces, nothing loops except
the thinking dots and a restart that is under way. `prefers-reduced-motion` / Reduce Motion
stops decorative movement; information (the seconds counter) keeps going.

## 8. How it is checked

- `packages/web/tests/lucide-icons.test.tsx` — the web's outlines are lucide-static's, unchanged;
  icons.tsx draws no path of its own; every destination has its icon.
- `packages/web/e2e/zzzzzzzzzzz-design-family.spec.ts` — icons on every rail and settings row,
  Lucide strokes in the sidebar, no repeated product name in the top bar, the connection dot on
  a phone; and the screenshot pass (desktop and phone, Arabic and English, light and dark).
- `apps/ios/CoreHubTests/FamilyTests.swift` — every Lucide asset is in the catalog, every
  destination has the web's icon, the theme pictures match.
- `.github/workflows/ios.yml` — no SF Symbol in the app.
- `packages/ui-tokens/tests/contrast.test.ts` — every colour pair at WCAG AA in both themes.
