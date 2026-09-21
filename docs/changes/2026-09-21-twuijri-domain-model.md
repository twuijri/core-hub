# نموذج المجال ومخطط قاعدة البيانات
المسؤول: twuijri · الفرع: docs/domain-model (يُنشئه المسؤول؛ لم يُنفَّذ git في هذه المهمة) · الحالة: review

## المشكلة والهدف
لا يوجد بعد نموذج مجال ولا مخطط قاعدة بيانات لـ Majlis. المطلوب: خريطة الكيانات
بملكية واضحة لكل وحدة (اللامتغيّر 1 في `ARCHITECTURE.md`)، آلات الحالة لـ `run`
و`task` و`workflow_run` و`job` بحالات نهائية صريحة، قواعد الأرشفة والحذف، ومخططات
Drizzle لكل وحدة تعمل على SQLite مع خيار PostgreSQL، وسجل القرارات والبدائل
المرفوضة. المفردات موحَّدة مع وكيل العقد الذي يعمل بالتوازي.

## القرار والموافقات
- الغرفة النظيفة (ADR 0004): لم يُفتح مصدر Hermes Studio / Ekko Studio ولا
  `packages/*` في نسخة المالك. المراجع المسموحة فقط: clawboard (MIT) لأفكار
  الكيانات (المهام، المشاريع، اليوميات، الإضافات)، وتطبيق Android الخاص بنا
  (MIT) لمعرفة ما يعرضه العميل.
- 13 وحدة كما في `ARCHITECTURE.md` §Modules، 55 جدولًا. الكيانات
  الإضافية على المفردات المطلوبة مبرَّرة في `docs/domain/DECISIONS.md`
  (`schedule_run`، `task_dependency`، `room_member`، `device_command`،
  `notification_delivery`، `webhook_delivery`، `push_credential`،
  `channel_subscription`، `job_event`، `plugin_tool`، `login_lockout`،
  `pairing_code`، `workspace_member`، `model_default`، `performance_snapshot`).
- انحرافان عن نص التكليف يحتاجان موافقة المالك:
  1. الجداول العامة (مستخدمون، مساحات عمل، رموز، أجهزة، سجل الوكلاء، قنوات
     الإصدار، الإضافات) بلا عمود `workspace` بدل قيمة وهمية (`DECISIONS.md` §7).
  2. جدول `job` مملوك لوحدة `audit` بدل وحدة جديدة `jobs` تتطلب ADR
     (`DECISIONS.md` §6). إن فضّل المالك وحدة مستقلة فالنقل ملف واحد وسطر واحد.
- المراجع بين الوحدات أعمدة معرّفات بلا مفاتيح أجنبية في قاعدة البيانات؛ المفاتيح
  الأجنبية داخل الوحدة فقط (`DECISIONS.md` §5).

## العقد
لا شيء في `packages/contracts` (لم يُنشأ بعد). ثوابت القوائم (`RUN_STATUSES`
وأخواتها) مصدَّرة من كل `schema.ts` ليعيد العقد استخدامها.

## الملفات والتأثير
- `docs/domain/README.md` — خريطة الكيانات (Mermaid ER)، الملكية لكل وحدة،
  آلات الحالة الأربع، قواعد الأرشفة والحذف، ما لا يُخزَّن.
- `docs/domain/DECISIONS.md` — 20 قرارًا مع البدائل المرفوضة.
- `docs/domain/{auth,agents,sessions,rooms,board,schedules,knowledge,models,devices,notify,updates,audit,plugins}.md`
  — الحقول والأنواع والفهارس واستعلامات العملاء وما لا يُخزَّن.
- `packages/server/src/db/{ids.ts,columns.ts,schema.ts,README.md}` — مولّد
  ULID، مساعدات الأعمدة وخريطة SQLite⇄PostgreSQL، التجميع، الترحيلات.
- `packages/server/src/modules/<module>/schema.ts` × 13.
- وكيل الهيكل يعمل بالتوازي في `packages/server` (`app/db.ts` يستورد
  `src/db/schema.ts` كما هو، `drizzle.config.ts` يقرأ الحزمة نفسها). لم يُلمس أي
  ملف من ملفاته؛ `db/README.md` عُدِّل ليطابق ما بناه فعلًا (`DATA_DIR`،
  `DATABASE_URL`، `<DATA_DIR>/hub.sqlite`، السكربتان `db:generate` و`db:migrate`).

## الفحوص (الأوامر ونواتجها الفعلية)
شُغِّلت في مجلد عمل مؤقت خارج المستودع لأن المستودع بلا `package.json` بعد
(`drizzle-orm@0.45.2`، `drizzle-kit` الأحدث، `typescript@7.0.2`، Node 24.21.0)،
على نسخة حرفية من `packages/server/src/{db,modules}`:

```
$ npx tsc -p tsconfig.json   # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax, NodeNext
tsc exit: 0

$ npx drizzle-kit generate   # dialect: sqlite, schema: ./src/db/schema.ts
[✓] Your SQL migration file ➜ drizzle/0000_secret_black_bird.sql
$ grep -c 'CREATE TABLE' drizzle/*.sql
55

$ node probe.cjs             # يطبّق الترحيل على SQLite جديد عبر node:sqlite مع PRAGMA foreign_keys=ON
statements applied: 158 | tables: 55 | indexes: 103
CHECK enforced: CHECK constraint failed: runs_status_check
partial unique enforced: UNIQUE constraint failed: worktrees.task_id
self-dependency blocked: CHECK constraint failed: task_dependencies_no_self_check
cascade project->tasks->worktrees: tasks left = 0 , worktrees left = 0
```

بعد أن أنشأ وكيل الهيكل سلسلة الأدوات في `packages/server` بالتوازي (Drizzle ORM
0.45.2، Drizzle Kit 0.31.10، TypeScript 5.9.3، `tsconfig.base.json` الصارم)،
أُعيد الفحص بأدوات المستودع نفسها ومن دون كتابة في `packages/server/drizzle/`
(مجلد الوكيل الآخر):

```
$ cd packages/server && ./node_modules/.bin/tsc --noEmit -p tsconfig.json   # يشمل app/db.ts الذي يستورد src/db/schema.ts
tsc exit: 0

$ ./node_modules/.bin/drizzle-kit generate --dialect sqlite --schema ./src/db/schema.ts --out <scratch>
[✓] Your SQL migration file ➜ <scratch>/0000_tiny_phantom_reporter.sql
tables: 55
DDL identical to scratch drizzle-kit generate
```

لم يُشغَّل: `pnpm db:migrate` على PostgreSQL (لا نسخة `pg-core` ولا سجل ترحيل
لهذه اللهجة بعد؛ الخريطة والنواقص موثّقة في `db/README.md`)، ولا `pnpm test`
(اختبارات الهيكل ملك وكيله ولا تمس المخطط).

## المخاطر والرجوع
- الخطر: اختلاف مفردات العقد عن أسماء الأعمدة/القوائم هنا. التخفيف: الثوابت
  المصدَّرة هي المصدر الوحيد؛ يراجع وكيل العقد `docs/domain/README.md` قبل
  التثبيت.
- الخطر: تكلفة الجولات على `usage_records` بلا ربط. التخفيف: أعمدة الأصل
  المنسوخة والفهارس المركّبة.
- الرجوع: حذف `docs/domain/` و`packages/server/src/{db,modules}` — لا بيانات
  ولا ترحيلات ملتزَمة بعد.

## التسليم والخطوة التالية
1. مراجعة المالك للانحرافين أعلاه (الجداول العامة، ملكية `job`).
2. وكيل الهيكل: `drizzle.config.ts`، سكربتات `db:generate/migrate/check`،
   وتوليد نسخة `pg-core` الميكانيكية، ثم تشغيل الترحيل على PostgreSQL في CI.
3. وكيل العقد: مطابقة المفردات وقوائم الحالات مع الثوابت المصدَّرة.
4. الترحيل الأول يُولَّد داخل المستودع بعد ربط سلسلة الأدوات، لا يُنسخ من
   المجلد المؤقت.
