# النماذج الاحتياطية، وتسجيل الدخول للمزوّد برمز الجهاز
المسؤول: twuijri · الفرع: feat/model-fallback-oauth · الحالة: review

## المشكلة والهدف
محادثة المالك توقفت في منتصفها بـ `HTTP 503 auth_unavailable … (providers=antigravity,
model=gemini-3.8-flash-high)` — عطل عند الوسيط المتوافق مع OpenAI — فمات التشغيل كله. وتقرير
المراقِب يقول إن أمرين معلنان في العقد بلا شاشة ولا تنفيذ:
1. **سلسلة النماذج الاحتياطية** (`ModelDefaults.fallbacks`): تُحفظ ولا يجرّبها أحد.
2. **تسجيل الدخول للمزوّد** (`models.startProviderSignIn` وأخواتها): تجيب `501`.

الهدف: أن ينتقل الدور إلى النموذج التالي في السلسلة عند خطأ مؤقت من المزوّد (5xx، 429،
`auth_unavailable`، انتهاء المهلة، تعذّر الاتصال) لا عند خطأ تحقق 4xx، وأن يظهر في المحادثة
أيّ نموذج أجاب فعلًا؛ وأن يُسجَّل الدخول بالرمز والرابط للمزوّدين الذين يدعمهم Hermes.

ما قرأته من مصدر Hermes (MIT، الوسم v2026.9.14، نسخة مثبتة في مجلد العمل المؤقت، لا نسخ لشيء
منه):
- Hermes يدعم سلسلة احتياطية بنفسه: المفتاح `fallback_providers` في `config.yaml` (قائمة
  `provider` + `model`؛ `hermes_cli/fallback_config.py` و`hermes fallback`)، ويقرؤها بوابة
  الـ TUI عند بدء الجلسة، وينتقل عند الأخطاء التي يصنّفها قابلة للتجاوز، ويكتب سطر حالة
  «Model fallback: X via P unavailable (…); using Y via Q.»، ويصير `usage.model` في
  `message.complete` هو النموذج الذي أجاب.
- خادم Hermes (`hermes serve`، ADR 0015) فيه تسجيل دخول برمز الجهاز لأربعة مزوّدين:
  `nous`، `openai-codex`، `xai-oauth`، `minimax-oauth` (`hermes_cli/web_routers/oauth.py`:
  `start` يعيد الرمز والرابط، `poll` يعيد الحالة، والاعتماد يُحفظ في بروفايل Hermes المطلوب).
  Anthropic هناك «خارجي» عمدًا (سياسة Anthropic)، فلا يُعرض.

## القرار والموافقات
**مقترح — بانتظار تأكيد المالك** (DECISIONS §54 و§55):
1. **متى ينتقل الدور**: فقط عند خطأ يتجاوزه نموذج آخر — 5xx، أو كلام المزوّد فيه
   `auth_unavailable` (حتى داخل بثّ 200)، 429، 408، لا جواب، تعذّر الاتصال. لا عند 4xx آخر
   (400، 404، 422)، ولا عند 401/403 (مفتاح مرفوض يصلحه الشخص لا يُخفى خلف مزوّد آخر)، ولا بعد
   أن يبدأ النموذج بالإجابة (نموذج ثانٍ يكمل نصف جملة الأول يُقرأ صوتًا واحدًا).
2. **أيّ سلسلة**: سلسلة البروفايل مع نموذج المحادثة (تُورث معه من البروفايل الافتراضي، §37).
   كل وكيل في البروفايل يستخدمها بعد نموذجه (نموذج الكاتب، أو نموذج الوكيل، أو نموذج
   البروفايل)، ولا يُعاد تجريب نموذج جُرِّب. **لا سلسلة لكل وكيل** في هذه المهمة (المطلوب قال
   «واختياريًا لكل وكيل»؛ تركته لقرار المالك لأنه يحتاج حقلًا وعمودًا جديدين).
3. **أين تُنفَّذ**: في Hermes بـ `fallback_providers` يكتبه المركز في `config.yaml` لكل بروفايل
   حيث يملك المركز اختيار النموذج (Hermes يصنّف الأخطاء بنفسه)؛ وللوكيل `direct` في المركز
   (`ModelsService.chat`). تغيير نموذج المحادثة من بطاقة المزوّد لا يمسح السلسلة، والسلسلة لا
   تحوي النموذج الذي تُحتاط له ولا تكرارًا.
4. **ما يراه العميل**: `Run.fallback` (قائمة ما فشل بالترتيب، مع رمز الخطأ وكلام المزوّد)، و
   `Run.model`/`Run.provider` يسمّيان النموذج الذي أجاب (أو آخر ما جُرِّب إن فشل الكل). في
   المحادثة ملاحظة تحت الرد «فشل X، فأجاب Y — السبب: …» وسطر الميتا يبدأ بـ «أجاب Y»، وتبقى بعد
   إعادة التحميل (الويب يقرأ صفحة من `sessions.listRuns`). في المسار شارة على أول دور تذكر النموذج
   الذي فشل، وتفاصيل الدور تذكر النموذج. عنوان المحادثة يُطلب على السلسلة نفسها.
5. **تسجيل الدخول**: المزوّدون الأربعة إعدادات جاهزة `sign_in: true` بلا مفتاح
   (`auth.kind = oauth`). Hermes يسجّل الدخول ويحفظ الاعتماد — للمزوّد المشترك في جذر Hermes
   (البروفايل الافتراضي)، ولمزوّد بروفايل في ذلك البروفايل — والمركز يعرض الرمز والرابط ويسأل
   Hermes حتى الموافقة، ثم يصير المزوّد «تم تسجيل الدخول» وتُجلب نماذجه من Hermes. فقط حيث يشغّل
   المركز Hermes بنفسه (`409 hermes_not_supervised` في غير ذلك). الوكيل `direct` يرفض هذا المزوّد
   باسمه (الاعتماد عند Hermes لا عند المركز). حذف المزوّد يطلب من Hermes نسيان الحساب.
   `completeProviderSignIn` يجيب `409 code_not_accepted` (لا أحد منهم يأخذ رمزًا يُلصق).
6. **الترتيب في الويب**: أزرار «قدّم/أخّر/احذف» لكل عنصر مرقّم بدل السحب — قائمة من ثلاثة أو
   أربعة لا تحتاج سحبًا، والأزرار تعمل بلوحة المفاتيح وقارئ الشاشة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `Run.fallback` (اختياري، `RunFallback | null`) ومخطّطا `RunFallback` و`RunFallbackAttempt`
  (`model`، `provider`، `code`، `error`)؛ ونُسخت إلى `$defs` في `events/common.schema.json`
  وأحداث `run.*` في `/rt/sessions` و`/rt/rooms`.
- `TrajectoryStep.model` و`TrajectoryStep.fallback` (اختياريان).
- `ModelDefaults.fallbacks`: وصف القاعدة.
- `ProviderPreset.sign_in` (مطلوب، boolean).
- `ProviderSignIn`: الحالة `failed` والحقل `error` (مطلوب)، ووصف للمخطط.
- `models.startProviderSignIn` (+`503`، والأسباب في الوصف)، `getProviderSignIn` (وصف)،
  `completeProviderSignIn` (+`409`).
- `docs/contracts/DECISIONS.md` §54 و§55.

## الملفات والتأثير
- الخادم — models: `service.ts` (مسار السلسلة في `chat`/`chatOnce`، `retryableFailure`،
  `fallbackChain`، إبقاء السلسلة عند تغيير النموذج، تسجيل الدخول `startSignIn`/`pollSignIn`/
  `completeSignIn`، جلب نماذج المزوّد من Hermes، الاختبار والتحديث لمزوّد `oauth`)، `sign-in.ts`
  (جديد: الحديث مع خادم Hermes وترجمة حالاته)، `propagation.ts` (`fallback_providers`)،
  `catalogue.ts` (أربعة إعدادات جاهزة، `signIn`)، `serialize.ts`، `index.ts` (المسارات، المنفذ)،
  i18n الخادم.
- الخادم — agents: `ports.ts`، `adapters/types.ts` (`model.fallback`، `FallbackModel`)،
  `adapters/direct.ts`، `adapters/hermes-tui.ts` (قراءة سطر Hermes و`usage.model`)، `runner.ts`،
  `service.ts` (`fallbacksFor`، `providerSlugOf`).
- الخادم — sessions: `ports.ts`، `run-reducer.ts`، `engine.ts` (يحدّث نموذج التشغيل ويحفظ ما
  فشل في `runs.timing` — بلا ترحيل قاعدة بيانات)، `mappers.ts`، `schema.ts`، `trajectory.ts`.
- الويب: `models/queries.ts` (`useCatalogue` يقرأ كل الصفحات)، `models/FallbackList.tsx` و`models/fallbacks.ts` و`models/SignInPanel.tsx` (جديدة)،
  `models/ModelsScreen.tsx`، `models/AddProviderDialog.tsx`، `models/queries.ts`،
  `chat/MessageView.tsx`، `chat/fallback.ts` و`chat/useRunHistory.ts` (جديدان)،
  `chat/ChatScreen.tsx`، `chat/TrajectoryView.tsx`، `types.ts`، `i18n/{ar,en}.json`.
- الاختبارات: `sessions/direct-fallback.test.ts`، `models/fallback-signin.test.ts`،
  `agents/adapters/hermes-fallback.real.test.ts` (جديدة)، إضافات في `hermes-tui.test.ts`،
  وتحديث `catalogue.test.ts` و`models-api.test.ts` و`runner.test.ts`؛ الويب
  `tests/model-fallback-signin.test.tsx`؛ Playwright `e2e/zzzzzzz-model-fallback.spec.ts` (الرحلة
  34) مع خطوة `direct` ووسيط مكتوب في `e2e/hub.ts`.
- الوثائق: `docs/domain/models.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (عبر `mj-run`)، ما تمسّه المهمة فقط:
```
$ pnpm lint
All matched files use Prettier code style!            (exit 0)
$ pnpm typecheck                                        (exit 0)
$ pnpm contracts:lint
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 288 client file(s) scanned, 176 contract path(s) known.
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  274 passed (274)
$ pnpm i18n:check
i18n:check  web: 1347 keys, ar/en in parity
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ vitest run (server) catalogue models-api propagation providers-shared direct hermes-tui runner
    run-reducer trajectory direct-run fallback-signin direct-fallback
 Test Files  12 passed (12)
      Tests  202 passed | 1 skipped (203)
$ vitest run (web) models-screen message-layout trajectory model-fallback-signin
 Test Files  4 passed (4)
      Tests  56 passed (56)
$ pnpm build                                            (exit 0)
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test zzzzzzz-model-fallback.spec.ts
  ✓  1 [chromium] › e2e/zzzzzzz-model-fallback.spec.ts:44:1 › 34. a fallback model answers when the chat model is down, and the reply says so (1.6s)
  1 passed (7.8s)
$ COREHUB_HERMES_IMAGE=majlis:profexport vitest run --maxWorkers=1 hermes-fallback.real   # Hermes v0.21.3 (2026.9.14)
 Test Files  1 passed (1)
      Tests  2 passed (2)
```
الفحص الحقيقي مع Hermes: المركز يكتب `fallback_providers: [{provider: corehub-lmstudio, model:
up-1}]` في `config.yaml` مع بقاء المفاتيح الأخرى، ونموذج المحادثة `down-1` يجيب `503
auth_unavailable`، فينتقل Hermes بنفسه إلى `up-1` ويجيب، ويقول المحوّل `model.fallback` بأسماء
المركز. شُغّلت حاوية واحدة بـ `--rm` ولم يكن يعمل غير حاويات المالك الدائمة.

أول CI (تشغيل 36084639082) فشل في رحلات Playwright 9 و26 و34 وفي اختبار CLI `pair`: مفتاح
استعلام سجل التشغيلات الجديد كان تحت `['sessions', …]`، وقائمة المحادثات تحدّث كل استعلام بهذه
البادئة على أنه صفحة محادثات، فتضيع تحديثات العناوين (9، 26)؛ ورحلة 34 لم تجد الخيار في قائمة
مُفترضة (virtualized) بعد أن تركت الرحلات السابقة مئات النماذج. أُصلح الاثنان (مفتاح
`['run-history', …]`، والبحث في الخانة قبل الاختيار). اختبار CLI نجح محليًا (19/19) دون تغيير —
تذبذب توقيت. بعد الإصلاح محليًا:
```
$ playwright test setup.spec.ts smoke.spec.ts                          22 passed (1.4m)
$ playwright test smoke.spec.ts zzzzzzz-model-fallback.spec.ts         22 passed (1.4m)
$ playwright test zzz-chat-history.spec.ts                             3 passed (21.4s)
$ vitest run tests/integration/cli.test.ts (packages/cli)              Tests  19 passed (19)
```

التشغيل الثاني (36085747900) نجح كله إلا الرحلة 34: نموذج `gpt-backup` لم يكن في القائمة أصلًا —
`useCatalogue` في الويب كان يقرأ الصفحة الأولى فقط (200 نموذج)، والرحلات السابقة تترك مزوّدًا بـ
443 نموذجًا. هذا خلل قائم في كل منتقي نموذج (يصيب المالك مع OpenRouter)، فأصلحته هنا: القراءة
تتبع `next_cursor` حتى عشر صفحات. محليًا، بعد رحلة المزوّدين التي تضيف الـ 443:
```
$ playwright test zzzzz-providers-scopes.spec.ts zzzzzzz-model-fallback.spec.ts   2 passed (12.1s)
$ vitest run tests/models-screen tests/model-fallback-signin tests/composer        Tests  53 passed (53)
```
محاولة تشغيل مجموعة Playwright كاملة محليًا توقّفت لأن مركز الاختبار أُغلق في منتصفها
(`ERR_CONNECTION_REFUSED` من الرحلة 20 فصاعدًا، والجهاز مشغول بمجموعات وكلاء آخرين) — لا تُعدّ
نتيجة؛ CI هو الحَكَم.

أثناء الكتابة كشف اختبار الويب حلقة استطلاع لا تنتهي (إبطال `['models']` كان يشمل استعلام
الدخول نفسه) فأُصلحت قبل الدفع.

لم يُشغَّل محليًا: بقية حِزم الخادم والويب وكل Playwright (يشغّلها CI على كل دفعة). لم أشغّل
الاختبارات الجديدة على الكود القديم؛ هي تطلب سلوكًا لم يكن موجودًا (انتقال، حقل `fallback`،
مسارات تسجيل الدخول كانت `501`). تسجيل الدخول لم يُجرَّب مع Hermes حقيقي: `start` يطلب خادم
OpenAI/Nous/xAI/MiniMax الحقيقي؛ جُرِّب مع خادم Hermes مكتوب يؤدّي تدفّق رمز الجهاز.

CI: التشغيل الثالث (36086904932) أخضر كله — lint/typecheck/contracts/tests/build، وPlaywright
كاملة على المركز الحقيقي، وصورة Docker تجيب `/health`، وdb:generate/migrate (SQLite وPostgreSQL)،
وسجل التغيير، وgraphify. `main` لم يتحرك منذ فتح الفرع (آخره beb539e)، فلا دمج مطلوب.

## المخاطر والرجوع
- **ملكية `fallback_providers`**: حيث للبروفايل نموذج محادثة في المركز، يكتب المركز السلسلة —
  سلسلة كتبها أحد بـ `hermes fallback` تُستبدل (تُفرَّغ إن كانت سلسلة المركز فارغة). مذكور في §54.
- **Hermes يقرر بنفسه** ما يتجاوزه؛ القاعدة المكتوبة أعلاه قاعدة المركز للوكيل `direct`.
- **سبب الفشل عند Hermes** يُقرأ من سطر حالة إنجليزي؛ إن تغيّرت صياغته يبقى الانتقال معروفًا من
  `usage.model` بلا سبب (`error: null`).
- **كلام المزوّد** يظهر كما أرسله (قد يكون JSON خامًا كما في لقطة Playwright) — سلوك قائم لرسائل
  الفشل، لم أغيّره.
- **تسجيل الدخول في الذاكرة**: إعادة تشغيل المركز تنسى الدخول الجاري (`404`)، والشخص يبدأ من جديد.
- الرجوع: التراجع عن الدمج يكفي؛ لا ترحيل قاعدة بيانات (ما فشل محفوظ في عمود `runs.timing`
  القائم)، والمفتاح `fallback_providers` يبقى في ملفات Hermes حتى يُحذف يدويًا أو بـ
  `hermes fallback`.

## التسليم والخطوة التالية
- المالك: تأكيد §54 و§55 (خصوصًا: عدم الانتقال عند 401/403، ملكية `fallback_providers`، ترك
  السلسلة لكل وكيل لقرار لاحق، والاكتفاء بمزوّدي Hermes الأربعة لتسجيل الدخول).
- بعد الدمج: تجربة تسجيل دخول ChatGPT/Codex حقيقي من صورة الاختبار.
