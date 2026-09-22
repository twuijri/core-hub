# Third-party notices

Whole files reused from permissively licensed projects are listed here with
their original notice.

**Still empty: no third-party file has been copied into this repository.**

Two entries would be expected here by a reader of `packages/web/src/ui/` and are
deliberately absent, because in both cases we took an idea and wrote our own code
(TEAM-RULES §3 — ideas go to `docs/inspirations/`, copied files come here):

| Project | Licence | Why it is not listed |
|---|---|---|
| [shadcn/ui](https://github.com/shadcn-ui/ui) | MIT (verified 2026-09-22, `shadcn@4.21.0`) | The component kit in `packages/web/src/ui/` follows its *way of working* — own the files, Radix for behaviour, one styling layer you control — and none of its code. Its components carry Tailwind utility classes and a `cn` helper inside the JSX; ours carry no literal colour at all, and their paint lives in `packages/web/src/styles/kit.css` on `--mj-*` tokens. See `docs/inspirations/shadcn-ui.md`. |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT (verified 2026-09-22, `@assistant-ui/react@0.15.21`) | Evaluated for the chat surface and **not adopted**; nothing from it is installed or copied. See `docs/inspirations/assistant-ui.md`. |

Dependencies installed from npm are not listed here: their licences travel with
them in `node_modules` and in `pnpm-lock.yaml`. This file is only for source we
carry ourselves.
