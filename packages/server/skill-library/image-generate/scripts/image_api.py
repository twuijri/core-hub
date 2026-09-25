#!/usr/bin/env python3
# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Generate, edit or vary images through an image API, reading the provider from the environment.

Used by the Core Hub skills `image-generate` and `image-edit` when Hermes's own
`image_generate` tool is not available or not configured. Standard library only.

Providers:
  openai      OpenAI Images (/images/generations, /images/edits, /images/variations).
  compatible  Any server speaking the OpenAI Images API at COREHUB_IMAGE_BASE_URL.
  gemini      Google's Generative Language API: `imagen-*` models through :predict,
              Gemini image models (`gemini-*-image*`) through :generateContent.

Environment (names only are ever printed, never values):
  COREHUB_IMAGE_PROVIDER   openai | compatible | gemini (optional; guessed otherwise)
  COREHUB_IMAGE_BASE_URL   base URL of the API (optional for openai and gemini)
  COREHUB_IMAGE_API_KEY    the key (else OPENAI_API_KEY, or GEMINI_API_KEY / GOOGLE_API_KEY)
  COREHUB_IMAGE_MODEL      model id (optional)

Every command prints one JSON object on stdout. Exit 0 on success, 2 on a refusal or API error.
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DEFAULTS = {
    "openai": {"base": "https://api.openai.com/v1", "model": "gpt-image-1"},
    "compatible": {"base": None, "model": "gpt-image-1"},
    "gemini": {
        "base": "https://generativelanguage.googleapis.com/v1beta",
        "model": "imagen-4.0-generate-001",
    },
}
TIMEOUT = float(os.environ.get("COREHUB_IMAGE_TIMEOUT", "180"))


class Refusal(Exception):
    def __init__(self, code: str, message: str, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


def env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def resolve(args) -> dict:
    """Which provider, where, which model and which key — from flags, then the environment."""
    provider = (args.provider or env("COREHUB_IMAGE_PROVIDER") or "").lower() or None
    if provider is None:
        if env("COREHUB_IMAGE_BASE_URL"):
            provider = "compatible"
        elif (env("GEMINI_API_KEY") or env("GOOGLE_API_KEY")) and not (
            env("OPENAI_API_KEY") or env("COREHUB_IMAGE_API_KEY")
        ):
            provider = "gemini"
        else:
            provider = "openai"
    if provider not in DEFAULTS:
        raise Refusal("provider_unknown", f"unknown provider {provider!r}; use openai, compatible or gemini")
    if provider == "gemini":
        key_names = ["COREHUB_IMAGE_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]
    else:
        key_names = ["COREHUB_IMAGE_API_KEY", "OPENAI_API_KEY"]
    key_name = next((name for name in key_names if env(name)), None)
    base = args.base_url or env("COREHUB_IMAGE_BASE_URL")
    if not base and provider == "openai":
        base = env("OPENAI_BASE_URL")
    base = base or DEFAULTS[provider]["base"]
    if not base:
        raise Refusal("base_url_missing", "set COREHUB_IMAGE_BASE_URL for an OpenAI-compatible image API")
    model = args.model or env("COREHUB_IMAGE_MODEL") or DEFAULTS[provider]["model"]
    return {
        "provider": provider,
        "base": base.rstrip("/"),
        "model": model,
        "key_name": key_name,
        "key": env(key_name) if key_name else None,
        "key_names": key_names,
    }


def need_key(cfg: dict) -> str:
    if cfg["key"]:
        return cfg["key"]
    if cfg["provider"] == "compatible":
        return ""  # a local server may need no key
    raise Refusal(
        "api_key_missing",
        "no API key in the environment; set one of " + ", ".join(cfg["key_names"]),
        looked_for=cfg["key_names"],
    )


def http(method: str, url: str, headers: dict, body: bytes | None) -> dict:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:2000]
        raise Refusal("api_error", f"the image API answered HTTP {error.code}", status=error.code, detail=detail)
    except urllib.error.URLError as error:
        raise Refusal("api_unreachable", f"could not reach the image API: {error.reason}")
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise Refusal("api_bad_response", "the image API did not answer JSON", detail=raw[:500].decode("utf-8", "replace"))


def json_post(url: str, key: str, payload: dict, gemini: bool = False) -> dict:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["x-goog-api-key" if gemini else "Authorization"] = key if gemini else f"Bearer {key}"
    return http("POST", url, headers, json.dumps(payload).encode("utf-8"))


def multipart_post(url: str, key: str, fields: dict, files: list[tuple[str, Path]]) -> dict:
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []
    for name, value in fields.items():
        if value is None:
            continue
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )
    for name, path in files:
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        parts.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'
                f"Content-Type: {mime}\r\n\r\n"
            ).encode("utf-8")
            + path.read_bytes()
            + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return http("POST", url, headers, b"".join(parts))


def slug(text: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", text.lower())[:6]
    return "-".join(words) or "image"


def save(images: list[bytes], out_dir: Path, prompt: str, extension: str) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    written = []
    for index, data in enumerate(images, start=1):
        path = out_dir / f"{slug(prompt)}-{stamp}-{index}.{extension}"
        path.write_bytes(data)
        written.append(str(path))
    return written


def download(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            return response.read()
    except urllib.error.URLError as error:
        raise Refusal("download_failed", f"could not download the generated image: {error}")


def openai_images(answer: dict) -> tuple[list[bytes], str | None]:
    items = answer.get("data") or []
    if not items:
        raise Refusal("no_image", "the API answered without an image", detail=json.dumps(answer)[:500])
    images = []
    for item in items:
        if item.get("b64_json"):
            images.append(base64.b64decode(item["b64_json"]))
        elif item.get("url"):
            images.append(download(item["url"]))
    revised = next((item.get("revised_prompt") for item in items if item.get("revised_prompt")), None)
    return images, revised


def gemini_images(answer: dict) -> tuple[list[bytes], str | None]:
    images: list[bytes] = []
    text = None
    for prediction in answer.get("predictions") or []:  # imagen :predict
        data = prediction.get("bytesBase64Encoded")
        if data:
            images.append(base64.b64decode(data))
    for candidate in answer.get("candidates") or []:  # gemini :generateContent
        for part in (candidate.get("content") or {}).get("parts") or []:
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                images.append(base64.b64decode(inline["data"]))
            elif part.get("text"):
                text = (text + "\n" if text else "") + part["text"]
    if not images:
        raise Refusal("no_image", "the API answered without an image", detail=(text or json.dumps(answer))[:500])
    return images, text


def inline_part(path: Path) -> dict:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(path.read_bytes()).decode("ascii")}}


def gemini_call(cfg: dict, prompt: str, n: int, aspect: str | None, sources: list[Path]) -> tuple[list[bytes], str | None]:
    key = need_key(cfg)
    model = cfg["model"]
    if model.startswith("imagen"):
        if sources:
            raise Refusal(
                "edit_unsupported",
                "Imagen models do not edit through this API; use a Gemini image model (COREHUB_IMAGE_MODEL)",
            )
        parameters: dict = {"sampleCount": max(1, min(n, 4))}
        if aspect:
            parameters["aspectRatio"] = aspect
        answer = json_post(
            f"{cfg['base']}/models/{model}:predict",
            key,
            {"instances": [{"prompt": prompt}], "parameters": parameters},
            gemini=True,
        )
    else:
        parts = [inline_part(path) for path in sources] + [{"text": prompt}]
        answer = json_post(
            f"{cfg['base']}/models/{model}:generateContent",
            key,
            {"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}},
            gemini=True,
        )
    return gemini_images(answer)


def check_images(paths: list[str]) -> list[Path]:
    found = []
    for name in paths:
        path = Path(name).expanduser()
        if not path.is_file():
            raise Refusal("image_not_found", f"no such image: {name}")
        found.append(path)
    return found


def run(args) -> dict:
    cfg = resolve(args)
    if args.command == "providers":
        return {
            "provider": cfg["provider"],
            "base_url": cfg["base"],
            "model": cfg["model"],
            "key_from": cfg["key_name"],
            "keys_looked_for": cfg["key_names"],
        }

    prompt = (args.prompt or "").strip()
    if args.command in ("generate", "edit") and not prompt:
        raise Refusal("prompt_missing", "a prompt is required")
    sources = check_images(getattr(args, "image", None) or [])
    mask = check_images([args.mask])[0] if getattr(args, "mask", None) else None
    n = max(1, min(args.n, 4))

    if cfg["provider"] == "gemini":
        if args.command == "vary":
            prompt = prompt or "Create a variation of this image: same subject, style and palette, new composition."
        images, note = gemini_call(cfg, prompt, n, args.aspect, sources)
    else:
        key = need_key(cfg)
        if args.command == "generate":
            payload = {"model": cfg["model"], "prompt": prompt, "n": n}
            if args.size:
                payload["size"] = args.size
            if args.quality:
                payload["quality"] = args.quality
            answer = json_post(f"{cfg['base']}/images/generations", key, payload)
        elif args.command == "edit":
            files = [("image[]" if len(sources) > 1 else "image", path) for path in sources]
            if mask:
                files.append(("mask", mask))
            answer = multipart_post(
                f"{cfg['base']}/images/edits",
                key,
                {"model": cfg["model"], "prompt": prompt, "n": n, "size": args.size, "quality": args.quality},
                files,
            )
        else:  # vary
            if prompt:
                answer = multipart_post(
                    f"{cfg['base']}/images/edits",
                    key,
                    {"model": cfg["model"], "prompt": prompt, "n": n, "size": args.size},
                    [("image", sources[0])],
                )
            else:
                answer = multipart_post(
                    f"{cfg['base']}/images/variations",
                    key,
                    {"model": args.model or env("COREHUB_IMAGE_MODEL") or "dall-e-2", "n": n, "size": args.size},
                    [("image", sources[0])],
                )
        images, note = openai_images(answer)

    files = save(images, Path(args.out), prompt or sources[0].stem, args.format)
    return {
        "ok": True,
        "command": args.command,
        "provider": cfg["provider"],
        "model": cfg["model"],
        "files": files,
        "note": note,
    }


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = main.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--provider", choices=sorted(DEFAULTS))
        p.add_argument("--base-url")
        p.add_argument("--model")
        p.add_argument("--n", type=int, default=1, help="how many images, 1-4")
        p.add_argument("--size", help="e.g. 1024x1024, 1536x1024, 1024x1536 (OpenAI-style APIs)")
        p.add_argument("--aspect", help="e.g. 1:1, 16:9, 9:16 (Gemini/Imagen)")
        p.add_argument("--quality", help="low | medium | high | auto (OpenAI-style APIs)")
        p.add_argument("--format", default="png", help="file extension to save as (default png)")
        p.add_argument("--out", default="images", help="folder to save into (default ./images)")

    generate = sub.add_parser("generate", help="a new image from a prompt")
    generate.add_argument("--prompt", required=True)
    common(generate)

    edit = sub.add_parser("edit", help="change an image by a prompt (optionally within a mask)")
    edit.add_argument("--image", action="append", required=True, help="source image; repeat for references")
    edit.add_argument("--mask", help="PNG whose transparent pixels mark the area to change")
    edit.add_argument("--prompt", required=True)
    common(edit)

    vary = sub.add_parser("vary", help="variations of an image")
    vary.add_argument("--image", action="append", required=True)
    vary.add_argument("--prompt", help="what to keep or change (optional)")
    common(vary)

    providers = sub.add_parser("providers", help="which provider, model and key name would be used")
    providers.add_argument("--provider", choices=sorted(DEFAULTS))
    providers.add_argument("--base-url")
    providers.add_argument("--model")
    return main


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = run(args)
    except Refusal as refusal:
        print(json.dumps({"ok": False, "error": refusal.code, "message": str(refusal), **refusal.extra}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
