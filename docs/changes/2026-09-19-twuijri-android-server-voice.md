# أندرويد: زر «استمع» يسقط إلى صوت الجهاز رغم وجود مزوّد عربي في Core Hub

المسؤول: twuijri
الفرع: fix/android-server-voice (من `origin/mobile`)
الحالة: review

## المشكلة والهدف
المالك يضغط زر «استمع» تحت رد المحادثة في تطبيق أندرويد فيظهر التنبيه:

> Server voice unavailable (The voice reply could not be played. Check the TTS
> provider in Studio.); using the device voice instead.

بينما المزوّد العربي نفسه يعمل في عميل الويب على الملف نفسه.

الهدف: أن يطلب الهاتف الصوت من المزوّد الذي ضبطه المالك تحديدًا لا أن يترك
السيرفر يخمّن، وأن يقول التنبيه أي مزوّد فشل ولماذا، وأن يستطيع المالك رؤية
المزوّدات وتغييرها من التطبيق. خارج النطاق: `clients/ios`، وأي تغيير في
السيرفر أو عميل الويب.

## السبب الجذري (مُتحقَّق منه في الشيفرة)
1. `HermesApi.synthesize` في أندرويد كان يرسل
   `POST /api/studio/tts/synthesize` بجسم `{text, options:{}}` فقط — بلا
   `provider` وبلا خيارات.
2. عندها يشتغل `resolveActiveTtsProvider` في
   `packages/server/src/modules/studio/controllers/tts.ts` (سطر ٩٨):
   يعيد المزوّد النشط المخزَّن للملف، وإلا المزوّد الوحيد المضبوط غير `edge`،
   وإلا **`edge`** — وهو صوت مايكروسوفت المجاني. فإذا لم يكن للملف مزوّد نشط
   مخزَّن وكان فيه أكثر من مزوّد، يذهب الطلب إلى `edge`، و`edge` يفشل على
   سيرفر المالك.
3. الويب لا يعتمد على ذلك أبدًا: `MessageItem.vue → handleSpeechToggle` يمرّر
   `provider` صراحةً مع خيارات ذلك المزوّد إلى `useSpeech.openaiToggle` ثم إلى
   `synthesizeSpeech`، والقيم تأتي من `useVoiceSettings` الذي يقرأ
   `GET /api/studio/tts/settings` (`settings` + `activeProvider`). لذلك يعمل في
   المتصفح ولا يعمل في الهاتف.
4. عطل ثانٍ منفصل في الإبلاغ: عند رد غير ناجح كان أندرويد يرمي
   `HermesException("HTTP ${code}")` ويُهمل جسم `{error, detail}` تمامًا، فلا
   يصل إلى المالك أي سبب. كما أن نص التنبيه الذي اقتبسه المالك
   (`voice_playback_failed`) يأتي من مسار `MediaPlayer` لا من مسار خطأ السيرفر،
   أي أنه في حالته وصلت بايتات لم يستطع المشغّل قراءتها — ولم يكن في الرسالة
   ما يدل على المزوّد الذي أنتجها. الآن يُذكر المزوّد في المسارين.

ملاحظة تحقّق: رمز التطبيق (`app_access`) يضبط `ctx.state.user` فعليًا في
`middleware/auth.ts`، فمعرّف المستخدم موجود؛ أي أن الفرع `!userId → 'edge'`
ليس هو السبب، والسبب هو غياب `provider` مع قاعدة الاحتياط `edge`.

## القرار والموافقات
- مطابقة الويب: التطبيق يقرأ إعدادات الملف ويرسل `provider` وخياراته المخزَّنة
  في كل نداء. لا تُرسل `apiKey` أبدًا (المفتاح يبقى في `secrets` على السيرفر)
  ولا تُرسل قيمة فارغة تلغي إعدادًا مخزَّنًا.
- عند غياب اختيار المالك، يُحاكي التطبيق قاعدة السيرفر نفسها
  (`activeProvider` ← المزوّد الوحيد غير `edge` ← `edge`) ويسمّيها صراحةً، بدل
  إرسال طلب بلا اسم. هذا يجعل ما يجري مرئيًا وقابلًا للتسمية عند الفشل.
- `PUT /api/studio/tts/settings/active` **لا يُكتب إلا** حين يختار المالك
  مزوّد سيرفر من شاشة الإعدادات صراحةً. قراءة رد بصوت مسموع لا تكتب شيئًا.
- الاختيار يُحفظ لكل ملف على حدة (`Store.voiceOutput`)، لأن Core Hub يخزّن
  إعدادات TTS لكل ملف.
- لا دفع ولا PR ولا دمج من المساعد؛ الفرع محلي بانتظار مراجعة المالك.

## الملفات والتأثير
جديد:
- `clients/android/app/src/main/java/us/i3u/hermesstudio/VoiceOutput.kt`
  (نماذج المزوّدات، تحليل غلاف الإعدادات، قاعدة اختيار المزوّد، الأسماء).
- `clients/android/app/src/test/java/us/i3u/hermesstudio/VoiceOutputTest.kt`
  (٩ اختبارات: التحليل والاختيار وحالات الاحتياط).
- `clients/android/app/src/test/java/us/i3u/hermesstudio/VoiceSynthesisTest.kt`
  (٩ اختبارات على `MockWebServer`: جسم الطلب، إسقاط المفتاح والقيم الفارغة،
  ‏5xx و«JSON بحالة 200» والجسم غير JSON والرد الفارغ، قراءة الإعدادات،
  كتابة المزوّد النشط مرة واحدة).
- `clients/android/app/src/test/java/us/i3u/hermesstudio/MockStudioVoiceTest.kt`
  (٦ اختبارات تشغّل `tools/mock-studio.py` كعملية حقيقية وتقود `HermesApi`
  الفعلي عليها؛ تُتخطّى إن لم يوجد python3).
- `docs/changes/2026-09-19-twuijri-android-server-voice.md` (هذا الملف).

معدّل:
- `HermesApi.kt`: `synthesize(profile, text, provider, options)`،
  `ttsSettings(profile)`، `setActiveTtsProvider(profile, provider)`،
  `ttsErrorDetail` (يضمّ `error` و`detail` مثل `readTtsError` في الويب)،
  `TtsSynthesisException(provider, statusCode, code, message)` بأكواد
  `tts_http_error` / `tts_not_audio` / `tts_empty_audio`، و`SynthesizedAudio`
  صار يحمل `provider` و`engine` من ترويستي `X-TTS-Provider` و`X-TTS-Engine`.
- `AppViewModel.kt`: حقول `voiceOutput` و`voiceSettings` و`loadingVoiceSettings`
  و`voiceSettingsError` في `UiState`، و`loadVoiceSettings` و`setVoiceOutput`،
  وذاكرة إعدادات لكل ملف تُمسح عند تسجيل الخروج، و`speakText` يحلّ المزوّد ثم
  يسمّيه، و`voiceFailureReason` يبني نص التنبيه، و`speakOnDevice` صار سببه
  اختياريًا (اختيار المالك لصوت الجهاز ليس عطلًا ولا يستحق تنبيهًا).
- `Store.kt`: `voiceOutput(profile)` / `setVoiceOutput(profile, value)`.
- `MainActivity.kt` (`DeviceSettings`): صف «الصوت» وورقة اختياره وتحميل
  الإعدادات عند تغيّر الملف.
- `ui/chat/Composer.kt`: `voiceOutputLabel` و`voiceOutputRows`.
- `values/strings.xml` و`values-ar/strings.xml`: ١٥ سلسلة جديدة في اللغتين.
- `tools/mock-studio.py`: `GET /api/studio/tts/settings`،
  `PUT /api/studio/tts/settings/active`، و`POST /api/studio/tts/synthesize`
  بأربعة مخارج (بلا مزوّد أو `edge` ← 502، `groq` ← JSON بحالة 200،
  `gemini` ← 400، `elevenlabs` ← بايتات WAV حقيقية)، ومنفذ من سطر الأوامر.
- `clients/android/README.md`.

لا تغيير خارج `clients/android` و`docs/`، ولا مساس بـ `clients/ios` ولا
بالسيرفر ولا بعميل الويب ولا بالرخصة أو حارسها.

## الفحوص
```
JAVA_HOME=…/jdk17 ANDROID_HOME=…/Android/Sdk gradle --offline \
  clean testDebugUnitTest assembleDebug  → BUILD SUCCESSFUL in 18s
                                           (44 actionable tasks: 44 executed)
tests=225 skipped=0 failures=0 errors=0  (كانت 201 قبل هذا العمل)
app/build/outputs/apk/debug/app-debug.apk  24,241,937 بايت
```
(Gradle 8.11.1 من توزيع wrapper في `~/.gradle`، JDK 17، SDK 35.)

الاختبارات الستة في `MockStudioVoiceTest` عملت فعلًا ولم تُتخطَّ
(`skipped="0"` في تقريرها)، أي أن الخادم الوهمي شُغِّل و`HermesApi` تحدّث معه.

## لم يُتحقق (يحتاج سيرفر المالك)
- أي المزوّدات مضبوط فعلًا على الملف، وهل `activeProvider` مخزَّن أم لا.
  هذا ما سيحسم أي فرع من `resolveActiveTtsProvider` كان يعمل عنده.
- هل يفشل `edge` على سيرفره بـ 502 أم يعيد بايتات لا يقرؤها `MediaPlayer`.
  التنبيه الجديد سيقول ذلك حرفيًا مع اسم المزوّد والحالة ونص الخطأ.
- تشغيل الصوت الحقيقي على جهاز: `MediaPlayer` مع الصيغة التي يعيدها مزوّده
  (لا يمكن تشغيله في اختبارات JVM).
- كتابة `PUT /api/studio/tts/settings/active` على سيرفر حقيقي ومزامنتها إلى
  ملف Hermes عبر `syncVoiceConfigToHermesProfile`.
- لم يُشغَّل CI (لا دفع).

## المخاطر والرجوع
- سلوكي: صار التطبيق يقرأ `GET /api/studio/tts/settings` مرة لكل ملف قبل أول
  نطق؛ نداء إضافي واحد. لو رفضه السيرفر (401 مثلًا) يظهر التنبيه
  «تعذّرت قراءة إعدادات الصوت» ويبقى صوت الجهاز احتياطًا كما كان.
- التطبيق صار يسمّي `edge` صراحةً حين لا يكون هناك اختيار ولا مزوّد نشط، وهو
  ما كان السيرفر يفعله ضمنيًا؛ السلوك نفسه لكنه مرئي الآن.
- الاحتياط إلى صوت الجهاز لم يُزَل، وزر «استمع» لا يصمت في أي حالة.
- الرجوع: إعادة الفرع إلى `origin/mobile`.

## التسليم والخطوة التالية
التزام واحد على `fix/android-server-voice` محليًا، بلا دفع. الخطوة التالية
للمالك: تثبيت نسخة debug على الهاتف، فتح الإعدادات ← الصوت ورؤية ما يسرده
السيرفر، ثم الضغط على «استمع». إن بقي الفشل فالتنبيه سيسمّي المزوّد والحالة
ونص الخطأ، وهو ما ينقص اليوم لتحديد ما إذا كان العطل في `edge` أم في صيغة
صوت المزوّد العربي.
