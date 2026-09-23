# خريطة الكود بـ Graphify، مرفوعة في المستودع ومفحوصة في CI؛ وحذف Understand-Anything
المسؤول: twuijri · الفرع: chore/graphify-map · الحالة: review

## المشكلة والهدف
اقترح المالك (٢٠٢٦-٠٩-٢٣) Graphify بدل Understand-Anything، ثم قرّر: «ثبتها بس خله يرفعها على
قيت هوب علشان لو اي احد نزل المستودع يعطيه من شروط التطوير ان فيه خريطة graphify … علشان
يقدر يثبت المهاره عنده ويستفيد منها»، و«احذف كل شي سابق كان لي Understand-Anything علشان ما
يحوسنا».

لم تُبنَ خريطة Understand-Anything للمجلس قط (`.ua/` غير موجود): بناؤها يمرّ على نموذج وكلفته
عالية. Graphify يقرأ الكود بـ tree-sitter على الجهاز بلا نموذج؛ خريطة المستودع تُبنى في نحو خمس
ثوانٍ.

## القرار والموافقات
- **الخريطة مرفوعة** في `graphify-out/` (`graph.json`، `GRAPH_REPORT.md`، `graph.html`، أسماء
  المجتمعات) — وهذا ما توصي به وثائق Graphify للفرق. غير مرفوع: `cache/` و`manifest.json` (أوقات
  الملفات على جهاز واحد) والنسخ المؤرّخة.
- **المهارة داخل المستودع** لـ Claude (`.claude/skills/graphify` + hooks في `.claude/settings.json`)
  ولـ Codex (`.codex/skills/graphify`، و`AGENTS.md` قسم graphify). `CLAUDE.md` الجديد يستورد
  `AGENTS.md` فقط، فلا تتكرّر التعليمات.
- **شرط تطوير**: `uv tool install graphifyy==0.9.66` (الإصدار مثبّت لأن CI يبني به) ثم
  `pnpm graph` قبل كل commit فيه كود — في `CONTRIBUTING.md` و`docs/DEVELOPMENT.md` و
  `docs/harness/validation.md`.
- **`pnpm graph` (`scripts/graph.mjs`) بدل `graphify update .`** لثلاثة أسباب وُجدت بالتجربة:
  ١. Graphify يسمّي الاستيراد إلى ملف لم يمسحه (عميل العقد المولَّد، وهو في `.gitignore`) بالمسار
     **المطلق**: `home_twuijri_project_corehub_…` — أي اسم مجلد المطوّر داخل ملف مرفوع. السكربت
     يحوّله إلى الصيغة النسبية التي لكل العقد الأخرى.
  ٢. `graphify update .` يدمج في الخريطة الموجودة ويُبقي ما لم يستخرجه هذه المرّة، فتتكرّر تلك
     العقدة؛ السكربت يبني من الصفر.
  ٣. تقسيم المجتمعات يتبع ترتيب قراءة الملفات من نظام الملفات، ويختلف بين الأجهزة (تشغيلان في
     المجلد نفسه متطابقان بايتًا ببايت؛ مجلدان مختلفان لا). العقد والعلاقات متطابقة، فالسكربت
     يكتبها بترتيب ثابت.
- **فحص CI** (*Code map is current*): على رأس الـ PR نفسه، يثبّت Graphify بالإصدار المثبّت،
  يشغّل `scripts/graph.mjs` ثم `scripts/graph-check.mjs`: يقارن العقد والعلاقات بالمرفوع
  (بلا `built_at_commit` وبلا المجتمعات)، ويرفض خريطة فيها مسار من جهاز.
- **لا `graphify hook install`**: خطّافاته تشغّل `graphify update .` المجرّد بعد كل commit فتعيد
  المشكلتين ١ و٢.
- **حذف Understand-Anything**: `docs/harness/knowledge-graph.md` أُعيدت كتابته لـ Graphify، وسطر
  `.ua/` في `AGENTS.md` وصفّ الإصدار في `validation.md` استُبدلا. سجلّ التأسيس
  (`2026-09-21-twuijri-founding.md`) يبقى كما هو: هو تاريخ.

## العقد
لا تغيير.

## الملفات والتأثير
- جديد: `graphify-out/`، `.graphifyignore`، `.gitattributes`، `.claude/`، `.codex/`، `CLAUDE.md`،
  `scripts/graph.mjs`، `scripts/graph-check.mjs`.
- معدّل: `AGENTS.md`، `CONTRIBUTING.md`، `docs/DEVELOPMENT.md`، `docs/harness/knowledge-graph.md`،
  `docs/harness/validation.md`، `.gitignore`، `.prettierignore`، `package.json` (`graph`،
  `graph:check`)، `.github/workflows/ci.yml` (وظيفة `graph`).
- لا شيء في المنتج ولا في الصورة ولا في البناء.

## الفحوص
```
pnpm graph            → Rebuilt: 6227 nodes, 14903 edges (~5 s)
pnpm graph:check      → graph:check  OK — 6227 nodes, 14903 edges, current
نسخة نظيفة في مجلد آخر (كما في CI): graph:check  OK — 6227 nodes, 14903 edges, current
ثلاثة تشغيلات في المجلد نفسه (بالكاش وبدونه): graph.json وGRAPH_REPORT.md وgraph.html متطابقة
lint، prettier: نظيفة
```
- **الفحص يلتقط ما يجب**: قبل إصلاح المسار رفض الخريطة بـ
  `the committed map carries paths from the machine that built it`؛ وتعديل ملف كود بلا `pnpm graph`
  أسقطه بـ `the committed map is stale`.
- **سؤال حقيقي**: `graphify affected "expireLater"` → `.apply()` و`.expire()` في
  `sessions/engine.ts` وسجل التغيير الذي يذكرهما. الأسئلة الحرّة بالكلمات أكثر ضوضاء من أسئلة الرمز
  (`affected`، `explain`، `path`).

## المخاطر والرجوع
- كل PR فيه كود يغيّر `graph.json`، فالـ PRs المتزامنة تتعارض فيه بعد كل دمج؛ الحلّ دائمًا
  `pnpm graph` (والإصلاح التلقائي يفعله). وبناء الخريطة على جهاز آخر يغيّر أرقام المجتمعات في
  الفرق، لا العقد.
- `graph.json` نحو ٨ ميغابايت في المستودع؛ لا يدخل الصورة ولا المثبّت.
- الرجوع: الفرع وحده.

## التسليم والخطوة التالية
PR إلى `main`. الدمج للمالك. بعد الدمج: كل PR جديد يشغّل `pnpm graph` قبل الـ commit.
