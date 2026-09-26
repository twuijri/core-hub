# الجوال: كل ملف في المحادثة يُفتح — صورة داخل الرسالة وبملء الشاشة، والباقي في عارض الجوال
المسؤول: twuijri · الفرع: fix/mobile-open-files · الحالة: review

## المشكلة والهدف
بلاغ المالك (٢٠٢٦-٠٩-٢٦، لقطة من الآيفون): رد الوكيل يسرد صورة أنتجها
(`retouch-this-exact-phot…0260926-175416-1.png`) ورابطًا «عرض الصورة المعدّلة». على الآيفون يظهر
الملف سطرًا بأيقونة صورة، الضغط عليه لا يفتح شيئًا ولا معاينة؛ وعلى أندرويد لا معاينة أيضًا. وصورته
هو (`photo-20260926-175004.jpg`) تظهر اسمًا فقط. المطلوب: كل ملف يُفتح على الجوالين — الصور معاينة
داخل الرسالة وبملء الشاشة (تكبير، مشاركة/حفظ)، وPDF والنصوص والصوت والفيديو والمستندات في عارض
النظام أو مشغّله، وما سواها يُشارَك أو يُحفظ على الأقل، والروابط في نص الرد التي تشير إلى ملف في
المركز تفتح العارض نفسه.

**السبب (بعد الفحص):**
- **المركز سليم**: شغّلت مركزًا محليًا (`tsx src/main.ts` بقاعدة مؤقتة)، رفعت صورة وأرسلتها في
  محادثة مع وكيل `direct`، ثم قرأت الرسائل ونزّلت المرفق بالعميل المولَّد لكوتلن من JVM بنفس
  الترويسات التي يرسلها الجوال (`Accept: application/json`، `X-Hub-Profile`، الحامل): `200` والبايتات
  كاملة، والكتلة `image` تحمل `attachment_id` و`name` و`mime`. أي أن العلّة في التطبيقين لا في المركز
  ولا في العقد.
- **الإصدارات**: رسم الصور داخل الرسالة لم يدخل إلا في 1.1.2 (`54329a8d` أندرويد، `d48ad198` iOS،
  فجر ٢٠٢٦-٠٩-٢٦). في 1.1.1 وما قبلها كان `MessageAttachments` في iOS يرسم **اسمًا وأيقونة فقط بلا زر
  ولا تنزيل**، وأندرويد كذلك — وهذا يطابق اللقطة حرفيًا. وأندرويد لم يحصل على التحديث الذاتي إلا بعد
  1.1.2، فالأرجح أن الجوالين كانا على 1.1.1 أو أقدم. لا أستطيع التأكد من رقم إصدار جوال المالك.
- **وفي 1.1.2 نفسه (وما في `main`)** الخلل نفسه يعود عند أي تعثّر: الصورة تُرسم فقط إن نجح تنزيلها،
  وإلا يسقط العرض إلى **اسم بلا ضغط ولا رسالة خطأ ولا إعادة محاولة** (iOS: `InlineImage` يعرض
  `chip` خارج أي `Button`؛ أندرويد: `FileChip(onClick = null)`) — صف ميت إلى أن تُغلق المحادثة.
- **الروابط في نص الرد لم تُعالَج أصلًا** على الجوالين: أندرويد يسلّم الرابط النسبي (`retouch….png`)
  للنظام عبر `LinkAnnotation.Url` فلا يجد تطبيقًا يفتحه، وiOS يمرّره إلى `openURL` فلا يحدث شيء.
- أخطاء أصغر: iOS كان يصغّر الصورة إلى 780×780 بالضبط (`preparingThumbnail(of:)` بمقاس مربع)
  فيشوّه نسبتها؛ وأندرويد يعدّ أي ملف طوله > 0 في الذاكرة المؤقتة ملفًا كاملًا، فتنزيل انقطع في
  منتصفه كان يُفتح مبتورًا.
- خارج النطاق: رفع المرفقات من أندرويد معطّل بسبب ترويسة `Content-Type` في الجزء (طلب الدمج #176
  يعالجه)، فصورة المالك رُفعت على الأرجح من جهاز آخر.

## القرار والموافقات
- **لا تغيير في العقد ولا في المركز**: البايتات عبر `sessions.downloadAttachment` و`sessions.readFile`
  (`download=true`) بالعميل المولَّد فقط والحامل في الترويسة؛ الصوت والفيديو من تذكرة العقد ذات
  الساعة الواحدة (`createAttachmentStream` / `createFileStream`، DECISIONS §90، §98)، تُحلّ نسبةً إلى
  عنوان المركز وتُعطى لمشغّل النظام فيبدأ فورًا ويقفز بـ`Range`. قائمة ملفات المحادثة
  (`sessions.listFiles`) تُقرأ فقط حين يحتاجها رابط.
- **كيف يُفتح كل نوع** (مقترح — للمالك أن يؤكد):
  - صورة (jpeg/png/gif/webp/heic/bmp) — سواء أُرسلت صورة أو «ملفًا بالجودة الأصلية» — تُرسم داخل
    الرسالة وتُجلب تلقائيًا حتى **20 MB**، وما فوقها ينتظر ضغطة. بملء الشاشة: أندرويد عارض داخل
    التطبيق (قرص/نقر مزدوج للتكبير، حفظ في الصور على أندرويد 10+، فتح في تطبيق آخر، مشاركة)؛ iOS
    Quick Look (تكبير، ومشاركة فيها «حفظ الصورة»).
  - PDF والنصوص والمستندات المكتبية وSVG: عارض النظام (أندرويد `ACTION_VIEW` عبر FileProvider
    الموجود، iOS Quick Look)، والشاركة إن لم يوجد عارض.
  - صوت وفيديو: مشغّل النظام من التذكرة (أندرويد `ACTION_VIEW` بالعنوان، iOS `VideoPlayer` بملء
    الشاشة)، وإن تعذّرت التذكرة يُنزَّل الملف ويُفتح.
  - غير ذلك: ورقة المشاركة (منها الحفظ في الملفات/Drive).
- **كل ملف غير مرسوم صفّ** بأيقونة نوعه واسمه وحجمه؛ أثناء التنزيل نسبة مئوية وشريط وزر إلغاء؛ عند
  الفشل سطر واحد بالسبب (لم يُوصَل للمركز / لم يعد في المركز / أكبر من أن يُفتح / كلام المركز) وزر
  إعادة. التنزيل الواحد مشترك بين الصورة داخل الرسالة والضغط عليها، ويبقى إن غادر الشخص المحادثة.
- **روابط الرد** (كقرار الويب §48): رابط هو عنوان مرفق من مرفقات الرد (نسبي أو على أصل المركز نفسه)،
  أو كلمة تطابق ملفًا من ملفات الرد باسمه (بما فيها `./out/…` و`sandbox:/…` و`file:///…` والأسماء
  المرمّزة)، أو مسار ملف في مجلد المحادثة — يفتح الملف كصفّه. أي رابط آخر يفتح في المتصفح كما كان،
  والرابط الذي لا يفتحه شيء يقول ذلك بدل الصمت.
- لا قرار جديد في DECISIONS: السلوك تطبيق لقرارات §48 و§90 و§98 على الجوال.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- أندرويد:
  - `apps/android/app/src/main/java/hub/core/android/chat/HubFiles.kt` (جديد): `HubFile`،
    `FileKinds` (النوع ← طريقة الفتح)، `FileLinks` (أي ملف يسمّيه الرابط؛ مسار المحتوى من العميل
    المولَّد لا نص مكتوب)، `HubFileFetcher` (تنزيل بالعميل المولَّد عبر عميل OkHttp المصادَق مع
    عدّاد تقدّم وإلغاء، كتابة `.part` ثم نقل، وعنوان التذكرة)، `FileDownloads` (حالة كل تنزيل للتطبيق).
  - `ui/components/MessageFiles.kt` (أُعيد): صورة/صف/عارض بملء الشاشة/`FileLinkHandler` و`AttachmentFiles`
    (فتح، مشاركة، حفظ عبر MediaStore، تشغيل).
  - `ChatReducer.kt` (`ChatAttachment.sizeBytes` وقاعدة الصورة)، `ChatViewModel.kt`، `AppGraph.kt`
    (`files`)، `ChatParts.kt` (ربط الروابط في رد الوكيل فقط)، `ChatScreen.kt` (`LocalChatSession`).
  - النصوص `values/strings.xml` و`values-ar/strings.xml` (`files_*`).
  - الاختبارات: `test/.../chat/HubFilesTest.kt` (جديد)، `testDebug/.../shots/FilesShots.kt` (جديد)،
    `DemoHub.kt` (مدخل `raw` و`answer` للاختبارات).
- iOS:
  - `apps/ios/CoreHub/Chat/HubFiles.swift` (جديد): نفس القواعد، `HubFileFetcher` (بالعميل المولَّد مع
    `onProgressReady`)، `FileDownloads`.
  - `Chat/Attachments.swift`: `MessageAttachments` و`PictureAttachment` و`FileRowView` و`FileOpener`
    (Quick Look، المشغّل، ورقة المشاركة) و`FileLinkOpener`؛ `AttachmentFiles.place` باقٍ.
  - `Chat/ChatScreen.swift`: `MessageRow.sessionID` وربط الروابط في رد الوكيل.
  - `i18n/en.json` و`i18n/ar.json` (`attachments.*`).
  - `CoreHubTests/HubFilesTests.swift` (جديد).
- أيقونات Lucide جديدة للجهازين (`file`، `music`، `film`، و`download`/`share-2`/`rotate-ccw` لـiOS):
  `scripts/icons/lucide-mobile.json` وما يولّده.
- `docs/STATUS.md`.
- لم أمسّ عرض استدعاءات الأدوات (`ToolCallCard`) — وكيل آخر يعمل عليه.

## الفحوص (الأوامر ونواتجها الفعلية)
فحص المركز الحقيقي (قبل الإصلاح، لتحديد السبب) — تنزيل مرفق بترويسات الجوال:
```
--- download Accept: application/json
HTTP/1.1 200 OK
content-type: image/png
content-disposition: attachment; filename="photo-20260926-175004.png"; filename*=UTF-8''photo-20260926-175004.png
PROBE uploaded 01M3FB975X4E8MACBGVSCCX32K IMAGE image/png
PROBE msg user blocks=[… ContentBlock(type=IMAGE, attachmentId=01M3FB975X4E8MACBGVSCCX32K, name=photo-20260926-175004.png, mime=image/png, sizeBytes=75, url=…)] -> isImage=[true]
PROBE download=Success(/tmp/photo-20260926-17500418334658912337689775.png) size=75 err=null
```
اختبارات أندرويد (JVM، MockWebServer) وصور Robolectric:
```
$ ./gradlew :app:testDebugUnitTest --tests 'hub.core.android.chat.HubFilesTest' --tests 'hub.core.android.phone.DictationLanguageTest'
BUILD SUCCESSFUL in 3s
TEST-hub.core.android.phone.DictationLanguageTest.xml:tests="11" skipped="0" failures="0" errors="0"
TEST-hub.core.android.chat.HubFilesTest.xml:tests="11" skipped="0" failures="0" errors="0"
$ ./gradlew :app:testDebugUnitTest --tests 'hub.core.android.shots.FilesShots'
BUILD SUCCESSFUL in 7s
tests="2" skipped="0" failures="0" errors="0"
```
رأيت الصور `android-15-files.png` (فاتح/إنجليزي، داكن/عربي): الرابط «عرض الصورة المعدّلة»، والصورة
مرسومة من بايتات أرسلها المركز التجريبي بعد أن رأى `Bearer demo`، وصف PDF بحجمه (243 KB)؛ و
`android-16-picture.png`: الصورة بملء الشاشة مع إغلاق وحفظ وفتح في تطبيق آخر ومشاركة.

فحوص المستودع:
```
$ pnpm contracts:check-clients
check-clients  OK — 787 client file(s) scanned, 254 contract path(s) known.
$ pnpm i18n:check
i18n:check  ios: 687 keys, ar/en in parity
i18n:check  OK
$ node scripts/icons/lucide-mobile.mjs --check
lucide: 92 shared + 24 Android icon(s) from lucide-static 1.48.0 up to date
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
exit=0
```
iOS لا يُبنى على لينكس؛ `HubFilesTests` تعمل في وظيفة iOS على CI (النتيجة في طلب الدمج).

## المخاطر والرجوع
- لم يُجرَّب على جوال حقيقي ولا على مركز المالك؛ iOS مبني من قراءة الكود ويثبته CI فقط.
- عنوان التذكرة يُعطى لمشغّل النظام (تطبيق آخر على أندرويد): تذكرة ملف واحد، قراءة فقط، ساعة، وهذا
  ما صُمّمت له في §90؛ لا يخرج الحامل أبدًا.
- ملف مؤقت يكتبه العميل المولَّد لأندرويد قد يبقى في `cache` إن أُلغي تنزيل في منتصفه (ينظّفه النظام).
- الرجوع: عكس الالتزامات؛ لا بيانات ولا ترحيل.

## التسليم والخطوة التالية
- طلب دمج واحد إلى `main` للمراجعة. على المالك: تأكيد القرارات المقترحة أعلاه (حد الجلب التلقائي
  20 MB، رسم الصورة المرسلة «ملفًا»، التشغيل من التذكرة)، ثم التجربة على الجوالين بعد بناء تجريبي
  يطلبه — والتأكد أولًا من رقم الإصدار المثبّت (الإعدادات ← هذا الجهاز).
