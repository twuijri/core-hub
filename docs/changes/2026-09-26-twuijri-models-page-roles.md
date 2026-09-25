# صفحة النماذج: الصوت في تبويباته، وتبويب «الصور» يختار نموذج الصور من مزوّدي المحادثة
المسؤول: twuijri · الفرع: feat/models-page-roles · الحالة: review

## المشكلة والهدف
قرارات المالك (2026-09-25) لصفحة النماذج:

1. «موديلات تحويل النص لصوت والصوت لنص تنتقل لتبويباتها ما نخليها هنا». تبويب «المزوّدون» كان يعرض كل
   المزوّدين ومعه مرشّح «عرض» فيه «تحويل الكلام إلى نص» و«تحويل النص إلى كلام»، وزر «إضافة مزوّد» لا يظهر
   إلا فيه. المطلوب: «المزوّدون» لمزوّدي المحادثة فقط، ومزوّدو الصوت يُعرضون ويُضافون ويُعدّلون ويُحذفون في
   تبويبَي الصوت، دون فقد أي مزوّد محفوظ.
2. تبويب جديد «الصور»: لا مزوّدو صور منفصلون؛ يختار التبويب مزوّدًا ونموذج صور من **مزوّدي المحادثة
   الموجودين** الذين يقدّمون نماذج صور (مثل cli-proxy-api يعرض `gemini-3.1-flash-image`). الاختيار لكل
   بروفايل، ويرث اختيار البروفايل الافتراضي ما لم يُغيَّر.
3. ربط الاختيار بالاستعمال: أداة الصور في هرمز نفسه، ومهارتا الهب `image-generate` و`image-edit` (بدل
   مفتاح `COREHUB_IMAGE_API_KEY` اليدوي من #142)، مع رسالة واضحة حين لا يُختار نموذج.
4. إزالة الخلفية (وافق المالك: «ممتاز»): تبقى الإزالة المحلية للخلفيات السادة، ويُضاف خيار «إزالة الخلفية»
   في `image-edit` يمرّ بنقطة التعديل لنموذج الصور المختار لقصّ العنصر فعلًا، بلا نموذج محلي في الصورة.

## ما رأيته في هرمز قبل الكتابة (ADR 0012)
قرأت مصدر هرمز (MIT) عند الوسم المثبّت `v2026.9.14`، ولم أنسخ منه شيئًا. بكلماتي:

- **الأداة `image_generate`** ترسل كل طلب إلى «مزوّد صور» واحد مسجّل. الاختيار مفتاح واحد في
  `config.yaml` هو `image_gen.provider` (اسم المزوّد). إن لم يُضبط، يأخذ هرمز FAL إن وُجد مفتاحه، أو المزوّد
  الوحيد المتاح. كل مزوّد يقرأ إعداداته من قسم باسمه تحت `image_gen` (`image_gen.<name>.model` …) أو من
  متغيّرات بيئة خاصة به.
- **المزوّدون المشحونون** (`plugins/image_gen/*`): `openai` يكلّم OpenAI نفسها فقط (لا عنوان قاعدة يُضبط،
  وقائمة نماذج ثابتة من فئة gpt-image)؛ `openrouter` و`nous` يأخذان العنوان والمفتاح من مزوّد تشغيل باسمهما
  لا من أي مزوّد آخر؛ `deepinfra` يقبل `base_url` لكنه توليد فقط بلا تعديل ومفتاحه `DEEPINFRA_API_KEY`؛
  و`xai` و`fal` و`krea` لخدماتها. **لا مزوّد مشحون يقبل «أي نقطة متوافقة مع OpenAI + مفتاحها + أي نموذج»**،
  وهو بالضبط ما يلزم لـcli-proxy-api ولمزوّد مخصّص.
- **الإضافات**: هرمز يقرأ إضافات المستخدم من `<HERMES_HOME>/plugins/<فئة>/<اسم>/` (ملف `plugin.yaml` فيه
  `kind: backend`، و`__init__.py` فيه `register(ctx)` يستدعي `ctx.register_image_gen_provider(...)`). إضافة
  المستخدم لا تُحمَّل إلا إن ذُكرت في `plugins.enabled` في `config.yaml` (بمفتاح المسار `image_gen/<اسم>` أو
  بالاسم). المزوّد يرث صنفًا فيه `name` و`generate(prompt, aspect_ratio, image_url=…, reference_image_urls=…)`
  و`capabilities()` (هل يقبل صورة مصدرًا للتعديل)، ويعيد قاموس نجاح أو خطأ؛ الصورة تُحفظ في
  `$HERMES_HOME/cache/images/`. المفاتيح تُقرأ عبر نطاق أسرار البروفايل: `.env` البروفايل أولًا ثم بيئة العملية.
- **الطرفية**: هرمز يخفي مفاتيح مزوّديه عن الطرفية، لكنه يمرّر متغيّرًا تعلنه المهارة في
  `required_environment_variables` ما لم يكن من مفاتيحه (هذا ما أثبته #142 بـ`COREHUB_IMAGE_API_KEY`).

## القرار والموافقات
**التبويبات:** «المزوّدون» يعرض مزوّدي المحادثة (`kind: llm`) فقط، وأزلت المرشّح لأن خيارًا واحدًا لا يرشّح
شيئًا (مقترح — للمالك أن يؤكّد). تبويبا الصوت يعرضان مزوّدي نوعهما مع زر «إضافة مزوّد» خاص بالتبويب،
وبطاقة المزوّد فيهما تعديل وحذف بلا «النموذج الافتراضي» للمحادثة. لا تغيير في البيانات: المزوّد المحفوظ
بقي كما هو، والتغيير في العرض فقط. تبويب جديد `images` في `docs/clients/navigation.json` بعد تبويبات الصوت.

**دور «الصور»:** دور جديد `image` في جدول الأدوار نفسه الذي يحمل نموذج المحادثة والأدوار المساعدة
(`model_defaults`)، فيرث بالقاعدة نفسها (§37): اختيار البروفايل له، وإلا اختيار البروفايل الافتراضي بالنموذج
نفسه على مزوّد البروفايل من الـslug نفسه. في العقد: `ModelDefaults.image` و`ModelDefaultsWrite.image`، و`inherited`
يذكر `image`. نموذج الصور يُعرف بقدرة جديدة `image_output` في `ModelCapability`: من بيانات المزوّد حين
يقولها (OpenRouter: `architecture.output_modalities`) ومن اسم النموذج (`image`، `dall-e`، `imagen`، `flux` …).
الهب يرفض اختيار نموذج ليس للصور، أو مزوّدًا مسجّل الدخول عبر هرمز (لا مفتاح بيد الهب)، أو بروتوكولًا لا
يولّد صورًا (Anthropic، Ollama). ترحيل قاعدة البيانات يوسّع قيد الأدوار فقط، ولا يلمس صفًا.

**ما يكتبه الهب للبروفايل** (عند كل حفظ وعند تجهيز كل بروفايل قبل دوره، كما يكتب المفاتيح اليوم):
- في `.env`: `COREHUB_IMAGE_PROVIDER` و`COREHUB_IMAGE_BASE_URL` و`COREHUB_IMAGE_MODEL` و`COREHUB_IMAGE_API_KEY`
  من المزوّد والنموذج المختارين. الهب يملك هذه الأسماء: تُحذف حين لا يُختار نموذج. البروتوكول: مزوّد Google
  الأصلي ← `gemini`؛ مزوّد متوافق مع OpenAI ونموذج من عائلة Images API (gpt-image، dall-e، imagen، flux …) ←
  `compatible` (`/images/generations` و`/images/edits`)؛ وغيره (مثل `gemini-*-image` عبر وسيط) ← `chat`
  (`/chat/completions` مع `modalities: ["image","text"]`، والصورة في `message.images`) — مقترح.
- في `config.yaml`: `image_gen.provider: corehub-images` و`image_gen/corehub-images` في `plugins.enabled`، وحين
  لا يُختار نموذج يُزال ما كتبه الهب فقط (قيمة لمزوّد آخر كتبها شخص تبقى).
- الإضافة `plugins/image_gen/corehub-images/` (كتابتي، Apache-2.0): تقرأ المتغيّرات الأربعة عبر نطاق أسرار
  هرمز، وتستعمل **السكربت نفسه** الذي تستعمله المهارتان (`image_api.py`)، فأداة هرمز والمهارتان على الاختيار
  نفسه دائمًا.

**المهارتان:** لا مفتاح يدوي: السكربت يقرأ ما كتبه الهب فقط، ولا يلجأ إلى `OPENAI_API_KEY`/`GEMINI_API_KEY`
(هرمز يحجبهما عن الطرفية أصلًا). بلا نموذج مختار يرد `image_model_not_chosen` برسالة «اختر نموذج صور في
النماذج ← الصور». **إزالة الخلفية** أمر جديد `remove-bg`: عبر Images API يطلب خلفية شفافة مباشرة، وعبر
نماذج المحادثة/Gemini يطلب العنصر على لون سادة ثم تُكمل خطوة `image-convert transparent-bg` المحلية الشفافية؛
السكربت يقول أيّ الحالين حدث.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `ModelCapability`: قيمة جديدة `image_output`.
- `ModelDefaults.image` و`ModelDefaultsWrite.image` (`ModelRef` أو `null`)، و`inherited` قد يحوي `image`.
- DECISIONS §72.

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml` (`ModelCapability.image_output`، `ModelDefaults.image`،
  `ModelDefaultsWrite.image`، وصف `inherited`)؛ `docs/contracts/DECISIONS.md` §72.
- الخادم (`packages/server/src/modules/models/`): `images.ts` (جديد: هل النموذج للصور، وبأي بروتوكول يُكلَّم،
  وأسماء المتغيّرات واسم الإضافة)، `hermes-image-plugin.ts` (جديد: يضع الإضافة في بيت هرمز)، `schema.ts`
  (الدور `image` والقدرة `image_output`)، `defaults.ts`، `service.ts` (قراءة الدور وحفظه والتحقق منه، وحلّ
  الاختيار إلى متغيّرات، وكتابته في الجذر وكل بروفايل مسمّى، وتثبيت الإضافة دون أن يُفشل فشلُها حفظ
  المزوّدين)، `propagation.ts` (`imageEnv` و`hermesImage` و`applyImage`)، `serialize.ts`،
  `adapters/openai.ts` (قراءة `output_modalities`)؛ ترحيل `drizzle/0021_model_role_image.sql`.
- المكتبة: `skill-library/image-generate` و`image-edit` (`SKILL.md` بالنسخة 1.1.0، و`image_api.py` واحد في
  المهارتين: بروتوكول `chat` جديد، و`remove-bg`، و`draw()` للإضافة، ولا مفاتيح احتياطية)، و
  `skill-library/_hermes-plugin/` (جديد، ليس مهارة: `plugin.yaml` و`__init__.py`).
- الويب: `packages/web/src/models/ModelsScreen.tsx` (تبويب المزوّدين للمحادثة فقط بلا مرشّح، وتبويبا الصوت
  بزر إضافة داخلهما وبطاقات بلا «النموذج الافتراضي»، ونافذة الإضافة بقوالب نوع التبويب، وتبويب الصور)،
  `queries.ts`، `i18n/ar.json` و`en.json` (مفاتيح `models.tab.images` و`models.images.*`
  و`models.speech.add_*`/`none_*`، وحُذفت `models.filter` و`models.filter_all` و`models.providers.empty` التي
  لم يعد يستعملها شيء).
- التنقّل والتوثيق: `docs/clients/navigation.json` (تبويب `images`)، `docs/clients/NAVIGATION.md` §٣،
  `docs/domain/models.md`، `docs/STATUS.md`.
- الاختبارات: `models/images-role.test.ts` (جديد)، `agents/skill-library.lint.test.ts`،
  `tests/unit/skill-library.real.test.ts` (يكتب `.env` بما يكتبه الهب)، `web/tests/models-screen.test.tsx`.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`، واحدًا بعد الآخر، في الشجرة `corehub-wt-modelsroles` بعد دمج `origin/night/2026-09-26`:

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck            → exit 0 (كل الحزم)

$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 96 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 570 client file(s) scanned, 222 contract path(s) known.
$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  364 passed (364)
$ pnpm --filter @corehub/contracts test
 Test Files  7 passed (7)
      Tests  38 passed (38)

$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 37 destinations, 2 pre-auth screens (login, setup), 42 terms, ar/en complete, routes for web, ios, android, desktop

# الخادم: وحدة النماذج كاملة (قبل الدمج)، ثم الملفات التي لمستها
$ vitest run --project unit src/modules/models/
 Test Files  11 passed (11)
      Tests  170 passed | 1 skipped (171)
$ vitest run --project unit src/modules/models/images-role.test.ts src/modules/agents/skill-library.lint.test.ts \
    src/modules/models/propagation.test.ts src/modules/models/providers-shared.test.ts
 Test Files  4 passed (4)
      Tests  78 passed (78)
$ vitest run --project unit src/modules/agents/hermes-gateways.test.ts src/modules/agents/channels-gateway.routes.test.ts \
    src/modules/agents/skill-library.test.ts src/modules/agents/skill-library.routes.test.ts
 Test Files  4 passed (4)
      Tests  47 passed (47)

# الويب
$ vitest run tests/models-screen.test.tsx
 Test Files  1 passed (1)
      Tests  30 passed (30)
$ vitest run tests/navigation.parity.test.tsx tests/voice-dictation.test.tsx tests/i18n.test.ts tests/model-fallback-signin.test.tsx
      Tests  28 passed (28)

# الاختبارات الجديدة تفشل على الشاشة القديمة (ModelsScreen.tsx من night/2026-09-26):
     × lists only chat providers on Providers, with no speech filter
     × lists, adds, edits and removes speech providers in their own tab
     × chooses the image model from the chat providers' image models
     × says an inherited image model is the default profile's, and a chosen one can go back to it
     × says in Arabic when no chat provider offers an image model, and leads to Providers
      Tests  5 failed | 25 passed (30)
```

ما تثبته اختبارات الخادم الجديدة (`images-role.test.ts`): القدرة `image_output` على نموذج
`gemini-3.1-flash-image` لمزوّد cli-proxy-api مخصّص ولا تظهر على `gemini-2.5-pro`؛ الوراثة (بروفايل `work` يرى
اختيار الافتراضي و`inherited: [image]`، ثم اختياره الخاص، ثم الرجوع بـ`null`)؛ رفض نموذج لا يرسم (`400`)؛ وفي
بيت هرمز: `image_gen.provider: corehub-images` و`image_gen/corehub-images` في `plugins.enabled` وملفات الإضافة
مطابقة، والمتغيّرات الأربعة في `.env` الجذر وفي بيئة العملية، وبروفايل `design` يرث بلا نسخة في `.env`ـه مع
بقاء إعداداته الخاصة (`my-own-plugin` و`image_gen.fal`)، ثم اختياره الخاص في `.env`ـه، ثم المسح يزيل ما كتبه
الهب فقط؛ و`fal` الذي اختاره شخص لا يُمسّ. واختبار يشغّل الإضافة ببايثون فعلي مع واجهة هرمز مكتوبة
بكلماتنا (`agent/image_gen_provider.py`، `agent/secret_scope.py`): تُسجَّل باسمها، وترسم وتعدّل عبر نقطة
`/chat/completions` مُبرمجة بمفتاح المزوّد، والصورة في مجلد الذاكرة المؤقتة، ولا يظهر المفتاح في الناتج؛
وبلا نموذج تقول `image_model_not_chosen` و«Models → Images».

**لم أشغّل** (قواعد السرعة: CI يشغّلها على كل دفع): حزم الخادم والويب كاملة، و`pnpm build`، ورحلات Playwright
(لم أضف رحلة جديدة)، والاختبار الحقيقي مع هرمز في الصورة (`skill-library.real.test.ts` يحتاج Docker، وليس
معي في هذه المهمة) — فالإضافة لم تُجرَّب بعد داخل هرمز حقيقي.

نتيجة CI على #144 عند `800c436` (فيه هذه المهمة): كلها ناجحة — CI (lint وtypecheck والعقد واختبارات العملاء
والبناء، وشرائح الخادم الثلاث، وdb:migrate على SQLite وPostgreSQL، وصورة Docker، ورحلات الويب، وسطح المكتب)،
وAndroid وiOS وDesktop installers وChange record. التشغيل السابق عند `7874c94` فشل في اختبار ويب واحد لا تلمسه
المهمة: `voice-dictation.test.tsx` «falls back to the browser’s recognizer…» (`expected 'en-US' to be 'ar-SA'`).
يفشل أيضًا على `origin/integration/2026-09-25` تحت الضغط (1 من 12 تشغيلًا مع إشغال كل الأنوية، و3 من 12 على هذا
الفرع): سباق في الاختبار نفسه، ينتظر أن يُطلب `preferences` لا أن يُطبَّق قبل النقر على الميكروفون.

## المخاطر والرجوع
- **أنماط الأسماء** (أي نموذج للصور، وأي بروتوكول) تخمين من الاسم حين لا يقول المزوّد؛ نموذج صور باسم غريب
  لا يظهر في التبويب حتى يقول مزوّده `output_modalities`. والرجوع بسيط: توسيع النمط في `images.ts`.
- **cli-proxy-api وبروتوكول `chat`**: الشكل المقروء هو شكل OpenRouter (`message.images`) مع بديلين (أجزاء
  `image_url` في المحتوى، و`data:` في النص). لم يُجرَّب على cli-proxy-api حقيقي.
- **الإضافة في هرمز** لم تُجرَّب في دور هرمز حقيقي؛ فشل تثبيتها يُسجَّل ولا يوقف كتابة المزوّدين، والمهارتان
  تعملان من المتغيّرات دونها.
- `.env` البروفايل صار يحمل مفتاح مزوّد الصور مرة ثانية باسم `COREHUB_IMAGE_API_KEY` (الهب يملكه ويحذفه).
- الرجوع: revert لهذا الفرع؛ الترحيل `0021` ينسخ الجدول كما هو، وصف بدور `image` يبقى بلا أثر على الأدوار
  الأخرى (والرجوع الكامل يحتاج حذف تلك الصفوف قبل إعادة القيد القديم).

## التسليم والخطوة التالية
- للمالك أن يؤكّد القرارات المقترحة: أنماط التعرّف والبروتوكول، وحذف مرشّح «اعرض»، وزر الإضافة داخل تبويبي
  الصوت، والأخضر الصافي لونًا افتراضيًا للقصّ.
- التالي: تجربة الإضافة في دور هرمز حقيقي بالصورة، وعلى cli-proxy-api الحقيقي بـ`gemini-3.1-flash-image`.
