# قائمة نماذج المزوّد من المزوّد نفسه، والصور عبر اشتراك ChatGPT
المسؤول: twuijri · الفرع: feat/codex-subscription-images · الحالة: review

## المشكلة والهدف
بلاغ المالك (2026-09-25 و2026-09-26):
1. مزوّد «ChatGPT / Codex (subscription)» (`openai-codex`) لا يقدّم نموذج صور، فتبويب
   النماذج ← الصور لا يعرض منه شيئًا؛ بينما CLI Proxy API على **الحساب نفسه** يقدّم
   `gpt-image-2` ويرسم به. صديقه الذي يستخدم تسجيل الدخول المباشر في Core Hub لا يحصل على صور.
2. القائمة ناقصة: حساب المالك نفسه (Pro) يعرض في Core Hub تسعة نماذج (gpt-5.5، gpt-5.6-luna/sol/terra،
   وأسماء `-900k`) بلا عائلة `gpt-6-*` التي يعرضها CLI Proxy API للحساب نفسه («فيه ٦ بس»).
3. قاعدة المالك لكل المزوّدين: «كل الموديلات خله هو يسحب الي يقدمه المزود ما يخترع من نفسه».

### ما لاحظته (ADR 0012، بكلماتي؛ مصدر Hermes MIT، الوسم v2026.9.14، قراءة فقط)
- **من أين تأتي القائمة**: مزوّدو المفاتيح يسألهم المركز بنفسه عبر محوّلاته (`/models`، قوائم
  Anthropic وGoogle، وسوم Ollama) — لا قائمة محفوظة فيها. أما المزوّد المسجَّل دخوله عبر Hermes
  (§55) فكان المركز يأخذ قائمته من منتقي Hermes (`/api/model/options?refresh=true`).
- **لماذا تنقص**: منتقي Hermes لاشتراك ChatGPT يسأل `…/backend-api/codex/models?client_version=0.0.0`
  بحساب المستخدم، وإن فشل الطلب أو رجع فارغًا يرجع **بصمت** إلى قائمة محفوظة في كوده (ثمانية نماذج:
  gpt-5.6-sol/terra/luna، gpt-5.5، gpt-5.4-mini، gpt-5.4، gpt-5.3-codex، gpt-5.3-codex-spark)، ويضيف
  أسماء `-900k` **يخترعها Hermes** (مفتاح سياق كبير يحذفه قبل الطلب، لا نموذج يعرضه الخادم). ولـ Nous
  Portal يعرض المنتقي قائمته المختارة فقط. والمركز لا يستطيع التمييز بين قائمة حيّة وقائمة محفوظة.
  القائمة التي رآها المالك (gpt-5.6-* مع `-900k` وبلا gpt-6) هي شكل تلك القائمة المحفوظة/المركّبة،
  لا ما يقدّمه خادم Codex لحساب Pro — فالسبب **ليس الخطة**، بل قائمة محفوظة تُعرض على أنها قائمة
  الحساب. لم أستطع تأكيد سبب فشل الطلب الحي عند المالك دون حسابه (قد يكون ترويسات طلب Hermes: يرسل
  `Authorization` و`ChatGPT-Account-Id` فقط، بلا ترويسات تعريفه التي يرسلها في المحادثة).
- **الصور**: خادم Codex لا يعرض نموذج صور في `/models`؛ يرسم حين يُعطى نموذج محادثة يخدمه أداة
  `image_generation` في Responses API مع اسم نموذج الصور (`gpt-image-2`). Hermes نفسه يشحن هذا
  كخلفية صور `openai-codex`، وCodex من OpenAI يرسم بـ gpt-image-2 للخطط المدفوعة (لا المجانية) ويُحتسب
  من حدود استخدام Codex في الخطة. CLI Proxy API (مشروع مفتوح المصدر، رخصته MIT حسب مستودعه
  `router-for-me/CLIProxyAPI`) يعرض ذلك كنقطة Images API على طريقته؛ قرأت وصفه العام فقط ولم أنسخ شيئًا.
- **هل هو مسموح؟** OpenAI لا تنشر قاعدة صريحة لعملاء طرف ثالث يستخدمون تسجيل دخول ChatGPT، لا منعًا
  ولا إذنًا. Hermes يشحن المحادثة والصور عليه ويعرّف نفسه بترويساته؛ والصور جزء من Codex على الخادم
  نفسه وتُحتسب من حدود الخطة نفسها، فهي مغطّاة بقدر ما تُغطّى المحادثة — لا أكثر. لا اختراق ولا تجاوز
  حماية: الطلب بشكل Responses العادي وبتوكن الحساب الذي سجّل صاحبه دخوله.

## القرار والموافقات
- **§83 — موافق عليه من المالك** (بكلماته أعلاه): قائمة النماذج هي ما يعيده المزوّد للحساب.
  المزوّد المسجَّل دخوله يُسأل مباشرة من بايثون Hermes في بيت Hermes الذي سُجّل فيه (`live-models.ts`):
  محلّل اعتماد Hermes يعطي التوكن (ويجدّده عند قرب انتهائه، ومرة أخرى بعد 401)، ثم نقطة نماذج المزوّد
  نفسها. التوكن لا يخرج من تلك العملية. قائمة Hermes تُستعمل فقط إن تعذّر السؤال، وتُعلَّم `fallback` مع
  السبب وتقولها البطاقة. أسماء `-900k` لم تعد تظهر لأن الخادم لا يعرضها. الأسماء المعروضة والإخفاء
  كما هي فوق القائمة.
- **§84 — مقترح، بانتظار تأكيد المالك**: نموذج واحد يضيفه المركز لقائمة الاشتراك: `gpt-image-2`
  (`image_output`)، يُعرض في تبويب الصور «الصور عبر اشتراك …»؛ الرسم عبر بروتوكول `codex` الجديد في
  `image_api.py` (المهارات وأداة Hermes معًا)، بنموذج المحادثة `gpt-5.5` حاملًا للأداة، بلا مفتاح يُكتب.
  خطة بلا صور ← `image_not_in_plan`؛ حد مستهلك ← `usage_limit`.
- مقترح أيضًا: حفظ مصدر القائمة في عمود `providers.capabilities` (JSON) بدل عمود جديد، لتجنّب ترحيل.
- مقترح: نموذج المحادثة الحامل للأداة ثابت `gpt-5.5` (كما في Hermes)، ويمكن تغييره بـ
  `COREHUB_IMAGE_CODEX_HOST` دون أن يكتبه المركز.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `Provider.catalogue.source` (`provider` | `fallback` | null، اختياري) و`Provider.catalogue.fallback_reason`.
- `Provider.draws_images` (اختياري، boolean).
- وصف `ModelDefaultsWrite.image` يذكر اشتراك ChatGPT.
- `docs/contracts/DECISIONS.md` §83 و§84.

## الملفات والتأثير
- الخادم: `models/live-models.ts` (جديد)، `models/sign-in.ts` (القائمة الحية أولًا ثم قائمة Hermes
  معلَّمة)، `models/index.ts` (بايثون Hermes وبيت البروفايل)، `models/service.ts` (مصدر القائمة،
  `gpt-image-2`، `drawsImages`، دور الصور يقبل الاشتراك)، `models/images.ts` (`CODEX_IMAGES`، بروتوكول
  `codex`)، `models/serialize.ts`، `models/schema.ts`، `agents/index.ts` (تصدير `hermesPythonRunner`).
- مكتبة المهارات: `image_api.py` (نسختا image-generate وimage-edit) بروتوكول `codex`؛ إصدار
  المهارتين 1.2.0.
- الويب: `models/ModelsScreen.tsx` (تبويب الصور حسب `draws_images` مع تسمية الاشتراك، وملاحظة مصدر
  القائمة على البطاقة)، `i18n/{ar,en}.json`.
- الاختبارات: `models/codex-subscription.test.ts` (جديد: خادم Codex مكتوب وبديل لمخزن اعتماد Hermes)،
  `models/codex-subscription.real.test.ts` (جديد: Hermes الحقيقي من الصورة)، تحديث
  `models/fallback-signin.test.ts`، والويب `tests/models-screen.test.tsx`.
- الوثائق: `docs/domain/models.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run`، ما تمسّه المهمة فقط:
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck                                              (exit 0)
$ pnpm contracts:lint
contracts:lint  OK            (تحذير واحد قائم من قبل في السطر 6853، لا علاقة له)
$ pnpm contracts:check-clients
check-clients  OK — 621 client file(s) scanned, 229 contract path(s) known.
$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  371 passed (371)
$ pnpm i18n:check
i18n:check  web: 2659 keys, ar/en in parity
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete
$ vitest run src/modules/models/            (server)
 Test Files  12 passed | 1 skipped (13)
      Tests  179 passed | 3 skipped (182)
$ vitest run src/modules/agents/skill-library.lint.test.ts
      Tests  30 passed (30)
$ vitest run tests/models-screen.test.tsx tests/model-fallback-signin.test.tsx   (web)
 Test Files  2 passed (2)
      Tests  42 passed (42)
$ COREHUB_HERMES_IMAGE=core-hub:morechannels vitest run --maxWorkers=1 --reporter=verbose \
    src/modules/models/codex-subscription.real.test.ts          # Hermes v0.21.3 (2026.9.14)
 ✓ lists the account's models with Hermes's own resolver and identity headers 400ms
 ✓ draws a PNG through the image_generation tool with the token Hermes hands the script 387ms
      Tests  2 passed (2)
```
`codex-subscription.test.ts` (9 اختبارات) يغطي: قائمة حساب Pro مرتبة والمخفي خارجها وبلا `-900k`،
قائمة Plus مختلفة (حسب الخطة)، تجديد التوكن مرة بعد 401، سببًا واضحًا حين يتعذّر السؤال، مزوّد xAI على
`/models`، تسجيل الدخول في المركز ثم القائمة الحية + `gpt-image-2` ودور الصور يقبله ويكتب `.env` بلا
مفتاح، «تحديث النماذج» يرجع إلى قائمة Hermes معلَّمة `fallback`، والرسم والتعديل وإزالة الخلفية
(`background: transparent`) وتجديد 401 وخطأ `image_not_in_plan` النظيف دون طباعة التوكن.
الاختبار الحقيقي شغّل حاويتين بـ `--rm` على `core-hub:morechannels` (مخزن اعتماد Hermes الحقيقي بتوكن
مزيّف لا ينتهي، `HERMES_CODEX_BASE_URL` إلى خادم مكتوب)؛ لم تبقَ حاوية.
لم أشغّل الاختبارات الجديدة على الكود القديم؛ هي تطلب وحدات وبروتوكولًا لم تكن موجودة.
لم يُشغَّل محليًا: بقية حزم الخادم والويب وPlaywright (يشغّلها CI).

CI على PR #156 (التشغيل 36191323593 وأخواته) أخضر كله: lint/typecheck/contracts/build، اختبارات الخادم
(3 أجزاء)، Playwright على المركز الحقيقي، صورة Docker تجيب `/health`، db:generate/migrate (SQLite
وPostgreSQL)، سطح المكتب وAndroid وiOS، وسجل التغيير وgraphify.

## المخاطر والرجوع
- **لا حساب ChatGPT حقيقيًا جُرِّب**: الشكل مأخوذ من مصدر Hermes وسلوكه الموصوف؛ أول تجربة حقيقية
  عند المالك. إن رفض الخادم ترويسات أو شكلًا، تظهر رسالته كما هي.
- **تصنيف «الخطة بلا صور»** تقديري (402/403 أو كلمات مثل plan/upgrade)، والنص الأصلي في `detail`.
- **`gpt-image-2` في منتقيات المحادثة** يظهر كما يظهر `gpt-image-1` على OpenAI اليوم؛ اختياره نموذج
  محادثة سيفشل من الخادم.
- **MiniMax**: قد لا يكون لعنوانه نقطة `/models` فيبقى على قائمة Hermes معلَّمة `fallback`.
- الاستخدام يُحتسب من حدود Codex في خطة الحساب (الصور أسرع استهلاكًا).
- الرجوع: التراجع عن الدمج؛ لا ترحيل. المصدر المحفوظ في JSON يُتجاهَل.

## التسليم والخطوة التالية
- المالك: تأكيد §84 (النموذج المضاف، الحامل `gpt-5.5`، التسميات)، وتجربة «تحديث النماذج» ثم الرسم على
  صورة الاختبار بحسابه وحساب صديقه.
- مزوّدون لم يُمسّوا لأنهم بلا قائمة محفوظة أصلًا: كل مزوّدي المفاتيح (المحوّلات تسأل المزوّد)؛ ومزوّدو
  الكلام (ElevenLabs يعرض الأصوات لا النماذج، والنموذج الافتراضي إعداد لا قائمة).
