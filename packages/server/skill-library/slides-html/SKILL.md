---
name: slides-html
description: Make a slide deck as one HTML file from Markdown.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [slides, presentation, deck, html, markdown, rtl, عرض, شرائح, سلايدات, عرض تقديمي]
    category: core-hub
    related_skills: [powerpoint, report-writer, data-to-chart, image-generate]
  core_hub:
    library: core-hub
---

# Slides HTML Skill

Writes a presentation as Markdown (slides separated by `---`) and turns it into one self-contained
HTML file that opens in Core Hub's file preview beside the chat, in any browser, offline and in
print (one page per slide). Arabic slides run right-to-left automatically, English ones
left-to-right, and a mixed deck sets the direction per slide. Local images are embedded so the
file works on its own. For an editable PowerPoint file, use Hermes's `powerpoint` skill instead
(the same Markdown outline is a good start for it).

يصنع عرضًا تقديميًا من Markdown في ملف HTML واحد يُفتح في معاينة الملفات، ويضبط الاتجاه للعربية.

## When to Use

- «سوّ لي عرض/سلايدات عن…»، «حوّل التقرير إلى عرض»، "make a deck", "turn these notes into slides".
- Quick internal presentations, briefings, lesson slides, a summary of a report or research.

## Prerequisites

Python 3 only. Charts from `data-to-chart` (SVG) and pictures from `image-generate` can be used
as images.

## How to Run

```
python3 <skill_dir>/scripts/make_slides.py deck.md --out deck.html
python3 <skill_dir>/scripts/make_slides.py deck.md --theme dark
python3 <skill_dir>/scripts/make_slides.py deck.md --dir rtl --title "خطة الربع الرابع"
```

Prints `{"ok": true, "file": "deck.html", "slides": N, "bytes": ...}`.

## Quick Reference

```markdown
<!-- class: title -->
# عنوان العرض
الاسم · التاريخ

---

## الفكرة الأولى
- نقطة قصيرة
- نقطة ثانية **مهمة**

ملاحظة: ما سأقوله شفهيًا هنا (يظهر بالضغط على N)

---

## النتائج
| المؤشر | القيمة |
|---|---|
| النمو | ‏12% |

![المبيعات](charts/sales.svg)
```

Supported: headings, paragraphs, bold, italic, `code`, links, images, lists (one nested level),
quotes, fenced code, tables, speaker notes (`Note:` / `ملاحظة:`), `<!-- class: title -->`.
In the deck: arrows / space / Page keys to move, Home / End, **N** notes, **F** full screen.

## Procedure

1. Agree on audience, length (default 6–10 slides) and language; outline titles first when the
   topic is broad, then write.
2. One message per slide: a title that states the point, 3–5 short bullets or one visual.
   Put detail in speaker notes, not on the slide.
3. Write `deck.md` in the working folder, build `deck.html`, and fix any warning.
4. Reply with the HTML file (it opens in the preview panel) and the Markdown source path for edits.

## Pitfalls

- Walls of text do not fit: at most ~40 words per slide.
- Remote images are loaded from the web and may be blocked in the preview; prefer local files,
  which are embedded (up to 5 MB each).
- Start Arabic lines with Arabic (or a right-to-left mark before a number/Latin word) so bullets
  align correctly.
- Do not promise PowerPoint compatibility for the HTML file.

## Verification

- `slides` in the JSON equals the number of `---`-separated sections with content.
- Open the file in the preview: the first slide shows, arrows move, the counter is right.
