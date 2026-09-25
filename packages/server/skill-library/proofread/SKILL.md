---
name: proofread
description: Proofread and polish Arabic or English text.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [proofread, grammar, spelling, editing, style, arabic, english, تدقيق, إملاء, نحو, تحرير, صياغة]
    category: core-hub
    related_skills: [report-writer, translate, humanizer]
  core_hub:
    library: core-hub
---

# Proofread Skill

Corrects spelling, grammar and punctuation in Arabic or English text and, when asked, tightens the
style — without changing the meaning, the register or the author's voice. The Arabic checklist
covers what most often goes wrong (hamza, taa marbuta, alif maqsura, number agreement, Arabic
punctuation and right-to-left display). The result is the corrected text plus a short list of
what changed and why, so the author can accept or reject each change.

يدقق النص العربي أو الإنجليزي إملائيًا ونحويًا ويحسّن صياغته دون تغيير معناه أو أسلوب كاتبه.

## When to Use

- «دقق لي هالنص»، «صحح الأخطاء الإملائية»، «حسّن الصياغة»، "proofread", "fix the grammar".
- Before sending a report, a letter, a post or a translation.
- To remove machine-sounding English, Hermes's `humanizer` skill goes further on style.

## Prerequisites

None. Read `references/arabic-checklist.md` with `skill_view` (file_path
`references/arabic-checklist.md`) before proofreading Arabic.

## How to Run

No script. For files, read with `read_file`, write the corrected version to a new file
(`name.proofread.md`) with `write_file`, and for Arabic run `report-writer`'s `rtl_md.py check` on it.

## Quick Reference

| Level | Changes |
|---|---|
| light (default) | spelling, grammar, punctuation, obvious typos only |
| medium | plus clarity: split long sentences, remove repetition, consistent terms and digits |
| heavy | plus restructuring paragraphs and tone — only when asked |

## Procedure

1. Ask nothing unless the level is unclear for a long document; default to **light**.
2. Work through the checklist in order for Arabic; for English, the English checklist at its end.
3. Keep: meaning, facts, names, numbers, quotations, technical terms, dialect used on purpose,
   and the author's formatting (headings, lists, tables).
4. Output:
   - the corrected text (in a fenced block for short texts, a new file for documents);
   - «التعديلات» / "Changes": a short table of before → after → reason, grouped when repeated
     (e.g. "همزة القطع ×7").
5. Flag, do not fix, anything that changes meaning (an ambiguous sentence, a wrong-looking number).

## Pitfalls

- Do not rewrite for taste at the light level.
- Do not "correct" quotations, legal text or names.
- Do not mix digit styles or switch the spelling variety (US/UK) of the author.
- An Arabic line that starts with a Latin word displays left-to-right; rephrase or mark it.

## Verification

- Every item in the change list appears in the corrected text; nothing else changed at the light level.
- Numbers, names and links are identical to the original.
