---
name: data-to-chart
description: Turn a CSV or Excel file into a table and a chart.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [csv, excel, xlsx, table, chart, graph, statistics, data, جدول, رسم بياني, إكسل, بيانات, إحصاء]
    category: core-hub
    related_skills: [xlsx, report-writer, slides-html]
  core_hub:
    library: core-hub
---

# Data to Chart Skill

Reads a CSV/TSV or `.xlsx` file from the conversation's folder and answers with what is in it: a
Markdown table, per-column statistics, and an SVG chart (bar, horizontal bar, line or pie) that
opens in the file preview and can go into a report or slides. The helper needs only Python's
standard library — no pandas, openpyxl or matplotlib — and handles Arabic headers, Arabic-Indic
digits, `;` separators and old Windows Arabic encodings. Building or editing Excel workbooks is
the job of Hermes's `xlsx` skill.

يقرأ ملف CSV أو إكسل ويحوّله إلى جدول وإحصاءات ورسم بياني SVG.

## When to Use

- «حلل هالملف»، «سوّ جدول ورسم بياني من الإكسل»، «كم المجموع لكل فرع؟»، "chart sales by month".
- Quick looks at exported data before a report or a slide.

## Prerequisites

None beyond Python 3. The file must be in the working folder (find it with
`search_files target='files'`). Old `.xls` files must be saved as `.xlsx` or `.csv` first.

## How to Run

```
python3 <skill_dir>/scripts/table_chart.py inspect sales.xlsx
python3 <skill_dir>/scripts/table_chart.py table sales.csv --columns region,total --sort total --desc --limit 20
python3 <skill_dir>/scripts/table_chart.py stats sales.csv
python3 <skill_dir>/scripts/table_chart.py chart sales.csv --x region --y total --kind bar --title "المبيعات حسب المنطقة" --out charts/sales-by-region.svg
python3 <skill_dir>/scripts/table_chart.py chart sales.xlsx --sheet 2026 --x month --y revenue,cost --kind line --agg sum --out charts/trend.svg
```

All commands print JSON: `inspect` gives columns with their type (`number`, `date`, `text`), row
count and sheet names; `table` gives `markdown`; `chart` gives the SVG `file`.

## Quick Reference

| Question | Chart |
|---|---|
| compare categories | `bar` (≤ 12 bars) or `hbar` (long labels, many bars) |
| change over time | `line`, x = the date/month column, sorted as in the file |
| share of a whole | `pie`, one `--y`, at most ~7 slices |
| how many rows per group | `--agg count` |
| average per group | `--agg mean` |

## Procedure

1. `inspect` the file. Name the columns in your reply the way the file names them.
2. Decide what answers the question: pick x (a category or date column) and y (numeric).
   If the question is unclear, propose one chart and ask before making several.
3. `table` for the rows the person needs (top N, sorted); `stats` for totals and averages. Paste
   the Markdown table into the reply, right-aligned numbers intact.
4. `chart` into a `charts/` folder with a title in the person's language. Show it as a Markdown
   image (`![title](charts/….svg)`).
5. Explain the result in two or three sentences: the largest, the smallest, the trend — with the
   numbers from the JSON, not estimated from the picture.

## Pitfalls

- `.xlsx` values are what Excel last saved; formulas are not recalculated. Say so if the file
  looks like it was never opened in Excel after editing.
- Mixed columns (numbers with notes) are `text`; clean or pick another column rather than guessing.
- Very many categories: the chart keeps the first `--limit` (20) and reports `truncated: true`;
  sort first (`--sort desc`) so the kept ones are the largest.
- Do not present totals of already-aggregated rows (a "Total" row in the file) twice; filter it.

## Verification

- The numbers in your text match `stats` / the table.
- The SVG file exists and `points` in the JSON equals the number of categories shown.
