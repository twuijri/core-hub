# المهام تسير بالترتيب: البدء التلقائي ينتظر الاعتماديات، مراقب المهام المتوقفة، حمولة «نُقلت المهمة»، الأرشيف عند الطلب
المسؤول: twuijri · الفرع: feat/tasks-in-order · الحالة: review

## المشكلة والهدف
الدفعة B7 من قائمة الفجوات (البنود a1 وa5 وa9 وa29)، ومعها ديون وثائق وB22:

1. **البدء التلقائي لا ينتظر الاعتماديات**: مهمة فيها `auto_start` تبدأ متى صارت «جاهزة» ومُسندة إلى وكيل، ولو لم
   تنتهِ المهام التي تعتمد عليها. STATUS كان يقول صراحة: «Not built yet: waiting for dependencies before starting».
2. **لا شيء يلاحظ تشغيلًا صامتًا**: مهمة «تعمل» وتشغيلها لا يقول شيئًا منذ ساعات تبقى «تعمل» ولا يعرف أحد.
3. **خطأ**: حدث `task.moved` من مسار النقل يُرسَل بالمهمة وحدها، بلا `from` و`to` و`actor` التي يَعِد بها مخطط الحدث،
   فتصل الـwebhooks ناقصة.
4. **الأرشيف يُحمَّل مع كل فتح للوحة**: الويب يطلب `include_archived=true` مع اللوحة دائمًا (ليعرف عدد رابط
   «عرض المؤرشفة»)، والأرشيف لا يكفّ عن النمو.
5. **ديون وثائق**: عنوانان «## 26» في `DECISIONS.md`؛ «§26» خطأ لقرار المزوّدين في `docs/domain/models.md` وسجل
   provider-picker؛ التزام نتيجة CI لواتساب بقي على فرعه بعد دمج #157؛ سطر STATUS يقول إن الغرف 501 على iOS؛
   اختبار `auth/tokens.test.ts` متذبذب.
6. **B22**: قالب طلب دمج ثنائي اللغة وقوالب بلاغات بسيطة، الإنجليزية أولًا للمساهمين.

## القرار والموافقات
القرار §93 في `docs/contracts/DECISIONS.md` — **مقترح، للمالك أن يؤكد**:

- **البدء التلقائي ينتظر**: لا تبدأ المهمة وحدها ما دام في `depends_on` شيء لم ينتهِ، وتبدأ وحدها حين يصل آخرها إلى
  «تمّت» (النقل إلى `done` يُعيد الفحص كما يفعل النقل إلى «جاهزة»). «منتهية» = `done`، أو `archived` بعد `done`
  (الأرشيف الأسبوعي يحفظ `completed_at`)؛ المؤرشفة يدويًا بلا إنهاء ليست منتهية. **البدء اليدوي لا يُمنع**: الويب
  يحذّر في نافذة الإسناد ويسمّي ما لم ينتهِ. البطاقة تقول «بانتظار ٢» وتسمّيها في التلميح، والتفاصيل تسردها بعمودها.
- **مراقب المهام المتوقفة** على نبضة المجدوِل (لا مؤقت خاص): مهمة للهب «تعمل» ولم يَصدر عن تشغيلها أي حدث على
  `/rt/sessions` يذكره (نص، تفكير، أداة، خطوة) منذ `COREHUB_TASK_STUCK_MINUTES` دقيقة — **الافتراض ٣٠، مقترح**؛
  `0` يطفئه — تأخذ علامة `stuck_since` (لحظة آخر نشاط) ويصل مالكها إشعار **واحد** («مهمة متوقفة عن التقدّم»،
  نوعه في العقد `task_moved`، يفتح المهمة). لا تُنقل ولا تُوقَف: البطء ليس فشلًا والقرار للشخص. تُمسح العلامة حين
  يعود النشاط أو تخرج المهمة من «تعمل». التشغيل الذي ينتظر جواب شخص (`waiting_approval`/`waiting_input`) ليس
  متوقفًا. الإعداد متغيّر بيئة الآن (مثل `COREHUB_TASK_AUTO_START_MAX`)؛ يمكن أن يصير إعدادًا في الواجهة لاحقًا بلا
  تغيير في العقد.
- **`task.moved`** من مسار النقل يحمل `from` و`to` و`actor`؛ ونقل البطاقة داخل عمودها نفسه صار `task.updated`.
- **الأرشيف يُعَدّ ولا يُرسَل**: بلا `include_archived` عمود `archived` فيه `count` الحقيقي و`tasks` فارغ،
  و`counts.total` يعدّ الأعمدة التي أُرسلت مهامها فقط. الويب يطلب الأرشيف حين يُضغط «عرض المؤرشفة».

ديون الوثائق:
- `## 26` الثاني («Changing a conversation's agent is a fork…»، من #23) صار **§92** ونُقل إلى آخر الملف، وتحت
  مكانه القديم سطر يشير إليه. حُدّثت إشاراته: سطر sessions في STATUS، و`2026-09-22-twuijri-chips-fork-titles.md`،
  و`2026-09-26-twuijri-title-no-tools.md`. الإشارات «§26» في الكود لتسمية الجلسات والتفريع لم أغيّرها (خارج
  المهمة، وملفات يعمل فيها غيري)؛ السطر المشير يقول إنها تعني §92.
- قرار المزوّدين هو **§27** («A provider row is something you added; the catalogue is a separate list of presets»):
  صُحّح في `docs/domain/models.md` (موضعان) و`2026-09-22-twuijri-provider-picker.md` (ثلاثة مواضع)، وفي
  `DECISIONS.md` §63 («like a custom chat endpoint (§26)» ← §27). بقيت تعليقات في `packages/server/src/modules/models/`
  تقول «§26» لقرار المزوّدين — لم أغيّرها (خارج النطاق).
- التزام نتيجة CI لواتساب `5f75b98f` (docs/changes فقط) أُخذ بـ cherry-pick.
- سطر iOS في STATUS: الغرف تُعرض قائمةً للقراءة (الاسم وعدد الأعضاء)، وفتح الغرفة لم يُبنَ على الهاتف بعد — لا 501.
- **`auth/tokens.test.ts`**: السبب لم يكن التوقيت. الاختبار «يعبث» بالرمز بتبديل آخر حرفين إلى `xx`، والتوقيع
  ٣٢ بايتًا = ٤٣ حرف base64url، وآخر حرف فيه بتات حشو يُسقطها المفكّك؛ فأحيانًا يبقى التوقيع هو نفسه ويُقبل الرمز
  «المعبوث به» (فشل CI في التشغيل 36199485661: «promise resolved … instead of rejecting» عند السطر 50). الإصلاح:
  تغيير **أول** حرف في التوقيع (ست بتات حقيقية)، وساعة صريحة ثابتة بدل `Date.now()`، وحدّا انتهاء الصلاحية
  (قبلها بثانية مقبول، وعندها مرفوض).

B22: `.github/pull_request_template.md` (المشكلة، القرار، الدليل، المخاطر والرجوع، وقائمة تحقق)، و
`.github/ISSUE_TEMPLATE/bug_report.md` و`feature_request.md` و`config.yml` — الإنجليزية أولًا والعربية بجانبها.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
`packages/contracts/openapi.yaml`:
- `Task.waiting_on` (مصفوفة `TaskDependencyState` = `{ id, title, status }`) و`Task.stuck_since` (Timestamp أو
  null) — اختياريان في المخطط ويرسلهما الهب دائمًا (مثل `external`)، فلا ينكسر عميل قديم.
- `tasks.getColumns`: وصف `include_archived`، و`count` العمود صار يعني عدد الأرشيف حين لا تُرسَل مهامه.
- لا عملية جديدة ولا حدث جديد؛ مخطط `task.moved` كان يطلب الحقول الثلاثة أصلًا. متغيّر بيئة جديد
  `COREHUB_TASK_STUCK_MINUTES` في `docs/DEPLOY.md`.

## الملفات والتأثير
- الخادم — `modules/tasks`: `service.ts` (`waitingOn`، تصفية `autoStartable`، `markStuck`، `archivedCount`، مسح
  العلامة في كل نقل)، `index.ts` (حمولة `task.moved`، إعادة الفحص عند `done` وعند تغيير الاعتماديات، العمود
  المؤرشف، `watchStuckTasks`، منفذ `registerTaskNotices`، التقاط نشاط التشغيلات من `/rt/sessions`)، `runs.ts`
  (آخر نشاط لكل تشغيل متابَع)، `serialize.ts`، `schema.ts` (عمود `stuck_at`) والهجرة `drizzle/0030_task_stuck.sql`.
- `modules/schedules`: `scheduler.ts` و`index.ts` (`registerSchedulerWork`: عمل وحدة أخرى على ساعة المجدوِل).
- `modules/notify/notices.ts`: حدث `task_stuck` بجملتيه (يُخزَّن `task_moved` لأن جدول الإشعارات مقيَّد بقائمة).
- `modules/index.ts` (جذر التركيب): ربط المراقب بالساعة والإشعار. `app/config.ts`: `COREHUB_TASK_STUCK_MINUTES`.
- الويب — `tasks/TasksScreen.tsx` (شارة «بانتظار» و«متوقفة»، الأرشيف عند الفتح)، `TaskDialog.tsx`، `AssignDialog.tsx`،
  `queries.ts`، `board.ts`، `i18n/ar.json` و`en.json`.
- الاختبارات: `tests/unit/tasks-in-order.test.ts` (جديد)، `tests/unit/webhook-events.test.ts`، `tests/unit/config.test.ts`،
  `src/modules/auth/tokens.test.ts`، والويب `tests/task-board-visuals.test.tsx`.
- الوثائق: `DECISIONS.md` (§92 منقول، §93 جديد، §63)، `STATUS.md`، `DEPLOY.md`، `docs/domain/tasks.md` و`models.md`،
  وسجلات chips-fork-titles وtitle-no-tools وprovider-picker، وسجل واتساب (cherry-pick). `.github/` (B22).
- بطاقات هرمز لا تتغيّر: المراقب والبدء التلقائي للمهام التي يملكها الهب فقط.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`، بعد دمج `origin/night/2026-09-27` في الفرع (أخذ §87–§91 والهجرتين 0028 و0029، فصارت
هجرتي `0030` بـ `drizzle-kit generate --name task_stuck` وقراراتي §92 و§93):
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
exit 0   (0 error TS)
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 650 client file(s) scanned, 235 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  380 passed (380)
$ (server) vitest run tests/unit/tasks-in-order.test.ts tests/unit/webhook-events.test.ts tests/unit/config.test.ts tests/unit/task-runs.test.ts tests/unit/task-worktrees.test.ts src/modules/tasks src/modules/schedules/scheduler.test.ts src/modules/notify src/modules/auth/tokens.test.ts
 Test Files  16 passed | 2 skipped (18)
      Tests  182 passed | 6 skipped (188)
$ (web) vitest run tests/task-board-visuals.test.tsx tests/i18n.test.ts
 Test Files  2 passed (2)
      Tests  25 passed (25)
$ DATA_DIR=<tmp> pnpm db:migrate
{"msg":"db: migrations applied (sqlite)"}
$ # قبل دمج فرع الليلة: pnpm build && PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zz-task-board.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zz-task-board.spec.ts:57:3 › the Tasks board, in colour › every stage is told by its frame and its word, in both themes and on a phone (5.7s)
  1 passed (13.8s)
```
(صور الـe2e الثلاث تغيّرت لأن المواصفة شُغّلت وحدها ببيانات غير بيانات المجموعة كلها؛ أُرجعت كما هي.)

**الاختبارات الجديدة تفشل على الكود القديم** (الكود القديم مع الاختبارات الجديدة):
```
server: tasks-in-order + webhook-events
     × stays waiting, says on what, and starts itself when the last one is done
     × a person can still start it by hand before its dependencies are done
     × counts archived-after-done as done, and archived by hand as not done
     × marks a running task whose run went quiet, tells its owner once, and clears on activity   (watchStuckTasks is not a function)
     × a task that leaves running is not stuck any more, and 0 switches the watchdog off
     × the board counts the archive and sends none of it without include_archived   (count: +0)
     × sends task.created and task.moved from the Tasks board, without the title by default   (no from/to/actor)
     × sends no task.moved for a card put elsewhere in its own column   ([undefined, undefined])
      Tests  8 failed | 14 passed (22)
web: task-board-visuals
     × shows the archive behind a counted link, read-only
     × a card that depends on unfinished tasks says how many, and names them on hover
     × starting by hand is not refused, but the assign dialog warns with what is not done
     × the details list what it waits for, with their columns
     × a running card whose run went quiet is marked stuck; others are not
      Tests  5 failed | 17 passed (22)
```
**العبث القديم بالرمز** (قياس بـ node على ٢٠٠٠٠٠ توقيع عشوائي من ٣٢ بايتًا):
```
old tamper left the signature unchanged in 192 of 200000 (1 in 1042)
new tamper left it unchanged in 0 of 200000
```
CI على طلب الليلة #165: يُضاف بعد الدفع.

## المخاطر والرجوع
- المراقب يعتمد على أحداث `/rt/sessions`: وكيل يعمل طويلًا بلا أي حدث (أداة واحدة تستغرق ساعة) سيُعلَّم «متوقفًا»
  — العلامة لا توقف شيئًا، ويمكن رفع `COREHUB_TASK_STUCK_MINUTES` أو جعله `0`.
- النشاط في الذاكرة: بعد إعادة التشغيل تُسوّى المهام «العاملة» أصلًا (§47)، فلا أثر.
- `counts.by_status.archived` صار العدد الحقيقي دون `include_archived` (كان ٠)؛ أندرويد يستبعد عمود الأرشيف من اللوحة، وiOS يقرأ `listTasks` لا الأعمدة، فلا يتغيّر ما يعرضانه.
- الرجوع: استرجاع دمج الفرع؛ الهجرة تضيف عمودًا قابلًا للفراغ فقط.

## التسليم والخطوة التالية
يُدمج في `night/2026-09-27` (طلب الليلة #165)، بلا طلب دمج خاص. للمالك أن يؤكد §93: انتظار الاعتماديات (والبدء
اليدوي بتحذير)، والمراقب وافتراضه ٣٠ دقيقة ومتغيّر البيئة بدل إعداد في الواجهة، وأن العلامة لا تنقل المهمة. بقي خارج
المهمة: تعليقات «§26» في الكود (تسمية الجلسات/التفريع = §92، والمزوّدين في `modules/models` = §27).
