# شجرة عمل git لكل مهمة، و`auto_start` (المهام، المرحلة الثانية)
المسؤول: twuijri · الفرع: feat/task-worktrees · الحالة: review

## المشكلة والهدف
صفّ المهام في `docs/STATUS.md` كان يقول: «لم يُبنَ بعد: شجرة عمل git لكل مهمة (الصفّ يُسجَّل في
`creating` ولا شيء يصنع شجرة)، والإبلاغ في غرفة المشروع، و`auto_start`». العقد فيه كل الحقول
(`Project.working_dir`، و`Worktree`، وعمليات الشجرة الثلاث، و`worktree.updated`، و`Task.auto_start`)
ولا شيء يعمل خلفها: المهمة المبدوءة تعمل في مجلّد الجلسة العادي حتى لو كان لمشروعها مستودع،
و`auto_start` يُحفظ ولا يُقرأ.

الهدف: شجرة عمل git حقيقية لكل مهمة مشروعُها له مستودع، يعمل فيها وكيلها، وتُزال مع المهمة؛
و`auto_start` يبدأ المهمة وحده بحدّ معقول لكل بروفايل. الغرف خارج النطاق بقرار المالك (لاحقًا).

## القرار والموافقات
- **مستودع المشروع** هو `working_dir` الموجود في العقد (لم يُضَف حقل): مسار **داخل مجلّد
  البروفايل** `/data/workspaces/<profile>` (المسار النسبي يبدأ منه)، يُفحص عند الكتابة: خارجه، أو
  غير موجود، أو عبر رابط رمزي، أو ليس مستودع git ← `400 validation_failed` مع `details.reason`
  (`outside_root`/`not_found`/`symlink`/`not_a_git_repo`) وكلام git في `details.message`. يُخزَّن
  مسارًا مطلقًا، وإن لم يُرسَل `default_branch` معه صار الفرعُ المفتوح في المستودع هو الأساس.
  داخل البروفايل لأن جلسة المهمة يجب أن تعمل في الشجرة، ومجلّد الجلسة لا يخرج من البروفايل.
- **بدء المهمة يصنع `git worktree` حقيقية** في `/data/workspaces/<profile>/worktrees/<short>-<slug>`
  على الفرع `task/<short>-<slug>` (`short` = مفتاح المشروع ورقم المهمة مثل `core-12`، أو آخر
  ثمانية أحرف من معرّف المهمة إن لم يكن المفتاح ASCII — كالمشروع الافتراضي العربي؛ `slug` من
  كلمات العنوان اللاتينية). الصفّ `creating` ← `ready` (أو `dirty`) أو `error` (في الجدول `failed`)
  بكلام git نفسه. تُفتح جلسة المهمة والشجرة مجلّدها، فيأخذها هرمز ووكلاء البرمجة عبر ACP
  (Claude Code وغيره) مجلّدَ عمل. كل استدعاء git مصفوفة وسائط (`execFile`)، لا سلسلة shell،
  مع `GIT_TERMINAL_PROMPT=0` ومهلة دقيقة.
- **رفض git يوقف البدء**: `409 conflict` بـ`details.reason: worktree_failed` وكلام git، والمهمة
  كما كانت (لا جلسة، لا إسناد). لم أشغّلها في مجلّد الجلسة بدلًا منها: وكيل يعمل على مجلّد فارغ
  سيبدو ناجحًا وهو لم يلمس المستودع.
- **الإزالة مع إبقاء الفرع**: عند حذف المهمة (ومنها الحذف الجماعي)، وأرشفتها (النقل والتعديل
  الجماعي، و**الأرشفة الأسبوعية** للمنجَز تُزال شجرها في الخلفية عند فتح اللوحة)، وحذف مشروعها،
  و`deleteWorktree` من التفاصيل. `deleteWorktree` مرفوض `409 task_running` ما دام تشغيل المهمة
  يعمل فيها. مجلّد حذفه أحد يدويًا يُنسى بـ`git worktree prune`. إن رفض git الإزالة بقي الصفّ
  `error` بكلامه. إعادة الصنع (`createWorktree` أو البدء التالي) تعيد **الصفّ نفسه والفرع نفسه**
  الذي أبقاه git. `createWorktree` يُرفض قبل أي وظيفة: `no_repository` أو `worktree_exists`.
- مهمة بلا مستودع: كما كانت، مجلّد الجلسة الخاص.
- **`auto_start`**: مهمة `ready` مُسندة إلى وكيل و`auto_start` تبدأ وحدها — عند إنشائها كذلك،
  أو إسنادها بلا `start`، أو نقلها إلى «جاهزة» بيد شخص، أو تشغيل الخيار وهي كذلك — **بحدّ
  `COREHUB_TASK_AUTO_START_MAX` (افتراضه 2) تشغيلات بدأها المركز وحده في آن واحد لكل بروفايل**؛
  الباقي ينتظر بترتيب العمود، ويبدأ حين يفرغ مكان (انتهاء تشغيل، أو إعادة تشغيل المركز). «أسند
  وابدأ» من شخص لا يحدّه هذا. تمريرة البدء واحدة في كل مرة لكل بروفايل (لا يأخذ اثنان المكان
  الأخير). يُعدّ ما بدأه المركز في الذاكرة ويُقرأ مقابل حال المهام الآن، وإعادة التشغيل تُنهي كل
  تشغيل فيبدأ العدّ من صفر وهذا صحيح. المشغَّل يعمل باسم مالك المهمة. مهمة لا تستطيع البدء
  (وكيل غير معروف، شجرة رفضها git) تذهب إلى `blocked` بالسبب («تعذّر بدء المهمة تلقائيًا: …»)
  بدل المحاولة مرة بعد مرة. بطاقات هرمز لا يبدؤها المركز.
- **الإيقاف يُطفئ `auto_start`** (من اللوحة أو من المحادثة)، فالمهمة الموقوفة تنتظر في «جاهزة» ولا
  تعود تبدأ وحدها؛ إعادة الإسناد ليست إيقافًا.
- **الويب**: زرّ «إعدادات المشروع» في رأس اللوحة (مسار المستودع والفرع الأساسي، وسبب رفض
  المركز للمسار)؛ وتفاصيل المهمة فيها «شجرة العمل» (المجلّد، الفرع، الحالة، رسالة git عند الرفض،
  عدد الملفات المتغيّرة والإيداعات المتقدّمة) مع «إزالة شجرة العمل» بتأكيد (معطَّل والمهمة تعمل)،
  ومفتاح «البدء تلقائيًا» يُحفظ لحظة قلبه (لا يظهر على بطاقة هرمز). اللوحة تسمع `worktree.updated`
  وتعيد قراءة التفاصيل المفتوحة. كل النصوص بالعربية والإنجليزية.

### قرارات للمالك (مقترحة — للتأكيد)
1. **الحدّ متغيّر بيئة اختياري** `COREHUB_TASK_AUTO_START_MAX` (1–50، افتراضه 2) لا حقل في
   الإعدادات؛ المركز يعمل بدونه (الثابت 5 باقٍ). يمكن نقله إلى الإعدادات لاحقًا.
2. **الإيقاف يُطفئ `auto_start`** على المهمة.
3. **سطر `.corehub/`** يُضاف إلى `info/exclude` المحلي للمستودع (ليس ملفًا متتبَّعًا) حتى لا
   تصير الشجرة `dirty` بسبب ملفات التشغيل التي تكتبها الجلسة.
4. **المستودع داخل مجلّد البروفايل فقط** (لا في أي مكان على المضيف).
5. **رفض git يوقف البدء** بدل العمل في مجلّد الجلسة.
6. **اسم الفرع** `task/<مفتاح-رقم>-<slug>` مع البديل من معرّف المهمة للمفاتيح غير اللاتينية.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
أوصاف وأمثلة فقط، بلا حقل ولا عملية ولا حدث جديد — DECISIONS §47:
- `Project.working_dir` و`default_branch`: القاعدة أعلاه؛ `createProject`/`updateProject`: أسباب
  `400`؛ `deleteProject`: الشجر تُزال أولًا.
- `Worktree` ووصف `status` (`error` يحمل كلام git؛ `merged`/`removed` محجوزتان).
- `Task.auto_start` و`TaskCreate.auto_start`: متى يبدأ، والحدّ، والإيقاف، و`blocked`.
- `assignTask`: `409 worktree_failed`؛ `createWorktree`: `no_repository`/`worktree_exists`؛
  `deleteWorktree`: `task_running`.
- `x-rt-events` لـ`createTask`/`updateTask`/`moveTask`/`deleteTask`/`bulkUpdateTasks`/
  `bulkDeleteTasks`/`deleteProject` صارت تذكر `worktree.updated` (وما يبدؤه `auto_start`).
- أمثلة المسارات صارت داخل `/data/workspaces/<profile>` (المشروع في `openapi.yaml` وفي
  `events/tasks/project.{created,updated}` و`worktree.updated`).

## الملفات والتأثير
- `packages/server/src/modules/tasks/git-worktrees.ts` (جديد): git بمصفوفة وسائط، فحص المستودع،
  الأسماء، الصنع والإزالة والأرقام، وسطر `.corehub/`.
- `packages/server/src/modules/tasks/index.ts`: `makeWorktree`/`worktreeFor`/`releaseWorktree`/
  `refreshWorktree`، و`startTaskRun` (صار `assignAndStart` يمرّ به)، و`autoStartPass`/`kickAutoStart`،
  وفحص المستودع في كتابة المشروع، والإزالة عند الحذف والأرشفة، والمحفّزات، وعمليات الشجرة الحقيقية،
  ومسح عند الإقلاع.
- `packages/server/src/modules/tasks/service.ts`: `beginWorktree` (يعيد صفّ المهمة السابق)،
  `settleWorktree`، `worktreeRemoved`، `liveWorktreesOfProject`، `orphanedWorktrees`، `autoStartable`،
  `autoStartWorkspaces`؛ `stop` و`finishRun` (الإلغاء) يُطفئان `auto_start`. حُذف `createWorktree`/
  `removeWorktree` القديمان (كانا يسجّلان صفًّا بلا git).
- `packages/server/src/modules/tasks/runs.ts`: `workingDir` في `TaskRunPort`، وعدّ ما بدأه المركز،
  و`serially`، و`afterSettle`.
- `packages/server/src/modules/sessions/service.ts` و`modules/index.ts`: `TurnInput.workingDir` يصل
  إلى `working_dir` الجلسة (يُفحص كمسار شخص).
- `packages/server/src/app/config.ts` و`docs/DEPLOY.md`: `COREHUB_TASK_AUTO_START_MAX`.
- اختبارات الخادم: `tests/unit/task-worktrees.test.ts` (جديد، ١٠ اختبارات على مستودع git حقيقي
  مؤقت)، و`tests/unit/config.test.ts`، و`src/modules/tasks/tasks.test.ts` (كان يرسل
  `working_dir: '/srv/hub'`، وهو الآن مرفوض — صار بلا مستودع).
- الويب: `src/tasks/ProjectDialog.tsx` (جديد)، `TaskDialog.tsx`، `TasksScreen.tsx`، `queries.ts`،
  `errors.ts`، `realtime/envelope.ts`، `styles/screens.css`، `i18n/{ar,en}.json`؛
  `tests/task-worktrees.test.tsx` (جديد، ١٠ اختبارات)؛ `e2e/zzzzzzz-task-worktrees.spec.ts` (جديد)
  و`e2e/hub.ts` (أداة اختبار `/__e2e/git-repo` تصنع مستودعًا حين تطلبه الرحلة، لا عند الإقلاع،
  فلا تراه رحلة أخرى).
- `packages/contracts/openapi.yaml` و`events/tasks/*.schema.json` (أوصاف وأمثلة)،
  `docs/contracts/DECISIONS.md` (§47)، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا ما يلمسه التغيير فقط (قاعدة السرعة)، والباقي على CI:
```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!

$ pnpm typecheck                 -> exit 0
$ pnpm i18n:check                -> i18n:check  OK
$ pnpm contracts:lint            -> contracts:lint  validating 90 event schema file(s) / contracts:lint  OK
$ pnpm contracts:check-clients   -> check-clients  OK — 277 client file(s) scanned, 175 contract path(s) known.
$ pnpm nav:check                 -> nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  273 passed (273)

$ vitest run tests/unit/task-worktrees.test.ts            (server)
      Tests  10 passed (10)
$ vitest run tests/unit/task-runs.test.ts tests/unit/config.test.ts src/modules/tasks/ tests/unit/task-worktrees.test.ts   (server)
 Test Files  9 passed | 2 skipped (11)
      Tests  102 passed | 6 skipped (108)
$ vitest run tests/task-worktrees.test.tsx                (web)
      Tests  10 passed (10)
$ vitest run tests/task-run.test.tsx tests/task-hermes-card.test.tsx tests/task-board-visuals.test.tsx tests/tasks-schedules-profiles.test.tsx tests/i18n.test.ts tests/logical-css.test.ts   (web)
 Test Files  6 passed (6)
      Tests  208 passed (208)
$ pnpm build   -> ✓ built
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzzz-task-worktrees.spec.ts
  ✓  1 [chromium] › e2e/zzzzzzz-task-worktrees.spec.ts:25:1 › a started task works in its own git worktree, shown in its details and removable (6.0s)
  1 passed (12.2s)

# الاختبارات الجديدة تفشل بلا التغيير (packages/server/src مخبّأ بـ git stash):
$ vitest run tests/unit/task-worktrees.test.ts
      Tests  10 failed (10)
```
CI على PR #105 للإيداع `d7a353b` (آخر إيداع قبل هذا السطر)، كلها نجحت:
```
Lint, typecheck, contracts, tests, build                 pass  13m20s
Web smoke journeys (Playwright against the real hub)     pass  5m10s
Docker image builds and answers /health                  pass  2m30s
db:generate + db:migrate (SQLite and PostgreSQL)         pass  1m4s
PR adds or updates a change record                       pass  13s
PR leaves graphify-out/ to the code-map bot              pass  10s
```

بعد دمج `origin/main` (فيه #104 «الوكيل العام» الذي أخذ §46): تعارض واحد في `DECISIONS.md`،
فصار قرار هذه المهمة **§47** وعُدّلت الإشارات إليه. أُعيدت الفحوص على الدمج:
```
$ pnpm lint                      -> All matched files use Prettier code style!
$ pnpm typecheck                 -> exit 0
$ pnpm i18n:check                -> i18n:check  OK
$ pnpm contracts:lint            -> contracts:lint  OK
$ pnpm contracts:check-clients   -> check-clients  OK — 284 client file(s) scanned, 176 contract path(s) known.
$ pnpm nav:check                 -> nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm change-record:check       -> change-record  OK — 1 record(s) valid
$ vitest run tests/unit/task-runs.test.ts tests/unit/config.test.ts src/modules/tasks/ tests/unit/task-worktrees.test.ts   (server)
 Test Files  9 passed | 2 skipped (11)
      Tests  102 passed | 6 skipped (108)
$ vitest run tests/task-worktrees.test.tsx tests/task-run.test.tsx tests/task-hermes-card.test.tsx tests/i18n.test.ts   (web)
 Test Files  4 passed (4)
      Tests  28 passed (28)
```

## المخاطر والرجوع
- **العدّ والطابور في الذاكرة**: يعيشان ما دامت العملية؛ إعادة التشغيل تُنهي التشغيلات فيبدأ العدّ
  من صفر، وعند الإقلاع يُنظر في كل بروفايل فيه مهام تنتظر البدء.
- **المستودع داخل البروفايل**: مستودع موجود في مكان آخر على المضيف يجب نسخه (أو استنساخه بالوكيل)
  إلى مجلّد البروفايل أولًا.
- **الإزالة `--force`**: تُضيع التغييرات غير المودَعة في الشجرة (النافذة تقول ذلك قبل التأكيد)؛
  الفرع وإيداعاته باقية. حذف المهمة وأرشفتها يزيلان كذلك بلا سؤال إضافي.
- لا ضمّ ولا PR من الشجرة (`merged` محجوزة)، ولا انتظار الاعتماديات قبل البدء التلقائي، ولا الغرف.
- `COREHUB_TASK_AUTO_START_MAX` متغيّر سابع في جدول النشر.
- الرجوع: الفرع وحده، بلا هجرة (كل الأعمدة موجودة منذ `0005`).

## التسليم والخطوة التالية
PR إلى `main` من `feat/task-worktrees`. الدمج والنشر للمالك. التالي: الإبلاغ في غرفة المشروع حين
تُبنى الغرف، وانتظار الاعتماديات قبل البدء، وربما ضمّ الفرع أو فتح PR منه من التفاصيل.
