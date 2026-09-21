# سجل الوكلاء (catalog + adapters) ونواة المهام

المسؤول: twuijri · الفرع: feat/auth-and-agents · الحالة: review

## المشكلة والهدف

المرحلة ٠ تحتاج إلى ما يجعل «الوكلاء» حقيقة: سجل يقرأه العميل، وقائمة معتمدة (catalog)
يختار منها المستخدم ما يثبّته، وعمليات تثبيت/تحديث/إزالة تعمل كـ Jobs بأحداث تقدّم،
ومحوّلات ADR 0002 الثلاثة. قبل هذا التغيير كانت كل عمليات `agents.*` و`jobs.*` ردود 501،
ولم يكن هناك من يكتب `audit_events` سوى ملف مؤقت داخل `auth`.

الهدف: وحدة `agents` كاملة لما تعِد به ADR 0006 (Hermes في الصورة، البقية تُثبَّت عند الطلب
في `${DATA_DIR}/agents/<id>`)، ونواة Jobs في `audit` تستخدمها هذه الوحدة وستستخدمها
`sessions` لاحقًا، ومساحة `/rt/jobs`.

## القرار والموافقات

- **الغرفة النظيفة (ADR 0004):** لم يُفتح أي مصدر من `Hermes Studio / Ekko Studio` ولا
  `packages/*` في نسخة المالك. المصادر المقروءة: وثائق هذا المستودع، وثائق Hermes العامة
  (MIT) عبر `docs/inspirations/hermes-agent.md`، وتوثيق ACP العام
  (`agentclientprotocol.com`: `initialize` بـ `protocolVersion: 1`، `session/new`،
  `session/prompt`، إشعارات `session/update`، `session/cancel`).
- **ADR 0007:** لم يُشتق أي شكل من تطبيقي الهاتف القديمين. فُتح عميل أندرويد المالك مرة
  واحدة في بداية العمل للاطّلاع على تدفّق الاقتران، وتبيّن أنه **لا يحتوي اقترانًا بـ QR
  أصلًا** (يستخدم `/api/auth/login` القديم)، فلم يُنسخ منه شيء؛ وحدة `auth` كلّها صارت من
  فرع آخر على أي حال.
- **قائمة معتمدة لا مفتوحة (ADR 0006):** `catalog/` ملف لكل وكيل بـ id ووصفة تثبيت ونسخة
  مثبّتة (pin) وفحص صحة ورخصة. `agents.discover` صار يحدّث مدخلات القائمة فقط ويُبلغ عن
  أي ثنائي آخر وجده تحت `ignored` دون تخزينه؛ لا يمكن تثبيت وكيل خارج القائمة بأي طريق.
- **«up to date» تعني الـ pin لا `latest`:** `agents.checkUpdate` يقارن المثبّت بالنسخة
  المعتمدة في القائمة، فلا يعرض المركز تحديثًا لم يراجعه المالك.
- **حالة `available` مقابل `not_installed`:** ADR 0006 يقول إن الوكيل غير المثبّت يبقى
  **ظاهرًا**؛ العقد يملك قيمة `not_installed` صريحة، فالسجل يعرضه ظاهرًا بحالته الصحيحة،
  وهذا ما يرسم به العميل زر «تثبيت».
- **محوّل العمليات (process harness) معلن وغير قابل للاختيار:** `selectable: false`،
  وكل عملياته ترمي `not_implemented`؛ محلّل النصوص الطرفية تخمين، والتخمين يعرض للمستخدم
  نصًا لم يكتبه الوكيل.
- **`hermes.start()` يبقى 501:** تشغيل دور كامل يحتاج سطح TUI gateway وهو مع وحدة
  `sessions`؛ إرجاع جلسة لا يستطيع المركز بثّها ادّعاء نجاح كاذب.

يحتاج قرار المالك: (أ) التغييران في العقد أدناه؛ (ب) تعديلان صغيران داخل `auth` (مذكوران).

## العقد (ما تغيّر في packages/contracts)

تغييران، كلاهما إضافة متوافقة:

1. `JobKind` += `check_update`. لم تكن هناك قيمة تصف عملية `agents.checkUpdate` التي
   يعلنها العقد نفسه (`refresh_catalogue` للنماذج، و`update` كذب لأنها لا تحدّث شيئًا).
2. `Job.resource` صار `oneOf: [ResourceRef, null]` مع وصف. كان مطلوبًا وغير قابل للتفريغ،
   بينما `agents.discover` عمل على مستوى المضيف بلا كيان واحد.

طُبّق التغييران في `openapi.yaml` وفي `$defs` لملفات أحداث `/rt/jobs` الستة
و`common.schema.json`.

## الملفات والتأثير

**جديد — `agents`:**
`catalog/{types,index,hermes,claude-code,codex,gemini-cli,opencode}.ts` (القائمة المعتمدة)،
`adapters/{types,host,acp,hermes,process,index}.ts` (ADR 0002)، `installer.ts`،
`service.ts`، `serialize.ts`، `ports.ts`، `index.ts`، واختبارات
`agents.test.ts` + `adapters/adapters.test.ts`.

**جديد — `audit`:** `service.ts` (`AuditService`: `record` للسجل، `createJob/startJob/
progressJob/finishJob/requestCancel` للمهام، `recordUsage/totalsFor*` للتكلفة)،
`jobs.ts` (مشغّل المهام)، `index.ts` (مسارات `jobs.*` و`/rt/jobs`)، `audit.test.ts`.

**جديد — `lib`:** `contract.ts` (مدقّقات AJV مشتقّة من العقد لكل عملية)، `route.ts`
(`defineRoute`: المسار والحراس والمخططات كلها من العقد)، `realtime.ts` (مغلّف الحدث
وغرف `profile:`/`user:`)، `pagination.ts`، `time.ts`.

**معدّل:**

- `lib/errors.ts` — قائمة `ErrorCode` صارت نسخة طبق الأصل من `ErrorCode` في العقد
  (أُضيفت `state_invalid`, `already_running`, `payload_too_large`,
  `unsupported_media_type`, `agent_unavailable`, `agent_error`, `service_unavailable`)،
  و**`internal_error` صار `internal`** لأن الأولى ليست في العقد أصلًا، فكان أي رد ٥٠٠
  يخالف العقد. (`app/routes.ts` و`auth/pairing.ts` تبعًا لذلك.)
- `lib/module.ts` — `/rt/jobs` في `REALTIME_NAMESPACES` (العقد يعلنه في
  `Meta.realtime_namespaces`)، و`SOCKET_PATH` انتقل إلى هنا كي لا تستورد أي وحدة `app/`.
- `app/config.ts` — `readHostEnv()`: `PATH` وبيئة العمليات الأبناء تُقرأ هنا وهنا فقط،
  حتى تبقى قاعدة «`config.ts` وحده يلمس `process.env`» صحيحة (يتحقق منها اختبار).
- `modules/agents/schema.ts` — مفردات العقد (`AgentKind`, `AgentCapability`,
  `AgentSection`, `AgentInstall.source`)، `broken → failed`، وأعمدة `licence`,
  `package_name`, `latest_version`, `auto_update`, `checked_at`, `sections`, `selectable`.
- `drizzle/0001_overjoyed_king_cobra.sql` — **مكتوبة يدويًا**: ما ولّدته `drizzle-kit`
  كان معطوبًا (ينسخ أعمدة الجدول الجديد من الجدول القديم، فيفشل بـ
  `no such column: "vendor"`). المكتوبة يدويًا تنسخ الأعمدة المشتركة فقط وتترجم القيم
  القديمة (`process→harness`, `bundled→builtin`, `detected/manual→user_cli`,
  `broken→failed`). قاعدة SQLite لا تسمح بتعديل CHECK، لذلك يُعاد بناء الجدولين.

**معدّل داخل `auth` (أصغر تغيير ممكن، يحتاج موافقة صاحب الفرع):**

- حُذف `auth/audit-stub.ts` واستُبدل بـ `AuditService` من `audit` (نفس الصفوف، بلا SQL يدوي).
- `index.ts` يصدّر `ownerUser` (كان موجودًا وغير مُصدَّر) — يحتاجه `agents` لنسب صفوف
  السجل إلى حساب المالك.
- `registerWorkspaceStatsProvider` صار يجمع مزوّدين بدل أن يستبدل واحدًا، وإلا لدهس
  `agents` رقم `sessions` والعكس. كل مزوّد يجيب عن حقله فقط.
- `sockets.ts` صار يقرأ `auth.profile` من المصافحة وينضم إلى `profile:<slug>` — هذا ما
  يعلنه `events/README.md` §Connecting، وبدونه لا يصل أي حدث على مستوى مساحة العمل.

## الفحوص (الأوامر ونواتجها الفعلية)

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck                     # contracts + server, tsc --noEmit
(بلا مخرجات = بلا أخطاء)

$ pnpm test
 Test Files  3 passed (3)      # @majlis/contracts
      Tests  11 passed (11)
 Test Files  23 passed (23)    # @majlis/server، منها 39 للوكلاء والمحوّلات و9 للمهام
      Tests  99 passed (99)

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  247 passed (247)

$ pnpm build                         # contracts + server
(بلا أخطاء)

$ pnpm contracts:lint
contracts:lint  redocly lint openapi.yaml
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ pnpm i18n:check
i18n:check  server: 61 keys, ar/en in parity
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 35 destinations, 37 terms, ar/en complete

$ pnpm db:generate                   # على المخطط المدموج بعد إعادة الأساس
[✓] Your SQL migration file ➜ drizzle/0001_overjoyed_king_cobra.sql 🚀
(أي: أنتجت 0001، ثم أُعيدت كتابتها يدويًا لأن المولّدة لا تعمل — انظر أعلاه)

$ DATA_DIR=<temp> tsx src/app/migrate.ts     # قاعدة SQLite جديدة، 0000 ثم 0001
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}
```

ما **لم** يُشغَّل: `pnpm db:migrate` على PostgreSQL (غير مدعوم أصلًا، `src/db/README.md`)،
وبناء صورة Docker.

## المخاطر والرجوع

- **نسخ القائمة المثبّتة لم تُتحقَّق من npm.** أرقام `catalog/*.ts`
  (`@zed-industries/claude-code-acp@0.6.1`، `@google/gemini-cli@0.14.0`،
  `@openai/codex@0.56.0`، `opencode-ai@0.15.9`) كُتبت بلا وصول إلى الشبكة؛ المالك
  يراجعها ويصححها قبل أي تثبيت حقيقي. البنية صحيحة، الأرقام تحتاج تأكيدًا.
- **أعلام ACP لكل أداة** (`--experimental-acp`، `acp`) من وثائقها العامة ولم تُجرَّب على
  ثنائي حقيقي؛ محوّل ACP مُختبَر بالكامل ضد وكيل وهمي داخل الاختبارات.
- **`hermes.start()`، `agents.restart`، وبقية مسارات الوكيل** ما زالت 501 موثّقة.
- **`registerWorkspaceStatsProvider` عالمي** لا مرتبط بتطبيق: في سلسلة اختبارات تبني عدة
  مراكز في عملية واحدة، آخر مزوّد مسجَّل هو الذي يجيب. مغلّف بـ try/catch حتى لا يُفشل
  قراءة الملف الشخصي. الإصلاح الصحيح: ربط السجلّ بكل تطبيق.
- **مهمة بلا مساحة عمل** (`auth.importProfile`) تُخزَّن بـ `workspace: null` ولا تظهر في
  `jobs.list` المحصور بمساحة العمل، بينما `Job.profile` في العقد غير قابل للتفريغ؛ من
  ينفّذ استيراد الملف الشخصي يملك هذه الفجوة.
- الرجوع: حذف `modules/agents`، `modules/audit/{service,jobs}.ts`، ملفات `lib` الجديدة،
  والمهاجرة `0001`، وإرجاع `auth/audit-stub.ts`.

## التسليم والخطوة التالية

1. الفرع `feat/auth-and-agents` مبنيّ فوق `origin/feat/auth` (PR #2) لأن وحدة `auth` هناك
   هي المعتمدة؛ وحدتي الخاصة بـ `auth` حُذفت بالكامل. يجب دمج PR #2 أولًا.
2. المالك يراجع: تغييرَي العقد، نسخ القائمة المثبّتة، والتعديلات الأربعة داخل `auth`.
3. الخطوة التالية: `sessions` (PR #1) يُوصَل بسطر واحد في `src/modules/index.ts` عبر
   `agentDirectory(app)`؛ ثم `AgentRunner` فوق `AcpSession` لتشغيل أول دور حقيقي.

## تحديث لاحق (المنسّق، 2026-09-21)
- أُعيد تركيب الفرع فوق `feat/sessions-streaming` (طلب الدمج #1). تعارضات `audit` حُلّت بأخذ نسخة هذا الفرع (الأشمل، بنفس أسماء التصدير التي يستهلكها موديول الجلسات)، وملفا الترجمة يحملان كتل `auth` و`sessions` و`jobs` معاً، وقائمة أكواد الأخطاء من العقد حرفياً.
- لا نسخة منشورة بعد، فجُمع المخطط في ترحيل واحد `0000_yellow_network.sql`؛ `db:generate` بعدها «لا تغييرات»، و`db:migrate` على قاعدة جديدة ينجح.
- الفحوص بعد التركيب: lint وtypecheck وbuild نظيفة، الوحدات 11 + 153، العقد 247، i18n وcontracts:lint سليمة.
