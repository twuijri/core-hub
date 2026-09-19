# أندرويد: الإملاء مقيَّد بلغة الهاتف، والتحقق من مزوّد الصوت المنطوق

المسؤول: twuijri
الفرع: feat/android-speech-language (من `origin/mobile`)
الحالة: review — بلا دفع وبلا PR

## المشكلة والهدف

### (١) الإملاء يتبع لغة التطبيق دائمًا — وهي المهمة الأساسية
هاتف المالك وتطبيقه بالإنجليزية، وهو يتكلّم العربية، فالميكروفون يفرّغ كلامًا
إنجليزيًا بلا معنى. وهو محقّ في ملاحظته أن تطبيقات أخرى تفرّغ عربيّته على
الهاتف الإنجليزي نفسه.

الهدف: أن تصبح لغة الإملاء تفضيلًا مستقلًّا لكل ملف، بثلاثة خيارات (اتّباع لغة
التطبيق، لغة محدّدة، اكتشاف تلقائي)، مع قائمة لغات حقيقية يبلّغ عنها الجهاز،
وتبديل سريع من الميكروفون.

### (٢) التحقق من مزوّد الرد المنطوق
المالك سمع صوت Grok العربي على iOS وصوت OpenAI على أندرويد للسؤال نفسه، على
نسخ سابقة للإصلاح الموجود في هذا الفرع. المطلوب التحقق — لا إعادة تصميم — من
أن الملف المستخدَم في نداء التركيب هو الملف نفسه الذي تجري عليه المحادثة.

خارج النطاق: `clients/ios` (لم يُلمَس، صفر ملفات معدّلة)، والسيرفر، وعميل الويب.

## تصحيح من المالك أثناء العمل (مُطبَّق)
الصياغة الأولى للمهمة كانت توجّه «الاكتشاف التلقائي» إلى نقطة التفريغ في
السيرفر. اعترض المالك: لا داعي لأن يسافر الصوت إلى خادمه ويعود لمجرّد معرفة
اللغة، ونحن أصلًا نستخدم محرّك جوجل داخل الجهاز. الاعتراض صحيح، وقد أُعيد بناء
المسار ليكون الاكتشاف **داخل الجهاز**، ولم يبقَ السيرفر إلا بديلًا صريحًا
موسومًا لجهاز لا يستطيع محرّكه الاكتشاف.

## السبب الجذري (مُتحقَّق منه في الشيفرة)
1. `AppViewModel.startDeviceListening` كان يمرّر
   `localized.resources.configuration.locales[0].toLanguageTag()` إلى
   `SpeechInput.start`، أي أن التعرّف داخل الجهاز يتبع لغة التطبيق دائمًا بلا
   أي وسيلة لتجاوزها.
2. مسار السيرفر كان يرسل `locales[0].language` تلميحًا، بالمنطق نفسه.

## ما تحقّقتُ منه في السيرفر قبل أي وعد
قراءة مباشرة في `packages/server`، وهي مهمة لأنها تنقض افتراضًا سهلًا:

- `POST /api/studio/stt/transcribe`
  (`packages/server/src/modules/studio/controllers/stt.ts:598`) لا يقرأ حقل
  `language` إطلاقًا: `grep -c language controllers/stt.ts` = **٠**. الحقلان
  الوحيدان المقروءان هما `provider` (إلزامي،
  `resolveStoredProvider` سطر ٤٨٤) و`audio` (إلزامي، `findAudioPart`).
- اللغة الفعلية تأتي من إعدادات المزوّد المخزَّنة للملف
  (`runtimeSetting.settings`)، ومثالها
  `services/voice/stt/openai.ts:133` حيث لا يُضاف `language` إلى الطلب الأعلى
  إلا إذا كان مخزَّنًا — أي أن الخانة الفارغة هي وحدها التي تجعل المزوّد يكتشف
  اللغة بنفسه.
- `resolveSttProfileStatus` (`controllers/stt.ts:89`) يعيد
  `{profile, configured, activeProvider, reason}` ولا يقول شيئًا عن اللغة.

الخلاصة: **لا يمكن الوعد بالاكتشاف من جهة السيرفر** اعتمادًا على إرسال طلب بلا
تلميح، لأن التلميح مُهمَل أصلًا واللغة محسومة بما هو مخزَّن في الملف. وهذا سبب
تقني إضافي يدعم تصحيح المالك: الاكتشاف يجب أن يكون داخل الجهاز.

## ما تحقّقتُ منه في SDK أندرويد (وليس افتراضًا)
من `~/Android/Sdk/platforms/android-35/data/api-versions.xml` و`javap` على
`android.jar`:

| العنصر | المستوى |
| --- | --- |
| `EXTRA_ENABLE_LANGUAGE_DETECTION` | ٣٤ |
| `EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES` | ٣٤ |
| `EXTRA_ENABLE_LANGUAGE_SWITCH` و`LANGUAGE_SWITCH_BALANCED` | ٣٤ |
| `EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES` | ٣٤ |
| `RecognitionListener.onLanguageDetection(Bundle)` | ٣٤ |
| `SpeechRecognizer.DETECTED_LANGUAGE` و`LANGUAGE_DETECTION_CONFIDENCE_LEVEL` | ٣٤ |
| `EXTRA_LANGUAGE_SWITCH_MAX_SWITCHES` | ٣٥ |
| `SpeechRecognizer.checkRecognitionSupport` و`RecognitionSupport` | ٣٣ |
| `ACTION_GET_LANGUAGE_DETAILS` و`EXTRA_SUPPORTED_LANGUAGES` | ٨ |

و`minSdk` في هذا المشروع = ٢٦، فكل ما فوق ٢٦ مُسيَّج بـ`Build.VERSION.SDK_INT`.
قيم الثقة: `UNKNOWN=0, NOT_CONFIDENT=1, CONFIDENT=2, HIGHLY_CONFIDENT=3`.

## القرار والتصميم
- **التفضيل**: `Store.speechLanguage(profile)` بثلاث قيم: `""` (اتّباع لغة
  التطبيق، وهو الافتراضي والسلوك القديم بالضبط)، `"auto"`، أو وسم BCP-47.
  محفوظ لكل ملف لأن Core Hub يخزّن إعدادات الصوت لكل ملف.
- **قائمة اللغات**: `SpeechRecognizer.checkRecognitionSupport` على أندرويد ١٣+
  (وهو المصدر الأدقّ لأنه يفصل النماذج المثبَّتة فعلًا عن التي يمكن جلبها)،
  وإلا بثّ `ACTION_GET_LANGUAGE_DETAILS`. تُعرض بأسمائها الذاتية (endonym).
  إن لم يُجب الجهاز بشيء تُعرض قائمة مُنسَّقة قصيرة **موسومة صراحةً بأنها غير
  مؤكَّدة**. لا يُضاف أبدًا ما لم يبلّغ عنه الجهاز — حتى لغة المحرّك المفضّلة
  تُرفَع إلى الأعلى ولا تُضاف.
- **الاكتشاف التلقائي داخل الجهاز**: `EXTRA_ENABLE_LANGUAGE_DETECTION` مع
  `EXTRA_ENABLE_LANGUAGE_SWITCH = balanced` وقائمة مسموحات = (لغات التطبيق
  المشحونة + لغة الهاتف + اختيار المالك) ∩ (ما أبلغ عنه المحرّك)، بحد أقصى ٥.
  ليست قائمة عربية مثبّتة في الشيفرة: العربية تدخل لأن التطبيق يشحن العربية.
- **الصدق عند العجز**: `DetectionSupport.usable` يشترط ثلاثة أمور معًا — المستوى
  ٣٤+، وأن يكون المحرّك قد أجاب فعلًا، وأن تكون المسموحات لغتين على الأقل. وإن
  اختلّ أيٌّ منها يعود المسار إلى لغة التطبيق **مع تنبيه يسمّيها**، ولا يُفرَّغ
  الكلام بلغة خاطئة في صمت. وكذلك: لا يُعلَن عن لغة مكتشَفة إلا إذا وصف
  المحرّك نفسه ثقته بأنها `CONFIDENT` فأعلى.
- **تبديل سريع**: ضغط مطوّل على زر الميكروفون يفتح القائمة نفسها
  (`combinedClickable` + دلالة `onLongClick` لقارئ الشاشة)، وصف التسجيل يعرض
  لغة اللقطة الجارية.
- **مسار السيرفر**: باقٍ كبديل صريح في الإعدادات. التلميح لا يزال يُرسَل (فهو
  الحقل الموثَّق والويب ترسله)، لكن ورقة اللغة تقول صراحةً إن الخادم يفرّغ
  بلغة مزوّد STT المخزَّنة للملف، فلا يُوعَد المالك بما لا يحدث.
- **قاعدة الملف الواحدة** (القضية ٢): `ProfileScope.of(sessionProfile, activeProfile)`
  و`UiState.chatProfile`.

## نتيجة التحقق من القضية (٢)
الكود الذي هبط في هذا الفرع سليم في جوهره: `speakText(finalReply, key, profile)`
يستخدم متغيّر `profile` الخاص بنفس التشغيل، و`api.synthesize/ttsSettings`
يمرّران الملف في ترويسة `X-Hermes-Profile`، والاختيار مخزَّن لكل ملف
(`Store.voiceOutput`) وذاكرة الإعدادات `voiceSettingsCache` مفهرسة بالملف. لكن
وُجدت ثلاث فجوات حقيقية أُصلحت دون إعادة تصميم:

1. **`ConversationScreen`** كان يكتب
   `state.openSession?.profile ?: state.activeProfile` ثم `.ifBlank { "default" }`،
   فجلسة تحمل ملفًا نصًّا فارغًا (لا `null`) كانت تقفز فوق الملف النشط إلى
   `default` — أي تطلب صوت ملف آخر. صار يستعمل `state.chatProfile`.
2. **`MainActivity`** كان يعيد قراءة إعدادات الصوت عند تغيّر
   `state.activeProfile` فقط، بينما فتح محادثة تابعة لملف آخر يغيّر ملف
   المحادثة دون أن يتحرّك الملف النشط — فيبقى قسم «الصوت» يسرد مزوّدات الملف
   السابق. صار المفتاح `state.chatProfile`.
3. **`api.transcribe`** كان ينفرد بإرسال الملف في `?profile=` فقط دون ترويسة
   `X-Hermes-Profile`، خلافًا لبقية نداءات الصوت. صار يرسل الاثنين.

هذه الفجوات تفسّر بدقّة الشكل الذي وصفه المالك: جهازان على المحادثة نفسها
يحلّان ملفين مختلفين، فيسمع كلٌّ منهما صوتًا آخر.

## الملفات والتأثير
جديد:
- `clients/android/app/src/main/java/us/i3u/hermesstudio/SpeechLanguage.kt`
  (التفضيل، تسوية الوسوم، تحليل قائمة الجهاز، قاعدة اختيار مسار اللقطة
  `SpeechPlan`، مرشّحو الاكتشاف، الأسماء الذاتية، عزل الاتجاه ثنائي اللغة).
- `clients/android/app/src/main/java/us/i3u/hermesstudio/ProfileScope.kt`
  (قاعدة الملف الواحدة).
- `clients/android/app/src/test/java/us/i3u/hermesstudio/SpeechLanguageTest.kt`
  (٢٢ اختبارًا).
- `clients/android/app/src/test/java/us/i3u/hermesstudio/SpeechRequestTest.kt`
  (٦ اختبارات على `MockWebServer`: وصول حقل `language`، وغيابه التام عند عدم
  وجود لغة، والفحص المسبق لحالة الملف).
- `clients/android/app/src/test/java/us/i3u/hermesstudio/ProfileScopeTest.kt`
  (١٠ اختبارات: القاعدة نفسها، وحرّاس على مستوى المصدر تمنع تكرارها).
- `docs/changes/2026-09-19-twuijri-android-speech-language.md` (هذا الملف).

معدّل:
- `SpeechInput.kt`: `start(languageTag, detectAmong, listener)`،
  `onLanguageDetected`، `recognitionIntent` مع إضافات الاكتشاف والتبديل مسيَّجة
  بالمستوى، و`queryLanguages` بمصدرَيها.
- `AppViewModel.kt`: حقول `speechLanguage`/`speechLanguages`/`speechDetection`/
  `takeLanguage`/`takeDetecting`/`detectedLanguage`، و`setSpeechLanguage`،
  و`loadSpeechLanguages`، و`detectionWishlist`، وإعادة كتابة `startVoiceInput`
  حول `SpeechLanguages.plan`، و`UiState.chatProfile`.
- `Store.kt`: `speechLanguage(profile)` / `setSpeechLanguage(profile, value)`.
- `HermesApi.kt`: `transcribe` صار يرسل ترويسة الملف أيضًا.
- `MainActivity.kt`: صف «لغة الإملاء» وملاحظته، ومفتاح إعادة التحميل.
- `ui/chat/Composer.kt`: ورقة اللغة المشتركة، الضغط المطوّل على الميكروفون،
  وسطر لغة اللقطة تحت حالة التسجيل.
- `ui/chat/ConversationScreen.kt`: استعمال `chatProfile`.
- `AndroidManifest.xml`: عنصر `<queries>` — بدونه يصير محرّك النطق غير مرئي
  على أندرويد ١١+ فتعود كل الاستعلامات فارغة وتسقط القائمة إلى التخمين.
- `values/strings.xml` و`values-ar/strings.xml`: ٢٠ سلسلة جديدة في اللغتين.
- `tools/mock-studio.py`: `GET /api/studio/stt/profile-status`،
  `GET /api/studio/stt/settings`، و`POST /api/studio/stt/transcribe` تُحاكي
  العقد الحقيقي (تقرأ `provider` و`audio` فقط، وتُرجع `mockReceivedLanguage`
  لإثبات أن التلميح وصل ثم أُهمل).
- `clients/android/README.md`.
- `MockStudioVoiceTest.kt`: اختباران إضافيان للإملاء.

لا تغيير خارج `clients/android` و`docs/`، ولا مساس بـ`clients/ios` ولا
بالسيرفر ولا بعميل الويب ولا بالرخصة أو حارسها.

## الفحوص (مُنفَّذة فعلًا)
```
JAVA_HOME=…/jdk17 ANDROID_HOME=…/Android/Sdk gradle --offline \
  clean testDebugUnitTest assembleDebug  → BUILD SUCCESSFUL in 18s
                                            (44 actionable tasks: 44 executed)
tests=265 skipped=0 failures=0 errors=0   (كانت 225 قبل هذا العمل، +40)
  SpeechLanguageTest   22/0/0
  SpeechRequestTest     6/0/0
  ProfileScopeTest     10/0/0
  MockStudioVoiceTest   8/0/0  (لم يُتخطَّ أيٌّ منها؛ الخادم الوهمي شُغِّل فعلًا)
app/build/outputs/apk/debug/app-debug.apk  24,286,729 بايت
```
(Gradle 8.11.1 من توزيع wrapper في `~/.gradle`، JDK 17، SDK 35، minSdk 26.)

`TranslationsTest` و`RtlTest` مرّا، أي أن الملفين متطابقان في المفاتيح
والعناصر النائبة، ولا يوجد `left/right` مادي في الشيفرة الجديدة.

## لم يُتحقق (يحتاج جهازًا أو سيرفر المالك)
- **سلوك محرّك النطق الحقيقي**: لا شيء من `checkRecognitionSupport` ولا
  `onLanguageDetection` ولا بثّ `ACTION_GET_LANGUAGE_DETAILS` يعمل في اختبارات
  JVM. المنطق النقي مُختبَر بالكامل، والطبقة الملاصقة لأندرويد لا. تحديدًا لم
  يُتحقق: أي لغات سيسردها هاتف المالك، وهل يقبل محرّكه إضافات الاكتشاف فعلًا،
  وهل يبلّغ بثقة `CONFIDENT` فأعلى.
- **نسخة أندرويد جهاز المالك**: إن كانت أقل من ١٤ فخيار «اكتشاف تلقائي» سيظهر
  مع سبب العجز في وصفه، ولن يعمل — واختيار «العربية» صراحةً هو الحل عنده حينها،
  وهو يحلّ الشكوى الأصلية كاملةً على أي حال.
- **ما هو مخزَّن فعلًا على سيرفره**: أي مزوّد STT نشط وهل فيه `language`
  مخزَّنة (وهي التي تحسم تفريغ مسار السيرفر)، وأي مزوّدات TTS مضبوطة لكل ملف —
  وهذا الأخير هو ما سيحسم نهائيًا سبب اختلاف الصوت بين جهازيه.
- **هل كان الجهازان على ملفين مختلفين فعلًا**: الفجوات الثلاث أعلاه تفسّر ذلك
  تفسيرًا كافيًا، لكن إثباتها يحتاج تكرار الحالة على جهازيه بعد هذه النسخة.
- تشغيل صوت حقيقي عبر `MediaPlayer`، ولم يُشغَّل CI (لا دفع).

## المخاطر والرجوع
- الافتراضي لم يتغيّر: ملف لم يُضبط فيه شيء يملي بلغة التطبيق تمامًا كما كان.
- نداء إضافي واحد لمحرّك النطق المحلي عند أول فتح للشاشة (لا شبكة فيه).
- `<queries>` يوسّع رؤية الحزم لمحرّك النطق فقط، وهو مطلوب لعمل الميزة.
- الرجوع: إعادة الفرع إلى `origin/mobile`.

## التسليم والخطوة التالية
التزام واحد على `feat/android-speech-language` محليًا، بلا دفع وبلا PR.
الخطوة التالية للمالك: تثبيت نسخة debug، فتح الإعدادات ← لغة الإملاء ورؤية ما
يسرده جهازه فعلًا (وهل «اكتشاف تلقائي» متاح أم معه سبب عجز)، ثم تجربة الضغط
المطوّل على الميكروفون واختيار العربية والتحدّث. وللقضية الثانية: تكرار السؤال
نفسه على الجهازين بعد هذه النسخة، والإبلاغ عن اسم الملف الظاهر في كلٍّ منهما.
