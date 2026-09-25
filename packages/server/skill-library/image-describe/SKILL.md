---
name: image-describe
description: Describe an image or read its text (OCR), any language.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [image, vision, describe, ocr, read text, screenshot, receipt, alt text, وصف, قراءة, نص, صورة, استخراج]
    category: core-hub
    related_skills: [image-convert, pdf, translate, summarize]
  core_hub:
    library: core-hub
---

# Image Describe Skill

Looks at an image and says what is in it, or copies out the text it contains — Arabic, English
or mixed — keeping lines, tables and reading order. It uses Hermes's `vision_analyze` tool, and a
small preparation script that turns the image upright, enlarges faint text, crops to a region
and cuts long screenshots into tiles the model can actually read. Scanned PDFs belong to the
`pdf` skill; this skill is for image files.

يصف الصورة أو يستخرج النص المكتوب فيها بالعربية أو الإنجليزية مع الحفاظ على الأسطر والجداول.

## When to Use

- «وش في الصورة؟»، «اقرأ لي النص اللي في الصورة»، «طلّع الجدول من هالصورة»، «اكتب وصف بديل».
- Screenshots of errors or chats, receipts, whiteboards, forms, signs, charts, product photos.
- Alt text for a website or a document.

## Prerequisites

- `vision_analyze` available in this conversation (the profile's model or Hermes's auxiliary
  vision model can see images). If it is not, say that images cannot be read here.
- Pillow for the preparation script (Hermes's venv has it).

## How to Run

```
python3 <skill_dir>/scripts/ocr_prep.py prepare receipt.jpg
python3 <skill_dir>/scripts/ocr_prep.py prepare scan.png --enhance
python3 <skill_dir>/scripts/ocr_prep.py prepare page.png --box 0,400,1200,800
python3 <skill_dir>/scripts/ocr_prep.py prepare long-screenshot.png --tile-height 1600
```

It prints `{"ok": true, "files": [...], "tiles": N}`. Pass each file, in order, to
`vision_analyze` with the question below.

## Quick Reference

| Goal | Question to `vision_analyze` |
|---|---|
| describe | "Describe this image: subject, setting, notable details, any visible text." |
| OCR | "Transcribe all text exactly as written, line by line, in its original language and script. Keep numbers, punctuation and line breaks. Mark unreadable parts as [؟] / [?]. Do not translate or summarise." |
| table | "Transcribe the table as a Markdown table with the same columns and rows. Empty cells stay empty." |
| alt text | "Write one sentence of alt text, under 125 characters." |
| chart | "Read the chart: title, axes, series and the values you can see." |

## Procedure

1. Locate the image (a path, an attachment, or `search_files target='files'`).
2. For text, always run `prepare` first; add `--enhance` for faint scans or photos of paper,
   `--box` when only one region matters.
3. Call `vision_analyze` per prepared file. For tiles, transcribe each and join them, removing the
   lines repeated in the overlap.
4. Arabic text: keep it as written (hamza, taa marbuta, diacritics if present); put each Arabic
   line in the reply as its own line so it reads right-to-left; keep Latin words and numbers
   inside it as they appear.
5. Reply in the person's language: a description in prose, a transcription in a fenced block or
   a Markdown table. Offer `translate` or `summarize` as the next step when useful.

## Pitfalls

- Do not guess unreadable characters; mark them.
- Do not "fix" spelling in a transcription unless asked — it is a copy.
- Faces: describe, never identify a real person from their face.
- Very small text in a large photo: crop with `--box` rather than asking the model to squint.

## Verification

- Numbers and totals in a receipt or table add up as transcribed (check with a short
  calculation when they are the point).
- Every tile was read; the line count roughly matches the image.
