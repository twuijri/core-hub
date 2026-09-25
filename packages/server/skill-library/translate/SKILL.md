---
name: translate
description: Translate between Arabic and English, keeping formatting.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [translate, translation, arabic, english, localisation, i18n, ترجمة, عربي, إنجليزي, تعريب]
    category: core-hub
    related_skills: [report-writer, proofread, summarize, image-describe]
  core_hub:
    library: core-hub
---

# Translate Skill

Translates text and documents between Arabic and English (and from other languages into either)
so that the result reads as if written in the target language, while everything that is not
prose survives exactly: Markdown structure, tables, code, links, placeholders, numbers and names.
A checker script compares the source and the translation and lists what was lost. Arabic output
is then passed through the RTL fixer of `report-writer` so it displays right-to-left.

يترجم بين العربية والإنجليزية ترجمة طبيعية، ويحافظ على التنسيق والجداول والروابط والأرقام.

## When to Use

- «ترجم هذا للإنجليزي/للعربي»، «عرّب الواجهة»، "translate this document", "localise these strings".
- Files in the working folder (`.md`, `.txt`, `.json` string tables) or pasted text.
- For a summary in another language, `summarize` is enough; for polishing a text that is already
  in the right language, `proofread`.

## Prerequisites

None beyond `read_file` / `write_file`. The checker needs only Python 3.

## How to Run

```
python3 <skill_dir>/scripts/translate_check.py report.md report.en.md
```

It prints `{"ok": true, "clean": true|false, "problems": [{"check": ..., "missing": [...], ...}]}`.
For Arabic results, also run `report-writer`'s `rtl_md.py fix` (its `skill_dir` comes from
`skill_view("report-writer")`).

## Quick Reference

| Keep unchanged | Translate |
|---|---|
| code blocks, inline code, commands, file paths | headings, paragraphs, list items, table cells |
| URLs and link targets, image paths | link texts and image alt texts |
| placeholders `{name}`, `{{x}}`, `%s`, `:id`, `${var}` | the words around them, reordered naturally |
| product and brand names, people's names (transliterate only if asked) | UI labels, when localising |
| numbers, dates' values, units | month names and date order to the target style |

Style: Modern Standard Arabic by default (ask before using a dialect); English in plain,
active voice. Keep the register — formal stays formal. Terms with an established Arabic
equivalent use it (الذكاء الاصطناعي، واجهة برمجة التطبيقات); otherwise keep the English term in
parentheses after the Arabic the first time.

## Procedure

1. Identify source language, target language, audience and any glossary the person gave.
2. Long documents: translate section by section in order (use `summarize`'s `chunk.py` to split
   if needed), keeping a glossary of recurring terms so they stay consistent.
3. Write the translation to a new file beside the source (`name.en.md`, `name.ar.md`); never
   overwrite the source.
4. Run `translate_check.py` and fix every problem it lists, then re-run until `clean` is true or
   the remaining items are deliberate (say which and why).
5. Arabic output: run `rtl_md.py fix` on it.
6. Reply with the file path and any terms you were unsure of, each with the alternative.

## Pitfalls

- Do not translate inside code, URLs, JSON keys or placeholders.
- Do not add or drop content; a translator's note goes in brackets and is labelled.
- Numbers: keep their value; switching to Arabic-Indic digits is a style choice — follow the
  document's existing style, and never mix both in one document.
- Right-to-left: a line that starts with an English word will display left-to-right; rephrase or
  let `rtl_md.py` add a right-to-left mark.

## Verification

- `translate_check.py` reports `clean: true` (or only reviewed, explained items).
- A native-speaker read of the first paragraph: it sounds written, not translated.
