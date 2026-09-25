# تلميع تطبيقي الجوال من ملاحظات المالك (iOS وأندرويد)
المسؤول: twuijri · الفرع: fix/mobile-polish · الحالة: review

## المشكلة والهدف
ملاحظات المالك من الاستخدام الفعلي على iPhone (TestFlight 1.1.0 (109))، وكل بند يُصلَح على
المنصتين معًا. هذا السجل بيت ملاحظات الجوال في هذا الفرع؛ كل بند تحت عنوانه.

1. **الكيبورد في المحادثة** — «المفروض اذا ضغطت بالوسط على المحادثه ينزل الكيبورد». النقر على
   المحادثة خارج مربع الكتابة لا يُنزل الكيبورد، وسحب القائمة لا يُنزله على أندرويد.
2. **القائمة الجانبية فوق الكيبورد** — «المفروض اذا فتحت القائمة الجانبية يصغير الكيبورد».
3. **شعار الدرج وما يغطيه الكيبورد** — رأس الدرج يعرض «CH» بدل علامة كور هب؛ والتأكد أن مربع
   الكتابة وآخر رسالة فوق الكيبورد، وأن صفوف أسفل الدرج لا يغطيها.
4. **المرفقات في مربع الكتابة** — لا طريقة لإرفاق شيء من التطبيق.
5. **مصدر الصوت** — الإملاء والقراءة بصوت الجوال فقط، والويب يستعمل مزوّدي المركز.
6. **أيقونات Lucide** — المالك يريد مجموعة Lucide بدل SF Symbols وMaterial.
7. **إذن الإشعارات وحالة الدفع** — المالك لم يرَ طلب إذن الإشعارات، وصفحة الإعدادات لا تقول
   بوضوح لماذا لا يصله الدفع.

## القرار والموافقات
طلب المالك (2026-09-25). القرارات، كل بند وحده:

### ١) الكيبورد في المحادثة
- iOS: المحادثة كانت فيها `.scrollDismissesKeyboard(.interactively)` أصلًا (السحب يُنزل الكيبورد
  مع الإصبع). أُضيف نقر يُنزله: `dismissesKeyboardOnTap()` إيماءة نقر **متزامنة**
  (`simultaneousGesture`) فوق قائمة الرسائل، فلا تأخذ النقر من الأزرار ولا الروابط ولا تحديد النص.
  والإنزال نفسه `Keyboard.dismiss()` (`resignFirstResponder` على التطبيق كله). وفي «محادثة جديدة»
  النقر على المساحة الفارغة فوق الوكلاء ومربع الكتابة يُنزله أيضًا.
- iOS: قارئ عند آخر رسالة يبقى عندها حين يظهر الكيبورد (علامة القاع ظاهرة عند `keyboardWillShow`
  ⇐ تمرير إلى القاع عند `keyboardDidShow`). قارئ صعد يقرأ القديم لا يُحرَّك.
- أندرويد: `imePadding` كان موجودًا. أُضيف: نقر على المحادثة يُنزل الكيبورد (`detectTapGestures`
  على الأب؛ الأبناء يرون النقر أولًا فزر الموافقة يعمل ولا يُنزله)، وسحب القائمة يُنزله مرة لكل
  سحبة (`NestedScrollConnection`، مصدر `UserInput` فقط). وحين يصغر عرض القائمة لأن الكيبورد ظهر،
  قارئ كان عند آخر رسالة يُمرَّر بقدر ما صغرت فيبقى آخرها ظاهرًا فوق مربع الكتابة.
- **لماذا «مصبّ تركيز» على أندرويد لا `clearFocus()`**: اختبار Robolectric أظهر أن مسح التركيز
  يُفقد نافذة Compose تركيزها، فيعيده أندرويد إليها، فتعطيه Compose لأول عنصر قابل للتركيز — وهو
  مربع الكتابة نفسه، فيعود الكيبورد. الحل: `KeyboardDismisser` ينقل التركيز إلى منطقة بلا حقل نص
  (`Modifier.keyboardSink`: قائمة الرسائل، أو الدرج) ثم يُخفي الـIME، ولا يمسح التركيز إلا إن لم يجد
  المصبّ.

### ٢) الدرج
- iOS: `DrawerState` يُنزل الكيبورد **قبل** أي حركة للدرج، فتحًا وإغلاقًا (زر القائمة، الظل، اختيار
  صف) — والإغلاق أيضًا لأن بحث المحادثات داخل الدرج حقل نص. سحب قائمة الدرج يُنزل الكيبورد.
- أندرويد: `DismissKeyboardWhenDrawerMoves` يراقب `drawer.targetValue`، فيغطي الفتح بالزر وبالسحب
  من الحافة، والإغلاق. الدرج مصبّ التركيز عند فتحه. وعمود الدرج عليه `imePadding` فحين يُكتب في بحث
  الدرج يرتفع أسفله (الحساب، اللغة، المظهر، الخروج، الإصدار) فوق الكيبورد.
- الاتجاه لم يتغير: iOS `.move(edge: .leading)` وأندرويد `ModalNavigationDrawer` من حافة بداية
  القراءة، أي من اليمين بالعربية، كما كانا.

### ٣) الشعار
- العلامة نفسها التي في الويب (`CoreHubMark`، بلون `accent` بلا مربّع، كرأس الشريط الجانبي في الويب).
  المصدر واحد: `scripts/icons/build-icons.mjs` صار يكتب أيضًا `Assets.xcassets/BrandMark.imageset`
  (SVG قالب يُحفظ متجهًا) و`res/drawable/ic_brand_mark.xml`. `BrandMark` في التطبيقين يرسمها، فتظهر
  في الدرج وشاشة الدخول و«محادثة جديدة» (iOS) وشاشة الربط (أندرويد).

### ٤) المرفقات
- زر «+» في مربع الكتابة بثلاثة خيارات: مكتبة الصور، الكاميرا، ملف. iOS: `PhotosPicker` (حتى ١٠)،
  و`UIImagePickerController` للكاميرا، و`.fileImporter`. أندرويد: منتقي الصور في النظام
  (`PickMultipleVisualMedia`)، و`TakePicture` إلى ملف في الذاكرة المؤقتة عبر `FileProvider` الموجود
  (مسار `camera/` أُضيف إلى `update_paths.xml`، ويُطلب إذن الكاميرا لأن التطبيق يعلن `CAMERA`
  للماسح)، و`OpenMultipleDocuments`.
- **كما يفعل الويب**: كل ملف يُرفع فور اختياره (`sessions.uploadAttachment`، الغرض `message`، في
  بروفايل المحادثة)، ويظهر شريحة بمعاينة وزر ×؛ × يحذف المرفوع من المركز
  (`sessions.deleteAttachment`). الإرسال ينتظر انتهاء الرفع، ثم يرسل نصًا ثم كتلة لكل ملف (`image`
  للصور، `file` لغيرها) كما في `blocksFor` بالويب. رسالة بملفات بلا كلمات مسموحة. الرسالة الأولى في
  «محادثة جديدة» تحمل ملفاتها أيضًا.
- الصور (من المكتبة والكاميرا) تُصغَّر قبل الرفع: الضلع الأطول ≤ ٢٠٤٨ بكسل، JPEG بجودة ٠٫٨ (أندرويد
  ٨٠، ومعتدلة الاتجاه عبر `ImageDecoder`). الملفات من «ملف» تُرسل كما هي.
- الحد ٢٥ م.ب (حد الرفع في طلب واحد): ما فوقه يُرفض قبل الرفع برسالة واضحة، ورد المركز `413`
  يظهر بالرسالة نفسها. الرفع المستأنف للملفات الأكبر (`/attachment-uploads`) لم يُبنَ على الجوال
  (اقتراح — للمالك أن يؤكد).
- ملفات الرسالة المرسلة تظهر أسماءً تحتها (iOS؛ أندرويد كان يعرضها أصلًا). عرض الصور نفسها داخل
  المحادثة ليس في هذا الفرع.
- أذونات iOS: `NSPhotoLibraryUsageDescription` جديدة، و`NSCameraUsageDescription` صارت تذكر الصور
  المرفقة، بالعربية والإنجليزية (`InfoPlist.strings` يولّدها `generate-swift.mjs` من الكتالوج).

### ٥) مصدر الصوت
- إعداد «الصوت: كور هب / الجوال» في «هذا الجهاز» على المنصتين؛ الافتراضي «كور هب». ومع «كور هب»:
  يُسأل المركز `models.getSpeech` لبروفايل المحادثة (مرة في الدقيقة على الأكثر)؛ إن كان مزوّد
  STT جاهزًا (`stt.ready`) يُسجَّل المقطع (m4a/AAC، ١٦ كيلوهرتز أحادي) ويُرسل إلى
  `models.transcribe` بلغة الإملاء ومدته، وإلا يُستعمل مُعرِّف الكلام في الجوال كما كان. رد `400`
  بسبب `no_speech` يظهر تلميحًا ودودًا لا خطأ.
- قراءة الردود: مع «كور هب» ومزوّد TTS جاهز، `models.synthesize` بأجزاء ≤ ٢٠٠٠ حرف (يُقطع عند نهاية
  جملة) تُشغَّل تباعًا، وإن فشل الجزء الأول يقرأ الجوال. وإلا صوت الجوال كما كان.
- «الجوال» يعني الجوال دائمًا. أندرويد يطلب إذن الميكروفون (`RECORD_AUDIO`، جديد في المانيفست) فقط
  حين يسجّل للمركز؛ مُعرِّف النظام لا يحتاجه.

### ٦) أيقونات Lucide
- `scripts/icons/lucide-mobile.mjs` (جديد): يأخذ أسماء Lucide (من `scripts/icons/lucide-mobile.json`
  أو من سطر الأوامر فيضيفها للقائمة)، ويقرأ أشكالها من حزمة `lucide-static` المثبّتة `1.48.0`
  (اعتماد تطوير في الجذر)، ويكتب لكل أيقونة: iOS صورة قالب SVG في `Assets.xcassets/Lucide/`
  (مساحة اسم، فالتطبيق يطلب `Image(lucide: .camera)` من `Generated/Lucide.swift`)، وأندرويد
  `res/drawable/lucide_*.xml`. كل عنصر (دائرة، مستطيل، خط…) يُحوَّل إلى مسار لأن أندرويد يرسم
  مسارات فقط، ويستعمل iOS المسارات نفسها. `--check` يفشل إن اختلف ملف أو بقي ملف لأيقونة حُذفت من
  القائمة، فيصلح لـPR التحويل الكامل لاحقًا.
- استُعملت هنا فقط للأيقونات التي أضافها هذا الفرع أو لمسها: `plus`، `image`، `camera`،
  `file-text`، `x`، `mic`. لم تُحوَّل بقية أيقونات التطبيقين (PR منفصل بعد هذا وبعد device-cards).
- إشعار ISC لـLucide في `THIRD-PARTY-NOTICES.md`.

### ٧) إذن الإشعارات وحالة الدفع
- **السبب الجذري**: لم يثبت. المالك وجد الإشعارات مسموحة في إعدادات الآيفون، فالطلب ظهر على الأرجح؛
  و«لا دفع» سببه أن المركز بلا مرسِل APNs بعد (`.noSender`). ومع ذلك كان في الكود ضعفان حقيقيان
  أُصلحا: الطلب كان يُسأل مرة واحدة بعد الدخول مباشرة، أثناء إغلاق شاشة المسح، ولا يُعاد أبدًا إن
  ضاع؛ وحالة `.noSender`/`.failed` لا تُعاد إلا عند تشغيل بارد.
- iOS: `PermissionPrompt` يسأل ما دامت الحالة `.notDetermined`، والتطبيق في المقدمة، مرة واحدة في كل
  تشغيل، بعد مهلة قصيرة (٠٫٧ ث) لتنغلق الورقة أو الماسح؛ ولا يسأل بعد الرفض أبدًا. `PushCenter.start`
  هو من يسأل (بعد الدخول، عند التشغيل، وعند العودة للمقدمة)، و`foreground` يعيد المحاولة ما دامت
  الحالة ليست `.active` — فمرسِل أُضيف في المركز يُلتقط بعودة التطبيق للمقدمة لا بإعادة تشغيله.
  حالة جديدة `.waiting` تميّز «لم يُسأل بعد» عن «مرفوض».
- أندرويد: `NotificationAsk` يسأل (Android 13+) ما دام الإذن غير ممنوح، مرة في كل تشغيل، ولا يسأل
  بعد «لا» (تُحفظ). كان يسأل مرة في عمر التثبيت فقط. `PushStatus.retriesOnForeground` يعيد تسجيل
  الدفع عند عودة التطبيق للمقدمة (`ProcessLifecycleOwner`).
- الصف الواضح في «هذا الجهاز» و«الإعدادات ← الإشعارات» على المنصتين: الحالة بكلمات بسيطة («الإشعارات
  الفورية تعمل»، «بانتظار إذنك»، «متوقفة من إعدادات الآيفون/الجوال»، «لا يوجد في المركز مرسِل للآيفون
  / لأندرويد بعد»، «فشل التسجيل»)، والشرح الأطول تحته، وزر «اسمح بالإشعارات» ما دام السؤال ممكنًا، أو
  «الإشعارات متوقفة لكور هب — افتح الإعدادات» الذي يفتح إعدادات إشعارات التطبيق في النظام.
- لم يُلمس كود تسجيل الجهاز ولا `PushRegistrar` (فرع `feat/device-cards` يعمل هناك).

اقتراحات — للمالك أن يؤكد: حد ٢٥ م.ب بلا رفع مستأنف على الجوال؛ «كور هب» مصدرًا افتراضيًا للصوت؛
مهلة ٠٫٧ ث قبل طلب الإذن؛ أن × على شريحة مرفوعة يحذفها من المركز فورًا.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. التطبيقان يستعملان عمليات موجودة: `sessions.uploadAttachment`، `sessions.deleteAttachment`،
`sessions.createRun` (كتل `image`/`file`)، `models.getSpeech`، `models.transcribe`، `models.synthesize`.

## الملفات والتأثير
- مشترك: `scripts/icons/build-icons.mjs` (العلامة داخل التطبيقين)، `scripts/icons/lucide-mobile.mjs`
  و`lucide-mobile.json` (جديدان)، `package.json` و`pnpm-lock.yaml` (`lucide-static` مثبّت)،
  `THIRD-PARTY-NOTICES.md`، `docs/STATUS.md`.
- iOS: `Shell/Keyboard.swift` (جديد)، `Shell/ShellView.swift`، `Shell/SidebarView.swift`،
  `Shell/Components.swift`، `Chat/Attachments.swift` (جديد)، `Chat/ChatParts.swift` (الزر والشرائح
  والميكروفون)، `Chat/ChatScreen.swift`، `Chat/NewChatScreen.swift`، `Chat/ChatModel.swift`،
  `Phone/Voice.swift`، `Phone/Push.swift`، `App/AppModel.swift`، `Hub/HubFailure.swift`
  (`details.reason`)، `Settings/SettingsScreen.swift` و`SettingsPages.swift`، `i18n/ar.json`
  و`en.json`، `project.yml` و`scripts/generate-swift.mjs` و`InfoPlist.strings`، `Generated/Lucide.swift`
  و`Assets.xcassets/{BrandMark,Lucide}` (مولَّدة)، الاختبارات `KeyboardTests.swift`
  و`AttachmentsVoiceTests.swift` (جديدان) و`PushTests.swift`.
- أندرويد: `ui/components/Keyboard.kt` و`AttachButton.kt` و`chat/Attachments.kt`
  و`phone/HubVoice.kt` و`phone/NotificationStatus.kt` (جديدة)، `ui/components/Common.kt`
  و`ChatParts.kt`، `ui/screens/ChatScreen.kt` و`ChatViewModel.kt` و`Shell.kt` و`SettingsScreen.kt`،
  `phone/Voice.kt` و`DeviceSettings.kt` و`ThisDevice.kt`، `data/Hub.kt` (`models`، `reason`)،
  `AppGraph.kt` (نوع صندوق الرسالة الأولى، وإعادة الدفع في المقدمة)، `MainActivity.kt`،
  `AndroidManifest.xml` (`RECORD_AUDIO`)، `res/xml/update_paths.xml`، `res/values{,-ar}/strings.xml`،
  `res/drawable/{ic_brand_mark,lucide_*}.xml` (مولَّدة)، `app/build.gradle.kts`
  و`gradle/libs.versions.toml` (Robolectric وأدوات اختبار Compose للاختبار فقط)،
  `src/testDebug/.../KeyboardDismissTest.kt` و`src/test/.../phone/MobilePolishTest.kt` (جديدان).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (كل أمر ثقيل عبر `mj-run`؛ أندرويد بـJDK 17 وSDK 35؛ لا Xcode محليًا، فـiOS على CI):

```
$ ./gradlew --no-daemon --max-workers=2 testDebugUnitTest --tests 'hub.core.android.ui.KeyboardDismissTest'
# مع جعل KeyboardDismisser.dismiss() لا يفعل شيئًا (السلوك القديم):
KeyboardDismissTest > tappingTheConversationPutsTheKeyboardAway FAILED
KeyboardDismissTest > openingTheDrawerPutsTheKeyboardAwayFirst FAILED
KeyboardDismissTest > draggingTheConversationPutsTheKeyboardAway FAILED
5 tests completed, 3 failed
# بالكود الجديد:
BUILD SUCCESSFUL
$ ./gradlew --no-daemon --max-workers=2 assembleDebug test lint     (apps/android)
BUILD SUCCESSFUL in 1m 1s
tests 189 skipped 4 failed 0      # debug + release; الجديدة: KeyboardDismissTest 5، AttachmentsTest 4،
                                  # VoiceSourceTest 4، NotificationStatusTest 3، LucideDrawablesTest 1
lint: 0 errors, 22 warnings       # الجديد الوحيد UseKtx على notificationsDenied بأسلوب الملف القائم
$ pnpm lint
All matched files use Prettier code style!
$ pnpm contracts:check-clients
check-clients  OK — 593 client file(s) scanned, 222 contract path(s) known.
$ pnpm i18n:check
i18n:check  ios: 346 keys, ar/en in parity
i18n:check  OK
$ node apps/ios/scripts/generate-swift.mjs --check
generate-swift  OK — every generated file matches its source
$ node scripts/icons/lucide-mobile.mjs --check
lucide: 6 icon(s) from lucide-static 1.48.0 up to date
$ pnpm icons:build --check
icons: 26 files up to date
$ pnpm version:check
version: 1.1.0 everywhere (8 places)
$ pnpm change-record:check
change-record  OK — 1 record(s) valid
```

CI على PR #147 (الدفعة الثانية، iOS كاملًا): «Build and test on the iOS simulator» نجح —
`Executed 86 tests, with 0 failures`، منها `KeyboardTests` (٢)، `BrandMarkTests`، `AttachmentTests`
(٥)، `VoiceSourceTests` (٤)، `LucideIconTests`، و`PushTests` الجديدة (٤) — وكل الوظائف الأخرى نجحت.
نتيجة الدفعة الأخيرة (أندرويد للبنود ٤–٧) تُكتب في الـPR.

## المخاطر والرجوع
- لم يُجرَّب شيء على جهاز حقيقي ولا على مركز المالك: الكاميرا، منتقي الصور، التسجيل للمركز، وتشغيل
  صوت المركز مختبرة بالمنطق فقط (لا محاكي بكاميرا أو ميكروفون في CI).
- إيماءة النقر في iOS متزامنة: نقر زر داخل رسالة يُنزل الكيبورد أيضًا (كما في Messages)؛ على
  أندرويد الزر يحتفظ بنقرته والكيبورد يبقى.
- Robolectric يُنزَّل أول مرة في CI؛ يزيد وقت وظيفة أندرويد قليلًا، ولا يدخل في التطبيق.
- `AVAudioPlayer` لا يشغّل ogg؛ إن أعاد مزوّد المركز ogg يقرأ الجوال بدلًا منه.
- الرجوع: إرجاع هذا الفرع؛ لا بيانات ولا عقد تغيّر.

## التسليم والخطوة التالية
البنود ١–٧ مبنية على المنصتين ومختبرة. التالي: مراجعة المالك وتجربة بناء اختبار على جهازيه؛ ثم PR
تحويل كل الأيقونات إلى Lucide (الويب والتطبيقان) بعد دمج هذا وdevice-cards، بالسكربت نفسه.
