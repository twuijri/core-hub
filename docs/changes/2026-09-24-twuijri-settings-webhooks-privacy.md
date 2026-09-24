# آخر صفحتين في الإعدادات على الويب: خطافات الويب والخصوصية، مع «بروفايل» في رسائل الخادم وطيّ بطاقة وقت التشغيل
المسؤول: twuijri · الفرع: feat/settings-webhooks-privacy · الحالة: review

## المشكلة والهدف
في `packages/web/src/settings/SettingsScreen.tsx` لا مدخل لـ`webhooks` ولا لـ`privacy` في
خريطة `SECTIONS`، فكلتاهما تعرض الصفحة المؤقتة، مع أن الخادم يجيب عمليات الخطافات كلها.
والهدف أربعة أشياء:
1. صفحة **خطافات الويب** (للمشرف): القائمة، الإضافة والتعديل، التفعيل والإيقاف، إرسال
   تجريبي، وآخر التسليمات بحالتها ورمز الرد.
2. صفحة **الخصوصية** من عمليات موجودة فعلًا، بلا زر لا يفعل شيئًا.
3. رسائل الخادم التي ما زالت تقول «مساحة العمل» / "workspace" تقول «البروفايل» / "profile".
4. بطاقة «وقت التشغيل» في صفحة النماذج تنطوي إلى سطر واحد «كل شيء يعمل» حين تنجح كل
   الفحوص، وتنفتح وحدها حين يفشل أحدها.

`this_device` لسطح المكتب والهواتف فقط (`surfaces` في `navigation.json`)، والويب لا يسرده
اليوم: `SETTINGS_IDS` و`visibleEntries` يستبعدانه، واختبار التكافؤ
(`tests/navigation.parity.test.tsx`) يثبت ذلك، والرحلة ٢٤ تتحقق أنه غير موجود في قائمة
الإعدادات. لم يتغيّر فيه شيء.

## القرار والموافقات
المهمة من المنسّق نيابة عن المالك (خطة «الويب ١٠٠٪» ليلة ٢٠٢٦-٠٩-٢٤). القرارات التالية
جديدة على المنتج، وكلها **مقترحة — بانتظار تأكيد المالك**:

- **الخطافات لا تُمرَّر إليها أحداث بعد.** قرأت الخادم: لا شيء في المجلس يرسل أحداثه إلى
  خطاف؛ التسليم الوحيد الذي يحدث هو التجريبي. فالصفحة تقول ذلك في سطر واحد ظاهر، وحقل
  «الأحداث» يُحفظ ويقول إنه يُرسَل حين يُبنى التمرير. لم تُعرض `include_content` ولا
  `profiles` ولا `max_retries`: لا أثر لها إلا في التمرير غير المبني، فبقيت بقيمها الافتراضية
  من الخادم. بناء التمرير خطوة لاحقة (انظر «التسليم»).
- **سرّ التوقيع يُصنع في المتصفح** (٣٢ بايتًا عشوائية بالست عشري، بادئة `whsec_`)، ويُرسَل مع
  الحفظ، ويُعرض مرة واحدة في نافذة للنسخ ثم لا يظهر أبدًا (الخادم يجيب `[stored]`). في التعديل:
  «الإبقاء على السرّ الحالي» (لا يُرسل حقل `secret` أصلًا) أو «إنشاء سرّ جديد» أو «إيقاف
  التوقيع» (`null`). خطاف جديد موقَّع افتراضيًا.
- **رفض العنوان بالكلمات بجانب الحقل:** `url_scheme` و`url_unresolvable` و`url_private` من
  `details.reason` تُترجَم، والعنوان الخاص يحتاج مفتاح «السماح بعنوان خاص» صراحة.
- **الإرسال التجريبي يتبع المهمة** بالاستطلاع (`jobs.get` كل ٧٠٠ ملّي ثانية حتى تنتهي)، ثم
  يعرض «سُلِّم — أجاب العنوان بـ 200» أو «لم يُسلَّم — …» ويعيد جلب القائمة والتسليمات.
- **الخصوصية:** جدول `docs/contracts/COVERAGE.md` يضع فيها مفتاحًا واحدًا هو
  `privacy.redact_pii` في إعدادات البروفايل. الخادم يخزّنه ولا يقرؤه شيء؛ هرمز عنده إعداد
  بالاسم نفسه لقنوات المراسلة (يخفي أرقام الهواتف ومعرّفات المستخدمين قبل النموذج) لكن المجلس
  لا يكتبه في إعداد هرمز. فعرضه مفتاحًا يعني ادّعاء إخفاء لا يحدث — **لم يُعرض**. الصفحة
  المقترحة بدلًا منه: «التطبيقات والأجهزة التي لها وصول» من `auth.listAppTokens` مع «إلغاء
  الوصول» (`auth.revokeAppToken`، يُفصل الجهاز المقترن)، وسطر صادق أن جلسات المتصفح لا تُسرد
  (لا عملية في العقد تسردها) وأن تغيير كلمة المرور يُخرج المتصفحات الأخرى ولا يلغي هذه الرموز
  (تحققت من `revokeOtherSessions`: يلغي رموز `web` فقط).
- **الصياغة:** «بروفايل» في كل رسالة يقرؤها المستخدم من الخادم، وفي نصوص الطرفية (CLI) أيضًا
  لأنها نصوص مستخدم. أسماء الحقول والرموز (`profile_not_found`، ومفتاح `workspace_name`…)
  لم تتغيّر. وأضيفت قاعدة إلى `pnpm i18n:check` تمنع عودة الكلمة القديمة في قيم الخادم
  والطرفية والويب.
- **بطاقة وقت التشغيل:** كل الفحوص ناجحة ⇐ سطر «وقت التشغيل · كل شيء يعمل» وزر «عرض الفحوص».
  أي فحص فاشل ⇐ القائمة مفتوحة دائمًا، بلا زر طيّ وبلا «كل شيء يعمل».

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عملية جديدة `notify.listWebhookDeliveries` — `GET /notify/webhooks/{webhook_id}/deliveries`
  (مشرف، `limit` من ١ إلى ٥٠، افتراضي ٢٠)، ومخطط `WebhookDelivery`: `id`, `webhook_id`,
  `event`, `status` (`queued|delivered|failed|dead`)، `attempts`, `response_status`,
  `error`, `created_at`, `delivered_at`. الحمولة لا تُعاد لأنها قد تحمل نص الرسائل.
- **إصلاح خادم لم يطابق العقد:** `notify.testWebhook` كان يجيب `202` بجسم المهمة كاملًا، والعقد
  يقول `JobAccepted` (`{ job_id }`). اكتشفته رحلة Playwright: الصفحة لم تجد `job_id` فلم تنتظر
  شيئًا. صار يجيب `{ job_id }`، واختبار الخادم يثبت ذلك ويفشل على الكود القديم.
- `docs/contracts/COVERAGE.md`: صف الخطافات يذكر العملية الجديدة.
- العدد في `docs/STATUS.md`: ‏186 من 252، و`notify` ‏12 من 12.

## الملفات والتأثير
- الخادم: `packages/server/src/modules/notify/index.ts` (المسار الجديد، `delivered_at` يُسجَّل
  عند نجاح التجربة، و`testWebhook` يجيب `{ job_id }`)، `notify.test.ts` (التسليمات بنجاح
  وفشل، ‏404 لخطاف غير موجود، `JobAccepted`، ونتيجة المهمة)؛
  `packages/server/src/i18n/{ar,en}.json` (ثماني رسائل)؛ نصوص سجل التدقيق في
  `modules/auth/routes.ts` («profile … created/updated/archived/settings updated»)؛
  ونصّا `detail`/`reason` في `modules/models/service.ts`.
- الطرفية: `packages/cli/src/i18n/{ar,en}.json` (تسعة نصوص) و`tests/integration/cli.test.ts`
  («Profile: default.»).
- `scripts/i18n-check.mjs`: قاعدة الكلمة القديمة.
- الويب: `src/notify/webhooks.ts` (الاستعلامات، السرّ، متابعة المهمة)، `src/notify/WebhooksTab.tsx`،
  `src/settings/PrivacyTab.tsx`، `src/settings/SettingsScreen.tsx` (مدخلان في `SECTIONS`)،
  `src/models/RuntimeChecks.tsx` (`RuntimeCard`) و`ModelsScreen.tsx`، والنصوص في
  `src/i18n/{ar,en}.json` (كتلتا `webhooks` و`privacy` بعد `notify`، و`models.runtime.all_ok/show/hide`).
- الاختبارات: `tests/webhooks-privacy.test.tsx` (١٤)، `tests/models-screen.test.tsx` (+٢)،
  ورحلتا Playwright ‏٢٤ و٢٥ في `e2e/zzz-settings-webhooks-privacy.spec.ts`: الرحلة ٢٤ تشغّل
  مستقبِلًا حقيقيًا على الجهاز وتتحقق أن التسليم التجريبي وصل وأن ترويسة
  `X-Majlis-Signature` هي HMAC المحتوى بالسرّ الذي عرضته الصفحة؛ الرحلة ٢٥ تنشئ رمزًا عبر
  الواجهة البرمجية، تلغيه من الصفحة، وتتحقق أن الخادم صار يرفضه (401).
- اللقطات الجديدة: `webhooks-ar-light`, `webhooks-secret-ar-light`, `webhook-dialog-ar-light`,
  `privacy-ar-light`. باقي اللقطات التي تغيّرت بالتشغيل الكامل أُرجعت (توقيت وحالة اتصال لا
  علاقة لها بالمهمة؛ لقطة `design-models` بلا مزوّد فلا تظهر فيها البطاقة).
- `docs/STATUS.md`: العدد، صف `notify` (يقول صراحة إن التسليم الوحيد اليوم هو التجريبي)،
  وقسم الويب.

## الفحوص (الأوامر ونواتجها الفعلية)
كل أمر ثقيل شُغّل عبر غلاف الذاكرة (`mj-run`، عاملان لـ vitest) واحدًا بعد الآخر.
```
$ pnpm --filter @majlis/server test
 Test Files  75 passed | 7 skipped (82)
      Tests  793 passed | 19 skipped (812)
$ pnpm --filter @majlis/server exec vitest run --project unit src/modules/notify   # على notify/index.ts القديم
     × sends a signed test and records what came back
     × records a failure rather than pretending the endpoint answered
     × answers 404 for the deliveries of a webhook that does not exist
$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  255 passed (255)
$ pnpm --filter @majlis/web test
 Test Files  39 passed (39)
      Tests  501 passed (501)
$ pnpm --filter @majlis/cli test
 Test Files  11 passed (11)
      Tests  64 passed (64)
$ pnpm typecheck            # exit 0
$ pnpm build                # exit 0
$ pnpm lint
All matched files use Prettier code style!
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 229 client file(s) scanned, 167 contract path(s) known.
$ pnpm i18n:check
i18n:check  server: 103 keys, ar/en in parity
i18n:check  cli: 249 keys, ar/en in parity
i18n:check  web: 921 keys, ar/en in parity
i18n:check  OK
$ pnpm i18n:check   # القاعدة الجديدة على نصوص الخادم والطرفية القديمة
i18n:check  FAILED with 33 problem(s)
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
$ MAJLIS_E2E_PORT=8871 MAJLIS_E2E_SETUP_PORT=8872 PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  30 passed (1.9m)
$ PLAYWRIGHT_CHANNEL=chrome npx playwright test e2e/zzz-settings-webhooks-privacy.spec.ts   # بعد آخر تعديل نصي
  ✓  1 … 24. Webhooks: a private address needs a yes, the secret shows once, and the test really arrives signed
  ✓  2 … 25. Privacy: a token that acts as you is listed, revoked here, and refused at the hub
  2 passed (8.5s)
```

## المخاطر والرجوع
- عملية عقد جديدة للقراءة فقط؛ تغيير جسم `testWebhook` يطابق العقد، ولم يكن أي عميل يقرأ
  الجسم القديم (الويب لم تكن فيه صفحة خطافات، والطرفية لا تستعمله).
- تغيير نصوص رسائل الخطأ لا يغيّر الرموز؛ اختبار الطرفية الوحيد الذي يقرأ النص حُدِّث.
- ملفات اللغة و`STATUS.md` مشتركة مع فروع أخرى: أُضيف ولم يُرتَّب، وقد يحتاج الدمج حلًّا يدويًا
  لسطر العدد.
- الرجوع: استرجاع الـcommits؛ لا ترحيل قاعدة بيانات.

## التسليم والخطوة التالية
PR إلى `main` للمراجعة. للمالك أن يؤكد: (١) صفحة الخصوصية المقترحة بلا `redact_pii`،
(٢) إخفاء `include_content`/`profiles`/`max_retries` حتى يوجد التمرير، (٣) صنع السرّ في
المتصفح. الخطوة التالية المقترحة: **تمرير أحداث المجلس إلى الخطافات** (الإرسال الموقَّع،
المحاولات مع `max_retries`، `dead`)، ثم ربط `redact_pii` بإعداد هرمز لكل بروفايل إن أراده المالك.
