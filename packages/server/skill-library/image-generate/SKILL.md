---
name: image-generate
description: Generate an image from a text prompt, in any language.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
required_environment_variables:
  - name: COREHUB_IMAGE_API_KEY
    prompt: API key for the image provider (only when the image_generate tool is not set up)
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
    tags: [image, images, generate, picture, illustration, logo, صورة, صور, توليد, رسم, تصميم]
    category: core-hub
    related_skills: [image-edit, image-convert, image-describe]
  core_hub:
    library: core-hub
---

# Image Generate Skill

Turns a description — Arabic or English — into a new image file in the conversation's folder.
It uses Hermes's own `image_generate` tool when the profile has an image provider set up, and
otherwise a helper script that calls OpenAI Images, Google Gemini/Imagen, or any
OpenAI-compatible image API with the key already in the environment. It never asks for, prints
or stores a key.

يولّد صورة جديدة من وصف بالعربية أو الإنجليزية ويحفظها في مجلد المحادثة.

## When to Use

- "Draw / make / generate an image of …", «ارسم لي»، «سوّ صورة»، «ولّد صورة»، «صمّم شعار».
- A cover, an illustration, an icon, a background, a mock-up picture for a slide or a report.
- Not for changing an existing image (use `image-edit`), resizing or converting one
  (`image-convert`), or reading what is in one (`image-describe`).

## Prerequisites

One of:
- Hermes's `image_generate` tool available in this conversation (the profile's image provider is
  configured in Hermes). This is the first choice.
- Or, for the helper script, a key in the environment: `COREHUB_IMAGE_API_KEY` (any provider), or
  `OPENAI_API_KEY` for OpenAI, or `GEMINI_API_KEY` / `GOOGLE_API_KEY` for Gemini. An
  OpenAI-compatible server is named with `COREHUB_IMAGE_BASE_URL`; `COREHUB_IMAGE_MODEL` and
  `COREHUB_IMAGE_PROVIDER` are optional. Hermes hides its own provider keys from the `terminal`
  tool, so `COREHUB_IMAGE_API_KEY` in the profile's `.env` is the reliable way to give the script
  a key.

If neither is available, say so plainly and name what is missing; do not invent a result.

## How to Run

The script lives in this skill's folder (`skill_dir` from `skill_view`):

```
python3 <skill_dir>/scripts/image_api.py providers
python3 <skill_dir>/scripts/image_api.py generate --prompt "..." --size 1024x1024 --out images
python3 <skill_dir>/scripts/image_api.py generate --prompt "..." --provider gemini --aspect 16:9
```

It prints one JSON object: `{"ok": true, "files": [...], "provider": ..., "model": ...}` or
`{"ok": false, "error": "<code>", "message": ...}`.

## Quick Reference

| Want | `image_generate` | script |
|---|---|---|
| square | `aspect_ratio: "square"` or `1:1` | `--size 1024x1024` / `--aspect 1:1` |
| landscape (slides, covers) | `landscape` / `16:9` | `--size 1536x1024` / `--aspect 16:9` |
| portrait (phone, story) | `portrait` / `9:16` | `--size 1024x1536` / `--aspect 9:16` |
| several options | call it more than once | `--n 2` … `--n 4` |

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
   - With `image_generate`: pass `prompt` and `aspect_ratio`. It returns a URL or a file path.
     If it is a URL, save it into the working folder (for example with `terminal`:
     `python3 -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" URL images/name.png`).
   - Otherwise run the script (`generate`). On `api_key_missing`, tell the person which variable
     to add to the profile's `.env`; on `api_error`, show the provider's message in a sentence.
5. Reply in the person's language with the file path(s) as Markdown images
   (`![description](images/….png)`), one line on what was made, and one offer to adjust.

## Pitfalls

- Never write a key into a command line, a file or the reply. The script reads it from the
  environment only.
- Do not claim an image was made when a call failed; report the error code and message.
- Real people, logos and trademarks: follow the provider's policy; decline impersonation.
- Large batches cost money: ask before generating more than four images.

## Verification

- The JSON says `"ok": true` and every path in `files` exists (`search_files target='files'`).
- Optionally look at the result with `vision_analyze` before describing it to the person.
