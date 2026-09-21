# إعادة تسمية قسم «اللوحة» إلى «المهام» (Tasks)

المسؤول: twuijri · الفرع: chore/rename-board-to-tasks · الحالة: review

## المشكلة والهدف

القسم الذي يعرض المشاريع والمهام كان يحمل ثلاثة أسماء في آنٍ واحد: `board`
في وحدة الخادم وفي وسم العقد ومعرّفات العمليات، و«Board / اللوحة» في خريطة
التنقّل، و«kanban» في قدرات الوكيل وفي وثيقة التغطية. قرّر المالك
(٢٠٢٦-٠٩-٢١) أن اسم القسم **Tasks / المهام** ولا شيء غيره: لا Kanban ولا
Board. الهدف تطبيق الاسم الواحد في كل مكان **قبل** أن يُبنى عليه أي كود أو
عميل، لأن التغيير بعد البناء يكسر العملاء والهجرات.

كلمات النموذج تبقى كما هي: عمود (`column`)، بطاقة (`card`)، مسار
(`swimlane`). المتغيّر هو اسم القسم فقط.

## القرار والموافقات

- قرار المالك في المحادثة (٢٠٢٦-٠٩-٢١): القسم اسمه **Tasks** / «المهام».
- ما قبل 1.0: إعادة التسمية كاسرة ومسموحة بلا `/api/v2` (ADR 0003 يقيّد
  التغييرات الكاسرة بعد الإصدار؛ لا يوجد عميل منشور ولا قاعدة بيانات منشورة).
  سُجّل ذلك في `docs/contracts/DECISIONS.md` §25.
- لا شيء منشور: حُذفت الهجرة الوحيدة `0000_*` وأُعيد توليد واحدة نظيفة بدل
  إضافة هجرة إعادة تسمية.
- لم يُفتح أي مصدر من Hermes Studio / Ekko Studio (ADR 0004).

## العقد (ما تغيّر في packages/contracts)

| القديم | الجديد |
|---|---|
| الوسم `board` | الوسم `tasks` |
| `board.*` (٢٧ معرّف عملية) | `tasks.*` |
| `GET /board` | `GET /task-columns` |
| `POST /board/dispatch` | `POST /task-dispatches` |
| المخطط `Board` | المخطط `TaskColumns` |
| `AgentCapability: kanban` | `AgentCapability: tasks` |
| `AgentSection: kanban` | `AgentSection: tasks` |
| `events/board/` (١٢ حدثًا) | `events/tasks/` |
| النطاق `/rt/board` | النطاق `/rt/tasks` |

`/board` لم تصبح `/tasks` لأن `/tasks` موجود أصلًا (قائمة المهام)، ولم تصبح
`/tasks/columns` أو `/tasks/dispatch` لأنهما شقيقان حرفيان لـ`/tasks/{task_id}`
وهذا ممنوع بقرار العقد §7 ويرفضه `no-ambiguous-paths` في redocly. اتُّبع نمط
البيت نفسه (`/room-invites`, `/agent-discoveries`, `/delivery-targets`):
مجموعة عليا بشرطة.

استثناء واحد في التعيين الحرفي: `board.get` صار `tasks.getColumns` لا
`tasks.get`، لأن `tasks.get` يُقرأ «اجلب مهمة» بينما العملية تجلب الأعمدة؛
الاسم الجديد يطابق مساره `/task-columns`. ما عداه تعيين حرفي
(`board.listTasks` → `tasks.listTasks`، وهكذا).

أسماء الأحداث نفسها لم تتغيّر (`task.moved`, `project.created`, …) لأنها
`<entity>.<verb>` ولا تسمّي القسم.

## الملفات والتأثير

- `packages/contracts/openapi.yaml` — الوسم والمسارات والمعرّفات والمخطط
  والنطاقات في `Meta.realtime_namespaces`.
- `packages/contracts/events/board/` → `packages/contracts/events/tasks/`
  (git mv، ١٢ ملفًا)، و`events/README.md` (النطاق، جدول الأوامر، الفهرس).
- `packages/server/src/modules/board/` → `modules/tasks/` مع
  `board.test.ts` → `tasks.test.ts`، و`boardModule` → `tasksModule`.
- `packages/server/src/lib/module.ts` — `MODULE_NAMES` و`REALTIME_NAMESPACES`.
- `packages/server/src/modules/index.ts`, `src/db/schema.ts`,
  `eslint.config.js` — قائمة الوحدات.
- `packages/server/src/modules/agents/schema.ts` و`catalog/hermes.ts` —
  `kanban` → `tasks`.
- قاعدة البيانات: الفهرس `tasks_board_idx` → `tasks_workspace_status_idx`؛
  أسماء الجداول (`projects`, `tasks`, `task_transitions`, `task_dependencies`,
  `worktrees`) لم تكن تسمّي القسم فلم تتغيّر. حُذفت
  `drizzle/0000_yellow_network.sql` ومخططها وأُعيد التوليد.
- `docs/clients/navigation.json` + `NAVIGATION.md` — الوجهة `board` → `tasks`،
  المصطلح `Tasks` / «المهام».
- `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `README.md`,
  `docs/domain/board.md` → `docs/domain/tasks.md`, `docs/domain/README.md`,
  `docs/domain/{sessions,schedules,knowledge,audit,DECISIONS}.md`,
  `docs/contracts/{README,COVERAGE,DECISIONS}.md`,
  `docs/adr/{0002,0005,0006}`, `docs/inspirations/*`.

بقي عمدًا: أسماء المشاريع الخارجية في `docs/inspirations/`
(Vibe Kanban, Claw-Kanban, clawboard) وأسماء ملفاتها؛ وسجلات التغيير
السابقة في `docs/changes/` لأنها دليل تاريخي لا يُعاد كتابته؛ وكلمات
`dashboard` و`clipboard` و`keyboard` التي لا علاقة لها بالقسم.

## الفحوص (الأوامر ونواتجها الفعلية)

كلها على Node v24.21.0 وpnpm 12.5.1، في شجرة عمل معزولة على الفرع نفسه.

```
$ pnpm lint
All matched files use Prettier code style!            (exit 0)

$ pnpm typecheck
packages/contracts / packages/cli / packages/server → Done   (exit 0)

$ pnpm test
packages/contracts   Test Files  3 passed (3)    · Tests  11 passed (11)
packages/cli         Test Files 10 passed (10)   · Tests  55 passed (55)
packages/server      Test Files 30 passed | 1 skipped (31) · Tests 187 passed | 1 skipped (188)
(exit 0)

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  247 passed (247)                     (exit 0)

$ pnpm contracts:lint
contracts:lint  redocly lint openapi.yaml
openapi.yaml: validated in 417ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK                                (exit 0)

$ pnpm contracts:check-clients
check-clients  OK — 32 client file(s) scanned, 161 contract path(s) known.   (exit 0)

$ pnpm nav:check
nav:check  OK — 35 destinations, 37 terms, ar/en complete                    (exit 0)

$ pnpm i18n:check
i18n:check  server: 72 keys, ar/en in parity
i18n:check  cli: 167 keys, ar/en in parity
i18n:check  web: packages/web/src/i18n not present yet — skipped
i18n:check  desktop: apps/desktop/src/i18n not present yet — skipped
i18n:check  OK                                    (exit 0)

$ pnpm build
packages/contracts / packages/cli / packages/server → Done                   (exit 0)
```

توليد العملاء لا يترك فرقًا في ملفات متتبَّعة (`packages/contracts/generated/`
مستثنى في `.gitignore`؛ مولّدا Kotlin/Swift يحتاجان Java وهي غير مثبَّتة محليًا،
وCI يشغّلهما من `openapi.yaml` نفسه):

```
$ pnpm contracts:generate
contracts:generate:ts  wrote generated/ts/schema.ts
contracts:generate:native  Java runtime not found; Kotlin/Swift clients not generated.
$ git status --porcelain packages/contracts/generated
(لا شيء)
```

الهجرة: حُذفت `0000_yellow_network.sql` ومخططها وسجلّها، ثم:

```
$ pnpm db:generate
[✓] Your SQL migration file ➜ drizzle/0000_loving_doorman.sql 🚀

$ pnpm db:generate            # مرة ثانية
No schema changes, nothing to migrate 😴

$ DATA_DIR=<tmp>/hub-data pnpm db:migrate     # قاعدة SQLite جديدة تمامًا
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}
```

الفهرس الوحيد الذي كان يسمّي القسم صار:

```
$ grep tasks_workspace_status_idx packages/server/drizzle/0000_loving_doorman.sql
CREATE INDEX `tasks_workspace_status_idx` ON `tasks` (`workspace`,`archived_at`,`status`,`sort_key`);
```

بحث نهائي عن بقايا (`grep -rIin "kanban\|board"` على كل الملفات المتتبَّعة،
باستثناء `clipboard`/`keyboard`/`dashboard`): لا يبقى إلا ما هو مقصود —
أسماء المشاريع الخارجية في `docs/inspirations/` وفي عمود «المصدر» من
`ARCHITECTURE` (clawboard, Vibe Kanban, Claw-Kanban, Hubcode, Hermes Kanban)،
وعبارة «kanban-style» في أول ذكر تشرح شكل القسم (README، ARCHITECTURE،
ROADMAP، navigation.json، وسم العقد، رأسا وحدة `tasks`)، والقرارات ٢ و٦ و٨ في
`docs/contracts/DECISIONS.md` التي لا تُحرَّر بل يَنسخها القرار ٢٥ الجديد،
وسجلات `docs/changes/` السابقة لأنها دليل تاريخي.

## المخاطر والرجوع

- الخطر الوحيد ذو الأثر: أي عميل أو هجرة كُتبت على الأسماء القديمة. لا يوجد
  أيٌّ منهما اليوم — `packages/web` و`apps/*` غير موجودة بعد، ووحدة `tasks`
  لا تسجّل أي مسار حتى الآن، والهجرة الوحيدة لم تُطبَّق على أي نشر.
- الرجوع: `git revert` لالتزام واحد؛ ولأن الهجرة أُعيد توليدها من الصفر فإن
  الرجوع يعيد الهجرة القديمة نفسها بلا حالة قاعدة بيانات عالقة.

## التسليم والخطوة التالية

الفرع جاهز للمراجعة، بلا دفع وبلا طلب دمج (قرار المالك يسبق النشر).
الخطوة التالية: بناء قسم المهام في الخادم على الأسماء الجديدة.
