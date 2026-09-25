---
name: image-generate
description: Generate an image from a text prompt, in any language.
version: 1.1.0
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
    prompt: Set by Core Hub from the chosen provider's key
    optional: true
metadata:
  hermes:
    tags: [image, images, generate, picture, illustration, logo, صورة, صور, توليد, رسم, تصميم]
    category: core-hub
    related_skills: [image-edit, image-convert, image-describe]
  core_hub:
    library: core-hub
---

# Image Generate Skill

Turns a description — Arabic or English — into a new image file in the conversation's folder,
with the image model chosen for this profile in Core Hub (Models → Images). That model is one of
the profile's own chat providers' image models; Core Hub hands it to Hermes's `image_generate`
tool and to this skill's script alike, so both draw with the same model. Nobody types a key: the
script reads only what Core Hub wrote, and never prints or stores it.

يولّد صورة جديدة من وصف بالعربية أو الإنجليزية بنموذج الصور المختار في Core Hub (النماذج ← الصور)،
ويحفظها في مجلد المحادثة.

## When to Use

- "Draw / make / generate an image of …", «ارسم لي»، «سوّ صورة»، «ولّد صورة»، «صمّم شعار».
- A cover, an illustration, an icon, a background, a mock-up picture for a slide or a report.
- Not for changing an existing image (use `image-edit`), resizing or converting one
  (`image-convert`), or reading what is in one (`image-describe`).

## Prerequisites

An image model chosen for this profile in Core Hub → Models → Images (the default profile's
choice is inherited when this profile made none). Core Hub then:
- points Hermes's `image_generate` tool at it (the `corehub-images` backend), and
- writes `COREHUB_IMAGE_MODEL`, `COREHUB_IMAGE_PROVIDER`, `COREHUB_IMAGE_BASE_URL` and
  `COREHUB_IMAGE_API_KEY` into the profile for the script.

If none is chosen, the script answers `image_model_not_chosen`: tell the person, in their
language, to choose an image model in Core Hub → Models → Images («اختر نموذج صور في النماذج ←
الصور»). Do not ask them for a key and do not invent a result.

## How to Run

The script lives in this skill's folder (`skill_dir` from `skill_view`):

```
python3 <skill_dir>/scripts/image_api.py providers
python3 <skill_dir>/scripts/image_api.py generate --prompt "..." --size 1024x1024 --out images
python3 <skill_dir>/scripts/image_api.py generate --prompt "..." --aspect 16:9 --out images
```

It prints one JSON object: `{"ok": true, "files": [...], "provider": ..., "model": ...}` or
`{"ok": false, "error": "<code>", "message": ...}`.

## Quick Reference

| Want | `image_generate` | script |
|---|---|---|
| square | `aspect_ratio: "square"` | `--size 1024x1024` or `--aspect 1:1` |
| landscape (slides, covers) | `landscape` | `--size 1536x1024` or `--aspect 16:9` |
| portrait (phone, story) | `portrait` | `--size 1024x1536` or `--aspect 9:16` |
| several options | call it more than once | `--n 2` … `--n 4` |

`--size` is for Images-API models (gpt-image, DALL·E); `--aspect` for Gemini and other chat
image models. `providers` says which kind the chosen model is.

## Procedure

1. Understand the request. If the subject, style or use is unclear, ask **one** short question;
   otherwise proceed with sensible defaults (landscape for slides and covers, square otherwise).
2. Write the prompt in English even when the person wrote Arabic — image models follow English
   best. Keep the person's intent: subject, setting, style (photo, flat illustration, 3D, line
   art…), mood, colours, composition. Add "no text" unless they asked for words in the image.
3. Arabic text inside an image is unreliable in most models. If they need Arabic words on the
   image, generate the picture without text and offer to add the words afterwards in a slide or
   document, or warn that the letters may come out wrong.
4. Generate:
   - With `image_generate` when it is offered: pass `prompt` and `aspect_ratio`. It returns a
     file path (or a URL); copy it into the working folder (for example with `terminal`:
     `cp PATH images/name.png`, or for a URL
     `python3 -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" URL images/name.png`).
   - Otherwise run the script (`generate`). On `image_model_not_chosen`, say an image model must
     be chosen in Models → Images; on `api_error`, show the provider's message in a sentence.
5. Reply in the person's language with the file path(s) as Markdown images
   (`![description](images/….png)`), one line on what was made, and one offer to adjust.

## Pitfalls

- Never write a key into a command line, a file or the reply, and never ask the person for one:
  the key belongs to the provider in Core Hub.
- Do not claim an image was made when a call failed; report the error code and message.
- Real people, logos and trademarks: follow the provider's policy; decline impersonation.
- Large batches cost money: ask before generating more than four images.

## Verification

- The JSON says `"ok": true` and every path in `files` exists (`search_files target='files'`).
- Optionally look at the result with `vision_analyze` before describing it to the person.
