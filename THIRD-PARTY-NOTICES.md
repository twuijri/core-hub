# Third-party notices

Whole files reused from permissively licensed projects are listed here with
their original notice.

## lobe-icons — the agents' marks

`packages/web/src/ui/brand/marks.tsx` carries the path data of eight marks — Hermes Agent,
Claude Code, Codex, Gemini CLI, opencode, and since 2026-09-25 Qwen Code (`qwen.svg`), Kimi
Code (`kimi.svg`) and Pi (`pi.svg`, lobe-icons' "Pi Agent", https://pi.dev) — taken from
[`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) `1.95.1` (verified
2026-09-22 and again 2026-09-25). Eight files out of nine hundred are copied in rather than
depended on, so the client carries the marks it shows and not a 2.4 MB package. They are redrawn into our own
`Mark` wrapper (one `viewBox`, `currentColor`, a `size` prop) and stripped of their
`<title>` elements, because the control around them already names the agent. Since 2026-09-27
the iOS and Android apps carry the same marks, written from that file by
`scripts/icons/agent-marks-mobile.mjs` (`apps/ios/CoreHub/Resources/Assets.xcassets/AgentMarks`,
`apps/android/app/src/main/res/drawable/agent_mark_*.xml`).

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
SST, Nous Research, Alibaba Cloud's Qwen team, Moonshot AI and Earendil. Core Hub shows each one only to identify the agent it names, which is
what a trademark is for. Core Hub is not affiliated with, endorsed by, or a product of any
of them. The ninth mark, for our own `direct` agent, is drawn by us.

## Lucide — the icons of every client

The web client, the desktop app (which shows the web client), and the iOS and Android apps draw
their icons from [Lucide](https://lucide.dev)
([`lucide-static`](https://www.npmjs.com/package/lucide-static) `1.48.0`, a root dev dependency, pinned).
`scripts/icons/lucide-mobile.mjs` reads the outlines of the icons listed in
`scripts/icons/lucide-mobile.json` from the package's `icon-nodes.json` and writes them as template
images in `apps/ios/CoreHub/Resources/Assets.xcassets/Lucide/` and as vector drawables
`apps/android/app/src/main/res/drawable/lucide_*.xml`; `scripts/icons/lucide-web.mjs` writes the
outlines the web asks for into `packages/web/src/ui/lucide.generated.ts`, which ships inside the web
bundle. Each generated file names the package and its licence. Some Lucide icons derive from Feather (MIT, Copyright (c) 2013-present Cole Bemis), as the
package's own licence file lists.

ISC License · Copyright (c) 2026 Lucide Icons and Contributors

> Permission to use, copy, modify, and/or distribute this software for any purpose with or without
> fee is hereby granted, provided that the above copyright notice and this permission notice appear
> in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
> SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
> AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
> NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
> OF THIS SOFTWARE.

## fflate — reading Office files in the web client

The web client bundles [`fflate`](https://github.com/101arrowz/fflate) `0.8.3` (an npm
dependency, not a copied file) to unpack XLSX, DOCX and PPTX files for the file preview
beside the chat (contract decision §48). Only `unzipSync` is used, in a chunk loaded the first
time an Office file is opened (about 13 KB, 6 KB compressed).

MIT License · Copyright (c) 2026 Arjun Barrett (as the package's `LICENSE` says)

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

## The web terminal's two libraries

The owner's web terminal (DECISIONS §70) is built on two npm packages. They are dependencies,
not copied source — the rule at the end of this file would leave them out — but both are
**redistributed** in a form their `node_modules` copy does not travel with, so they are noted
here on the owner's request (2026-09-25):

| Package | Version | Licence | Where it ships |
|---|---|---|---|
| [`node-pty`](https://github.com/microsoft/node-pty) | `1.1.0` | MIT — Copyright (c) 2012-2015 Christopher Jeffrey; (c) 2016 Daniel Imms; (c) 2018-present Microsoft Corporation | compiled into the image (`build/Release/pty.node`, `packages/server/Dockerfile`) |
| [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) and [`@xterm/addon-fit`](https://github.com/xtermjs/xterm.js) | `6.0.0`, `0.11.0` | MIT — Copyright (c) 2017-2019 The xterm.js authors; (c) 2014-2016 SourceLair Private Company; (c) 2012-2013 Christopher Jeffrey | bundled into the web client's lazily loaded Terminal chunk |

Both under the MIT licence quoted in full above (lobe-icons), with the copyright lines in the
table. Their `LICENSE` files are in their packages in `node_modules`.

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
