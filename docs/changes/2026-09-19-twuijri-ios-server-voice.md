# iOS: زر النطق يستخدم صوت الخادم العربي بدل صوت الجهاز

المسؤول: twuijri
الفرع: fix/ios-server-voice (من `origin/mobile`)
الحالة: review

## المشكلة والهدف
أبلغ المالك أن زر «النطق» في المحادثة على iOS ينطق بصوت الجهاز بدل الصوت
العربي الذي هيّأه على الخادم، بينما الويب ينطق بالصوت الصحيح. نفس العطل
أُبلغ على أندرويد.

### السبب الجذري المتحقَّق منه على iOS
- `clients/ios/HermesStudio/Core/APIClient.swift` كان يرسل إلى
  `POST /api/studio/tts/synthesize` جسمًا فيه `text` و`options` فارغة فقط،
  **بلا `provider`**.
- الخادم في `packages/server/src/modules/studio/controllers/tts.ts`
  (`synthesize`، والسطر ٤٧٧ تحديدًا) يستدعي حينها `resolveActiveTtsProvider`،
  وهذه ترجع `edge` (صوت مايكروسوفت المجاني) ما لم يكن للبروفايل مزوّد مفعّل
  مخزَّن، أو ما لم يكن هناك مزوّد واحد مهيّأ غير `edge`.
- الويب لا يترك القرار للخادم: `useVoiceSettings.ts` يحمّل
  `GET /api/studio/tts/settings` (`settings` + `activeProvider`)، و
  `useSpeech.ts` (عبر `MessageItem.vue`) يرسل `provider` وخيارات المزوّد
  المخزّنة صراحةً. لذلك ينطق المتصفح بالصوت الصحيح والهاتف لا.
- ثانيًا: `MessageSpeaker` كان يبتلع أي فشل ويتحوّل إلى
  `AVSpeechSynthesizer` بصمت، فلا يرى المالك أن صوت الخادم فشل ولا لماذا.

هذا تفسير للسلوك المُبلَّغ؛ **لم يُختبر على سيرفر المالك**، فقد يكون السبب
الفعلي عنده أن البروفايل بلا `activeProvider` مخزَّن أصلًا (وهو ما تعالجه
شاشة الإعدادات الجديدة).

خارج النطاق: `clients/android` (لم يُمسّ)، وأي تغيير في الخادم أو الويب.

## القرار والموافقات
- الموافقة: تكليف المالك بإصلاح هذا العطل على iOS مع شاشة إعدادات ظاهرة.
- القرارات:
  1. **مطابقة الويب حرفيًا**: تحميل إعدادات TTS للبروفايل وإرسال `provider`
     مع خيارات المزوّد المخزّنة في كل نداء نطق، وقراءة `X-TTS-Provider` و
     `X-TTS-Engine` من الرد.
  2. **لا يُرسَل المفتاح السري أبدًا**: نقطة الإعدادات ترجع `apiKey` كعلامة
     `[stored]` فقط، وهي وقائمة `baseUrlPresets` تُستبعدان من الخيارات.
     القيم الفارغة تُسقَط لأن `mergeStoredTtsOptions` في الخادم تعتبر الخيار
     الموجود الفارغ تجاوزًا للقيمة المخزّنة.
  3. **الافتراضي هو صوت البروفايل**: عدم وجود اختيار محلي = اتّبع
     `activeProvider` للبروفايل، تمامًا كالويب. صوت الجهاز لا يعمل إلا
     باختيار صريح أو عند فشل صوت الخادم. قرار M1 (صوت الجهاز افتراضي
     للإدخال) لم يتغيّر؛ هذا عن الرد المنطوق فقط.
  4. **`PUT /api/studio/tts/settings/active` لا يُكتب ضمنيًا**: يُكتب فقط
     حين يختار المالك مزوّد خادم يختلف عمّا لدى الخادم. اختيار صوت الجهاز
     لا يكتب شيئًا على الخادم، والنطق نفسه لا يكتب شيئًا.
  5. **الفشل يُصرَّح به**: `TtsFailure` يحمل اسم المزوّد ورمز الحالة ونص
     `{ error, detail }` من الخادم، ويُكشف جسم JSON العائد بحالة 200 قبل
     تسليمه إلى `AVAudioPlayer` (وهي الحالة التي يعالجها عميل أندرويد
     أصلًا)، ثم — وبعد ذلك فقط — ينتقل إلى صوت الجهاز مع لافتة تشرح السبب.

## الملفات والتأثير
- `clients/ios/HermesStudio/Core/VoiceOutput.swift` (جديد): كل المنطق الخالص —
  `TtsProviderCatalog` (نفس قائمة الخادم وتسمياتها)، `TtsProviderSetting` و
  `TtsSettings` (فكّ ترميز `settings`/`providers` و`activeProvider`)،
  `TtsRequest` (بناء جسم الطلب)، `TtsFailure` و`TtsErrorBody`،
  `VoiceOutputChoice`/`VoiceOutputSelection` (اختيار المزوّد وخطة الكتابة)،
  `VoiceFallbackNotice`، و`VoiceOutputStore` (ذاكرة إعدادات لكل بروفايل).
- `clients/ios/HermesStudio/Core/APIClient.swift`: `ttsSettings(profile:)`،
  `setActiveTtsProvider(_:profile:)`، واستبدال `synthesize(text:profile:)`
  بـ `synthesize(text:provider:options:profile:)` التي ترجع
  `SynthesizedSpeech` (الصوت + المزوّد + المحرّك) وترمي `TtsFailure` مفصّلًا.
- `clients/ios/HermesStudio/Core/MessageSpeaker.swift`: `synthesize` صارت
  اختيارية (اختيار صوت الجهاز لا يستدعي الخادم أصلًا)، و`failure` منشورة
  تحمل سبب الفشل قبل الانتقال إلى صوت الجهاز.
- `clients/ios/HermesStudio/Core/SecureStore.swift`: `Preferences.ttsVoice(for:)`
  و`setTtsVoice(_:profile:)` — الاختيار محفوظ لكل بروفايل على الجهاز.
- `clients/ios/HermesStudio/Features/ConversationView.swift`: `speak(_:)` تمرّ
  عبر `VoiceOutputStore`، وتحميل الإعدادات مع الجلسة، ولافتة الفشل.
- `clients/ios/HermesStudio/Features/Settings/VoiceOutputSettingsView.swift`
  (جديد): قسم «Voice» في الإعدادات وشاشة «Spoken replies».
- `clients/ios/HermesStudio/Features/SettingsView.swift`: قسم `Voice` الجديد
  قبل «This device». قسم «Voice input» لم يُنقل ولم يُغيَّر.
- `clients/ios/HermesStudio/Resources/en.lproj/Localizable.strings` و
  `ar.lproj/Localizable.strings`: ١٤ مفتاحًا جديدًا متطابقة في الملفين.
  النصوص العربية تبدأ بعلامة RLM قبل المصطلح اللاتيني (Core Hub، iOS، HTTP)
  حتى لا ينكسر ترتيب النص المختلط، وأسماء المزوّدين تُعرَض عبر
  `TechnicalText` (LTR دائمًا).
- `clients/ios/README.md`: قسم «Spoken replies» جديد، وتحديث سطر ترتيب
  الإعدادات وسطر ملفات الاختبار ونقطة Speech في M3.

## الفحوص
- لا يوجد Xcode ولا Swift على هذا الجهاز: **لم يُبنَ المشروع ولم تُشغَّل
  الاختبارات محليًا.** التحقق الفعلي يقع على `mobile-test-track.yml` على
  macOS بعد الدمج.
- المراجعة اليدوية: قُرئ `synthesize` في الخادم و`mergeStoredTtsOptions` و
  `resolveActiveTtsProvider` و`listTtsProviderSettings` وقائمة المزوّدين، و
  `packages/client/src/api/studio/tts.ts` و`tts-settings.ts` و
  `useSpeech.ts` و`useVoiceSettings.ts` و`MessageItem.vue` لتأكيد شكل
  الطلب والرد. بُحث عن كل مستدعي `synthesize` و`MessageSpeaker` في iOS:
  المحادثة الفردية فقط (غرف المجموعات لا تنطق).
- اختبارات جديدة (ملف واحد، ٢٧ حالة):
  `clients/ios/HermesStudioTests/VoiceOutputTests.swift` — فكّ ترميز
  الإعدادات (مفتاحا `settings` و`providers`، علامة `[stored]`، إسقاط
  المزوّد المجهول، `activeProvider` بقيمة `null` التي يفكّها
  `JSONSerialization` كـ`NSNull`، وظهور مزوّد الخادم المفعّل بلا صفّ
  مخزَّن)، وبناء جسم الطلب (المزوّد، الخيارات المخزّنة، استبعاد المفتاح
  والقيم الفارغة وقوائم العناوين، وحذف `provider` حين لا يُعرف)، ومسارات
  الروابط الكاملة (`absoluteString` لا `path`)، واختيار المزوّد بكل حالاته،
  وخطة الكتابة إلى `settings/active`، وكل مسار خطأ (JSON فيه `error` و
  `detail`، حقل واحد، نص عادي مقتطع، جسم JSON بحالة 200، صوت حقيقي لا
  يُخطَّأ، رسالة الفشل باسم المزوّد والحالة، فشل نقل بلا حالة، لافتة
  الرجوع إلى صوت الجهاز).

## المخاطر والرجوع
- **تغيير سلوكي مقصود**: هاتف كان ينطق بـ`edge` سينطق الآن بمزوّد البروفايل
  المفعّل. إن كان مزوّد البروفايل معطّلًا أو بلا مفتاح، ستظهر لافتة خطأ
  صريحة ثم صوت الجهاز — وهذا هو المطلوب بدل الصمت.
- **`PUT settings/active` يغيّر البروفايل على الخادم** ويؤثّر على الويب وعلى
  وكيل Hermes (`syncVoiceConfigToHermesProfile`). لذلك لا يُكتب إلا باختيار
  صريح من المالك ولا يُكتب حين يطابق المفعّل الحالي.
- **لم يُتحقَّق بصريًا** من شاشة الإعدادات ولا من RTL (لا Xcode).
- الرجوع: `git revert` لهذه الدفعة. لا هجرات ولا تغييرات خادم؛ مفتاح
  `ttsVoice.<profile>` في `UserDefaults` يبقى بلا أثر بعد الرجوع.

## التسليم والخطوة التالية
الفرع محلي فقط، بلا دفع وبلا PR. الخطوة التالية للمالك:
1. مراجعة الفرق ودفع الفرع وفتح PR إلى `mobile` ليبني CI على macOS.
2. التحقق على سيرفره: أن `GET /api/studio/tts/settings` للبروفايل يرجع
   المزوّد العربي وأن `activeProvider` مضبوط عليه (وإلا فاختياره من
   *Settings → Voice → Spoken replies* هو ما يضبطه).
3. التحقق على جهاز: زر النطق ينطق بالصوت العربي، وتبديل الاختيار إلى صوت
   الجهاز والعكس، ورسالة خطأ واضحة عند تعطيل المزوّد عمدًا.
