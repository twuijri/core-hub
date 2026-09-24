# المهام والجدولة تعرضان كل البروفايلات بلا مرشّح بروفايل (المرحلة الثانية من ADR 0016)
المسؤول: twuijri · الفرع: feat/tasks-schedules-all-profiles · الحالة: review

## المشكلة والهدف
المرحلة الأولى (`2026-09-24-twuijri-all-profiles-lists.md`) جمعت المحادثات. قال المالك:
«المفروض ما فيه خيار الكل… كل البروفايلات تكون بس لتصنيف المحادثات… الكرون جوب والمهام المفروض
تطلع كل البروفايلات بدون تصنيف».

قبل هذا التغيير: لوحة المهام وصفحة الجدولة كان عليهما مرشّح بروفايل؛ بطاقة المهمة بلا شارة
بروفايل؛ «فتح المحادثة» من بطاقة بروفايل آخر كان **يحرّك الشريحة العلوية** (`setProfile`)؛ نافذة
الإسناد كانت ترسل الطلب ببروفايل الشريحة لا ببروفايل البطاقة (فإسناد بطاقة من بروفايل آخر يفشل
بـ404) وتعرض وكلاء بروفايل الشريحة؛ اسم الوكيل على البطاقة كان يُخمَّن في الويب من وكلاء بروفايل
الشريحة لأن الخادم لم يربط `nameOf` قطّ (كان يرسل المعرّف مكان الاسم)؛ مقبسا `/rt/tasks`
و`/rt/schedules` لا يسمعان إلا بروفايل الشريحة (والويب لا يستمع للجدولة أصلًا)؛ `schedules.list`
يتجاهل `cursor`/`limit` المعلنين في العقد؛ و`tasks.dispatch` (ومعه عمليتا worktree) يجيب بكائن
المهمة كاملًا بلا `job_id` بينما العقد يقول `JobAccepted {job_id}`.

## القرار والموافقات
- قرار المالك أعلاه (ADR 0016 §4، الموافقة في المحادثة). التنفيذ مستقل ليلًا بتوجيه المنسّق.
- **الصفحتان تعرضان كل بروفايل يحق للشخص** (قاعدة `listWorkspacesFor` في الخادم، لا قائمة من
  العميل)، **بلا مرشّح بروفايل**، وعلى كل بطاقة وجدول شارة بروفايله متى كان للشخص أكثر من بروفايل.
- **الشريحة العلوية تقرّر أين يُنشأ الجديد فقط**، وأي فعل على عنصر موجود (نقل، تعديل، إسناد، إيقاف،
  تعليق، حذف، تشغيل الآن) يُرسل بـ`X-Hub-Profile` بروفايل العنصر، والخادم يتحقق منه كأي طلب:
  عضو خارجه ← `404 profile_not_found`، وعنصر ليس في البروفايل المذكور ← `404 not_found`.
- نوافذ البطاقة (الإسناد، التفاصيل، التسليم) تُفتح داخل `ProfileScope` بروفايل البطاقة، فوكلاؤها
  وطلباتها لبروفايلها.
- **محادثة المهمة تُفتح في بروفايلها** بالرابط `/chat/<id>?profile=<slug>` كما تفعل قائمة المحادثات
  في المرحلة الأولى، ولا تتحرك الشريحة.
- **اسم الوكيل من الخادم**: `registerTaskNames` في جذر التركيب (السجل للوكيل، `auth` للشخص).
- **مرآة هرمز**: هرمز يحفظ لوحة واحدة ومجدولًا واحدًا لكل بيت (هكذا يعكسه الكود الحالي؛ لا لكل
  بروفايل)؛ البطاقة تنعكس في مساحة البروفايل الذي أُعطيت له (ADR 0014/0015)، والوظيفة تبقى في
  البروفايل الذي أُنشئت منه. كانت المزامنة تحدث فقط لمن يدخل البروفايل الافتراضي؛ صارت تحدث لكل من
  يفتح الصفحة (المزامنة تكتب انعكاسات فقط، والعرض يبقى مقصورًا على ما يحق له).
- **اقتراحات تنتظر تأكيد المالك (proposed — owner to confirm):**
  1. **حُذف حقل «البروفايل» من نموذج «جدول جديد»**. طلبه المالك في ٢٠٢٦-٠٩-٢٣ («المفروض اختار اي
     بروفايل»)، لكن ADR 0016 §9 جعل الشريحة العلوية وحدها تقرّر أين يُنشأ الشيء. بقي سطر يسمّي
     البروفايل: «الجداول الجديدة تُنشأ في Default. لإنشاء جدول في بروفايل آخر، بدّل البروفايل من
     أعلى الصفحة.» — وهذا يصلح أيضًا خللًا قديمًا: قائمة الوكلاء في النموذج كانت لبروفايل الشريحة
     حتى لو اختير بروفايل آخر.
  2. خانة «مهمة جديدة» صارت «مهمة جديدة في Default» متى كان للشخص أكثر من بروفايل.
  3. `tasks.getColumns` و`schedules.list` عامّتان أصلًا؛ صارتا تقبلان `profiles=all` مرادفًا صريحًا
     (مع `profile` معًا ← `400`)، وبقي `profile` للمتصلين بالـAPI دون أن يعرضه الويب.
  4. مرشّح «المشروع» في لوحة المهام بقي (ليس مرشّح بروفايل)، وقائمة المشاريع فيه لبروفايل الشريحة.
- الخريطة (Graphify) لم تُستعمل: الوحدات معروفة (`tasks`، `schedules`، `auth`) وقُرئت مباشرة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `tasks.listTasks`: معامل `profiles=all` كما في `sessions.list` (§28): بلا المعامل بروفايل
  الترويسة كما كان؛ معه كل بروفايل يحق للمتصل، ترتيب واحد `id desc`، والترويسة يجب أن تبقى
  بروفايلًا يحق له.
- `tasks.getColumns` و`schedules.list`: معامل `profiles=all` (مرادف لما تجيبان به أصلًا؛ مع
  `profile` ← `400 validation_failed`). وصف `schedules.list` صار «الأحدث أولًا» بمؤشر واحد عبر
  البروفايلات (كان يقول «الموعد التالي أولًا» ولم يكن كذلك).
- `packages/contracts/events/README.md`: `profiles: 'all'` في مصافحة `/rt/tasks` و`/rt/schedules`.
- `docs/contracts/DECISIONS.md` **§32** (§30 و§31 أخذهما #80 و#82 قبله).
- لا تغيير في مخطط `JobAccepted`: الخادم هو الذي كان مخالفًا وأُصلح.

## الملفات والتأثير
- الخادم: `modules/tasks/{index,service}.ts` (`listTasksAcross`، `registerTaskNames`، مزامنة هرمز من
  الافتراضي دائمًا، `JobAccepted` لـ`dispatch`/`createWorktree`/`deleteWorktree`)،
  `modules/schedules/{index,service}.ts` (`listAcross` بمؤشر)، `modules/auth/index.ts` (تصدير
  `defaultWorkspace`)، `modules/index.ts` (ربط الأسماء). اختبار جديد
  `tests/unit/lists-across-profiles.test.ts` (١٨)، وتحديث `tasks.test.ts` (شكل `dispatch`).
- الويب: `tasks/{TasksScreen,AssignDialog,queries}.ts(x)`، `schedules/SchedulesScreen.tsx`،
  `realtime/{socket,context,envelope}.ts(x)` (مساحة `schedules` و`profiles: 'all'` للمهام والجدولة)،
  `i18n/{ar,en}.json` (`tasks.new_task_in`، `schedules.in_profile`؛ حُذفت أربعة مفاتيح لم تعد
  مستعملة: `tasks.all_workspaces`، `tasks.workspace`، `schedules.workspace`،
  `schedules.all_workspaces`). اختبار جديد `tests/tasks-schedules-profiles.test.tsx` (١٠).
- Playwright: رحلة جديدة **26** `e2e/zzzz-profiles-boards.spec.ts` (بروفايلان على اللوحة والجدولة
  بالشارات، إسناد وتشغيل بطاقة المصمم من Default وفتح محادثتها في بروفايلها، إيقاف جدول المصمم من
  Default)؛ الرحلة 11 في `smoke.spec.ts` تتحقق من السطر والشارة وغياب المرشّح بدل حقل البروفايل
  والمرشّح. `zzz-profiles.spec.ts` (المرحلة الأولى): الرحلة صارت تنتظر ظهور الرد الأول قبل عدّ
  الردود — كانت تعدّ أثناء تحميل المحادثة فتقرأ 0 على جهاز مشغول (سباق في الاختبار لا في
  الكود؛ ظهر مع كثرة الرحلات بعد #79/#80).
- اللقطات: جديدتان `all-profiles-{tasks,schedules}-ar-light.png`، وتغيّرت لقطات المهام والجدولة
  التي صارت فيها شارات (`schedules-*`، `tasks-colours-*`، `tasks-{review,running}`). أُعيدت كل
  اللقطات الأخرى إلى نسخة `main`.
- المستندات: ADR 0016 (المرحلة ٢ مبنية)، `docs/clients/NAVIGATION.md` و`navigation.json`
  (`profileScope`)، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
كل الأوامر الثقيلة عبر `mj-run` (ذاكرة ٧ غ، عاملان)، بعد دمج `origin/main` (b21d31e).
```
$ pnpm lint
All matched files use Prettier code style!                       # exit 0
$ pnpm typecheck                                                  # exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 233 client file(s) scanned, 167 contract path(s) known.
$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  255 passed (255)
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/server test
 Test Files  79 passed | 8 skipped (87)
      Tests  846 passed | 23 skipped (869)
$ pnpm --filter @majlis/web test
 Test Files  40 passed (40)
      Tests  512 passed (512)
$ pnpm --filter @majlis/cli test
 Test Files  11 passed (11)
      Tests  64 passed (64)
$ pnpm build
✓ built in 761ms                                                  # exit 0
$ MAJLIS_E2E_PORT=8895 MAJLIS_E2E_SETUP_PORT=8896 PLAYWRIGHT_CHANNEL=chrome npx playwright test --workers=1
  ✓  28 [chromium] › e2e/zzz-profiles.spec.ts:80:3 › lists across profiles › two profiles, one list: …
  ✓  32 [chromium] › e2e/zzzz-profiles-boards.spec.ts:77:1 › 26. the Tasks board and the Schedules page hold every profile, each item badged and acted on in its own (4.2s)
  32 passed (2.1m)
```
**الاختبارات الجديدة تسقط على الكود القديم** (قبل الدمج، بإرجاع ملفات الخادم/الويب إلى `main`
مع بقاء الاختبارات والعقد):
```
server (tests/unit/lists-across-profiles.test.ts + tasks.test.ts):
     × takes `profiles=all` as the board it already is, and refuses it beside `profile`
     × names each card’s agent on the hub, from the registry — in every profile
     × shows a member Hermes’s card for their profile as Hermes has it now, without the default profile
     × lists every profile for the owner, and only the header’s without it
     × takes `profiles=all` as the list it already is, and refuses it beside `profile`
     × pages across profiles in one order, as the cursor it declares says
     × shows a member their profile’s Hermes job as Hermes has it now, without the default profile
     × dispatch assigns the ready tasks to the project default, and says why one could not start
      Tests  8 failed | 30 passed (38)
web (tests/tasks-schedules-profiles.test.tsx):
     × asks for every profile, offers no profile filter, and badges each card with its own
     × shows the agent’s name the hub gave, not a guess from this profile’s agents
     × opens a task’s conversation in the task’s own profile, without moving the selector
     × assigns a card in its own profile, offering that profile’s agents
     × makes a new task in the profile the person is in, and says which
     × hears every profile on the tasks socket
     × reads every page of every profile, badges each schedule, and offers no filter
     × makes a new schedule in the profile the person is in, with no second picker
     × hears every profile on the schedules socket, and redraws on an event from any
      Tests  9 failed | 1 passed (10)
```
الناجحة على الكود القديم (فحوص صلاحية الكتابة على عنصر في بروفايل آخر، والكتابة على جدول في
بروفايله) كانت صحيحة أصلًا وتبقى حارسة ضد التراجع.

## المخاطر والرجوع
- `schedules.list` صار يقسّم الصفحات (افتراضي ٥٠): عميل كان يقرأ الصفحة الأولى ويتجاهل المؤشر يرى
  أول ٥٠ فقط. الويب يتبع المؤشر؛ الـCLI لا يستعمل هذه العملية.
- `dispatch`/worktree يجيبان `{job_id}` بدل كائن المهمة: لم يكن أي عميل يقرأ الشكل القديم.
- مزامنة هرمز صارت تحدث عند فتح الصفحة من أي شخص (مخنوقة بخمس ثوانٍ كما كانت).
- **خارج النطاق**: `updates` يجيب أيضًا بكائن المهمة في رد `202` (نفس نمط
  `serializeJob`)؛ ولا تحمل تشغيلات الجدولة `session_id` بعد (دائمًا `null`)، فلا محادثة تُفتح منها.
- الرجوع: استرجاع الـcommits؛ لا هجرة.

## التسليم والخطوة التالية
PR إلى `main` (للمراجعة، لا دمج). المرحلة الثالثة من ADR 0016: سطح المكتب كالويب، ومكان الشريحة في
الجوال لم يُقرَّر.
