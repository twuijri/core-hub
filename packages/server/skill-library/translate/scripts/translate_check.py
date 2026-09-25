#!/usr/bin/env python3
# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Compare a Markdown source with its translation and report what the translation lost or changed.

Used by the Core Hub skill `translate`. Standard library only.

  translate_check.py SOURCE TRANSLATION

Prints {"ok": true, "clean": bool, "problems": [...], "counts": {...}}. It compares what must survive a
translation unchanged: the number and levels of headings, list items, table rows and columns,
fenced code blocks (byte for byte), inline code, link and image targets, placeholders such as
{name} / {{name}} / %s / :name, and numbers (Arabic-Indic digits count as their Western value).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

FENCE = re.compile(r"^(```|~~~)[^\n]*\n.*?^\1\s*$", re.S | re.M)
INLINE_CODE = re.compile(r"`[^`\n]+`")
LINK = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
BARE_URL = re.compile(r"(?<![(<])https?://[^\s)>\]]+")
PLACEHOLDER = re.compile(r"\{\{\s*[\w.]+\s*\}\}|\{[\w.]+\}|%\(?\w*\)?[sd]|(?<!\w):[a-z_]\w*\b|\$\{[\w.]+\}")
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
DIGITS = str.maketrans("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9", "01234567890123456789")


def structure(text: str) -> dict:
    fences = [match.group(0).strip() for match in FENCE.finditer(text)]
    prose = FENCE.sub("", text)
    lines = prose.split("\n")
    headings = [len(m.group(1)) for line in lines if (m := re.match(r"^(#{1,6})\s", line))]
    bullets = sum(1 for line in lines if re.match(r"^\s*(?:[-*+]|\d+[.)])\s+\S", line))
    table_rows = [line for line in lines if re.match(r"^\s*\|.*\|\s*$", line)]
    table_cols = [len(row.strip().strip("|").split("|")) for row in table_rows]
    inline = INLINE_CODE.findall(prose)
    without_code = INLINE_CODE.sub("", prose)
    links = LINK.findall(without_code)
    urls = BARE_URL.findall(LINK.sub("", without_code))
    placeholders = PLACEHOLDER.findall(without_code)
    numbers = [
        n.replace(",", "").replace("٬", "")
        for n in NUMBER.findall(LINK.sub("", BARE_URL.sub("", without_code)).translate(DIGITS))
    ]
    return {
        "fences": fences,
        "headings": headings,
        "bullets": bullets,
        "table_rows": len(table_rows),
        "table_cols": table_cols,
        "inline_code": inline,
        "links": links + urls,
        "placeholders": placeholders,
        "numbers": numbers,
    }


def missing(source: list[str], target: list[str]) -> list[str]:
    left = Counter(source)
    left.subtract(Counter(target))
    return sorted(item for item, count in left.items() for _ in range(max(count, 0)))


def compare(source: dict, target: dict) -> list[dict]:
    problems: list[dict] = []
    if source["headings"] != target["headings"]:
        problems.append({"check": "headings", "source": source["headings"], "translation": target["headings"]})
    if source["bullets"] != target["bullets"]:
        problems.append({"check": "list_items", "source": source["bullets"], "translation": target["bullets"]})
    if source["table_rows"] != target["table_rows"] or source["table_cols"] != target["table_cols"]:
        problems.append(
            {
                "check": "tables",
                "source": {"rows": source["table_rows"], "cols": source["table_cols"]},
                "translation": {"rows": target["table_rows"], "cols": target["table_cols"]},
            }
        )
    if source["fences"] != target["fences"]:
        problems.append(
            {
                "check": "code_blocks",
                "source": len(source["fences"]),
                "translation": len(target["fences"]),
                "detail": "fenced code must be copied unchanged",
            }
        )
    for key, label in (("inline_code", "inline_code"), ("links", "link_targets"), ("placeholders", "placeholders"), ("numbers", "numbers")):
        lost = missing(source[key], target[key])
        added = missing(target[key], source[key])
        if lost or added:
            problems.append({"check": label, "missing": lost[:20], "unexpected": added[:20]})
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source")
    parser.add_argument("translation")
    args = parser.parse_args(argv)
    texts = []
    for name in (args.source, args.translation):
        path = Path(name).expanduser()
        if not path.is_file():
            print(json.dumps({"ok": False, "error": "file_not_found", "message": f"no such file: {name}"}))
            return 2
        texts.append(path.read_text(encoding="utf-8"))
    source, target = structure(texts[0]), structure(texts[1])
    problems = compare(source, target)
    counts = {
        "headings": len(source["headings"]),
        "list_items": source["bullets"],
        "table_rows": source["table_rows"],
        "code_blocks": len(source["fences"]),
        "links": len(source["links"]),
        "numbers": len(source["numbers"]),
    }
    print(json.dumps({"ok": True, "clean": not problems, "problems": problems, "counts": counts}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
