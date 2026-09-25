# تطبيق iOS — الجزء ٣: خصائص الهاتف
المسؤول: twuijri · الفرع: feat/ios-app-phone · الحالة: review

## المشكلة والهدف
قال المالك: «ولو خلصت تطبيق الديسك توب … ابدا بالايفون والاندرويد». بعد الهيكل والمحادثة (#120)
وكل الوجهات (#124)، يبقى ما يخص الهاتف: الإشعارات، الإضافة للمشاركة من تطبيقات أخرى، الإملاء،
وإعدادات «هذا الجهاز» (الإدخال الصوتي، لغة الإملاء، الردود المنطوقة). مكدَّس على #124.

## القرار والموافقات
كل قرار منتج هنا **مقترح — والمالك يؤكد**:

- **لا APNs الآن، وإشعارات محلية ما دام التطبيق يعمل.** التسجيل للدفع يحتاج وحدة `devices` في
  المركز (`devicesRegisterPush` ما زالت 501، `docs/STATUS.md`) وحساب Apple للمالك (مفتاح دفع).
  بدلًا منه يستمع التطبيق على `/rt/devices` لحدث `notice.created` الذي يكتبه المركز بلغة الشخص
  (انتهى رد، وكيل ينتظر)، ويعرضه إشعارًا محليًا، صامتًا إن كانت المحادثة نفسها على الشاشة، والضغط
  عليه يفتح المحادثة في بروفايلها. يعمل ما دام التطبيق مفتوحًا أو أُغلق للتو؛ حين يعلّقه iOS لا يصل
  شيء — مكتوب في `apps/ios/README.md` وفي صفحة «هذا الجهاز».
- **ونظرة في الخلفية والتطبيق مغلق**، كما في أندرويد (WorkManager هناك): `BGAppRefreshTask` يطلب من
  iOS إيقاظ التطبيق قرابة كل ١٥ دقيقة — iOS يقرّر متى وهل — فيقرأ الإشعارات غير المقروءة منذ آخر نظرة
  (`notify.listNotices`) ويعرض الجديد منها. كل إشعار يظهر مرة واحدة أيًّا كان الطريق الذي رآه أولًا.
  مفعّلة افتراضيًا وتُطفأ من «هذا الجهاز».
- **إذن الإشعارات يُطلب مرة بعد الدخول أو الاقتران**، ويظهر في «هذا الجهاز» مع زرّ لطلبه.
- **الإضافة للمشاركة لا تكلّم المركز**: تحفظ النص أو الرابط في App Group، والتطبيق يفتح به محادثة
  جديدة يراجعها الشخص قبل الإرسال. الإضافة لا تحمل أي رمز دخول، فلا يذهب شيء مُشارَك إلى المركز دون أن
  يفتح الشخص التطبيق ويرسله. الـApp Group (`group.io.github.twuijri.corehub`) لا يعمل قبل توقيع
  التطبيق بحساب المالك.
- **الإملاء بالتعرّف على الكلام في الهاتف** (Speech framework) في زرّ ميكروفون داخل خانة الكتابة؛
  ما يُسمع يلحق بما كُتب. وضع «server» (إرسال الصوت للمركز) ليس هنا بعد.
- **الردود المنطوقة** بـ`AVSpeechSynthesizer`، بلغة الرد نفسه (أول حرف قوي)، بلا الكود ولا علامات
  Markdown.
- **التحديث الذاتي** الذي يذكره `NAVIGATION.md` «حيث تسمح المنصة»: iOS لا يسمح به (التحديث من
  App Store أو TestFlight)، فلا خيار له في «هذا الجهاز».
- **خيارات «هذا الجهاز» تُحفظ في الهاتف لا في المركز**: هاتف آخر للشخص نفسه قد لا يملك ميكروفونًا أو
  يريد لغة أخرى. (`Preferences.voice` في المركز لم يُمسّ.)

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. يُستخدم حدث `notice.created` على `/rt/devices` كما هو في `events/devices`.

## الملفات والتأثير
- `apps/ios/CoreHub/Phone/LocalNotices.swift` (جديد): `/rt/devices` ← إشعار محلي، النظرة في الخلفية
  (`BGAppRefreshTask`، و`UIBackgroundModes: fetch` في `project.yml`)، ومنع التكرار، والتوجيه عند الضغط.
- `apps/ios/CoreHub/Phone/Voice.swift` (جديد): إعدادات الجهاز، الإملاء، القراءة بصوت.
- `apps/ios/CoreHub/Share/ShareInbox.swift` و`apps/ios/CoreHubShare/ShareViewController.swift`
  (جديدان) وهدف `CoreHubShare` في `project.yml` (امتداد مشاركة يُضمَّن في التطبيق، وApp Group للهدفين).
- `Chat/ChatParts.swift` (زرّ الإملاء)، `Chat/ChatModel.swift` (القراءة بصوت)، `Chat/ChatScreen.swift`
  (المحادثة الظاهرة)، `Chat/NewChatScreen.swift` و`Shell/ShellView.swift` (مسودة من المشاركة)،
  `Settings/SettingsScreen.swift` («هذا الجهاز»)، `App/AppModel.swift`.
- `project.yml`: أذونات الميكروفون والتعرّف على الكلام؛ `scripts/generate-swift.mjs` يكتب نصّيهما
  بالعربية والإنجليزية في `InfoPlist.strings`؛ `i18n/{ar,en}.json` (277 مفتاحًا).
- `apps/ios/README.md` (الإشعارات، الـApp Group في خطوات التوقيع)، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا:

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm contracts:check-clients
check-clients  OK — 327 client file(s) scanned, 176 contract path(s) known.
$ pnpm i18n:check
i18n:check  ios: 277 keys, ar/en in parity
i18n:check  OK
$ node apps/ios/scripts/generate-swift.mjs --check
generate-swift  OK — every generated file matches its source
```

على GitHub Actions (`iOS`، التشغيل 36095100212؛ وبعد إضافة النظرة في الخلفية التشغيل 36095875410: `Executed 53 tests, with 0 failures`):

```
Test Case '-[CoreHubTests.PhoneTests testANoticeLeadsToItsConversationInItsProfile]' passed (0.005 seconds).
Test Case '-[CoreHubTests.PhoneTests testARepliesSpokenWordsLeaveMarkdownAndCodeOut]' passed (0.001 seconds).
Test Case '-[CoreHubTests.PhoneTests testSharedTextWaitsOnceForTheApp]' passed (0.008 seconds).
Test Case '-[CoreHubTests.PhoneTests testThisDevicesChoicesPersistAndPickTheDictationLanguage]' passed (0.004 seconds).
	 Executed 52 tests, with 0 failures (0 unexpected) in 3.159 (8.726) seconds
** TEST SUCCEEDED **
Copy …/CoreHub.app/PlugIns/CoreHubShare.appex … (in target 'CoreHub' from project 'CoreHub')
```

## المخاطر والرجوع
- لا شيء من هذا جُرّب على جهاز: الإشعارات والميكروفون والكاميرا والمشاركة تحتاج هاتفًا حقيقيًا.
- الإشعارات لا تصل والتطبيق معلَّق؛ هذا حدّ معروف حتى تُبنى وحدة `devices` ويُضاف حساب Apple.
- المشاركة لا تصل إلى التطبيق قبل التوقيع (App Group).
- الرجوع: إعادة هذا الطلب؛ لا شيء في المركز تغيّر.

## التسليم والخطوة التالية
طلب الدمج بالإنجليزية، مكدَّس على #124 (المكدَّس على #120). على المالك: تأكيد القرارات، وحين يريد
التطبيق على جهازه: حساب Apple وتسجيل المعرّف والـApp Group (الخطوات في `apps/ios/README.md`). بعد
بناء وحدة `devices` في المركز: تسجيل رمز APNs بـ`devicesRegisterPush`.
