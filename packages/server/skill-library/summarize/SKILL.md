---
name: summarize
description: Summarise a document, a web page or a long text.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [summary, summarize, tl;dr, key points, document, url, article, تلخيص, ملخص, خلاصة, نقاط, مقال]
    category: core-hub
    related_skills: [pdf, docx, research-brief, translate, report-writer]
  core_hub:
    library: core-hub
---

# Summarize Skill

Produces a faithful summary of a file in the conversation's folder, a URL, or pasted text — in
the language the person asks for, which may differ from the source's. Short sources are read
whole; long ones are split into ordered chunks by a helper script, summarised chunk by chunk,
then combined, so nothing in the middle is silently dropped. Extraction from PDF and Word files
is the job of the `pdf` and `docx` skills; this skill decides what the summary says.

يلخّص ملفًا أو رابطًا أو نصًا طويلًا بالعربية أو الإنجليزية، دون إسقاط وسط المستند.

## When to Use

- «لخّص لي هذا الملف/الرابط»، «أعطني أهم النقاط»، "TL;DR", "summarise this report in Arabic".
- Meeting notes, reports, articles, contracts (as an overview — not legal advice), long chats.
- For action items with owners and deadlines, Hermes's `document-to-action-items` is the better fit.

## Prerequisites

- `read_file` for text and Markdown; `web_extract` for URLs.
- PDF / DOCX / XLSX: load the `pdf`, `docx` or `xlsx` skill to extract the text first (to a
  `.md` or `.txt` file in the working folder).

## How to Run

```
python3 <skill_dir>/scripts/chunk.py notes.md --max-chars 12000
python3 <skill_dir>/scripts/chunk.py extracted.txt --out-dir chunks
```

It prints `{"ok": true, "total_chars": N, "chunks": [{"index", "heading", "chars", "text"|"file"}]}`.
Chunks follow headings and paragraphs; code blocks are never cut.

## Quick Reference

| Length asked | Shape |
|---|---|
| one line | a single sentence with the main point |
| short (default) | 3–7 bullet points, most important first |
| executive | «الخلاصة» / "Bottom line" paragraph, then key points, then risks/next steps |
| detailed | one short section per heading of the source |

## Procedure

1. Get the text: `read_file`, `web_extract` (for a URL), or the extraction skills. If a URL
   fails, try Hermes's `blocked-page-recovery` skill before giving up.
2. Under ~12,000 characters: summarise directly. Longer: run `chunk.py`, write a 3–5 line
   summary of every chunk in order (keep numbers, names, dates), then write the final summary
   from those notes.
3. Answer in the language the person used unless they asked otherwise; keep proper nouns, figures
   and dates exactly as in the source. Arabic summaries start each line with Arabic, not with a
   Latin word or a number, so they display right-to-left.
4. State the source (file name or URL) at the top and say when the source was partial
   (paywall, extraction gaps, OCR).
5. Offer one follow-up: a longer version, a translation, or a report (`report-writer`).

## Pitfalls

- A summary adds nothing that is not in the source; opinions are labelled as such.
- Do not stop at the first chunk: every chunk must contribute.
- Numbers are copied, never rounded or recomputed, unless asked.
- Quote at most a sentence or two of the source verbatim.

## Verification

- Every chunk index appears in your notes; the final summary covers the start, middle and end.
- Key figures in the summary can be found in the source text.
