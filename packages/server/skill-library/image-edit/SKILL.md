---
name: image-edit
description: Edit an image, vary it, or cut out its background.
version: 1.2.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
required_environment_variables:
  - name: COREHUB_IMAGE_MODEL
    prompt: Set by Core Hub from Models → Images; never typed by hand
    optional: true
  - name: COREHUB_IMAGE_PROVIDER
    prompt: Set by Core Hub from Models → Images
    optional: true
  - name: COREHUB_IMAGE_BASE_URL
    prompt: Set by Core Hub from Models → Images
    optional: true
  - name: COREHUB_IMAGE_API_KEY
    prompt: Set by Core Hub from the chosen provider's key (absent for the ChatGPT subscription)
    optional: true
metadata:
  hermes:
    tags: [image, edit, variation, inpaint, retouch, restyle, background, cutout, تعديل, صورة, نسخ, تنويع, خلفية, قص, إزالة الخلفية]
    category: core-hub
    related_skills: [image-generate, image-convert, image-describe]
  core_hub:
    library: core-hub
---

# Image Edit Skill

Changes an existing image by an instruction ("make the sky sunset orange", «غيّر لون السيارة
إلى الأزرق»), puts the subject in a new setting or style, makes variations of it, or cuts the
subject out of its background — all with the image model chosen for this profile in Core Hub
(Models → Images). Hermes's `image_generate` tool uses the same model when it offers
`image_url`; otherwise the helper script does. Pixel operations that need no model — resize,
crop, rotate, convert, compress, make a plain background transparent — belong to `image-convert`.

يعدّل صورة موجودة بتعليمات، أو يصنع منها نسخًا متنوعة، أو يزيل خلفيتها ويقصّ العنصر، بنموذج الصور
المختار في Core Hub (النماذج ← الصور).

## When to Use

- "Change / replace / remove / add … in this image", «عدّل الصورة»، «شيل الشخص من الخلفية»،
  «خلها بأسلوب كرتوني»، «أبغى نسخ ثانية منها».
- "Remove the background", «شيل الخلفية»، «خلفية شفافة»، «قص المنتج من الصورة» — for a photo whose
  background is not plain (a plain one is `image-convert transparent-bg` alone, no model).
- Variations of a logo, a product shot or an illustration.
- Not for a brand-new image (`image-generate`) or exact pixel work (`image-convert`).

## Prerequisites

The same as `image-generate`: an image model chosen in Core Hub → Models → Images. Without one
the script answers `image_model_not_chosen` — tell the person to choose one there («اختر نموذج
صور في النماذج ← الصور»); never ask for a key. Imagen models do not edit; the error says so, and
a Gemini or gpt-image model does.

## How to Run

```
python3 <skill_dir>/scripts/image_api.py edit --image photo.jpg --prompt "..." --out images
python3 <skill_dir>/scripts/image_api.py edit --image room.png --mask mask.png --prompt "..."
python3 <skill_dir>/scripts/image_api.py vary --image logo.png --n 3
python3 <skill_dir>/scripts/image_api.py vary --image logo.png --prompt "keep the shape, try warmer colours"
python3 <skill_dir>/scripts/image_api.py remove-bg --image product.jpg --out images
```

`--image` may be repeated for reference images. A mask is a PNG the size of the image whose
transparent pixels mark the area to change (Images-API models).

## Quick Reference

| Request | Do |
|---|---|
| change part of the picture | `edit` with a precise instruction; a mask when only one area may change |
| same subject, new style | `edit` with "Redraw this image as …" |
| a few alternatives | `vary` (`--n` up to 4) |
| remove a background (photo) | `remove-bg`; if it answers `"transparent": false`, run its `next` step |
| remove a plain background | `image-convert transparent-bg` alone — no model needed |

## Removing a background

`remove-bg` sends the image to the chosen model's edit endpoint to cut the subject out:

- a gpt-image model is asked for a transparent background directly — the answer says
  `"transparent": true` and the PNG is ready;
- any other model (Gemini, a chat image model) puts the subject on a flat pure-green background
  (`--bg-color` to change it, e.g. when the subject is green) and answers `"transparent": false`
  with a `next` command: run `image-convert`'s `transparent-bg` on that file (replace
  `<image-convert skill_dir>` with that skill's folder from `skill_view("image-convert")`). That
  bundled step clears the flat colour locally, with no model.

## Procedure

1. Find the source image: a path the person gave, a file in the conversation's folder
   (`search_files target='files'`), or an attachment. If there are several, ask which.
2. If the instruction is vague, look first with `vision_analyze` and restate what you will change.
3. Write the instruction in English, naming what must stay the same ("keep the face, pose and
   lighting unchanged") as well as what changes.
4. Edit with `image_generate` (`image_url` = the absolute path, `prompt` = the instruction) when
   it offers `image_url`; otherwise run the script. For a background removal use the script's
   `remove-bg` and follow its `next` step. Save results next to the original, never over it.
5. Reply with the new file(s) as Markdown images and one line on what changed.

## Pitfalls

- Never overwrite the original file; the script always writes new files under `--out`.
- Edits of faces and identity documents: refuse deceptive or harmful changes.
- Text inside images (especially Arabic) may be mangled; say so rather than promising it.
- A model may redraw details while cutting out: compare with the original and say so if it did.
- Keys come only from Core Hub; never place one in a command or a reply, never ask for one.

## Verification

- `"ok": true` and the new files exist; compare before/after with `vision_analyze` when the
  person asked for a specific change.
- After a background removal the final file is a PNG with transparency (`"transparent": true`,
  or `transparent-bg` reported a `cleared_share` above zero).
