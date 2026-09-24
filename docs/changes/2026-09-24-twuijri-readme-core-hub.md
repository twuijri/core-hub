# إعادة كتابة README باسم Core Hub
المسؤول: twuijri · الفرع: docs/readme-core-hub · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٤): «احتاج تعدل الريدمي … مكتوب على انه المجلس
… متفقين اننا نحوله يصير كور هب … وشرح منمق وكل شيء بالانجليزي ومرتب».

كان `README.md` في الجذر يقدّم المنتج باسمه القديم وبفقرة قائمة قراءة، بلا طريقة تشغيل ولا
ملخص لما يعمل. الهدف: صفحة مستودع `twuijri/core-hub` بالإنجليزية، مرتبة وسهلة التصفح، باسم
**Core Hub** فقط، مبنية على حقائق المستودع (`docs/STATUS.md` و`docs/DEPLOY.md`
و`docs/ARCHITECTURE.md` و`docs/ROADMAP.md` و`docs/adr/` و`docker-compose.yml` و`LICENSE`
و`THIRD-PARTY-NOTICES.md`) دون ادعاء ميزة يقول STATUS إنها غير مبنية.

## القرار والموافقات
- الأقسام: تعريف قصير، المزايا، البدء السريع بـ Docker، التحديث، البنية باختصار، التطوير،
  المساهمة، الحالة وخارطة الطريق، الترخيص.
- **الصورة**: `ghcr.io/twuijri/core-hub:latest`، تحققت أنها موجودة وعامة
  (`docker manifest inspect` نجح). مسار `release.yml` ينشر إلى `ghcr.io/${{ github.repository }}`
  فصار الاسم `core-hub` بعد تغيير اسم المستودع. مقتطف compose في README مكتوب بهذه الصورة
  وبخدمة `hub` نفسها، أما `docker-compose.yml` في الجذر فما زال يشير إلى الصورة القديمة ولم
  ألمسه (خارج نطاق المهمة؛ PR إعادة التسمية يغيّره).
- **الأوامر التي تحمل الاسم القديم**: تجنّبت ذكره بالكامل. أوامر التطوير عبر سكربتات الجذر
  (`pnpm dev`، `pnpm web:dev`، `pnpm web:e2e`) وعميل الطرفية عبر المسار
  (`pnpm --filter ./packages/cli build` ثم `node packages/cli/dist/bin.js …`)، وكلها تعمل على
  `main` اليوم. **PR إعادة التسمية** إن أضاف اسمًا جديدًا للأمر (`core-hub setup` مثلًا) فليحدّث
  هذه الأسطر.
- **الشعار**: لم يُضف. GitHub لا يعرض SVG مضمّنًا داخل Markdown، وإضافة ملف SVG تعني لمس ملف
  آخر غير README وسجل التغيير، وهذا خارج ما سمح به المالك. مقترح — للمالك أن يؤكد: ملف
  `docs/assets/core-hub-mark.svg` من مسار `MajlisMark.tsx` في PR لاحق.
- **الترخيص**: نُقل نص `LICENSE` حرفيًا كما هو (ملكية خاصة، كل الحقوق محفوظة) مع الإشارة إلى
  `THIRD-PARTY-NOTICES.md`.
- **تيليجرام**: مكتوب «in progress» كما طلب المالك، وفي قسم الحالة «Telegram setup» ضمن غير
  المبني، مطابقًا لـ STATUS.
- لم أذكر عدد العمليات المنفّذة (201 من 259) لأن STATUS قاسه في ٢٠٢٦-٠٩-٢٢ وقد يتغيّر؛ أحلت
  إلى STATUS بدل رقم يتقادم.

## العقد
لا شيء.

## الملفات والتأثير
- `README.md` — إعادة كتابة كاملة بالإنجليزية.
- `docs/changes/2026-09-24-twuijri-readme-core-hub.md` — هذا السجل.

لا أثر على الشيفرة أو الصورة. كل رابط نسبي في README تحققت أنه يشير إلى ملف أو مجلد موجود.

## الفحوص
```
$ grep -ni majlis README.md
(لا مخرجات)

$ (فحص الروابط النسبية في README)
ok AGENTS.md
ok CONTRIBUTING.md
ok docs/adr/
ok docs/adr/0003-contract-first.md
ok docs/adr/0004-clean-room.md
ok docs/adr/0006-hermes-is-the-base.md
ok docs/adr/0007-clients-from-scratch.md
ok docs/adr/0010-one-credential-store.md
ok docs/adr/0011-first-run-setup.md
ok docs/adr/0014-workspaces-are-hermes-profiles.md
ok docs/ARCHITECTURE.md
ok docs/changes/
ok docs/clients/NAVIGATION.md
ok docs/contracts/
ok docs/DEPLOY.md
ok docs/DEVELOPMENT.md
ok docs/harness/validation.md
ok docs/inspirations/
ok docs/ROADMAP.md
ok docs/STATUS.md
ok docs/TEAM-RULES.md
ok LICENSE
ok packages/cli
ok packages/contracts
ok packages/server
ok packages/ui-tokens
ok packages/web
ok THIRD-PARTY-NOTICES.md
```

## المخاطر والرجوع
مستند فقط. الخطر الوحيد تعارض نصي مع PR إعادة التسمية إن لمس README أيضًا؛ الحل أخذ هذه
النسخة ثم تحديث أسطر الأوامر. الرجوع: `git revert` لهذا الـ commit.

## التسليم والخطوة التالية
PR إلى `main` للمراجعة. بعد دمج PR إعادة التسمية: مراجعة أسطر الأوامر في README، وإضافة الشعار
إن وافق المالك.
