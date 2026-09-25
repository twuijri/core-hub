# تلميع الجوال ٢: جودة الصور المرفقة، والصوت الافتراضي (iOS وأندرويد)
المسؤول: twuijri · الفرع: fix/mobile-polish-2 · الحالة: review

## المشكلة والهدف
ردّ المالك على اقتراحات PR #147 (سجل `2026-09-26-twuijri-mobile-polish.md`):

- **جودة المرفقات** — «خله خيارين مثل التيليقرام مع ضغط ولا بدون، ممكن برسل دقة عالية علشان
  يعالجها». كل الصور كانت تُصغَّر إلى ٢٠٤٨ بكسل وJPEG ٠٫٨، وحد الجوال ٢٥ م.ب ثابت.
- **الصوت الافتراضي** — «اذا قصدك المايك والتسجيل خل الأساسي حق الجوال ويقدر يغير المستخدم».
  الافتراضي كان «كور هب».
- وافق المالك كما هو على: مهلة ٠٫٧ ث قبل طلب إذن الإشعارات، وحذف المرفوع فورًا عند × على الشريحة.

الهدف: الأمران على المنصتين معًا.

## القرار والموافقات
**١) الجودة كما في تيليجرام**
- الواجهة: قائمة «+» صار في أعلاها اختيار «الصور»: «مضغوطة» / «بالجودة الأصلية» (Compressed /
  Original quality)، والاختيار محفوظ في الجوال (`DeviceSettings.photoQuality` في iOS،
  `DeviceChoices.photoOriginal` في أندرويد) ويسري على مكتبة الصور والكاميرا. اخترتُه على الضغط المطوّل
  على زر الإرسال لأنه ظاهر ويُكتشف بلا شرح، ويبقى القرار قبل الاختيار لا بعده (اقتراح — للمالك أن يؤكد).
- «مضغوطة»: كما كانت — الضلع الأطول ≤ ٢٠٤٨، JPEG ٠٫٨، وتُرسل كتلة `image`.
- «بالجودة الأصلية»: الملف نفسه بلا لمس — HEIC/JPEG/PNG بدقته كاملة، واتجاهه (EXIF) وكل بياناته كما
  هي — ويُرسل كتلة `file` (مثل «أرسل كملف» في تيليجرام) مهما كان نوعه. في iOS يطلب منتقي الصور الملف
  الأصلي (`preferredItemEncoding: .current`، فلا يُحوَّل HEIC). **استثناء الكاميرا**: كاميرا iOS تعطي
  صورة لا ملفًا، فتُكتب بدقتها كاملة JPEG بأعلى جودة ومعتدلة بـEXIF؛ كاميرا أندرويد تكتب ملفها فيُرفع
  كما هو.
- **موقع GPS**: لا الويب ولا المركز يحذفانه (بحثتُ في `packages/web/src` و`packages/server/src` عن
  EXIF/GPS فلم أجد شيئًا)، فتُركت الملفات الأصلية كما هي. ملاحظة: منتقي الصور في أندرويد قد يحذف
  الموقع بنفسه ما لم يملك التطبيق `ACCESS_MEDIA_LOCATION` (ولا يملكه).
- **الحد هو حد المركز**: العقد لا يقدّم عملية تُخبر بالحد، فالحد الذي يحفظه الجوال هو حد العقد
  نفسه: `UploadStart.size_bytes.maximum` = ٥٠ م.ب (الحد الذي يطبّقه الخادم `MAX_RESUMABLE_BYTES`،
  ويستعمله الويب `MAX_ATTACHMENT_BYTES`)، واختبار في كل تطبيق يقرأ `openapi.yaml` ويفشل إن اختلف.
  حتى ٢٥ م.ب رفع في طلب واحد (`sessions.uploadAttachment`)، وفوقها الرفع المستأنف كما يفعل الويب
  (`sessions.startUpload` ثم `uploadChunk` بقطع `chunk_bytes` ثم `completeUpload`، و`abortUpload` إن
  فشل). ما فوق ٥٠ م.ب يُرفض قبل الرفع، و`413` من المركز يظهر برقم المركز نفسه (`details.max_bytes`،
  يُقرأ الآن في `HubFailure.maxBytes` / `HubError.maxBytes`).

**٢) الصوت الافتراضي «الجوال»**
- الافتراضي للإملاء والميكروفون صار «الجوال»، وقراءة الردود تتبع الإعداد نفسه؛ «كور هب» في الإعدادات.
- **التثبيتات الموجودة**: iOS كان يكتب الإعداد فقط حين يغيّره الشخص، فمن لم يغيّره يأخذ الافتراضي الجديد
  تلقائيًا. أندرويد كان يكتب كل الإعدادات مع أي تغيير، فلا يُعرف من اختار «كور هب» حقًا؛ صار الإعداد
  يُحفظ بمفتاح جديد (`voice_source_chosen`) لا يُكتب إلا حين يُختار، والمفتاح القديم لا يُقرأ. الثمن:
  من اختار «كور هب» صراحة في أندرويد 1.1.x يعود إلى «الجوال» مرة واحدة (اقتراح — للمالك أن يؤكد؛
  نسخة أندرويد تلك لم تُنشر لأحد غير المالك).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. عمليات موجودة فقط: `sessions.uploadAttachment`، `sessions.startUpload`، `sessions.uploadChunk`،
`sessions.completeUpload`، `sessions.abortUpload`.

## الملفات والتأثير
- iOS: `Chat/Attachments.swift` (الاختيار في «+»، `addOriginalPhoto`/`addOriginalCameraPhoto`،
  `OutgoingMessage.asFiles`، `AttachmentUploader` و`HubAttachmentBackend`)، `Phone/Voice.swift`
  (`PhotoQuality`، الافتراضي `.phone`)، `Hub/HubFailure.swift` (`maxBytes`)، `Chat/ChatScreen.swift`
  و`NewChatScreen.swift`، `i18n/{ar,en}.json`، `project.yml` (`openapi.yaml` مورد للاختبارات)،
  `CoreHubTests/AttachmentsVoiceTests.swift`.
- أندرويد: `chat/Attachments.kt` (`asFiles`، `AttachmentUploader`، `HubAttachmentBackend`، `mimeOf`،
  الحدّان)، `ui/components/AttachButton.kt` (الاختيار في «+»، `PickedFiles.original`)،
  `ui/screens/ChatViewModel.kt`، `phone/DeviceSettings.kt`، `data/Hub.kt` (`maxBytes`)،
  `res/values{,-ar}/strings.xml`، `src/test/.../phone/MobilePolishTest.kt`.
- `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (عبر `mj-run`؛ أندرويد بـJDK 17؛ لا Xcode محليًا فـiOS على CI):

```
$ ./gradlew --no-daemon --max-workers=2 assembleDebug test lint     (apps/android)
# أول تشغيل: الاختبار القديم ما زال يتوقع «25 MB» حدًا للجوال:
AttachmentsTest > photosShrinkToTheLongerSideLimitAndNeverGrow FAILED
# بعد تحديثه (50 MB للحد، و25 MB للطلب الواحد):
BUILD SUCCESSFUL in 43s
tests 199 skipped 4 failed 0      # الجديدة: PhotoQualityTest 5، وthisPhoneIsTheDefaultAndOnlyAPickPinsTheVoice
lint: 0 errors, 22 warnings       # كما في main
```

(بقية الفحوص ونتيجة CI تُضاف قبل المراجعة.)

## المخاطر والرجوع
- لم يُجرَّب على جهاز: الملف الأصلي من منتقي iOS بـ`.current`، والرفع المستأنف أمام مركز حقيقي،
  مختبران بالمنطق فقط (خلفية مزيّفة تتحقق من الإزاحات والقطع والإلغاء).
- ملف فوق ٢٥ م.ب يُرفع بقطع `chunk_bytes` (٢٥٦ ك.ب في الخادم): قرابة ٢٠٠ طلب لـ٥٠ م.ب، بلا استئناف بعد انقطاع الشبكة (يُلغى ويظهر خطأ).
- الرجوع: إرجاع هذا الفرع؛ لا بيانات ولا عقد تغيّر.

## التسليم والخطوة التالية
PR إلى `main` حين يخضرّ CI، والمالك يدمج.
