# أندرويد: صدق اكتشاف لغة الإملاء، تلميح الضغط المطوّل، واتجاه نص المؤلِّف

المسؤول: twuijri
الفرع: fix/android-dictation-polish (من `origin/mobile`)
الحالة: review — لم يُدفع ولم يُفتح طلب دمج

## المشكلة والهدف

ثلاث ملاحظات من المالك على بناء `test.22` لتطبيق أندرويد:

1. **الاكتشاف التلقائي لم يعمل على جهازه.** شريط التسجيل كتب
   «Listening in English (Saudi Arabia)» بينما كان يتكلّم العربية، وخرج النص
   بحروف لاتينية («Salaam Alaikum») وكأنه نتيجة ناجحة.
2. **تلميح خفيف ومتقطّع** عند بدء التسجيل يذكّر بأن الضغط المطوّل على
   الميكروفون يغيّر اللغة — لا في كل مرة.
3. **النص العربي في مؤلِّف الرسائل يبدأ من منتصف السطر** لا من الحافة اليمنى،
   داخل واجهة إنجليزية.

## ما ثبت فعليًا عن العطل الأول (من المصدر، لا تخمينًا)

- **`en-SA` ليس خطأً في تركيب الوسم.** `appLanguageTag()` يقرأ
  `resources.configuration.locales[0].toLanguageTag()`، و«English (Saudi
  Arabia)» لغة نظام حقيقية يعرضها أندرويد. الوسم يمرّ سليمًا من
  `normalizeTag`، ثم يُسلَّم كما هو إلى `EXTRA_LANGUAGE`. المشكلة أن أي محرّك
  نطق تقريبًا لا يملك نموذجًا لهذه اللغة/المنطقة، ولم يكن في التطبيق أي رجوع
  إلى لغة يملكها المحرّك.
- **المحرّك لم يُسأل قط عن الاكتشاف.** `SpeechInput.querySupport` كان يبني
  نيّة الفحص بـ `recognitionIntent(context, Locale.getDefault().toLanguageTag())`
  — بلا `EXTRA_ENABLE_LANGUAGE_DETECTION`. ومع ذلك كان
  `DetectionSupport.engineConfirmed` يُضبط من `reported.answered`، وتوثيقه
  يقول صراحةً إنه يعني «أجاب `checkRecognitionSupport` عن نيّة تطلب
  الاكتشاف». الكود والتوثيق كانا متناقضين: «يسمع كلامًا» كان يُقرأ دليلًا على
  «يكتشف اللغة».
- **الوقوع على `SpeechPlan.OnDevice(detectionUnavailable = true)` مطابق للعرَض.**
  الشريط يعرض `composer_take_language` = «Listening in %1$s»، والسبب كان يُعلن
  في إشعار عابر واحد فقط، بجملة واحدة لكل الأسباب («هذا الجهاز لا يستطيع…»).
  لذلك ظهر على الشاشة ما رآه المالك بالضبط: لغة خاطئة بنبرة نجاح.
- **ما لا يمكن إثباته من هنا:** أيّ العوائق الثلاثة كان الفاعل على جهازه
  تحديدًا (مستوى الواجهة، أم رفض المحرّك، أم غياب النماذج). لا يوجد جهاز في
  بيئة العمل. ولهذا صار التطبيق نفسه هو الذي **يُبلّغ** بالسبب.

## القرار والتنفيذ

### 1) الإبلاغ بدل الافتراض

- `DetectionBlock` (جديد): `None` / `NotChecked` / `PlatformTooOld` /
  `EngineSilent` / `EngineRefused` / `NoModels`.
- `DetectionSupport` صار يحمل ما أبلغ به الجهاز: `checked`, `sdkInt`,
  `engineAnswered`, `detectionAccepted`, `allowed`؛ و`block` يختار أول عائق.
- `SpeechInput.queryLanguages` على أندرويد 14+ يسأل أولًا بنيّة **تحمل**
  إضافات الاكتشاف؛ إن رفضها المحرّك يُعاد السؤال بنيّة عادية ويُسجَّل
  `detectionAccepted = false` بدل ابتلاع الفرق.
- `SpeechLanguages.supportedTag`: وسم لا يخدمه المحرّك يُنقل إلى صيغة أخرى من
  **نفس اللغة** أبلغ عنها المحرّك (`en-SA` ← `en-GB`/`en-US`)، ولا يُخمَّن شيء
  حين لا يُبلّغ المحرّك بقائمة أصلًا.
- شريط التسجيل صار يقول: «يكتشف اللغة بين …» مع أسماء اللغات التي سُلِّمت
  للمحرّك فعلًا، أو «بلا اكتشاف — يستمع بـ… (السبب)»، أو «… غير متاحة هنا —
  يستمع بـ…». نفس جملة السبب تظهر تحت «الاكتشاف التلقائي» في ورقة اللغات.
- بعد انتهاء التسجيل يبقى تحذير فوق المؤلِّف (`dictationWarning`) ما دام النص
  الناتج موجودًا: اكتشاف لم يعمل، أو محرّك «اكتشف» ولم يُسمِّ لغة، أو رجوع عن
  لغة غير مدعومة. الإشعار العابر وحده كان يختفي بينما يبقى النص.

### 2) التلميح المتقطّع

- `DictationHint.showsOn(count, longPressUsed)`: أول ثلاث تسجيلات، ثم فجوات
  متكرّرة 5/8/6/10/7/9 (كلها داخل «كل خامسة إلى عاشرة»)، وتوقّف نهائي بعد أول
  استخدام فعلي للضغط المطوّل.
- العدّاد و«استُخدم الضغط المطوّل» يُحفظان **لكل بروفايل** في `Store`.
- العرض: سطر خفيف فوق بطاقة المؤلِّف (`segmentTrack`، نصف قطر pill، خط
  `meta`)، يظهر ويختفي بتلاشٍ، ويزول تلقائيًا بعد ٥ ثوانٍ. ليس نافذة ولا
  قرارًا.

### 3) اتجاه المحتوى

- `ContentDirection.kt` (جديد): الوجه الأندرويدي لعقد
  `docs/CONTENT-DIRECTION.md` — أول حرف قوي، **لكل فقرة**، مع تخطّي النصوص
  المعزولة (U+2066…U+2069) والتضمينات، ومرورٌ على النقاط البرمجية الكاملة
  (رمز تعبيري هو زوج بديل، والبديل المفرد يُصنَّف يسارًا). الأرقام وعلامات
  الترقيم ليست دليلًا، وعند غياب الدليل يُستعمل اتجاه الواجهة.
- **سبب العطل الفعلي في المؤلِّف:** `decorationBox` كان يلفّ حقل النص في
  `Box`، و`Box` لا يمرّر الحد الأدنى للعرض إلى أبنائه. فقياس النص كان بعرض
  محتواه فقط، مثبّتًا عند بداية اتجاه الواجهة (اليسار). فقرة عربية محاذاتها
  يمين **داخل ذلك الصندوق الضيّق** تبدأ حيث ينتهي عرض المحتوى — أي في منتصف
  المؤلِّف. أُصلح بـ `propagateMinConstraints = true` على صندوق داخلي يمرّر
  العرض وحده (لا الارتفاع، كي لا يكبر الحقل إلى ٤٨dp).
- `ContentDirectionBox` يمنح الحقل اتجاه ما كُتب فيه بدل لغة الواجهة، فتتبعه
  المحاذاة ومؤشر الكتابة والنص البديل — وهو ما يفعله `dir="auto"` في الويب.
  طُبِّق على مؤلِّف المحادثة (ومعه معاينة الإملاء الجزئية، لأنها تُدرَج في
  الحقل نفسه)، ومؤلِّف الغرفة الجماعية، وحقل إجابة سؤال الوكيل.
- `chatTextDirection` صار يستدعي القاعدة المشتركة، فلم يعد اسم نموذج معزول
  يقلب اتجاه فقرة عربية.

## الملفات والتأثير

جديد:
- `clients/android/app/src/main/java/us/i3u/hermesstudio/ContentDirection.kt`
- `clients/android/app/src/main/java/us/i3u/hermesstudio/DictationHint.kt`
- `clients/android/app/src/test/java/us/i3u/hermesstudio/ContentDirectionTest.kt`
- `clients/android/app/src/test/java/us/i3u/hermesstudio/DictationHintTest.kt`
- `clients/android/app/src/test/java/us/i3u/hermesstudio/DictationReportingTest.kt`

معدّل:
- `SpeechLanguage.kt`, `SpeechInput.kt`, `AppViewModel.kt`, `Store.kt`,
  `ChatMarkdown.kt`
- `ui/chat/Composer.kt`, `ui/chat/RunCards.kt`, `ui/groups/RoomScreen.kt`
- `res/values/strings.xml`, `res/values-ar/strings.xml` (١٥ مفتاحًا جديدًا
  بالعربية والإنجليزية؛ حُذف `speech_language_automatic_unavailable` و
  `notice_speech_detection_unavailable` لأن السبب صار محدّدًا)
- `app/src/test/java/us/i3u/hermesstudio/SpeechLanguageTest.kt`
- `clients/android/README.md`

لم يُمسّ `clients/ios` ولا الخادم ولا عميل الويب.

## الفحوص

```
JAVA_HOME=/home/twuijri/.local/opt/jdk17 ANDROID_HOME=/home/twuijri/Android/Sdk \
  gradle --offline testDebugUnitTest assembleDebug
```
BUILD SUCCESSFUL — ٢٩٣ اختبارًا، صفر إخفاق، و`app-debug.apk` (‎24.3MB‎).
تشمل `TranslationsTest` (تطابق المفاتيح والمتغيّرات بين اللغتين) و`RtlTest`
(start/end والأيقونات الاتجاهية).

## الحدود

- **يحتاج جهاز المالك:** أيّ `DetectionBlock` يظهر فعليًا على هاتفه، وهل
  `checkRecognitionSupport` يرفض نيّة الاكتشاف أم يقبلها ويصمت. `detectionAccepted`
  يثبت أن المحرّك **قبل** نيّة تطلب الاكتشاف، لا أن الاكتشاف سينجح؛ الدليل
  القاطع الوحيد هو إطلاق `onLanguageDetection`، ولذلك يُبلَّغ عن التسجيل
  الذي «اكتشف» دون أن يُسمّي لغة.
- **يحتاج جهاز المالك:** التحقّق البصري من أن العربية تبدأ من الحافة اليمنى
  في المؤلِّف، ومن شكل التلميح فوق البطاقة. سبب العطل مثبت من المصدر
  (`Box` لا يمرّر الحد الأدنى للعرض) ومحروس باختبار، لكن لا لقطة شاشة هنا.
- لم يُجرَّب مسار خادم Core Hub للنسخ الصوتي في هذا التغيير؛ لم يُمسّ.

## التسليم والخطوة التالية

الفرع محلي فقط: **لم يُدفع، ولا طلب دمج**. بانتظار قرار المالك، ثم بناء
`test` وتجربة على الهاتف.
