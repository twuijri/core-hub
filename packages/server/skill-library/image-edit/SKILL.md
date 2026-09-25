---
name: image-edit
description: Edit an image by instruction, or make variations of it.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
required_environment_variables:
  - name: COREHUB_IMAGE_API_KEY
    prompt: API key for the image provider (only when the image_generate tool cannot edit)
    optional: true
  - name: COREHUB_IMAGE_BASE_URL
    prompt: Base URL of an OpenAI-compatible or Gemini image API
    optional: true
  - name: COREHUB_IMAGE_MODEL
    prompt: Image model id
    optional: true
  - name: COREHUB_IMAGE_PROVIDER
    prompt: openai, compatible or gemini
    optional: true
metadata:
  hermes:
    tags: [image, edit, variation, inpaint, retouch, restyle, تعديل, صورة, نسخ, تنويع, خلفية]
    category: core-hub
    related_skills: [image-generate, image-convert, image-describe]
  core_hub:
    library: core-hub
---

# Image Edit Skill

Changes an existing image by an instruction ("make the sky sunset orange", «غيّر لون السيارة
إلى الأزرق»), puts the subject in a new setting or style, or makes variations of it. It uses
Hermes's `image_generate` tool with the source image when the profile's image model can edit,
and otherwise the helper script against OpenAI Images, Gemini, or an OpenAI-compatible API.
Pixel operations that need no model — resize, crop, rotate, convert, compress, make a plain
background transparent — belong to `image-convert`.

يعدّل صورة موجودة بتعليمات، أو يصنع منها نسخًا متنوعة.

## When to Use

- "Change / replace / remove / add … in this image", «عدّل الصورة»، «شيل الشخص من الخلفية»،
  «خلها بأسلوب كرتوني»، «أبغى نسخ ثانية منها».
- Variations of a logo, a product shot or an illustration.
- Not for a brand-new image (`image-generate`) or exact pixel work (`image-convert`).

## Prerequisites

The same as `image-generate`: Hermes's `image_generate` tool (it advertises `image_url` only
when the active model can edit), or a key for the script in `COREHUB_IMAGE_API_KEY` /
`OPENAI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY`, with `COREHUB_IMAGE_BASE_URL` for an
OpenAI-compatible server. Imagen models do not edit; use a Gemini image model for Gemini edits.

## How to Run

```
python3 <skill_dir>/scripts/image_api.py edit --image photo.jpg --prompt "..." --out images
python3 <skill_dir>/scripts/image_api.py edit --image room.png --mask mask.png --prompt "..."
python3 <skill_dir>/scripts/image_api.py vary --image logo.png --n 3
python3 <skill_dir>/scripts/image_api.py vary --image logo.png --prompt "keep the shape, try warmer colours"
```

`--image` may be repeated for reference images. A mask is a PNG the size of the image whose
transparent pixels mark the area to change (OpenAI-style APIs).

## Quick Reference

| Request | Do |
|---|---|
| change part of the picture | `edit` with a precise instruction; a mask when only one area may change |
| same subject, new style | `edit` with "Redraw this image as …" |
| a few alternatives | `vary` (`--n` up to 4) |
| remove a busy background | `edit` "replace the background with plain white"; then `image-convert transparent-bg` if they want transparency |

## Procedure

1. Find the source image: a path the person gave, a file in the conversation's folder
   (`search_files target='files'`), or an attachment. If there are several, ask which.
2. If the instruction is vague, look first with `vision_analyze` and restate what you will change.
3. Write the instruction in English, naming what must stay the same ("keep the face, pose and
   lighting unchanged") as well as what changes.
4. Edit with `image_generate` (`image_url` = the absolute path, `prompt` = the instruction) when
   it offers `image_url`; otherwise run the script. Save results next to the original, never
   over it.
5. Reply with the new file(s) as Markdown images and one line on what changed.

## Pitfalls

- Never overwrite the original file; the script always writes new files under `--out`.
- Edits of faces and identity documents: refuse deceptive or harmful changes.
- Text inside images (especially Arabic) may be mangled; say so rather than promising it.
- Keys come only from the environment; never place one in a command or a reply.

## Verification

- `"ok": true` and the new files exist; compare before/after with `vision_analyze` when the
  person asked for a specific change.
