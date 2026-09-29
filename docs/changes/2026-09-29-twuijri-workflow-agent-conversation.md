# خطوة الوكيل تتحدث في المحادثة نفسها في كل تشغيل
المسؤول: twuijri · الفرع: batch/2026-09-29c · الحالة: review

## المشكلة والهدف

طلب المالك (٢٠٢٦-٠٩-٢٩، عام لكل هاب، لا منطق خاص بـ ClickUp أو بشخص): خطوة «وكيل» في محرر سير العمل تفتح
**محادثة جديدة في كل تشغيل**، فتمتلئ قائمة المحادثات بمحادثة لكل تشغيل. المطلوب: وضع «المحادثة» للخطوة —
جديدة لكل تشغيل (السلوك الحالي والافتراضي) أو **محادثة موجودة واحدة** يُرسَل إليها نص كل تشغيل، مع اختيار
المحادثة، و«اختبر المحادثة»، و«أنشئها إن لم توجد» (مطفأ افتراضيًا)، وصلاحيات يفرضها الهاب، وتسلسل التشغيلات
المتزامنة، ومخرجات إضافية للخطوة — بلا أي كسر للتطبيقات أو الهابات القديمة.

## القرار والموافقات

(DECISIONS §136، مقترح — للمالك أن يؤكد)

- **الشكل في العقد**: حقل اختياري `WorkflowNode.conversation` من نوع `WorkflowAgentConversation`:
  `mode` (`new` افتراضي أو `reuse`، نص عادي لا enum حتى لا يعجز هاتف قديم عن فك قيمة جديدة)، `session_id`
  (معرّف أو قالب `{{…}}` يُملأ بـ `render` في `expr.ts` كالنص)، `create_if_missing` (مطفأ)، `title` (قالب).
  يُرفض عند الحفظ: وضع غير معروف `conversation_mode_unknown`، `reuse` بلا معرّف `conversation_id_missing`،
  معرّف ليس ULID ولا قالبًا `conversation_id_invalid`، ومسارات القوالب تُفحص كالنص.
- **الصلاحيات (في الهاب لا في الواجهة فقط)**: المحادثة يجب أن تكون في بروفايل التشغيل كما يصله الشخص الذي يعمل
  التشغيل باسمه (تشغيل المُشغِّل الخارجي باسم منشئه §123). محادثة بروفايل آخر تُجاب تمامًا كالمفقودة
  (`not_found`) فلا يُكشف وجودها. مرفوضة: محادثة مقعد في غرفة، ومساعد شخص آخر (`global_agent`) — `not_allowed`.
- **الوكيل** (قرار): للمحادثة وكيل واحد؛ يجب أن يطابق وكيلُ الخطوة وكيلَ المحادثة وإلا تفشل الخطوة
  (`agent_mismatch`) — لا تبديل صامت. ويجوز ترك وكيل الخطوة فارغًا فيجيب وكيل المحادثة (ولا يظهر تحذير
  `agent_missing` لخطوة `reuse`). منتقي الويب يضع وكيل المحادثة المختارة في الخطوة تلقائيًا. النموذج: نموذج
  الخطوة إن سمّت واحدًا، وإلا نموذج المحادثة.
- **المحادثة المفقودة**: «أنشئها إن لم توجد» مطفأ ← الخطوة تفشل بسبب واضح («the conversation <id> was not found
  in this profile…») ولا تُنشأ محادثة بصمت. مفعّل ← تُنشأ محادثة (المصدر `workflow`، بوكيل الخطوة، بالعنوان
  المعطى أو عنوان الخطوة) ويذهب الدور إليها، **وتُعاد الخطوة لتشير إليها** إن كان المعرّف المكتوب ثابتًا (كما
  تفعل خطوة «أرسل رسالة» لمحادثة محذوفة §124، دون رفع نسخة الرسم)، مع **إشعار في صندوق الوارد** وسطر سجل
  `workflow conversation made`. المعرّف القالب لا يُعاد توجيهه. التشغيلات المنتظرة للمعرّف المفقود نفسه تستخدم
  المحادثة التي أنشأها الأول (لا محادثتان).
- **التزامن**: الأدوار في المحادثة الواحدة **واحدًا بعد الآخر كاملة**: ينتظر التشغيل انتهاء أدوار سير العمل
  التي سبقته لهذه المحادثة وخلوّها من أي دور جارٍ (ولو دور شخص)، ثم يكتب نصه ويبدأ. فالسجل: نص، رد، نص، رد؛
  ولا يتلقى Hermes دورًا ثانيًا أثناء الأول (`already_running`)؛ ومخرج كل تشغيل هو ردّ دوره فقط (يُقرأ برقم
  تشغيله). الانتظار محدود بـ ١٠ دقائق (`conversationWaitMs`)، بعدها — أو إن أنهت مهلةُ الخطوة أو ميزانيةُ
  التشغيل الخطوةَ — تفشل الخطوة «the conversation was busy…» ولا يُكتب شيء في المحادثة.
- **المخرجات**: `WorkflowStep.session_id` (موجود منذ §52 لكنه كان `null` دائمًا) صار يُملأ لكل خطوة وكيل،
  و`WorkflowStep.message_id` جديد اختياري (ردّ الوكيل)؛ `output` كما هو نصًا. والخطوات اللاحقة تقرأ
  `{{steps.<id>.conversation_id}}` (و`session_id`) و`message_id` و`run_id` و`status`، وتبقى مقروءة عند
  إعادة التشغيل من خطوة لاحقة.
- **«اختبر المحادثة»**: عملية إضافية `schedules.checkWorkflowConversation` (`POST /workflows/conversation-check`)
  بالدالة نفسها التي يطبقها التشغيل: `ready` / `busy` / `not_found` / `not_allowed` / `agent_mismatch` مع العنوان
  والوكيل والدور الجاري والسبب؛ لا ترسل ولا تحفظ شيئًا. القالب `400 conversation_id_template`.
- **الويب** (بتوجيه المالك أثناء العمل): **المنتقي هو الأداة الرئيسية** — محادثات البروفايل بالبحث بالعنوان، مع
  آخر نشاط والوكيل (مقاعد الغرف لا تُعرض)؛ و«الصق معرّف محادثة بدلًا من ذلك» ثانوي (القوالب فيه فقط)؛ المعرّف
  الثابت — مختارًا أو ملصوقًا — يُفحص فورًا ويظهر بعنوانه أو بسبب رفضه؛ زر «اختبر المحادثة»؛ مفتاح «أنشئها إن
  لم توجد» (مطفأ) مع عنوان المحادثة الجديدة. عرض التشغيل فيه «افتح المحادثة» عند الرد. أضفت لـ `Combobox`
  خاصية اختيارية `nouns` حتى لا يقول «2 models» لقائمة محادثات (الافتراضي كما كان).
- **الهواتف**: فحصت الرحلة: نماذج Kotlin/Swift المولّدة تُسقط الحقول غير المعروفة عند الفك، فالهاتف **القديم**
  يرسل عقدة الوكيل بلا الحقل — والهاب يحتفظ بالقديم (`keepRules`، مثبت في اختبار). الهاتف المبني من هذا العقد
  يفك الحقل ويعيد إرساله (صار في `WorkflowNode` المولّد)، ويعرض الوضع والمعرّف و«تُنشأ إن لم توجد» للقراءة فقط
  في خطوة الوكيل (iOS وAndroid). **تعديله على الهاتف متابعة**.
- اختبار الخطوة (`testWorkflowStep` مع التنفيذ) يبقى في محادثة تجريبية خاصة به كما كان، لا في المحادثة المختارة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

إضافي فقط: `WorkflowNode.conversation` (اختياري)، مخططات `WorkflowAgentConversation` و`WorkflowConversationCheck`
و`WorkflowConversationCheckResult`، `WorkflowStep.message_id` (اختياري)، والعملية
`schedules.checkWorkflowConversation`. `pnpm contracts:compat`: لا كسر مقابل v1.1.5. `session_id` كان مُعلنًا
وقابلًا لـ null وصار يحمل قيمة — لا يغيّر معناه.

## الملفات والتأثير

- الخادم: `packages/server/src/modules/schedules/{agent-conversation.ts (جديد),schema.ts,service.ts,workflow-engine.ts,index.ts}`،
  `packages/server/src/modules/sessions/{service.ts,index.ts}`، `packages/server/src/modules/index.ts`؛
  الاختبار `packages/server/tests/unit/workflow-agent-conversation.test.ts` (جديد).
- العقد: `packages/contracts/openapi.yaml`؛ `docs/contracts/DECISIONS.md` §136؛ `docs/STATUS.md` (370 عملية).
- الويب: `schedules/workflows/{ConversationForm.tsx (جديد),model.ts,queries.ts,StepPanel.tsx,WorkflowEditor.tsx}`،
  `ui/Combobox.tsx` (خاصية `nouns` اختيارية)، `i18n/{ar,en}.json`؛ الاختبارات `tests/workflow-conversation.test.tsx`
  (جديد)، `tests/workflow-editor-model.test.ts` (الحقل في التسلسل)، `e2e/zzzzzzzzzzzzzzzz-workflow-conversation.spec.ts`
  (جديد، الرحلة 43)، `e2e/hub.ts` (رد مكتوب لـ «تابع المحادثة: …»).
- الهواتف: `apps/ios/CoreHub/Screens/WorkflowEditor.swift`، `apps/android/.../WorkflowEditor.kt`، ونصوصهما ar/en.

## الفحوص (الأوامر ونواتجها الفعلية)

اختبارات الخادم الجديدة على كود main (‏`git checkout origin/main -- packages/server/src packages/contracts/openapi.yaml`):

```text
     × sends every run into the same conversation, keeps its history in order, and says where
     × a new conversation per run stays the default, and the step now names it
     × fails clearly on a missing, a deleted or another profile’s conversation, and never opens one in silence
     × refuses a conversation of another agent, and a step without an agent uses the conversation's
     × makes a missing conversation once when asked, points the step at it, and says so
     × takes two runs one after another in the same conversation, each with its own reply
     × fails a run that waited too long for a busy conversation, without writing into it
     × "Test conversation" answers as the run would, and sends nothing
     × checks the field when the workflow is saved, and an app that does not know it keeps it
      Tests  9 failed (9)
```

بعد التغيير (اختبار الويب الجديد يستورد `ConversationForm` غير الموجود في main فيفشل كله هناك):

```text
pnpm --filter @corehub/server exec vitest run tests/unit/workflow-agent-conversation.test.ts tests/unit/status.test.ts tests/unit/workflow-agent-step.test.ts
      Tests  11 passed (11)
pnpm --filter @corehub/server exec vitest run tests/unit/workflow-agent-step.test.ts src/modules/schedules/ tests/unit/schedule-runs.test.ts tests/unit/task-worktrees.test.ts src/modules/sessions/sessions-run.test.ts
 Test Files  16 passed | 1 skipped (17)
      Tests  170 passed | 3 skipped (173)
pnpm --filter @corehub/web exec vitest run tests/workflow-conversation.test.tsx tests/workflow-editor.test.tsx tests/workflow-editor-model.test.ts
      Tests  38 passed (38)
pnpm --filter @corehub/web exec vitest run tests/workflow-editor.test.tsx tests/workflow-editor-model.test.ts tests/combobox.test.tsx tests/workflow-panel-boundary.test.tsx tests/workflow-conversation.test.tsx tests/workflow-step-output.test.ts
 Test Files  6 passed (6)
      Tests  53 passed (53)
pnpm change-record:check      → change-record  OK — 1 record(s) valid
PLAYWRIGHT_CHANNEL=chrome playwright test zzzzzzzzzzzzzzzz-workflow-conversation --workers=1
  ✓  1 [chromium] › e2e/zzzzzzzzzzzzzzzz-workflow-conversation.spec.ts:52:1 › 43. an agent step talks in the same conversation every run (10.6s)
  1 passed (19.7s)
pnpm lint                     → All matched files use Prettier code style!
pnpm typecheck                → exit 0
pnpm contracts:lint           → Your API description is valid; contracts:lint OK
pnpm contracts:compat         → OK — no breaking change against v1.1.5
pnpm contracts:check-clients  → OK — 1124 client file(s) scanned, 268 contract path(s) known.
pnpm contract:test            → Test Files 20 passed (20), Tests 429 passed (429)
pnpm i18n:check               → web: 3523 keys … ios: 2723 keys … android: 2582 keys, ar/en in parity … OK
pnpm nav:check                → OK — 41 destinations …
```

لا Java على الجهاز، فعملاء Kotlin/Swift وعرض الهاتف يُتحقق منهم في CI (بناء Android واختباراته، ومحاكي iOS).

CI على PR ‏#225 (رأس `002939df`) — كل الفحوص ناجحة:

```text
Android build, unit tests, lint | pass
Build and test on the iOS simulator | pass
Desktop app smoke (Electron under Xvfb against the real hub) | pass
Docker image builds and answers /health | pass
Generate the Swift client (CoreHubClient) | pass
Lint, typecheck, contracts, client tests, build | pass
Lint, typecheck, contracts, tests, build | pass
PR adds or updates a change record | pass
Real Hermes suites (floor) | pass
Real Hermes suites (pinned) | pass
Server unit tests (shard 1/3, 2/3, 3/3) | pass
Translations fit their labels (measured widths) | pass
db:generate + db:migrate (SQLite and PostgreSQL) | pass
Web smoke journeys (Playwright against the real hub) | pass
```

## المخاطر والرجوع

- الطابور وتذكّر «المحادثة التي أُنشئت لمعرّف مفقود» في ذاكرة العملية: إعادة التشغيل تمحوهما، ولا ضرر — التشغيلات
  الجارية تفشل عند إعادة التشغيل كما كانت، والمحادثة المنشأة صارت في الخطوة بإعادة التوجيه.
- دور شخص يُرسَل في اللحظة بين انتهاء الانتظار وكتابة نص التشغيل يدخل طابور الجلسة العادي فيأتي بعده — لا تداخل
  في الرد لأن كل تشغيل يقرأ رده برقمه.
- `session_id` في `WorkflowStep` صار يحمل قيمة لخطوات الوكيل؛ عميل كان يفترضه `null` دائمًا لم يُعثر عليه.
- الرجوع: عكس الالتزامات؛ الحقل اختياري والعملية جديدة، فلا يتأثر عميل قديم، والخطوات المحفوظة بـ `reuse` ستعود
  لمحادثة جديدة لكل تشغيل على الكود القديم (يتجاهل الحقل).

## التسليم والخطوة التالية

- ضمن PR الدفعة `batch/2026-09-29c` إلى main بقرار المالك.
- متابعة: تعديل وضع المحادثة ومعرّفها من الهاتف (iOS/Android)؛ منتقي الويب يعرض آخر 200 محادثة للبروفايل
  (البحث فيها بالعنوان) — ما بعدها يُلصق معرّفه.
