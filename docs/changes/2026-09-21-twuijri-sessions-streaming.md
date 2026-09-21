# وحدة الجلسات والبث الحي (Phase 0)
المسؤول: twuijri · الفرع: feat/sessions-streaming · الحالة: review

## المشكلة والهدف
الجزء الثاني من المرحلة صفر: استبدال أكواد `501` لعمليات `sessions` بتنفيذ حقيقي —
جلسات المحادثة، الرسائل، التشغيلات المتدفّقة (`run`)، نداءات الأدوات، الموافقات،
المقاطعة، تسجيل الاستهلاك، واستئناف البث بعد انقطاع الشبكة. هذا ما تحتاجه تطبيقات
الهاتف لفتح محادثة مع وكيل ورؤية الرد يُكتَب حيًّا (`docs/ROADMAP.md` Phase 0
و Checkpoint A).

## القرار والموافقات
- العقد أولًا: `packages/contracts/openapi.yaml` و`packages/contracts/events/sessions/*`
  هما المرجع؛ ما خالفهما في `docs/domain/` صُحِّح في هذا الفرع.
- الغرفة النظيفة (ADR 0004): لم يُفتَح أي ملف من مصدر Hermes Studio / Ekko Studio
  ولا من نسخة المالك منه. المرجع الوحيد للسلوك هو وثائق هذا المستودع.
- وحدتا `auth` و`agents` تُنفَّذان في فرع مواز (`feat/auth-and-agents`)، فلم يُلمس أي
  ملف تحت `src/modules/auth/` أو `src/modules/agents/`. الاعتماد عليهما عبر منافذ
  ضيّقة عرّفتها وحدة الجلسات نفسها (`src/modules/sessions/ports.ts` و`scope.ts`) مع
  تنفيذ افتراضي صادق (`unavailable.ts`: 404 / 422) وتنفيذ مكتوب بالسيناريو للاختبار
  (`src/modules/sessions/testing/`).
- لم يُدفع الفرع ولم يُدمج ولم يُنشر شيء. ينتظر مراجعة المالك.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
تغيير واحد، إضافي ومتوافق مع ما سبق:

1. `packages/contracts/events/README.md` — أمر `subscribe` على `/rt/sessions` صار
   يقبل `{ session_id, after_seq? }`، ورد الإقرار صار `{ ok, replayed, truncated }`،
   مع فقرة «Resuming a session» تشرح الاستئناف. هذا هو عقد استعادة ما فات العميل
   أثناء الانقطاع: يعيد الخادم إرسال الأظرف نفسها بالترتيب نفسه، و`truncated: true`
   تعني «لا أستطيع إثبات الاكتمال، أعد القراءة عبر HTTP». لا مخطّط حدث جديد، ولا
   حقل جديد داخل ظرف قائم، ولا تغيير في `openapi.yaml`.

**وثيقة `openapi.yaml` كانت صحيحة**: كل ما نُفِّذ هنا يطابقها كما هي، واختبار العقد
يمرّ على 246 عملية دون تعديل حرف واحد فيها.

أخطاء وُجدت في الوثائق أو الخادم (لا في العقد) وصُحِّحت هنا:
- `src/lib/errors.ts` كان يستعمل `internal_error` بينما `ErrorCode` في العقد يقول
  `internal`، وكان ينقص عشرة رموز يحتاجها هذا التنفيذ (`state_invalid`،
  `already_running`، `agent_unavailable`، `agent_error`، `profile_not_found`، …).
  القائمة الآن مطابقة حرفيًا لقائمة العقد، ولكل رمز نص عربي وإنجليزي.
- `docs/domain/sessions.md` كان يسمّي الأحداث `tool_call.started` /
  `tool_call.finished` بينما العقد يعلن `tool.started` / `tool.completed` /
  `tool.failed`؛ ولم يذكر الأعمدة التي يفرضها مخطّط `Session` و`Run` و`ToolCall`
  في العقد. صُحِّحت الوثيقة وأُضيفت الأعمدة إلى المخطّط:
  `sessions.source/channel/provider/reasoning_effort/preview/parent_session_id/
  category_id/notify`، `runs.job_id/provider/reasoning_effort`،
  `tool_calls.output_truncated/subagent_id`، والدور `command` في `messages.role`.
  وأُضيف إلى الوثيقة جدول التحويل بين حالات التشغيل التسع داخليًا والست على السلك.

## الملفات والتأثير

### منفَّذ فعلًا (لم يعد 501)
| العملية | ملاحظة |
|---|---|
| `sessions.list` | ترقيم بمؤشّر (keyset)، فلاتر agent/source/pinned/archived/q، `match` على نتائج البحث |
| `sessions.create` / `get` / `update` / `delete` | إعادة تسمية، تثبيت، أرشفة وإلغاء أرشفة، حذف مع إلغاء التشغيلات الجارية |
| `sessions.bulkUpdate` / `bulkDelete` | نجاح جزئي مع ظرف خطأ مترجم لكل عنصر |
| `sessions.fork` / `sessions.export` | نسخ النص مع `parent_session_id`؛ تصدير JSON و Markdown كمرفق تنزيل |
| `sessions.listMessages` | ترقيم للخلف بـ`before`، مع `has_more` |
| `sessions.listRuns` / `getRun` / `createRun` / `cancelRun` | طابور تشغيل لكل جلسة، `when: queue/next/interrupt`، `202` فوري بـ`job_id` |
| `sessions.listApprovals` / `getApproval` / `respondApproval` | صندوق الموافقات على مستوى مساحة العمل، و«اسمح دائمًا» يُخزَّن على الجلسة |

### ما زال 501 عمدًا (وموثَّق)
- `sessions.listCategories` / `createCategory` / `updateCategory` / `deleteCategory`
  — لا يوجد جدول `session_categories` في نموذج المجال؛ وإرسال `category_id` في
  `sessions.update` يردّ `501` صراحةً بدل تجاهله بصمت.
- كل عمليات المرفقات (`uploadAttachment`، `getAttachment`، `downloadAttachment`،
  `deleteAttachment`، `startUpload`، `uploadChunk`، `abortUpload`، `completeUpload`)
  — وحدة `knowledge` تملك التخزين. الرسائل تحمل معرّفات المرفقات كمراجع معتمة
  وتُعرَض برابط التنزيل الذي يعلنه العقد.
- `audit.getReport` و`jobs.*` و`/rt/jobs` — الكتابة في سجلّي `jobs` و`usage_records`
  تمت، والقراءة مرحلة رابعة.

### الملفات
- جديد `packages/server/src/modules/sessions/`: `ports.ts` (منافذ الوكيل)،
  `unavailable.ts`، `scope.ts` (مساحة العمل والمالك)، `schema.ts` (مُوسَّع)،
  `store.ts` (كل استعلام، مفلتَر بمساحة العمل)، `run-reducer.ts` (آلة الحالة، دالة
  صافية)، `journal.ts` (سجل الاستئناف)، `realtime.ts` (`/rt/sessions`)،
  `engine.ts` (تنفيذ التشغيل)، `service.ts`، `routes.ts`، `index.ts`،
  `testing/fake-runner.ts`.
- جديد `packages/server/src/modules/audit/service.ts` + تصديره من `index.ts`:
  الوجه الكاتب لسجلّي `jobs` و`usage_records`.
- جديد `packages/server/src/db/handle.ts`: نوع مقبض قاعدة البيانات الذي تراه الوحدة
  (الوحدات لا تستورد `app/`).
- جديد `packages/server/drizzle/0000_furry_tyrannus.sql`: أول ترحيل للمخطّط كاملًا.
- معدَّل: `src/lib/errors.ts`، `src/app/routes.ts`، `src/i18n/{ar,en}.json`،
  `docs/domain/sessions.md`، `packages/contracts/events/README.md`.

### تصميم التشغيل والبث
```
POST /sessions/{id}/runs   ->  رسالة المستخدم + run(queued) + job  ->  202 فورًا
                               (message.created, run.queued)
        v
RunEngine.kick()            سلسلة واحدة لكل جلسة: تشغيل واحد في كل مرة، بالترتيب
        v
runner.start()              المحوّل يقبل الدور -> قشرة رسالة المساعد
                               (message.created, run.started, session.updated)
        v
for await (event of runner.stream(runId))
        reduceRun(state, input) -> (state', actions)   [دالة صافية، مختبَرة وحدها]
        actions -> كتابة في القاعدة + أحداث العقد
           (message.delta, reasoning.delta, tool.*, approval.*, context.updated)
        v
حالة نهائية -> كتابة الرسالة النهائية والتشغيل والاستهلاك
               (run.completed | run.failed | run.cancelled, session.updated)
```
الفروق (deltas) لا تُحفَظ أبدًا؛ تُحفَظ الرسالة النهائية فقط، ويُسجَّل كل ظرف مُرسَل
في سجل ذاكرة محدود لكل جلسة حتى يستطيع عميل عاد من انقطاع أن يطلب ما فاته بـ
`subscribe { session_id, after_seq }`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ node -v
v24.21.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck
$ pnpm -r --if-present typecheck
$ pnpm generate:ts && tsc --noEmit -p tsconfig.json
contracts:generate:ts  wrote generated/ts/schema.ts
$ pnpm --filter @majlis/contracts build && tsc --noEmit -p tsconfig.json
(لا أخطاء)

$ pnpm test
 Test Files  3 passed (3)        # @majlis/contracts
      Tests  11 passed (11)
 Test Files  22 passed (22)      # @majlis/server (unit)
      Tests  84 passed (84)

$ npx vitest run --project unit src/modules/sessions
 Test Files  5 passed (5)
      Tests  55 passed (55)

$ pnpm contract:test
 Test Files  1 passed (1)
      Tests  246 passed (246)

$ pnpm build
$ pnpm -r --if-present build
$ pnpm generate:ts && tsc -p tsconfig.json
contracts:generate:ts  wrote generated/ts/schema.ts
$ pnpm --filter @majlis/contracts build && tsc -p tsconfig.json
(لا أخطاء)

$ pnpm i18n:check
i18n:check  server: 29 keys, ar/en in parity
i18n:check  OK

$ pnpm contracts:lint
contracts:lint  redocly lint openapi.yaml
openapi.yaml: validated in 446ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ pnpm db:generate
[✓] Your SQL migration file ➜ drizzle/0000_furry_tyrannus.sql 🚀

$ DATA_DIR=/tmp/ch-migrate-check pnpm db:migrate   # قاعدة SQLite نظيفة
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}
```

ما يثبته اختبار التكامل تحديدًا (`src/modules/sessions/sessions-run.test.ts`):
تسلسل الأحداث الكامل لتشغيل واحد يطابق حرفيًا ما تعلنه `sessions.createRun` في
`x-rt-events`، وكل ظرف مُرسَل يُتحقَّق منه مقابل مخطّط JSON الخاص به في
`packages/contracts/events/sessions/` (بما في ذلك `additionalProperties: false`)،
لا مقابل وصف مكتوب باليد. ويُتحقَّق كذلك من أجسام ردود HTTP (`SessionDetail`،
`MessagePage`، `Run`، `Approval`، `Session`) مقابل `components.schemas` في
`openapi.yaml` مباشرةً (`sessions-api.test.ts`).

## المخاطر والرجوع
- **لا وكيل حقيقي بعد.** كل شيء مُختبَر عبر `FakeAgentRunner`. صحّة التعامل مع وكيل
  ACP أو Hermes حقيقي — ترتيب الإطارات، أشكال الموافقات، أرقام الاستهلاك، سلوك
  المقاطعة — لا يمكن ادّعاؤها قبل وصول محوّل الوكلاء واختبارها معه.
- **مساحة العمل والمالك مؤقّتان.** حتى تصل `auth`، يُشتقّ معرّف مساحة العمل من اسم
  البروفايل ومعرّف المالك ثابت محلي (`scope.ts`). العزل بين مساحات العمل حقيقي
  ومُختبَر، لكن الصفوف ستحتاج إعادة ربط بمعرّفات `workspaces` و`users` الحقيقية
  (المستودع بلا بيانات إنتاج بعد، فالتكلفة صفر اليوم).
- **لا مصادقة على السوكِت.** `/rt/sessions` يقرأ `profile` من المصافحة ولا يتحقّق من
  الرمز؛ التحقّق مكان واحد تملكه `auth` ولا يجوز أن تخترعه هذه الوحدة مرتين.
- **الاستئناف في الذاكرة.** إعادة تشغيل الخادم تفقد السجل، والعميل يعود إلى
  `GET /sessions/{id}` كما يقول العقد. كل تشغيل تُرك جاريًا بإعادة التشغيل يُعلَّم
  `failed` برمز `stale` بدل أن يبقى دوّارًا للأبد.
- **PostgreSQL غير مدعوم في هذه الوحدة بعد**: المخطّط مكتوب بـ`sqlite-core`، والطلب
  على قاعدة PostgreSQL يردّ `503 service_unavailable` بدل أن يفشل بغموض.
- **الرجوع**: الوحدة معزولة في `src/modules/sessions/`؛ استبدال `sessionsModule` في
  `src/modules/index.ts` بنسخة فارغة يعيد كل عملياتها إلى `501` دون أثر على بقية
  الخادم. الترحيل يضيف جداول فقط ولا يحذف شيئًا.

## التسليم والخطوة التالية
1. مراجعة المالك لهذا الفرع (لم يُدفع بعد؛ لا PR ولا دمج بلا طلب صريح).
2. بعد دمج `feat/auth-and-agents`: ربط المنافذ الحقيقية في `src/modules/index.ts` —
   سطر واحد لكل منها:
   `createSessionsModule({ agents: agentsRegistry, runner: agentAdapter, scopes: authScopes })`.
   لا تغيير آخر داخل الوحدة.
3. بعدها: تشغيل حقيقي واحد مع Hermes للتحقّق من ترتيب الإطارات وأرقام الاستهلاك،
   ثم توجيه أحد هاتفَي المالك إلى `/api/v1` (Checkpoint A).
4. مؤجَّل بوعي: `session_categories`، المرفقات (`knowledge`)، نواة الوظائف
   و`/rt/jobs`، وتقارير `audit`.
