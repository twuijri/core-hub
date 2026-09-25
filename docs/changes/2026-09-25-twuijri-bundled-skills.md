# مكتبة مهارات Core Hub: مهارات جاهزة في كل بروفايل، ومنها مهارات للصور
المسؤول: twuijri · الفرع: feat/bundled-skills · الحالة: review

## المشكلة والهدف
قال المالك (2026-09-25): «اهم المهارات الرئيسية ولزم يكون فيه شي خاص بالصور». أي مكتبة مهارات جاهزة من
أول يوم، فيها أهم المهارات الأساسية، ولا بد أن يكون فيها شيء للصور.

ما وجدته قبل الكتابة: هرمز (الوسم المثبّت `v2026.9.14`) يشحن 58 مهارة مدمجة في تصنيفات (#91)، و147 في
`optional-skills`. فيها `pdf` و`docx` و`xlsx` و`powerpoint` و`grounded-citations` و`humanizer`
و`document-to-action-items` و`blocked-page-recovery`، **ولا شيء للصور** (أدوات هرمز `image_generate`
و`vision_analyze` موجودة، لكن لا مهارة تقود النموذج إليها ولا بديل إن لم يُضبط مزوّد صور)، ولا ترجمة، ولا
كتابة تقارير عربية بضبط الاتجاه، ولا عروض HTML، ولا جدولة بلغة طبيعية. المكتبة تملأ هذه الفجوات وتحيل
إلى مهارات هرمز حيث تكفي (استخراج PDF/Word، دفتر الاستشهادات، الصفحات المحجوبة) ولا تكرّرها.

## القرار والموافقات
**المهارات الاثنتا عشرة** (كلها كتابتي، Apache-2.0 جزءًا من Core Hub، لم يُنسخ نص من أي مشروع؛ قرأت مصدر
هرمز MIT لأعرف أسماء أدواته وقواعده فقط)، في `packages/server/skill-library/`:

| المهارة | ما تفعله | ما تعتمد عليه |
|---|---|---|
| `image-generate` | توليد صورة من وصف بأي لغة | أداة هرمز `image_generate`، وإلا `scripts/image_api.py` (OpenAI Images، Gemini/Imagen، أي واجهة متوافقة مع OpenAI) |
| `image-edit` | تعديل صورة بتعليمات، أو نسخ متنوعة منها | `image_generate` مع `image_url`، وإلا السكربت نفسه (`edit`، `vary`، قناع) |
| `image-describe` | وصف صورة واستخراج نصها (OCR) بالعربية والإنجليزية | `vision_analyze`، و`scripts/ocr_prep.py` (Pillow) يعدل الاتجاه ويقص ويكبّر ويقطّع الطويل |
| `image-convert` | تحجيم، قص بنسبة، حشو، تحويل صيغة، ضغط تحت حجم، تدوير، حذف البيانات الوصفية، ورقة صور، خلفية سادة ← شفافة | `scripts/image_tools.py` (Pillow الموجود في venv هرمز) |
| `summarize` | تلخيص ملف أو رابط أو نص طويل دون إسقاط وسطه | `web_extract`/`read_file`، و`scripts/chunk.py` |
| `report-writer` | تقرير أو مذكرة أو خطاب بالعربية/الإنجليزية بضبط RTL | قوالب، و`scripts/rtl_md.py` (يفحص ويصلح: علامة RLM، «،؛؟») |
| `data-to-chart` | CSV/Excel ← جدول Markdown وإحصاءات ورسم SVG | `scripts/table_chart.py` (مكتبة بايثون القياسية فقط، يقرأ xlsx مباشرة، أرقام هندية، cp1256) |
| `research-brief` | بحث في الويب بمصادر مرقّمة وتحقق من مصدرين | `web_search`/`web_extract`، ومهارتا هرمز `grounded-citations` و`blocked-page-recovery` |
| `translate` | ترجمة عربي ↔ إنجليزي مع حفظ التنسيق | `scripts/translate_check.py` يكشف ما ضاع (عناوين، قوائم، جداول، شيفرة، روابط، متغيرات، أرقام) |
| `slides-html` | عرض شرائح HTML واحد من Markdown، يفتح في معاينة الملفات (#106) | `scripts/make_slides.py` (بلا طلبات خارجية، يضمّن الصور، اتجاه لكل شريحة، ملاحظات المتحدث، طباعة) |
| `schedule-helper` | طلب بكلام عادي ← جدولة في Core Hub | أدوات الهب `mcp__corehub__schedules_*` (#134) إن وُجدت، وإلا الخطوات حقلًا حقلًا |
| `proofread` | تدقيق إملائي ونحوي وأسلوبي بالعربية والإنجليزية | `references/arabic-checklist.md` |

**إزالة الخلفية:** لا توجد تبعية صغيرة لها في الصورة (`rembg` و`onnxruntime` غير موجودتين ونموذجها
~170 م.ب)، فلم أبنِ فصل عنصر عن صورة فوتوغرافية. بنيت فقط «خلفية سادة ← شفافة» بـPillow (تعبئة من
الحواف)، وهي تقول بوضوح حين لا تكون الخلفية سادة، والمهارة تقترح `image-edit` ثم هذه الخطوة.

**وصف كل مهارة** جملة إنجليزية ≤ 60 حرفًا تنتهي بنقطة، لأن هرمز يقصّ ما زاد في قائمة المهارات التي يراها
النموذج (`agent/skill_utils.py` §SKILL_PROMPT_DESC_LIMIT). العربية في الوسوم (`metadata.hermes.tags`)
وفي متن كل مهارة (سطر عربي، وعبارات الطلب بالعربية في «When to Use»).

**التثبيت (DECISIONS §60):**
- في فئة `skills/core-hub/<skill>/` في كل بروفايل؛ هرمز يسردها بفئتها (`hermes skills list`: المصدر `local`).
- **متى:** عند كل إقلاع لكل بروفايل (`default` وكل مسمّى)، وفور إنشاء بروفايل أو نسخه أو استيراده عبر الهب
  — **حين يشغّل الهب هرمز بنفسه** (`managed`، وهو الحال في الصورة). مع بوابة هرمز خارجية لا يكتب الهب في منزلها
  من تلقاء نفسه؛ بطاقة المكتبة في صفحة المهارات تعرض «تثبيت».
- **لا يُحدَّث إلا ما كتبه الهب:** بيان `skills/.core-hub-library.json` فيه SHA-256 لكل ملف كتبه. الملف المطابق
  للبيان يُستبدل بالنسخة الجديدة؛ المختلف ملك الشخص، والمهارة `edited` ولا تُمس حتى «استعادة». المهارة التي
  يحذفها الشخص تُذكر ولا تعود. مجلد بالاسم نفسه لم يكتبه الهب لا يُمس (تعارض).
- **مفتاح لكل بروفايل، مفعّل افتراضيًا**، محفوظ في البيان نفسه داخل البروفايل (يسافر مع النسخ والتصدير).
  الإيقاف يحذف غير المعدّل ويترك المعدّل للشخص بلا شارة؛ التشغيل يثبّت المكتبة كلها من جديد.
- صفحة المهارات: بطاقة «مكتبة Core Hub» (العدد، المعدّلة، «تثبيت»، المفتاح بتأكيد)، وشارة «مكتبة Core Hub»
  على كل مهارة منها، وشارة «معدّلة» وزر «استعادة» بتأكيد للمعدّلة. مهارة المكتبة تُفتح وتُحرَّر وتُطفأ وتُحذف
  كغيرها.

**اكتشاف أثناء الفحص الحقيقي وإصلاحه:** طرفية هرمز تشغّل غلاف دخول (login shell)، وملف `/etc/profile` في
Debian يعيد ضبط PATH لغير الجذر فيسقط `/opt/hermes/.venv/bin`، فكان `python3` «command not found» داخل
الصورة — لكل مهارة بسكربت، ومنها مهارات هرمز نفسها (`xlsx`، `pdf`، `docx`…). أضفت إلى الصورة غلافًا
`/usr/local/bin/python3` (و`python`) ينفّذ بايثون venv هرمز، فيعمل Pillow، ويبقى venv للقراءة فقط.

**مفاتيح الصور:** هرمز يخفي مفاتيح مزوّديه (`OPENAI_API_KEY`، `GOOGLE_API_KEY`…) عن الطرفية عمدًا ويرفض أن
تمرّرها مهارة (GHSA-rhgp-j443-p4rf). لذلك تفضّل مهارتا الصور أداة هرمز `image_generate` (تعمل في عمليته
الرئيسية بمزوّد الصور المضبوط)، والسكربت يقرأ `COREHUB_IMAGE_API_KEY` (و`_BASE_URL`، `_MODEL`، `_PROVIDER`)
المعلنة في `required_environment_variables` اختيارية، فيمرّرها هرمز حين توجد في `.env` البروفايل. لا مفتاح
مكتوب في أي ملف، والسكربت لا يطبع المفتاح أبدًا.

قرارات **مقترحة — للمالك أن يؤكّد**: قائمة المهارات الاثنتي عشرة وأسماؤها؛ الوصف الإنجليزي القصير (قد يريد
المالك وصفًا عربيًا يظهر في الواجهة العربية — حقل إضافي لاحقًا)؛ إزالة الخلفية مقتصرة على السادة؛
`COREHUB_IMAGE_API_KEY` مسارًا بديلًا للمفتاح (أو أن يكتبه الهب تلقائيًا من مزوّد مشترك في خطوة لاحقة)؛
التثبيت التلقائي فقط حين يشغّل الهب هرمز؛ المفتاح في صفحة المهارات لا في الإعدادات؛ غلاف `python3` في الصورة.

**ترقيم:** DECISIONS §60 ورحلة e2e رقم 31 أخذتهما لأن §55–§59 محجوزة في طلبات مفتوحة (#131، #133، #135،
#134/#136، #140). طلب الدمج التجميعي الجاري قد يحتاج إعادة ترقيم لهما.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `SkillSource`: قيمة جديدة `library`. `Skill.library`: `current` | `edited` | `null` (اختياري).
- `agents.listSkills`: الجواب يحمل `library` (`SkillLibrary`: `enabled`، `available`، `installed`، `edited`) ووصف الفئة.
- جديد: `agents.updateSkillLibrary` (`PATCH /agents/{agent_id}/skill-library`، `SkillLibraryPatch {enabled}`،
  للمديرين) و`agents.restoreSkill` (`POST /agents/{agent_id}/skills/{skill_key}/restore`، للمديرين، `409` بسبب
  `skill_not_library` أو `skill_library_off`).
- `docs/contracts/DECISIONS.md` §60. العدد: 266 عملية (كانت 264)، 208 منفّذة.

## الملفات والتأثير
- المكتبة: `packages/server/skill-library/` (12 مجلد مهارة + `DESCRIPTION.md`؛ 9 سكربتات بايثون، قوالب، مرجع).
- الخادم: `modules/agents/skill-library.ts` (قراءة المكتبة، البذر بالبيان، الحالة، المفتاح، الاستعادة)،
  `modules/agents/index.ts` (البذر عند الإقلاع في وضع `managed`، `source: library` و`library` في المهارة، ملخص
  المكتبة، المساران الجديدان)، `modules/index.ts` (بذر البروفايل الجديد).
- الصورة: `packages/server/Dockerfile` (نسخ `skill-library`، غلاف `python3`)، `.dockerignore` (استثناء المكتبة من `*.md`).
- الويب: `agents/AgentSkillsScreen.tsx` (البطاقة، الشارتان، «استعادة»)، `agents/skills.ts` (الأنواع والخطافان)،
  `agents/toolErrors.ts` (السببان)، `i18n/{ar,en}.json` (`skills.library.*`).
- الاختبارات: `skill-library.test.ts` (15)، `skill-library.lint.test.ts` (27)، `skill-library.routes.test.ts` (6)،
  `tests/unit/skill-library.real.test.ts` (2، بصورة)، `web/tests/skill-library.test.tsx` (3)،
  `web/e2e/zzzz-skill-library.spec.ts` (الرحلة 31)، لقطتان: `agent-skills-ar-light.png` (تغيّرت: البطاقة)
  و`agent-skills-library-ar-light.png` (جديدة).
- الوثائق: `docs/STATUS.md` (208 من 266، سطر agents)، `docs/contracts/DECISIONS.md` §60.

## الفحوص (الأوامر ونواتجها الفعلية)
كل الأوامر عبر `mj-run`، محليًا ما يمسّه التغيير فقط.

الفحص الحقيقي بهرمز من صورة هذا الفرع (`docker build -f packages/server/Dockerfile -t core-hub:skills .`):
```
$ COREHUB_HERMES_IMAGE=core-hub:skills pnpm exec vitest run --project unit tests/unit/skill-library.real.test.ts --silent=false --reporter=verbose
default: hermes skills list shows 12 in core-hub
work: hermes skills list shows 12 in core-hub
 ✓ … Hermes lists every library skill in the core-hub category, in default and in a profile it made 1117ms
hermes answered:  | session_id: 20260925_103153_97622e | Done: {"output": "{\"ok\": true, \"command\": \"generate\", \"provider\": \"compatible\", \"model\": \"gpt-image-1\", \"files\": [\"images/a-red-fox-in-flat-style-20260925-103155-1.png\"], \"note\": null}",
tools offered to the model: skill_manage, skill_view, skills_list, terminal, tool_call, tool_describe, tool_search
 ✓ … runs image-generate end to end in a Hermes turn, against a scripted image endpoint 3260ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```
ما يثبته: هرمز الحقيقي أنشأ البروفايل `work` بمهاراته، وبذر الهب مكتبته فيه وفي `default`، و`hermes skills
list` سرد الاثنتي عشرة في فئة `core-hub` بجانب مهارات هرمز. ثم دورة هرمز حقيقية (`hermes -p work chat -q
"ارسم لي ثعلبًا أحمر"`) بنموذج مُبرمج: `skill_view("image-generate")` أعاد مجلد المهارة، و`terminal` شغّل
سكربتها، فوصل الطلب إلى نقطة صور مُبرمجة بـ`Authorization: Bearer <COREHUB_IMAGE_API_KEY من .env البروفايل>`
ونزلت صورة PNG في مجلد العمل، والمفتاح لم يظهر في أي ناتج رآه النموذج.

الاختبار نفسه على الصورة السابقة `core-hub:morechannels` (قبل غلاف `python3`) فشل هكذا — وهو سبب الإصلاح:
```
script output: {"output": "/usr/bin/bash: line 5: python3: command not found", "exit_code": 127, …}
 × … runs image-generate end to end in a Hermes turn … → expected [] to have a length of 1 but got +0
```
والصورة نفسها أقلعت بمجلد بيانات فارغ في حاوية بلا منافذ على المضيف (وضع `managed`) وبذرت المكتبة وحدها:
```
{"mode":"managed","endpoint":"http://127.0.0.1:8642","msg":"agents: hermes runtime"}
{"profile":"default","installed":["data-to-chart","image-convert","image-describe","image-edit","image-generate","proofread","report-writer","research-brief","schedule-helper","slides-html","summarize","translate"],"updated":[],"edited":[],"conflicts":[],"msg":"agents: Core Hub skill library seeded"}
```
(أُزيلت الحاوية والمجلد بعدها.)

بقية الفحوص:
```
$ pnpm exec vitest run --project unit src/modules/agents/skill-library.test.ts
 Test Files  1 passed (1)
      Tests  15 passed (15)
$ pnpm exec vitest run --project unit src/modules/agents/skill-library.lint.test.ts
 Test Files  1 passed (1)
      Tests  27 passed (27)
$ pnpm exec vitest run --project unit src/modules/agents/skill-library.routes.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
$ pnpm exec vitest run --project unit src/modules/agents/skills.test.ts src/modules/agents/agent-tools.routes.test.ts src/modules/agents/agents.test.ts tests/unit/status.test.ts
 Test Files  4 passed (4)        # بعد تحديث STATUS؛ قبله فشل status.test بـ«expected 264 to be 266» كما يجب
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  276 passed (276)
$ pnpm --filter @corehub/web exec vitest run tests/skill-library.test.tsx tests/agent-jobs-plugins.test.tsx
 Test Files  2 passed (2)
      Tests  10 passed (10)
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/smoke.spec.ts e2e/zzzz-skill-library.spec.ts -g "skills are the files|skill library" --workers=1
  ✓  1 … 15. an agent’s skills are the files in its folder (1.6s)
  ✓  2 … 31. Core Hub’s skill library: installed, badged, an edit restored, switched off (1.1s)
  2 passed (8.9s)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck                      # exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 285 client file(s) scanned, 178 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm build                          # exit 0
```
الاختبارات الجديدة تفشل على `main`: الوحدة `skill-library.ts` والمساران وحقل `library` غير موجودة فيه.
لقطات الرحلة 15 غير المرتبطة (القنوات، MCP، الذاكرة) أُرجعت.

CI على طلب الدمج #142 (الالتزام `bf1b70b`، التشغيلان 36124932526 و36124932538) — كله أخضر:
```
Docker image builds and answers /health	pass	2m54s
Lint, typecheck, contracts, tests, build	pass	18m15s
PR adds or updates a change record	pass	12s
PR leaves graphify-out/ to the code-map bot	pass	7s
Web smoke journeys (Playwright against the real hub)	pass	5m27s
db:generate + db:migrate (SQLite and PostgreSQL)	pass	56s
```

## المخاطر والرجوع
- **الكتابة في منزل هرمز:** البذر لا يكتب إلا داخل `skills/core-hub/` وملف البيان، ولا يستبدل إلا ملفًا بصمته
  هي ما كتبه الهب؛ مفتاح بيان يشير خارج المجلد يُهمل. فشل بذر بروفايل يُسجَّل ولا يوقف الإقلاع ولا البقية.
- **مهارة تدفع النموذج لتشغيل سكربت:** السكربتات لا تصل إلا إلى نقطة الصور التي يسمّيها المتغير، ولا تكتب
  فوق الأصل أبدًا، وتطبع JSON فقط، ولا تطبع مفتاحًا.
- **غلاف `python3`:** يغيّر ما تجده الطرفية في PATH الدخول: كانت بلا بايثون، الآن بايثون venv هرمز
  (للقراءة فقط للمستخدم `hub`؛ `pip install` داخلها يفشل كما كان سيفشل).
- **الرجوع:** إرجاع الطلب يعيد السلوك السابق؛ الملفات التي بذرها الهب تبقى في البروفايلات مهارات عادية
  (يحذفها الشخص من الصفحة، أو يطفئ المكتبة قبل الإرجاع فتُحذف غير المعدّلة).

## التسليم والخطوة التالية
- للمالك: تأكيد القرارات المقترحة أعلاه، وخاصة قائمة المهارات، ومسار مفتاح الصور البديل، وهل يريد وصفًا
  عربيًا لكل مهارة في الواجهة.
- لاحقًا: أن يكتب الهب `COREHUB_IMAGE_*` في `.env` البروفايل من مزوّد مشترك يدعم الصور (ADR 0010)، فيعمل
  المسار البديل بلا خطوة يدوية؛ وضبط `image_gen.provider` في هرمز من الواجهة.
- إعادة ترقيم §60 والرحلة 31 إن احتاج الدمج التجميعي.
