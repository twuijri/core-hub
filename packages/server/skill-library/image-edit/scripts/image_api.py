#!/usr/bin/env python3
# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Generate, edit, vary or cut out images with the image model chosen in Core Hub.

The model is the profile's choice in Core Hub → Models → Images: one of the chat providers'
image models. Core Hub writes it into the profile's environment; nobody types a key here.
Used by the Core Hub skills `image-generate` and `image-edit`, and by the Hermes image backend
Core Hub installs (`image_gen.provider: corehub-images`), so Hermes's `image_generate` tool
and these skills always draw with the same model. Standard library only.

Protocols (COREHUB_IMAGE_PROVIDER):
  compatible  The OpenAI Images API (/images/generations, /images/edits, /images/variations)
              at COREHUB_IMAGE_BASE_URL — gpt-image, DALL·E, Imagen, FLUX … on any host.
  chat        A chat model that answers with images (/chat/completions with
              modalities ["image", "text"]) — e.g. gemini-*-image behind cli-proxy-api or
              OpenRouter.
  gemini      Google's own API: `imagen-*` through :predict, Gemini image models through
              :generateContent.
  openai      `compatible` at api.openai.com.
  codex       A ChatGPT subscription signed in through Hermes: the Codex backend's
              /responses with its `image_generation` tool (gpt-image-2.5, gpt-image-2 …),
              carried by a chat model the subscription serves. No key is written: the
              token is Hermes's, asked for at the moment of drawing (and refreshed by
              Hermes), never printed or stored.

Environment, written by Core Hub (names only are ever printed, never values):
  COREHUB_IMAGE_PROVIDER   compatible | chat | gemini | openai | codex
  COREHUB_IMAGE_BASE_URL   the provider's address
  COREHUB_IMAGE_MODEL      the model id
  COREHUB_IMAGE_API_KEY    the provider's key (absent for an endpoint that takes none)

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
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Mapping

PROVIDERS = ("compatible", "chat", "gemini", "openai", "codex")
DEFAULT_BASE = {
    "openai": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "codex": "https://chatgpt.com/backend-api/codex",
}
ENV = {
    "provider": "COREHUB_IMAGE_PROVIDER",
    "base": "COREHUB_IMAGE_BASE_URL",
    "model": "COREHUB_IMAGE_MODEL",
    "key": "COREHUB_IMAGE_API_KEY",
}
TIMEOUT = float(os.environ.get("COREHUB_IMAGE_TIMEOUT", "180"))
NOT_CHOSEN = (
    "No image model is chosen for this profile. Choose one in Core Hub: Models → Images. "
    "لم يُختر نموذج صور لهذا البروفايل؛ اختره في Core Hub: النماذج ← الصور."
)
# The Images API families that take `background: transparent` (OpenAI's gpt-image).
TRANSPARENT_CAPABLE = re.compile(r"(^|[/:._-])(gpt-image|chatgpt-image)", re.I)
# The chat model that carries the `image_generation` tool on the Codex backend.
CODEX_HOST = os.environ.get("COREHUB_IMAGE_CODEX_HOST", "gpt-5.5")
CODEX_INSTRUCTIONS = (
    "Fulfil the request by calling the image_generation tool exactly once. "
    "Do not answer with text instead of an image."
)
# The backend's own sizes for gpt-image; a ratio is mapped onto the nearest.
CODEX_SIZES = {"1:1": "1024x1024", "16:9": "1536x1024", "3:2": "1536x1024", "9:16": "1024x1536", "2:3": "1024x1536"}
NOT_IN_PLAN = (
    "The ChatGPT plan signed in to Core Hub did not allow image generation (it needs a paid "
    "plan with Codex). خطة ChatGPT المسجّل دخولها في Core Hub لا تسمح بتوليد الصور."
)


class Refusal(Exception):
    def __init__(self, code: str, message: str, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


def resolve(args, environ: Mapping[str, str] | None = None) -> dict:
    """The protocol, address, model and key: flags first, then what Core Hub wrote."""
    source = os.environ if environ is None else environ

    def env(name: str) -> str | None:
        value = (source.get(name) or "").strip()
        return value or None

    model = getattr(args, "model", None) or env(ENV["model"])
    provider = (getattr(args, "provider", None) or env(ENV["provider"]) or "").lower() or None
    if not model:
        raise Refusal("image_model_not_chosen", NOT_CHOSEN, choose_in="Models → Images")
    if provider is None:
        provider = "compatible"
    if provider not in PROVIDERS:
        raise Refusal("provider_unknown", f"unknown image protocol {provider!r}; use one of {', '.join(PROVIDERS)}")
    base = getattr(args, "base_url", None) or env(ENV["base"]) or DEFAULT_BASE.get(provider)
    if not base:
        raise Refusal("image_model_not_chosen", NOT_CHOSEN, choose_in="Models → Images")
    return {
        "provider": "compatible" if provider == "openai" else provider,
        "base": base.rstrip("/"),
        "model": model,
        "key": env(ENV["key"]),
    }


def need_key(cfg: dict) -> str:
    """The key, or "" for a server that takes none; Google's own API always takes one."""
    if cfg["key"]:
        return cfg["key"]
    if cfg["provider"] == "gemini":
        raise Refusal(
            "api_key_missing",
            "the provider chosen in Models → Images has no key; add it to that provider in Core Hub",
            looked_for=[ENV["key"]],
        )
    return ""


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
    except (urllib.error.URLError, ValueError) as error:
        raise Refusal("download_failed", f"could not download the generated image: {error}")


def image_from_ref(ref: str) -> bytes:
    """Bytes of a `data:` URI or an http(s) URL the API answered with."""
    if ref.startswith("data:"):
        return base64.b64decode(ref.split(",", 1)[1])
    return download(ref)


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


DATA_URI = re.compile(r"data:image/[\w.+-]+;base64,[A-Za-z0-9+/=]+")


def chat_images(answer: dict) -> tuple[list[bytes], str | None]:
    """Images from a chat answer: `message.images` (OpenRouter's shape, which proxies copy),
    image parts of the content, or a `data:` URI in the text."""
    images: list[bytes] = []
    text = None
    for choice in answer.get("choices") or []:
        message = choice.get("message") or {}
        for image in message.get("images") or []:
            if not isinstance(image, dict):
                continue
            url = (image.get("image_url") or {}).get("url") or image.get("url")
            if url:
                images.append(image_from_ref(url))
        content = message.get("content")
        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url")
                    if url:
                        images.append(image_from_ref(url))
                elif part.get("type") == "text" and part.get("text"):
                    text = (text + "\n" if text else "") + part["text"]
        elif isinstance(content, str) and content:
            if not images:
                images.extend(image_from_ref(uri) for uri in DATA_URI.findall(content))
            text = DATA_URI.sub("", content).strip() or None
    if not images:
        raise Refusal("no_image", "the model answered without an image", detail=(text or json.dumps(answer))[:500])
    return images, text


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


def data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


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
                "Imagen models do not edit through this API; choose a Gemini image model in Models → Images",
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


def chat_call(cfg: dict, prompt: str, n: int, aspect: str | None, sources: list[Path]) -> tuple[list[bytes], str | None]:
    key = need_key(cfg)
    content: object = prompt
    if sources:
        content = [{"type": "text", "text": prompt}] + [
            {"type": "image_url", "image_url": {"url": data_uri(path)}} for path in sources
        ]
    payload: dict = {
        "model": cfg["model"],
        "messages": [{"role": "user", "content": content}],
        "modalities": ["image", "text"],
    }
    if aspect:
        payload["image_config"] = {"aspect_ratio": aspect}
    images: list[bytes] = []
    note = None
    # One picture an answer: asking for several is several calls.
    for _ in range(max(1, min(n, 4))):
        found, text = chat_images(json_post(f"{cfg['base']}/chat/completions", key, payload))
        images.extend(found)
        note = note or text
    return images, note


def codex_credentials(force: bool = False) -> tuple[str, str | None, dict]:
    """The subscription's access token, from Hermes's own store in this Hermes home (Hermes
    refreshes it when it is about to expire, or on `force`), the base URL Hermes would use, and
    the identity headers Hermes sends the Codex backend. Never printed or stored."""
    try:
        from hermes_cli.auth import resolve_codex_runtime_credentials
    except Exception:  # noqa: BLE001 - not inside Hermes's Python
        raise Refusal(
            "codex_unavailable",
            "images through the ChatGPT subscription need Hermes's Python (run inside Core Hub's Hermes)",
        )
    try:
        creds = resolve_codex_runtime_credentials(force_refresh=force, refresh_if_expiring=True)
    except Exception as error:  # noqa: BLE001 - Hermes's own words, never the token
        raise Refusal(
            "codex_not_signed_in",
            "the ChatGPT subscription is not signed in (Core Hub → Models → Providers → Sign in): "
            + str(error)[:300],
        )
    token = str(creds.get("api_key") or "").strip()
    if not token:
        raise Refusal("codex_not_signed_in", "the ChatGPT subscription has no usable sign-in")
    headers: dict = {}
    base = str(creds.get("base_url") or "").strip() or None
    try:
        from agent.codex_headers import codex_cloudflare_headers

        headers.update(codex_cloudflare_headers(token, base_url=base or DEFAULT_BASE["codex"]))
    except Exception:  # noqa: BLE001 - older Hermes: the account id is enough
        pass
    account = codex_account(token)
    if account and not any(name.lower() == "chatgpt-account-id" for name in headers):
        headers["ChatGPT-Account-ID"] = account
    return token, base, headers


def codex_account(token: str) -> str | None:
    """The ChatGPT account id in the token's claims, which the backend wants as a header."""
    try:
        part = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        value = (claims.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")
        return value if isinstance(value, str) and value else None
    except Exception:  # noqa: BLE001
        return None


def sse_events(raw: bytes):
    """The JSON payloads of a server-sent event stream (`data:` lines, blank-line separated)."""
    lines: list[str] = []
    for line in raw.decode("utf-8", "replace").splitlines() + [""]:
        if line.startswith("data:"):
            lines.append(line[5:].lstrip())
        elif line == "" and lines:
            text = "\n".join(lines).strip()
            lines = []
            if text and text != "[DONE]":
                try:
                    yield json.loads(text)
                except ValueError:
                    continue


def codex_results(value, found: list[str]) -> None:
    """Every finished `image_generation_call` result (base64) in a payload, in order. A
    progressive partial frame is never taken for a picture."""
    if isinstance(value, dict):
        if value.get("type") == "image_generation_call" and isinstance(value.get("result"), str) and value["result"]:
            if value["result"] not in found:
                found.append(value["result"])
        for child in value.values():
            codex_results(child, found)
    elif isinstance(value, list):
        for child in value:
            codex_results(child, found)


def codex_refusal(status: int, detail: str) -> Refusal:
    """The backend's answer as a refusal; a plan without images gets its own code."""
    message = detail
    try:
        body = json.loads(detail)
        error = body.get("error") if isinstance(body, dict) else None
        if isinstance(error, dict) and error.get("message"):
            message = str(error["message"])
        elif isinstance(body, dict) and body.get("detail"):
            message = str(body["detail"])
    except ValueError:
        pass
    lowered = message.lower()
    if status in (402, 403) or any(word in lowered for word in ("plan", "entitle", "not available", "upgrade")):
        if "tool choice" not in lowered:
            return Refusal("image_not_in_plan", NOT_IN_PLAN, status=status, detail=message[:500])
    if status == 429:
        return Refusal("usage_limit", "the ChatGPT plan's Codex usage limit was reached; try later", status=status, detail=message[:500])
    return Refusal("api_error", f"the Codex backend answered HTTP {status}", status=status, detail=message[:500])


def codex_draw(cfg: dict, prompt: str, sources: list[Path], size: str | None, background: str | None) -> list[bytes]:
    """One picture through the subscription: a streamed /responses call with the
    image_generation tool; 401 once more with a token Hermes refreshes."""
    content: list = [{"type": "input_text", "text": prompt}]
    content += [{"type": "input_image", "image_url": data_uri(path)} for path in sources]
    tool: dict = {"type": "image_generation", "model": cfg["model"], "output_format": "png"}
    if size:
        tool["size"] = size
    if background:
        tool["background"] = background
    payload = {
        "model": CODEX_HOST,
        "instructions": CODEX_INSTRUCTIONS,
        "input": [{"type": "message", "role": "user", "content": content}],
        # No `tool_choice`: the backend reads it as a function name and refuses a hosted tool;
        # the instructions are what ask for the call.
        "tools": [tool],
        "store": False,
        "stream": True,
    }
    body = json.dumps(payload).encode("utf-8")
    for attempt in (0, 1):
        token, base, identity = codex_credentials(force=attempt == 1)
        url = (cfg.get("base") or base or DEFAULT_BASE["codex"]).rstrip("/") + "/responses"
        headers = {
            **identity,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        request = urllib.request.Request(url, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:2000]
            if error.code == 401 and attempt == 0:
                continue
            raise codex_refusal(error.code, detail)
        except urllib.error.URLError as error:
            raise Refusal("api_unreachable", f"could not reach the Codex backend: {error.reason}")
        found: list[str] = []
        failed = None
        for event in sse_events(raw):
            codex_results(event, found)
            if event.get("type") in ("response.failed", "error"):
                failed = event
        if found:
            return [base64.b64decode(found[-1])]
        if failed is not None:
            error = (failed.get("response") or {}).get("error") or failed.get("error") or failed
            raise codex_refusal(400, json.dumps({"error": error}) if isinstance(error, dict) else str(error))
        raise Refusal("no_image", "the Codex backend answered without an image")
    raise Refusal("api_error", "the Codex backend refused the refreshed sign-in (HTTP 401)", status=401)


def codex_call(cfg: dict, command: str, prompt: str, sources: list[Path], n: int, size: str | None, aspect: str | None, background: str | None) -> tuple[list[bytes], str | None]:
    if command == "vary":
        prompt = prompt or "Create a variation of this image: same subject, style and palette, new composition."
    if not size and aspect:
        size = CODEX_SIZES.get(aspect.replace(" ", ""))
    images: list[bytes] = []
    for _ in range(max(1, min(n, 4))):
        images.extend(codex_draw(cfg, prompt, sources, size, background))
    return images, None


def check_images(paths: list[str]) -> list[Path]:
    found = []
    for name in paths:
        path = Path(name).expanduser()
        if not path.is_file():
            raise Refusal("image_not_found", f"no such image: {name}")
        found.append(path)
    return found


def has_alpha(data: bytes) -> bool:
    """True for a PNG that can be transparent (an alpha channel, or a tRNS chunk)."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 26:
        return False
    if data[25] in (4, 6):
        return True
    return b"tRNS" in data[:4096]


REMOVE_BG_TRANSPARENT = (
    "Remove the background completely. Keep the main subject exactly as it is — its shape, "
    "edges, colours, details and position — and make everything else fully transparent."
)


def remove_bg_prompt(colour: str) -> str:
    return (
        "Cut out the main subject and place it on a perfectly flat, solid "
        f"{colour} background with no shadow, gradient, texture or other objects. Keep the "
        "subject exactly as it is — its shape, edges, colours, details and position."
    )


def call(
    cfg: dict,
    command: str,
    prompt: str,
    sources: list[Path],
    *,
    mask: Path | None = None,
    n: int = 1,
    size: str | None = None,
    aspect: str | None = None,
    quality: str | None = None,
    background: str | None = None,
) -> tuple[list[bytes], str | None]:
    """One request to the chosen model: `generate`, `edit` or `vary`. The library entry the
    Hermes backend uses; `run` below is the command line around it."""
    n = max(1, min(n, 4))
    if cfg["provider"] == "codex":
        return codex_call(cfg, command, prompt, sources, n, size, aspect, background)
    if cfg["provider"] in ("gemini", "chat"):
        if command == "vary":
            prompt = prompt or "Create a variation of this image: same subject, style and palette, new composition."
        speak = gemini_call if cfg["provider"] == "gemini" else chat_call
        return speak(cfg, prompt, n, aspect, sources)
    key = need_key(cfg)
    if command == "generate":
        payload = {"model": cfg["model"], "prompt": prompt, "n": n}
        if size:
            payload["size"] = size
        if quality:
            payload["quality"] = quality
        if background:
            payload["background"] = background
        answer = json_post(f"{cfg['base']}/images/generations", key, payload)
    elif command == "edit":
        files = [("image[]" if len(sources) > 1 else "image", path) for path in sources]
        if mask:
            files.append(("mask", mask))
        fields = {"model": cfg["model"], "prompt": prompt, "n": n, "size": size, "quality": quality}
        if background:
            fields["background"] = background
            fields["output_format"] = "png"
        answer = multipart_post(f"{cfg['base']}/images/edits", key, fields, files)
    elif prompt:  # vary with a direction is an edit
        answer = multipart_post(
            f"{cfg['base']}/images/edits",
            key,
            {"model": cfg["model"], "prompt": prompt, "n": n, "size": size},
            [("image", sources[0])],
        )
    else:
        answer = multipart_post(
            f"{cfg['base']}/images/variations",
            key,
            {"model": cfg["model"], "n": n, "size": size},
            [("image", sources[0])],
        )
    return openai_images(answer)


def remove_background(cfg: dict, source: Path, out: Path, colour: str, size: str | None) -> dict:
    """Cut the subject out with the image model's edit endpoint. A gpt-image model is asked
    for transparency outright; any other model puts the subject on a flat colour, which the
    bundled, model-free `image-convert transparent-bg` then clears."""
    transparent_capable = cfg["provider"] in ("compatible", "codex") and bool(TRANSPARENT_CAPABLE.search(cfg["model"]))
    images, note = call(
        cfg,
        "edit",
        REMOVE_BG_TRANSPARENT if transparent_capable else remove_bg_prompt(colour),
        [source],
        size=size,
        background="transparent" if transparent_capable else None,
    )
    files = save(images[:1], out, f"{source.stem}-cutout", "png")
    transparent = has_alpha(images[0])
    result = {
        "ok": True,
        "command": "remove-bg",
        "provider": cfg["provider"],
        "model": cfg["model"],
        "files": files,
        "transparent": transparent,
        "note": note,
    }
    if not transparent:
        result["background"] = None if transparent_capable else colour
        result["next"] = (
            "python3 <image-convert skill_dir>/scripts/image_tools.py transparent-bg " + files[0]
        )
    return result


def run(args, environ: Mapping[str, str] | None = None) -> dict:
    cfg = resolve(args, environ)
    if args.command == "providers":
        return {
            "ok": True,
            "provider": cfg["provider"],
            "base_url": cfg["base"],
            "model": cfg["model"],
            "key_from": ENV["key"] if cfg["key"] else None,
        }

    prompt = (getattr(args, "prompt", None) or "").strip()
    if args.command in ("generate", "edit") and not prompt:
        raise Refusal("prompt_missing", "a prompt is required")
    sources = check_images(getattr(args, "image", None) or [])
    mask = check_images([args.mask])[0] if getattr(args, "mask", None) else None

    if args.command == "remove-bg":
        return remove_background(cfg, sources[0], Path(args.out), args.bg_color, args.size)

    images, note = call(
        cfg,
        args.command,
        prompt,
        sources,
        mask=mask,
        n=args.n,
        size=args.size,
        aspect=args.aspect,
        quality=args.quality,
    )
    files = save(images, Path(args.out), prompt or sources[0].stem, args.format)
    return {
        "ok": True,
        "command": args.command,
        "provider": cfg["provider"],
        "model": cfg["model"],
        "files": files,
        "note": note,
    }


def materialize(ref: str, folder: str) -> Path:
    """A local file for a source image given as a path, a `data:` URI or an http(s) URL —
    what Hermes's tool hands a backend."""
    if ref.startswith(("http://", "https://", "data:")):
        path = Path(folder) / f"source-{uuid.uuid4().hex[:8]}.png"
        path.write_bytes(image_from_ref(ref))
        return path
    return check_images([ref])[0]


def draw(
    prompt: str,
    *,
    sources: list[str] | None = None,
    aspect: str | None = None,
    size: str | None = None,
    get: Callable[[str], str | None] | None = None,
) -> dict:
    """For the Hermes backend: one image, as bytes. `get` reads a variable through Hermes's
    secret scope (a profile's `.env` before the process environment); absent, the
    environment is read."""
    values = {name: (get(name) if get else os.environ.get(name)) or "" for name in ENV.values()}
    cfg = resolve(argparse.Namespace(provider=None, base_url=None, model=None), values)
    with tempfile.TemporaryDirectory(prefix="corehub-image-") as folder:
        paths = [materialize(ref, folder) for ref in (sources or [])]
        images, note = call(
            cfg, "edit" if paths else "generate", prompt, paths, n=1, size=size, aspect=aspect,
        )
    return {"image": images[0], "model": cfg["model"], "provider": cfg["provider"], "note": note}


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = main.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--provider", choices=PROVIDERS, help="override the protocol Core Hub chose")
        p.add_argument("--base-url")
        p.add_argument("--model", help="override the model chosen in Models → Images")
        p.add_argument("--n", type=int, default=1, help="how many images, 1-4")
        p.add_argument("--size", help="e.g. 1024x1024, 1536x1024, 1024x1536 (Images API)")
        p.add_argument("--aspect", help="e.g. 1:1, 16:9, 9:16 (Gemini and chat image models)")
        p.add_argument("--quality", help="low | medium | high | auto (Images API)")
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

    remove = sub.add_parser("remove-bg", help="cut the subject out of its background with the image model")
    remove.add_argument("--image", action="append", required=True)
    remove.add_argument(
        "--bg-color",
        default="pure green (#00FF00)",
        help="the flat colour a model without transparency puts the subject on (default pure green)",
    )
    common(remove)

    providers = sub.add_parser("providers", help="which protocol, address and model would be used")
    providers.add_argument("--provider", choices=PROVIDERS)
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
