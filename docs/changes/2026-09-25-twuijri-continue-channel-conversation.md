# «أكمل في كور هب» لمحادثة تيليجرام/واتساب
المسؤول: twuijri · الفرع: feat/continue-channel-conversation · الحالة: review

## المشكلة والهدف
#126 أظهر محادثات تيليجرام وواتساب (وغيرهما) التي يحفظها هرمز في قائمة المحادثات، **للقراءة فقط**،
وترك «أكمل في كور هب» خطوةً تالية مقترحة. المطلوب: زر في المحادثة المقروءة يحوّلها إلى محادثة عادية في
المركز، في البروفايل نفسه، ومعها نص المحادثة سياقًا للوكيل — إما رسالة نظام/سياق، أو أول رسالة من
المستخدم فيها ملخص والنص مرفق ملفًّا نصيًّا؛ نختار واحدًا ونسجّله.

**التكديس**: #126 مكدّس على #121 وكلاهما غير مدموج في `main`، فهذا الفرع من `feat/channel-conversations`
وطلب دمجه إليه (لا إلى `main`)، منفصلًا عن #133 (حدود سير العمل والجداول الشائعة).

## القرار والموافقات
قرار العقد **§58** (مقترح — ينتظر تأكيد المالك):

- **اخترتُ «أول رسالة من المستخدم» لا «رسالة نظام».** الوكيل لا يستلم في أي دور إلا مطالبة ذلك الدور
  (`AgentRunRequest.prompt`) وجلسته هو؛ رسالة نظام أو سياق تُكتب في سجل المركز بلا دور **لا تصل إليه
  أبدًا**. فأول رسالة = كتلة نص (ملخص وقائعي بلغة الشخص: القناة، الطرف الآخر، عدد الرسائل، المدة، «النص
  كاملًا في الملف المرفق؛ اقرأه أولًا»، ثم ملاحظة الشخص إن كتبها) + كتلة ملف فيها النص كاملًا (Markdown)
  يضعه المركز في مجلد مدخلات الدور كأي مرفق.
- **المركز لا يرسلها، العميل يرسلها.** دور يبدأه المركز قبل أن يستمع العميل للمحادثة تضيع بداياته (السبب
  نفسه الذي جعل أول رسالة في «محادثة جديدة» تنتظر الاشتراك)، فالعملية ترد بـ`first_message` والويب
  يسلّمها لشاشة المحادثة بآلية «محادثة جديدة» نفسها (`putFirstMessage`) فتُرسَل حين تستمع.
- **الملخص وقائع لا ملخص نموذج**: بلا دور إضافي يُدفع ثمنه وبلا خطأ محتمل؛ الوكيل يقرأ النص كله في أول
  دور.
- **العنوان** «تيليجرام: أحمد» (بلغة الشخص) ويُعلَّم أنه من الشخص، فلا يستبدله تسمية الوكيل التلقائية.
- **الوكيل**: الويب يختار **هرمز البروفايل** (من كانت القناة تكلّمه) وإلا أول وكيل يستطيع الرد؛ ونافذة صغيرة
  فيها حقل اختياري «ماذا تريد من الوكيل أن يفعل بها؟».
- **المحادثة في القناة لا تُمسّ**، ولا يُكتب شيء في جلسة هرمز.
- رُفض: نسخ الرسائل إلى سجل المحادثة الجديدة (لن يراها الوكيل، وستدّعي أدوارًا لم تحدث)، ورسالة نظام
  (السبب نفسه، ولا دور «نظام» في العقد يرسله عميل)، والكتابة في جلسة هرمز (§55)، وبدء الدور في المركز.
- الخريطة (Graphify) لم تُستعمل: قرأتُ مباشرة `sessions` (الإنشاء، الأدوار، `fork`) و`knowledge` (المرفقات)
  و`channel-conversations.ts` من #126.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عملية جديدة `sessions.continueChannelConversation` (`POST /channel-conversations/{conversation_id}/continue`)
  بـ`ChannelContinueRequest` (`agent_id`، `note`) و`ChannelContinuation` (`session`، `first_message`)؛
  `201`، و`400`/`404`/`422`/`503` موثّقة.
- `events/common.schema.json`: المخططان الجديدان.
- `docs/contracts/DECISIONS.md` §58.

## الملفات والتأثير
- الخادم: `sessions/channel-continuation.ts` (جديد، نقي: النص والملخص والعنوان)، `sessions/service.ts`
  (`continueChannel`)، `sessions/routes.ts` (المسار)، `sessions/ports.ts` + `sessions/unavailable.ts` +
  `knowledge/index.ts` (منفذ المرفقات صار فيه `store`: بايتات يكتبها المركز للشخص تُحفظ رفعًا له)،
  ونصوص الخادم `i18n/{ar,en}.json` (`sessions.continue`).
- الويب: `chat/ContinueChannel.tsx` (جديد: الزر والنافذة)، `chat/ChannelConversationView.tsx` (الزر تحت
  لافتة «للقراءة فقط»)، ونصوص `ar.json`/`en.json` (`sessions.channels.continue`).
- الاختبارات: `sessions/channel-continuation.test.ts` (خادم)، إضافة في
  `tests/contract/channel-conversations.contract.test.ts`، و`tests/channel-continue.test.tsx` (ويب)، ورحلة
  Playwright رقم 33 (`zzzzzzzz-channel-conversations.spec.ts`) تكمل الآن إلى «أكمل في كور هب» على الخادم
  الحقيقي، مع لقطة جديدة `channel-continue-ar-light.png` وتحديث `channel-conversation-ar-light.png` (الزر
  صار تحت اللافتة).
- `e2e/hub.ts`: خادم الرحلات صار يركّب منفذ المرفقات الحقيقي (`attachmentsPort`) كما يفعل جذر التركيب؛ كان
  بلا مرفقات فكانت العملية ترد `503 attachments_not_wired`.
- `ChannelConversationView`: `data-testid="channel-readonly"` صار على اللافتة وحدها والزر بجانبها، فبقي
  تحقق الرحلة من نص اللافتة كما هو.
- في النص العربي تُعزل التواريخ باتجاه يسار→يمين (LRI…PDI)، وإلا ظهرت `2026-09-25` كـ`25-09-2026`
  (ظهر ذلك في أول لقطة).
- `docs/STATUS.md`: 213 من 267 عملية، وسطر sessions.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
typecheck exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 291 client file(s) scanned, 179 contract path(s) known.
$ pnpm i18n:check
i18n:check  server: 159 keys, ar/en in parity
i18n:check  web: 1350 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contract:test
 Test Files  6 passed (6)
      Tests  281 passed (281)
$ vitest run src/modules/sessions/channel-continuation.test.ts        (server)
 Test Files  1 passed (1)
      Tests  4 passed (4)
$ vitest run tests/unit/status.test.ts src/modules/sessions/channel-conversations.test.ts src/modules/knowledge
      Tests  72 passed (72)
$ vitest run tests/channel-continue.test.tsx tests/channel-conversations.test.tsx   (web)
 Test Files  2 passed (2)
      Tests  10 passed (10)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzzzz-channel-conversations.spec.ts
  1 passed (7.3s)
```
أول تشغيل للرحلة فشل مرتين بحق: `503` (خادم الرحلات بلا مرفقات، أُصلح في `e2e/hub.ts`) ثم نص الطرف
الآخر في بيانات الرحلة «أحمد من تيليجرام» (عُدّل التحقق).
اختبار الخادم يمرّ على مخزن الملفات الحقيقي: يُنزَّل النص المرفق ويُقرأ (بلا مخرجات الأدوات)، وتُرسَل
`first_message` كما هي دورًا حقيقيًا (`202`). واختبار الويب يتحقق أن الشاشة الجديدة **ترسل** أول رسالة بعد
الاشتراك. الاختبارات الجديدة تفشل على الكود القديم (لا مسار `continue` ولا زر).

CI على #136 (التشغيل 36106845838)، كلها ناجحة:
```
Lint, typecheck, contracts, tests, build              pass
Web smoke journeys (Playwright against the real hub)  pass
Docker image builds and answers /health               pass
db:generate + db:migrate (SQLite and PostgreSQL)      pass
PR adds or updates a change record                    pass
PR leaves graphify-out/ to the code-map bot           pass
```

## المخاطر والرجوع
- **محادثة فارغة** إن أُغلق التبويب بين الإنشاء والإرسال — كما في «محادثة جديدة» لم يُكتب فيها.
- **النص قد يكون طويلًا** (حتى ٥٠٠ رسالة): ملف واحد يقرؤه الوكيل بأدواته؛ لا يُحشر في نص المطالبة.
- **تغيير منفذ المرفقات** (`store` إلزامي): تنفيذان فقط (`knowledge` و`noAttachments`) وكلاهما محدّث.
- **الرجوع**: إلغاء الطلب؛ لا هجرة. المحادثات التي أُنشئت تبقى محادثات عادية.

## التسليم والخطوة التالية
- طلب دمج إلى `feat/channel-conversations` (#126) بالإنجليزية؛ يُدمج بعد #121 و#126، ثم يصل `main` معهما.
- رحلة #126 (رقم 33) صارت تشمل «أكمل في كور هب» حتى رد الوكيل في المحادثة الجديدة.
