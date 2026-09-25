# بطاقات الأجهزة في «اتصالات الأجهزة»، وإعداد مرسِلات الإشعارات من ملفاتها
المسؤول: twuijri · الفرع: feat/device-cards · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٥، لقطة الإعدادات ← اتصالات الأجهزة ← تبويب «التطبيق»):
«شكل الايفون مهب حلو، لو نخليه مربع اكبر فيه نوع الجهاز ومتى اخر مره نشاط له وتفاصيل علشان تفرق
بينهم، كذا ايفون عام وصغيره ولاصقة بالزر». ثم لاحظ ثلاثة أشياء أخرى في الصفحة نفسها:
- «لما رجعت للصفحة اختفى الايفون؟»: الشارة «تم الإقران: iPhone» كانت نتيجة جلسة الإقران فقط، وتبويب
  «التطبيق» لم يعرض الأجهزة المقترنة قط (كانت في تبويب «الأجهزة»).
- كتلة «مرسِلات الإشعارات» تحت الأجهزة بما فيها «ينقص: key_id…» وقائمة متغيرات البيئة «تشتّت».
- ملء نموذج APNs يدويًا «غلط»: Apple وFirebase يعطيان ملفات.

والآيفون منذ iOS 16 يسمّي نفسه «iPhone» فقط، فلا يفرّق الاسم بين جهازين.

الهدف: بطاقة لكل جهاز تقول ما هو (أيقونة النوع، الاسم، الطراز، إصدار النظام والتطبيق)، ومتى كان
آخر نشاطه ومتى أُقرن، وحال إشعاراته، مع إعادة التسمية والتجربة والإزالة؛ الأجهزة تُقرأ من المركز
دائمًا فلا تختفي؛ إعداد المرسِلات مطويّ للمشرف ويبدأ من الملف.

## القرار والموافقات
طلب المالك المهمة. كل ما يلي **مقترح — ينتظر تأكيد المالك** (DECISIONS §81):

1. **صفحة واحدة بدل تبويبين** (طلب المنسّق بعد ملاحظة المالك): الإقران في الأعلى، ثم «أجهزتك»
   (للمشرف «الأجهزة») بطاقات مجمّعة حسب النوع: الجوالات والأجهزة اللوحية، الحواسيب، المتصفحات.
   كان التبويبان يكرران الشيء نفسه (الإقران يصنع جهازًا يظهر في الآخر فقط). الجهاز المقترن للتو يظهر
   في القائمة فورًا (يُعاد جلبها عند `pairing.claimed` أو عند الفحص الدوري) بشارة «أُقرن الآن»، ولا
   شارة منفصلة بعد الآن. `navigation.json` لم يعد يذكر `tabs` لهذه الصفحة.
2. **البطاقة**: أيقونة حسب النوع والمنصة (آيفون، أندرويد، جهاز لوحي، حاسوب، متصفح)؛ الاسم؛ الطراز
   (لا يُكرر الصانع إن كان في الطراز)؛ «iOS 18.6 · كور هب 0.1.0» (الأرقام معزولة LTR)؛ «آخر نشاط قبل ٥
   دقائق» والوقت الدقيق في تلميح عند المرور أو التركيز، ويتجدد كل دقيقة؛ «أُقرن في …» («أُضيف في» للمتصفح)؛
   حال الإشعارات: تعمل · المزوّد، أو غير متاحة في هذه النسخة، أو بانتظار السماح، أو مطفأة في الجهاز، أو
   «متوقفة: لا مرسِل FCM في هذا المركز بعد» (وللمشرف زر «إعداد الإشعارات» يفتح المرسِلات)، أو متوقفة؛
   «هذا الجهاز»/«هذا المتصفح»؛ «متصل»؛ إعادة التسمية، إرسال تجربة (إن كان الدفع مسجلًا)، إزالة بتأكيد
   («إلغاء الربط» صار «إزالة»). الأرقام العربية كما يعطيها `Intl` للغة `ar` في بقية الصفحات.
3. **العقد**: `Device` يكسب `os_version` و`paired_at` و`push_blocker`؛ `DeviceRegistration` يكسب
   `os_version` و`push_blocker`؛ `DevicePatch` يكسب `brand` و`model` و`os_version` و`push_blocker`.
   كلها اختيارية أو قابلة لـ null: التطبيق الأقدم يرسل أقل فتظهر تفاصيل أقل. `paired_at` قابل لـ null
   حتى يقرأ التطبيق الجديد مركزًا أقدم لا يرسله (المولّد يجعل الحقل الإلزامي غير القابل لـ null شرطًا).
4. **الاسم للشخص**: تسمية الجهاز من المركز (`devices.update` بـ`name`) تُسجَّل (`renamed_at`)، فإعادة
   الإقران أو التسجيل بالاسم العام لا تمحوها؛ إلغاء الربط ينساها. التطبيقان لا يرسلان الاسم عند كل
   تشغيل، بل الطراز والإصدارات وسبب توقف الدفع فقط.
5. **آخر نشاط**: كان يُكتب لنداءات الجهاز المقترن فقط (مرة في الدقيقة). صار يُكتب أيضًا لنداءات تسجيل
   الدخول الذي سجّل الجهاز بـ`devices.register` (هاتف دخل بكلمة المرور، متصفح) — `seen_session_id`،
   مرة في الدقيقة لكل تسجيل دخول. الذاكرة التي تمنع الكتابة المتكررة تنسى القديم بعد ألفي مدخل.
6. **التطبيقان**: iOS يحوّل معرّف `utsname.machine` إلى اسم الطراز (`iPhone17,1` ← «iPhone 16 Pro»؛
   المعرّف الأحدث من الجدول يُرسل كما هو)، ويرسل `systemVersion` ونسخة الحزمة، وسبب توقف الدفع من إذن
   الإشعارات. أندرويد يرسل الاسم الذي أعطاه الشخص للهاتف في الإعدادات (`Settings.Global.DEVICE_NAME`)
   وإلا الصانع والطراز، و`Build.VERSION.RELEASE` و`versionName`، وسبب التوقف (نسخة بلا Firebase، أو
   الإذن لم يُطلب بعد، أو رُفض). يُرسل عند الإقران أو التسجيل وعند كل تشغيل (`devices.update`)، وفي
   أندرويد أيضًا بعد الإجابة على طلب الإذن. **جديد**: الدخول بكلمة المرور يسجّل الجوال جهازًا عند كل
   تشغيل حتى دون Firebase (كان التسجيل مع الدفع فقط).
7. **المرسِلات** (طلب المالك الثالث): مطوية في آخر الصفحة للمشرف فقط؛ مطويةً سطر واحد بحال كل مرسِل،
   ومفتوحةً صف لكل مرسِل بحاله وزر «إعداد»/«تغيير». أُزيل «ينقص: …» ونص متغيرات البيئة من الصفحة؛ صار
   الثاني داخل النافذة تحت «أو اضبطه بمتغيرات البيئة» مع رابط `docs/DEPLOY.md`. المحفوظ يُذكر دون سر:
   «محفوظ — المشروع core-hub-66772» و«محفوظ — مفتاح ينتهي بـ …DEFG · الفريق …».
   - **APNs**: زر «رفع ملف AuthKey_….p8» وسحب وإفلات؛ Key ID من اسم الملف؛ معرّف الحزمة يقترحه المركز
     (`APP_IDS.apple` في `packages/contracts/src/product.ts` = `com.twuijri.corehub`، فلم يعد «ينقص»)؛
     Team ID حقل؛ الإنتاج افتراضي. الحقل النصي خلف «اللصق بدلًا من ذلك».
   - **FCM**: رفع ملف حساب الخدمة، والتحقق من `type`/`project_id`/`client_email`/`private_key`، واسم
     المشروع بعد الرفع؛ `google-services.json` يُعرف ويُرفض بجملة واضحة (في الويب وفي المركز).
   - **بعد الحفظ**: المركز يتحقق أن مفتاح APNs مفتاح EC P-256 يوقّع رمز ES256 قبل حفظه (مفتاح RSA كان
     يُقبل)، والويب يقول «المفتاح يبدو سليمًا». لم يُسأل Apple عند الحفظ: Apple لا تجيب إلا على دفع حقيقي
     إلى رمز جهاز حقيقي، وهذا ما يفعله «إرسال تجربة».

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `openapi.yaml`: `Device` (+`os_version`، `paired_at`، `push_blocker`)، `DeviceRegistration`
  (+`os_version`، `push_blocker`)، `DevicePatch` (+`brand`، `model`، `os_version`، `push_blocker`)، مخطط
  جديد `PushBlocker`، وأمثلة العمليات. لا عملية جديدة.
- `events/devices/*.schema.json`: نسخة `Device` في `$defs` بالحقول نفسها.
- `src/product.ts`: `APP_IDS` (معرّفا التطبيقين في المتجرين؛ لا يتبعان إعادة التسمية).
- DECISIONS §81.

## الملفات والتأثير
- الخادم: `modules/devices/schema.ts` (أعمدة `push_blocker`، `seen_session_id`، `renamed_at`)،
  `drizzle/0026_device_report.sql` (+ لقطة وسجل)، `modules/devices/index.ts` (التسلسل، الاسم المحفوظ،
  آخر نشاط لتسجيل الدخول)، `modules/devices/push.ts` و`senders.ts` (`checkApnsKey`، معرّف الحزمة
  الافتراضي، رفض `google-services.json`)، `modules/auth/routes.ts` (حقول الإقران).
- الويب: `screens/DeviceConnectionsScreen.tsx` (صفحة واحدة)، `devices/DeviceCard.tsx` (جديد)،
  `devices/format.ts` (جديد)، `devices/DevicesPanel.tsx`، `devices/PushSendersCard.tsx`،
  `devices/senderFiles.ts` (جديد)، `ui/icons.tsx` (`IconPhone`، `IconTablet`)، `ui/Notice.tsx`
  (`testId` اختياري)، `i18n/{ar,en}.json`.
- أندرويد: `phone/DeviceInfo.kt` (جديد)، `phone/PushService.kt`، `phone/Push.kt` (`report`)،
  `AppGraph.kt`، `MainActivity.kt`، `ui/screens/ConnectViewModel.kt`.
- iOS: `CoreHub/Phone/DeviceInfo.swift` (جديد)، `CoreHub/Phone/Push.swift`، `CoreHub/App/AppModel.swift`.
- الاختبارات: `packages/server/tests/unit/devices-push.test.ts`، `packages/web/tests/device-cards.test.tsx`
  (جديد)، `packages/web/tests/push-sender-files.test.tsx` (جديد)، `packages/web/tests/devices-push.test.tsx`،
  `packages/web/e2e/zzzzzz-browser-push.spec.ts` (ولقطته)، `DeviceInfoTest.kt` (جديد)، `PushTest.kt`،
  `DeviceInfoTests.swift` (جديد)، `PushTests.swift`.
- وثائق: `docs/STATUS.md`، `docs/contracts/DECISIONS.md` (§81)، `docs/clients/navigation.json`
  و`NAVIGATION.md` (لا تبويبات)، `docs/DEPLOY.md` (مكان المرسِلات).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run`، بعد دمج `origin/main` (`fa17cd1a`):
```
$ pnpm lint                      → All matched files use Prettier code style!   (eslint بلا أخطاء)
$ pnpm typecheck                 → exit 0
$ pnpm contracts:lint            → contracts:lint  OK   (Your API description is valid; 96 event schemas)
$ pnpm contracts:check-clients   → check-clients  OK — 593 client file(s) scanned, 222 contract path(s) known.
$ pnpm --filter @corehub/contracts test   → Test Files 8 passed · Tests 45 passed
$ pnpm contract:test             → Test Files 19 passed · Tests 364 passed
$ pnpm i18n:check                → i18n:check  OK
$ pnpm nav:check                 → nav:check  OK — 37 destinations, 2 pre-auth screens, 42 terms, ar/en complete
$ vitest --project unit tests/unit/devices-push.test.ts src/modules/devices/push.test.ts
    src/modules/auth/pairing.test.ts src/modules/auth/setup-window.test.ts tests/unit/realtime-auth.test.ts
                                 → Test Files 5 passed · Tests 64 passed
$ vitest (web) device-cards, devices-push, push-sender-files, i18n, logical-css, ui-layer, navigation.parity
                                 → Test Files 7 passed · Tests 316 passed
$ pnpm build                     → exit 0
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzz-browser-push.spec.ts (منافذ 8871-8873)
  ✓ a browser turns notifications on, and a test notice is pushed to it   1 passed
$ pnpm --filter @corehub/contracts generate:native   → contracts:generate:native  OK   (JDK 17)
$ ./gradlew --max-workers=2 testDebugUnitTest --tests 'hub.core.android.phone.*'
  hub.core.android.phone.DeviceInfoTest tests="5" failures="0" errors="0"
  hub.core.android.phone.PhoneTest      tests="6" failures="0" errors="0"
  hub.core.android.phone.PushTest       tests="10" failures="0" errors="0"
$ node apps/ios/scripts/generate-swift.mjs --check  → generate-swift  OK
```
لا Xcode محليًا: اختبارات iOS تثبتها وظيفة «Build and test on the iOS simulator» في CI.
CI على #149 عند `8bc8d63e`: كل الفحوص الأربعة عشر ناجحة:
```
Android build, unit tests, lint | pass | 4m37s      BUILD SUCCESSFUL in 3m 38s
Build and test on the iOS simulator | pass | 5m59s  Executed 76 tests, with 0 failures
  Test Case '-[CoreHubTests.DeviceInfoTests testTheModelIsItsMarketingNameAndAnUnknownOneIsSentAsItIs]' passed
  Test Case '-[CoreHubTests.DeviceInfoTests testAGenericNameStaysAndTheModelTellsPhonesApart]' passed
  Test Case '-[CoreHubTests.DeviceInfoTests testMissingPartsAreLeftOutAndLongOnesFit]' passed
  Test Case '-[CoreHubTests.DeviceInfoTests testWhatStopsPushIsThePermission]' passed
  Test Case '-[CoreHubTests.DeviceReportTests testAPairedPhoneReportsWhatItIsButNeverItsName]' passed
  Test Case '-[CoreHubTests.DeviceReportTests testAPasswordSignInRegistersOnceAndARemovedRowAgain]' passed
Generate the Swift client (CoreHubClient) | pass
Lint, typecheck, contracts, client tests, build | pass
Server unit tests (shard 1/3, 2/3, 3/3) | pass
Web smoke journeys (Playwright against the real hub) | pass
db:generate + db:migrate (SQLite and PostgreSQL) | pass
Docker image builds and answers /health | pass
Desktop app smoke (Electron under Xvfb against the real hub) | pass
PR adds or updates a change record | pass · PR leaves graphify-out/ to the code-map bot | pass
```

ما تثبته الاختبارات الجديدة (وتسقط على الكود القديم: الحقول والمكوّنات غير موجودة): الخادم يحفظ ما يقوله
الجهاز ويُبقي الاسم الذي أعطاه الشخص عند إعادة الإقران والتسجيل، والتطبيق الأقدم لا يمحو شيئًا؛ آخر نشاط
يُكتب لتسجيل الدخول الذي سجّل الجهاز، مرة في الدقيقة، ولا يُكتب لتسجيل دخول آخر؛ الجهاز المقترن مرة في
الدقيقة بساعة متحكَّم بها؛ الملف الخطأ يُرفض باسمه ومفتاح RSA لا يُقبل لـAPNs. الويب: كل حقول البطاقة،
التطبيق الذي يرسل أقل، أسباب توقف الدفع، إعادة التسمية والتجربة والإزالة بتأكيد، الإقران ثم مغادرة
الصفحة والعودة والجهاز باقٍ، التجميع حسب النوع، المرسِلات مطوية بلا حقول ولا متغيرات، رفع `.p8` يملأ
Key ID ومعرّف الحزمة من المركز، `google-services.json` يُرفض، وما يُحفظ يُذكر دون سر. أندرويد وiOS:
تحويل معلومات الجهاز، سبب توقف الدفع، وتقرير التشغيل (الجهاز المقترن يرسل `PATCH` دون اسم؛ الدخول
بكلمة المرور يسجّل مرة، والصف المحذوف يُسجَّل من جديد مرة).

بعد دمج `origin/main` الثاني (`6ce936f6`، #147 و#148 أخذا §78–§80 والترحيل `0025_channel_identities`):
القرار صار **§81** والترحيل **`0026_device_report`** (أُعيد توليده بـ`db:generate` فوق لقطة `main`).
تعارضان في الكود حُلّا بإبقاء ما في `main` وإضافة التقرير إليه: طلب إذن الإشعارات في أندرويد انتقل إلى
`phone/NotificationStatus.kt` (يرسل `reportDevice()` بعد الإجابة، و«سبق الرفض» صار
`notificationsDenied`)، و`PushCenter.start` في iOS صار يطلب الإذن بنفسه (التقرير يُرسل بعد معرفة الإذن).
```
$ pnpm lint                      → All matched files use Prettier code style!
$ pnpm typecheck                 → exit 0
$ DATA_DIR=<جديد> pnpm db:migrate → db: migrations applied (sqlite)
    migrations: 27 · devices: push_blocker,seen_session_id,renamed_at · channel_identities: true
$ pnpm contracts:lint            → contracts:lint  OK
$ pnpm contracts:check-clients   → check-clients  OK — 609 client file(s) scanned, 228 contract path(s) known.
$ pnpm i18n:check                → i18n:check  OK
$ pnpm nav:check                 → nav:check  OK — 38 destinations, 2 pre-auth screens, 43 terms, ar/en complete
$ vitest (server) devices-push, devices/push, auth/pairing   → Test Files 3 passed · Tests 45 passed
$ vitest (web) device-cards, devices-push, push-sender-files → Test Files 3 passed · Tests 23 passed
$ ./gradlew testDebugUnitTest --tests 'hub.core.android.phone.*'
  DeviceInfoTest 5 · PushTest 10 · PhoneTest 6 · NotificationStatusTest 3 · AttachmentsTest 4 · VoiceSourceTest 4 · LucideDrawablesTest 1 — failures="0" errors="0"
$ node apps/ios/scripts/generate-swift.mjs --check → generate-swift  OK
```

## المخاطر والرجوع
- **الرجوع**: revert للطلب. الترحيل `0026` يضيف ثلاثة أعمدة قابلة لـ null فقط؛ الكود القديم يتجاهلها.
- جدول أسماء طرازات iOS مكتوب يدويًا حتى تشكيلة 2025؛ المعرّف غير المعروف يُرسل كما هو (يفرّق بين
  الأجهزة لكنه ليس اسمًا تسويقيًا). تحديث الجدول مع كل تشكيلة جديدة.
- لم يُشغَّل شيء على هاتف حقيقي ولا على مركز المالك.
- الدخول بكلمة المرور صار يضيف الجوال إلى قائمة الأجهزة عند التشغيل حتى دون دفع.
- التطبيق الجديد مع مركز أقدم: `devices.update` بالحقول الجديدة قد يُرفض (400) إن تحقق المركز الأقدم من
  الحقول الزائدة — التقرير «أفضل جهد» ولا يوقف شيئًا.
- لم يُسأل Apple ولا Google عند الحفظ؛ «إرسال تجربة» هو الإثبات الحقيقي.

## التسليم والخطوة التالية
- طلب واحد إلى `main` بالإنجليزية؛ المالك يراجع ويدمج.
- **اقتراح للمالك**: نقل المرسِلات لاحقًا إلى صفحة إدارة خاصة بها إن كثرت (هي الآن مطوية في آخر
  الصفحة، وتحتاج صفحة مستقلة وجهةً جديدة في `navigation.json` لكل العملاء).
- تحديث جدول طرازات iOS عند صدور أجهزة جديدة.
