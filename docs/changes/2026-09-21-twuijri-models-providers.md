# مخزن واحد للمزوّدين والمفاتيح: وحدة `models` والنشر إلى كل وكيل
المسؤول: twuijri · الفرع: feat/models-providers · الحالة: review

## المشكلة والهدف
طلب المالك في 2026-09-21، حرفيًا: يضيف المزوّد (مفتاح الواجهة) **مرة واحدة في مكان واحد**،
ويستفيد منه كل وكيل — Hermes وكل وكيل برمجة يثبّته لاحقًا. ولا يريد ضبط مزوّد لكل وكيل.

الحالة قبل هذه المهمة: وحدة `models` مجرّد هيكل بلا مسارات، و23 عملية تحت الوسم `models` في
العقد كلها 501، و`Agent.default_model` دائمًا `null`، و**ADR 0008 §4 يقرّر العكس**: المفاتيح
تبقى في بيت Hermes ولا تمرّ بقاعدة بيانات المركز أبدًا. ذلك القرار يصل Hermes ولا يصل أي وكيل
برمجة يشغّله المركز كعملية، فكان تثبيت Claude Code يعني «الآن ألصِق مفتاح Anthropic مرة أخرى،
في مكان آخر» — وهو ما رفضه المالك.

## القرار والموافقات
- **الغرفة النظيفة (ADR 0004)**: لم يُفتح أي ملف تحت `agent-studio/packages/*` ولا أي مصدر من
  Hermes Studio / Ekko Studio. ما قُرئ: وثائق هذا المستودع، ومصدر Hermes Agent (MIT) ووثائقه
  العامة — مسجَّلة بالروابط والمعرّفات الحرفية في `docs/inspirations/hermes-agent.md`
  §«مفاتيح المزوّدين واختيار النموذج». لم يُنسَخ أي كود.
- **ADR 0010 (جديد، يَنسَخ ADR 0008 §4 فقط)**: المركز يملك مخزن الاعتمادات، والنشر مسؤوليته
  لا مسؤولية المستخدم. بقية ADR 0008 (سطح `/v1/runs`، الابن المُشرَف عليه، الصورة،
  `agents.restart`) قائمة ويعتمد عليها هذا القرار. لم يُعدَّل ملف 0008 لأن
  `docs/adr/README.md` يمنع تعديل ADR بعد قبوله.
- **«عائلة الاعتماد»**: العقد يعطي المزوّد نوعًا واحدًا (`llm|stt|tts`)، فصار OpenAI ثلاثة صفوف
  ومفتاحًا واحدًا. الصفوف التي تتشارك `family` تتشارك صف `secrets` نفسه — وهذه هي الصيغة
  الميكانيكية لـ«أضفه مرة واحدة».
- **لا تخمين لاسم مزوّد عند Hermes**: عند Hermes `openai` مرادف لـ**OpenRouter**، و OpenAI
  المباشر `openai-api`، وGoogle `gemini`، و Groq و Mistral مفتاحا **صوت** لا مزوّدَي محادثة.
  كل مدخلة في فهرسنا تعلن `hermesProvider` أو `null`؛ وعند `null` لا يُكتب أي اختيار نموذج
  ويُسجَّل السبب، بدل كتابة اسم يوجّه التشغيل إلى حساب آخر.
- **الاتجاه**: `models` يعتمد على `agents` (يحتاج بيت Hermes)؛ و`agents` **لا** يعتمد على
  `models` بل يعلن منفذًا `AgentModelsPort` يسجّله `models` عند الإقلاع.
- لم يُدفع الفرع، ولم يُفتح PR، ولم يُنشر شيء.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
**لا شيء.** العمليات الـ23 تحت الوسم `models` كانت معلنة أصلًا؛ هذه المهمة نفّذت 19 منها كما
هي، وأبقت 4 عمليات 501 بسبب مكتوب (أدناه). صفوف قاعدة البيانات صِيغت على مفردات العقد نفسها
(`ProviderKind`, `ModelKind`, `ModelCapability`, `Provider.api_mode`, `Visibility.mode`) فلا
جدول ترجمة بين الجدول والواجهة.

## الملفات والتأثير
**`packages/server/src/modules/models/`** (جديدة كاملةً عدا `schema.ts`)
- `schema.ts` — إعادة صياغة: `providers` (slug، عائلة الاعتماد، `api_mode`، الظهور، حالة
  الفهرس)، `models` (alias، visible، preview)، `model_defaults` (chat + الأدوار المساعدة)،
  وجديدان: `ensembles` و`speech_settings`.
- `crypto.ts` — حلقة مفاتيح بإصدارات في `${DATA_DIR}/keys/data.key` (0600)، AES-256-GCM
  بـnonce لكل ختم، التدوير إضافي (`rotate` ← `reseal` ← `forget`)، والقناع `[stored]`.
- `secrets.ts` — مخزن الأسرار فوق الجدول: `put/reveal/has/summary/wipe/rotate`.
- `catalogue.ts` — الفهرس المُدمج: 12 مزوّدًا، ولكل واحد عائلته واسم متغيّره وأسماء Hermes
  ومعرّف Hermes (أو `null`). **لا يُزرع أي معرّف نموذج**: القائمة دائمًا ما أجاب به المزوّد.
- `adapters/` — `anthropic` و`openai` (وكل ما نسخ شكلها) و`google` و`ollama` و`elevenlabs`،
  لكلٍّ فحص اتصال حقيقي وقائمة نماذج حقيقية، و`fetch` محقون دائمًا.
- `dotenv.ts` — قارئ/دامج `.env` غير متلف، باقتباس مطابق لكاتب Hermes نفسه.
- `propagation.ts` — بناء بيئة العملية للوكلاء، وكتابة `.env` و`config.yaml` في بيت Hermes
  كتابةً ذرّية (ملف مؤقّت + إعادة تسمية، 0600) مع دورة YAML تحفظ التعليقات والمفاتيح الشقيقة.
- `store.ts` / `service.ts` / `serialize.ts` / `defaults.ts` / `index.ts` — الزرع الكسول،
  العمليات، التحويل إلى أشكال العقد، والأدوار المساعدة، والمسارات.
- اختبارات: `crypto.test.ts` (14)، `adapters/adapters.test.ts` (20)،
  `propagation.test.ts` (19)، `models-api.test.ts` (21 + 1 مسوَّر).

**`packages/server/src/modules/agents/`**
- `catalog/types.ts` + كل مدخلة — حقل `credentials`: عائلة الاعتماد ← المتغيّر الذي يقرؤه هذا
  الوكيل. سطر واحد لكل وكيل، نصونه نحن لا المستخدم. و`index.ts` يحرس صحته.
- `ports.ts` — `AgentModelsPort`. `index.ts` — تسجيل المنفذ **لكل تطبيق** (WeakMap على
  Socket.IO، لا متغيّر عام) و`agentDirectory` يعيد النموذج الموروث.
- `service.ts` — `environmentFor` و`defaultModelOf` و`loadAgentBySlug`، و`targetFor` صار يدمج
  الاعتمادات المشتركة. `serialize.ts` — `Agent.default_model` لم يعد `null` دائمًا.

**`packages/server/src/lib/route.ts`** — المعالج يستلم `reply` أيضًا، لعملية واحدة جسمها ليس
JSON (`models.synthesize` يعيد بايتات صوت). كل معالج آخر يتجاهل الوسيط الثالث.

**`packages/server/drizzle/0001_zippy_sir_ram.sql`** — هجرة جديدة. `providers` و`models` و
`model_defaults` تُعاد إنشاؤها لا تُعدَّل: أُعلنت في 0000 ولم يُكتب فيها صف قط (الوحدة كانت بلا
مسارات)، ونسخ الأعمدة كان سيسمّي أعمدة لم توجد. التعليق في أعلى الملف يقول ذلك.

**`packages/web/src/models/`** — `ModelsScreen.tsx` و`queries.ts` بدل الشاشة النائبة، مع
`navigation/routes.tsx` و`types.ts` والترجمات، واختبار `tests/models-screen.test.tsx` (7).

**`packages/cli/src/commands/models.ts`** — `providers list|add|test|remove` و
`models list|default`، مع `main.ts` و`types.ts` والترجمات، واختبار تكامل جديد.

**الوثائق** — `docs/adr/0010-one-credential-store.md`،
`docs/inspirations/hermes-agent.md` (قسم جديد بالمعرّفات الحرفية والروابط)،
`docs/domain/models.md` (أُعيدت كتابته ليطابق المنفَّذ)، `docs/domain/agents.md`.

## ما بقي 501، ولماذا
| العملية | السبب |
|---|---|
| `models.startProviderSignIn` · `getProviderSignIn` · `completeProviderSignIn` | لا مزوّد في الفهرس المُدمج يستوثق بـOAuth device code؛ كلهم مفتاح واجهة. إعادة `201` بـ`verification_url` مخترَع كذبة يعرضها العميل. تصل مع أول مزوّد OAuth. |
| `models.transcribe` | الصوت يصل `multipart/form-data` والخادم بلا قارئ multipart (محلّل جسم واحد عمدًا). إضافته تغيير مستقل؛ حتى ذلك تقول العملية ذلك بدل إرجاع نص فارغ. |

الأربع مسجَّلة كمسارات صريحة لا كـstub عام في `app/routes.ts`، فيصل العميل **سببها** لا
«غير منفَّذة بعد» فقط، ويتحقّق اختباران من نصّ السبب.

## الفحوص (الأوامر ونواتجها الفعلية)

```
$ pnpm typecheck
(لا أخطاء؛ يبني contracts وui-tokens ثم tsc --noEmit لكل حزمة)

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm test
 Test Files  3 passed (3)            contracts
      Tests  11 passed (11)
 Test Files  1 passed (1)            ui-tokens
      Tests  89 passed (89)
 Test Files  10 passed (10)          cli
      Tests  56 passed (56)
 Test Files  35 passed | 1 skipped (36)   server
      Tests  267 passed | 2 skipped (269)
 Test Files  9 passed (9)            web
      Tests  82 passed (82)

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  247 passed (247)

$ pnpm contracts:lint
openapi.yaml: validated in 415ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ pnpm contracts:check-clients
check-clients  OK — 96 client file(s) scanned, 161 contract path(s) known.

$ pnpm nav:check
nav:check  OK — 35 destinations, 37 terms, ar/en complete, routes for web

$ pnpm i18n:check
i18n:check  server: 93 keys, ar/en in parity
i18n:check  cli: 199 keys, ar/en in parity
i18n:check  web: 251 keys, ar/en in parity
i18n:check  desktop: apps/desktop/src/i18n not present yet — skipped
i18n:check  OK

$ pnpm db:generate
(drizzle-kit generate ← drizzle/0001_zippy_sir_ram.sql؛ احتاج طرفية لسؤال إعادة التسمية،
 شُغِّل تحت pty، ثم حُرِّر يدويًا ليكون drop+create كما شُرح أعلاه)

$ rm -rf /tmp/majlis-dbtest && DATA_DIR=/tmp/majlis-dbtest pnpm db:migrate
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}
(تحقّق: الجداول ensembles, model_defaults, models, providers, secrets, speech_settings
 وأعمدة providers الـ27 موجودة)

$ pnpm build
✓ built in 542ms   (web)؛ وبقية الحزم بلا أخطاء

$ node packages/cli/dist/bin.js --help
  providers list    List the workspace's model providers and whether each has a key.
  providers add     Store a provider's API key (asked for, never given as an argument).
  providers test    Ask the provider whether the stored key works.
  providers remove  Clear a provider's key, or remove a custom provider.
  models list       List the models the providers reported.
  models default    Show the workspace's default models, or set one.

$ pnpm web:e2e
  ✓  1 [chromium] › login → new session → streamed markdown reply … (2.1s)
  ✓  2 [chromium] › an approval card answers once / session / always / deny … (706ms)
  ✓  3 [chromium] › a socket drop mid-run resumes with after_seq … (3.2s)
  3 passed (9.6s)
```

الحزمة `@majlis/server` شُغِّلت ثلاث مرات متتالية بعد إصلاح المنفذ العام، وأعطت النتيجة نفسها
في كل مرة (كان هناك تعارض حقيقي بين مركزين في عملية اختبار واحدة، وهو ما أصلحه الالتزام
`fix(agents): key the models port to the app`).

## المخاطر والرجوع
- **إعادة تشغيل Hermes عند تغيير مزوّد**: مقصودة وظاهرة (بطاقة الوكيل تصير `starting`)
  ومسجَّلة في التدقيق `agent.reconfigured`. لو أزعجت المالك، الرجوع سطر واحد في
  `ModelsService.propagate`.
- **مفتاح البيانات**: فقدان `${DATA_DIR}/keys/data.key` يفقد كل المفاتيح المخزَّنة. الصفوف
  تبقى وتُقرأ «كان هنا سر». يجب أن يشمله أي نسخ احتياطي — وهذا يحتاج سطرًا في `docs/DEPLOY.md`
  عند كتابته.
- **الكتابة في بيت Hermes**: ذرّية (ملف مؤقّت + إعادة تسمية)، ولا تمسّ إلا المتغيّرات التي
  نملكها، وترفض إعادة كتابة `config.yaml` غير قابل للتحليل. لكن لا يوجد قفل ملفات **بين**
  العمليات في Hermes نفسه (موثّق في `docs/inspirations/hermes-agent.md` §ط): آخر كاتب ذرّي
  يفوز. لو حرّر المالك الملف يدويًا في اللحظة نفسها، قد يضيع تحريره.
- **الهجرة 0001 تُسقط ثلاثة جداول**: آمنة لأنها فارغة بالبرهان (لا كود كتب فيها). لو كان لدى
  المالك قاعدة بيانات فيها صفوف في `providers` — ولا يوجد — فستضيع. الرجوع: العودة إلى
  الالتزام السابق وإسقاط `drizzle/0001_*`.
- **مفاتيح المالك الحقيقية غير مستخدمة**: لم يُطلب أي مفتاح ولم يُقرأ أي مفتاح من أي مكان.

## ما يحتاج مفاتيح المالك الحقيقية للتحقّق
كل شيء أعلاه يمرّ بـ`fetch` مكتوب بالسيناريو. ما لا يمكن إثباته بلا مفتاح حقيقي:
1. أن أشكال ردود المزوّدين كما افترضناها اليوم (قوائم النماذج، رسائل الخطأ، أسعار OpenRouter).
2. أن Hermes يلتقط فعلًا المفتاح والنموذج بعد إعادة تشغيل البوّابة على جهاز فيه Hermes.
3. `models.synthesize` مع مزوّد صوت حقيقي.

لذلك يوجد اختبار مسوَّر يتخطّى نفسه بصراحة:
`MAJLIS_LIVE_PROVIDER=anthropic MAJLIS_LIVE_PROVIDER_KEY=… pnpm --filter @majlis/server test`
— يضبط المفتاح عبر الواجهة، يشغّل `testProvider` الحقيقي، وينتظر أن تصل قائمة نماذج غير
فارغة. بدون المتغيّرين يظهر `1 skipped` كما في الناتج أعلاه.

## التسليم والخطوة التالية
- الفرع `feat/models-providers` من `origin/chore/rename-board-to-tasks` (PR #10، وهو نفسه فوق
  `feat/web-shell`/PR #9). **لم يُدفَع ولم يُفتح PR** — بانتظار المالك.
- الخطوة التالية بعد موافقته: دفع الفرع، PR بالإنجليزية إلى `main`، ثم — إن أراد — تشغيل
  الاختبار المسوَّر بمفتاح حقيقي واحد للتأكّد من أشكال ردود المزوّد.
- متروك عن قصد: تبويب «الفِرَق» في الويب (العمليات منفَّذة، الشاشة تصل مع شاشات الغرف)،
  و`models.transcribe`، وسجلّ OAuth للمزوّدين.

## تحديث لاحق (المنسّق، 2026-09-22)
أُعيد تركيب الفرع فوق `main` بعد دمج طلبات الويب والتسمية ووثائق الالتحاق؛ التعارض الوحيد كان
لقطات رحلات المتصفح (ملفات ثنائية) وأُخذت نسخة هذا الفرع لأنها تعكس الشاشات بعد وصول «النماذج».
أُعيد تشغيل كل الفحوص على الشجرة المُركَّبة، ومرّتين متتاليتين للتأكد من عدم وجود تذبذب:
الوحدات 11 + 89 + 56 + 267 (وتخطّيان مقصودان) + 82 في المرّتين، والعقد 247، والترحيل على قاعدة
جديدة ثم `db:generate` يقول «لا تغييرات».
