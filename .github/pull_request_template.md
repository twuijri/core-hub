<!--
English first, please: this repository is public. An Arabic summary under the English one is
welcome. Rules: CONTRIBUTING.md, docs/TEAM-RULES.md. Only the owner merges into `main`.
الإنجليزية أولًا لأن المستودع عام، ويُرحَّب بملخص عربي تحتها.
-->

## Issue / البلاغ

<!-- "Closes #123" closes the issue automatically when this pull request is merged; write one line
per issue. Use "Refs #123" when it only helps and the issue should stay open. Write "None" when
there is no issue.
«Closes #123» يغلق البلاغ تلقائيًا عند الدمج؛ سطر لكل بلاغ. «Refs #123» إن كان يساعد فقط ويبقى البلاغ مفتوحًا. -->

Closes #

## Problem / المشكلة

<!-- What is wrong or missing, and who notices it. -->

## Decision / القرار

<!-- What this pull request does, and what it deliberately does not do. New product choices are
marked "proposed — owner to confirm". -->

## Evidence / الدليل

<!-- The checks you actually ran and their real output (docs/harness/validation.md). Never claim a
check you did not run. -->

- Change record / سجل التغيير: `docs/changes/YYYY-MM-DD-<owner>-<topic>.md`

## Risks and rollback / المخاطر والرجوع

<!-- What could break, and how to undo it. -->

## Checklist / قائمة التحقق

- [ ] Contract first: every new endpoint or event is in `packages/contracts` (or nothing changed there).
      العقد أولًا.
- [ ] Every user-facing string exists in Arabic and English. كل نص للمستخدم بالعربية والإنجليزية.
- [ ] A change record in `docs/changes/` with real check output. سجل تغيير بنواتج فعلية.
- [ ] Clean room: nothing copied from Hermes Studio / Ekko Studio (ADR 0004). الغرفة النظيفة.
- [ ] No secrets, no owner hostnames, no `graphify-out/`. لا أسرار ولا أسماء مضيفين.
