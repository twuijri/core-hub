# تسجيل الدفع يموت مع جلسته، وسجلات الجوال وأداؤه من المسارات الحية
المسؤول: twuijri · الفرع: feat/push-cleanup-mobile-logs · الحالة: review

## المشكلة والهدف
**الجزء ١ — الدفع بعد انتهاء الجلسة.** سجل الدفع السابق (`2026-09-26-twuijri-apps-push-registration.md`) ترك
قيدًا معروفًا: إن أنهى المركز جلسة كلمة المرور (انتهت، خروج من مكان آخر، تغيير كلمة المرور، إلغاء المشرف،
تعطيل المستخدم أو حذفه) فلا يستطيع تطبيق iOS إزالة تسجيله، فيبقى رمز APNs عند المركز ويستمر الدفع إلى هاتف
لم يعد مسجّل الدخول حتى يُحذف الجهاز من الويب. السبب في الخادم: صف الجهاز لا يعرف أي جلسة سجّلت رمزه.

الهدف: كل طريق ينهي به المركز جلسةً أو رمز جهاز يمسح رموز الدفع التي سجّلتها تلك الجلسة، والجلسة التي انتهت
صلاحيتها بلا حدث تُكتشف قبل الإرسال التالي؛ ويُنسى الرمز الذي يقول FCM/APNs إنه غير مسجّل أو غير صالح.

**الجزء ٢ — السجلات والأداء في الجوال.** الويب صار يقرأ السجلات والأداء من `audit.listLogLines` و
`audit.getLivePerformance` (DECISIONS §51)، لكن صفحتي «السجلات» و«الأداء» في iOS بقيتا على
`audit.getReport` بنوعي `logs`/`performance` (القديمين: سجل التدقيق، وصف كل دقيقة عن ذاكرة الهب)، وأندرويد
لم يكن له الصفحتان أصلًا (كانتا «افتحها على الويب»). الهدف: التطبيقان على المسارين الحيين بما يناسب الهاتف
(المصدر، المستوى، التحديث)، للمالك والمشرف فقط كما في `navigation.json`، ثم الحكم على بقاء النوعين القديمين.

## القرار والموافقات
طلب المالك المهمة ضمن ليلة ٢٠٢٦-٠٩-٢٦ (#144)، ومنها صراحةً: إزالة النوعين القديمين إن لم يبقَ من يستعملهما،
العقد أولًا. ما يلي **مقترح — ينتظر تأكيد المالك**:

1. **التسجيل مربوط بجلسته** (بلا تغيير في العقد): عمود جديد `devices.push_session_id` (ترحيل `0023`) يحفظ صف
   `auth.app_tokens` الذي سجّل الرمز — جلسة كلمة المرور، أو رمز الاقتران للهاتف المقترن. `devices.registerPush`
   يكتبه لـ FCM وAPNs.
2. **كل طريق ينهي الجلسة من المركز يمسح رمزها فورًا**: الخروج (`auth.logout`)، إلغاء رمز (`revokeAppToken`)،
   تغيير كلمة المرور بنفسه (تُلغى الجلسات الأخرى، وتبقى جلسة من غيّرها ورمزها)، إعادة المشرف لكلمة مرور شخص،
   تعطيل الشخص (كل رموزه، حتى المتصفح، لأنه لا يستطيع الدخول أصلًا)، حذفه، إعادة ضبط المالك
   (`COREHUB_RESET_OWNER`)، وإعادة الاقتران (رمز الاقتران القديم). الدالتان في وحدة `devices`
   (`endPushForSessions`، `endPushForOwners`) و`auth` تستدعيهما من `revokeToken` و`revokeOtherSessions`
   و`updateUser` و`deleteUser` والاقتران وإعادة الضبط — فلا طريق جديد يلغي رمزًا دون أن يمرّ بها.
3. **الانتهاء الصامت**: جلسة انتهت صلاحيتها (أو شخص عُطّل) لا حدث لها، فمرسِل الدفع يسأل قبل كل إرسال عن
   الجلسة (`sessionLive`، منفذ يعيره جذر التركيب من `auth.tokenLive`: الصف موجود، غير ملغى، غير منتهٍ، وصاحبه
   نشط). إن ماتت يُنسى الرمز ويُسجَّل التسليم فاشلًا («the sign-in that registered this device has ended»)
   ولا يُرسل شيء. صف أقدم بلا `push_session_id` يرجع إلى رمز اقترانه إن كان مقترنًا.
4. **اشتراك Web Push في المتصفح لا يُربط بالجلسة**: الويب يحسب «الإشعارات مفعّلة» من اشتراك المتصفح نفسه ولا
   يعيد تسجيله بعد الدخول، فربطه بالجلسة كان سيُسكت دفع المتصفح بعد أول خروج ودخول دون أن يعرف صاحبه.
   يبقى للمتصفح حتى يُطفأ أو يُفصل (كما كان)، إلا عند تعطيل الشخص أو حذفه أو إعادة ضبط المالك. متابعة مقترحة:
   أن يعيد الويب تسجيل اشتراكه بعد الدخول، ثم يُربط هو أيضًا.
5. **رموز FCM/APNs الميتة**: كان المرسِل ينسى FCM `UNREGISTERED`/404 وAPNs `410`/`Unregistered` وWeb Push
   404/410. أُضيف FCM `INVALID_ARGUMENT` **حين تقول رسالته إن رمز التسجيل نفسه غير صالح** فقط — نفس الرمز
   يأتي لرسالة بناها المركز خطأ، ونسيان رمز سليم لذلك أسوأ. وبقي APNs `BadDeviceToken` و
   FCM `SENDER_ID_MISMATCH` بلا نسيان (قرار سابق في `senders.ts`): كلاهما ينتج أيضًا عن إعداد خاطئ في المركز
   (بيئة sandbox/production أو مشروع Firebase آخر)، ونسيان رموز كل الهواتف بسببه أسوأ.
6. **السجلات في الجوال**: `audit.listLogLines`، أحدث ٢٠٠ سطر (الويب يعرض حتى ٥٠٠٠)، المصدر (الكل، الهب،
   Hermes، الأخطاء فقط) والمستوى الأدنى (يختفي مع «الأخطاء فقط»)، و«تحديث» (زر، والسحب في iOS) يطلب ما بعد
   آخر `seq` فقط ويضيفه تحت المعروض. بلا بحث نصي ولا اختيار بروفايل ولا تنزيل ولا ذيل حيّ كل ٣ ثوانٍ — للهاتف
   أثقل من فائدته؛ الويب يبقى لها.
7. **الأداء في الجوال**: `audit.getLivePerformance` كل `interval_seconds` (٥ ثوانٍ افتراضًا) ما دامت الصفحة
   ظاهرة فقط: الجهاز (المعالج والأنوية، الذاكرة، الحِمل)، عملية الهب (المعالج، RSS والكومة، تأخّر حلقة
   الأحداث، مدة التشغيل ونسخة Node)، كل عملية Hermes بحالتها، ونشاط كل بروفايل؛ رقم لم يقسه المركز «—» لا صفر؛
   فشل القياس يُبقي آخر قياس ومعه السبب. بلا الرسوم الصغيرة (`history`).
8. **إزالة `logs` و`performance` من `audit.getReport`** (DECISIONS **§75**): لا يطلبهما بعد الآن الويب ولا
   الواجهة الطرفية ولا سطح المكتب ولا أيّ من التطبيقين (بحثت في المستودع كله)، والتطبيقات تكلّم مراكز من
   نسختها. فأُزيل النوعان من العقد مع `q` و`level`، وصار `X-Hub-Profile` هو معامل `Profile` الإلزامي (النوعان
   الباقيان `usage`/`skills` لبروفايل دائمًا)، وتوقّف معاين الأداء الذي يكتب صفًا كل دقيقة، وأُسقط جدول
   `performance_snapshots` (ترحيل `0024`). سجل التدقيق وأحداث المهام باقية كما هي. صفحة «الاستخدام» في iOS
   هي المستدعي الوحيد الباقي، وتمرّر بروفايلها كما كانت.
9. أسماء الملفات `LiveTools` (لا `HubTools`) لأن في العقد مخططًا اسمه `HubTools` (أدوات الهب لوكلائه).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `audit.getReport` (`GET /audit/reports/{kind}`): `kind` = `[usage, skills]` (كان معهما `logs` و`performance`)،
  و`AuditReport.kind` مثله؛ حُذف `q` و`level`؛ `X-Hub-Profile` صار `$ref: Profile` الإلزامي؛ الوصف محدَّث.
  DECISIONS §75. أُعيد توليد عملاء TypeScript وKotlin وSwift (غير مرفوعة، تُولَّد في البناء).
- الجزء ١ بلا تغيير في العقد.

## الملفات والتأثير
- الخادم — الدفع: `modules/devices/schema.ts` (`push_session_id`)، `drizzle/0023_device_push_session.sql`
  (+ اللقطة والسجل)، `modules/devices/index.ts` (`endPushForSessions`، `endPushForOwners`، المنفذ
  `sessionLive`، `registerPush` يكتب الجلسة)، `modules/devices/push.ts` (فحص الجلسة قبل الإرسال)،
  `modules/devices/senders.ts` (FCM `INVALID_ARGUMENT` للرمز)، `modules/auth/users.ts` (`tokenLive`،
  `revokeToken`، `revokeOtherSessions`، `updateUser`، `deleteUser`)، `modules/auth/pairing.ts`،
  `modules/auth/setup.ts`، `modules/auth/index.ts`، `modules/index.ts` (المنفذ).
- الخادم — التقارير: `modules/audit/reports.ts` (usage فقط)، `modules/audit/index.ts` (المسار، بلا معاين)،
  `modules/audit/schema.ts` (بلا الجدول)، `drizzle/0024_drop_performance_snapshots.sql` (+ اللقطة والسجل).
- الاختبارات: `tests/unit/devices-push.test.ts` (٧ حالات جديدة)، `modules/devices/push.test.ts`،
  `modules/devices/testing/fake-push.ts` (FCM `INVALID_ARGUMENT`)، `modules/auth/setup-window.test.ts`،
  `modules/audit/audit.test.ts`، `modules/audit/reports.test.ts` (حُذفت اختبارات النوعين).
- أندرويد: `tools/LiveTools.kt` (جديد: `LogsModel`، `PerformanceModel`، القواعد)، `ui/screens/ToolsScreens.kt`
  (جديد)، `ui/screens/SettingsScreen.kt` (الصفحتان أصليتان)، `data/Hub.kt` (`AuditApi`)،
  `res/values{,-ar}/strings.xml` (٤٠ نصًا)، `test/.../tools/LiveToolsTest.kt` (جديد).
- iOS: `CoreHub/Settings/LiveTools.swift` (جديد)، `Settings/SettingsScreen.swift`، `Settings/ManagementPages.swift`
  (`AuditPage` للاستخدام فقط)، `i18n/{ar,en}.json` (٤١ مفتاحًا)، `CoreHubTests/LiveToolsTests.swift` (جديد).
- العقد والوثائق: `packages/contracts/openapi.yaml`، `docs/contracts/DECISIONS.md` (§75)، `docs/domain/audit.md`،
  `docs/domain/README.md`، `docs/STATUS.md`، هذا السجل، وسطر في `2026-09-26-twuijri-night-pr.md`.
- لم تُلمس ملفات الأيقونات ولا الموارد ولا `project.yml` (مهمة الأيقونات الموازية).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run`، بعد دمج `origin/night/2026-09-26` (`e91cf33`، ومعه طلبات قدرات الجهاز وترحيلها `0022`) في الفرع:
```
$ pnpm contracts:lint                → contracts:lint  OK   (Your API description is valid.)
$ pnpm --filter @corehub/contracts generate   (JDK 17)  → contracts:generate:native  OK
$ pnpm contracts:check-clients       → check-clients  OK — 581 client file(s) scanned, 222 contract path(s) known.
$ pnpm i18n:check                    → ios: 325 keys, ar/en in parity · i18n:check  OK
$ pnpm nav:check                     → nav:check  OK — 37 destinations … routes for web, ios, android, desktop
$ pnpm lint                          → All matched files use Prettier code style!   (exit 0)
$ pnpm change-record:check           → change-record  OK — 9 record(s) valid
$ pnpm typecheck                     → exit 0
$ pnpm db:generate                   → No schema changes, nothing to migrate
$ vitest run tests/unit/devices-push.test.ts tests/unit/device-requests.test.ts src/modules/devices src/modules/auth src/modules/audit
 Test Files  19 passed | 1 skipped (20)
      Tests  138 passed | 1 skipped (139)
$ vitest run --project contract tests/contract/{audit,devices,auth,perf-logs}.contract.test.ts tests/contract/contract.test.ts
 Test Files  5 passed (5)
      Tests  329 passed (329)
$ ./gradlew --no-daemon --max-workers=2 assembleDebug testDebugUnitTest lintDebug   (apps/android, JDK 17)
BUILD SUCCESSFUL in 1m
hub.core.android.tools.LiveToolsTest tests=6 fail=0 err=0
hub.core.android.nav.NavigationParityTest tests=8 fail=0 err=0
hub.core.android.ui.StringsParityTest tests=2 fail=0 err=0
… والـ١٣ الباقية كلها fail=0 err=0
```
الاختبارات الجديدة تسقط على الكود القديم (شُغّلت بإرجاع ملفات الخادم إلى `HEAD` مؤقتًا):
```
     × says a token is gone when FCM calls the token itself invalid, not when the message is
     × forgets the token when that sign-in signs out, and keeps the other sign-ins
     × forgets the other sign-ins’ tokens when the person changes their password
     × forgets a person’s tokens when an admin resets their password, disables or deletes them
     × pushes nothing through a sign-in that expired, and forgets its token
     × forgets a paired phone’s token when it is paired again
     × forgets a token FCM calls invalid
      Tests  7 failed | 27 passed (34)
# setup.ts وحده بالقديم:
     × disables the owner, keeps everyone else, reopens setup — once
```
(«leaves a browser’s subscription with the browser» ينجح على القديم والجديد: يثبّت أن سلوك المتصفح لم يتغيّر.)
اختبارات أندرويد وiOS الجديدة تسقط على القديم لأن الأصناف غير موجودة.

لا Xcode محليًا، فشُغّل سير عمل iOS يدويًا على فرع المهمة (`workflow_dispatch`، عند `f811428` بعد تغيير العقد):
```
iOS 36160236585 — success
  ✓ Generate the Swift client (CoreHubClient) in 39s
  ✓ Build and test on the iOS simulator in 7m22s
  ** TEST SUCCEEDED **   Executed 70 tests, with 0 failures
  Test Case '-[CoreHubTests.LiveToolsTests testANewFilterIsANewPageAndErrorsOnlySendsNoLevel]' passed
  … وحالات LiveToolsTests الثماني كلها passed
```

## المخاطر والرجوع
- **الرجوع**: revert للفرع. الترحيل `0023` يضيف عمودًا فارغًا (لا يضر بنسخة أقدم)؛ `0024` يسقط جدول عيّنات
  الأداء — الرجوع لا يعيد العيّنات القديمة (لم يكن يقرؤها أحد سوى النوع المحذوف).
- الأجهزة المسجّلة قبل هذا بلا `push_session_id`: جهاز مقترن يرجع إلى رمز اقترانه؛ هاتف دخل بكلمة المرور قبل
  هذا يبقى تسجيله حتى يسجّل التطبيق رمزه من جديد (كل تشغيل في iOS) أو يُحذف من الويب. بيانات التجربة تُمسح
  عند النضج على كل حال.
- مسح الرمز عند انتهاء الجلسة لا يرسل حدث `device.updated`؛ قائمة الأجهزة في الويب تعرفه عند التحديث التالي.
- الهاتف الذي انتهت جلسته ثم دخل من جديد يسجّل رمزه كما يفعل بعد كل دخول، فلا ضياع.
- مركز أقدم مع تطبيق أحدث: صفحتا السجلات والأداء تحتاجان §51 (موجود في المركز منذ ٢٠٢٦-٠٩-٢٥)؛ التطبيقات
  تكلّم مراكز نسختها.

## التسليم والخطوة التالية
- دُمج في `night/2026-09-26` (#144) عند `be82a4f`. CI على #144 عند `a21b1fc` (يحويه، ومعه مهمة لاحقة): كل
  الفحوص ناجحة (١٧ pass)، ومنها «Android build, unit tests, lint» و«Build and test on the iOS simulator» و
  «Generate the Swift client (CoreHubClient)» و«db:generate + db:migrate (SQLite and PostgreSQL)» وأجزاء
  اختبارات الخادم الثلاثة و«Web smoke journeys».
- لم يُجرَّب على هاتف ولا على مركز المالك، ولم يُرسل دفع حقيقي (المرسِلان مطفآن حتى يُدخل المالك بياناتهما).
- متابعة مقترحة: يعيد الويب تسجيل اشتراك Web Push بعد كل دخول، ثم يُربط المتصفح بجلسته أيضًا؛ حدث
  `device.updated` حين يمسح المركز رمزًا.
