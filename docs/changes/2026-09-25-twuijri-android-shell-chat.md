# تطبيق أندرويد — الجزء ١: الهيكل والإقران والمحادثة
المسؤول: twuijri · الفرع: feat/android-app · الحالة: review

## المشكلة والهدف
قال المالك: «ولو خلصت تطبيق الديسك توب … ابدا بالايفون والاندرويد». المرحلة ٣ في
`docs/ROADMAP.md` تطلب عميل أندرويد جديدًا من الصفر على العقد وخريطة التنقّل (ADR 0007). هذا
الجزء الأول من ثلاثة: مشروع `apps/android` (Kotlin + Jetpack Compose)، الإقران بالـQR أو بعنوان
المركز وتسجيل الدخول، الهيكل (القائمة الجانبية، مبدّل البروفايل، قائمة المحادثات بمرشّح «كل
البروفايلات»)، والمحادثة كاملة مع البث اللحظي والـMarkdown والكود وبطاقات الأدوات والموافقات
وأسئلة الوكيل، بالعربية (RTL) والإنجليزية، مع اختبارات وحدات وسير عمل CI يبني الـAPK.

الجزء ٢ (الوجهات الباقية واختبار تكافؤ التنقّل) والجزء ٣ (خصائص الجوال) في طلبَي دمج تاليين على
الفرع نفسه، ولكلٍّ سجلّه.

## القرار والموافقات
المالك نائم وطلب أن نقرّر ونكمل؛ كل قرار منتج هنا **مقترح — والمالك يؤكد**:

- **أقل إصدار أندرويد 26 (8.0)**: العميل المولَّد يستعمل `java.time` (إعداد المولّد
  `dateLibrary: java8`)، وأندرويد يملكها من 26 بلا desugaring، وقنوات الإشعارات والأيقونات
  المتكيّفة من 26 أيضًا. ما تحت 26 قرابة ١٪ من الأجهزة. السبب مكتوب في `app/build.gradle.kts`.
- **القائمة الجانبية على الجوال درجٌ (drawer)، لا شريط سفلي**: `NAVIGATION.md` §١ يقول إن القائمة
  «متطابقة على كل السطوح» وإن في رأسها «زر إغلاق على الجوال»، فالدرج هو القائمة نفسها؛ فيه الشريط
  الأساسي (محادثة جديدة، بحث، الوكلاء للمشرف، المهام، الجدولة) ثم مقطعا «محادثة · الغرف» والقائمة
  تحتهما، ثم التذييل (الاسم، نقطة الاتصال، الترس ← الإعدادات، تسجيل الخروج، اللغة، السمة بثلاثة
  رموز، الإصدار).
- **مكان مبدّل البروفايل على الجوال** («الجوال: لم يُقرَّر مكانها»): شريحة في أعلى الدرج تحت
  العلامة، لا شريط علوي دائم. لا تأخذ مساحة من المحادثة ولا المهام، وشاشة المحادثة الجديدة تسمّي
  البروفايل الذي ستُنشأ فيه («في البروفايل …»)، ومحادثة من بروفايل آخر تحمل اسمه تحت عنوانها.
- **مرشّح قائمة المحادثات**: «كل البروفايلات» افتراضيًا عند كل دخول، ثم شريحة لكل بروفايل، ويختفي
  لمن له بروفايل واحد؛ لا يحرّك المبدّل ولا يحرّكه المبدّل (ADR 0016). شارة البروفايل على كل صف
  ما دامت القائمة قد تحوي أكثر من بروفايل، والمحادثة تُفتح في بروفايلها دون تحريك المبدّل.
- **الزجاج على الجوال بلا ضبابية**: الشريط العلوي والمُلحِّن زجاجيان بدرجة الشفافية وحدّها من
  `tokens.json`، والفقاعات والبطاقات صلبة (`DESIGN.md`). ضبابية ما خلف العنصر غالية على البطارية
  ومعقّدة قبل أندرويد 12، وأسباب `DESIGN.md` نفسها (وضوح العربية، البطارية) تفضّل تركها على الهاتف.
  «النص عالي التباين» في النظام يُسقط الزجاج إلى صلب، كما يفعل `prefers-reduced-transparency` في
  الويب، وإيقاف الحركات في النظام يوقف نقاط «يفكّر» ويُبقي العدّاد.
- **التخزين الآمن**: الرموز في `SharedPreferences` مختومة بمفتاح AES-256-GCM يولَّد داخل Android
  Keystore ولا يغادره (لا مكتبة `security-crypto` المهجورة ولا Tink، فلا حجم زائد). قيمة لا تُفتح
  (مفتاح ممسوح) تُقرأ غائبة فيُطلب الاتصال من جديد بدل الانهيار. `allowBackup=false`.
- **التجديد** كما في العقد والعميل المرجعي: جلسة الويب تُجدَّد قبل انتهائها بـ٣٠ ثانية وعند
  `401 token_expired` مرة واحدة ثم يُعاد الطلب، ورمز التطبيق (من الإقران) يُجدَّد إذا بقي أقل من سبعة
  أيام (`auth.refresh` بالحامل وبلا جسم) ويُمدّ أجله بمدّته الأصلية. تجديد واحد في وقت واحد، فلا
  يدوّر طلبان متزامنان رمز التحديث نفسه. أي `401` غير ذلك (رمز ملغى) يُخرج الشخص.
- **الإقران** يقبل QR المركز (`corehub.pairing`، و`majlis.pairing` من مركز أقدم من إعادة التسمية)،
  أو لصق الرمز، أو رابط `corehub://pair?hub=…&id=…&code=…` كما يقبله تطبيق سطح المكتب؛ رمز منتهٍ أو
  رمز تطبيق آخر يُرفض بجملة واضحة. الماسح `zxing-android-embedded` (صغير، بلا خدمات Google).
- **المحادثة**: الشخص يمينًا والوكيل يسارًا في كل لغة (قاعدة `DESIGN.md`)، والمحتوى يقرّر اتجاهه
  (أول حرف قوي). مؤشّر «يفكّر · ١٢ ث · الأداة» فوق المُلحِّن أثناء التشغيل، وبعده «فكّر ١٢ ث» مطويًّا.
  أول رسالة في محادثة جديدة تنشئ الجلسة ثم تنتظر اشتراك الشاشة قبل الإرسال، فلا يضيع حدث من أول رد.
  بعد انقطاع الاتصال يُعاد الاشتراك بـ`after_seq`، و`truncated` يعيد قراءة الجلسة.
- **صفحات لم تُبنَ على الجوال بعد** (البحث، الوكلاء، المهام، الجدولة، الإعدادات) تقول ذلك صراحةً
  وتصل في الجزء ٢؛ الغرف تعرض كلمات المركز (`rooms` ما زال 501).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا عملية ولا حدث جديد. تغيّر **مولّد Kotlin وحده** (لا `openapi.yaml`):
- `scripts/kotlin-openapi.mjs` (جديد) يُعدّ نسخة من الوثيقة للمولّد، لأن `openapi-generator` 7.10
  يقرأ OpenAPI 3.1 خطأً لـKotlin في أربعة مواضع، وكلٌّ منها كسر العميل فعلًا:
  1. خاصية `oneOf: [X, null]` أو `type: [x, 'null']` مطلوبة كانت تخرج غير قابلة للـnull، فيرفض
     kotlinx أي `null` حقيقي من المركز (`room_id`، `finished_at`…) — تصير اختيارية `T? = null`.
  2. `ContentBlock` (oneOf بمميّز `type`) كان واجهة متعدّدة الأشكال لا يقرؤها kotlinx — تصير صنفًا
     واحدًا بكل حقول المتغيّرات و`type` تعداد.
  3. معاملات مستوى المسار (`session_id`) كانت تسقط من عملية لها معاملات خاصة (`createRun`،
     `listMessages` خرجت بلا `session_id`) — تُنسخ إلى كل عملية.
  4. حقل نموذج multipart بتعداد له قيمة افتراضية كان لا يُترجَم (`purpose = message`) — يُضمَّن التعداد
     بلا الافتراضي.
- `openapi-generator/kotlin.yaml`: القيمة الحرّة (`{}`) صارت `JsonElement` بدل `kotlin.Any` الذي لا
  مُسلسِل له (وسائط الأدوات والإعدادات).
- `scripts/generate-native.mjs`: Kotlin يقرأ النسخة المُعدّة (`generated/openapi.kotlin.yaml`)، ويُضاف
  `explicitNulls = false` إلى JSON المولَّد حتى لا يرسل PATCH مبنيّ من نموذج `null` لكل حقل لم يقصده
  (يفشل بصوت عالٍ إن تغيّر نص المولّد). Swift لم يتغيّر.

## الملفات والتأثير
- `apps/android/` جديد: Gradle 8.11.1 (wrapper)، AGP 8.9.2، Kotlin 2.1.21، Compose BOM 2026.06.01؛
  الوحدة `:client` مصادرها مخرَج المولّد مباشرة (`packages/contracts/generated/kotlin`، غير
  مُودَع) وتفشل برسالة واضحة إن لم يُولَّد؛ الوحدة `:app` التطبيق.
- `app/build.gradle.kts`: مهمة `generateSharedSources` تولّد من المستودع وقت البناء: ألوان
  السمتين والزجاج والمسافات والأنصاف والخطوط من `packages/ui-tokens/tokens.json` (Kotlin)،
  واسم المنتج ونوع رمز الإقران من `packages/contracts/src/product.ts`، ومصطلحات التنقّل
  (`term_*` بالعربية والإنجليزية) من `docs/clients/navigation.json`. لا نسخة يدوية ثانية لأيٍّ منها.
- `app/src/main/java/hub/core/android/`: `data/` (التخزين المختوم، الجلسة، HTTP والتجديد، الإقران
  والروابط)، `realtime/` (Socket.IO على `/rt/*` بـ`profiles: 'all'`)، `chat/` (محوّل حالة المحادثة
  والأدوار)، `markdown/` (CommonMark + جداول GFM، والـHTML يُعرض نصًّا لا يُنفَّذ)، `nav/` (الوجهات
  بمعرّفات `navigation.json`)، `ui/` (السمة، الدرج، شاشات الاتصال والمحادثة، البطاقات).
- `app/src/main/res/values{,-ar}/strings.xml`: كل نص بالعربية والإنجليزية.
- `app/src/test/`: ٤٠ اختبار وحدة (أدناه).
- `.github/workflows/android.yml` (جديد): Ubuntu، Java 17، Android SDK، توليد عميل Kotlin، ثم
  `./gradlew assembleDebug test lint` ورفع `app-debug.apk` مُنتجًا للتشغيل (١٤ يومًا). لا نشر ولا توقيع.
- `packages/contracts/tests/kotlin-openapi.test.ts` (جديد) يختبر الإعداد، وعلى العقد الحقيقي: لا
  خاصية مطلوبة تقبل null بعده.
- مشترك، إضافة فقط: `eslint.config.js` و`.prettierignore` يتجاهلان مخرجات Gradle؛
  `docs/STATUS.md` (العملاء).

الاختبارات:
- `ContractExamplesTest`: كل مثال استجابة في `openapi.yaml` (٢١٩ مثالًا) يُفكّ بالعميل المولَّد.
  هذا هو الدليل أن المولّد بعد الإصلاح يقرأ ما يرسله المركز. لم يُشغَّل على مخرَج المولّد القديم لأن
  ذلك المخرَج لا يُترجَم أصلًا (`purpose = message`)، ومثال `Message` وحده فيه `"room_id": null`
  لحقل كان `String` غير قابل للـnull.
- `AuthTest` (MockWebServer): تجديد عند `token_expired` ثم إعادة الطلب، تجديد واحد لأربعة طلبات
  متزامنة، تجديد استباقي، رمز التطبيق يُجدَّد بالحامل بلا جسم ويبقى، رفض التجديد يُخرج الشخص، رمز
  ملغى يُخرج بلا تجديد، مركز لا يُوصل إليه لا يُخرج أحدًا.
- `ChatReducerTest` (بأشكال أمثلة العقد): بناء الرد من القشرة والأجزاء والرسالة النهائية، قشرة
  متأخرة لا تمحو ما بُثّ، الأدوات، الموافقات والأسئلة، فشل التشغيل بكلمات المركز، تجاهل أحداث جلسات
  أخرى، `after_seq` من بروفايل الجلسة وحده، تجميع الأدوار.
- `PairingTest`، `SecureStoreTest`، `MarkdownTest` (ومنه اتجاه المحتوى)، `ChatsListTest`،
  `StringsParityTest` (المفاتيح والعناصر النائبة متطابقة، ولا «مساحة عمل»).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (JDK 17، Android SDK 35، عبر `mj-run`، Gradle بـ`--no-daemon --max-workers=2`):

```
$ pnpm --filter @corehub/contracts generate:native
contracts:generate:native  kotlin -> generated/kotlin
contracts:generate:native  swift -> generated/swift
contracts:generate:native  OK

$ ./gradlew --no-daemon --max-workers=2 :app:testDebugUnitTest
testsuite hub.core.android.chat.ChatReducerTest tests="8" failures="0" errors="0"
testsuite hub.core.android.contract.ContractExamplesTest tests="1" failures="0" errors="0"
  contract examples decoded: 219
testsuite hub.core.android.data.AuthTest tests="8" failures="0" errors="0"
testsuite hub.core.android.data.PairingTest tests="7" failures="0" errors="0"
testsuite hub.core.android.data.SecureStoreTest tests="3" failures="0" errors="0"
testsuite hub.core.android.markdown.MarkdownTest tests="6" failures="0" errors="0"
testsuite hub.core.android.ui.ChatsListTest tests="5" failures="0" errors="0"
testsuite hub.core.android.ui.StringsParityTest tests="2" failures="0" errors="0"

$ ./gradlew --no-daemon --max-workers=2 assembleDebug lint
Wrote HTML report to file:///…/apps/android/app/build/reports/lint-results-debug.html
(0 errors, 10 warnings: UseKtx 4, ModifierParameter 2, AppBundleLocaleChanges, DiscouragedApi,
 DataExtractionRules, ObsoleteSdkInt)
app-debug.apk  14,671,143 bytes (14.0 MB, debug, غير مُصغَّر)

$ pnpm --filter @corehub/contracts exec vitest run tests/kotlin-openapi.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)

$ pnpm --filter @corehub/contracts typecheck    (نجح)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm contracts:check-clients
check-clients  OK — 315 client file(s) scanned, 176 contract path(s) known.
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
```

CI: يُضاف بعد الدفع.

## المخاطر والرجوع
- حجم الـAPK التجريبي ١٤ م.ب لأنه بلا تصغير؛ نسخة الإصدار مفعّل فيها R8 وتقليص الموارد ولم تُبنَ هنا.
- الماسح `zxing-android-embedded` يستعمل واجهة الكاميرا القديمة؛ يعمل على كل الأجهزة، وإن احتجنا
  لاحقًا CameraX + ML Kit فالتبديل داخل `ConnectScreen` وحده.
- `usesCleartextTraffic=true` لأن مركز الشبكة المنزلية كثيرًا ما يكون `http://192.168.x.x`؛ التطبيق لا
  يرسل رمزًا إلا إلى العنوان الذي أعطاه الشخص أو QR المركز.
- الرجوع: حذف `apps/android` و`android.yml` وإرجاع ملفات المولّد الثلاثة؛ لا شيء في الخادم أو الويب
  يعتمد عليها، وSwift لم يتغيّر.

## التسليم والخطوة التالية
- الجزء ٢: الوجهات الباقية (المهام، الجدولة، الوكلاء للقراءة، قائمة الإعدادات، صندوق الإشعارات، البحث)
  واختبار تكافؤ التنقّل مع `navigation.json` ومسارات `surfaceRoutes.android`.
- الجزء ٣: الإشعارات (وحدة `devices` ما زالت 501)، المشاركة إلى كور هب، الإدخال الصوتي، «هذا الجهاز».
