#!/usr/bin/env python3
# Copyright 2026 twuijri — part of Core Hub, licensed under the Apache License, Version 2.0.
"""Read a CSV/TSV or Excel (.xlsx) file and turn it into a Markdown table, statistics or an SVG chart.

Used by the Core Hub skill `data-to-chart`. Standard library only: .xlsx is read directly from
its XML (values as last saved by Excel; formulas are not recalculated), so no openpyxl or pandas
is needed.

  inspect FILE [--sheet NAME]                         columns, types, row count, first rows
  table FILE [--columns a,b] [--sort COL] [--desc] [--limit 50] [--sheet NAME]
  stats FILE [--columns a,b] [--sheet NAME]           count, sum, mean, min, max per numeric column
  chart FILE --x COL --y COL[,COL] [--kind bar|hbar|line|pie] [--agg sum|mean|count|none]
             [--title T] [--limit 20] [--sheet NAME] --out chart.svg

Every command prints one JSON object; `table` puts the Markdown in "markdown".
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
ARABIC = re.compile(r"[\u0600-\u06FF]")
PALETTE = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#dc2626", "#ca8a04", "#4b5563"]


class Refusal(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- reading

def decode(raw: bytes) -> str:
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    for encoding in ("utf-8-sig", "cp1256", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def read_csv(path: Path) -> list[list[str]]:
    text = decode(path.read_bytes())
    sample = text[:20000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel_tab if path.suffix.lower() == ".tsv" else csv.excel
    return [row for row in csv.reader(io.StringIO(text), dialect) if any(cell.strip() for cell in row)]


def column_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref)
    index = 0
    for char in letters.group(0) if letters else "A":
        index = index * 26 + (ord(char) - 64)
    return index - 1


def read_xlsx(path: Path, sheet: str | None) -> tuple[list[list[str]], list[str]]:
    try:
        book = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise Refusal("file_unreadable", f"{path.name} is not a valid .xlsx file")
    with book:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in book.namelist():
            root = ET.fromstring(book.read("xl/sharedStrings.xml"))
            for item in root.findall("m:si", NS):
                shared.append("".join(node.text or "" for node in item.iter(f"{{{NS['m']}}}t")))
        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target") for rel in rels}
        sheets = []
        listed = workbook.find("m:sheets", NS)
        for node in list(listed) if listed is not None else []:
            rid = node.get(f"{{{REL_NS}}}id")
            target = targets.get(rid, "")
            target = target.lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            sheets.append((node.get("name"), target))
        if not sheets:
            raise Refusal("sheet_missing", "the workbook has no sheets")
        names = [name for name, _ in sheets]
        chosen = sheets[0]
        if sheet:
            match = [entry for entry in sheets if entry[0] == sheet]
            if not match:
                raise Refusal("sheet_missing", f"no sheet {sheet!r}; sheets: {', '.join(names)}")
            chosen = match[0]
        root = ET.fromstring(book.read(chosen[1]))
        rows: list[list[str]] = []
        for row in root.iter(f"{{{NS['m']}}}row"):
            values: dict[int, str] = {}
            for cell in row.findall("m:c", NS):
                kind = cell.get("t")
                value_node = cell.find("m:v", NS)
                if kind == "inlineStr":
                    value = "".join(node.text or "" for node in cell.iter(f"{{{NS['m']}}}t"))
                elif value_node is None:
                    continue
                elif kind == "s":
                    value = shared[int(value_node.text or 0)]
                elif kind == "b":
                    value = "TRUE" if value_node.text == "1" else "FALSE"
                else:
                    value = value_node.text or ""
                values[column_index(cell.get("r") or "A")] = value
            if values:
                width = max(values) + 1
                rows.append([values.get(i, "") for i in range(width)])
        return [row for row in rows if any(cell.strip() for cell in row)], names


def load(name: str, sheet: str | None) -> tuple[list[str], list[list[str]], list[str]]:
    path = Path(name).expanduser()
    if not path.is_file():
        raise Refusal("file_not_found", f"no such file: {name}")
    suffix = path.suffix.lower()
    sheets: list[str] = []
    if suffix in (".xlsx", ".xlsm"):
        rows, sheets = read_xlsx(path, sheet)
    elif suffix == ".xls":
        raise Refusal("format_unsupported", "old .xls files are not read; save as .xlsx or .csv")
    else:
        rows = read_csv(path)
    if not rows:
        raise Refusal("file_empty", f"{path.name} has no rows")
    width = max(len(row) for row in rows)
    header = [cell.strip() or f"column_{i + 1}" for i, cell in enumerate(rows[0] + [""] * (width - len(rows[0])))]
    body = [row + [""] * (width - len(row)) for row in rows[1:]]
    return header, body, sheets


# ---------------------------------------------------------------- values

ARABIC_DIGITS = str.maketrans("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u066b\u066c", "0123456789.,")


def number(text: str) -> float | None:
    value = text.strip().translate(ARABIC_DIGITS)
    if not value:
        return None
    negative = value.startswith("(") and value.endswith(")")
    value = re.sub(r"[\s,%$€£﷼]|SAR|ر\.س|ريال", "", value.strip("()"))
    try:
        result = float(value)
    except ValueError:
        return None
    if math.isnan(result) or math.isinf(result):
        return None
    return -result if negative else result


def kind_of(values: list[str]) -> str:
    filled = [v for v in values if v.strip()]
    if not filled:
        return "empty"
    numeric = sum(1 for v in filled if number(v) is not None)
    if numeric / len(filled) >= 0.9:
        return "number"
    if sum(1 for v in filled if re.match(r"^\d{4}-\d{2}-\d{2}", v.strip())) / len(filled) >= 0.9:
        return "date"
    return "text"


def pick(header: list[str], names: str | None) -> list[int]:
    if not names:
        return list(range(len(header)))
    chosen = []
    for name in [n.strip() for n in names.split(",") if n.strip()]:
        if name in header:
            chosen.append(header.index(name))
        elif name.isdigit() and 1 <= int(name) <= len(header):
            chosen.append(int(name) - 1)
        else:
            raise Refusal("column_missing", f"no column {name!r}; columns: {', '.join(header)}")
    return chosen


def fmt(value: float) -> str:
    if value == int(value) and abs(value) < 1e15:
        return f"{int(value):,}"
    return f"{value:,.2f}"


def md_cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ").strip()


# ---------------------------------------------------------------- commands

def cmd_inspect(args) -> dict:
    header, body, sheets = load(args.file, args.sheet)
    columns = []
    for i, name in enumerate(header):
        values = [row[i] for row in body]
        columns.append({"name": name, "type": kind_of(values), "filled": sum(1 for v in values if v.strip())})
    return {"columns": columns, "rows": len(body), "sheets": sheets, "sample": body[:5]}


def cmd_table(args) -> dict:
    header, body, _ = load(args.file, args.sheet)
    columns = pick(header, args.columns)
    rows = body
    if args.sort:
        key = pick(header, args.sort)[0]
        numeric = kind_of([row[key] for row in rows]) == "number"
        rows = sorted(
            rows,
            key=lambda row: (number(row[key]) if number(row[key]) is not None else float("-inf")) if numeric else row[key],
            reverse=args.desc,
        )
    shown = rows[: args.limit]
    types = [kind_of([row[i] for row in body]) for i in columns]
    lines = [
        "| " + " | ".join(md_cell(header[i]) for i in columns) + " |",
        "|" + "|".join("---:" if t == "number" else "---" for t in types) + "|",
    ]
    for row in shown:
        lines.append("| " + " | ".join(md_cell(row[i]) for i in columns) + " |")
    return {"markdown": "\n".join(lines), "rows_shown": len(shown), "rows_total": len(body)}


def cmd_stats(args) -> dict:
    header, body, _ = load(args.file, args.sheet)
    out = []
    for i in pick(header, args.columns):
        values = [number(row[i]) for row in body]
        values = [v for v in values if v is not None]
        if not values or kind_of([row[i] for row in body]) != "number":
            continue
        total = sum(values)
        out.append(
            {
                "column": header[i],
                "count": len(values),
                "sum": total,
                "mean": total / len(values),
                "min": min(values),
                "max": max(values),
            }
        )
    return {"stats": out, "rows": len(body)}


def aggregate(header, body, x: int, ys: list[int], agg: str) -> tuple[list[str], list[list[float]]]:
    labels: list[str] = []
    buckets: dict[str, list[list[float]]] = {}
    for row in body:
        label = row[x].strip() or "—"
        if label not in buckets:
            labels.append(label)
            buckets[label] = [[] for _ in ys]
        for j, y in enumerate(ys):
            value = number(row[y])
            if agg == "count":
                buckets[label][j].append(1.0)
            elif value is not None:
                buckets[label][j].append(value)
    series: list[list[float]] = []
    for j in range(len(ys)):
        values = []
        for label in labels:
            items = buckets[label][j]
            if agg == "mean":
                values.append(sum(items) / len(items) if items else 0.0)
            elif agg == "none":
                values.append(items[-1] if items else 0.0)
            else:
                values.append(sum(items))
        series.append(values)
    return labels, series


def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def text_el(x: float, y: float, content: str, size: int = 12, anchor: str = "middle", weight: str = "normal", fill: str = "#374151") -> str:
    direction = ' direction="rtl" unicode-bidi="embed"' if ARABIC.search(content) else ""
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" text-anchor="{anchor}" font-weight="{weight}" '
        f'fill="{fill}"{direction}>{esc(content)}</text>'
    )


def short(label: str, limit: int = 18) -> str:
    return label if len(label) <= limit else label[: limit - 1] + "…"


def nice_max(value: float) -> float:
    if value <= 0:
        return 1.0
    exponent = 10 ** math.floor(math.log10(value))
    for step in (1, 2, 2.5, 5, 10):
        if value <= step * exponent:
            return step * exponent
    return 10 * exponent


def svg_chart(kind: str, title: str, labels: list[str], series: list[list[float]], names: list[str]) -> str:
    width, height = 900, 520
    font = "font-family=\"'Noto Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif\""
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" {font}>']
    parts.append(f'<rect width="{width}" height="{height}" fill="#ffffff"/>')
    parts.append(text_el(width / 2, 34, title, 18, weight="bold", fill="#111827"))
    if kind == "pie":
        values = series[0]
        total = sum(v for v in values if v > 0) or 1.0
        cx, cy, r = 320, 280, 190
        angle = -math.pi / 2
        for i, (label, value) in enumerate(zip(labels, values)):
            if value <= 0:
                continue
            sweep = 2 * math.pi * value / total
            x1, y1 = cx + r * math.cos(angle), cy + r * math.sin(angle)
            x2, y2 = cx + r * math.cos(angle + sweep), cy + r * math.sin(angle + sweep)
            large = 1 if sweep > math.pi else 0
            color = PALETTE[i % len(PALETTE)]
            if sweep >= 2 * math.pi - 1e-9:
                parts.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}"/>')
            else:
                parts.append(f'<path d="M{cx},{cy} L{x1:.1f},{y1:.1f} A{r},{r} 0 {large} 1 {x2:.1f},{y2:.1f} Z" fill="{color}" stroke="#fff" stroke-width="2"/>')
            angle += sweep
            ly = 90 + i * 26
            parts.append(f'<rect x="560" y="{ly - 12}" width="14" height="14" fill="{color}"/>')
            parts.append(text_el(582, ly, f"{short(label, 26)} — {fmt(value)} ({value / total:.0%})", 13, anchor="start"))
        parts.append("</svg>")
        return "\n".join(parts)

    left, right, top, bottom = 90, 30, 60, 110
    if len(series) > 1:
        top = 84
        for j, name in enumerate(names):
            x = left + j * 170
            parts.append(f'<rect x="{x}" y="50" width="14" height="14" fill="{PALETTE[j % len(PALETTE)]}"/>')
            parts.append(text_el(x + 20, 62, short(name, 20), 12, anchor="start"))
    plot_w, plot_h = width - left - right, height - top - bottom
    peak = nice_max(max((v for s in series for v in s), default=0.0))
    low = min(0.0, min((v for s in series for v in s), default=0.0))
    span = (peak - low) or 1.0

    if kind == "hbar":
        n = len(labels)
        band = plot_h / max(n, 1)
        bar = band * 0.7 / len(series)
        for i, label in enumerate(labels):
            y0 = top + i * band + band * 0.15
            parts.append(text_el(left - 8, y0 + band * 0.4, short(label), 12, anchor="end"))
            for j, values in enumerate(series):
                w = plot_w * (values[i] - low) / span
                parts.append(f'<rect x="{left}" y="{y0 + j * bar:.1f}" width="{max(w, 0):.1f}" height="{bar:.1f}" fill="{PALETTE[j % len(PALETTE)]}"/>')
                parts.append(text_el(left + max(w, 0) + 4, y0 + j * bar + bar * 0.75, fmt(values[i]), 11, anchor="start"))
        parts.append("</svg>")
        return "\n".join(parts)

    for k in range(5):
        value = low + span * k / 4
        y = top + plot_h - plot_h * k / 4
        parts.append(f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" stroke="#e5e7eb"/>')
        parts.append(text_el(left - 8, y + 4, fmt(value), 11, anchor="end", fill="#6b7280"))
    n = len(labels)
    band = plot_w / max(n, 1)
    rotate = n > 8
    for i, label in enumerate(labels):
        x = left + band * (i + 0.5)
        if rotate:
            parts.append(
                f'<g transform="translate({x:.1f},{top + plot_h + 14}) rotate(-40)">'
                + text_el(0, 0, short(label), 11, anchor="end")
                + "</g>"
            )
        else:
            parts.append(text_el(x, top + plot_h + 20, short(label), 12))
    zero = top + plot_h - plot_h * (0 - low) / span
    if kind == "line":
        for j, values in enumerate(series):
            points = " ".join(f"{left + band * (i + 0.5):.1f},{top + plot_h - plot_h * (v - low) / span:.1f}" for i, v in enumerate(values))
            color = PALETTE[j % len(PALETTE)]
            parts.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="2.5"/>')
            for i, v in enumerate(values):
                parts.append(f'<circle cx="{left + band * (i + 0.5):.1f}" cy="{top + plot_h - plot_h * (v - low) / span:.1f}" r="3.5" fill="{color}"/>')
    else:
        bar = band * 0.7 / len(series)
        for j, values in enumerate(series):
            for i, v in enumerate(values):
                x = left + band * i + band * 0.15 + j * bar
                y = top + plot_h - plot_h * (v - low) / span
                parts.append(f'<rect x="{x:.1f}" y="{min(y, zero):.1f}" width="{bar:.1f}" height="{abs(zero - y):.1f}" fill="{PALETTE[j % len(PALETTE)]}"/>')
                if n <= 12 and len(series) == 1:
                    parts.append(text_el(x + bar / 2, min(y, zero) - 5, fmt(v), 11))
    parts.append(f'<line x1="{left}" y1="{zero:.1f}" x2="{width - right}" y2="{zero:.1f}" stroke="#9ca3af"/>')
    parts.append("</svg>")
    return "\n".join(parts)


def cmd_chart(args) -> dict:
    header, body, _ = load(args.file, args.sheet)
    x = pick(header, args.x)[0]
    ys = pick(header, args.y)
    if args.kind == "pie" and len(ys) != 1:
        raise Refusal("pie_one_series", "a pie chart takes exactly one --y column")
    agg = args.agg or ("count" if all(kind_of([row[y] for row in body]) != "number" for y in ys) else "sum")
    labels, series = aggregate(header, body, x, ys, agg)
    if args.sort:
        order = sorted(range(len(labels)), key=lambda i: series[0][i], reverse=args.sort == "desc")
        labels = [labels[i] for i in order]
        series = [[values[i] for i in order] for values in series]
    if len(labels) > args.limit:
        labels, series = labels[: args.limit], [values[: args.limit] for values in series]
        truncated = True
    else:
        truncated = False
    names = [header[y] for y in ys]
    title = args.title or (f"{' / '.join(names)} — {header[x]}")
    svg = svg_chart(args.kind, title, labels, series, names)
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(svg, encoding="utf-8")
    return {"file": str(out), "points": len(labels), "series": names, "aggregate": agg, "truncated": truncated}


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = main.add_subparsers(dest="command", required=True)
    p = sub.add_parser("inspect")
    p.add_argument("file")
    p.add_argument("--sheet")
    p = sub.add_parser("table")
    p.add_argument("file")
    p.add_argument("--columns")
    p.add_argument("--sort")
    p.add_argument("--desc", action="store_true")
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--sheet")
    p = sub.add_parser("stats")
    p.add_argument("file")
    p.add_argument("--columns")
    p.add_argument("--sheet")
    p = sub.add_parser("chart")
    p.add_argument("file")
    p.add_argument("--x", required=True)
    p.add_argument("--y", required=True)
    p.add_argument("--kind", choices=["bar", "hbar", "line", "pie"], default="bar")
    p.add_argument("--agg", choices=["sum", "mean", "count", "none"])
    p.add_argument("--sort", choices=["asc", "desc"])
    p.add_argument("--title")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--sheet")
    p.add_argument("--out", required=True)
    return main


COMMANDS = {"inspect": cmd_inspect, "table": cmd_table, "stats": cmd_stats, "chart": cmd_chart}


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
