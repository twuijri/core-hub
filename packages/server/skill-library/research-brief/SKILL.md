---
name: research-brief
description: Research a question on the web and cite every source.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [research, web, sources, citations, fact check, compare, بحث, مصادر, تحقق, مقارنة, إنترنت]
    category: core-hub
    related_skills: [grounded-citations, blocked-page-recovery, summarize, report-writer]
  core_hub:
    library: core-hub
---

# Research Brief Skill

Answers a question from the open web with a short, sourced brief in Arabic or English: plan the
searches, search in both languages when the topic is regional, read the pages themselves (not
just the snippets), cross-check each claim against a second source, and write the answer with a
numbered source list. It relies on Hermes's `web_search` and `web_extract` tools; for strict
citation bookkeeping it defers to Hermes's `grounded-citations` skill, and for pages that refuse to
load to `blocked-page-recovery`.

يبحث في الإنترنت ويكتب موجزًا موثّقًا بالعربية أو الإنجليزية، مع رقم مصدر لكل معلومة.

## When to Use

- «ابحث لي عن…»، «قارن بين…»، «وش آخر الأخبار عن…»، «تأكد من هالمعلومة»، "research / compare / fact-check".
- Before a report, a decision or a purchase that depends on current facts.
- Not for questions the conversation's own files answer (read those), or for academic papers only
  (Hermes's `arxiv` skill).

## Prerequisites

`web_search` and `web_extract` available in this conversation. If they are not, say that web
research is not possible here and answer only from what is known, labelled as unverified.

## How to Run

No script. Templates: `templates/brief-ar.md`, `templates/brief-en.md` (read them with
`skill_view`, file_path `templates/…`). For a citation ledger that keeps URLs and numbers straight,
load `grounded-citations` and use its script.

## Quick Reference

| Step | Tool | Rule |
|---|---|---|
| plan | — | 3–6 queries: the question, synonyms, the opposite view, Arabic *and* English for regional topics |
| search | `web_search` | read titles and dates; prefer primary sources (official sites, filings, papers, statistics offices) |
| read | `web_extract` | open the 3–8 best pages; never cite a page you did not open |
| check | — | every key claim from two independent sources, or marked single-source |
| write | `write_file` | short answer first, then findings, disagreements, gaps, numbered sources |

## Procedure

1. Restate the question in one line and note what would change the answer (dates, place, units).
2. Search with the planned queries; add `site:` or a year when results are noisy.
3. Extract the pages you will rely on. When a page fails (403, paywall), try
   `blocked-page-recovery`; otherwise drop it and say so.
4. Build the source list as you go: number, title, publisher, date, URL. Numbers follow first use.
5. Write the brief in the person's language from the template. Arabic briefs keep URLs at the end
   of the line after a right-to-left mark, and use Arabic numerals consistently.
6. Save it as `research-<topic>-<yyyy-mm-dd>.md` when it is longer than a chat answer; otherwise
   answer inline with the same structure.

## Pitfalls

- Never invent a source, a quote, a date or a URL. If you did not open it, it is not a source.
- Mark old information: "as of 2024 [3]" when the latest source is old.
- Numbers from different sources may use different definitions; say which one you used.
- Quote briefly (a sentence at most) and paraphrase the rest.

## Verification

- Every `[n]` in the text has an entry in the source list and every entry is cited.
- Each key claim has two sources or is labelled single-source / unverified.
