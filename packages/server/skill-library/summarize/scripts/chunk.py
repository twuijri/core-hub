#!/usr/bin/env python3
# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Split a long text or Markdown file into ordered chunks at headings and paragraph breaks.

Used by the Core Hub skill `summarize` to summarise a document that is too long to read in one
go: summarise each chunk, then summarise the summaries. Standard library only.

  chunk.py FILE [--max-chars 12000] [--out-dir DIR]
  chunk.py - < text.txt

Prints {"ok": true, "chunks": [{"index", "heading", "chars", "file"?, "text"?}], "total_chars"}.
With --out-dir each chunk is written to a numbered file and "text" is left out of the JSON.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")


def read(name: str) -> str:
    if name == "-":
        return sys.stdin.read()
    path = Path(name).expanduser()
    raw = path.read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    # cp1256 is how older Arabic Windows files are saved; latin-1 always decodes, so it is last.
    for encoding in ("utf-8-sig", "cp1256", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def blocks(text: str) -> list[tuple[str | None, str]]:
    """(heading in force, paragraph) pairs, in order; fenced code stays in one block."""
    out: list[tuple[str | None, str]] = []
    heading: str | None = None
    current: list[str] = []
    fenced = False

    def flush() -> None:
        if current and "".join(current).strip():
            out.append((heading, "\n".join(current).strip("\n")))
        current.clear()

    for line in text.replace("\r\n", "\n").split("\n"):
        if line.strip().startswith("```"):
            fenced = not fenced
            current.append(line)
            continue
        if not fenced:
            match = HEADING.match(line)
            if match:
                flush()
                heading = match.group(2)
                current.append(line)
                continue
            if line.strip() == "":
                flush()
                continue
        current.append(line)
    flush()
    return out


def split_long(paragraph: str, limit: int) -> list[str]:
    """A single paragraph longer than the limit is cut at sentence ends (Arabic and Latin)."""
    if len(paragraph) <= limit:
        return [paragraph]
    sentences = re.split(r"(?<=[.!?؟。])\s+", paragraph)
    pieces: list[str] = []
    current = ""
    for sentence in sentences:
        while len(sentence) > limit:
            pieces.append(sentence[:limit])
            sentence = sentence[limit:]
        if current and len(current) + 1 + len(sentence) > limit:
            pieces.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        pieces.append(current)
    return pieces


def chunk(text: str, limit: int) -> list[dict]:
    chunks: list[dict] = []
    parts: list[str] = []
    size = 0
    first_heading: str | None = None
    for heading, paragraph in blocks(text):
        for piece in split_long(paragraph, limit):
            if parts and size + len(piece) + 2 > limit:
                chunks.append({"heading": first_heading, "text": "\n\n".join(parts)})
                parts, size, first_heading = [], 0, None
            if first_heading is None:
                first_heading = heading
            parts.append(piece)
            size += len(piece) + 2
    if parts:
        chunks.append({"heading": first_heading, "text": "\n\n".join(parts)})
    for index, item in enumerate(chunks, start=1):
        item["index"] = index
        item["chars"] = len(item["text"])
    return chunks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file")
    parser.add_argument("--max-chars", type=int, default=12000)
    parser.add_argument("--out-dir")
    args = parser.parse_args(argv)
    if args.file != "-" and not Path(args.file).expanduser().is_file():
        print(json.dumps({"ok": False, "error": "file_not_found", "message": f"no such file: {args.file}"}))
        return 2
    text = read(args.file)
    chunks = chunk(text, max(1000, args.max_chars))
    if args.out_dir:
        out = Path(args.out_dir).expanduser()
        out.mkdir(parents=True, exist_ok=True)
        for item in chunks:
            path = out / f"chunk-{item['index']:03d}.md"
            path.write_text(item.pop("text"), encoding="utf-8")
            item["file"] = str(path)
    print(json.dumps({"ok": True, "total_chars": len(text), "chunks": chunks}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
