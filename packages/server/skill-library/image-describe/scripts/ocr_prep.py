#!/usr/bin/env python3
# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Prepare an image so a vision model can read it: upright, legible, and in pieces it can see.

Used by the Core Hub skill `image-describe` before `vision_analyze`. Needs Pillow.

  prepare IMG [--out-dir DIR] [--box X,Y,W,H] [--enhance] [--max-side 2048] [--tile-height 1600]

Writes one or more PNG files and prints {"ok": true, "files": [...], "tiles": N, ...}:
- the EXIF orientation is applied (phone photos arrive sideways otherwise);
- --box crops to a region first (a table, a receipt total, one column);
- --enhance converts to greyscale, stretches the contrast and sharpens — for faint scans;
- a small image is enlarged so text is at least readable, a huge one is reduced to --max-side;
- a very tall image (a long screenshot, a receipt) is cut into overlapping tiles, top to bottom.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageFilter, ImageOps
except ImportError:  # pragma: no cover
    print(json.dumps({"ok": False, "error": "pillow_missing", "message": "Pillow (PIL) is not installed"}))
    sys.exit(2)


def fail(code: str, message: str) -> int:
    print(json.dumps({"ok": False, "error": code, "message": message}, ensure_ascii=False))
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("image")
    p.add_argument("--out-dir")
    p.add_argument("--box")
    p.add_argument("--enhance", action="store_true")
    p.add_argument("--max-side", type=int, default=2048)
    p.add_argument("--min-side", type=int, default=1000)
    p.add_argument("--tile-height", type=int, default=1600)
    args = parser.parse_args(argv)

    source = Path(args.image).expanduser()
    if not source.is_file():
        return fail("image_not_found", f"no such image: {args.image}")
    try:
        image = Image.open(source)
        image.load()
    except Exception as error:  # noqa: BLE001
        return fail("image_unreadable", f"{args.image}: {error}")
    original = image.size
    image = ImageOps.exif_transpose(image).convert("RGB")

    if args.box:
        try:
            x, y, w, h = (int(float(v)) for v in args.box.split(","))
        except ValueError:
            return fail("box_invalid", "box must be X,Y,W,H in pixels")
        image = image.crop((max(0, x), max(0, y), min(image.width, x + w), min(image.height, y + h)))

    if args.enhance:
        image = ImageOps.autocontrast(ImageOps.grayscale(image), cutoff=1).filter(ImageFilter.SHARPEN)

    longest = max(image.size)
    if longest < args.min_side:
        factor = args.min_side / longest
        image = image.resize((round(image.width * factor), round(image.height * factor)), Image.Resampling.LANCZOS)
    width_limit = args.max_side
    if image.width > width_limit:
        factor = width_limit / image.width
        image = image.resize((width_limit, max(1, round(image.height * factor))), Image.Resampling.LANCZOS)

    out_dir = Path(args.out_dir).expanduser() if args.out_dir else source.parent / f"{source.stem}-read"
    out_dir.mkdir(parents=True, exist_ok=True)
    tile = max(400, args.tile_height)
    overlap = tile // 10
    files = []
    if image.height <= tile * 1.25:
        path = out_dir / f"{source.stem}-1.png"
        image.save(path, "PNG")
        files.append(str(path))
    else:
        top = 0
        index = 1
        while top < image.height:
            bottom = min(image.height, top + tile)
            path = out_dir / f"{source.stem}-{index}.png"
            image.crop((0, top, image.width, bottom)).save(path, "PNG")
            files.append(str(path))
            if bottom >= image.height:
                break
            top = bottom - overlap
            index += 1
    print(
        json.dumps(
            {
                "ok": True,
                "files": files,
                "tiles": len(files),
                "original": {"width": original[0], "height": original[1]},
                "prepared": {"width": image.width, "height": image.height},
                "enhanced": bool(args.enhance),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
