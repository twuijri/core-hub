---
name: report-writer
description: Write a report, memo or letter in Arabic or English.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [report, memo, letter, document, writing, markdown, rtl, arabic, تقرير, مذكرة, خطاب, كتابة, مستند]
    category: core-hub
    related_skills: [docx, pdf, proofread, translate, summarize, data-to-chart]
  core_hub:
    library: core-hub
---

# Report Writer Skill

Writes a structured report, an internal memo or a formal letter as Markdown in the conversation's
folder — in Arabic, English, or both — and makes sure Arabic displays right-to-left correctly: every
line starts with an Arabic letter or a right-to-left mark, Arabic punctuation (، ؛ ؟) is used, and
tables read from the right. A helper script checks and fixes this. For a Word or PDF file, write
the Markdown here first, then hand it to the `docx` or `pdf` skill.

يكتب تقريرًا أو مذكرة أو خطابًا بصيغة Markdown بالعربية أو الإنجليزية، مع ضبط اتجاه النص العربي.

## When to Use

- «اكتب لي تقرير عن…»، «سوّ مذكرة داخلية»، «صغ خطاب رسمي»، "draft a memo / status report".
- Turning notes, a summary (`summarize`) or research (`research-brief`) into a document.

## Prerequisites

None beyond `write_file` / `patch`. Templates are in `<skill_dir>/templates/`
(`report-ar.md`, `report-en.md`, `memo-ar.md`, `memo-en.md`); read the one you need with
`skill_view` (file_path `templates/…`).

## How to Run

```
python3 <skill_dir>/scripts/rtl_md.py check report.md
python3 <skill_dir>/scripts/rtl_md.py fix report.md --out report.md
```

`check` prints `{"ok": true, "count": N, "issues": [{"line", "issue", "text"}]}`; `fix` writes the
corrected file and says where.

## Quick Reference

| Kind | Shape |
|---|---|
| memo / مذكرة | header table (إلى، من، التاريخ، الموضوع) → الخلاصة → الخلفية → المطلوب |
| report / تقرير | الملخص التنفيذي → النطاق → النتائج (أرقام وجداول) → المخاطر → التوصيات |
| letter / خطاب | التحية → الموضوع → المتن في فقرات قصيرة → الطلب → الختام والتوقيع |

RTL rules for Arabic Markdown:
- Start every heading, bullet, table cell and paragraph with an Arabic word. When a line must start
  with a Latin name or a number, put U+200F (right-to-left mark) right after the Markdown marker.
- Use «،» «؛» «؟» and Arabic quotation marks « »; keep Latin terms and numbers inside the sentence.
- The first column of a table is the rightmost one: put the label column first.
- Dates: write the month name (٢٥ سبتمبر ٢٠٢٦ or 25 سبتمبر 2026 — one digit style per document).

## Procedure

1. Settle four things, asking only for what is missing: audience, purpose, language, length. Use
   the person's language by default; bilingual means Arabic first, English after a divider.
2. Start from the matching template; drop sections that do not apply rather than leaving them empty.
3. Write plainly: short paragraphs, one idea each, numbers with their units and sources. Put the
   conclusion first in memos and executive summaries.
4. Save as `<topic>-<yyyy-mm-dd>.md` in the working folder with `write_file`.
5. For Arabic or mixed documents run `rtl_md.py check`, then `fix` (to the same file) and re-check
   until `count` is 0 or only `table_row_starts_ltr` items that you have reviewed remain.
6. Reply with the file path, a two-line outline, and an offer to export (`docx`, `pdf`), proofread
   (`proofread`) or translate (`translate`).

## Pitfalls

- Do not invent figures, names or dates; leave a clear placeholder [..] and say so.
- Do not mix Hindi (٠١٢) and Western (012) digits in one document.
- Do not put Arabic inside code blocks for layout; code blocks are always left-to-right.
- A formal letter needs the sender's real details; ask rather than making them up.

## Verification

- `rtl_md.py check` reports no `line_starts_ltr` or `latin_punctuation` issues.
- Headings follow the template order; every section has content.
