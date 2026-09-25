#!/usr/bin/env python3
# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Resize, crop, convert, compress, rotate and tidy images with Pillow.

Used by the Core Hub skill `image-convert`. Needs Pillow (`PIL`), which Hermes's venv carries.
Every command prints one JSON object; the source file is never overwritten unless --out names it.

  info IMG...                                  size, mode, format, bytes, EXIF orientation
  resize IMG (--width W | --height H | --max PX | --scale F) [--out F]
  crop IMG (--box X,Y,W,H | --aspect 16:9 [--gravity center|top|bottom|left|right]) [--out F]
  pad IMG --aspect 1:1 [--color #ffffff] [--out F]
  convert IMG --to png|jpeg|webp|gif|bmp|tiff|ico [--quality Q] [--out F]
  compress IMG --max-kb N [--to jpeg|webp] [--out F]
  rotate IMG (--degrees D | --auto) [--out F]
  flip IMG --axis horizontal|vertical [--out F]
  strip IMG [--out F]                          drop EXIF/GPS and other metadata
  sheet IMG... [--cols 4] [--cell 320] --out F contact sheet of several images
  transparent-bg IMG [--tolerance 24] [--out F]  plain, even background → transparent PNG
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - reported to the agent as JSON
    print(json.dumps({"ok": False, "error": "pillow_missing", "message": "Pillow (PIL) is not installed"}))
    sys.exit(2)

FORMATS = {
    "png": "PNG",
    "jpg": "JPEG",
    "jpeg": "JPEG",
    "webp": "WEBP",
    "gif": "GIF",
    "bmp": "BMP",
    "tif": "TIFF",
    "tiff": "TIFF",
    "ico": "ICO",
}


class Refusal(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def open_image(name: str) -> Image.Image:
    path = Path(name).expanduser()
    if not path.is_file():
        raise Refusal("image_not_found", f"no such image: {name}")
    try:
        image = Image.open(path)
        image.load()
    except Exception as error:  # noqa: BLE001 - any decoder error is the same answer
        raise Refusal("image_unreadable", f"{name}: {error}")
    return image


def target(source: str, out: str | None, suffix: str, extension: str | None = None) -> Path:
    if out:
        return Path(out).expanduser()
    path = Path(source)
    return path.with_name(f"{path.stem}-{suffix}{'.' + extension if extension else path.suffix}")


def format_for(path: Path, fallback: str | None) -> str:
    fmt = FORMATS.get(path.suffix.lower().lstrip("."))
    if fmt:
        return fmt
    if fallback:
        return fallback
    raise Refusal("format_unknown", f"cannot tell the format from {path.name}; give --out with an extension")


def fit_mode(image: Image.Image, fmt: str) -> Image.Image:
    """JPEG and BMP have no alpha: flatten onto white rather than onto black."""
    if fmt in ("JPEG", "BMP") and image.mode in ("RGBA", "LA", "P"):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[-1])
        return background
    if fmt == "JPEG" and image.mode not in ("RGB", "L", "CMYK"):
        return image.convert("RGB")
    return image


def write(image: Image.Image, path: Path, fmt: str | None = None, quality: int | None = None, keep_meta: bool = True, source: Image.Image | None = None) -> dict:
    fmt = fmt or format_for(path, (source.format if source else None))
    image = fit_mode(image, fmt)
    options: dict = {}
    if fmt in ("JPEG", "WEBP"):
        options["quality"] = quality or 90
        if fmt == "JPEG":
            options["optimize"] = True
    if fmt == "PNG":
        options["optimize"] = True
    if keep_meta and source is not None and fmt in ("JPEG", "WEBP") and source.info.get("exif"):
        options["exif"] = source.info["exif"]
    if fmt == "ICO":
        options["sizes"] = [(s, s) for s in (16, 32, 48, 64, 128, 256) if s <= max(image.size)] or [(16, 16)]
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, fmt, **options)
    return {"file": str(path), "format": fmt, "width": image.width, "height": image.height, "bytes": path.stat().st_size}


def ratio(text: str) -> float:
    try:
        left, right = text.replace("x", ":").split(":")
        value = float(left) / float(right)
    except (ValueError, ZeroDivisionError):
        raise Refusal("aspect_invalid", f"aspect must look like 16:9, got {text!r}")
    if value <= 0:
        raise Refusal("aspect_invalid", f"aspect must be positive, got {text!r}")
    return value


def cmd_info(args) -> dict:
    items = []
    for name in args.images:
        image = open_image(name)
        exif = image.getexif()
        items.append(
            {
                "file": name,
                "format": image.format,
                "mode": image.mode,
                "width": image.width,
                "height": image.height,
                "bytes": Path(name).expanduser().stat().st_size,
                "orientation": exif.get(0x0112),
                "has_alpha": image.mode in ("RGBA", "LA") or "transparency" in image.info,
                "frames": getattr(image, "n_frames", 1),
            }
        )
    return {"images": items}


def cmd_resize(args) -> dict:
    image = ImageOps.exif_transpose(open_image(args.image))
    width, height = image.size
    if args.scale:
        size = (max(1, round(width * args.scale)), max(1, round(height * args.scale)))
    elif args.max:
        factor = min(args.max / width, args.max / height, 1.0 if not args.upscale else float("inf"))
        size = (max(1, round(width * factor)), max(1, round(height * factor)))
    elif args.width and args.height:
        size = (args.width, args.height)
    elif args.width:
        size = (args.width, max(1, round(height * args.width / width)))
    elif args.height:
        size = (max(1, round(width * args.height / height)), args.height)
    else:
        raise Refusal("size_missing", "give --width, --height, --max or --scale")
    resized = image.resize(size, Image.Resampling.LANCZOS)
    return write(resized, target(args.image, args.out, f"{size[0]}x{size[1]}"), source=image)


def cmd_crop(args) -> dict:
    image = ImageOps.exif_transpose(open_image(args.image))
    width, height = image.size
    if args.box:
        try:
            x, y, w, h = (int(float(v)) for v in args.box.split(","))
        except ValueError:
            raise Refusal("box_invalid", "box must be X,Y,W,H in pixels")
        if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > width or y + h > height:
            raise Refusal("box_outside", f"the box must lie inside {width}x{height}")
        box = (x, y, x + w, y + h)
    elif args.aspect:
        want = ratio(args.aspect)
        if width / height > want:
            w, h = round(height * want), height
        else:
            w, h = width, round(width / want)
        gravity = args.gravity
        x = {"left": 0, "right": width - w}.get(gravity, (width - w) // 2)
        y = {"top": 0, "bottom": height - h}.get(gravity, (height - h) // 2)
        box = (x, y, x + w, y + h)
    else:
        raise Refusal("crop_missing", "give --box or --aspect")
    cropped = image.crop(box)
    return write(cropped, target(args.image, args.out, "crop"), source=image)


def parse_color(text: str) -> tuple[int, ...]:
    value = text.lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    if len(value) not in (6, 8):
        raise Refusal("color_invalid", f"colour must be #rgb, #rrggbb or #rrggbbaa, got {text!r}")
    try:
        return tuple(int(value[i : i + 2], 16) for i in range(0, len(value), 2))
    except ValueError:
        raise Refusal("color_invalid", f"colour must be hexadecimal, got {text!r}")


def cmd_pad(args) -> dict:
    image = ImageOps.exif_transpose(open_image(args.image))
    want = ratio(args.aspect)
    width, height = image.size
    if width / height > want:
        size = (width, round(width / want))
    else:
        size = (round(height * want), height)
    color = parse_color(args.color)
    mode = "RGBA" if len(color) == 4 or image.mode in ("RGBA", "LA") else "RGB"
    canvas = Image.new(mode, size, color if mode == "RGBA" and len(color) == 4 else color[:3])
    canvas.paste(image.convert(mode), ((size[0] - width) // 2, (size[1] - height) // 2))
    return write(canvas, target(args.image, args.out, "pad"), source=image)


def cmd_convert(args) -> dict:
    image = open_image(args.image)
    fmt = FORMATS.get(args.to.lower())
    if not fmt:
        raise Refusal("format_unknown", f"cannot convert to {args.to!r}")
    extension = "jpg" if fmt == "JPEG" else args.to.lower()
    out = target(args.image, args.out, "converted", extension)
    if args.out is None:
        out = Path(args.image).with_suffix("." + extension)
        if out.resolve() == Path(args.image).expanduser().resolve():
            out = target(args.image, None, "converted", extension)
    return write(ImageOps.exif_transpose(image), out, fmt=fmt, quality=args.quality, source=image)


def cmd_compress(args) -> dict:
    image = ImageOps.exif_transpose(open_image(args.image))
    fmt = FORMATS.get((args.to or "jpeg").lower())
    if fmt not in ("JPEG", "WEBP"):
        raise Refusal("format_unsupported", "compress writes jpeg or webp")
    limit = args.max_kb * 1024
    working = fit_mode(image, fmt)
    best = None
    for _ in range(6):
        low, high = 20, 95
        while low <= high:
            quality = (low + high) // 2
            buffer = io.BytesIO()
            working.save(buffer, fmt, quality=quality, optimize=True)
            if buffer.tell() <= limit:
                best = (quality, buffer.getvalue())
                low = quality + 1
            else:
                high = quality - 1
        if best:
            break
        working = working.resize((max(1, working.width * 3 // 4), max(1, working.height * 3 // 4)), Image.Resampling.LANCZOS)
    if not best:
        raise Refusal("too_small", f"could not reach {args.max_kb} KB")
    extension = "jpg" if fmt == "JPEG" else "webp"
    out = target(args.image, args.out, "small", extension)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(best[1])
    return {"file": str(out), "format": fmt, "quality": best[0], "width": working.width, "height": working.height, "bytes": out.stat().st_size}


def cmd_rotate(args) -> dict:
    image = open_image(args.image)
    if args.auto:
        rotated = ImageOps.exif_transpose(image)
    elif args.degrees is not None:
        rotated = ImageOps.exif_transpose(image).rotate(-args.degrees, expand=True, resample=Image.Resampling.BICUBIC)
    else:
        raise Refusal("rotation_missing", "give --degrees or --auto")
    return write(rotated, target(args.image, args.out, "rotated"), keep_meta=False, source=image)


def cmd_flip(args) -> dict:
    image = ImageOps.exif_transpose(open_image(args.image))
    flipped = ImageOps.mirror(image) if args.axis == "horizontal" else ImageOps.flip(image)
    return write(flipped, target(args.image, args.out, "flipped"), source=image)


def cmd_strip(args) -> dict:
    image = ImageOps.exif_transpose(open_image(args.image))
    # Rebuilt from the raw pixels: no EXIF, GPS, XMP, ICC or text chunks survive.
    clean = Image.frombytes(image.mode, image.size, image.tobytes())
    if image.mode == "P" and image.getpalette():
        clean.putpalette(image.getpalette())
    clean.format = image.format
    return write(clean, target(args.image, args.out, "clean"), keep_meta=False, source=clean)


def cmd_sheet(args) -> dict:
    if not args.out:
        raise Refusal("out_missing", "give --out for the contact sheet")
    images = [ImageOps.exif_transpose(open_image(name)) for name in args.images]
    cols = max(1, min(args.cols, len(images)))
    rows = (len(images) + cols - 1) // cols
    cell = args.cell
    gap = 8
    sheet = Image.new("RGB", (cols * cell + (cols + 1) * gap, rows * cell + (rows + 1) * gap), (255, 255, 255))
    for index, image in enumerate(images):
        thumb = image.convert("RGBA")
        thumb.thumbnail((cell, cell), Image.Resampling.LANCZOS)
        col, row = index % cols, index // cols
        x = gap + col * (cell + gap) + (cell - thumb.width) // 2
        y = gap + row * (cell + gap) + (cell - thumb.height) // 2
        sheet.paste(thumb, (x, y), thumb)
    return write(sheet, Path(args.out).expanduser())


def cmd_transparent_bg(args) -> dict:
    """Flood-fill from the border: pixels connected to the edge and close to the edge colour go.

    Honest scope: this is for plain, even backgrounds (a logo on white, a product on a studio
    sweep). It does not find a subject in a photograph — that needs a segmentation model.
    """
    image = ImageOps.exif_transpose(open_image(args.image)).convert("RGBA")
    width, height = image.size
    pixels = image.load()
    corners = [pixels[0, 0], pixels[width - 1, 0], pixels[0, height - 1], pixels[width - 1, height - 1]]
    reference = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    tolerance = args.tolerance

    def close(color) -> bool:
        return color[3] > 0 and all(abs(color[i] - reference[i]) <= tolerance for i in range(3))

    seen = bytearray(width * height)
    stack = [(x, y) for x in range(width) for y in (0, height - 1)] + [(x, y) for y in range(height) for x in (0, width - 1)]
    cleared = 0
    while stack:
        x, y = stack.pop()
        index = y * width + x
        if seen[index]:
            continue
        seen[index] = 1
        if not close(pixels[x, y]):
            continue
        r, g, b, _ = pixels[x, y]
        pixels[x, y] = (r, g, b, 0)
        cleared += 1
        if x > 0:
            stack.append((x - 1, y))
        if x < width - 1:
            stack.append((x + 1, y))
        if y > 0:
            stack.append((x, y - 1))
        if y < height - 1:
            stack.append((x, y + 1))
    share = cleared / (width * height)
    result = write(image, target(args.image, args.out, "transparent", "png"), fmt="PNG")
    result["background"] = "#%02x%02x%02x" % reference
    result["cleared_share"] = round(share, 3)
    if share < 0.02:
        result["warning"] = "almost nothing was cleared: the background is probably not plain"
    elif share > 0.95:
        result["warning"] = "almost everything was cleared: lower --tolerance"
    return result


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = main.add_subparsers(dest="command", required=True)

    p = sub.add_parser("info")
    p.add_argument("images", nargs="+")

    p = sub.add_parser("resize")
    p.add_argument("image")
    p.add_argument("--width", type=int)
    p.add_argument("--height", type=int)
    p.add_argument("--max", type=int, help="longest side in pixels (never enlarges unless --upscale)")
    p.add_argument("--scale", type=float)
    p.add_argument("--upscale", action="store_true")
    p.add_argument("--out")

    p = sub.add_parser("crop")
    p.add_argument("image")
    p.add_argument("--box")
    p.add_argument("--aspect")
    p.add_argument("--gravity", default="center", choices=["center", "top", "bottom", "left", "right"])
    p.add_argument("--out")

    p = sub.add_parser("pad")
    p.add_argument("image")
    p.add_argument("--aspect", required=True)
    p.add_argument("--color", default="#ffffff")
    p.add_argument("--out")

    p = sub.add_parser("convert")
    p.add_argument("image")
    p.add_argument("--to", required=True)
    p.add_argument("--quality", type=int)
    p.add_argument("--out")

    p = sub.add_parser("compress")
    p.add_argument("image")
    p.add_argument("--max-kb", type=int, required=True)
    p.add_argument("--to", choices=["jpeg", "jpg", "webp"])
    p.add_argument("--out")

    p = sub.add_parser("rotate")
    p.add_argument("image")
    p.add_argument("--degrees", type=float, help="clockwise")
    p.add_argument("--auto", action="store_true", help="apply the camera's EXIF orientation")
    p.add_argument("--out")

    p = sub.add_parser("flip")
    p.add_argument("image")
    p.add_argument("--axis", choices=["horizontal", "vertical"], default="horizontal")
    p.add_argument("--out")

    p = sub.add_parser("strip")
    p.add_argument("image")
    p.add_argument("--out")

    p = sub.add_parser("sheet")
    p.add_argument("images", nargs="+")
    p.add_argument("--cols", type=int, default=4)
    p.add_argument("--cell", type=int, default=320)
    p.add_argument("--out")

    p = sub.add_parser("transparent-bg")
    p.add_argument("image")
    p.add_argument("--tolerance", type=int, default=24)
    p.add_argument("--out")
    return main


COMMANDS = {
    "info": cmd_info,
    "resize": cmd_resize,
    "crop": cmd_crop,
    "pad": cmd_pad,
    "convert": cmd_convert,
    "compress": cmd_compress,
    "rotate": cmd_rotate,
    "flip": cmd_flip,
    "strip": cmd_strip,
    "sheet": cmd_sheet,
    "transparent-bg": cmd_transparent_bg,
}


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = COMMANDS[args.command](args)
    except Refusal as refusal:
        print(json.dumps({"ok": False, "error": refusal.code, "message": str(refusal)}, ensure_ascii=False))
        return 2
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
