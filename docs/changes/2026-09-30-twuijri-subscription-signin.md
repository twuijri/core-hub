# الدخول بالاشتراكات عبر CLIProxyAPI المرفق مع المركز، وHermes على نماذج Core Hub
المسؤول: twuijri · الفرع: feat/subscription-signin (يحمل المرحلتين 1 و2 أيضًا، PR #232 إلى main) · الحالة: review

## المشكلة والهدف
قرار المالك الصريح (2026-09-30): كل مزوّد يُربط **بتسجيل الدخول إلى حساب** (Claude وChatGPT/Codex وGoogle Antigravity
وxAI وKimi وMeta وDevin، أي كل ما يدعمه CLIProxyAPI 8.0.4) ينتقل إلى CLIProxyAPI المرفق مع المركز، فنستعمل دخوله
وأدواته: الاستهلاك، والمتبقي من الحصة، ومواعيد التصفير، وأخطاء كل حساب، وحسابات متعددة، وإعادة الدخول. المزوّدون
بالمفتاح أو العنوان يبقون كما هم تمامًا. لا يحكم المركز على شروط المزوّدين ولا يمنع أحدًا؛ جملة محايدة واحدة فقط.
والرمز القصير مفضّل حيث يدعمه CLIProxyAPI، وإلا فالرابط ولصق العنوان من واجهة الويب، على خادم Docker بلا متصفح.
ويريد المالك أيضًا أن يستعمل Hermes النماذج عبر البوابة، ومساعد نقل لدخول Hermes القديم، ثم تقاعد دخول Hermes بعد
الانتقال مع إبقائه يعمل حتى ذلك الحين.

ثم قرار المالك الأحدث (2026-09-30) الذي يلغي «الاختياري»: «ابي كل الايجنتات تمر عن طريقنا مالها اتصال بنفسها … كل شي
يكون عن طريق الهب بدون زر» (DECISIONS §144). وملاحظاته على preview.38: إعادة تشغيل Hermes تلقائيًا بعد كل تغيير بلا زر،
واسم النموذج مقروءًا في لوحة الجاهزية (§145)، وقائمة مزوّدين واحدة بشعارات الشركات، وشكل واحد لكل القوائم المنسدلة (§146).

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
- **Hermes على نماذج Core Hub** (كما كُتب أولًا في §143؛ عدّله §144 أدناه: لا مفتاح): كل صف تخدمه
  البوابة يصير كتلة `corehub-gw-<slug>` في `providers:` على عنوانه الخاص في البوابة
  (`/gateway/row/<الصف>/anthropic` بـ`anthropic_messages` لنماذج Claude فيبقى التخزين المؤقت للموجّه، و`/openai/v1`
  بـ`responses` لـOpenAI وChatGPT، و`chat_completions` لغيرها)، بتوكن طويل العمر لكل بروفايل
  (`chgwh_<workspace>.<HMAC>` موقّع بـ`hermes-token.key`، في `.env` ذلك البروفايل فقط)، ومعرّف النموذج يبقى معرّف المزوّد.
  البوابة تطلب المنفذ نفسه في كل تشغيل (`gateway.port`) فلا تتغير ملفات Hermes. الصوت والتضمينات وصور ChatGPT عبر
  Hermes وCodex app-server تبقى كما هي.
- **§144 — كل الوكلاء عبر المركز بلا زر** (قرار المالك، يلغي الجزء الاختياري من §140–§143):
  - **Hermes**: حُذف مفتاح «Hermes يستخدم نماذج Core Hub» وعمليتاه (`models.getHermesModelSource` /
    `models.setHermesModelSource`) ومخطط `HermesModelSource` — أُضيفت في هذا التغيير نفسه ولم تصدر (أساس التوافق v1.1.5
    بدونها)، فحذفها لا يكسر عميلًا صادرًا. كل مركز بوابته متاحة يكتب كتل البوابة لـHermes عند كل إقلاع وكل تغيير، وملف
    `hermes-models.json` من نسخة تجريبية لا يقرؤه أحد. وحُذف «مخرج الطوارئ» (طريق Hermes الأصلي في آخر سلسلة البدائل).
    الصفوف التي لا تخدمها البوابة (دخول Nous وMiniMax عبر Hermes) تبقى لـHermes. `COREHUB_MODEL_GATEWAY=off` مفتاح المشغّل
    وحده يعيد Hermes لطرقه.
  - **Hermes الشخصي على الجهاز**: لا يكتب المركز `~/.hermes` أبدًا. كل دور Hermes يبدؤه المركز (الويب والجوال والقنوات
    وسير العمل والجداول) يعمل في بيت Hermes الخاص بالمركز `${DATA_DIR}/hermes` (ADR 0021 القرار 3، `hermes-runtime.ts`:
    `HERMES_HOME` للـTUI gateway وللـgateway الذي يشرف عليه المركز في كل الأوضاع؛ لا يُشارَك إلا حالة اعتماديات التثبيت
    برابط داخل بيت المركز، وعزل مجلد القفل في §129 يفصل البوابتين). فكتل البوابة والتوكن تُكتب هناك فقط: رسائل Core Hub
    تمرّ عبر البوابة، ورسائل الشخص من تطبيق Hermes الخاص به تبقى على إعداده. حدّ معروف: في وضع `external` (Hermes يشغّله
    غيرنا على العنوان) المهام التي يشغّلها ذلك الـgateway بنفسه تتبع ملفاته.
  - **وكلاء البرمجة**: لا خيار «مصدر النماذج» (أُزيل قسم `models` من نموذج الإعدادات الذي يرسمه الخادم للويب وiOS
    وAndroid)، ودخول الوكيل بحسابه على الجهاز لا يُحتسب، و`COREHUB_AGENT_MODEL_SOURCE` يُقبل ويُتجاهل. إن لم يكن لدى
    المركز نموذج للوكيل (لا نموذج ولا افتراضي، أو مزوّد لا تخدمه البوابة، أو نسخة أقدم من ربطها، أو بوابة لم تبدأ، أو ملف
    إعداد لا يُكتب) يفشل الدور قبل أن تبدأ أي عملية بـ`provider_not_configured` وكلمات تقول ما العمل (الإعدادات ← النماذج،
    أو منتقي النماذج، أو الوكلاء)، ولا يعمل على حساب الوكيل أبدًا.
  - **التوافق**: `Agent.model_source` باقٍ في العقد (`hub` أو غائب)، و`agent` لم يعد يُرسل. تطبيق قديم يرسل
    `PATCH /agents/{id}/settings` بقسم `models` و`model_source` وحده يُجاب 200 ولا يتغير شيء.
- **§145 — إعادة تشغيل Hermes تلقائيًا بعد كل تغيير يحتاجها**: كل مسار يغيّر ما يقرؤه Hermes يجدول إعادة التشغيل نفسها
  المجمّعة (تنتظر انتهاء الرد الجاري، دقيقتان على الأكثر): إضافة مزوّد وتعديله وحذفه، والافتراضيات والبدائل، والصوت
  والصور، ودخول اشتراك — ومن الجديد: خروج آخر حساب في اشتراك من نافذته، وصف اشتراك تغيّرت حساباته خارج الدخول (قراءة كل
  دقيقة)، وتغيير لا تراه إلا ملفات بروفايل مسمّى (يقرؤها gateway رسائله). تقرير الجاهزية يقول إن كانت إعادة التشغيل في
  طريقها (`scheduled` / `waiting_for_run` في `detail`) فيقول الويب وiOS وAndroid «جارٍ تطبيق التغيير — يُعاد تشغيل هرمز
  تلقائيًا…» ويعيدون السؤال كل ثانيتين حتى يخضرّ؛ و«إعادة التشغيل الآن» لا تظهر إلا حين لا إعادة قادمة (مخرج استعادة).
  و«نموذج محادثة مختار» يعرض «<اسم المزوّد> · <النموذج>» بدل `corehub-gw-…/…`.
- **§146 — «إضافة مزوّد»**: تبويبان: «جاهز» و«مخصّص» (كما صحّح المالك). حُذف تبويب «الدخول باشتراك»: الاشتراكات في
  القائمة نفسها تحت «الاشتراكات» بوسم «اشتراك» وبأسمائها كما هي، واختيار أحدها يعرض سطر التفصيل (رمز قصير أو رابط، و«يعرض
  الاستهلاك ومواعيد التصفير») والجملة المحايدة و«متابعة لتسجيل الدخول». بعدها «بمفتاح API». لا تكرار: دخولا Hermes
  لـChatGPT وxAI لا يُعرضان. MiniMax وNous: وسم «اشتراك» وتفصيل «دخول برمز قصير عبر هرمز · لهرمز ووكيل كور هب نفسه» —
  **لم أخدمهما عبر البوابة**: يحتاج ذلك استعارة توكنات Hermes القصيرة العمر إلى CLIProxyAPI لكل استدعاء (لا يأخذ مفتاحًا إلا
  من ملفه، وتغيير الملف يعيد تشغيله) وترجمة Chat Completions لـNous لكل وكيل؛ فيفشل وكيل البرمجة الموجّه إليهما بجملة واضحة،
  ويستعملهما Hermes على طريقه في بيت المركز، ووكيل المركز الخاص بالاستعارة لكل دور (§118). القائمة هي `Select` نفسه الذي
  يستعمله منتقي الموافقات في المحرّر: شعار الشركة بلون العلامة الأخضر، والاسم عنوانًا والوسم بجانبه، والتفصيل تحته.
  الشعارات من `@lobehub/icons-static-svg` 1.95.1 (MIT، نفس مصدر شارات الوكلاء) ومن Simple Icons 16.33.0 (CC0) لـDeepgram،
  يولّدها `scripts/icons/vendor-logos.mjs`، وحرف أول لمن لا شعار له (LiteLLM، Nous)؛ مسجّلة في THIRD-PARTY-NOTICES.md.
  التصفية بالكتابة: البحث السريع في Radix ينقل إلى الاسم عند كتابته؛ لم أضف حقل تصفية (نحو ثلاثين صفًّا).
  **شكل واحد للقوائم المنسدلة**: مستطيل بحواف دائرية كرأس بطاقة «وقت التشغيل» وحدّ رفيع 1px وارتفاع مريح ونص عادي والسهم في
  آخر السطر (يسار في العربية)، في `Select` و`Combobox` معًا فيسري على كل النماذج والحوارات والمرشحات ومبدّل البروفايل. وأزرار
  شريط المحرّر (النموذج، «تلقائي»، الموافقات) بالشكل نفسه مصغّرًا كالأزرار الثانوية «اختبر»/«تعديل» — بلا استثناء كما طلب.
  الجوال: شاشة إضافة المزوّد في iOS وAndroid تبقى بقسمين حاليًا؛ القائمة الواحدة بالشعارات هناك متابعة لاحقة.
- **Hermes القديم «legacy»**: دخول Hermes يبقى يعمل للصفوف الموجودة. ChatGPT وxAI عبر Hermes يُعلَّمان بذلك ويعرضان
  «انقله إلى بوابة Core Hub»: دخول جديد (التوكن لا يُنسخ — OpenAI وAnthropic يدوّران توكن التحديث فيُخرج أحدهما الآخر)،
  وبعد الموافقة وجلب النماذج تنتقل اختيارات النماذج (الافتراضي والأدوار والبدائل وأعضاء المجموعات) إلى نفس النماذج في
  الصف الجديد، والقديم يبقى حتى يحذفه. الويب لم يعد يعرض إضافة هذين عبر Hermes حيث تتاح الاشتراكات
  (`ProviderPreset.replaced_by`). Nous وMiniMax يبقيان لـHermes (CLIProxyAPI لا يدخل إليهما).
- **خطة الإزالة** مكتوبة في §143: `signed-in-chat.ts` ونصف Hermes من `live-models.ts` وبروتوكول `codex` للصور ومعظم
  `sign-in.ts`، في تغيير لاحق بعد انتقال مراكز المالك الحية وبكلمته.
- **الجوال**: صفحة المزوّد على iOS وAndroid تعرض حسابات الاشتراك وحالتها واستهلاكها و«افحص الآن»؛ «إضافة مزوّد» تعرض
  الاشتراكات؛ وصفحة الدخول تأخذ العنوان الملصوق. الإيقاف والتجديد والخروج والنقل على الويب وحده حاليًا.

**مراجعة القائمة مقابل CLIProxyAPI 8.0.4 (بعد ملاحظة المالك على preview.38)**: القائمة كاملة. واجهة الإدارة في 8.0.4
تقبل في `GET /v8/management/oauth/auth-url?provider=` هذه فقط: `claude`، `codex`، `antigravity`، `kimi`، `kimi-ai`،
`xai`، `devin`، `meta` (+ مزوّدي الإضافات، والإضافات مطفأة وبناء Linux هو `no-plugin`)؛ ومسارات v0 هي نفسها
(`anthropic-`/`codex-`/`antigravity-`/`kimi-`/`kimi-ai-`/`xai-`/`devin-`/`meta-auth-url`)؛ وأعلام سطر الأوامر كذلك. غير متاح في
8.0.4 مع السبب:
- **Gemini CLI (حساب Google)** و`/v0/management/gemini-cli-auth-url`: أُزيل من CLIProxyAPI في 2026-06-18، يوم أنهت Google
  دخول Gemini CLI للحسابات الشخصية؛ ومخزن الحسابات فيه يتجاهل ملفات `type: gemini`. حساب Google المتبقي هو Antigravity
  (موجود عندنا).
- **Qwen**: أُزيل في 2026-04-15. **iFlow**: أُزيل في 2026-04-17.
- **Vertex**: ليس دخولًا بل رفع ملف حساب خدمة (`/oauth/import?provider=vertex`)، أي مفتاح؛ خارج «الدخول باشتراك».
أثبتُّ ذلك في اختبار الملف الحقيقي: قائمة المركز تساوي الثمانية، و`auth-url` لـ`gemini-cli` و`gemini` و`qwen` و`iflow` يجيب 404.
**لا تكرار باسمين**: دخولا Hermes لـChatGPT وxAI (`openai-codex`، `xai-oauth`) يحملان `replaced_by`، فلا تعرضهما قائمة الـPresets
في الويب ولا في iOS وAndroid حين تتاح الاشتراكات (كان الجوال يعرضهما بجانب قسم الاشتراكات). MiniMax وNous عبر Hermes باقيان
كما طلب المالك، ولا يعرضهما CLIProxyAPI فلا تكرار.

قرارات جديدة بانتظار تأكيد المالك: عرض كل المزوّدين الذين يدعمهم CLIProxyAPI بما فيهم Claude وAntigravity وDevin
وMeta (قراره: لا حكم)؛ «افحص الآن» على عناوين غير موثّقة (طلبه). §144 و§145 و§146 من كلام المالك نفسه.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
إضافات فقط (`contracts:compat` نظيف مقابل v1.1.5):
- عمليات جديدة: `models.listSubscriptionVendors`، `models.getProviderAccounts`، `models.updateProviderAccount`،
  `models.removeProviderAccount`، `models.refreshProviderAccount`، `models.checkProviderAccount`،
  `models.moveProviderToGateway` (و`models.getHermesModelSource`/`setHermesModelSource` أُضيفتا ثم حُذفتا في §144 قبل أي
  إصدار).
- مخططات جديدة: `SubscriptionVendors`، `SubscriptionVendor`، `ProviderSubscription`، `ProviderGatewayMove`،
  `ProviderMove`، `ProviderAccounts`، `ProviderAccount`، `UsageWindow`، `ProviderAccountError`،
  `ProviderAccountPatch`؛ ومعامل `ProviderAccountId`.
- حقول اختيارية جديدة: `Provider.subscription`، `Provider.gateway_move`، `ProviderSignIn.callback_hint`،
  `ProviderPreset.replaced_by`.
- `models.completeProviderSignIn` صار يقبل عنوانًا لدخول الرابط (كان 409 لكل دخول)؛ ووصف `Model.agent_gateway` يشمل
  اشتراكات البوابة. التطبيق الأقدم لا يرى إعدادات الاشتراك في قائمة الـpresets، والمركز الأقدم يجيب 404 فيخفي العميل الجديد
  الميزة.
- وصف `Agent.model_source` (§144: `hub` فقط الآن) ووصف `RuntimeCheck.detail` (§145: قيم `scheduled`/`waiting_for_run`،
  و«<المزوّد> · <النموذج>») — أوصاف فقط، بلا تغيير مخطط.

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
- §144: الخادم `agents/service.ts` (`modelSourceFor`، `gatewayMiss`، قبول `model_source` القديم وتجاهله)،
  `agents/runner.ts` (الفشل الواضح بدل حساب الوكيل)، `agents/adapters/acp.ts` (بلا قسم `models`)، `agents/ports.ts`
  و`gateway/gateway.ts` (`enabled()`)، `agents/index.ts`، `app/config.ts` و`Dockerfile` (المتغير متقاعد)،
  `models/index.ts` و`models/service.ts` (بلا مفتاح ولا مخرج طوارئ، وحُذف `models/hermes-source.ts`)؛ الويب حُذف
  `HermesSourceCard.tsx`؛ الاختبارات `hermes-gateway.test.ts` و`hub-gateway.test.ts` و`runner-gateway.test.ts`.
- §145: `models/service.ts` (`propagateToProfiles` يعيد ما تغيّر، `syncSignedIn`/`syncSubscriptionRows`،
  `restartState`، `chatModelName`)، `models/index.ts` (قراءة كل دقيقة)، اختبار جديد `gateway/hermes-restart.test.ts`،
  تحديث `models-api.test.ts`؛ الويب `RuntimeChecks.tsx` و`queries.ts` (السؤال كل ثانيتين) واختبارا `agent-restart.test.tsx`
  و`i18n.test.ts`؛ iOS `ModelsRuntime.swift` ونصوص `models_runtime.*.json`؛ Android `ModelsRuntimeCard.kt` ونصوص
  `runtime.*.json`.
- §146: الويب `AddProviderDialog.tsx`، `SubscriptionSignIn.tsx`، `ui/Select.tsx` (`badge`، `block`)، `ui/Combobox.tsx`،
  `ui/brand/VendorLogo.tsx` و`ui/brand/vendor-logos.generated.ts` (جديدان)، `styles/app.css` (شكل المشغّل الواحد والشعارات)،
  ونصوص `i18n/*.json`؛ `scripts/icons/vendor-logos.mjs` (جديد)؛ `THIRD-PARTY-NOTICES.md`؛ الاختبارات
  `subscription-signin.test.tsx` ورحلة Playwright واللقطات (`provider-list-ar-light.png` جديدة، ولقطات `design-*` محدّثة).
- حجم الصورة والمثبّتات: بلا تغيير (CLIProxyAPI موجود فيها منذ ADR 0029). الشعارات نحو 19 KB في الويب.

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
      Tests  4 passed (4)
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

فحوص §144–§146 (هذه الجولة، على الرأس قبل الدفع):
```
$ pnpm contracts:lint && pnpm contracts:generate && pnpm contracts:check-clients && pnpm contracts:compat
contracts:lint  OK · contracts:generate:native  OK · check-clients  OK — 1151 client file(s) scanned, 274 contract path(s) known.
contracts:compat  OK — no breaking change against v1.1.5
$ pnpm contract:test
 Test Files  20 passed (20)      Tests  436 passed (436)
$ tsc --noEmit -p tsconfig.json   (packages/server)   → (exit 0)
$ pnpm --filter @corehub/web typecheck                → (exit 0)
$ vitest run --maxWorkers=2 src/modules/agents src/modules/models tests/unit/config.test.ts   (packages/server)
 Test Files  91 passed | 26 skipped (117)      Tests  1119 passed | 97 skipped (1216)
$ vitest run --maxWorkers=2 src/modules/models   (بعد §145)
      Tests  291 passed | 17 skipped (308)
$ vitest run tests/unit/status.test.ts   → 1 passed
$ vitest run tests/agent-restart.test.tsx tests/i18n.test.ts tests/models-screen.test.tsx   (packages/web)
      Tests  42 passed (42)
$ vitest run tests/subscription-signin.test.tsx tests/models-screen.test.tsx   (packages/web، بعد §146)
      Tests  35 passed (35)
$ node scripts/i18n-check.mjs → i18n:check  OK · node scripts/i18n/limits.mjs → i18n:limits  OK
$ node scripts/icons/vendor-logos.mjs --check → vendor-logos: OK
$ ./gradlew --no-daemon :app:compileDebugKotlin   (apps/android) → نجح
$ PLAYWRIGHT_CHANNEL=chrome playwright test --workers=1 e2e/zzzzzzzzzzzzzzzz-subscriptions.spec.ts e2e/zz-design.spec.ts
  e2e/zzzzz-providers-scopes.spec.ts e2e/zzzzzzzzzzz-design-family.spec.ts e2e/zzzzzzzzzzzzzzzzz-pseudo-locales.spec.ts
  12 passed (en-XA وar-XB وzh-XC وth-XD على الحاسوب والجوال)
```

## المخاطر والرجوع
- **شروط المزوّدين**: المركز يشغّل دخول المزوّدين بعملاء أدواتهم كما يقدّمها CLIProxyAPI. القرار للشخص؛ جملة محايدة واحدة.
- **عناوين «افحص الآن» غير موثّقة** وقد تتغير: القراءة الفاشلة تُقال ولا تغيّر شيئًا؛ النوافذ السلبية من الترويسات تبقى.
- **تغيّر CLIProxyAPI السريع**: الإصدار مثبّت، وكل استدعاء إداري يمرّ في اختبار الملف الحقيقي المطلوب في CI.
- **عدادات الطلبات والنوافذ السلبية في ذاكرة CLIProxyAPI**: تبدأ من جديد عند إعادة تشغيله أو تغيير مزوّدي المفاتيح.
- **Hermes على البوابة نقطة عطل واحدة** (§144 أزال طريق Hermes الأصلي من آخر السلسلة بطلب المالك): إن تعطلت البوابة
  لا يجيب Hermes على النماذج التي تخدمها حتى تعود. لم يُشغَّل مع Hermes حقيقي بعد (اختبار الوحدة يثبت الكتل والتوكن ووصول
  استدعاء بطريقة Hermes إلى الصف).
- **وكيل برمجة بلا نموذج في المركز** صار يفشل بجملة واضحة بدل أن يعمل على حسابه (§144)؛ من اعتاد حساب الوكيل يحتاج مزوّدًا
  في الإعدادات ← النماذج.
- **شكل القوائم المنسدلة تغيّر في كل الشاشات** (§146): فحوص العرض المزيّفة (أربع لغات، حاسوب وجوال) خضراء؛ قد يلاحظ المالك
  شاشة تحتاج لمسة.
- **الرجوع**: `COREHUB_MODEL_GATEWAY=off` يطفئ كل ذلك (Hermes يعود لمزوّديه في الكتابة التالية ووكلاء البرمجة لمفاتيح
  البروفايل كما قبل البوابة)؛ حذف صف الاشتراك يسجّل خروج حساباته. لا ترحيل قاعدة بيانات؛ الملفات الجديدة في
  `<DATA_DIR>/gateway/`. لا كسر لشيء قائم: دخول Hermes يعمل كما كان، والمزوّدون بالمفتاح بلا تغيير.

## التسليم والخطوة التالية
قرار المالك (2026-09-30): كل البوابة تُدمج في main دفعة واحدة ثم 1.1.6. لذا صار PR #232 موجّهًا إلى `main` ويحمل المرحلة 1
(#229) والمرحلة 2 وإصلاحات التجربة الحية (#231) والاشتراكات، بعد دمج آخر رأس لـ`feat/model-gateway-2`؛ #229 و#231 يغلقهما
المالك. https://github.com/twuijri/core-hub/pull/232 (مسودة). التالي: CI أخضر؛ تأكيد المالك لقرارات §143؛
القائمة الواحدة بالشعارات على iOS وAndroid (متابعة)؛ خدمة دخول MiniMax وNous عبر البوابة إن أرادها المالك (تصميم منفصل)؛
تجربة حية بحساب حقيقي (ChatGPT بالرمز على الخادم)؛ ثم تقاعد مسارات Hermes المستعارة حسب خطة الإزالة، وطلب client ID خاص
بـCore Hub لبرنامج «Sign in with ChatGPT».
