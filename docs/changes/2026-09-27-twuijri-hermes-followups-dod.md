# متابعات هرمز (B17) وتعريف الإنجاز للمهام (B18)
المسؤول: twuijri · الفرع: feat/hermes-followups-dod (يُدمج في night/2026-09-27، طلب #165) · الحالة: review

## المشكلة والهدف
من قائمة فجوات الفورك (fork-gap-list، الدفعتان B17 وB18):
- **B17 — متابعات هرمز**: تفاصيل بطاقة هرمز لا تعرض أحداث هرمز ولا تشغيلاته؛ التعديل الجماعي لا
  يقول تعليقًا ولا واجهة له في الويب؛ صفحة المهارات لا تعرف قائمة الإطفاء في إعداد هرمز وتعرض مهارات
  أنظمة أخرى (ماك)؛ أسماء البروفايلات لا تُقرأ من هرمز عند تبنّيها، واسم الافتراضي لا يُكتب عند
  الإعداد الأول؛ محادثات القنوات تقف عند ١٠٠ محادثة و٥٠٠ رسالة، وصور تيليجرام لا تظهر.
- **B18 — تعريف الإنجاز**: قائمتا «تعريف الإنجاز» و«القيود» على المهمة: في العقد، وعلى بطاقة
  اللوحة، وفي نافذة التفاصيل، وتُرسلان مع التشغيل في نص المهمة، وتظهران عند المراجعة بمربعات يعلّمها
  المراجع.

## القرار والموافقات
قرأتُ مصدر هرمز (MIT، الوسم `v2026.9.14`، `Hermes Agent v0.21.3`) وكتبت ما يفعله بكلماتنا في
DECISIONS §103 و§104 (§102 أخذها فرع متابعات الويب في طلب الليلة نفسه). كل القرارات **مقترحة —
للمالك أن يؤكد**:
1. **تاريخ بطاقة هرمز** (`TaskDetail.hermes`): أحداثه وتشغيلاته كما يحفظها، الأحدث أولًا (١٠٠ حدث
   و٢٠ تشغيلًا على الأكثر)، بكلمات هرمز؛ ما لا يعرفه الويب يُعرض كما كتبه هرمز.
2. **تعليق جماعي** (`TaskBulkUpdate.patch.comment`) وأولوية جماعية، على هرمز أولًا؛ رفض هرمز لبطاقة
   لا يُسقط البقية. وفي الويب زر «تحديد» على اللوحة وشريط: الأولوية، وتعليق على الكل.
3. **مفتاح المهارة هو مفتاح هرمز**: الإطفاء والتشغيل يكتبان قائمة `skills.disabled` في `config.yaml`
   للبروفايل (كما يفعل هرمز)، فيصلح للمهارات المدمجة أيضًا دون لمس ملفاتها؛ `hermes-agent` لا يُطفأ
   (`409 skill_essential`). التشغيل يعيد أيضًا اسم `SKILL.md.off` الذي تركه مركز أقدم.
4. **مهارات نظام آخر لا تُعرض** (`platforms:` لا تشمل نظام المركز)، كما لا يعرضها هرمز. أما المهارة
   المقيّدة بسياق (`environments:` مثل عامل كانبان) فتبقى معروضة لأنها من مهارات البروفايل ويمكن
   إطفاؤها — وهذا الفرق الوحيد عن قائمة لوحة هرمز (ثبّته الاختبار الحقيقي: `sdlc-review`).
5. **الأسماء من هرمز**: بروفايل يتبنّاه المركز يأخذ اسم عرضه في هرمز، واسم غُيّر من جهة هرمز يُؤخذ عند
   القائمة التالية، وبروفايل بلا اسم عرض يبقى باسمه في المركز؛ واسم الافتراضي المعطى في الإعداد الأول
   يُكتب في هرمز.
6. **ترقيم محادثات القنوات**: `limit` (حتى ١٠٠٠ لكل بروفايل) مع `has_more`، و`offset`/`next_offset`
   للرسائل الأقدم؛ في الويب «محادثات قنوات أقدم» و«حمّل رسائل أقدم».
7. **صور القنوات**: هرمز يحفظ الصورة في ذاكرة الصور للبروفايل يومًا واحدًا ويخزّن في الرسالة ملاحظة
   باسم الملف فقط؛ المركز يستخرج الاسم (PNG وJPEG وGIF وWebP) ويحذف ملاحظات هرمز من النص ويعرضها في
   `ChannelMessage.attachments` مع `available`، وعملية جديدة `sessions.getChannelPicture` تقدّمها
   بالاسم من تلك الذاكرة فقط. الويب يرسمها في الفقاعة أو يقول إن هرمز لم يعد يحتفظ بها.
8. **تعريف الإنجاز والقيود** (§104): قائمتان حتى ٣٠ سطرًا، تُرسلان في نص التشغيل بلغته، يعلّمها
   المراجع والمهمة في المراجعة (الحفظ بزر «حفظ»)، وكل تشغيل جديد يمسح العلامات؛ البطاقة تعرض
   `✓ 1/3`. بطاقة هرمز لا تأخذهما (`409 hermes_owns_card`) لأن هرمز يوجّه عامله من البطاقة؛ ومهمة
   المركز التي تُسلَّم لهرمز وتبدأ تحملهما في وصف بطاقة هرمز.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- مخططات جديدة: `TaskCheckItem`، `TaskCheckItemWrite`، `HermesCardHistory`، `HermesCardEvent`،
  `HermesCardRun`، `ChannelAttachment`.
- `Task.definition_of_done` و`Task.constraints` (تُرسل دائمًا)، وفي `TaskCreate` و`TaskPatch`؛
  `TaskDetail.hermes`؛ `TaskBulkUpdate.patch.comment`.
- `sessions.listChannelConversations`: `limit` و`has_more`. `sessions.listChannelMessages`: `offset`
  و`next_offset`. `ChannelMessage.attachments`. عملية جديدة `sessions.getChannelPicture`
  (`GET /channel-conversations/{id}/pictures/{picture_id}`) — ٣٤٨ عملية.
- أوصاف: `agents.updateSkill` و`agents.listSkills` و`Skill.enabled` (مفتاح هرمز والأنظمة)،
  `auth.listProfiles` و`SetupRequest.workspace_name` (الأسماء من هرمز).
- ترحيل `0032_task_definition_of_done` (عمودان JSON في `tasks`).
- DECISIONS §103 و§104.

## الملفات والتأثير
- الخادم: `tasks/{schema,serialize,service,runs,index,hermes-api}.ts` + الترحيل؛ `agents/skills.ts`
  و`agents/index.ts` و`agents/skill-library.ts` (تعليق) و`agents/hermes-profiles.ts`؛
  `auth/profile-mirror.ts` و`auth/routes.ts`؛ `sessions/channel-conversations.ts` و`sessions/routes.ts`
  و`sessions/testing/scripted-channels.ts`؛ `modules/index.ts` (المنفذان: `displayName` و`picture`).
- الويب: `tasks/{CheckList,HermesHistory}.tsx` (جديدان)، `tasks/{TaskDialog,TasksScreen}.tsx`،
  `tasks/{queries,errors}.ts`؛ `agents/AgentSkillsScreen.tsx` و`agents/toolErrors.ts`؛
  `chat/ChannelConversationView.tsx`، `sessions/{SessionList.tsx,channels.ts}`؛ `i18n/{ar,en}.json`.
- الاختبارات: خادم — `tests/unit/task-definition-of-done.test.ts` (جديد)،
  `tasks/hermes-api.test.ts`، `agents/{skills,hermes-profiles,agent-tools.routes,presets,skill-library}.test.ts`،
  `sessions/channel-conversations.test.ts`، `tests/unit/profile-mirror.test.ts`،
  `tests/contract/channel-conversations.contract.test.ts`، والحقيقية: `tasks/hermes-api.real.test.ts`،
  `agents/{hermes-plugins,hermes-profiles}.real.test.ts`، `sessions/channel-conversations.real.test.ts`.
  ويب — `tests/{task-definition-of-done,task-bulk}.test.tsx` (جديدان)،
  `tests/{channel-conversations,agent-jobs-plugins}.test.tsx`؛ رحلة `e2e/zzzzzzzzzzzz-task-definition-of-done.spec.ts`
  (٣٦) ولقطتاها، ولقطات لوحة المهام (زر «تحديد» الجديد).
- الوثائق: DECISIONS §103 و§104، `docs/STATUS.md` (sessions ٥٣، و٣٤٨ عملية، وأسطر tasks وagents وauth).
- لم يُمسّ `apps/*` (وكيل مساواة الجوال يعمل هناك).

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`، محليًا ما لمسه التغيير فقط:
```
$ pnpm lint                     → All matched files use Prettier code style! (exit 0)
$ pnpm typecheck                → exit 0
$ pnpm contracts:lint           → contracts:lint  OK
$ pnpm contracts:check-clients  → check-clients  OK — 737 client file(s) scanned, 251 contract path(s) known.
$ pnpm i18n:check               → i18n:check  OK
$ pnpm nav:check                → nav:check  OK — 39 destinations, 2 pre-auth screens (login, setup), 44 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm exec vitest run --project contract tests/contract/channel-conversations.contract.test.ts
 Test Files  1 passed (1)   Tests  2 passed (2)
$ pnpm exec vitest run --project unit src/modules/agents/   (packages/server)
 Test Files  42 passed | 19 skipped (62)   Tests  613 passed | 49 skipped
$ pnpm exec vitest run --project unit tests/unit/task-definition-of-done.test.ts src/modules/tasks tests/unit/task-runs.test.ts
 Test Files  8 passed | 2 skipped (10)   Tests  90 passed | 6 skipped (96)
$ pnpm exec vitest run --project unit src/modules/agents/skills.test.ts src/modules/sessions/channel-conversations.test.ts
 Test Files  2 passed (2)   Tests  44 passed (44)
$ pnpm exec vitest run --project unit tests/unit/profile-mirror.test.ts src/modules/agents/hermes-profiles.test.ts
 Test Files  2 passed (2)   Tests  24 passed (24)
$ pnpm exec vitest run <18 web files: tasks, channels, sessions list, chat, skills, i18n, logical css>   (packages/web)
 Test Files  18 passed (18)   Tests  454 passed (454)
$ pnpm exec vitest run tests/agent-jobs-plugins.test.tsx tests/task-bulk.test.tsx
 Test Files  2 passed (2)   Tests  9 passed (9)
$ pnpm build → exit 0
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zz-task-board.spec.ts e2e/zzzzzzzz-channel-conversations.spec.ts e2e/zzz-agent-jobs-plugins.spec.ts e2e/zzzz-skill-library.spec.ts --workers=1
  5 passed (23.3s)
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/smoke.spec.ts --workers=1
  21 passed (1.6m)
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzzzzzzzz-task-definition-of-done.spec.ts --workers=1
  ✓ 36. a definition of done and constraints are written, kept and counted; many cards take one priority (1.9s)
```
(المنفذان ٨٨٤٧/٨٨٤٨ لأن غيري قد يشغّل ٨٧٩١. أُرجعت لقطات e2e غير المتعلقة، وبقيت لقطات لوحة المهام.)

**هرمز الحقيقي** (صورة محلية `core-hub:morechannels`: `Hermes Agent v0.21.3 (2026.9.14)`، لم تُبنَ صورة،
كل حاوية `--rm` ولم يبقَ شيء بعدها):
```
$ COREHUB_HERMES_IMAGE=core-hub:morechannels vitest run src/modules/sessions/channel-conversations.real.test.ts
stored: "هذه الفاتورة\n\n[Image attached at: /hh/profiles/pager/cache/images/img_abcdefabcdef.png]\n[screenshot]"
 ✓ … reads past Hermes’s page of 100, and serves a picture Hermes stored (§103) 1320ms
 Tests  4 passed (4)
$ COREHUB_HERMES_IMAGE=core-hub:morechannels vitest run src/modules/tasks/hermes-api.real.test.ts
hermes events: commented, reprioritized, edited, created
 ✓ … edits, comments on, reassigns and deletes a card the CLI created 7628ms
 Tests  1 passed (1)
$ COREHUB_HERMES_IMAGE=core-hub:morechannels vitest run src/modules/agents/hermes-plugins.real.test.ts
category skills: 54 listed, 54 in categories, 54 built-in
listed here only: sdlc-review
 ✓ … switches a skill where Hermes keeps the switch, both ways (§103)
 Tests  6 passed (6)
$ COREHUB_HERMES_IMAGE=core-hub:morechannels vitest run src/modules/agents/hermes-profiles.real.test.ts
 Tests  2 passed (2)
```
ما تثبته: نص الصورة الذي خزّنه كود هرمز نفسه (`build_native_content_parts` ثم `_durable_content`)
يُقرأ صورةً متاحة ويُقدَّم ملفها؛ قائمة من ١٠٦ محادثات تُقرأ على صفحتين؛ أحداث بطاقة حقيقية
(`reprioritized` اسم هرمز للأولوية، فأُضيف إلى الأسماء المعروفة)؛ تعليق وأولوية جماعيان يصلان هرمز؛
إطفاء مهارة مدمجة من المركز يراه هرمز، وإطفاء من لوحة هرمز يراه المركز؛ قائمة المركز تطابق قائمة هرمز
عدا المهارة المقيّدة بسياق؛ واسم العرض يُقرأ كما كتبه `hermes profile rename`.

**الاختبارات الجديدة تفشل على الكود القديم** (أرجعتُ `packages/{server,web}/src` والعقد والترحيل إلى
أساس الفرع `cd9d9357` مؤقتًا وأبقيت الاختبارات):
```
server (9 files): Test Files  9 failed (9)   Tests  23 failed | 98 passed (121)
web (4 files):    Test Files  4 failed (4)   Tests  10 failed | 18 passed (28)
```

بعد دمج `origin/night/2026-09-27` (فيه §102 لمتابعات الويب؛ فأخذتُ §103 و§104، والعدّ ٣٤٩ من ٣٤٩ و
sessions ٥٤) أُعيد ما مسّه الدمج:
```
$ pnpm lint → All matched files use Prettier code style!
$ pnpm typecheck → exit 0
$ pnpm contracts:lint → contracts:lint  OK
$ pnpm contracts:check-clients → check-clients  OK — 743 client file(s) scanned, 252 contract path(s) known.
$ pnpm i18n:check → i18n:check  OK
$ pnpm nav:check → nav:check  OK — 39 destinations, 2 pre-auth screens (login, setup), 44 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm change-record:check → change-record  OK — 23 record(s) valid
$ pnpm exec vitest run --project contract   (packages/server)
 Test Files  19 passed (19)   Tests  402 passed (402)
$ pnpm exec vitest run --project unit tests/unit/status.test.ts … (18 files: tasks, skills, profiles, channels)
 Test Files  16 passed | 2 skipped (18)   Tests  182 passed | 6 skipped (188)
$ pnpm exec vitest run <18 web files>   (packages/web)
 Test Files  18 passed (18)   Tests  441 passed (441)
```

CI على طلب الليلة #165: يُضاف بعد الدفع.

## المخاطر والرجوع
- **سلوك الإطفاء تغيّر**: صار يكتب قائمة هرمز بدل إعادة تسمية `SKILL.md`. المهارات التي أطفأها مركز
  أقدم بالتسمية تبقى مطفأة وتعود بالتشغيل. من كان يعتمد على `SKILL.md.off` (لا أحد في الكود) يرى الفرق.
- **مزامنة الأسماء عند كل قائمة بروفايلات** تقرأ `profile.yaml` لكل بروفايل (ملفات صغيرة). اسم عرض
  يغيّره شخص في هرمز يغلب اسم المركز؛ اسم مركز لم يصل هرمز (رفضه) لا يُمسح.
- **الصور تعيش يومًا في هرمز**: بعدها تظهر «حُذفت». الصورة تُقرأ من ملف على قرص المركز (المركز وهرمز
  يتشاركان القرص حيث يدير المركز هرمز).
- **الترقيم**: القائمة الأطول تسأل هرمز صفحات أكثر (حتى ١٠ لكل بروفايل عند ١٠٠٠)، ويبقى الحفظ بالختم.
- **العلامات تُمسح مع كل تشغيل جديد** حتى لو لم يتغيّر العمل: مقصود (المراجعة للمحاولة الجديدة).
- الرجوع: إرجاع الالتزامات؛ الترحيل يضيف عمودين بقيمة افتراضية `[]` فلا يضر تركه.

## التسليم والخطوة التالية
يُدمج في `night/2026-09-27` (طلب #165)، لا طلب مستقل. للمالك أن يؤكد §103 و§104. تالٍ مقترح: عرض
تعريف الإنجاز على الجوالين (وكيل مساواة الجوال)، وتعليم العلامات مباشرة دون «حفظ» إن أراده المالك.
