# الهواتف: مجموعة «الأدوات» في الدرج، و«سير العمل» صفحة مستقلة، وتحرير سير العمل كما في الويب
المسؤول: twuijri · الفرع: feat/phones-tools-workflows · الحالة: review

## المشكلة والهدف
وافق المالك (2026-09-28) على نقل ما دخل الويب وسطح المكتب في PR #209 إلى تطبيقي iOS وأندرويد:
1. التنقّل كما في الويب (DECISIONS §126): مجموعة قابلة للطيّ «الأدوات» / "Tools" في الدرج فيها الوكلاء
   (للمالك والمشرف كما هو)، المهام، سير العمل (وجهة مستقلة لا تبويب في الجدولة)، الجدولة؛ الحالة محفوظة
   على الجهاز؛ وتُميَّز المجموعة مطويّةً إن كانت الصفحة الحالية داخلها؛ ومكان البحث أقرب ما يكون للويب.
2. تحرير سير العمل على الهاتفين (كان للقراءة فقط): مشغّلات Webhook، ومحرّر القواعد المتعددة، ووجهات
   «أرسل رسالة»، وتنبيه الفشل، ومرحلة التشغيل ومعرّفا المهمة والحدث مع البحث، و«اختبر هذه الخطوة».

## القرار والموافقات
- الموافقة على النطاق: المالك 2026-09-28. التفاصيل مقترحة — ينتظر تأكيد المالك — في DECISIONS §128:
  - **مكان البحث على الهاتف**: الدرج لا ينطوي، فمقابل «صفّ العلامة» في الويب هو رأس الدرج: أيقونة البحث
    بجانب زرّ الإغلاق دائمًا، ويغادر صفّ البحث الشريط (`brandRow` صار يشمل الهاتفين).
  - «الأدوات» مفتوحة افتراضيًا، والحالة في إعدادات التطبيق على الجهاز (أندرويد `SharedPreferences`
    المفتاح `sidebar_groups_closed`، iOS `UserDefaults` المفتاح `sidebar.groupsClosed`)، وأي قيمة لا تُقرأ
    = مفتوحة.
  - `workflows` يبقى في `railExtra` (و`rail` لم يتغير) حتى يطابق تطبيقٌ قديم `rail` حرفيًا.
  - الجدولة بلا مبدِّل «المهام المجدولة | سير العمل»، وكل طريق كان يفتح تشغيل سير عمل عبر الجدولة
    (الموافقات المعلّقة، لوحة الخلفية، الإشعارات، الروابط `schedules?section=workflows` و`workflow_run`)
    يفتح الآن «سير العمل» والتشغيل نفسه.
  - تنبيه الفشل يُكتب فقط إن غيّره الشخص في جلسة التحرير (فارغًا = `null` صريح)، وإلا لا يُرسل الحقل.
    نسخة سير العمل تحمل تنبيه الأصل.
  - اختيارات عرض تنتظر التأكيد: زر «سير عمل جديد» في الشريط العلوي لصفحة سير العمل فقط؛ على iOS مفاتيح
    تبديل بدل مربعات الاختيار (تيليجرام، المحادثة، أحداث ClickUp)؛ على أندرويد قوائم وشرائح بدل القوائم
    المنسدلة؛ «افتح التشغيل» من سجل التسليمات على أندرويد يغلق المحرّر (تضيع التعديلات غير المحفوظة)؛
    قسما التنبيه والمشغّلات تحت الخطوات؛ سجل التسليمات يُحدَّث كل 5 ثوانٍ (أندرويد) / 10 ثوانٍ (iOS) ما دامت
    بطاقة المشغّل ظاهرة؛ على iOS صارت صفوف الشريط تُظهر خلفية للصفحة الحالية، ونبرة `info` لـ`StatusPill`؛
    كلمات الوصول «مفتوحة» / «مطويّة».
- لا عقد API جديد. لا كسر (ADR 0027).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء في `packages/contracts`. عقد التنقّل `docs/clients/navigation.json` زاد فقط: `workflows.surfaces`
صار يشمل `ios` و`android`، ومسار `/workflows` في `surfaceRoutes.ios` و`surfaceRoutes.android`، و`surfaces`
لكلٍّ من `brandRow` و`sidebarGroups.tools` يشمل الهاتفين (مع تحديث التعليقات). `rail` كما هو.

## الملفات والتأثير
- العقد والمستندات: `docs/clients/navigation.json`، `docs/clients/NAVIGATION.md`، `docs/contracts/DECISIONS.md`
  §128، `docs/STATUS.md`، واختبار الويب `packages/web/tests/navigation.parity.test.tsx` (سطح `workflows`).
- أندرويد (`apps/android/app/src`): `nav/{Navigation,AppPaths,HubLinks,SidebarGroups}.kt`، `MainActivity.kt`،
  `AppGraph.kt`، `ui/screens/{Shell,SchedulesScreen,WorkflowsScreen,WorkflowEditor,WorkflowFlow,WorkflowFlowUi,
  BackgroundSheet,Waiting}.kt`، `settings/NotificationsPage.kt`، `phone/Notices.kt`،
  `res/values{,-ar}/strings_workflow_tools.xml` (نصوص الويب نفسها)؛ الاختبارات `nav/ToolsDrawerTest.kt`
  و`parity/WorkflowFlowTest.kt` (جديدة) وتحديث `NavigationParityTest` و`WorkflowsTest` و`PushTest` و`LeftoversTest`
  و`OwnSettingsTest` و`RoomsTest` و`SelfSufficientTest` و`TestSupport.kt`.
- iOS (`apps/ios`): `Navigation/{Destinations,Routes}.swift`، `Shell/{SidebarView,ShellView,PendingList,
  BackgroundSheet,AsyncContent}.swift`، `App/AppModel.swift`، `Phone/LocalNotices.swift`،
  `Settings/Pages/OwnSettingsRules.swift`، `Screens/{WorkflowsScreen,WorkflowTriggers,WorkflowSendForm}.swift`
  (جديدة) و`Screens/{WorkflowEditRules,WorkflowEditor,Workflows}.swift` و`Schedules/SchedulesScreen.swift`،
  `i18n/{en,ar,workflow_editor.en,workflow_editor.ar}.json`؛ الاختبارات `WorkflowTriggersTests.swift` (جديد)
  وتحديث `NavigationParityTests` (ومعه `SidebarGroupStateTests`) و`WorkflowEditorTests` و`WorkflowsTests`
  و`RoomsTests` و`OwnSettingsTests` و`LeftoversTests` و`FamilyTests`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا:
```
$ node scripts/navigation-check.mjs
nav:check  OK — 41 destinations, 2 pre-auth screens (login, setup), 47 terms, ar/en complete, routes for web, ios, android, desktop
$ node scripts/i18n-check.mjs | tail -1
i18n:check  OK
$ node packages/contracts/scripts/check-clients.mjs
check-clients  OK — 1079 client file(s) scanned, 267 contract path(s) known.
$ (packages/web) npx vitest run --maxWorkers=1 tests/navigation.parity.test.tsx
 Test Files  1 passed (1)
      Tests  12 passed (12)
$ (apps/android) ./gradlew --no-daemon -Dorg.gradle.workers.max=2 :app:compileDebugKotlin
BUILD SUCCESSFUL in 6s
$ (apps/android) ./gradlew … :app:testDebugUnitTest --tests 'hub.core.android.nav.*' --tests '…WorkflowsTest' --tests '…WorkflowFlowTest' --tests '…StringsParityTest'
BUILD SUCCESSFUL in 27s
  AppPathsTest 4 · NavigationParityTest 14 · ToolsDrawerTest 6 · WorkflowsTest 7 · WorkflowFlowTest 12 · StringsParityTest 4 — 0 failures
$ (apps/android) ./gradlew … --tests PushTest LeftoversTest OwnSettingsTest RoomsTest SelfSufficientTest UiKitPolicyTest DestinationsTest
BUILD SUCCESSFUL in 8s
  11 · 6 · 13 · 16 · 24 · 1 · 3 tests — 0 failures
$ (apps/android) ./gradlew … --tests 'hub.core.android.shots.ScreenShots.lightArabic'
BUILD SUCCESSFUL in 20s   (لقطة الدرج بالعربية: الأيقونات في الرأس، «الأدوات» وأعضاؤها الأربعة، RTL سليم)
```
iOS لا يُبنى على هذا الجهاز (لا Swift): البناء واختبارات XCTest على CI فقط — النتيجة أدناه.

CI على PR #211 (الرأس `82fc2be9`، بعد دمج `origin/main`): كل الفحوص ناجحة — Android build, unit tests, lint؛
Build and test on the iOS simulator (أول بناء لكود iOS: `Executed 376 tests, with 0 failures`، `** TEST SUCCEEDED **`)؛
Generate the Swift client؛ Lint, typecheck, contracts, client tests, build؛ Server unit tests (3/3)؛ Web smoke journeys
(Playwright)؛ Desktop app smoke؛ Docker image؛ db:generate + db:migrate؛ change record؛ graphify-out.

## المخاطر والرجوع
- كود iOS كُتب دون مترجم محلي؛ CI هو أول بناء له.
- تطبيق جديد مع مركز قديم: المشغّلات والاختبارات تجيب 404 ← يختفي قسم المشغّلات بهدوء، ويظهر خطأ عادي
  للاختبار؛ الحفظ يعمل (الحقول الجديدة اختيارية ويُبقيها المركز إن غابت). وجهة إرسال بمنصة لا يعرفها
  التطبيق تبقى كما هي.
- الرجوع: revert للـPR؛ لا بيانات ولا ترحيل (حالة المجموعة إعداد محلي على الجهاز).

## التسليم والخطوة التالية
PR واحد إلى `main` بانتظار CI ومراجعة المالك. بعده: تجربة على هاتفي المالك.
