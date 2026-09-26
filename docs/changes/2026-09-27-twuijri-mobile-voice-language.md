# الجوال: لغة الإملاء تلقائية، إملاء متواصل بشريط، صور الردود داخل الرسالة، وصوت المركز على الآيفون
المسؤول: twuijri · الفرع: fix/mobile-voice-language · الحالة: review

## المشكلة والهدف
- **الإملاء بالإنجليزي** — المالك على آيفون ولوحة المفاتيح عربية، ضغط المايك فتعرّف الكلام إنجليزيًا.
  قال: «المفروض هو يتعرف تلقائي… نحطها (تغيير اللغة) كخيار إضافي بس، الناس مو بعارفة أنه لازم تضغط
  على زر المايك بزيادة عشان يغير اللغة». ثم: «ما هو بس العربي… المفروض تدعم كل الأشياء، اللغات المشهورة».
- **السبب الجذري**: إعداد «لغة الإملاء» في الجهازين كان افتراضيه `app` / `Dictation.APP` = «كلغة
  التطبيق»، وكانت الدالة تعطي `ar-SA` إن كانت الواجهة عربية وإلا `en-US` (iOS:
  `DeviceSettings.dictationLocale(app:)`، أندرويد: `DictationLanguage.tag`). واجهة المالك إنجليزية،
  فأُنشئ `SFSpeechRecognizer(locale: en-US)` مهما كانت لوحة المفاتيح. والمركز كان يُرسَل له
  `language` من اللغة نفسها، فيجبر نموذج التحويل على الإنجليزية أيضًا.
- **تجربة الإملاء** (مراجعة فجوات التطبيق القديم، سلوكًا فقط): أندرويد كان يفتح نافذة النظام لجملة
  واحدة، وiOS يقف عند أول نتيجة نهائية. المطلوب شريط تسجيل (إلغاء، مستوى الصوت، إيقاف، إرسال)،
  ونص جزئي حيّ في خانة الكتابة، وإملاء متواصل حتى يضغط الشخص إيقاف.
- **صور الردود** — تطبيقا الجوال يعرضان مرفقات الردود أسماء ملفات؛ الويب يرسمها منذ #154.
- **صوت المركز على الآيفون** — iOS لا يشغّل Ogg فيرجع لصوت الجوال.

## القرار والموافقات
**١) اللغة تلقائية (الافتراضي «تلقائي»)** — مقترح، للمالك أن يؤكد:
- **iOS** (التعرّف بالجوال يأخذ لغة واحدة): بالترتيب: لغة **لوحة المفاتيح النشطة** لخانة الكتابة
  (`textInputMode.primaryLanguage` للمستجيب الأول، تتحدث مع `currentInputModeDidChangeNotification`
  وتُحفظ آخر لغة، فيعمل المايك ولو كانت اللوحة مطوية)، ثم لغة **المحادثة** من حروف آخر ٨ رسائل، ثم
  `Locale.preferredLanguages`، ثم لغة التطبيق. يُطابَق الأول مع `SFSpeechRecognizer.supportedLocales()`
  (المنطقة المعتادة للغة المجردة: `ar`→`ar-SA`، `en`→`en-US`…) ويُتحقق من `isAvailable`، ويُطلب التعرّف
  على الجهاز حين `supportsOnDeviceRecognition`.
- **أندرويد**: لغة **نوع لوحة المفاتيح الحالي** (`getCurrentInputMethodSubtype().languageTag`) بنفس
  البدائل في `EXTRA_LANGUAGE`؛ وفي «تلقائي» على أندرويد ١٣+ يُفعَّل `EXTRA_ENABLE_LANGUAGE_DETECTION`
  مع `EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES` = اللغة الأولى + لغات لوحات المفاتيح + لغات الجوال
  (حتى ١٠)، وعلى ١٤+ `EXTRA_ENABLE_LANGUAGE_SWITCH` (balanced) بنفس القائمة.
- **كشف الكتابة** رخيص ولا يقتصر على العربي/اللاتيني: عربي، لاتيني، سيريلي، ديفاناغري، هان، كانا،
  هانغول، عبري، يوناني، تايلندي؛ وكل كتابة تُحوَّل إلى لغة الجهاز المكتوبة بها (فارسي على جوال فارسي،
  أوكراني على جوال أوكراني…) وإلا الأشهر فيها.
- **المركز** (تسجيل يُرسل لـ`models.transcribe`): في «تلقائي» لا تُرسل لغة، فيكشفها النموذج (العقد:
  «BCP-47 hint; omit for auto-detect»). لم أرسل لغة لوحة المفاتيح لأن `language` عند مزودات Whisper
  يُجبر اللغة ولا يلمّح، فلوحة إنجليزية مع كلام عربي تعيد نفس الخطأ. اللغة المختارة يدويًا تُرسل.
  لا تغيير في الخادم لهذا.
- **ترحيل**: القيمة القديمة `app`/`APP` تُقرأ «تلقائي»؛ `ar`/`en` المختارتان تبقيان كما هما.

**٢) اختيار اللغة خيار إضافي** — مقترح، للمالك أن يؤكد: **الضغط المطوّل على المايك** يفتح قائمة:
«تلقائي» (بعلامة ✓)، ثم لغات لوحات مفاتيح الجهاز، ثم لغات شائعة (الإنجليزية، العربية، الإسبانية،
الفرنسية، الألمانية، الصينية، الهندية، البرتغالية، اليابانية، الروسية، الإيطالية، التركية، الكورية،
الإندونيسية، الأردية، الفارسية)، ثم «لغات أخرى…» قائمة قابلة للبحث بكل ما يدعمه معرّف الجوال
(`SFSpeechRecognizer.supportedLocales()`؛ وفي أندرويد ١٣+ `checkRecognitionSupport`، وقبله كل لغات
الجهاز). ما دام الاختيار ليس «تلقائي» تظهر شارة صغيرة على المايك (`AR`، `FR`…). نفس القائمة في
«هذا الجهاز ← لغة الإملاء». لا لغة مثبتة في الكود كخيار وحيد.

**٣) إملاء متواصل بشريط** — مقترح، للمالك أن يؤكد:
- شريط فوق خانة الكتابة أثناء الإملاء: × إلغاء (يعيد النص كما كان قبل الإملاء)، موجة من مستوى
  الميكروفون، رمز اللغة المسموعة، ■ إيقاف (يُبقي النص)، ↑ إرسال (يوقف ثم يرسل حين تصل الكلمات الأخيرة؛
  ومع المركز بعد انتهاء التحويل). زر الإرسال في الخانة يتصرف مثله أثناء الإملاء.
- الكلمات تظهر في الخانة وهي تُقال، بعد ما كُتب قبل الإملاء.
- **iOS**: مهمة تعرّف واحدة على ميكروفون واحد؛ حين ينهي iOS مقطعًا (توقف أو حد الوقت) يُحفظ ما سُمع
  ويبدأ مقطع جديد على الميكروفون نفسه دون أن يضغط الشخص شيئًا؛ ويُلتقط أيضًا بدء iOS مقطعًا جديدًا من
  تلقاء نفسه بعد توقف (نص أقصر بكثير لا يبدأ بنفس الكلمة). ثلاثة إخفاقات فورية متتالية = «غير متاح».
- **أندرويد**: `SpeechRecognizer` بدل نافذة النظام، مع `EXTRA_PARTIAL_RESULTS`، ويُعاد تشغيله بعد كل
  `onResults`/`ERROR_NO_MATCH`/`ERROR_SPEECH_TIMEOUT` حتى الإيقاف؛ مستوى الصوت من `onRmsChanged`. صار
  يحتاج إذن الميكروفون (نافذة النظام لم تكن تحتاجه) ويُطلب عند أول استعمال.
- مع صوت «كور هب»: تسجيل كما كان، والموجة من `averagePower`/`maxAmplitude`.

**٤) صور الردود داخل الرسالة** (كالويب منذ #154): كتلة `image` تُرسم في الرسالة بعد جلب بايتاتها
بـ`sessions.downloadAttachment` وترويسة الدخول (لا رمز في الرابط)، وحتى تصل تظهر كاسمها. اللمس يفتح
عارضًا بملء الشاشة: iOS بـQuick Look (تكبير، ومشاركة/حفظ)، وأندرويد بنافذة سوداء بتكبير بالقرص
وزر مشاركة. بقية الملفات شرائح باسمها، اللمس يفتحها: iOS بـQuick Look، وأندرويد بالتطبيق المناسب
(`ACTION_VIEW` عبر FileProvider) وإلا ورقة المشاركة. الملفات تُحفظ في ذاكرة التطبيق المؤقتة باسمها
(مجلد لكل مرفق) فلا تُجلب مرتين.

**٥) صيغة صوت المركز** — DECISIONS §91 (مقترح، للمالك أن يؤكد): العقد لم يكن فيه ما يطلب صيغة، فأُضيف
أولًا `SpeechRequest.format` (`SpeechFormat`: `mp3`، `aac`، `wav`، `ogg`) اختياريًا؛ يطلبه المركز من
المزود حيث يستطيع الاختيار (بروتوكول OpenAI: `response_format`، وOgg Opus اسمه `opus`)، وإلا يرجع بصيغة
المزود و`Content-Type` يقول ما جاء. تطبيقا الجوال يطلبان `mp3`. ولم ألمس مزودات الصوت الجديدة (Groq
وغيرها) التي يضيفها وكيل آخر؛ ما تغيّر في المحوّل هو سطر `response_format` في `openai.ts`، ونوع
`SynthesizeRequest.format` الاختياري الذي تقرؤه المحوّلات الجديدة إن شاءت.
- صوت الجوال لقراءة الرد صار بلغة حروف الرد (لا عربي/إنجليزي فقط).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `SpeechRequest.format` (اختياري، `SpeechFormat | null`) ومخطط `SpeechFormat` الجديد؛ `audio/aac`
  بين أنواع ردّ `models.synthesize`؛ وصف العملية يذكر `format`. DECISIONS §91.
- لا عمليات ولا أحداث جديدة. `models.transcribe` كما هو (`language` تلميح اختياري أصلًا).

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml`، `docs/contracts/DECISIONS.md` (§91).
- الخادم: `packages/server/src/modules/models/{index.ts,service.ts}`، `adapters/types.ts`،
  `adapters/openai.ts` (سطر الصيغة)، واختبار في `adapters/adapters.test.ts`.
- iOS: `Phone/DictationLanguage.swift` (جديد، القواعد)، `Phone/KeyboardLanguage.swift` (جديد)،
  `Phone/Dictation.swift` (جديد، الإملاء المتواصل)، `Phone/Voice.swift` (الإعداد، الصيغة، لغة الرد)،
  `Chat/ChatParts.swift` (الخانة، القائمة، الشريط، الموجة)، `Chat/DictationLanguageList.swift` (جديد)،
  `Chat/Attachments.swift` (`MessageAttachments`، `InlineImage`، `AttachmentFiles`)، `Chat/ChatScreen.swift`،
  `Settings/SettingsScreen.swift`، `i18n/{ar,en}.json`، والاختبارات `DictationLanguageTests.swift` (جديد)،
  `PhoneTests.swift`، `AttachmentsVoiceTests.swift`.
- أندرويد: `phone/DictationLanguage.kt` (جديد)، `phone/DictationUi.kt` (جديد)، `phone/Voice.kt`،
  `phone/HubVoice.kt`، `phone/DeviceSettings.kt`، `phone/ThisDevice.kt`، `ui/components/MessageFiles.kt`
  (جديد)، `ui/components/ChatParts.kt`، `ui/screens/{ChatScreen,ChatViewModel}.kt`، `chat/ChatReducer.kt`،
  `res/values{,-ar}/strings.xml`، `res/xml/update_paths.xml`، والاختبارات `DictationLanguageTest.kt` (جديد)،
  `PhoneTest.kt`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (عبر `mj-run`؛ لا Java ولا Xcode على هذه الآلة، فـSwift وKotlin يُبنيان ويُختبران في CI):

```
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
You have 1 warning.          ← موجود قبل التغيير (سطر 6853، مثال لا يطابق مخططه)
contracts:lint  OK
$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  375 passed (375)
$ pnpm contracts:check-clients
check-clients  OK — 638 client file(s) scanned, 231 contract path(s) known.
$ pnpm --filter @corehub/server exec vitest run src/modules/models/adapters/adapters.test.ts src/modules/models/speech-api.test.ts
 Test Files  2 passed (2)
      Tests  29 passed (29)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck        → خرج بـ0
$ pnpm i18n:check
i18n:check  ios: 359 keys, ar/en in parity
i18n:check  OK
```

CI على الفرع نفسه (`workflow_dispatch`، قبل الدمج في فرع الليلة):

```
iOS      run 36206906889  success  — Executed 114 tests, with 0 failures; منها
         DictationLanguageTests (10 اختبارات)، PhoneTests.testTheOldSameAsTheAppChoiceBecomesAuto،
         AttachmentTests.testAReplysPictureIsDrawnAndItsOtherFilesAreNamed،
         VoiceSourceTests.testTheHubIsAskedForSpeechTheIPhonePlaysInTheRepliesOwnLanguage — passed؛
         لا تحذيرات isolation/Sendable. (المحاولة الأولى 36206387421 فشلت بخطأ ترجمة في
         KeyboardLanguage.swift، أُصلح.)
Android  run 36206880647  success  — ./gradlew assembleDebug test lint: :app:testDebugUnitTest و:app:lint
         نجحا، BUILD SUCCESSFUL in 4m 30s (منها DictationLanguageTest الجديد وPhoneTest المحدّث).
```

بعد دمج `origin/night/2026-09-27` في الفرع (§87–§90 أخذتها مهام أخرى، فصار قرار الصيغة §91):

```
$ pnpm contracts:lint            → contracts:lint  OK
$ pnpm contract:test             → Test Files  19 passed (19) · Tests  380 passed (380)
$ pnpm lint                      → All matched files use Prettier code style!
$ pnpm typecheck                 → خرج بـ0
$ pnpm i18n:check                → i18n:check  OK
$ pnpm change-record:check       → change-record  OK — 4 record(s) valid
$ pnpm contracts:check-clients   → check-clients  OK — 659 client file(s) scanned, 235 contract path(s) known.
$ vitest run adapters.test.ts speech-api.test.ts → Test Files  2 passed (2) · Tests  29 passed (29)
```

CI على طلب الليلة #165 (الرأس `98d73b31`، بعد دمج هذه المهمة في `2e74323a` ثم مهام أخرى):

```
Android build, unit tests, lint          pass
Build and test on the iOS simulator      pass
Generate the Swift client (CoreHubClient) pass
Lint, typecheck, contracts, client tests, build  pass
Web smoke journeys                       pass
Server unit tests (shard 1/3, 2/3)       pass
Server unit tests (shard 3/3)            fail — tests/unit/profile-transfer-providers.test.ts
                                         (expected 4 to be 2): ينجح على 2e74323a (هذه المهمة)
                                         وعلى d09bd987، ويفشل بعد دمج feat/voice-providers
                                         (41376ec3) — ليس من هذه المهمة؛ أُبلغ عنه.
```

اختبار المالك نفسه (`testAutoListensInTheKeyboardsLanguageNotTheAppsLanguage` / «Auto listens in the
keyboard's language, not the app's») يفشل على الكود القديم: القديم لا يعرف لوحة المفاتيح ويعطي
`en-US` لواجهة إنجليزية. ولم يُجرَّب شيء على جهاز حقيقي.

## المخاطر والرجوع
- **iOS قد يبدأ مقطعًا جديدًا بنفسه** بعد توقف طويل على بعض الإصدارات؛ الكشف تقريبي (نص أقصر من النصف
  لا يبدأ بالكلمة نفسها). إن أخطأ، قد تتكرر كلمات أو تسقط في حالات نادرة. يحتاج تجربة المالك على جهازه.
- **أندرويد**: إعادة تشغيل المعرّف بين المقاطع قد تُسمع نغمة البدء على بعض الأجهزة؛ وكشف اللغة/تبديلها
  يعتمد على المعرّف (غالبًا على الجهاز) وقد لا يؤثر. أما اللغة الأولى فهي لغة لوحة المفاتيح دائمًا.
- لوحات مفاتيح أندرويد التي لا تذكر لغتها في النوع (أو «الكتابة متعددة اللغات») تسقط إلى المحادثة
  ثم لغات الجوال.
- الإذن: أندرويد صار يطلب إذن الميكروفون للإملاء بالجوال.
- الرجوع: استرجاع دمج هذا الفرع؛ الحقل `format` اختياري فحذفه لا يكسر عميلًا لا يرسله.

## التسليم والخطوة التالية
- يُدمج في `night/2026-09-27` (طلب #165)، بلا طلب دمج خاص.
- المالك يجرّب على الآيفون: لوحة عربية وواجهة إنجليزية → يُسمع عربي؛ الضغط المطوّل واختيار لغة؛
  الإملاء المتواصل مع التوقفات؛ صورة في رد؛ «قراءة الردود» بصوت المركز.
- للوكيل الذي يضيف مزودات الصوت: المحوّلات الجديدة تقرأ `SynthesizeRequest.format` حيث يدعم المزود
  اختيار الصيغة.
