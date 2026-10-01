# «افحص الآن» كما يقرؤه CLIProxyAPI، وجملة بدل ردّ المزوّد الخام، وحالة إعادة التشغيل الصحيحة، ولا تنبيه لرد تشاهده
المسؤول: twuijri · الفرع: fix/subscription-usage-live (PR مسودة إلى main) · الحالة: review

## المشكلة والهدف
أول دخول حقيقي للمالك (2026-10-01، preview.39 = 1.1.6): حساب Google Antigravity يعمل، لكن «افحص الآن» فشل وعرضت
النافذة ردّ Google الخام: `403 … You do not have a valid license of this product …`. والهدف: قراءة الاستهلاك كما تقرؤه
لوحة إدارة CLIProxyAPI (CPAMC) لحسابات المستهلكين، ومراجعة بقية المزوّدين بالطريقة نفسها، وألّا يظهر ردّ مزوّد خام
أبدًا بل جملة قصيرة بلغة الشخص. وملاحظة ثانية: بعد تغيير النموذج الافتراضي أظهرت بطاقة وقت التشغيل «لم يُعِد هرمز
التشغيل» مع الزر، مع أن هرمز أعاد التشغيل وحده بعد قليل.

## القرار والموافقات
DECISIONS §147 (إصلاح لملاحظات المالك الحية). باختصار:
- **الطلبات هي طلبات CPAMC** (تحققت من مصدره على `main` `a7ec312f` ومن CLIProxyAPI 8.0.4، لا تخمين):
  Antigravity: `retrieveUserQuotaSummary` على مضيفي daily وsandbox ثم production، مع مشروع الحساب
  (`project_id`) في الجسم واسم عميل Antigravity؛ ثم `fetchAvailableModels` (حصة كل نموذج: المتبقي ووقت التصفير)، وهو
  ما كان CPAMC يقرؤه قبل الملخّص وما يطلبه CLIProxyAPI نفسه لكل حساب. كنا نسأل production وحده بجسم `{}` وبلا اسم عميل،
  وهذا ما ردّت عليه Google بـ403. **ملاحظة**: CPAMC اليوم يستعمل الملخّص لا `fetchAvailableModels` (تغيّر في 2026-06-17)،
  فجعلتُ الملخّص أولًا والقائمة لكل نموذج احتياطًا. ChatGPT: `wham/usage` باسم عميل Codex، ونوافذ مراجعة الكود أيضًا.
  Claude: كل النوافذ ومنها «أسبوعي (Fable)» (`iguana_necktie`). xAI: الرصيد الأسبوعي أولًا ثم الفاتورة الشهرية. Kimi:
  وحدات الوقت كما يرسلها وإعادة الضبط بتاريخ أو بثوانٍ، واسم الحد.
- **لا ردّ خام في النافذة**: جملة واحدة بلغة الشخص («لا يشارك Google الاستهلاك لهذا النوع من الحسابات.»، أو رفض الدخول،
  أو تحديد الطلبات، أو خطأ المزوّد برقمه، أو تعذّر الوصول، أو ردّ بلا استهلاك). ردّ المزوّد في سجل المركز فقط، منقّحًا
  (وصار توكن Google `ya29.` يُنقّح أيضًا). بلا تغيير في العقد.
- **إعادة التشغيل في طريقها تبقى في طريقها**: السبب أن حالة §145 كانت تنتهي لحظة طلب المركز إعادة التشغيل، لا لحظة بدء
  هرمز من جديد؛ فتلك الثواني يقول التقرير «لم يُعِد التشغيل» مع الزر، وتتوقف الصفحة عن السؤال فتبقى حمراء. الآن تبقى
  `scheduled` حتى يبدأ هرمز (حتى ثلاث دقائق، ثم الزر مخرجًا). **مدة الانتظار**: 1.5 ثانية تجميع، ثم — فقط إن كان دور
  **هرمز** جاريًا (لا أي وكيل كما كان؛ دور وكيل البرمجة لا تمسّه إعادة التشغيل) — حتى دقيقتين (80 × 1.5 ث) وتقول البطاقة
  «بعد انتهاء الرد الجاري»، ثم ثوانٍ لبدء هرمز. راجعت مسارات تغيير الافتراضي (`setDefaults`، `ensureChatDefault`،
  `moveUses`): كلها تعيد التشغيل؛ لا ثغرة، فلم أُضف إعادة تشغيل.

### رفض المزوّد كما هو: لا سعة وحدّ عابر ليسا حصة منتهية؛ والمحادثة تسمع ما تفعله البوابة (DECISIONS §148، الفرع fix/gateway-gemini-claude-code)
**ما رآه المالك** (Claude Code على اشتراك Google Antigravity يعمل): «هلا» بقيت «يفكر 88 ث» ثم أجاب `openrouter/free` بأدوات وملف
`hello.txt`، وسطر البديل يقول إن حصة gemini-3.8-flash-high ثم gemini-3-flash نفدت. وهرمز على الحساب نفسه أجاب.

**السبب الجذري**:
1. Google يقول `RESOURCE_EXHAUSTED` للحصة المنتهية ولنقص السعة ولحدّ الدقيقة معًا، وCLIProxyAPI 8.0.4 لا يُبقي على مسار
   Anthropic (Claude Code) وResponses وGemini إلا الرسالة («Resource has been exhausted (e.g. check quota)») بلا سبب Google ولا
   مهلته (قرأت مصدره: معالج Claude يبني `{type, message}`، ومعالج Chat يعيد JSON المزوّد كما هو). والبوابة كانت تسمّي أي رفض ثانٍ
   بعد الانتظار «نفدت الحصة». فلما رفضت Google النموذجين (غالبًا سعة أو حدّ دقيقة) نزل الدور في السلسلة إلى آخرها: نموذج مجاني ضعيف.
2. الأدوات و`hello.txt` من ذلك النموذج الضعيف، ودفعها **نص المركز** في الدور: «Write any file the user should be able to download
   into: …» — صيغة أمر قرأها النموذج مهمة (مسار الأحداث يُظهر «They've also instructed me to write any file…»).

**الإصلاح**:
- على رفض في مسار غير Chat تسأل البوابة النموذج نفسه مرة في الدور عبر مسار Chat في CLIProxyAPI (`max_tokens: 1`) فتقرأ جواب Google كاملًا؛
  إن أجاب النموذج هناك فالحدّ زال ويُعاد الطلب فورًا.
- ثلاثة أسباب: `quota_exhausted` (402، `insufficient_quota`، فوترة، رصيد، حصة يومية/شهرية، `QUOTA_EXHAUSTED`، «exhausted your
  capacity … quota will reset») فورًا؛ `no_capacity` (`MODEL_CAPACITY_EXHAUSTED`، «No capacity available»، نموذج محمّل، 503/529)
  انتظار مرة (مهلة المزوّد وإلا 5 ث)؛ `rate_limited` (بقية كلمات الحصة وحدّ الدقيقة) انتظار مرة (وإلا 20 ث، بحد 30). الرفض الثاني
  بسببه هو؛ ثم السلسلة أو الفشل.
- الخطأ وسطر البديل بسبب واضح («ليس لدى X سعة لـY الآن»، «X يحدّ الطلبات على Y الآن»، «نفدت حصة…») وكلام Google مع رموز السبب
  وأسماء الحصص والمهلة (منقّحًا من الأسرار) في `details.said`.
- حدث جديد `run.status` (إضافة): «ينتظر X — يعيد السؤال بعد N ث» أو «يجرّب X…» في مؤشر التفكير، يزول مع أول كلام أو نهاية الدور.
- ملاحظة مجلد التنزيل صارت سياقًا: `<corehub-context>` وشرطية («فقط إن طلب المستخدم ملفًا…»، «وإلا فتجاهل هذه الملاحظة ولا تنشئ
  ملفًا»). تبقى في الدور لأن المجلد خاص بكل دور (لا تحمله موجّهات النظام التي تُضبط عند بدء الوكيل).
- فحصت ولم أغيّر: CLIProxyAPI لا يعيد المحاولة بنفسه (`request-retry: 0`، `max-retry-interval: 0`، التبريد مطفأ)؛ ودور Claude Code
  البسيط يرسل طلبًا واحدًا (قِسته بالثنائي الحقيقي) فلا تفسّر الطلبات المتوازية الرفض. تأخّر أول دور لهرمز (69 ث ثم سريع) بداية باردة
  على الأغلب (تحميل مشروع Antigravity أول مرة)؛ لم أتحقق منه من السجلات — متابعة.
- أُسقط بطلب المالك: بقاء سطر البديل بعد إعادة الرسم (مسار الأحداث يحفظه).

الملفات: `models/gateway/gateway.ts` و`tokens.ts` و`testing/fake-cliproxy.mjs` و`gateway.test.ts`، `agents/runner.ts` و`ports.ts`
و`runner-gateway.test.ts` و`runner.test.ts`، `sessions/{engine,realtime,run-reducer,ports}.ts`، `i18n/{ar,en}.json` (الخادم والويب)،
العقد `events/sessions/run.status.schema.json` و`events/README.md` و`x-rt-events` في `openapi.yaml`، الويب `chat/{transcript,turns,
RunStatus,RunFailureNotice}.ts(x)` و`realtime/envelope.ts` واختبارات `model-status.test.ts` و`run-quota-notice.test.tsx`،
`tests/container/fake-provider.mjs` و`proof/attachments/hermes-stub.mjs` (يقرآن المجلد بالصيغة الجديدة).

### لا تنبيه على الجوال لرد تشاهده (DECISIONS §149)
(المالك: «اي رد يوصلني تنبيه على جوالي… اني انا فاتح
  الصفحة المفروض ما يرسلي تنبيه»): العميل يقول على `/rt/sessions` أمرًا جديدًا `viewing { session_id }` ما دامت المحادثة
  مفتوحة والصفحة أو التطبيق في الواجهة (الويب: التبويب ظاهر ومركّز؛ iOS: المشهد نشط؛ Android: النشاط مستأنف)، ويكرّره كل
  20 ثانية، و`null` حين يتوقف. المركز يحفظه في الذاكرة لكل مقبس 45 ثانية ويمسحه عند انقطاع المقبس. لانتهاء الرد أو فشله
  أو طلب موافقة في محادثة يشاهدها: يُكتب التنبيه داخل التطبيق كما هو (العدّاد والصندوق) ولا يُرسل للجوال. المحادثات
  الأخرى والتطبيقات القديمة كما كانت. نُفّذ على الويب وiOS وAndroid.


#### التجربة الحية الثانية (preview.41): لماذا يفشل Claude Code وحده على Gemini، والحساب الذي يبرّد نفسه
بثنائي CLIProxyAPI 8.0.4 الحقيقي، وملف حساب Antigravity يشير إلى بديل لخادم Google، وClaude Code الحقيقي:
- **السبب الأول — عدّ الرموز**: Claude Code يسأل `count_tokens` نحو 15 مرة عند بدء الدور (عددتها عند البوابة)، وCLIProxyAPI يحوّل
  كلًّا منها إلى `countTokens` عند Antigravity، فيرفضها حدّ Google بـRESOURCE_EXHAUSTED، والرفض كان يُسقط نموذج الدور كله — لهذا
  نجح هرمز وGemini CLI على الحساب والنموذج نفسيهما وفشل Claude Code. **الإصلاح**: البوابة تجيب `/v1/messages/count_tokens` بنفسها
  بتقدير (نحو 4 بايت للرمز من النظام والرسائل والأدوات)، ولا يصل أيّها إلى مزوّد. اختبار حقيقي جديد يفشل على الكود القديم بالضبط
  كما رآه المالك ويمر بعده.
- **السبب الثاني — التبريد**: تسجيل الدخول (§143) كان يضبط حقل الحساب `disable_cooling: false`، وهو يغلب `disable-cooling: true`
  في الإعداد، فبعد 429 واحد يرفض CLIProxyAPI كل طلب لاحق محليًا («All credentials … are cooling down»). أثبتّه بالثنائي الحقيقي
  (الحقل false: الطلبان التاليان لا يصلان Google؛ true: يصلان). **الإصلاح**: `true` عند التسجيل، وللحسابات الموجودة مرة في كل تشغيل.
- **النص الخام**: سطر البديل وإشعار الفشل يقولان جملة المركز وحدها؛ كلام المزوّد (ورسالة داخل JSON مستخرجة منه) في
  `Run.error.details.said` وسجل المركز.
- فحصت ولم أجد سببًا: طلب الرسالة نفسه (`max_tokens` 32000 يُسقطه CLIProxyAPI، و`thinkingLevel: high`) يصل ويُجاب عند البديل.

### السحب للرد على الجوال، والضغط المطوّل على رد الوكيل (DECISIONS §150)
طلب المالك: «اذا المستخدم سحب المحادثة يسار يخليني كاني برد عليها نفس التيليقرام»، وأن يفتح الضغط المطوّل على رسالة الوكيل
القائمة نفسها التي تفتح على رسالته.
- **السحب للرد (iOS وAndroid)**: سحب أفقي على فقاعة (رسالتك أو رسالة الوكيل) يحرّكها نحو بداية القراءة ويُظهر سهم الرد
  خلفها: يسارًا في الإنجليزية (تيليقرام)، يمينًا في العربية. بعد 60 نقطة اهتزاز خفيف، والإفلات هناك يردّ؛ بعدها تتحرك بثلث
  سرعة الإصبع حتى 96. يُحسم المحور مرة واحدة عند أول حركة بعد عتبة اللمس: بداية أفقية غالبًا (|dx| > 1.5 |dy|) نحو بداية
  القراءة فقط، وإلا فهو تمرير القائمة. لا على رد يُبث ولا على الغلاف الفارغ. «تقليل الحركة» يعيدها بلا حركة، وVoiceOver
  وTalkBack لهما إجراء «ردّ».
- **تداخل إيماءة الرجوع في iOS**: الرجوع التفاعلي يبدأ من الحافة الأمامية ويتحرك نحو الخلفية (يمينًا في الإنجليزية، يسارًا
  في العربية)، وسحب الرد في الاتجاه المعاكس، فلا يتنافسان؛ وعند الحافة نفسها تفوز إيماءة النظام. وفي Android إيماءة الرجوع
  من حافتي الشاشة، وتفوز عند الحافة.
- **مسار رد واحد**: السحب يستدعي «الرد على هذه» نفسه من قائمة الرسالة: الشريط المقتبس مع «×» فوق المحرّر، والرسالة تُرسل
  بـ`reply_to_message_id` كما يرسلها الويب، فيصل الاقتباس لكل وكيل ووقت تشغيل بالطريقة نفسها. واختيار الرد (سحبًا أو من
  القائمة) يضع المؤشر في المحرّر ويفتح لوحة المفاتيح.
- **الضغط المطوّل على رد الوكيل**: القائمة نفسها (نسخ، قراءة بصوت، رد، تفرّع من هنا)، و«…» تحت الرد باقٍ. في iOS المعاينة أول
  اثني عشر سطرًا من الرد لا البطاقة كلها؛ وقائمة Android بلا معاينة كما لرسالة الشخص. لا على رد يُبث.
- الملفات: Android `ui/components/SwipeToReply.kt` (جديد) و`ChatParts.kt` (السحب، الضغط المطوّل، تركيز المحرّر)
  و`ui/screens/ChatScreen.kt` ونصوص `i18n/chat_controls.*.json`، واختبار `testDebug/.../SwipeToReplyUiTest.kt`؛ iOS
  `Chat/SwipeToReply.swift` (جديد) و`Chat/ChatScreen.swift` و`Chat/ChatParts.swift` و`Chat/ChatControlsViews.swift`
  ونصوص `i18n/chat_controls.*.json`، واختبار `CoreHubTests/SwipeToReplyTests.swift`.
- الفحوص: `./gradlew :app:testDebugUnitTest --tests hub.core.android.ui.SwipeToReplyUiTest` → 7 ناجحة؛ `compileDebugKotlin`
  ناجح؛ iOS يبنيه ويختبره CI (لا Xcode هنا)؛ والإيماءة نفسها في SwiftUI تحتاج تجربة على جهاز.

#### قيد المالك: لا نُضعف Claude من أجل Gemini («ما ابي نخرب كلود علشان جيميناي»)
أي تعديل على طلب Claude Code (مستوى التفكير، الأدوات، `max_tokens`) يُحصر في الحالة التي يثبت السجل فشلها: نموذج Google (Gemini، Gemma
— عبر Google أو Antigravity أو Vertex أو بروكسي) والسبب نفسه؛ أصغر تغيير ينجح (مستوى تفكير أدنى تقبله Google قبل «إيقافه»)؛ ولا شيء
لنماذج Claude — ومنها Claude عبر Antigravity — فطلبها يصل كما أرسله Claude Code بايتًا ببايت؛ والاختبارات تثبت الأمرين. سجل كل رفض في هذا الـPR.

#### سجل المالك (preview.43) والإعادة المتدرجة
السجل: طلب Claude Code إلى Antigravity · gemini-3.8-flash-high رُفض «Resource has been exhausted»، والنموذج نفسه **أجاب** طلب Chat
البسيط من البوابة بعده بلحظة (`readFromChatRoute:false` في سطر الإعادة، والانتقال للسلسلة بعد 0.9 ث بلا انتظار — مسار «أجاب الفحص»
في الكود: أعيد الطلب نفسه فرُفض ثانية فنزلت السلسلة؛ ولم يُسجَّل الرفض الأول). فالرفض لشكل طلب Claude Code لا للحساب. الإصلاح:
- حين يرفض نموذج Google طلبًا ويجيب الطلب البسيط، يُعاد السؤال أخفّ خطوة خطوة: **تفكير أدنى** (`effort` → `low`، ميزانية التفكير
  → 1024، `thinkingLevel` → `low`)، ثم **بلا تفكير**، ثم **وصف أدوات مختصر** (الأدوات نفسها ومعاملاتها، بلا أوصاف المخطّط، ووصف كل أداة
  160 حرفًا). الخطوة التي أجابت تبقى لبقية الجلسة، والسجل يسمّيها. إن رُفضت كلها: الانتظار والسلسلة كما كانا.
- نماذج Claude وكل نموذج غير Google لا يتغيّر طلبها أبدًا (اختبار: `claude-*` المرفوض يصل طلبه بتفكيره وجهده كما أُرسل وتتولى السلسلة).
- السجل يقول الآن: كل رفض كما جاء، ونتيجة الطلب البسيط («answered» أو «refused too»)، وكل إعادة أخف، والتي أجابت.
- اختبار حقيقي: Antigravity البديل يرفض `thinkingLevel: high`، فيجيب Claude Code بعد خفض التفكير (يصل Google `thinkingLevel: low`،
  لا إيقافه).

#### سجل المالك (preview.44): مسار Claude في CLIProxyAPI وحده يرفض؛ Claude Code على نموذج Google يذهب طريق Chat
الدليل: Gemini CLI وستة وكلاء على سلك Chat (Goose وOpenCode وQwen وKimi وGrok وPi) أجابوا على صف Antigravity نفسه، والخطوات الأخف
كلها رُفضت على `/v1/messages`. فالرفض من معالج Claude في CLIProxyAPI لا من الحساب ولا من شكل الطلب.
- **مقارنة ما يصل Google** من المسارين (بديل Antigravity، الطلب نفسه): نقطة النهاية واحدة (`streamGenerateContent?alt=sse`)، والنموذج
  و`userAgent: antigravity` و`requestType: agent` والمشروع والرؤوس والأدوات و`systemInstruction` متطابقة تقريبًا. الفروق من مسار
  Claude: يضيف `generationConfig.thinkingConfig {thinkingLevel: "high"}`؛ ويُسقط أول نص نظام (`x-anthropic-billing-header: cc_version=…`)
  ومسار Chat يبقيه؛ ويحقن معامل `reason` إلزاميًا في الأدوات بلا معاملات (أداتان)؛ ويدمج كتل نص المستخدم في محتوى واحد بثلاثة أجزاء؛
  و`sessionId` يُشتق بطريقة أخرى.
- **الإصلاح**: `models/gateway/anthropic-chat.ts` (جديد): لطلب `/v1/messages` على **نموذج Google فقط** (`googleModel()`) تترجم البوابة
  طلب Anthropic إلى OpenAI Chat (النظام، الصور، `tool_use` → `tool_calls`، `tool_result` → رسائل `tool` مع «Error: » للخطأ، `tool_choice`،
  `effort`/ميزانية التفكير → `reasoning_effort`؛ تُسقط كتل التفكير من التاريخ والأدوات الخادمية بلا مخطط) وترسله إلى `/v1/chat/completions`
  في CLIProxyAPI، ثم تعيد الجواب إلى Anthropic: بثًّا بأحداث SSE (`message_start`، كتل التفكير والنص تُبث، استدعاءات الأدوات تُجمع لكل
  فهرس وتُرسل كاملة عند النهاية بكتلة `tool_use` و`input_json_delta` واحد، `message_delta` بسبب التوقف والاستهلاك، `message_stop`)، أو JSON
  واحدًا، والخطأ بصيغة خطأ Anthropic. الاستهلاك يُحسب من أجزاء Chat الأصلية.
- **Claude لا يُمس**: نموذج `claude-*` (ومنه Claude عبر Antigravity) يذهب إلى `/v1/messages` كما أرسله Claude Code بايتًا ببايت
  (اختبار: `x-fake-path` = `/v1/messages`، التفكير والجهد كما أُرسلا).
- **الاختبارات**: وحدة `anthropic-chat.test.ts` (4)؛ البوابة: ترجمة بأداتين متداخلتين ونص عربي وتفكير واستهلاك وتوازن الكتل، وClaude بلا
  تغيير، ونموذج Google يرفضه مسار Anthropic في البديل ويجيب عبر Chat؛ وحقيقي: Claude Code الحقيقي على نموذج Google عبر CLIProxyAPI الحقيقي
  وبديل Antigravity يستدعي أداة ويعود بنتيجتها ويجيب بالعربية.

#### سجل المالك (preview.45): طريق Chat يُرفض أيضًا — تشخيص لمرة واحدة في الجلسة
السجل: الطلب المترجَم خرج على `/v1/chat/completions` ورُفض 429، والطلب البسيط على Chat **أجاب**، و«تفكير أدنى» و«بلا تفكير» تُخطّيا (لا
تفكير في الطلب المترجَم)، و«الأدوات مختصرة» رُفض، ثم الانتظار ثم السلسلة. فالمسار ليس السبب: شيء في **محتوى** طلب Claude Code (وطلبات
OpenCode الكبيرة بأدوات تمر).
- **التشخيص** (`models/gateway/bisect.ts`، جديد): لـClaude Code على نموذج Google فقط، حين يُرفض ويجيب الطلب البسيط، مرة واحدة في الجلسة
  لكل نموذج، تسأل البوابة النموذج ست صيغ من الطلب المرفوض نفسه (البث والرؤوس وmax_tokens كما هي؛ تُقرأ حتى أول كلمة أو الرفض ثم تُترك):
  1) بلا سطر `x-anthropic-billing-header`؛ 2) جملة الهوية («You are Claude Code…» / «You are a Claude agent…») بجملة محايدة؛ 3) بلا أدوات؛
  4) مخططات الأدوات منظّفة لـGemini (حذف `$schema` و`additionalProperties` و`propertyNames` و`patternProperties` و`format`
  و`exclusive*` و`const` و`examples` و`$ref/$defs`، ودمج `allOf`)؛ 5) موجّه النظام وحده؛ 6) بلا رؤوس الوكيل (`user-agent: claude-cli…`،
  `anthropic-beta`…) — أضفتها لأن الطلب البسيط يُرسل بلا رؤوس الوكيل والطلب الحقيقي بها.
- كل خطوة في السجل: `gateway: bisect step N: answered|refused|not asked` مع التغيير والحالة وكلام المزوّد منقّحًا.
- **ما يُحفظ**: أول خطوة آمنة أجابت (1 أو 4 أو 6) تبقى طريقة السؤال لبقية الجلسة (`gateway: the session keeps asking the model with this
  bisect step`) ويُعاد الطلب بها فورًا. 2 و3 و5 تُسجَّل فقط. إن لم تُجب خطوة آمنة: الخطوات الأخف ثم الانتظار ثم السلسلة كما كانت.
- **Claude لا يُمس**: لا تشخيص لنموذج Claude (اختبار: لا سطور bisect، والطلب على `/v1/messages`).
- الاختبارات: خمسة في `gateway.test.ts` (سطر الفوترة يُحفظ 1، المخطط يُحفظ 4، الرؤوس تُحفظ 6، الهوية تُسجَّل فقط ولا تشخيص ثانٍ، Claude بلا
  تشخيص)؛ وحقيقي: بديل Antigravity يرفض كل طلب فيه سطر الفوترة، فيجيب Claude Code الحقيقي عبر CLIProxyAPI الحقيقي بعد التشخيص (يثبت أيضًا
  أن مسار Chat في CLIProxyAPI يحمل سطر الفوترة إلى Google).

#### Codex على «افتراضي · gemini-3.8-flash-high» يفشل فورًا ببطاقة «يحتاج مفتاح OpenAI أو تسجيل دخول ChatGPT»
- **لم أستطع إعادته هنا**: Codex الحقيقي (codex-acp 2.1.1) على صف Antigravity افتراضيًا عبر البوابة يجيب (اختبار حقيقي
  `it.each(['codex','gemini-cli'])`)، والمصادقة على البوابة ببروتوكول codex-acp المدمج. فالسبب في إعداد المالك لم يُعرف بعد.
- **ما تغيّر**: إن بدأ وكيل على البوابة ثم رفض البدء طالبًا تسجيل دخوله هو (auth / sign in / API key / 401 …) لم يعد يظهر البطاقة القديمة:
  يفشل الدور بـ`provider_not_configured` وجملة تقول إن الوكيل لم يأخذ بوابة المركز عند بدئه وطلب تسجيل دخوله، وفي السجل سطر
  `agents: the agent asked for its own sign-in although it was started on the model gateway` بالنموذج والمزوّد وأسماء متغيرات البيئة التي
  مُرّرت له (الأسماء لا القيم). ورمز الوكيل يُلغى. اختبار وحدة في `runner-gateway.test.ts`.
- **المطلوب**: سطور `agents:` و`gateway:` من سجل المالك حول دور Codex الفاشل (ومنها السطر الجديد وحقل `wired`) لإيجاد السبب.

#### الخط الزمني لدور فشل قبل أن يبدأ
محادثة جديدة فشل دورها قبل البدء كانت تقول «هذه المحادثة من قبل أن يسجّل المركز أوقات الخطوات…». الآن إن لم يكن في المسار إلا ما أُرسل
(`timing: none` وكل الخطوات `input`) يقول: «انتهى الدور قبل أن يبدأ الوكيل، فلا خط زمني — فقط ما أُرسل.» (`TrajectoryView.tsx`،
`i18n/{ar,en}.json`، اختبار في `tests/trajectory.test.tsx`).

### «رجوع إلى المحادثات» و«رجوع إلى الوكلاء» في أسفل الشريط الجانبي (DECISIONS §151)
قرار المالك (2026-10-01): صف الرجوع في الشريط الجانبي للإعدادات ولصفحات الوكيل صار في الأسفل، مثبّتًا فوق صندوق التذييل
مباشرة (الاتصال والاسم والترس والخروج، ثم اللغة والسمة والإصدار)، خارج القائمة التي تتمرّر فيبقى ظاهرًا مهما تمرّرت، وTab يصل
إليه قبل التذييل. الشكل والأيقونة والرابط كما هي، والاتجاه صحيح في العربية. يحلّ محل موضعه في الأعلى في §33 (2026-09-24).
درج الويب على الجوال هو الشريط نفسه فيتبعه؛ تطبيقا الجوال كما هما.
- الملفات: `packages/web/src/shell/Sidebar.tsx`؛ الاختبارات `tests/agents-top-level.test.tsx`، و`e2e/zzz-agents-top-level.spec.ts`،
  و`e2e/smoke.spec.ts` (نافذة قصيرة والقائمة متمرّرة: الصف ظاهر فوق التذييل)، ولقطات `e2e/shots` محدّثة.
- الفحوص: `vitest run tests/agents-top-level.test.tsx …` → 22 ناجحة؛ Playwright `smoke` و`zzz-agents-top-level` و`zz-design`
  بعامل واحد → 26 ناجحة.
- بعد ملاحظة المالك على preview.44 (الصف بدا عنصرًا آخر من القائمة): المنطقة المثبّتة لها فاصل رفيع فوقها (border-top) بينها
  وبين القائمة المتمرّرة، والصف مرسوم زرًّا بحدّ 1px وحواف الأزرار الثانوية («اختبر»/«تعديل») ومشغّلات القوائم، بعرض الشريط
  مع الحافة المعتادة؛ وبلا فاصل ثانٍ بينه وبين التذييل فيُقرأ جزءًا منه. السهم والنص وحالات المرور والتركيز كما هي، والاتجاه
  صحيح في العربية؛ في الإعدادات وفي صفحات الوكيل (`SidebarGroup pinned`، `styles/kit.css`). Playwright الثلاثة → 26 ناجحة،
  واللقطات محدّثة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
حدث جديد `run.status` على `/rt/sessions` (إضافة؛ `contracts:compat` OK مقابل v1.1.6) وإضافته إلى `x-rt-events` لـ`sessions.createRun`.
`Run.error.details` يحمل `reason` بثلاث قيم و`said` (الحقل موجود في غلاف `Error`). وقبل ذلك: لا شيء. `check_error` كان دائمًا جملة يعرضها العميل؛ الآن بلغة الطلب.
- أمر جديد من العميل إلى المركز `viewing` على `/rt/sessions`، موثّق في `events/README.md` (إضافة فقط؛ لا عملية HTTP ولا
  مخطط حدث؛ §149).

## الملفات والتأثير
- الخادم: `models/catalogue.ts` (طلبات «افحص الآن» لكل مزوّد، `company`)، `models/subscriptions.ts` (الطلبات بالترتيب،
  الأسباب، القراءات)، `models/gateway/cliproxy-management.ts` (`projectId`)، `models/service.ts` (حالة إعادة التشغيل)،
  `models/index.ts` و`agents/runner.ts` (`busyWith('hermes')`)، `lib/redact-text.ts`، ونصوص `i18n/ar.json` و`en.json`.
- الاختبارات: `models/gateway/subscription-usage.test.ts` (جديد، بأشكال ردود مسجّلة)، `models/gateway/hermes-restart.test.ts`،
  `agents/update-policy.test.ts`.
- §149: الخادم `sessions/viewing.ts` (جديد) و`sessions/realtime.ts` (الأمر) و`sessions/index.ts`، `notify/index.ts`
  (`push: false`)، `modules/index.ts` (المشاهدة قبل الإرسال)؛ الويب `realtime/useViewing.ts` (جديد) و`chat/ChatScreen.tsx`؛
  iOS `Chat/ChatModel.swift` و`Chat/ChatScreen.swift`؛ Android `realtime/Realtime.kt` و`ui/screens/ChatScreen.kt`؛
  الاختبارات `tests/unit/push-viewing.test.ts` و`web/tests/viewing.test.tsx`؛ `contracts/events/README.md`.
- التوثيق: DECISIONS §147 و§149.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ tsc --noEmit -p tsconfig.json   (packages/server، packages/web) → (exit 0)
$ vitest run --maxWorkers=2 src/modules/models src/modules/agents/update-policy.test.ts src/modules/agents/runner.test.ts tests/unit
  (packages/server) → كل ملفات models وagents ناجحة؛ 3 اختبارات في tests/unit/terminal.test.ts تفشل على هذا الجهاز وحده
  (bash: cannot set terminal process group — بيئة الطرفية، لا علاقة لها بالتغيير؛ CI أخضر)
$ COREHUB_REAL_GATEWAY=1 vitest run src/modules/models/gateway/subscriptions.real.test.ts → 4 passed
$ vitest run src/modules/models/gateway/subscription-usage.test.ts src/modules/models/gateway/subscriptions.test.ts → 16 passed
$ vitest run src/modules/models/gateway/hermes-restart.test.ts src/modules/agents/update-policy.test.ts → 28 passed
$ vitest run tests/unit/push-viewing.test.ts → 3 passed
$ vitest run tests/viewing.test.tsx   (packages/web) → 2 passed
$ node scripts/i18n-check.mjs → OK · node scripts/i18n/limits.mjs → OK
$ ./gradlew --no-daemon :app:compileDebugKotlin (apps/android) → نجح
CI على أول دفعة (aed9835a): 15 ناجحًا.
preview.44 (طريق Chat لـClaude Code على Google، بدء Codex، الخط الزمني):
$ eslint (gateway، agents، web/src/chat) → OK · tsc --noEmit (server، web) → exit 0 · change-record:check → OK
$ vitest run --maxWorkers=2 src/modules/models src/modules/agents src/modules/sessions (packages/server)
  → Test Files 121 passed | 27 skipped · Tests 1345 passed | 106 skipped
$ vitest run tests/trajectory.test.tsx tests/model-status.test.ts tests/run-quota-notice.test.tsx (packages/web) → 18 passed
$ COREHUB_REAL_GATEWAY=1 COREHUB_REAL_GATEWAY_ALL=1 vitest run --maxWorkers=1 model-gateway.real.test.ts gateway-stream.real.test.ts
  → Test Files 2 passed · Tests 38 passed
preview.45 (التشخيص):
$ eslint models/gateway → OK · tsc --noEmit (server) → exit 0
$ vitest run --maxWorkers=2 src/modules/models src/modules/agents → Test Files 93 passed | 26 skipped · Tests 1140 passed | 102 skipped
$ COREHUB_REAL_GATEWAY=1 vitest run model-gateway.real.test.ts -t Antigravity → 5 passed
$ COREHUB_REAL_GATEWAY=1 COREHUB_REAL_GATEWAY_ALL=1 vitest run --maxWorkers=1 model-gateway.real.test.ts gateway-stream.real.test.ts → Test Files 2 passed · Tests 39 passed
```

## المخاطر والرجوع
- عناوين الاستهلاك غير موثّقة عند المزوّدين وقد تتغير؛ القراءة الفاشلة تُقال بجملة ولا تغيّر شيئًا.
- لم تُجرَّب الطلبات الجديدة على حساب Google حقيقي بعد (أشكال الردود من مصدر CPAMC وCLIProxyAPI)؛ يلزم «افحص الآن» على
  حساب المالك بعد النشر.
- الرجوع: إرجاع هذا الـPR؛ لا ترحيل ولا ملفات جديدة في البيانات.

## التسليم والخطوة التالية
PR مسودة إلى main، ثم تجربة المالك «افحص الآن» على Antigravity وChatGPT وClaude في نسخة المعاينة التالية.

### صفّ متغيّر في نافذة الخطوة يخرج من المربع (2026-10-01)
المالك: في نافذة «إرسال رسالة»، لوحة INPUT، خرج `{{steps.agent_1.output}}` مع عنوان الخطوة خارج المربع. السبب: `truncate` على عنصرَي flex بلا `min-w-0` فلا ينكمشان. الإصلاح في `NodeDialog.tsx` (`Variable`): `flex-wrap` للسطر و`min-w-0 max-w-full truncate` للمسار والعنوان؛ العنوان الطويل ينزل لسطره ويُختصر داخل البطاقة. فحص: `tsc` للويب.
