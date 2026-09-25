# تطبيق iOS — الجزء ٢: بقية الوجهات واختبار تكافؤ التنقّل
المسؤول: twuijri · الفرع: feat/ios-app-destinations · الحالة: review

## المشكلة والهدف
قال المالك: «ولو خلصت تطبيق الديسك توب … ابدا بالايفون والاندرويد». الجزء ١ (#120) بنى الهيكل
والاقتران والمحادثة، وبقيت كل وجهة أخرى صفحةً تقول إنها قادمة. هذا الجزء يبني بقية الوجهات الأربع
والثلاثين، وتهيئة أول تشغيل، وروابط `corehub://open/…`، ويضيف اختبار تكافؤ التنقّل الذي يطلبه
`docs/clients/README.md` لكل عميل. مكدَّس على #120: يُدمج بعده.

## القرار والموافقات
كل قرار منتج هنا **مقترح — والمالك يؤكد**:

- **معرّفات الشاشات على iOS هي مسارات الويب نفسها** (`surfaceRoutes.ios`)، و`this_device` مساره
  `/settings/this-device`. السبب: هي نفسها مسارات روابط `corehub://open/<path>` التي يصنعها الويب
  وسطح المكتب، فرابط صُنع لسطح يفتح الصفحة نفسها على الهاتف. `preAuth` لـiOS: `/login` و`/setup`.
- **البحث ورقة** فوق الصفحة الحالية، حقلها مركَّز فورًا، عبر كل البروفايلات؛ نتيجة من الوكيل العام
  تفتح صفحته، وغيرها تفتح المحادثة في بروفايلها دون تحريك المبدّل.
- **الوكلاء**: بطاقة لكل وكيل، وشرائح صفحاته (ما أعلنه المحوّل فقط، و«الإعدادات» لكل وكيل مثبّت)
  تفتح الصفحة مباشرة؛ اسم الوكيل يفتح قائمته. كل صفحة وكيل تبدأ بـ«رجوع إلى الوكلاء» واسم الوكيل
  ومبدّل البروفايل (القاعدة ٤ في §٤)، وزرّ الرجوع المعتاد يبقى أيضًا.
- **ما يُحرَّر على الهاتف وما يُقرأ فقط**: المهارات (تشغيل/إطفاء)، MCP (اختبار)، الذاكرة (تحرير)،
  المهام المجدولة (شغّل الآن)، الإضافات (تشغيل/إطفاء)، إعدادات الوكيل (المفاتيح الثنائية فقط)،
  نقل مهمة، تشغيل جدول الآن، الاسم وكلمة المرور، اختبار webhook، العرض والإشعارات، إلغاء رموز
  التطبيقات، إنشاء بروفايل، رمز اقتران لهاتف آخر. **للقراءة فقط على الهاتف** ويُعدَّل من الويب:
  ربط القنوات (QR واتساب وبوت تيليجرام)، المزوّدون ومفاتيحهم، بقية حقول إعدادات الوكيل، المستخدمون.
  الصفحة تقول ذلك حيث يلزم.
- **الغرف**: القائمة تعرض ما يجيب به المركز حرفيًا (`rooms` ما زالت 501)، لا قائمة فارغة صامتة.
- **تهيئة أول تشغيل** (`setup`): حين يقول المركز إنه بلا مالك، يفتح الدخول شاشة إنشاء المالك،
  وتطلب رمز التهيئة فقط إن انتهت الساعة المفتوحة (ADR 0019).
- **رابط `corehub://open/<path>`** يفتح الصفحة التي يسمّيها، والمحادثة في `?profile=` إن وُجد.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء في `packages/contracts`. تغيّر ملف التنقّل (عقد العملاء): `docs/clients/navigation.json`
أضاف `surfaceRoutes.ios` ومسار iOS لشاشتي `preAuth` — إضافة فقط، بلا تغيير لأي وجهة أو قائمة.

## الملفات والتأثير
- `apps/ios/CoreHub/Navigation/Routes.swift` (جديد): `surfaceRoutes.ios` ومطابقة المسارات.
- `apps/ios/CoreHub/Screens/` (جديد): البحث والوكيل العام، الوكلاء وصفحات الوكيل السبع، المهام
  والجدولة والغرف.
- `apps/ios/CoreHub/Settings/SettingsPages.swift` و`ManagementPages.swift` (جديدان): تبويبات
  الإعدادات الثمانية، الإدارة الثلاث، الأدوات السبع.
- `apps/ios/CoreHub/Shell/AsyncContent.swift` (جديد): محمّل واحد لكل صفحة (انتظار، جملة المركز مع
  «حاول مجددًا»، المحتوى) وعرض JSON لتقارير التدقيق.
- `apps/ios/CoreHub/Auth/LoginScreen.swift`: شاشة التهيئة؛ `App/AppModel.swift`: التهيئة والروابط.
- `apps/ios/CoreHub/i18n/{ar,en}.json`: 123 مفتاحًا جديدًا بالعربية والإنجليزية (257 الآن).
- `apps/ios/CoreHubTests/NavigationParityTests.swift` (جديد): القواعد الثماني.
- `docs/clients/navigation.json` (إضافة `ios`)، `docs/clients/README.md` (قسم iOS)،
  `docs/STATUS.md`، `apps/ios/README.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (عبر `mj-run`):

```
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web, ios
$ pnpm i18n:check
i18n:check  ios: 257 keys, ar/en in parity
i18n:check  OK
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
$ pnpm contracts:check-clients
check-clients  OK — 322 client file(s) scanned, 176 contract path(s) known.
$ pnpm --filter @corehub/web exec vitest run tests/navigation.parity.test.tsx tests/workspace.test.tsx
 Test Files  2 passed (2)
      Tests  12 passed (12)
```

على GitHub Actions (`iOS`، التشغيل 36094307150):

```
Test Case '-[CoreHubTests.NavigationParityTests testEntryLabelEqualsScreenTitle]' passed (0.005 seconds).
Test Case '-[CoreHubTests.NavigationParityTests testEveryDestinationHasAScreenAndNothingElseDoes]' passed (0.014 seconds).
Test Case '-[CoreHubTests.NavigationParityTests testEveryEntryListIsTheManifestsInOrder]' passed (0.001 seconds).
Test Case '-[CoreHubTests.NavigationParityTests testLinksOpenTheirPageInTheirProfile]' passed (0.003 seconds).
Test Case '-[CoreHubTests.NavigationParityTests testRolesAndSurfaces]' passed (0.441 seconds).
Test Case '-[CoreHubTests.NavigationParityTests testSecondaryEntries]' passed (0.001 seconds).
Test Case '-[CoreHubTests.NavigationParityTests testTheAgentLevelFollowsCapabilities]' passed (0.001 seconds).
Test Case '-[CoreHubTests.NavigationParityTests testThePreAuthScreensAreTheManifestsAndNotDestinations]' passed (0.002 seconds).
	 Executed 48 tests, with 0 failures (0 unexpected) in 3.339 (3.566) seconds
** TEST SUCCEEDED **
```

## المخاطر والرجوع
- **لم تُشغَّل أي شاشة على جهاز ولا على مركز المالك.** المُختبَر آليًا: التنقّل كله مقابل الملف،
  والمنطق الصافي؛ الشاشات نفسها تُقرأ أول مرة حين يشغّل المالك التطبيق من Xcode.
- الصفحات تعرض أشكال العقد كما يولّدها المولّد؛ قيمة تعداد جديدة يرسلها المركز ولا يعرفها العميل
  تُفشل فكّ تلك الصفحة وحدها بجملة «ردّ المركز بصيغة لا يقرؤها هذا التطبيق» مع السبب.
- `navigation.json` يتغيّر في فرع أندرويد أيضًا (`surfaceRoutes.android`)؛ من يُدمج ثانيًا يحلّ
  تعارضًا نصيًّا في موضع الإضافة.
- الرجوع: إعادة الملفات أعلاه؛ حذف `surfaceRoutes.ios` من `navigation.json` يُسقط اختبار التكافؤ
  في iOS وحده.

## التسليم والخطوة التالية
طلب الدمج بالإنجليزية، مكدَّس على #120. التالي: الجزء ٣ (إشعارات محلية من إشعارات المركز ما دام
التطبيق يعمل — وحدة `devices` 501 فلا APNs —، إضافة المشاركة، الإملاء والردود المنطوقة في «هذا
الجهاز»).
