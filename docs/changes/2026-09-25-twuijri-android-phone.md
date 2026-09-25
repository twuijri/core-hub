# تطبيق أندرويد — الجزء ٣: خصائص الجوال
المسؤول: twuijri · الفرع: feat/android-app-phone · الحالة: review

## المشكلة والهدف
الجزء الأخير من طلب المالك «ولو خلصت تطبيق الديسك توب … ابدا بالايفون والاندرويد»: ما يجعل
التطبيق تطبيق جوال لا نافذة على الويب — الإشعارات، «مشاركة إلى كور هب» من التطبيقات الأخرى، الإدخال
الصوتي بمميّز الكلام في الجوال، وصفحة «هذا الجهاز» (`this_device`) كاملة كما يصفها `NAVIGATION.md`
§٢: «اتصال Core Hub، وضع الإدخال الصوتي، لغة الإملاء، الردود المنطوقة، التحديث الذاتي حيث تسمح المنصة».

الفرع مبني فوق `feat/android-app-destinations` (#125)، وطلب الدمج قاعدته ذلك الفرع.

## القرار والموافقات
المالك نائم؛ القرارات التالية **مقترحة — والمالك يؤكد**:

- **الإشعارات بلا Push الآن**: وحدة `devices` ما زالت 501 (ومنها `registerPush`)، فلا FCM في هذا
  الجزء، ولا حاجة إلى خدمات Google في التطبيق. بدلها: (١) ما يعلنه المركز على `/rt/devices`
  (`notice.created`) يصير إشعار أندرويد ما دام التطبيق يعمل ولا شاشة منه ظاهرة؛ (٢) فحص في الخلفية
  كل ١٥ دقيقة بـWorkManager حين تتوفر الشبكة (`notify.listNotices` غير المقروءة) والتطبيق مغلق —
  مفعَّل افتراضيًا ويُطفأ من «هذا الجهاز». كل إشعار يظهر مرة واحدة، والضغط عليه يفتح ما يخصّه
  (`corehub://open/<المسار>`). يُطلب إذن الإشعارات (أندرويد ١٣+) مرة بعد الدخول. **Push الحقيقي
  (FCM وتسجيل الجهاز `devices.registerPush`) متابعة** حين تُبنى وحدة `devices` في المركز.
- **المشاركة إلى كور هب**: النص والروابط فقط (`text/plain`) تصير مسودة محادثة جديدة في بروفايل
  المبدّل، ولو وصلت قبل الدخول تنتظره. **الملفات والصور متابعة**: تحتاج رفع المرفقات في خانة الكتابة
  أولًا.
- **الإدخال الصوتي**: زرّ ميكروفون في خانة الكتابة يستدعي مميّز الكلام في الجوال (`RecognizerIntent`)
  لجملة واحدة، ويُضاف نصها إلى المسودة ولا يُرسل وحده. لغة الإملاء: كلغة التطبيق (افتراضيًا) أو
  العربية أو الإنجليزية. لا يظهر الزر إن لم يكن في الجوال مميّز كلام أو أطفأه الشخص. لا يحتاج التطبيق
  إذن الميكروفون لأن تطبيق التمييز هو من يسجّل. (تحويل الكلام عبر مزوّد STT في المركز خيار لاحق.)
- **الردود المنطوقة** (مطفأة افتراضيًا): حين يكتمل رد في محادثة ظاهرة على الشاشة يُقرأ بصوت الجوال
  (TextToSpeech)، بالعربية إن كان نصه عربيًا وإلا بالإنجليزية.
- **التحديث الذاتي**: «ابحث عن تحديث» يسأل قناة `updates` في المركز عن أحدث إصدار أندرويد
  (`updates.check` بـ`android` و`stable`)؛ إن وُجد يُنزَّل من المركز، ويُطابَق SHA-256 مع الإصدار، ثم
  يُسلَّم لمثبّت أندرويد الذي يسأل الشخص. ملف لا يطابق يُحذف ولا يُثبَّت. مركز بلا قناة يقول ذلك.
- كل خيارات «هذا الجهاز» تُحفظ في الجوال نفسه، لا في المركز: هي وصف لهذا الجهاز.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. العمليات المستعملة موجودة: `notify.listNotices`، `updates.check`، `updates.download`، والحدث
`notice.created` على `/rt/devices`.

## الملفات والتأثير
- `apps/android/app/src/main/java/hub/core/android/phone/`: `DeviceSettings.kt` (خيارات هذا الجهاز ولغة
  الإملاء)، `Notices.kt` (أيّ الإشعارات يُعرض ومساره، القناة، `NoticeWorker`)، `Voice.kt` (زر الميكروفون
  والقارئ)، `Share.kt`، `Updates.kt`، `ThisDevice.kt` (الصفحة).
- `AppGraph.kt`: خيارات الجهاز، القارئ، مراقبة `notice.created`، وجدولة الفحص حسب الدخول والخيار.
- `ChatViewModel.kt`: قراءة الرد المكتمل حين تُفعَّل الردود المنطوقة. `ChatScreen.kt`: الميكروفون، ومسودة
  المشاركة. `MainActivity.kt`: نية `SEND`، وإذن الإشعارات مرة.
- `AndroidManifest.xml`: `POST_NOTIFICATIONS`، `REQUEST_INSTALL_PACKAGES`، `<queries>` لخدمة التمييز
  والنطق، مرشّح `SEND text/plain`، و`FileProvider` لملف التحديث وحده (`res/xml/update_paths.xml`).
- `res/drawable/ic_notice.xml` (أيقونة الإشعار من علامة التطبيق)، النصوص بالعربية والإنجليزية.
- `libs.versions.toml` و`app/build.gradle.kts`: `androidx.work:work-runtime-ktx` 2.10.1.
- `docs/STATUS.md` (العملاء).

الاختبارات: `PhoneTest` (كل إشعار غير مقروء يظهر مرة، الأقدم أولًا؛ مسار كل إشعار؛ نص المشاركة وعنوانها؛
لغة الإملاء ولغة القراءة؛ حفظ الخيارات وقيمها الافتراضية؛ SHA-256 للتحديث). و`LiveHubTest` صار يسأل
قناة التحديثات أيضًا.

## الفحوص (الأوامر ونواتجها الفعلية)

```
$ ./gradlew --no-daemon --max-workers=2 :app:testDebugUnitTest
testsuite hub.core.android.chat.ChatReducerTest tests="8" failures="0" errors="0"
testsuite hub.core.android.contract.ContractExamplesTest tests="1" failures="0" errors="0"
testsuite hub.core.android.data.AuthTest tests="8" failures="0" errors="0"
testsuite hub.core.android.data.PairingTest tests="7" failures="0" errors="0"
testsuite hub.core.android.data.RealtimeTest tests="3" failures="0" errors="0"
testsuite hub.core.android.data.SecureStoreTest tests="3" failures="0" errors="0"
testsuite hub.core.android.live.LiveHubTest tests="2" skipped="2" failures="0" errors="0"
testsuite hub.core.android.markdown.MarkdownTest tests="6" failures="0" errors="0"
testsuite hub.core.android.nav.AppPathsTest tests="4" failures="0" errors="0"
testsuite hub.core.android.nav.NavigationParityTest tests="8" failures="0" errors="0"
testsuite hub.core.android.phone.PhoneTest tests="6" failures="0" errors="0"
testsuite hub.core.android.ui.ChatsListTest tests="5" failures="0" errors="0"
testsuite hub.core.android.ui.DestinationsTest tests="3" failures="0" errors="0"
testsuite hub.core.android.ui.StringsParityTest tests="2" failures="0" errors="0"

$ COREHUB_LIVE_HUB=http://127.0.0.1:8791 … ./gradlew :app:testDebugUnitTest --tests '*LiveHubTest*'
tests 2 failures 0 errors 0 skipped 0
live: event /rt/devices notice.created seq=1
live: run ended; failure=stream ended unexpectedly; messages=[(user, مرحبا), (assistant, )]; lastSeq=8
live: update check available=false reason=NOT_CONFIGURED
live: board 9 columns; 0 schedules; 7 notices; 1 profiles; 1 users; 0 app tokens; hub Core Hub 1.0.0; direct settings 1 sections; search 2 hits
```

ما لم يُجرَّب: على جهاز حقيقي أو محاكٍ — لا صلاحية `/dev/kvm` هنا — فلم يُرَ الإشعار ولا ورقة
المشاركة ولا الميكروفون ولا المثبّت على شاشة؛ المنطق خلفها مختبَر بالوحدات، و`notice.created` رُئي
يصل من مركز حقيقي.

CI على #127 (قاعدته `feat/android-app-destinations`):

```
Android build, unit tests, lint                       pass   (run 36095032304, BUILD SUCCESSFUL in 5m 13s)
  Debug APK: 15M (15393662 bytes) · artifact corehub-android-debug-apk (14,799,747 bytes zipped)
Lint, typecheck, contracts, tests, build              pass
Web smoke journeys (Playwright against the real hub)  pass
Docker image builds and answers /health               pass
db:generate + db:migrate (SQLite and PostgreSQL)      pass
PR adds or updates a change record                    pass
PR leaves graphify-out/ to the code-map bot           pass
```

نسخة الإصدار (R8، غير موقّعة) بعد الأجزاء الثلاثة، مبنية محليًا للقياس: ‏2,564,370 بايت (٢٫٦ م.ب).

## المخاطر والرجوع
- الفحص في الخلفية كل ١٥ دقيقة يستهلك قليلًا من البطارية والشبكة؛ يُطفأ من «هذا الجهاز».
- «التثبيت من مصادر غير معروفة» يطلبه أندرويد عند أول تحديث ذاتي؛ هذا سلوك المنصة.
- الرجوع: عكس هذا الطلب يعيد الجزأين ١ و٢ كما هما؛ لا شيء في المركز تغيّر.

## التسليم والخطوة التالية
- Push حقيقي (FCM) حين تُبنى وحدة `devices` (`registerPush`)، ومعه إشعار فوري والتطبيق مغلق.
- مشاركة الملفات والصور بعد رفع المرفقات من خانة الكتابة.
- تشغيل التطبيق على جهاز أو محاكٍ للتحقق من الواجهة، ونشر إصدار أندرويد في قناة `updates` إن أراد المالك.
