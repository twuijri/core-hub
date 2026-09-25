# تجهيز تطبيق الآيفون للنشر في App Store
المسؤول: twuijri · الفرع: feat/app-store-prep · الحالة: review

## المشكلة والهدف
قرار المالك (٢٠٢٦-٠٩-٢٥): نشر تطبيق الآيفون `com.twuijri.corehub` في App Store (لا متجر ماك، وGoogle Play
لاحقًا). سجلّ التطبيق في App Store Connect موجود، وبناءات TestFlight تخرج من `ios-signed.yml`. الناقص كان
كل ما يحتاجه التقديم عدا البناء: نص الصفحة بالعربية والإنجليزية، وسياسة خصوصية منشورة، وإجابات «خصوصية
التطبيق» والتصنيف العمري، ولقطات الشاشة بالمقاسات المطلوبة، وملاحظات المراجِع، وخطوات المالك للتقديم.

## القرار والموافقات
- **صفحة المتجر** في `apps/ios/fastlane/metadata` بتخطيط fastlane `deliver` للغتين `en-US` و`ar-SA`:
  الاسم "Core Hub" و«كور هب» (اسما المنتج في ADR 0017)، العنوان الفرعي، النص الترويجي، الوصف (ما يفعله
  التطبيق فعلًا حسب STATUS وREADME، بلا أسماء منتجات شركات أخرى)، الكلمات المفتاحية، روابط الدعم والتسويق
  والخصوصية، ملاحظات إصدار 1.1.0، الفئتان (الإنتاجية ثم أدوات المطوّرين — **مقترح، ينتظر تأكيد المالك**)،
  وحقوق النشر. `apps/ios/scripts/store-metadata.mjs` يفحص حدود App Store Connect (والكلمات المفتاحية
  العربية أيضًا ≤ ١٠٠ بايت احتياطًا).
- **سياسة الخصوصية** `docs/privacy.md` و`docs/privacy.ar.md`، رابطها صفحة GitHub للملف على `main` (المستودع
  عام؛ **لم تُفعَّل GitHub Pages**). مطابقة للكود: التطبيق لا يكلّم إلا المركز الذي يختاره المستخدم،
  والمطوّر لا يجمع شيئًا، والإشعارات عبر Apple و«حين يُفعَّل» عبر مرحّل المالك الذي لا يخزّن محتوى، والأذونات
  وأسبابها، والتعرّف على الكلام من Apple حين يُستعمل صوت الجوال.
- **خصوصية التطبيق**: «Data Not Collected» — لا مكتبة تحليلات ولا تقارير أعطال ولا أي طرف ثالث (التطبيق
  يربط أطر Apple والعميل المولَّد فقط). ملاحظة للمالك عند إطلاق المرحّل في `docs/store/apple/README.md`.
- **التصنيف العمري** (مقترح): إجابات متحفّظة تعطي 13+ لأن نموذجًا عامًا قد يكتب عن الطب أو بألفاظ خفيفة،
  مع البديل 4+ وسبب عدم التوصية به.
- **اللقطات آليًا**: مركز تجريبي داخل التطبيق في بناء Debug فقط (`-UITestDemo YES`، `CoreHub/Demo`): يدخل
  التطبيق إليه فورًا، وكل طلب للعميل المولَّد يُجاب من `DemoFixtures.swift` دون شبكة ولا مقبس ولا إشعارات.
  الملف يولّده `apps/ios/scripts/demo-fixtures.mjs` ويفحص كل إجابة على مخطط استجابة عمليتها في
  `openapi.yaml`، والمسارات مأخوذة من العقد لا مكتوبة باليد (ADR 0003). XCUITest `StoreScreenshots` يلتقط
  ست صفحات بكل لغة. المقاسات حسب متطلبات Apple الحالية (تحققت ٢٠٢٦-٠٩-٢٥): آيفون 6.9" ‏1320×2868 كافٍ
  (6.5" مطلوب فقط بدون 6.9")، وآيباد 13" ‏2064×2752 مطلوب لأن التطبيق يعمل على الآيباد.
- **سير العمل** `ios-screenshots.yml` يدوي فقط؛ و`ios-store-metadata.yml` يفحص على الطلبات ويرفع النص يدويًا.
  الرفع بـ fastlane deliver خلف خيار `upload` (مطفأ افتراضيًا)، مع `--skip_binary_upload --skip_submission
  --submit_for_review false`: **لا يقدّم للمراجعة أبدًا**، ولا يرسل التصنيف العمري ولا بيانات المراجِع.
- **مسار الدخول بالعنوان واسم المستخدم وكلمة المرور** موجود في الشاشة الأولى تحت زرّي الاقتران وكلمة «أو»،
  بلا تمرير على الآيفون (لقطة `00-sign-in` في التشغيل تثبت ذلك). لم يلزم إصلاح.
- **ملاحظات المراجِع** `docs/store/apple/review-notes.md` بالإنجليزية. عنوان المركز التجريبي **لم يُكتب في
  المستودع**: قاعدة AGENTS.md تمنع أسماء خوادم المالك، فالملاحظات فيها `<DEMO_HUB_URL>` يضع المالك مكانه
  العنوان عند اللصق (مقترح — ينتظر تأكيد المالك). بيانات حساب المراجِع لا تُكتب في أي مكان؛ يدخلها المالك.
- لم يُرفع شيء ولم يُقدَّم شيء ولم يتغيّر شيء في App Store Connect.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. `demo-fixtures.mjs` يقرأ العقد فقط.

## الملفات والتأثير
- `apps/ios/CoreHub/Demo/DemoHub.swift`، `DemoFixtures.swift` (مولَّد): المركز التجريبي، داخل `#if DEBUG`.
- `apps/ios/CoreHub/Hub/HubAPI.swift`، `App/AppModel.swift`، `App/CoreHubApp.swift`: ربط المركز التجريبي
  (Debug فقط؛ بناء Release بلا تغيير في السلوك).
- `apps/ios/CoreHubTests/DemoHubTests.swift`: كل إجابة تمرّ بالعميل المولَّد وتُفكّ باللغتين، وما ليس فيه يُرفض.
- `apps/ios/CoreHubUITests/StoreScreenshots.swift`، `apps/ios/project.yml` (هدف `CoreHubUITests` ومخطط
  `CoreHubScreenshots`؛ مخطط `CoreHub` يبنيه في الاختبار ولا يشغّله).
- `apps/ios/fastlane/metadata/**`، `apps/ios/scripts/{demo-fixtures.mjs,store-metadata.mjs,asc-api-key-json.sh}`.
- `.github/workflows/ios-screenshots.yml`، `.github/workflows/ios-store-metadata.yml` (جديدان).
- `docs/privacy.md`، `docs/privacy.ar.md`، `docs/store/apple/{README.md,review-notes.md}`، قسم «App Store
  submission» في `docs/RELEASING.md`، `apps/ios/README.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (لا Swift ولا Xcode على هذه الآلة؛ بناء iOS واختباراته على CI):
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm contracts:check-clients
check-clients  OK — 615 client file(s) scanned, 228 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm version:check
version: 1.1.0 everywhere (8 places)
$ node apps/ios/scripts/demo-fixtures.mjs --check
demo-fixtures  OK — 14 answers match the contract; apps/ios/CoreHub/Demo/DemoFixtures.swift is current.
$ node apps/ios/scripts/store-metadata.mjs --summary
en-US/name.txt: 8/30
en-US/subtitle.txt: 26/30
en-US/promotional_text.txt: 163/170
en-US/description.txt: 1620/4000
en-US/keywords.txt: 88/100, 88 bytes
en-US/release_notes.txt: 525/4000
ar-SA/name.txt: 6/30
ar-SA/subtitle.txt: 28/30
ar-SA/promotional_text.txt: 145/170
ar-SA/description.txt: 1407/4000
ar-SA/keywords.txt: 50/100, 83 bytes
ar-SA/release_notes.txt: 417/4000
store-metadata  OK — en-US, ar-SA are within App Store Connect's limits.
```
الفاحصان يرفضان الخطأ (تجربة يدوية): إجابة بدور `boss` وجلسة بلا `title` ←
`/role must be equal to one of the allowed values` و`must have required property 'title'`؛ عنوان فرعي ٣١ حرفًا
وكلمات ١١٤ بايت ومسافات حول الفواصل واسم التطبيق في الكلمات ← أربع مشكلات.

تشغيل اللقطات على الفرع (مشغّل مؤقت `push` على الفرع، أُزيل قبل الطلب؛ `workflow_dispatch` لا يعمل قبل وجود
الملف في `main`)، التشغيل 36181981209، بلا رفع (مهمة الرفع `skipped`):
```
iPhone 17 Pro Max (BA9128D4-…) · iPad Pro 13-inch (M5) (34A60270-…)
Test Case '-[CoreHubUITests.StoreScreenshots testStoreScreenshots]' passed (152.253 seconds).
Test Case '-[CoreHubUITests.StoreScreenshots testStoreScreenshots]' passed (142.930 seconds).
28 screenshots, all at App Store sizes
```
نظرتُ في اللقطات: المحادثة (Markdown وبطاقة الأداة و«فكّر 4 ث»)، الدرج بشارات البروفايلات، الوكلاء،
المهام، محادثة جديدة، الإعدادات، وشاشة الدخول؛ بالعربية من اليمين وبالإنجليزية.

CI على الطلب #153 (بعد دمج `origin/main`): كل الفحوص نجحت، ومنها بناء iOS واختباراته على المحاكي
(`DemoHubTests` الأربعة نجحت)، و«Store listing and demo hub checks»، والخادم والويب وسطح المكتب؛ مهمة الرفع
`skipping`.
```
Test Case '-[CoreHubTests.DemoHubTests testEveryPageOfTheScreenshotsDecodesInBothLanguages]' passed (1.169 seconds).
Test Case '-[CoreHubTests.DemoHubTests testTheDemoIsOffUnlessLaunchedForIt]' passed (0.002 seconds).
Test Case '-[CoreHubTests.DemoHubTests testTheRequestLanguagePicksTheWords]' passed (0.111 seconds).
Test Case '-[CoreHubTests.DemoHubTests testWhatTheDemoHubDoesNotHaveIsRefused]' passed (0.079 seconds).
```

## المخاطر والرجوع
- الرفع (deliver) لم يُجرَّب — ممنوع قبل قرار المالك. أول تشغيل بـ `upload` قد يكشف فرقًا في deliver (مثل
  إنشاء النسخة 1.1.0 إن لم توجد). لا يمس البناء ولا التقديم.
- اسم «كور هب» أو "Core Hub" قد يكون محجوزًا في المتجر؛ App Store Connect يقول ذلك عند الحفظ.
- التصنيف العمري والفئات وقرار «Data Not Collected» مع المرحّل مقترحات للمالك.
- الرجوع: حذف الملفات الجديدة وسطور `#if DEBUG` الثلاثة؛ بناء Release لا يتأثر.

## التسليم والخطوة التالية
طلب دمج إلى `main`. بعد الدمج: المالك يشغّل «iOS store screenshots» ويراجع اللقطات، ثم يعيده مع `upload`،
ويتبع «App Store submission» في `docs/RELEASING.md` (اختيار البناء، بيانات المراجِع، ثم Add for Review / Submit).
