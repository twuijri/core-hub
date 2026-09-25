# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Core Hub's image backend for Hermes's `image_generate` tool (Core Hub decision §72).

Core Hub installs this folder as `plugins/image_gen/corehub-images/` in a profile's Hermes home,
lists it in `plugins.enabled` and names it in `image_gen.provider` while the profile has an image
model chosen in Core Hub → Models → Images. It is not a skill: the skill library only carries it.

It draws with the same `image_api.py` the `image-generate` and `image-edit` skills run (copied
next to this file), reading the four `COREHUB_IMAGE_*` variables Core Hub writes through Hermes's
own secret scope — the profile's `.env` first, then the process environment. It never prints or
stores a key.
"""

from __future__ import annotations

import base64
import importlib.util
import logging
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.image_gen_provider import (
    DEFAULT_ASPECT_RATIO,
    ImageGenProvider,
    error_response,
    normalize_reference_images,
    resolve_aspect_ratio,
    save_b64_image,
    success_response,
)

logger = logging.getLogger(__name__)

NAME = "corehub-images"
# The semantic ratios Hermes's tool speaks, as the Images API sizes and as ratios.
SIZES = {"landscape": "1536x1024", "square": "1024x1024", "portrait": "1024x1536"}
RATIOS = {"landscape": "16:9", "square": "1:1", "portrait": "9:16"}
# Only these Images API families take the OpenAI size names above.
SIZED = re.compile(r"(^|[/:._-])(gpt-image|chatgpt-image|dall-e)", re.I)


def _image_api():
    """The shared script, loaded from this folder once."""
    name = "corehub_image_api"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("image_api.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _secret(name: str) -> Optional[str]:
    # Hermes's own reader: a profile's `.env` before the process environment. A read it refuses
    # (no profile scope while one process serves several) is a missing value — never another
    # profile's.
    try:
        from agent.secret_scope import get_secret

        return get_secret(name)
    except Exception:  # noqa: BLE001
        return None


class CoreHubImageProvider(ImageGenProvider):
    """Draws with the profile's image model from Core Hub."""

    @property
    def name(self) -> str:
        return NAME

    @property
    def display_name(self) -> str:
        return "Core Hub"

    def is_available(self) -> bool:
        return bool(_secret("COREHUB_IMAGE_MODEL"))

    def list_models(self) -> List[Dict[str, Any]]:
        model = _secret("COREHUB_IMAGE_MODEL")
        return [{"id": model, "display": model, "strengths": "Chosen in Core Hub → Models → Images"}] if model else []

    def default_model(self) -> Optional[str]:
        return _secret("COREHUB_IMAGE_MODEL")

    def capabilities(self) -> Dict[str, Any]:
        # Every protocol the script speaks takes a source image to edit; Imagen alone refuses,
        # and says so in its answer.
        return {"modalities": ["text", "image"], "max_reference_images": 3}

    def generate(
        self,
        prompt: str,
        aspect_ratio: str = DEFAULT_ASPECT_RATIO,
        *,
        image_url: Optional[str] = None,
        reference_image_urls: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        prompt = (prompt or "").strip()
        aspect = resolve_aspect_ratio(aspect_ratio)
        model = _secret("COREHUB_IMAGE_MODEL") or ""
        if not prompt:
            return error_response(
                error="Prompt is required", error_type="invalid_input", provider=NAME, aspect_ratio=aspect,
            )
        sources = ([image_url] if image_url else []) + (normalize_reference_images(reference_image_urls) or [])
        api = _image_api()
        try:
            drawn = api.draw(
                prompt,
                sources=sources[:4],
                aspect=RATIOS[aspect],
                size=SIZES[aspect] if SIZED.search(model) else None,
                get=_secret,
            )
        except api.Refusal as refusal:
            return error_response(
                error=str(refusal), error_type=refusal.code, provider=NAME, model=model,
                prompt=prompt, aspect_ratio=aspect,
            )
        except Exception as exc:  # noqa: BLE001 - the tool reports it; the agent explains it
            logger.debug("Core Hub image backend failed", exc_info=True)
            return error_response(
                error=f"Core Hub image backend error: {exc}", error_type="provider_exception",
                provider=NAME, model=model, prompt=prompt, aspect_ratio=aspect,
            )
        path = save_b64_image(base64.b64encode(drawn["image"]).decode("ascii"), prefix="corehub", extension="png")
        extra = {"note": drawn["note"]} if drawn.get("note") else None
        return success_response(
            image=str(path), model=drawn["model"], prompt=prompt, aspect_ratio=aspect, provider=NAME,
            modality="image" if sources else "text", extra=extra,
        )


def register(ctx) -> None:
    """Hermes's plugin entry point."""
    ctx.register_image_gen_provider(CoreHubImageProvider())
