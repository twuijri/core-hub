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
