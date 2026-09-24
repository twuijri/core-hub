# Third-party notices

Whole files reused from permissively licensed projects are listed here with
their original notice.

## lobe-icons — the agents' marks

`packages/web/src/ui/brand/marks.tsx` carries the path data of five marks — Hermes Agent,
Claude Code, Codex, Gemini CLI and opencode — taken from
[`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) `1.95.1` (verified
2026-09-22). Five files out of nine hundred are copied in rather than depended on, so the
client carries the marks it shows and not a 2.4 MB package. They are redrawn into our own
`Mark` wrapper (one `viewBox`, `currentColor`, a `size` prop) and stripped of their
`<title>` elements, because the control around them already names the agent.

MIT License · Copyright (c) 2023 LobeHub

> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify,
> merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following
> conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
> INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
> PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
> LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT
> OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
> OTHER DEALINGS IN THE SOFTWARE.

**Trademarks.** The marks themselves belong to their owners — Anthropic, OpenAI, Google,
SST and Nous Research. Core Hub shows each one only to identify the agent it names, which is
what a trademark is for. Core Hub is not affiliated with, endorsed by, or a product of any
of them. The sixth mark, for our own `direct` agent, is drawn by us.

## Ideas taken, code not taken

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
