# تطبيق iOS — الجزء ١: الهيكل والاقتران والمحادثة
المسؤول: twuijri · الفرع: feat/ios-app · الحالة: review

## المشكلة والهدف
قال المالك: «ولو خلصت تطبيق الديسك توب … ابدا بالايفون والاندرويد». المرحلة ٣ في
`docs/ROADMAP.md` تطلب `apps/ios` عميلًا أصليًا جديدًا من الصفر على العقد وخريطة التنقّل
(ADR 0007). هذا الجزء الأول من ثلاثة: مشروع `apps/ios` (SwiftUI)، الاقتران بالـQR أو بعنوان المركز
وتسجيل الدخول، الهيكل (الدرج، مبدّل البروفايل، قائمة المحادثات بمرشّح «كل البروفايلات»)، والمحادثة
المتدفقة مع الـMarkdown وبطاقات الأدوات والموافقات وأسئلة الوكيل، بالعربية (RTL) والإنجليزية، مع
اختبارات XCTest وسير عمل يبني ويختبر على محاكي macOS.

الجزء ٢ (الوجهات الباقية واختبار تكافؤ التنقّل) والجزء ٣ (خصائص الجوال: الإشعارات، الإضافة
للمشاركة، الإملاء، «هذا الجهاز») في طلبَي دمج تاليين، ولكلٍّ سجلّه.

## القرار والموافقات
المالك نائم وطلب أن نقرّر ونكمل؛ كل قرار منتج هنا **مقترح — والمالك يؤكد**. قرارات الهاتف نفسها
التي اقترحها فرع أندرويد (`feat/android-app`، سجلّه `2026-09-25-twuijri-android-shell-chat.md`)
حتى يتطابق التطبيقان:

- **أقل إصدار iOS 17**: إطار `Observation` و`NavigationStack` و`UnevenRoundedRectangle` و
  `defaultScrollAnchor`؛ ما دون 17 قليل جدًا من أجهزة ٢٠٢٦.
- **القائمة الجانبية على الهاتف درج** من حافة بداية القراءة (اليمين بالعربية)، يفتحه زر القائمة:
  فيه الشريط الأساسي بترتيب `navigation.json` (محادثة جديدة، بحث، الوكلاء للمشرف، المهام، الجدولة)،
  ثم «محادثة · الغرف» والقائمة تحتهما، ثم التذييل (الاسم، نقطة الاتصال، الترس ← الإعدادات، اللغة،
  السمة بثلاثة رموز، الخروج، الإصدار). لا زر «محادثة جديدة» ثانٍ في الشريط العلوي: مدخل واحد لكل وجهة.
- **مكان مبدّل البروفايل على الهاتف** (`NAVIGATION.md`: «الجوال: لم يُقرَّر مكانها»): شريحة في رأس
  الدرج تحت العلامة، لا شريط علوي دائم يأكل المحادثة، وشاشة المحادثة الجديدة تسمّي البروفايل
  («محادثة جديدة في …»). القرار نفسه في أندرويد.
- **الإعدادات على الهاتف**: القائمة هي الصفحة، أعلاها «رجوع إلى المحادثات» يعيد إلى آخر صفحة، وكل
  صفحة منها تعرض طريق الرجوع (`NAVIGATION.md` §٢).
- **الاقتران**: QR المركز (`corehub.pairing`، و`majlis.pairing` من مركز أقدم)، أو لصق نصّه، أو رابط
  `corehub://pair?hub=…&id=…&code=…` كما يقبله تطبيقا سطح المكتب وأندرويد، مع التحقق نفسه من المعرّف
  والرمز. الرموز كلها في Keychain (`AfterFirstUnlockThisDeviceOnly`)، لا في UserDefaults.
- **التجديد**: رمز الدخول يُجدَّد قبل انتهائه بـ٣٠ ثانية وعند `401` مرة واحدة ثم يُعاد الطلب، وتجديد
  واحد في وقت واحد (actor). رمز التطبيق من الاقتران يُجدَّد مرة في اليوم على الأكثر
  (`auth.refresh` بالحامل وبلا جسم). رفض التجديد يُخرج الشخص مع جملة تقول ذلك.
- **الاتصال اللحظي بلا مكتبة**: Socket.IO v5 فوق `URLSessionWebSocketTask` بكودنا (ترميز الحزم
  مختبَر). مكتبة `socket.io-client-swift` رخصتها MIT وكان يمكن إضافتها، لكن ما نحتاجه صغير (حزمة
  الاتصال، الأحداث، الإقرارات، ping) ولا يستحق تبعية خارجية. الإعادة بتأخير متزايد حتى ٣٠ ثانية،
  والاشتراك من جديد بـ`after_seq` بعد كل عودة، و`truncated` يعيد قراءة المحادثة.
- **الـMarkdown**: `AttributedString` من النظام لما داخل السطر، وتقسيم الكتل (فقرات، عناوين،
  قوائم، اقتباس، كود، فاصل) بمحلّل صغير مختبَر؛ الكود يبقى من اليسار لليمين دائمًا.
- **قاعدة المحادثة** من `DESIGN.md`: الشخص يمينًا والوكيل يسارًا في كل لغة، والمحتوى يقرّر اتجاهه
  بأول حرف قوي. مؤشّر «يفكّر · ١٢ ث · الأداة» فوق الملحّن ما دام التشغيل حيًّا، وبعده «فكّر ١٢ ث»
  مطويًّا، ولا رقم مختلق حين لا تُعرف المدة.
- **الزجاج** على الكروم العائم وحده (الدرج، الملحّن) بمادة النظام، ويصير صلبًا مع «تقليل الشفافية».
- **`http://` مسموح** (`NSAllowsArbitraryLoads`): المركز الذاتي كثيرًا ما يكون على عنوان شبكة
  محلية أو VPN بلا TLS.
- **معرّف الحزمة المقترح** `io.github.twuijri.corehub`، ومخطّط الروابط `corehub`.
- **التوقيع والنشر**: لا شيء موقَّع ولا منشور؛ ما يحتاجه المالك مكتوب في `apps/ios/README.md`
  (حساب Apple، `DEVELOPMENT_TEAM`، TestFlight).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا عملية ولا حدث جديد، ولا تغيير في `openapi.yaml`. تغيّر **مولّد Swift وحده**:

- أول عميل Swift ولّده CI **لم يُترجَم** (`cannot assign value of type 'CoreHubClient.Locale?' to
  type 'Foundation.Locale?'`)، وقراءة مخرَجه أظهرت ما هو أسوأ: `category_id: oneOf [Ulid, null]`
  المطلوبة خرجت `String` غير اختيارية، فيفشل فكّ أي قائمة فيها `null` حقيقي، و`sessionsCreateRun`
  خرجت **بلا `session_id`** لأن المولّد يُسقط معاملات مستوى المسار من عملية لها معاملات خاصة.
- `scripts/swift-openapi.mjs` (جديد) يُعدّ نسخة من الوثيقة لمولّد Swift وحده (المصدر لا يُمسّ):
  كل خاصية تقبل `null` تصير اختيارية، ومعاملات مستوى المسار تُنسخ إلى كل عملية، والمكوّنات التي
  تحمل اسمًا يملكه Swift تأخذ بادئة (`Task` ← `HubTask`، `Locale` ← `HubLocale`).
- `scripts/generate-native.mjs`: Swift يقرأ النسخة المُعدّة (`generated/openapi.swift.yaml`)؛ Kotlin
  كما هو هنا. فرع أندرويد أضاف إعدادًا مماثلًا لـKotlin (`kotlin-openapi.mjs`) في الملف نفسه، فمن
  يُدمج ثانيًا يحلّ تعارضًا نصيًّا صغيرًا في `targets` (سطر لكل مولّد).
- `tests/swift-openapi.test.ts` (جديد) على العقد الحقيقي.

## الملفات والتأثير
- `apps/ios/` جديد: `project.yml` (XcodeGen؛ ملف المشروع مولَّد لا يُودَع)، `CoreHub/` (App، Auth،
  Hub، Realtime، Chat، Sessions، Navigation، Shell، Settings، Theme، i18n)، `CoreHubTests/`،
  `README.md`، `scripts/generate-swift.mjs`.
- `apps/ios/scripts/generate-swift.mjs` يولّد من المستودع ويُودَع ناتجه: `Generated/Tokens.swift`
  (ألوان السمتين والزجاج والمسافات والأنصاف والخطوط والحركة من `packages/ui-tokens/tokens.json`)،
  `Generated/Product.swift` (الاسم والمعرّف ونوع رمز الاقتران من `packages/contracts/src/product.ts`)،
  و`Resources/{ar,en}.lproj/InfoPlist.strings` (اسم التطبيق وجمل أذونات النظام بالعربية
  والإنجليزية). CI يفشل إن تأخّر أيٌّ منها عن مصدره (`--check`).
- `apps/ios/CoreHub/i18n/{ar,en}.json`: كل نص بالعربية والإنجليزية؛ `nav.*` هي `terms` حرفيًا.
- `.github/workflows/ios.yml` (جديد): Linux يولّد عميل Swift ويفحص الملفات المولّدة، ثم
  `macos-latest` يولّد المشروع بـXcodeGen ويشغّل `xcodebuild build test` على محاكي iPhone ويرفع
  السجل ونتيجة الاختبارات. لا توقيع ولا نشر. يعمل فقط حين يتغيّر ما يخص iOS.
- `packages/server/tests/unit/native-realtime-frames.test.ts` (جديد، اختبار فقط): يرسل للمركز
  الحقيقي **الإطارات نفسها** التي يكتبها التطبيق (قبول نطاق بالحامل، رفض بسببه، `subscribe` بإقرار
  يحمل رقمه، ورسالة متدفقة كأحداث)، ويُثبت أن `POST` بلا جسم يُرفض إن ادّعى JSON ويُخدم إن لم يدّعِ —
  ولهذا يُسقط التطبيق `Content-Type` من طلب بلا جسم.
- مشترك، إضافة فقط: `scripts/i18n-check.mjs` (مجموعة `ios`)، `docs/STATUS.md` (العملاء).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (Linux، عبر `mj-run`):

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck        → exit 0, 0 × "error TS"
$ pnpm i18n:check
i18n:check  ios: 134 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contracts:check-clients
check-clients  OK — 314 client file(s) scanned, 176 contract path(s) known.
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm change-record:check
change-record  OK — 1 record(s) valid

$ (packages/contracts) vitest run tests/swift-openapi.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
$ (packages/server) vitest run tests/unit/native-realtime-frames.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
$ node apps/ios/scripts/generate-swift.mjs --check
generate-swift  OK — every generated file matches its source
```

على GitHub Actions (`iOS`، التشغيل 36092981058، Xcode 26.6، Swift 6.3.3، محاكي iOS 26):

```
Generate the Swift client (CoreHubClient): success
generate-swift  OK — every generated file matches its source
** BUILD SUCCEEDED **
	 Executed 40 tests, with 0 failures (0 unexpected) in 2.208 (2.840) seconds
** TEST SUCCEEDED **
```

الاختبارات الأربعون: محوّل حالة المحادثة (التدفق، القشرة لرسالة لم تصل، الأدوات، فشل التشغيل
وإيقافه، الموافقات، تجاهل جلسات أخرى، `after_seq` من بروفايل الجلسة وحده، الترطيب والصفحات
الأقدم، تجميع الأدوار)، إطارات Engine.IO/Socket.IO بالنص الحرفي، الاقتران (QR، الرابط، الرفض،
الانتهاء)، العناوين، توقيت التجديد، اختيار البروفايل، الـMarkdown، اتجاه المحتوى، تطابق العربية
والإنجليزية ومصطلحات `navigation.json` (من الملف نفسه منسوخًا وقت البناء)، ألوان السمتين مقابل
`tokens.json`، قائمة الوكيل حسب القدرات، وإسقاط `Content-Type` من طلب بلا جسم.

## المخاطر والرجوع
- **لم يُشغَّل التطبيق على جهاز ولا على مركز المالك.** بُني واختُبرت منطقياته على المحاكي، وإطارات
  الاتصال اللحظي مُثبتة على المركز الحقيقي في اختبار الخادم؛ الشاشات نفسها لم يرها أحد بعد. أول
  تجربة للمالك على Mac بـXcode (الخطوات في `apps/ios/README.md`).
- الـMarkdown أبسط من الويب (لا جداول)؛ الجداول تظهر نصًّا.
- مولّد Swift يقرأ نسخة مُعدّة؛ إن تغيّر العقد بشكل لا يغطيه `swift-openapi.mjs` يسقط بناء iOS في
  CI لا غيره.
- الرجوع: حذف `apps/ios` و`.github/workflows/ios.yml` و`scripts/swift-openapi.mjs` وإعادة سطر
  Swift في `generate-native.mjs`؛ لا شيء في الخادم أو الويب يعتمد عليها.

## التسليم والخطوة التالية
طلب الدمج بالإنجليزية على `twuijri/core-hub`. التالي: الجزء ٢ (بقية الوجهات، واختبار تكافؤ التنقّل
مع `surfaceRoutes.ios`) ثم الجزء ٣ (إشعارات محلية ما دام التطبيق يعمل — وحدة `devices` ما زالت
501 فلا تسجيل APNs —، إضافة المشاركة، الإملاء، «هذا الجهاز»). على المالك: تأكيد القرارات أعلاه،
وحساب Apple للتوقيع حين يريد التطبيق على جهازه.
