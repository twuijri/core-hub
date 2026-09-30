# الدخول بالاشتراكات عبر CLIProxyAPI المرفق مع المركز، وHermes على نماذج Core Hub
المسؤول: twuijri · الفرع: feat/subscription-signin (يحمل المرحلتين 1 و2 أيضًا، PR #232 إلى main) · الحالة: review

## المشكلة والهدف
قرار المالك الصريح (2026-09-30): كل مزوّد يُربط **بتسجيل الدخول إلى حساب** (Claude وChatGPT/Codex وGoogle Antigravity
وxAI وKimi وMeta وDevin، أي كل ما يدعمه CLIProxyAPI 8.0.4) ينتقل إلى CLIProxyAPI المرفق مع المركز، فنستعمل دخوله
وأدواته: الاستهلاك، والمتبقي من الحصة، ومواعيد التصفير، وأخطاء كل حساب، وحسابات متعددة، وإعادة الدخول. المزوّدون
بالمفتاح أو العنوان يبقون كما هم تمامًا. لا يحكم المركز على شروط المزوّدين ولا يمنع أحدًا؛ جملة محايدة واحدة فقط.
والرمز القصير مفضّل حيث يدعمه CLIProxyAPI، وإلا فالرابط ولصق العنوان من واجهة الويب، على خادم Docker بلا متصفح.
ويريد المالك أيضًا أن يستعمل Hermes النماذج عبر البوابة (اختياري لكل مركز مع رجوع)، ومساعد نقل لدخول Hermes القديم،
ثم تقاعد دخول Hermes بعد الانتقال مع إبقائه يعمل حتى ذلك الحين.

## القرار والموافقات
ADR 0030 (قرار المالك) وDECISIONS §143 (التفاصيل مقترحة — بانتظار تأكيد المالك). باختصار:

- **واجهة الإدارة في CLIProxyAPI مفعّلة للمركز وحده**: على loopback فقط، بسرّ عشوائي يصنعه المركز عند كل تشغيل
  ويبقى في ذاكرته، ولوحة التحكم ومحدّثها مطفآن. وحدة جديدة في `models` تغلّفها (`gateway/cliproxy-management.ts`).
- **الرمز القصير**: xAI وKimi (kimi.com وkimi.ai) وMeta عبر واجهة الإدارة؛ وChatGPT بتشغيل
  `cli-proxy-api -codex-device-login -no-browser` عملية فرعية كما يشغّل المركز دخول الوكلاء (§106)، وقراءة الرابط
  والرمز مما تطبعه (الأمر يخرج بـ0 نجح أو لم ينجح، فالنجاح هو جملته «Codex device authentication successful» فقط).
- **الرابط ولصق العنوان**: Claude وGoogle Antigravity وDevin — يفتح الشخص صفحة المزوّد، ثم يلصق العنوان الذي وصل إليه
  المتصفح (`http://localhost:…/callback?code=…&state=…`) في المركز. نرسل العنوان كما هو فيتحقق CLIProxyAPI من `state`
  الذي فيه، فيُرفض عنوان من دخول أقدم (اكتشفت هذا باختبار الملف الحقيقي: كان CLIProxyAPI يقدّم `state` في الجسم على الذي
  في العنوان).
- **الحساب يتبع صفًّا**: بعد الموافقة يجد المركز الحساب الذي حفظه CLIProxyAPI ويضع له `prefix: h<الصف>` و
  `note: corehub:<الصف>` و`disable_cooling: false`، فيصل `h<الصف>/<النموذج>` في البوابة إلى حسابات ذلك الصف وحدها بالتناوب،
  ويبرد الحساب الذي انتهت حصته حتى تصفيرها بينما يجيب الآخرون. نماذج الصف هي ما يخدمه CLIProxyAPI تحت البادئة
  (`/v1/models`، مع نوافذ السياق)، وتصل كل الوكلاء عبر البوابة، ووكيل المركز الخاص (`direct`) أيضًا.
- **نافذة المزوّد (Dialog، لا صفحة)**: الضغط على بطاقة الاشتراك يفتحها: لكل حساب الحالة وآخر خطأ ووقت إعادة
  المحاولة، والطلبات (المجموع و20 عمودًا بعشر دقائق)، ونوافذ الاستهلاك مع المتبقي ووقت التصفير (Claude وChatGPT من
  ترويسات آخر إجابة)، و«افحص الآن» (عبر `api-call` في CLIProxyAPI، والتوكن لا يخرج منه — عناوين الاستهلاك غير موثّقة
  عند المزوّدين، فما لا يُقرأ يُقال ولا يغيّر شيئًا)، وتجديد الدخول، والإيقاف والتشغيل، وتسجيل الخروج، و«سجّل دخول حساب
  آخر». وتحتها آخر أخطاء المزوّد.
- **الجملة المحايدة الوحيدة**: «بعض المزوّدين يقيّدون استخدام الاشتراك خارج تطبيقاتهم.» لا منع ولا حكم.
- **Hermes على نماذج Core Hub**: مفتاح واحد للمركز (`<DATA_DIR>/gateway/hermes-models.json`، بلا ترحيل). كل صف تخدمه
  البوابة يصير كتلة `corehub-gw-<slug>` في `providers:` على عنوانه الخاص في البوابة
  (`/gateway/row/<الصف>/anthropic` بـ`anthropic_messages` لنماذج Claude فيبقى التخزين المؤقت للموجّه، و`/openai/v1`
  بـ`responses` لـOpenAI وChatGPT، و`chat_completions` لغيرها)، بتوكن طويل العمر لكل بروفايل
  (`chgwh_<workspace>.<HMAC>` موقّع بـ`hermes-token.key`، في `.env` ذلك البروفايل فقط)، ومعرّف النموذج يبقى معرّف المزوّد.
  سلسلة البدائل تنتهي بطريق Hermes الأصلي إلى نموذج المحادثة إن كان بمفتاح، فيجيب Hermes لو تعطلت البوابة. البوابة تطلب
  المنفذ نفسه في كل تشغيل (`gateway.port`) فلا تتغير ملفات Hermes. **المركز الجديد يبدأ عليه، والمركز الذي فيه مزوّدون يبقى
  Hermes فيه كما هو حتى يبدّل المالك.** الرجوع مفتاح واحد يحذف كتل المركز والتوكن فقط. الصوت والتضمينات وصور ChatGPT عبر
  Hermes وCodex app-server تبقى كما هي.
- **Hermes القديم «legacy»**: دخول Hermes يبقى يعمل للصفوف الموجودة. ChatGPT وxAI عبر Hermes يُعلَّمان بذلك ويعرضان
  «انقله إلى بوابة Core Hub»: دخول جديد (التوكن لا يُنسخ — OpenAI وAnthropic يدوّران توكن التحديث فيُخرج أحدهما الآخر)،
  وبعد الموافقة وجلب النماذج تنتقل اختيارات النماذج (الافتراضي والأدوار والبدائل وأعضاء المجموعات) إلى نفس النماذج في
  الصف الجديد، والقديم يبقى حتى يحذفه. الويب لم يعد يعرض إضافة هذين عبر Hermes حيث تتاح الاشتراكات
  (`ProviderPreset.replaced_by`). Nous وMiniMax يبقيان لـHermes (CLIProxyAPI لا يدخل إليهما).
- **خطة الإزالة** مكتوبة في §143: `signed-in-chat.ts` ونصف Hermes من `live-models.ts` وبروتوكول `codex` للصور ومعظم
  `sign-in.ts`، في تغيير لاحق بعد انتقال مراكز المالك الحية وبكلمته.
- **الجوال**: صفحة المزوّد على iOS وAndroid تعرض حسابات الاشتراك وحالتها واستهلاكها و«افحص الآن»؛ «إضافة مزوّد» تعرض
  الاشتراكات؛ وصفحة الدخول تأخذ العنوان الملصوق. الإيقاف والتجديد والخروج والنقل على الويب وحده حاليًا.

قرارات جديدة بانتظار تأكيد المالك: عرض كل المزوّدين الذين يدعمهم CLIProxyAPI بما فيهم Claude وAntigravity وDevin
وMeta (قراره: لا حكم)؛ Hermes على البوابة افتراضيًا للمراكز الجديدة فقط؛ «افحص الآن» على عناوين غير موثّقة (طلبه).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
إضافات فقط (`contracts:compat` نظيف مقابل v1.1.5):
- عمليات جديدة: `models.listSubscriptionVendors`، `models.getProviderAccounts`، `models.updateProviderAccount`،
  `models.removeProviderAccount`، `models.refreshProviderAccount`، `models.checkProviderAccount`،
  `models.moveProviderToGateway`، `models.getHermesModelSource`، `models.setHermesModelSource`.
- مخططات جديدة: `SubscriptionVendors`، `SubscriptionVendor`، `ProviderSubscription`، `ProviderGatewayMove`،
  `ProviderMove`، `ProviderAccounts`، `ProviderAccount`، `UsageWindow`، `ProviderAccountError`،
  `ProviderAccountPatch`، `HermesModelSource`؛ ومعامل `ProviderAccountId`.
- حقول اختيارية جديدة: `Provider.subscription`، `Provider.gateway_move`، `ProviderSignIn.callback_hint`،
  `ProviderPreset.replaced_by`.
- `models.completeProviderSignIn` صار يقبل عنوانًا لدخول الرابط (كان 409 لكل دخول)؛ ووصف `Model.agent_gateway` يشمل
  اشتراكات البوابة. التطبيق الأقدم لا يرى إعدادات الاشتراك في قائمة الـpresets، والمركز الأقدم يجيب 404 فيخفي العميل الجديد
  الميزة.

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml`.
- الخادم: `models/catalogue.ts` (إعدادات الاشتراكات الثمانية، `gatewaySignIn`، `gatewayMove`)،
  `models/subscriptions.ts` (الدخول والحسابات والنوافذ والأخطاء وقراءة «افحص الآن»)،
  `models/gateway/cliproxy-management.ts`، `models/gateway/cliproxy-login.ts` (دخول ChatGPT بالرمز)،
  `models/gateway/cliproxy-config.ts` و`cliproxy.ts` (واجهة الإدارة، مخزن الحسابات، البصمة بلا صفوف الاشتراك)،
  `models/gateway/gateway.ts` (عناوين الصفوف، توكنات Hermes، المنفذ الثابت، مسار `direct`)، `gateway/tokens.ts`،
  `models/hermes-source.ts`، `models/service.ts`، `models/serialize.ts`، `models/index.ts` (المسارات والإقلاع)،
  `models/propagation.ts` (`anthropic_messages`)، ونصوص الخادم في `i18n/ar.json` و`en.json`.
- الاختبارات: `gateway/subscriptions.test.ts`، `gateway/hermes-gateway.test.ts`، `gateway/subscriptions.real.test.ts`،
  `gateway/testing/fake-cliproxy-accounts.mjs` و`vendor-mitm.ts` وتحديث `fake-cliproxy.mjs`، وتعديل اختبارين قائمين
  (`gateway.test.ts` لواجهة الإدارة، `hub-gateway.test.ts` لاختيار أحدث ملف إعداد).
- الويب: `models/SubscriptionSignIn.tsx`، `ProviderAccountsDialog.tsx`، `MoveToGatewayDialog.tsx`،
  `HermesSourceCard.tsx`، و`SignInPanel.tsx` (لصق العنوان، عزل الاسم)، `AddProviderDialog.tsx`، `ModelsScreen.tsx`،
  `queries.ts`، `types.ts`، `styles/screens.css`، ونصوص `i18n/ar.json` و`en.json`؛ اختبار
  `tests/subscription-signin.test.tsx`؛ رحلة Playwright `e2e/zzzzzzzzzzzzzzzz-subscriptions.spec.ts` و`e2e/hub.ts`
  (بديل CLIProxyAPI) وثلاث لقطات.
- الجوال: iOS `Settings/Models/ModelsAccounts.swift` وتعديل `ModelsProviders.swift` و`ModelsAddProvider.swift`
  ونصوص `i18n/subscriptions.*.json`؛ Android `screens/models/ModelsAccounts.kt` وتعديل `ModelsScreen.kt`
  و`ModelsProvidersTab.kt` و`ModelsAddProvider.kt` ونصوص `i18n/subscriptions.*.json`.
- CI: ملف الاختبار الحقيقي أُضيف إلى وظيفة `model-gateway-real` المطلوبة.
- التوثيق: ADR 0030، DECISIONS §143، `docs/guides/any-model-any-agent.md`، `docs/DEPLOY.md`، `docs/STATUS.md`.
- حجم الصورة والمثبّتات: بلا تغيير (CLIProxyAPI موجود فيها منذ ADR 0029).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
(exit 0)
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:compat
contracts:compat  OK — no breaking change against v1.1.5
$ pnpm migrations:guard
migrations:guard  OK — no breaking change against v1.1.5
$ pnpm contracts:check-clients
check-clients  OK — 1152 client file(s) scanned, 275 contract path(s) known.
$ pnpm contract:test
 Test Files  20 passed (20)
      Tests  438 passed (438)
$ pnpm i18n:check
i18n:check  OK
$ pnpm i18n:limits
i18n:limits  OK
$ pnpm nav:check
nav:check  OK — 41 destinations, 2 pre-auth screens (login, setup), 47 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm scripts:test
ℹ tests 119 · pass 119 · fail 0
$ vitest run --project unit --maxWorkers=2 src/modules/models      (packages/server)
 Test Files  23 passed | 3 skipped (26)
      Tests  283 passed | 16 skipped (299)
$ vitest run --project unit --maxWorkers=2 src/modules/agents      (packages/server)
 Test Files  67 passed | 23 skipped (90)
      Tests  820 passed | 78 skipped (898)
$ COREHUB_REAL_GATEWAY=1 vitest run --project unit --maxWorkers=1 src/modules/models/gateway/subscriptions.real.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
$ vitest run tests/subscription-signin.test.tsx tests/models-screen.test.tsx tests/model-fallback-signin.test.tsx tests/logical-css.test.ts tests/i18n.test.ts   (packages/web)
 Test Files  5 passed (5)
      Tests  392 passed (392)
$ pnpm build
(exit 0)
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzzzzzzzzzzzz-subscriptions.spec.ts e2e/zzzzz-providers-scopes.spec.ts --workers=1
  2 passed (23.6s)
$ JAVA_HOME=jdk17 pnpm --filter @corehub/contracts generate:native
contracts:generate:native  OK
$ ./gradlew :app:compileDebugKotlin      (apps/android)
BUILD SUCCESSFUL in 1m 19s
```
iOS لم يُبنَ محليًا (لا Xcode على Linux)؛ يبنيه CI. نتيجة CI تُضاف هنا بعد الدفع.

## المخاطر والرجوع
- **شروط المزوّدين**: المركز يشغّل دخول المزوّدين بعملاء أدواتهم كما يقدّمها CLIProxyAPI. القرار للشخص؛ جملة محايدة واحدة.
- **عناوين «افحص الآن» غير موثّقة** وقد تتغير: القراءة الفاشلة تُقال ولا تغيّر شيئًا؛ النوافذ السلبية من الترويسات تبقى.
- **تغيّر CLIProxyAPI السريع**: الإصدار مثبّت، وكل استدعاء إداري يمرّ في اختبار الملف الحقيقي المطلوب في CI.
- **عدادات الطلبات والنوافذ السلبية في ذاكرة CLIProxyAPI**: تبدأ من جديد عند إعادة تشغيله أو تغيير مزوّدي المفاتيح.
- **Hermes على البوابة نقطة عطل واحدة**: السلسلة تنتهي بطريق Hermes الأصلي حيث يوجد مفتاح. لم يُشغَّل مع Hermes حقيقي بعد
  (اختبار الوحدة يثبت الكتل والتوكن ووصول استدعاء بطريقة Hermes إلى الصف).
- **الرجوع**: `COREHUB_MODEL_GATEWAY=off` يطفئ كل ذلك (Hermes يعود لمزوّديه في الكتابة التالية)؛ مفتاح «Hermes يستخدم نماذج
  Core Hub» يرجع Hermes وحده؛ حذف صف الاشتراك يسجّل خروج حساباته. لا ترحيل قاعدة بيانات؛ الملفات الجديدة في
  `<DATA_DIR>/gateway/`. لا كسر لشيء قائم: دخول Hermes يعمل كما كان، والمزوّدون بالمفتاح بلا تغيير.

## التسليم والخطوة التالية
قرار المالك (2026-09-30): كل البوابة تُدمج في main دفعة واحدة ثم 1.1.6. لذا صار PR #232 موجّهًا إلى `main` ويحمل المرحلة 1
(#229) والمرحلة 2 وإصلاحات التجربة الحية (#231) والاشتراكات، بعد دمج آخر رأس لـ`feat/model-gateway-2`؛ #229 و#231 يغلقهما
المالك. https://github.com/twuijri/core-hub/pull/232 (مسودة). التالي: CI أخضر؛ تأكيد المالك لقرارات §143؛
تجربة حية بحساب حقيقي (ChatGPT بالرمز على الخادم)؛ ثم تقاعد مسارات Hermes المستعارة حسب خطة الإزالة، وطلب client ID خاص
بـCore Hub لبرنامج «Sign in with ChatGPT».
