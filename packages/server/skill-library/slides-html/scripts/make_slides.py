#!/usr/bin/env python3
# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Build one self-contained HTML slide deck from a Markdown file.

Used by the Core Hub skill `slides-html`. Standard library only; the output has no external
requests (no CDN, no web fonts), so it opens in a sandboxed file preview and offline.

  make_slides.py deck.md [--out deck.html] [--theme light|dark] [--dir auto|rtl|ltr] [--title T]

Markdown: slides are separated by a line containing only `---`. Supported inside a slide:
headings, paragraphs, **bold**, *italic*, `code`, links, images, bullet and numbered lists
(one level of nesting), > quotes, fenced code, and pipe tables. A line starting with `Note:`
(or `ملاحظة:`) begins speaker notes for that slide. `<!-- class: title -->` on its own line makes a
centred title slide.

Keys in the deck: → / ← / space / PageUp / PageDown, Home / End, N for notes, F for full screen.
Each slide's direction is taken from its text unless --dir forces one. Printing gives a page per slide.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import re
import sys
from pathlib import Path

ARABIC = re.compile(r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]")
LATIN = re.compile(r"[A-Za-z]")
SEPARATOR = re.compile(r"^\s*---\s*$")
NOTE = re.compile(r"^\s*(?:Note|Notes|ملاحظة|ملاحظات)\s*:\s*(.*)$", re.I)
CLASS = re.compile(r"^\s*<!--\s*class:\s*([\w -]+?)\s*-->\s*$")


def direction(text: str) -> str:
    arabic = len(ARABIC.findall(text))
    latin = len(LATIN.findall(text))
    return "rtl" if arabic and arabic >= latin * 0.5 else "ltr"


BASE = {"dir": Path("."), "embed": True}
MAX_EMBED = 5 * 1024 * 1024
MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".webp": "image/webp", ".svg": "image/svg+xml"}


def image_source(src: str) -> str:
    """A local picture is embedded as a data: URI, so the deck shows it in a sandboxed preview
    (which loads nothing but data:, blob: and https:) and when the file is moved on its own."""
    if not BASE["embed"] or re.match(r"^(?:https?:|data:|blob:)", src, re.I):
        return src
    path = (BASE["dir"] / src).expanduser()
    mime = MIME.get(path.suffix.lower())
    try:
        if mime and path.is_file() and path.stat().st_size <= MAX_EMBED:
            return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    except OSError:
        pass
    return src


def inline(text: str) -> str:
    """Escape, then apply inline Markdown. Code spans are protected first."""
    codes: list[str] = []

    def keep(match: re.Match) -> str:
        codes.append(f"<code>{html.escape(match.group(1))}</code>")
        return f"\x00{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", keep, text)
    text = html.escape(text, quote=False)
    text = re.sub(
        r"!\[([^\]]*)\]\(([^)\s]+)\)",
        lambda m: f'<img src="{html.escape(image_source(m.group(2)), quote=True)}" alt="{m.group(1).replace(chr(34), "&quot;")}">',
        text,
    )

    def link(match: re.Match) -> str:
        href = match.group(2)
        if re.match(r"^\s*javascript:", href, re.I):
            href = "#"
        return f'<a href="{html.escape(href, quote=True)}">{match.group(1)}</a>'

    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], text)


def table(lines: list[str]) -> str:
    rows = [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in lines]
    if len(rows) >= 2 and all(re.fullmatch(r":?-{2,}:?", cell) for cell in rows[1] if cell):
        head, body = rows[0], rows[2:]
    else:
        head, body = None, rows
    out = ["<table>"]
    if head:
        out.append("<thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead>")
    out.append("<tbody>")
    for row in body:
        out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in row) + "</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def blocks(lines: list[str]) -> str:
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue
        if stripped.startswith("```") or stripped.startswith("~~~"):
            fence = stripped[:3]
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith(fence):
                code.append(lines[i])
                i += 1
            i += 1
            out.append(f'<pre dir="ltr"><code>{html.escape(chr(10).join(code))}</code></pre>')
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            level = len(heading.group(1))
            out.append(f"<h{level}>{inline(heading.group(2))}</h{level}>")
            i += 1
            continue
        if stripped.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i])
                i += 1
            out.append(table(rows))
            continue
        if stripped.startswith(">"):
            quote = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip()[1:].strip())
                i += 1
            out.append(f"<blockquote>{inline(' '.join(quote))}</blockquote>")
            continue
        item = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", line)
        if item:
            ordered = item.group(2)[0].isdigit()
            tag = "ol" if ordered else "ul"
            html_items: list[str] = []
            while i < len(lines):
                current = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", lines[i])
                if not current:
                    break
                if len(current.group(1)) >= 2 and html_items:
                    sub_tag = "ol" if current.group(2)[0].isdigit() else "ul"
                    subs = []
                    while i < len(lines):
                        nested = re.match(r"^(\s{2,})([-*+]|\d+[.)])\s+(.*)$", lines[i])
                        if not nested:
                            break
                        subs.append(f"<li>{inline(nested.group(3))}</li>")
                        i += 1
                    html_items[-1] = html_items[-1][:-5] + f"<{sub_tag}>{''.join(subs)}</{sub_tag}></li>"
                    continue
                html_items.append(f"<li>{inline(current.group(3))}</li>")
                i += 1
            out.append(f"<{tag}>{''.join(html_items)}</{tag}>")
            continue
        paragraph = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~)", lines[i]):
            paragraph.append(lines[i].strip())
            i += 1
        if paragraph:
            out.append(f"<p>{inline(' '.join(paragraph))}</p>")
        else:
            i += 1
    return "\n".join(out)


def split_slides(text: str) -> list[dict]:
    slides: list[dict] = []
    current: list[str] = []
    fenced = False
    for line in text.replace("\r\n", "\n").split("\n"):
        if line.strip().startswith("```") or line.strip().startswith("~~~"):
            fenced = not fenced
        if not fenced and SEPARATOR.match(line):
            slides.append({"lines": current})
            current = []
            continue
        current.append(line)
    slides.append({"lines": current})
    result = []
    for slide in slides:
        lines = slide["lines"]
        if not any(line.strip() for line in lines):
            continue
        classes: list[str] = []
        body: list[str] = []
        notes: list[str] = []
        in_notes = False
        for line in lines:
            klass = CLASS.match(line)
            if klass:
                classes.extend(klass.group(1).split())
                continue
            note = NOTE.match(line)
            if note and not in_notes:
                in_notes = True
                if note.group(1):
                    notes.append(note.group(1))
                continue
            (notes if in_notes else body).append(line)
        result.append({"body": body, "notes": notes, "classes": classes})
    return result


STYLE = """
:root{--bg:#ffffff;--fg:#111827;--muted:#6b7280;--accent:#2563eb;--code:#f3f4f6;--line:#e5e7eb}
:root[data-theme=dark]{--bg:#0f172a;--fg:#e5e7eb;--muted:#94a3b8;--accent:#60a5fa;--code:#1e293b;--line:#334155}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);
font-family:'Noto Sans Arabic','Segoe UI',Tahoma,'Helvetica Neue',Arial,sans-serif}
.deck{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center}.js .deck{height:100%;overflow:hidden}
.slide{display:flex;width:min(100vw,calc(100vh*16/9));height:min(100vh,calc(100vw*9/16));
padding:5% 6%;flex-direction:column;justify-content:flex-start;gap:.6em;font-size:clamp(14px,2.6vmin,34px);line-height:1.45}
.js .slide{display:none}.js .slide.active{display:flex}.slide+.slide{border-top:1px solid var(--line)}.js .slide+.slide{border-top:0}.slide.title{justify-content:center;align-items:center;text-align:center}
.slide.title h1{font-size:2.6em}
h1{font-size:2em;margin:0 0 .3em;color:var(--accent)}h2{font-size:1.5em;margin:0 0 .3em}h3{font-size:1.2em;margin:0}
p{margin:0}ul,ol{margin:0;padding-inline-start:1.3em}li{margin:.25em 0}
img{max-width:100%;max-height:60vh;object-fit:contain;align-self:center}
pre{background:var(--code);padding:.8em 1em;border-radius:.4em;overflow:auto;font-size:.7em;text-align:left}
code{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--code);padding:.05em .3em;border-radius:.25em}
pre code{background:none;padding:0}
blockquote{margin:0;padding-inline-start:.8em;border-inline-start:.25em solid var(--accent);color:var(--muted)}
table{border-collapse:collapse;font-size:.8em}th,td{border:1px solid var(--line);padding:.35em .7em;text-align:start}
th{background:var(--code)}a{color:var(--accent)}
.bar{position:fixed;inset-inline:0;bottom:0;height:4px;background:var(--line)}
.bar i{display:block;height:100%;background:var(--accent);width:0}
.count{position:fixed;bottom:10px;inset-inline-end:16px;color:var(--muted);font-size:13px}
.notes{display:none;position:fixed;inset-inline:0;bottom:0;max-height:35vh;overflow:auto;background:var(--code);
padding:12px 18px;font-size:15px;border-top:1px solid var(--line)}
body.show-notes .notes.active{display:block}
@media print{@page{size:landscape;margin:0}.slide{display:flex!important;width:100vw;height:100vh;page-break-after:always}
.bar,.count,.notes{display:none!important}.deck{display:block;height:auto}}
"""

SCRIPT = """
(function(){document.documentElement.classList.add('js');var s=[].slice.call(document.querySelectorAll('.slide')),n=[].slice.call(document.querySelectorAll('.notes')),
i=0,bar=document.querySelector('.bar i'),count=document.querySelector('.count');
function show(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach(function(e,j){e.classList.toggle('active',j===i)});
n.forEach(function(e,j){e.classList.toggle('active',j===i)});bar.style.width=((i+1)/s.length*100)+'%';
count.textContent=(i+1)+' / '+s.length;try{history.replaceState(null,'','#'+(i+1))}catch(e){}}
document.addEventListener('keydown',function(e){var k=e.key;
if(k==='ArrowRight'||k==='PageDown'||k===' '){show(document.dir==='rtl'&&k==='ArrowRight'?i-1:i+1);e.preventDefault()}
else if(k==='ArrowLeft'||k==='PageUp'){show(document.dir==='rtl'&&k==='ArrowLeft'?i+1:i-1);e.preventDefault()}
else if(k==='Home')show(0);else if(k==='End')show(s.length-1);
else if(k==='n'||k==='N')document.body.classList.toggle('show-notes');
else if((k==='f'||k==='F')&&document.documentElement.requestFullscreen)document.documentElement.requestFullscreen();});
document.addEventListener('click',function(e){if(e.target.closest('a'))return;
var x=e.clientX/window.innerWidth;show((document.dir==='rtl'?x<0.5:x>0.5)?i+1:i-1)});
var h=parseInt((location.hash||'#1').slice(1),10);show(isNaN(h)?0:h-1)})();
"""


def build(text: str, title: str | None, theme: str, forced: str) -> tuple[str, int]:
    slides = split_slides(text)
    if not slides:
        raise ValueError("the Markdown has no slides")
    deck_dir = forced if forced != "auto" else direction(text)
    if not title:
        first = next((line for slide in slides for line in slide["body"] if line.strip().startswith("#")), "Slides")
        title = re.sub(r"^#+\s*", "", first).strip()
    parts = []
    notes = []
    for index, slide in enumerate(slides, start=1):
        body_text = "\n".join(slide["body"])
        slide_dir = forced if forced != "auto" else direction(body_text)
        classes = " ".join(["slide", *slide["classes"]])
        parts.append(f'<section class="{html.escape(classes)}" dir="{slide_dir}" aria-label="{index}">{blocks(slide["body"])}</section>')
        note_html = blocks(slide["notes"]) if slide["notes"] else ""
        notes.append(f'<aside class="notes" dir="{direction(chr(10).join(slide["notes"])) if slide["notes"] else slide_dir}">{note_html}</aside>')
    lang = "ar" if deck_dir == "rtl" else "en"
    document = (
        f'<!doctype html>\n<html lang="{lang}" dir="{deck_dir}" data-theme="{theme}">\n<head>\n<meta charset="utf-8">\n'
        f'<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>{html.escape(title)}</title>\n'
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main class=\"deck\">\n" + "\n".join(parts) + "\n</main>\n"
        + "\n".join(notes)
        + f'\n<div class="bar"><i></i></div><div class="count"></div>\n<script>{SCRIPT}</script>\n</body>\n</html>\n'
    )
    return document, len(slides)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("markdown")
    parser.add_argument("--out")
    parser.add_argument("--theme", choices=["light", "dark"], default="light")
    parser.add_argument("--dir", choices=["auto", "rtl", "ltr"], default="auto")
    parser.add_argument("--title")
    parser.add_argument("--no-embed", action="store_true", help="keep image paths instead of embedding the files")
    args = parser.parse_args(argv)
    source = Path(args.markdown).expanduser()
    if not source.is_file():
        print(json.dumps({"ok": False, "error": "file_not_found", "message": f"no such file: {args.markdown}"}))
        return 2
    BASE["dir"] = source.parent
    BASE["embed"] = not args.no_embed
    try:
        document, count = build(source.read_text(encoding="utf-8"), args.title, args.theme, args.dir)
    except ValueError as error:
        print(json.dumps({"ok": False, "error": "no_slides", "message": str(error)}))
        return 2
    out = Path(args.out).expanduser() if args.out else source.with_suffix(".html")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(document, encoding="utf-8")
    print(json.dumps({"ok": True, "file": str(out), "slides": count, "bytes": out.stat().st_size}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
