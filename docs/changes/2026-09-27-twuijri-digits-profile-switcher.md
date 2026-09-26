# الأرقام الإنجليزية في كل العملاء، وتبديل البروفايل أسفل قائمة الجوال
المسؤول: twuijri · الفرع: night/digits-profile · الحالة: review

## المشكلة والهدف
اختياران للمالك (2026-09-26، قبل ليلة التطبيقات):
1. **الأرقام إنجليزية (123) في كل العملاء، وفي الواجهة العربية أيضًا.** الأندرويد يعرض أرقامًا هندية في مواضع
   («٤٣ ث» في صف نشاط الأدوات) لأنه يتبع أرقام اللغة العربية للجهاز؛ الويب والآيفون غالبًا إنجليزية. المطلوب:
   الأعداد والمدد والأحجام والتواريخ والأوقات والعدّادات والنسب وأرقام الإصدارات بأرقام إنجليزية، مع بقاء
   الكلمات العربية وصيغ الجمع والاتجاه من اليمين.
2. **تبديل البروفايل في الجوال أسفل القائمة الجانبية** بجانب اسم الحساب ونقطة الاتصال (الآيفون والأندرويد)،
   شريحة صغيرة باسم البروفايل الحالي تفتح القائمة، ويُحذف مكانه القديم أعلى القائمة. الويب وسطح المكتب كما هما.

## القرار والموافقات
قرار المالك 2026-09-26، ليس مقترحًا — DECISIONS §113:
- **مرة واحدة لكل عميل، على اللغة المستعملة في التنسيق**، لا شاشة شاشة:
  - الويب/سطح المكتب: `intlLocale(language)` في `packages/web/src/i18n/index.ts` يعطي `ar-u-nu-latn` للعربية.
    كل `Intl.NumberFormat/DateTimeFormat/RelativeTimeFormat` وكل `toLocale*String` في الويب صار يمر به (29 ملفًا،
    منها ثلاث مواضع كانت تستعمل لغة المتصفح بلا لغة أصلًا: `AgentChannelsScreen` و`LinkedHubsScreen`). اختبار يقرأ
    المصدر ويرفض أي منسّق جديد لا يمر به.
  - الآيفون: `AppLanguage.locale` صار `Locale.latinDigits` (`@numbers=latn`)، فكل `DateFormatter` و`DateComponentsFormatter`
    والبيئة `\.locale` بأرقام إنجليزية؛ والأحجام («3.4 MB») كانت `ByteCountFormatter` بأرقام الجهاز فصارت
    `ByteCount.text` عبر `ByteCountFormatStyle` بلغة الجهاز مع `latn`.
  - الأندرويد: `Digits` جديد (`apps/android/app/src/main/java/hub/core/android/Digits.kt`): سياق النشاط يُبنى دائمًا
    بلغة التطبيق (أو قائمة لغات الجهاز حين يتبعه) مع `-u-nu-latn`، والافتراضي للعملية يأخذ المفتاح نفسه، فيتفق
    `stringResource` والجمع و`String.format` و`Formatter.formatShortFileSize` و`DateUtils` — حتى حين يتبع التطبيق جهازًا
    عربيًا (كان هذا المسار بلا تغيير أصلًا فيأخذ أرقام الجهاز).
  - كتالوجات النصوص: حُوّلت الأرقام الهندية (وعلاماتها ٪ ٬ ٫) إلى إنجليزية في كل ملفات العربية: الخادم، CLI، الويب،
    الآيفون، الأندرويد (`values-ar`)، ونصوص إعدادات هرمز العربية في `hermes-settings.ts`. و`pnpm i18n:check` يفشل على
    أي رقم هندي في كتالوج عربي أو في `values-ar` للأندرويد. المحتوى الذي يكتبه الشخص أو الوكيل يُعرض كما كُتب.
- **شريحة البروفايل في تذييل الدرج** (iOS وAndroid): صغيرة (ارتفاع `heightSm`، خلفية `surface2`، زوايا `full`،
  أيقونة `layout-grid` كما في جدول العائلة، سهم عند أكثر من بروفايل) بجانب نقطة الاتصال، تفتح نفس قائمة البروفايلات.
  حُذف المحدد من أعلى الدرج. رأس صفحات الوكيل في الآيفون يبقى بمحدده الكامل لأن تلك الصفحات تحرّر بروفايلًا واحدًا.
- لا نصوص جديدة: الشريحة تستعمل المفاتيح الموجودة (`shell.profile_current`/`profile_switch` في iOS و`profile_label` في Android).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. قرار في `docs/contracts/DECISIONS.md` §113.

## الملفات والتأثير
- الويب: `packages/web/src/i18n/index.ts` (`intlLocale`)، و29 ملفًا تحت `packages/web/src/**` تستعمله؛ تعليقات فيها
  أمثلة أرقام هندية صُحّحت؛ `packages/web/tests/latin-digits.test.ts` (جديد)؛ `tests/hermes-settings.test.tsx`
  و`tests/schedule-run-options.test.tsx` ومواصفات e2e الثلاث (`zzzzz-hub-schedules`، `zzzzzz-schedule-templates`،
  `zzzzzz-hermes-settings`) تتبع النص الجديد.
- الكتالوجات: `packages/{server,cli,web}/src/i18n/ar.json`، `apps/ios/CoreHub/i18n/ar.json`،
  `apps/android/app/src/main/res/values-ar/{strings,strings_parity}.xml`، `packages/server/src/modules/agents/hermes-settings.ts`.
- `scripts/i18n-check.mjs`: قاعدة «لا أرقام هندية» للكتالوجات العربية و`values-ar`.
- الأندرويد: `Digits.kt` (جديد)، `MainActivity.attachBaseContext`، `CoreHubApp.onCreate` (`AppGraph.kt`)،
  `ui/screens/Shell.kt` (الشريحة في التذييل)، `app/src/test/.../phone/DigitsTest.kt` (جديد)،
  `app/src/testDebug/.../shots/ScreenShots.kt` (يتحقق أن الشريحة في التذييل على سطر نقطة الاتصال).
- الآيفون: `CoreHub/i18n/L10n.swift` (`Locale.latinDigits`، `ByteCount`)، `Chat/Attachments.swift`، `Settings/LiveTools.swift`،
  `Shell/SidebarView.swift` (الشريحة في التذييل، `ProfileSelector(compact:)`)، `CoreHubTests/DigitsTests.swift` (جديد).
- الوثائق: `docs/design/family.md` (سطر الأرقام، وسطر الشريحة في جدول الجوال)، `docs/clients/NAVIGATION.md`
  و`docs/clients/navigation.json` (مكان المحدد في الجوال)، `docs/contracts/DECISIONS.md` §113.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm typecheck            → exit 0
$ pnpm lint                 → All matched files use Prettier code style!
$ pnpm i18n:check
i18n:check  server: 198 keys, ar/en in parity
i18n:check  cli: 252 keys, ar/en in parity
i18n:check  web: 3201 keys, ar/en in parity
i18n:check  desktop: 103 keys, ar/en in parity
i18n:check  ios: 710 keys, ar/en in parity
i18n:check  android: Arabic resources use Latin digits
i18n:check  OK
(على ar.json الويب القديم: i18n:check  FAILED with 36 problem(s))
$ pnpm nav:check
nav:check  OK — 39 destinations, 2 pre-auth screens (login, setup), 44 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm contracts:check-clients
check-clients  OK — 804 client file(s) scanned, 254 contract path(s) known.
$ pnpm --filter @corehub/web exec vitest run tests/latin-digits.test.ts tests/device-cards.test.tsx … (17 ملفًا)
 Test Files  17 passed (17)
      Tests  121 passed (121)
$ vitest run tests/usage-reports … workspace-files … file-preview … (6 ملفات)
 Test Files  6 passed (6)
      Tests  79 passed (79)
$ vitest run tests/hermes-settings.test.tsx → Tests  9 passed (9)
$ (server) vitest run src/modules/agents/hermes-settings → Tests  42 passed | 3 skipped (45)
$ ./gradlew :app:testDebugUnitTest --tests DigitsTest --tests UiKitPolicyTest --tests StringsParityTest \
    --tests NavigationParityTest --tests shots.ScreenShots
hub.core.android.phone.DigitsTest        tests=4 failures=0 errors=0
hub.core.android.ui.UiKitPolicyTest      tests=1 failures=0 errors=0
hub.core.android.ui.StringsParityTest    tests=3 failures=0 errors=0
hub.core.android.nav.NavigationParityTest tests=8 failures=0 errors=0
hub.core.android.shots.ScreenShots       tests=4 failures=0 errors=0
```
- على JDK 17 نفسه: `String.format(ar-SA, "%d", 43)` = «٤٣» و`ar-SA-u-nu-latn` = «43» (أول اختبار في `DigitsTest` يثبت ذلك،
  فالاختبار يفشل على الشيفرة القديمة). لقطات الدرج (`build/shots/*/android-02-chats.png`) تُظهر «Sara ● ▦ Work ⇅» في التذييل.
- الآيفون لا يُبنى على Linux: `DigitsTests.swift` وتغييرات Swift تُثبت في مهمة iOS على #181.
- CI على #181: يُضاف بعد الدفع.

## المخاطر والرجوع
- `Locale.setDefault` في الأندرويد يضيف مفتاح الأرقام فقط ولا يغيّر اللغة، فـ`AppLanguage.system()` يقرأ لغة الجهاز كما كان.
- حين يتبع التطبيق الجهاز صار السياق يُبنى بقائمة لغات الجهاز مع `latn` بدل تركه كما هو؛ لغة الموارد لا تتغير.
- الرجوع: إرجاع التزام المهمة؛ لا بيانات ولا عقد.

## التسليم والخطوة التالية
يُدمج في `night/2026-09-27-apps` (#181). يراجع المالك الشريحة في الجوال صباحًا مع إصدار 1.1.3.
