---
name: image-convert
description: Resize, crop, convert or compress image files.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [image, resize, crop, convert, compress, png, jpeg, webp, transparent, تحجيم, قص, تحويل, ضغط, صورة]
    category: core-hub
    related_skills: [image-generate, image-edit, image-describe]
  core_hub:
    library: core-hub
---

# Image Convert Skill

Exact, repeatable pixel work on image files with Pillow: resize, crop to a box or an aspect
ratio, pad to a shape, convert between PNG/JPEG/WebP/GIF/BMP/TIFF/ICO, compress under a size,
rotate or flip, strip metadata (GPS included), build a contact sheet, and make a **plain**
background transparent. No model and no network — the result is the same every time. Creative
changes ("remove the person", "make it look like a painting") belong to `image-edit`.

عمليات دقيقة على ملفات الصور: تحجيم، قص، تحويل الصيغة، ضغط، تدوير، حذف البيانات الوصفية،
وجعل الخلفية السادة شفافة.

## When to Use

- «صغّر الصورة»، «قصها مربع»، «حوّلها PNG»، «خلها أقل من ٢٠٠ كيلو»، «شيل الموقع من الصورة».
- Preparing images for a slide (16:9), a profile picture (1:1), a story (9:16), a favicon (ICO).
- Not for generating or redrawing content (`image-generate`, `image-edit`).

## Prerequisites

Pillow in the Python that runs the script (Hermes's venv has it). Check once with
`python3 <skill_dir>/scripts/image_tools.py info <image>`; `pillow_missing` means it is not there.

## How to Run

```
python3 <skill_dir>/scripts/image_tools.py info photo.jpg
python3 <skill_dir>/scripts/image_tools.py resize photo.jpg --max 1600 --out out/photo-1600.jpg
python3 <skill_dir>/scripts/image_tools.py crop photo.jpg --aspect 16:9 --gravity center
python3 <skill_dir>/scripts/image_tools.py crop scan.png --box 120,80,900,600
python3 <skill_dir>/scripts/image_tools.py pad logo.png --aspect 1:1 --color '#ffffff'
python3 <skill_dir>/scripts/image_tools.py convert logo.png --to webp --quality 85
python3 <skill_dir>/scripts/image_tools.py compress photo.jpg --max-kb 200
python3 <skill_dir>/scripts/image_tools.py rotate photo.jpg --auto
python3 <skill_dir>/scripts/image_tools.py strip photo.jpg --out photo-clean.jpg
python3 <skill_dir>/scripts/image_tools.py sheet a.png b.png c.png --cols 3 --out sheet.png
python3 <skill_dir>/scripts/image_tools.py transparent-bg logo.jpg --tolerance 24
```

Every command prints `{"ok": true, "file": ..., "width": ..., "height": ..., "bytes": ...}` or
`{"ok": false, "error": ..., "message": ...}`. Without `--out` a new file is written beside the
source with a suffix (`-crop`, `-small`, `-1600x900` …); the source is never replaced.

## Quick Reference

| Use | Command |
|---|---|
| slide / cover | `crop --aspect 16:9` then `resize --width 1920` |
| profile picture | `crop --aspect 1:1` then `resize --width 512` |
| story / reel | `crop --aspect 9:16` or `pad --aspect 9:16` to keep everything |
| e-mail or upload limit | `compress --max-kb 300` (JPEG) or `--to webp` |
| favicon | `convert --to ico` from a square PNG |
| privacy before sharing | `strip` (removes EXIF, GPS, camera data) |
| logo on white → transparent | `transparent-bg` (plain backgrounds only) |

## Procedure

1. Run `info` first: size, format, orientation and alpha decide the right command.
2. Apply the camera's orientation (`rotate --auto`) before cropping a phone photo; the other
   commands already do this.
3. Chain commands through files for multi-step jobs; name the final file clearly.
4. Reply with the result path as a Markdown image, its new size and bytes, in the person's
   language.

## Pitfalls

- JPEG has no transparency: converting a transparent PNG to JPEG puts it on white.
- `transparent-bg` only clears pixels connected to the border and close to the corner colour.
  On a photograph it clears little or nothing, and the JSON says so (`warning`). There is no
  subject-segmentation model in this setup; offer `image-edit` ("put the subject on plain white")
  and then `transparent-bg`.
- Upscaling (`--scale 2`, `--upscale`) adds pixels, not detail.
- Keep the original: always write a new file unless the person asked to replace it.

## Verification

- The JSON `width`/`height`/`bytes` match what was asked (`compress` must be ≤ the limit).
- For crops and transparency, look at the result with `vision_analyze` when it matters.
