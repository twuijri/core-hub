# مزوّدو الصوت: Groq بأصواته، وخدمات الصوت المعروفة، واختيار الصوت ومعاينته
المسؤول: twuijri · الفرع: feat/voice-providers · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٦): في النماذج ← «تحويل الصوت إلى نص» و«تحويل النص إلى صوت» يُضاف Groq (شركة الاستدلال
groq.com، لا Grok من xAI): «جروك الثاني، وفيه صوت سعودي، ولازم تختار الصوت». يُضاف مرة واحدة بمفتاح، ثم يُختار
النموذج والصوت من قائمة تبيّن اللغة والجنس، مع زر «معاينة» ينطق عيّنة عربية أو إنجليزية بالصوت المختار. وتُضاف خدمات
الصوت المعروفة الأخرى بنقرة بعد التحقق من وثائقها العامة. قاعدة المالك: النماذج والأصوات تُسحب من المزوّد ولا
تُخترع؛ القائمة الثابتة فقط حين لا مسار قائمة للمزوّد، وتُعلَّم بذلك.

إضافات المنسّق أثناء العمل: (١) Groq يقبل نحو ٢٠٠ حرف في الطلب: يُقسَّم النص الطويل عند حدود الجمل ثم الكلمات،
ويُطلب كل جزء، ويُضمّ الصوت بالترتيب، لأي مزوّد بحدّ صغير. (٢) Edge TTS بلا مفتاح فقط إن سمحت شروط Microsoft لخادم
طرف ثالث، وإلا يُكتب السبب ويُوصى بـ Azure Speech. (٣) «العربية» تعني «العربية أيضًا»: كل لغات المزوّد وأصواته، بترشيح
حسب اللغة وبحث، والأشهر أولًا و«كل اللغات» خلف مرشّح، وإدخال يدوي للمعرّف؛ وفي الإملاء: اكتشاف تلقائي ثم أي لغة.

## القرار والموافقات
قرار العقد §94 في `docs/contracts/DECISIONS.md` — **مقترح، للمالك أن يؤكد**. ما تحققت منه في الوثائق العامة
(٢٠٢٦-٠٩-٢٦)، بكلماتي:

- **Groq**: الإملاء `POST /openai/v1/audio/transcriptions` بشكل OpenAI بنموذجَي `whisper-large-v3-turbo` و
  `whisper-large-v3`. النطق `POST /openai/v1/audio/speech` بنموذجين: `canopylabs/orpheus-v1-english` و
  `canopylabs/orpheus-arabic-saudi` (اللهجة السعودية)، و`wav` هو الصيغة الوحيدة، و٢٠٠ حرف على الأكثر في الطلب. لا مسار
  قائمة أصوات؛ الأصوات مسمّاة في صفحة Orpheus بجنسها:
  الإنجليزية `autumn` و`diana` و`hannah` (إناث) و`austin` و`daniel` و`troy` (ذكور)؛ **والعربية السعودية
  `abdullah` و`fahad` و`sultan` (ذكور) و`lulwa` و`noura` و`aisha` (إناث)**.
- **OpenAI**: ١٣ صوتًا موثّقًا (`alloy` … `marin` و`cedar`)، تسعة منها فقط لـ`tts-1`/`tts-1-hd`؛ لا مسار قائمة أصوات.
  النماذج من `GET /models`.
- **ElevenLabs**: الأصوات `GET /v2/voices` صفحات حتى ١٠٠ (`next_page_token`)، ونماذج النطق `GET /v1/models`
  (`can_do_text_to_speech`)، والإملاء `POST /v1/speech-to-text` بـ`model_id=scribe_v2` (بلا مسار قائمة لنماذج Scribe).
- **Deepgram**: `Authorization: Token`؛ `GET /v1/models` فيه نماذج الإملاء وأصوات Aura (كل صوت نموذج باسمه مثل
  `aura-2-thalia-en` مع `architecture` و`languages` و`metadata.tags` للجنس)؛ `POST /v1/listen` بالتسجيل جسمًا، و
  `POST /v1/speak?model=<الصوت>`. Aura-2 بلا عربية في الوثائق، وNova للإملاء.
- **Azure Speech** بمفتاح المورد: قائمة الأصوات كلها `GET https://<region>.tts.speech.microsoft.com/cognitiveservices/voices/list`
  (منها `ar-SA-HamedNeural` و`ar-SA-ZariyahNeural`)، والنطق SSML إلى `…/cognitiveservices/v1`، والإملاء «النسخ السريع»
  `POST /speechtotext/transcriptions:transcribe?api-version=2025-10-15` (يقبل WebM وOgg وMP3 وAAC).

**ما أُضيف:** قوالب `groq-stt` و`groq-tts` (عائلة groq: مفتاح المحادثة نفسه)، و`elevenlabs-stt`، و`deepgram-stt`/
`deepgram-tts`، و`azure-tts`/`azure-stt` (العنوان يُطلب ولا يُخمَّن لأن المفتاح مربوط بمنطقة؛ مثاله في
`base_url_example`). إضافة صف من عائلة تضيف إخوته، وعائلة لها مفتاح في النطاق المختار تُعيره لصف يُضاف لاحقًا
(`key_on_file`) فلا يُلصق المفتاح مرتين. لا نموذج ولا صوت افتراضي لـGroq TTS: الشخص يختار (قول المالك).

**الأصوات:** من المزوّد متى كان له مسار (`source: provider`)، ومن وثائقه متى لم يكن (`source: documented` — Groq و
OpenAI) في ملف واحد قابل للتحرير `packages/server/src/modules/models/speech/documented.ts` مع رابط الصفحة ويوم التحقق؛
وتُرشَّح حسب النموذج. النماذج: قائمة المزوّد نفسها مصفّاة إلى نوع الصف (كانت صفوف الكلام تحمل نماذج المحادثة أيضًا)،
وScribe من قائمته الموثّقة بعلامة `catalogue.source: fallback`.

**النص الطويل:** حدّ كل مزوّد في الكتالوج (`speech.maxInputChars`: Groq ٢٠٠، Deepgram ٢٠٠٠، OpenAI ٤٠٩٦، ElevenLabs
٥٠٠٠)؛ يُقسَّم النص عند نهايات الجمل (اللاتينية والعربية «؟ ۔» والصينية وفواصل الأسطر) ثم الفواصل ثم الكلمات، ولا تُقطع
كلمة إلا إن زادت وحدها على الحد؛ ويُضمّ WAV بعيّناته تحت رأس واحد (ويُرفض خلط صيغ عيّنات مختلفة)، وMP3 بالتتابع.

**كل اللغات (مقترح):** في الويب لكل حقل قائمة قابلة للبحث وحقل المعرّف الذي تملؤه ويُكتب فيه يدويًا. اللغة: «اكتشاف
تلقائي» ثم الأشهر (الإنجليزية، العربية، الإسبانية، الفرنسية، الألمانية، الصينية، الهندية، البرتغالية، اليابانية،
الروسية، الكورية، الإيطالية، التركية، الإندونيسية، الأردية، الفارسية، البنغالية) ثم كل اللغات، بأسمائها من المتصفح بلغة
الواجهة. الأصوات مجمّعة حسب اللغة، مرشّحة افتراضيًا على «اللغات الأشهر» مع «كل اللغات (العدد)» وكل لغة وحدها. قائمة لغة
الإملاء في الملحّن صارت «تلقائي» والأشهر (كانت العربية والإنجليزية فقط).

**المعاينة:** `SpeechRequest.model` مع `provider_id` و`voice`، فزر «معاينة» ينطق ما على الشاشة قبل الحفظ، بالعربية أو
الإنجليزية (لغة الصوت المختار حين تكون إحداهما).

**هرمز (MIT، الوسم `v2026.9.14`، قرأته قبل الكتابة):** أدوات الصوت في هرمز تقرأ `stt.provider` (مدمجة: `local`،
`groq`، `openai`، `mistral`، `xai`، `elevenlabs`، `deepinfra`) و`tts.provider` (مدمجة: `edge` الافتراضي، `openai`،
`elevenlabs`، `minimax`، `xai`، `mistral`، `gemini`، `deepinfra` ومحلية)، وإعدادات كل مزوّد في قسمه (`stt.groq.model`،
`stt.groq.language`، `stt.elevenlabs.model_id`، `tts.openai.voice`، `tts.elevenlabs.voice_id` …) والمفاتيح من
`GROQ_API_KEY`/`OPENAI_API_KEY`/`ELEVENLABS_API_KEY`. الهب لم يكن يكتب شيئًا من هذا (فقط `stt.enabled` و`voice.auto_tts`
من إعدادات القنوات). الآن يكتب الهب اختيار البروفايل حيث لهرمز مزوّد: STT لـGroq وOpenAI وElevenLabs، وTTS لـOpenAI
وElevenLabs، مفتاحًا مفتاحًا (يبقى كل ما عداه)، وحذف اللغة يعيد الاكتشاف التلقائي. Groq TTS لا يصل هرمز: مسار OpenAI
في هرمز يطلب MP3 أو Opus وGroq يرفضهما؛ وDeepgram وAzure بلا مزوّد في هرمز — فيبقى صوت هرمز في القنوات كما هو، والويب
والجوال يتكلمان عبر نقاط الهب (`models.synthesize`/`models.transcribe`) كما في #152.

**ما تُرك ولماذا:**
- **Google Cloud TTS/STT:** صفحة المصادقة الرسمية تذكر Application Default Credentials وحسابات الخدمة، لا مفتاح API،
  ونموذج المزوّدين في الهب مفتاح واحد. لم يُضف.
- **Edge TTS:** نقطة غير موثّقة يُوصل إليها بانتحال متصفح Edge برمز مضمَّن فيه، ولا شروط منشورة تمنح خادم طرف ثالث
  استعمالها؛ الاستعمال غير مسموح بوضوح، فلم يُبنَ. **التوصية: Azure Speech** — الأصوات العصبية نفسها (ومنها السعودية
  `ar-SA-*`) بمفتاح رسمي، وهي مبنية الآن وقابلة للاختيار.
- **Gemini TTS** (مفتاح AI Studio، يدعم العربية، ولهرمز مزوّد له): واجهته تتغيّر الآن إلى «interactions» في الوثائق؛
  مرشّح لاحق.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `models.listVoices`: معامل اختياري `model`، والجواب `{ items, source }` مع `VoiceListSource` (`provider`/`documented`/`none`)؛
  `Voice.description` و`Voice.models` اختياريان.
- `SpeechRequest.model` (اختياري)، ووصف التقسيم في `models.synthesize` (بجانب `format` من §91).
- `ProviderPreset.base_url_example` و`ProviderPreset.key_on_file` (اختياريان).
- DECISIONS §94.

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml`، `docs/contracts/DECISIONS.md` §94.
- الخادم (`packages/server/src/modules/models/`): `catalogue.ts` (القوالب الجديدة، `speech`، `hermesSpeech`،
  `baseUrlExample`، العائلتان `deepgram` و`azure-speech`)؛ `adapters/groq.ts` و`deepgram.ts` و`azure.ts` (جديدة)،
  `adapters/elevenlabs.ts` (v2 للأصوات، `/v1/models`، Scribe)، `adapters/openai.ts` (الأصوات الموثّقة، `orpheus` نموذج
  نطق، تجاوز النموذج)، `adapters/http.ts` (`requestUpload`، `requestTextForBytes`، `synthesisFailure`)،
  `adapters/types.ts`، `adapters/index.ts`؛ `speech/documented.ts` و`speech/split.ts` و`speech/audio.ts` (جديدة)؛
  `service.ts` (القوالب مع المفتاح المُعار، إعارة المفتاح عند الإضافة، تصفية نماذج صفوف الكلام، `listVoices` مع
  `model`/`source`، التقسيم والضمّ، `hermesSpeechChoice`، نشر الاختيار عند كل حفظ للكلام)؛ `propagation.ts`
  (`hermesSpeech` و`applySpeech`)؛ `index.ts` (المسارات).
- اختبارات الخادم: `speech-providers.test.ts` و`speech/speech.test.ts` (جديدان)، `tests/contract/speech.contract.test.ts`،
  `tests/unit/profile-transfer-providers.test.ts` (تصدير Groq يحمل صفّي الصوت)،
  `providers-shared.test.ts` (Groq صار ثلاثة صفوف بمفتاح واحد: الاختبار يحذفها كلها ويتحقق أن المفتاح يبقى حتى آخرها).
- الويب: `models/SpeechPickers.tsx` (جديد)، `models/SpeechCard.tsx`، `models/AddProviderDialog.tsx`، `models/queries.ts`،
  `voice/languages.ts` (جديد)، `voice/DictationControls.tsx`، `voice/context.tsx`، `voice/speech-api.ts`، `i18n/{ar,en}.json`.
- اختبارات الويب: `tests/speech-voice-picker.test.tsx` (جديد)، `e2e/zzzzzzz-voice.spec.ts` (يتحقق من علامة القائمة
  الموثّقة ويلتقط بطاقة النطق)، اللقطتان `e2e/shots/models-speech-{stt,tts}-ar-light.png`.
- الوثائق: `docs/STATUS.md`، `docs/domain/models.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`، واحدًا بعد الآخر، في `corehub-wt-voice` بعد دمج `origin/night/2026-09-27`. دُمج الفرع ثلاث مرات: في
الثانية كان طلب الجوال قد أخذ §91 (`SpeechRequest.format`)، وفي الثالثة أُخذ §92 و§93، فصار قرار هذه المهمة §94، ودُمج `format` مع `model` في
`models.synthesize`، وصارت محوّلات Deepgram وAzure وElevenLabs تحترم الصيغة المطلوبة حيث يسمح المزوّد (Groq ‏WAV فقط؛
Azure بلا AAC فيجيب MP3؛ والنوع في `Content-Type`). النتائج أدناه بعد الدمج الثاني، وأُعيد بعد الثالث ما مسّه (انظر آخر الكتلة):

```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!
$ pnpm typecheck                       → exit 0
$ pnpm contracts:lint                  → exit 0 («Woohoo! Your API description is valid»؛ التحذير الوحيد في
                                         السطر 7011، مثال برامج الأجهزة، ليس من هذه المهمة)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 662 client file(s) scanned, 235 contract path(s) known.
$ pnpm i18n:check
i18n:check  ios: 359 keys, ar/en in parity
i18n:check  OK
$ pnpm change-record:check
change-record  OK — 7 record(s) valid
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop
$ (server) vitest run --project unit src/modules/models/
 Test Files  14 passed | 1 skipped (15)
      Tests  199 passed | 3 skipped (202)
$ (server) vitest run --project unit src/modules/models/speech-providers.test.ts   (مع فحص الصيغة)
      Tests  9 passed (9)
$ (server) vitest run --project contract tests/contract/speech.contract.test.ts tests/contract/contract.test.ts
 Test Files  2 passed (2)
      Tests  336 passed (336)
$ (web) vitest run tests/speech-voice-picker.test.tsx tests/models-screen.test.tsx tests/voice-dictation.test.tsx \
    tests/composer.test.tsx tests/i18n.test.ts tests/navigation.parity.test.tsx
 Test Files  6 passed (6)
      Tests  69 passed (69)
$ pnpm build                            → exit 0   (قبل الدمج الثاني، ومعه رحلة Playwright أدناه)
$ COREHUB_E2E_PORT=8871 … PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzzz-voice.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zzzzzzz-voice.spec.ts:51:1 › 32. dictation lands in the composer, a reply is read aloud, and voice mode goes round (5.8s)
  1 passed (14.8s)

# بعد الدمج الثالث (القرار §94):
$ pnpm lint / pnpm typecheck / pnpm contracts:lint / pnpm i18n:check / pnpm change-record:check   → exit 0 كلها
$ (server) vitest run --project unit src/modules/models/
 Test Files  14 passed | 1 skipped (15)
      Tests  199 passed | 3 skipped (202)
$ (server) vitest run --project contract tests/contract/speech.contract.test.ts
      Tests  6 passed (6)
$ (web) vitest run tests/speech-voice-picker.test.tsx tests/models-screen.test.tsx
      Tests  35 passed (35)

# الاختبارات الجديدة على الكود القديم (catalogue.ts وSpeechCard.tsx من night/2026-09-27 قبل المهمة):
     × adds with the chat key, lists its own models per tab and its documented voices per model
     × reads a long reply in parts under 200 characters and joins the WAVs in order
     × says a voice must be chosen, and transcribes with Whisper
     × pages through the account's voices, lists its TTS models, and transcribes with Scribe
     × lists models and Aura voices from its own list, speaks and transcribes
     × asks the region's voice list, speaks SSML and transcribes with a locale
     × adds a speech row of a family that holds a key without asking for it again
     × writes the chosen provider, model, voice and language into Hermes's voice settings
      Tests  8 failed | 1 passed (9)
     × offers the model's own voices with language and gender, and says the list is documented
     × previews the chosen voice before saving, in Arabic or English
     × picks a spoken language from Auto, the popular languages, every language, or a typed code
      Tests  3 failed | 1 passed (4)
```

ما تثبته اختبارات الخادم الجديدة: خادم وهمي واحد على منفذ محلي يلعب دور كل مزوّد، والطلبات تخرج إلى العناوين الحقيقية
(`https://api.groq.com/…`، `https://westeurope.tts.speech.microsoft.com/…`) ولا تُحوَّل إلى الخادم الوهمي إلا في آخر
لحظة، فالمسارات والرؤوس والأجسام المفحوصة هي ما يُرسل في الإنتاج. لا مفتاح حقيقي في أي اختبار.

**لم أشغّل** (قواعد السرعة: CI يشغّلها على كل دفع): حزم الخادم والويب كاملة، وبقية رحلات Playwright، واختبار هرمز
الحقيقي في الصورة (لم أحمل Docker في هذه المهمة) — فكتابة `stt:`/`tts:` في `config.yaml` مثبتة بالملف وبقراءة مصدر
هرمز، لا بدور صوت حقيقي في هرمز. ولا مفتاح حقيقي لأي مزوّد.

CI على #165 عند `98d73b31` (فيه هذه المهمة): كله ناجح إلا شريحة الخادم ٣/٣، وفيها
`tests/unit/profile-transfer-providers.test.ts` يعدّ مزوّدَين في تصدير بروفايل فيه Groq، وصار Groq ثلاثة صفوف بمفتاح واحد
(`expected 4 to be 2`؛ الاستيراد نفسه نجح بأربعة). أصلحت الاختبار ليذكر `groq-stt` و`groq-tts` (السلوك مقصود: التصدير
يحمل صفوف الصوت بمفتاحها)، ومحليًا: `Tests  4 passed (4)`.

## المخاطر والرجوع
- **الوثائق تتغيّر:** قوائم Groq وOpenAI الموثّقة قد تتقادم؛ الملف يذكر الصفحة ويوم التحقق، والصوت غير المدرج يُكتب يدويًا.
- **Azure:** العنوان المطلوب هو نقطة المورد بمنطقته؛ النطاق المخصّص (`…cognitiveservices.azure.com`) يُستعمل كما هو
  للاتجاهين، ولم يُجرَّب أن النطق يجيب عليه.
- **ضمّ MP3** بالتتابع يعمل في المشغّلات الشائعة؛ الرؤوس (ID3) المتكررة لا تُزال.
- **هرمز:** الهب صار يكتب `stt.provider`/`tts.provider` عند كل حفظ لإعدادات الكلام متى كان لهرمز المزوّد؛ من غيّر صوت
  هرمز يدويًا لمزوّد آخر سيُكتب فوقه اختيار الهب ما دام الاختيار لمزوّد يعرفه هرمز.
- **حذف Groq من تبويب المزوّدين** لا يحذف صفَّي الصوت ولا المفتاح (كما كان OpenAI دائمًا)؛ المفتاح يُحذف مع آخر صف.
- الرجوع: revert لهذا الفرع؛ لا ترحيل قاعدة بيانات. صفوف الكلام المضافة تبقى بلا أثر إن رُجع (القوالب تختفي فقط).

## التسليم والخطوة التالية
- للمالك أن يؤكد §94: قائمة المزوّدين، عدم وجود صوت افتراضي لـGroq، قائمة «اللغات الأشهر»، الكتابة في `stt:`/`tts:`
  في هرمز، وترك Google وEdge.
- التالي: تجربة بمفاتيح حقيقية على ستاك التست (Groq أولًا: الصوت السعودي والتقسيم)، وتجربة كتابة الصوت في دور هرمز حقيقي
  (رسالة صوتية على تيليجرام)، وGemini TTS حين تستقر واجهته، وربما مزوّد TTS لهرمز يمرّ بالهب ليصل Groq وAzure إلى القنوات.
