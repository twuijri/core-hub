# متابعات الإشعارات: اشتراك المتصفح مع جلسته، حدث حين يسقط الرمز، إثبات الجهاز للمرحّل
المسؤول: twuijri · الفرع: feat/push-followups · الحالة: review

## المشكلة والهدف
دفعة B16 من قائمة الفجوات. بقيت خمس متابعات من سجلّي `2026-09-26-twuijri-push-cleanup-mobile-logs.md` و
`2026-09-26-twuijri-push-relay.md` وADR 0024:
1. اشتراك Web Push في المتصفح لا يُربط بجلسته، فمتصفح انتهت جلسته يبقى يستقبل الإشعارات.
2. حين يُسقط المركز رمز دفع (انتهاء جلسة أو رمز ميت) لا يصل حدث `device.updated`، فلا تتحدّث قائمة الأجهزة في الويب.
3. التطبيقان لا يرسلان إثبات الجهاز (`relay_proof`)، فهاتف ينتقل إلى مركز آخر دون أن يخرج من الأول ينتظر حتى
   يفلت المركز القديم رمزه أو تمضي ٣٠ يومًا.
4. معرّف تثبيت FCM: هل يلزم؟
5. iOS لا يُسقط تسجيله حين يكتشف أن المركز أنهى جلسته (401 عند التشغيل مثلًا).

## القرار والموافقات
طلب المالك الدفعة ضمن ليلة ٢٠٢٦-٠٩-٢٧ (#165). ما يلي **مقترح — ينتظر تأكيد المالك** (DECISIONS **§107**):

1. **اشتراك المتصفح يعيش مع جلسته** كالهاتف: `devices.registerPush` يحفظ الجلسة (`push_session_id`) لكل مزوّد، لا
   لـFCM وAPNs فقط، فكل طريق ينهي الجلسة يُسقط تسجيل المتصفح (`endPushForSessions` نفسها). اشتراك سُجّل قبل هذا
   (بلا جلسة) يبقى حتى يُطفأ أو يُفصل المتصفح.
2. **الويب يعيد الاشتراك بعد الدخول بصمت** (`resumeBrowserPush`، مكوّن `BrowserPushResume` داخل `AuthProvider`):
   فقط حين يرى الصفحة تنتقل من «بلا دخول» إلى «داخل» (لا عند كل تحميل لصفحة داخلة أصلًا، فتسجيلها قائم)،
   والإذن ما زال `granted`، والمتصفح ما زال يحمل اشتراكًا، و**الشخص الداخل هو من فعّل الإشعارات في هذا المتصفح**
   (يُحفظ معرّفه في تخزين المتصفح عند التفعيل ويُمسح عند الإطفاء). شخص آخر يدخل من المتصفح نفسه لا يُشترك
   بصمت، ويرى الحالة «مطفأة» ويفعّلها بنفسه. لا يطلب إذنًا أبدًا ولا يرمي خطأ. مفتاح VAPID تغيّر (بيانات المركز
   استُبدلت) ← اشتراك جديد بلا سؤال لأن الإذن ممنوح.
3. **`device.updated` حين يُسقط المركز تسجيلًا من نفسه**: انتهت الجلسة (كل طرق `auth`) أو قال مزوّد الدفع إن
   الرمز ميت (وفحص الجلسة قبل الإرسال). يُعلَن في الدورة التالية (`setImmediate`) بعد أن تستقر المعاملة، ومن
   الصف كما هو حينها — فمعاملة تراجعت تُعلن ما أبقته، وهو صحيح — ولصاحب الجهاز. الجهاز الملغى في اللحظة نفسها
   يُعلنه من ألغاه (`device.unlinked`، أو `device.updated` عند الخروج) فلا يتكرّر. معرّفات الأجهزة فريدة لقاعدة كل
   مركز، فيُعلن كل مركز في العملية صفوفه فقط.
4. **إثبات الجهاز في التطبيقين**: مفتاح P-256 يُصنع مرة لكل تثبيت — **في iOS مفتاح برمجي في Keychain**
   (`AfterFirstUnlockThisDeviceOnly`: لا ينتقل في نسخة احتياطية إلى هاتف آخر، ويُقرأ والهاتف مقفل لأن رمز APNs
   قد يصل في الخلفية)، **وفي أندرويد مفتاح في Android Keystore** لا يخرج نصفه الخاص منه. يوقّع
   `corehub-push-bind-v1\n<apns|fcm>\n<token>\n<signed_at>`؛ المفتاح النقطة الخام (٦٥ بايت) والتوقيع `r||s` (٦٤
   بايت) بـbase64url كما يقرأ المرحّل. يُرسل مع كل تسجيل (`relay_proof`). لا مفتاح ← تسجيل بلا إثبات كتطبيق
   أقدم. رُفض Secure Enclave: لا يعمل في المحاكي الذي تُختبر عليه CI، وخطر ADR 0024 §6 لا يحتاج مفتاحًا لا يغادر
   الهاتف.
5. **تمرير المركز**: كان قائمًا منذ §82 (`registerPush` ← `relayBind` بالإثبات كما هو). أضفت فحصه طرفًا لطرف:
   المرحّل المزيّف صار يتحقق من الإثبات كالمرحّل الحقيقي (المفتاح، التوقيع، «الأحدث من المفتاح نفسه ينقل»).
   حدّ معروف: تسجيل لم يستطع المرحّل ربطه لحظتها يُربط لاحقًا بلا إثبات (الإثبات صالح ١٠ دقائق فقط).
6. **معرّف تثبيت FCM لا يلزم فتُرك**: لا ADR 0024 ولا سجلات الدفع تعتمد عليه؛ المركز والمرحّل يخاطبان رمز تسجيل
   FCM (`message.token` في HTTP v1)، وإثبات الجهاز يعرّف التثبيت للمرحّل أصلًا.
7. **iOS عند خروج يفرضه المركز** (`signedOutByHub`: 401 عند التشغيل أو في أي نداء): الجلسة المنتهية لا تستطيع
   إخبار المركز بشيء، والمركز نسي الرمز حين انتهت. فيُنسى الرمز المحفوظ في التطبيق ويُلغى تسجيل APNs نفسه
   (`unregisterForRemoteNotifications`) فيرفض APNs الرمز القديم لأي مركز أو مرحّل ما زال يحمله (مركز أقدم من
   التنظيف يتلقى `Unregistered` فينساه) — كما يحذف أندرويد رمز FCM منذ سجل الدفع الأول. الدخول التالي يسجّل من
   جديد (`start`). مفتاح الإثبات يبقى لأنه للتثبيت. الخروج بإرادة الشخص كما هو: يُخبر المركز أولًا ولا يلمس APNs.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا مسار ولا مخطط جديد. وصف حدث `device.updated` (`events/devices/device.updated.schema.json` وجدول
`events/README.md`) يذكر السبب الجديد: تسجيل أسقطه المركز من نفسه. DECISIONS §107. عملاء Kotlin وSwift
تُولَّد في البناء (ولّدتها محليًا بـJDK 17 لأرى أسماء `PushRelayProof` و`relayProof`، ولم تُرفع).

## الملفات والتأثير
- الخادم: `modules/devices/index.ts` (إعلان التسجيلات الساقطة `pushDropped`، `liveHubs`، الجلسة لكل مزوّد)،
  `modules/devices/push.ts` (`onTokenForgotten`)، `modules/devices/testing/fake-relay.ts` (التحقق من الإثبات).
- اختبارات الخادم: `tests/unit/devices-push.test.ts` (المتصفح مع جلسته، الحدث عند الخروج وعند الرمز الميت)،
  `tests/unit/devices-push-relay.test.ts` (ثلاث حالات للإثبات، منها مركزان ومرحّل واحد).
- الويب: `src/devices/browserPush.ts` (صاحب الاشتراك، `resumeBrowserPush`)، `src/devices/BrowserPushResume.tsx`
  (جديد)، `src/app.tsx` (سطر)، `src/notify/BrowserPushSection.tsx` (الحالة لهذا الشخص)،
  `tests/browser-push-resume.test.tsx` (جديد)، `e2e/zzzzzz-browser-push.spec.ts` (خروج ثم دخول ثم إشعار ثانٍ يصل).
- iOS: `CoreHub/Phone/DeviceProof.swift` (جديد)، `CoreHub/Phone/Push.swift`، `CoreHub/App/AppModel.swift`،
  `CoreHubTests/DeviceProofTests.swift` (جديد)، `CoreHubTests/PushTests.swift`.
- أندرويد: `phone/DeviceProof.kt` (جديد)، `phone/Push.kt`، `AppGraph.kt`، `test/.../phone/DeviceProofTest.kt`
  (جديد)، `test/.../phone/PushTest.kt`.
- الوثائق: `docs/contracts/DECISIONS.md` (§107)، `docs/adr/0024-push-relay.md` (سطران: التطبيقان يرسلان الإثبات)،
  `docs/domain/devices.md`، `docs/STATUS.md`، هذا السجل، وسطر في `2026-09-27-twuijri-night-pr.md`.
- لم يُلمس كتالوج الوكلاء (مهمة موازية).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run`، بعد دمج `origin/night/2026-09-27`:
```
$ vitest run --project unit tests/unit/devices-push.test.ts tests/unit/devices-push-relay.test.ts tests/unit/status.test.ts
      Tests  43 passed (43)
$ vitest run --project unit src/modules/devices src/modules/auth tests/unit/devices-push.test.ts tests/unit/devices-push-relay.test.ts tests/unit/device-requests.test.ts
 Test Files  15 passed | 1 skipped (16)
      Tests  122 passed | 1 skipped (123)
$ vitest run --project contract tests/contract/devices.contract.test.ts
      Tests  1 passed (1)
$ vitest run tests/browser-push-resume.test.tsx tests/devices-push.test.tsx      (web)
      Tests  14 passed (14)
$ pnpm build                                  → exit 0
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzz-browser-push.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zzzzzz-browser-push.spec.ts:31:1 › a browser turns notifications on, and a test notice is pushed to it (1.6s)
  1 passed (9.7s)
$ pnpm --filter @corehub/web typecheck        → exit 0
$ pnpm --filter @corehub/server typecheck     → exit 0
$ pnpm lint                                   → All matched files use Prettier code style! (exit 0)
$ pnpm contracts:lint                         → contracts:lint  OK (96 event schema files)
$ pnpm contracts:check-clients                → check-clients  OK — 772 client file(s) scanned, 252 contract path(s) known.
$ pnpm i18n:check                             → i18n:check  OK
$ pnpm nav:check                              → nav:check  OK — 39 destinations …
$ ./gradlew --no-daemon --max-workers=2 testDebugUnitTest --tests 'hub.core.android.phone.*'   (JDK 17)
BUILD SUCCESSFUL in 42s
hub.core.android.phone.DeviceProofTest tests=5 failures=0 errors=0
hub.core.android.phone.PushTest tests=11 failures=0 errors=0
… والثمانية الباقية في الحزمة كلها failures=0 errors=0
```
اختبارات الخادم الجديدة تسقط على الكود القديم (أُرجع `index.ts` و`push.ts` إلى الأصل مؤقتًا):
```
     × forgets a browser’s subscription when its sign-in ends, and takes it again after the next
     × says device.updated when a sign-in ends and takes its phone’s token
     × says device.updated when the push service calls the token dead
      Tests  3 failed | 39 passed (42)
```
حالات الإثبات الثلاث تنجح على القديم أيضًا: تمرير المركز كان قائمًا منذ §82، وهي تثبّته الآن أمام مرحّل مزيّف
يتحقق فعلًا. اختبارات الويب والتطبيقين الجديدة تسقط على القديم لأن الدوال والأصناف غير موجودة.

لا Xcode محليًا؛ شغّلت سير iOS وأندرويد وCI يدويًا على فرع المهمة (`workflow_dispatch`) — النتائج في «التسليم».

## المخاطر والرجوع
- **الرجوع**: revert للفرع. لا ترحيل ولا تغيير في المخطط.
- متصفح اشترك قبل هذا: لا صاحب محفوظ له فلا يُعاد تسجيله بصمت، ولا جلسة له عند المركز فيبقى تسجيله القديم كما كان.
- إن مُسح تخزين المتصفح فقد صاحبه فلا إعادة صامتة؛ يفعّلها الشخص مرة من صفحة الإشعارات.
- إلغاء تسجيل APNs عند خروج يفرضه المركز: Apple توصي باستعماله نادرًا؛ الدخول التالي يسجّل من جديد وقد يعطي رمزًا
  جديدًا (يُرسل كل رمز على أي حال). لم يُجرَّب على هاتف حقيقي.
- مفتاح iOS في Keychain يبقى بعد حذف التطبيق وإعادة تثبيته (سلوك Keychain في iOS): الهاتف نفسه يبقى بمفتاحه، وهذا
  في صالح الإثبات.
- لم يُنشر المرحّل بعد، فالإثبات لم يُجرَّب إلا أمام المرحّل المزيّف ومنطق المرحّل الحقيقي في اختباراته.

## التسليم والخطوة التالية
CI يدويًا على فرع المهمة (`workflow_dispatch`):
```
CI 36222900009 (054ec08c…aa81c7cc) — success: Lint/typecheck/contracts/tests/build, Server unit tests (shard 1/3, 2/3, 3/3),
   Web smoke journeys (Playwright against the real hub), db:generate + db:migrate, Docker, Desktop app smoke
Android 36222898428 — success: Android build, unit tests, lint
iOS 36222896736 — failure: CoreHubTests/DeviceInfoTests.swift:50:21: error: type 'ReportingBackend' does not conform to protocol 'PushBackend'
   (نسخة ثانية مزيّفة من PushBackend لم تأخذ المعامل الجديد؛ أُصلحت)
iOS 36223120990 (f65e90ea) — success: ** TEST SUCCEEDED ** Executed 167 tests, with 0 failures
   Test Case '-[CoreHubTests.DeviceProofTests testTheProofIsWhatTheRelayVerifies]' passed
   … وحالات DeviceProofTests الخمس، وPushTests testTheRegistrationCarriesTheRelayProofEachTime
   وtestASignOutByTheHubForgetsTheTokenAndDropsTheAPNsRegistration: passed
```
- يُدمج في `night/2026-09-27` (#165)؛ نتيجة CI هناك تُضاف هنا.
- لم يُجرَّب على هاتف ولا متصفح حقيقي مع مزوّد دفع حقيقي، ولم يُنشر المرحّل.
- للمالك: تأكيد §107 (خاصة: إعادة الاشتراك لصاحب التفعيل وحده، وإلغاء تسجيل APNs عند خروج يفرضه المركز).
