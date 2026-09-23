# خريطة الكود يحدّثها بوت بعد الدمج بدل أن يحملها كل PR
المسؤول: twuijri · الفرع: ci/code-map-bot-pr · الحالة: review

## المشكلة والهدف
منذ `2026-09-23-twuijri-graphify-map.md` كان على كل PR أن يرفع `graphify-out/` مُعاد البناء
(`graph.json` و`graph.html` و`GRAPH_REPORT.md` وملفا الأسماء)، ووظيفة CI «Code map is current
(Graphify)» تُسقطه إن لم يفعل. لكن `graph.json` يتغيّر كلّه تقريبًا مع أي تغيير في الكود، فكل دمج
في `main` كان يجعل **كل** PR مفتوح آخر يتعارض — في `graphify-out/` وحده، لا في الكود.

الهدف: أن تبقى الخريطة مرفوعة في المستودع (من ينسخه يجدها)، دون أن يحملها أي PR، ولو تأخّرت
عن `main` بدمج أو اثنين.

## القرار والموافقات
قرار المالك (٢٠٢٦-٠٩-٢٣): «بعد الدمج في main: سير عمل في GitHub يفتح PR صغيراً اسمه «تحديث
خريطة الكود» فيه الخريطة الجديدة، وأنت تدمجه».

التصميم كما بُني:
- **لا خريطة في الـ PR.** حُذفت وظيفة «Code map is current» من `ci.yml`، وحلّت محلّها وظيفة رخيصة
  غير مطلوبة *PR leaves graphify-out/ to the code-map bot*: تُسقط أي PR يغيّر `graphify-out/`
  (قياسًا على قاعدة الـ PR بـ `base...head`) ما لم يكن فرعه `bot/code-map` من المستودع نفسه،
  وتطبع أمر الإصلاح. الوظائف الخمس المطلوبة في حماية `main` لم تُمسّ أسماؤها ولا وجودها
  (تحقّقت منها بـ `gh api …/required_status_checks`).
- **البوت** `.github/workflows/code-map.yml`: عند كل push إلى `main` (أو يدويًا)، ومع
  `concurrency` يُلغي الأقدم فتبقى آخر نسخة فقط: يثبّت Graphify بالإصدار نفسه (`graphifyy==0.9.66`)،
  يشغّل `scripts/graph.mjs` ثم `scripts/graph-check.mjs`. إن كانت خريطة `main` قديمة: يرفعها في
  commit ‏`chore(graph): update code map` (باسم twuijri) على فرع `bot/code-map` جديد من commit
  الـ push نفسه، يدفعه بـ force (هذا الفرع وحده)، ويفتح أو يحدّث PR واحدًا عنوانه
  «Update the code map». إن كانت حالية: يغلق PR البوت المفتوح إن وُجد. الصلاحيات:
  `contents: write` و`pull-requests: write` و`actions: write` فقط.
- **قيد GITHUB_TOKEN وحلّه.** ما يدفعه سير عمل أو يفتحه بـ `GITHUB_TOKEN` لا يُطلق أي سير عمل
  `pull_request` أو `push`، فلن تظهر الفحوص المطلوبة على commit البوت ولن يستطيع المالك الدمج
  (`enforce_admins` مفعّل). الاستثناء المسموح هو `workflow_dispatch`: أضفته إلى `ci.yml` و
  `change-record.yml`، والبوت يشغّلهما على `bot/code-map` بعد الدفع
  (`gh workflow run … --ref bot/code-map`)، فتُرفق check runs بالأسماء المطلوبة نفسها بـ commit
  البوت. وظائف `ci.yml` لا تقرأ `github.event.pull_request` إلا الوظيفة الجديدة، وهي تتخطّى نفسها
  خارج `pull_request`. و`change-record.yml` في التشغيل اليدوي يقارن بـ `origin/main`.
- **استثناء سجل التغيير ضيّق:** `scripts/check-change-record.mjs` يقبل مجموعة تغييرات كل ملفاتها
  تحت `graphify-out/` فقط — لا شيء غيرها — لأن PR البوت لا مهمة فيه تُسجَّل. أي ملف آخر معها يعيد
  الشرط كما كان.
- **الوثائق:** المساهم يشغّل `pnpm graph` محليًا لاستعلاماته ولا يرفع `graphify-out/`؛ بقي
  `pnpm graph` و`pnpm graph:check` (الثاني يستعمله البوت، ومفيد محليًا). رسائل `graph-check.mjs`
  صارت تشير إلى البوت بدل «ارفع الخريطة».
- لم يُمسّ: حماية الفرع، الإعدادات، الصور، الخوادم. لم يُشغَّل البوت على `main`.

## العقد
لا شيء.

## الملفات والتأثير
- جديد: `.github/workflows/code-map.yml`، وهذا السجل.
- معدّل: `.github/workflows/ci.yml` (‏`workflow_dispatch`، حذف وظيفة `graph`، وظيفة
  `map-untouched`)، `.github/workflows/change-record.yml` (‏`workflow_dispatch`، القاعدة
  `origin/main` عند غياب `base_ref`)، `scripts/check-change-record.mjs` (الاستثناء)،
  `scripts/graph-check.mjs` (التعليق والرسائل)، `docs/harness/knowledge-graph.md`، `AGENTS.md`،
  `CONTRIBUTING.md`، `docs/DEVELOPMENT.md`، `docs/harness/validation.md`، `.gitattributes` (تعليق).
- لا شيء في المنتج ولا الصورة ولا البناء.
- هذا الـ PR نفسه لا يغيّر `graphify-out/`.

## الفحوص
```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck        → exit=0 (كل الحزم)

# YAML الثلاثة تُقرأ، وأسماء الوظائف المطلوبة كما هي:
ci.yml triggers: ['push', 'pull_request', 'workflow_dispatch'] jobs: {'checks': 'Lint, typecheck, contracts, tests, build', 'web-e2e': 'Web smoke journeys (Playwright against the real hub)', 'map-untouched': 'PR leaves graphify-out/ to the code-map bot', 'migrations': 'db:generate + db:migrate (SQLite and PostgreSQL)', 'docker': 'Docker image builds and answers /health'}
change-record.yml triggers: ['pull_request', 'workflow_dispatch'] jobs: {'record': 'PR adds or updates a change record'}
code-map.yml triggers: ['push', 'workflow_dispatch'] jobs: {'update': 'Rebuild the code map and propose it'}
bash -n على سكربت خطوة فتح الـ PR → SYNTAX-OK

# الاستثناء، في worktree مؤقت من origin/main:
--- map only:
change-record  OK — only graphify-out/ changed (2 file(s)): the generated code map needs no record
exit=0
--- map + README:
change-record  FAILED: this change adds or updates no file under docs/changes/ (TEAM-RULES §2).
exit=1

# ما سيفعله البوت على main الحالي (نسخة نظيفة من origin/main): لا PR
graph:check  OK — 6290 nodes, 14986 edges, current

# على هذا الفرع (سكربتات تغيّرت): الخريطة متأخرة، وهذا متوقّع ولا يُسقط الـ PR بعد الآن
graph:check  the committed map is stale (committed: 6290 nodes, 14986 edges; this tree: 6290 nodes, 14993 edges).
             The code-map bot refreshes graphify-out/ after each merge into main; PRs do not carry it.

# بعد الـ commit على هذا الفرع:
$ pnpm change-record:check --base origin/main
change-record  OK — 1 record(s) valid
# منطق وظيفة map-untouched: git diff --name-only origin/main...HEAD -- graphify-out/
graphify-out/ is untouched.
```
`actionlint` غير مثبّت على الجهاز؛ حزمة npm المسمّاة `actionlint` نسخة wasm قديمة (٢٠٢٢) من
ناشر غير رسمي، فلم أشغّلها. لم تُشغَّل `pnpm test` ولا `pnpm build` ولا e2e: لا كود منتج تغيّر، وCI
يشغّلها على الـ PR.

## المخاطر والرجوع
- **إعداد مطلوب مرة واحدة:** `can_approve_pull_request_reviews` حاليًا `false`، فلن يستطيع
  `GITHUB_TOKEN` فتح PR حتى يفعّل المالك *Settings → Actions → General → Workflow permissions →
  Allow GitHub Actions to create and approve pull requests*. دون ذلك يدفع البوت الفرع ويفشل
  برسالة تذكر الإعداد. لم أغيّره: ليس من صلاحيتي.
- **الفحوص المُطلقة يدويًا:** check runs من `workflow_dispatch` يصدرها تطبيق GitHub Actions
  (‏app_id 15368، وهو نفسه في الفحوص المطلوبة) على commit رأس الفرع، فالمتوقّع أن تستوفي
  الشرط. لم يُثبَت هذا بعد إلا بأول تشغيل حقيقي بعد الدمج.
- **PRs المفتوحة التي فيها commits للخريطة** (#60 و#62 و#63 و#64، كلها تغيّر ٥ ملفات فيها) ستتعارض مرة
  أخيرة في `graphify-out/`، ثم ستُسقطها وظيفة `map-untouched`: الحل أخذ نسخة `main`
  (`git restore --source=origin/main --staged --worktree -- graphify-out`).
- الخريطة في `main` قد تتأخّر بدمج أو اثنين — مقبول بقرار المالك.
- كل دمج والخريطة قديمة يشغّل CI كاملًا مرة إضافية على `bot/code-map` (نحو ٢٠ دقيقة تشغيل).
- الرجوع: revert لهذا الـ PR يعيد الوظيفة القديمة؛ وإغلاق PR البوت وحذف `bot/code-map` كافيان
  لإيقاف أثره.

## التسليم والخطوة التالية
- PR إلى `main` للمراجعة؛ لا دمج ولا auto-merge ولا تشغيل للبوت مني.
- بعد الدمج على المالك: تفعيل إعداد «Allow GitHub Actions to create and approve pull requests»،
  ثم التحقّق في أول تشغيل لـ *Code map* أن PR «Update the code map» فُتح وأن الفحوص الخمسة
  المطلوبة ظهرت عليه خضراء وأن زر الدمج متاح. بعدها لا شيء غير دمج PRs البوت.
