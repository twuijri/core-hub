#!/usr/bin/env python3
# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Check and fix right-to-left problems in an Arabic (or mixed) Markdown file.

Used by the Core Hub skills `report-writer` and `translate`. Standard library only.

  rtl_md.py check FILE      list the lines that will display wrongly, with the reason
  rtl_md.py fix FILE [--out F]   write a corrected copy (default FILE with -rtl before the suffix)

What it looks at, outside code blocks and inline code:
- a line in an Arabic paragraph whose first strong letter is Latin or that starts with a digit:
  browsers take a paragraph's direction from its first strong character, so the whole line would
  run left-to-right. Fix: a RIGHT-TO-LEFT MARK (U+200F) after the Markdown marker (#, -, 1., >, |);
- Latin punctuation in Arabic sentences: "," → "،", ";" → "؛", "?" → "؟" (not inside numbers, URLs
  or Latin words);
- a table whose header row starts with a Latin cell in an Arabic document (checked, not changed).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

RLM = "\u200f"
ARABIC = re.compile(r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]")
LATIN = re.compile(r"[A-Za-z\u00c0-\u024f]")
MARKER = re.compile(r"^(\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)*)")
PROTECTED = re.compile(r"`[^`]*`|https?://\S+|\[[^\]]*\]\([^)]*\)|<[^>]+>")


def first_strong(text: str) -> str | None:
    for char in text:
        if ARABIC.match(char):
            return "rtl"
        if LATIN.match(char):
            return "ltr"
        if char.isdigit():
            return "digit"
    return None


def arabic_share(text: str) -> float:
    arabic = len(ARABIC.findall(text))
    latin = len(LATIN.findall(text))
    return arabic / (arabic + latin) if arabic + latin else 0.0


def swap_punctuation(segment: str) -> str:
    segment = re.sub(r"(?<=[\u0600-\u06ff\s\)]),(?=\s|$)", "،", segment)
    segment = re.sub(r"(?<=[\u0600-\u06ff\s\)]);(?=\s|$)", "؛", segment)
    segment = re.sub(r"(?<=[\u0600-\u06ff\s\)])\?(?=\s|$|[\"')\]])", "؟", segment)
    return segment


def fix_punctuation(line: str) -> str:
    out = []
    last = 0
    for match in PROTECTED.finditer(line):
        out.append(swap_punctuation(line[last : match.start()]))
        out.append(match.group(0))
        last = match.end()
    out.append(swap_punctuation(line[last:]))
    return "".join(out)


def analyse(lines: list[str], fix: bool) -> tuple[list[dict], list[str]]:
    document_rtl = arabic_share("\n".join(lines)) >= 0.3
    issues: list[dict] = []
    fixed: list[str] = []
    fenced = False
    for number, line in enumerate(lines, start=1):
        if line.strip().startswith("```") or line.strip().startswith("~~~"):
            fenced = not fenced
            fixed.append(line)
            continue
        if fenced or not line.strip():
            fixed.append(line)
            continue
        plain = PROTECTED.sub(lambda m: "x" if m.group(0).startswith("`") else m.group(0), line)
        line_rtl = arabic_share(plain) >= 0.3 or (document_rtl and ARABIC.search(plain) is not None)
        new = line
        if line_rtl:
            prefix = MARKER.match(line).group(1)
            rest = line[len(prefix) :]
            if rest.startswith("|"):
                cells = [cell.strip() for cell in rest.strip("|").split("|")]
                if cells and first_strong(cells[0]) in ("ltr", "digit") and not re.fullmatch(r":?-{2,}:?", cells[0] or ""):
                    issues.append({"line": number, "issue": "table_row_starts_ltr", "text": line.strip()[:80]})
            elif not rest.startswith(RLM) and first_strong(rest) in ("ltr", "digit"):
                issues.append({"line": number, "issue": "line_starts_ltr", "text": line.strip()[:80]})
                new = prefix + RLM + rest
            punctuated = fix_punctuation(new)
            if punctuated != new:
                issues.append({"line": number, "issue": "latin_punctuation", "text": line.strip()[:80]})
                new = punctuated
        fixed.append(new if fix else line)
    return issues, fixed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.add_argument("file")
    fix = sub.add_parser("fix")
    fix.add_argument("file")
    fix.add_argument("--out")
    args = parser.parse_args(argv)

    path = Path(args.file).expanduser()
    if not path.is_file():
        print(json.dumps({"ok": False, "error": "file_not_found", "message": f"no such file: {args.file}"}))
        return 2
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    issues, fixed = analyse(lines, fix=args.command == "fix")
    result: dict = {"ok": True, "issues": issues, "count": len(issues)}
    if args.command == "fix":
        out = Path(args.out).expanduser() if args.out else path.with_name(f"{path.stem}-rtl{path.suffix}")
        out.write_text("\n".join(fixed), encoding="utf-8")
        result["file"] = str(out)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
