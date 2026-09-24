# المجلس يُطلق جداوله بنفسه، وخطوة «الموافقة» في سير العمل تنتظر شخصًا
المسؤول: twuijri · الفرع: feat/hub-schedules-fire · الحالة: review

## المشكلة والهدف
قال `docs/STATUS.md` في صف الجدولة: جداول هرمز تعمل في مجدول هرمز، لكن «`runNow` لجدول ليس لهرمز
ما زال يجيب `501`، لأن لا شيء يُطلق جداول المجلس بعد»، و«خطوات `approval` في سير العمل غير مبنية
وتفشل قائلةً ذلك». أي أن جدولًا للوكيل «مباشر» أو لوكيل برمجة أو لسير عمل **يُحفظ ويُحسب موعده ثم
لا يعمل أبدًا**. وسجلّ التشغيل لا يحمل رقم محادثة (لاحظه #84)، فلا تُفتح محادثة التشغيل من الصفحة.

الهدف: مُجدول داخل المجلس يُطلق كل جدول ليس لهرمز في موعده كما يُطلقه شخص؛ `runNow` يبدأ التشغيل
نفسه فورًا ويعيد المعرّفات الحقيقية؛ خطوة الموافقة توقف التشغيل وترفع موافقة عادية تُجاب من الويب؛
وكل ذلك يصمد أمام إعادة التشغيل.

## القرار والموافقات
- **المُجدول** (`schedules/scheduler.ts`): كل ١٥ ثانية يسأل عن الجداول المفعّلة غير المؤرشفة التي
  ليست لهرمز وحلّ `next_run_at` المخزَّن لها، ويحجز كل موعد **في معاملة واحدة**: تحديث
  `next_run_at` بشرط أن يكون ما زال الموعد الذي قُرئ (compare-and-set)، وكتابة سطر في السجل فريد
  لكل (جدول، موعد) — الفهرس `schedule_runs_schedule_tick_uq` كان موجودًا لهذا بالضبط. من يخسر أيّ
  السباقين لا يفعل شيئًا: عمليتان على قاعدة واحدة، أو نظرتان متزامنتان، أو نظرة بعد إعادة تشغيل —
  الموعد يُطلق مرة واحدة.
- **ما يُطلق** (`schedules/schedule-runs.ts`): كما يبدؤه شخص —
  - هدف `agent_prompt`: جلسة مصدرها `schedule` وأصلها سطر السجل (`schedule_run`) في بروفايل الجدول،
    باسم مالك الجدول وبلغته، ودور واحد نصّه نص الجدول، في مجلد الجلسة العادي تحت
    `/data/workspaces/<profile>/` (للجدول في العقد لا مجلد عمل خاص به). عبر المنفذ
    `registerScheduleRunner` في جذر التركيب، كما في المهام.
  - هدف `workflow`: يبدأ سير العمل بمحرّكه، والجدول والموعد في `{{trigger}}`.
  - السطر يُكتب قبل أي بدء، ثم يُعلَّم بما بدأ (`session_id`/`run_id` أو `workflow_run_id`)، ثم
    يُحسم **مرة واحدة** بنهايته: الناتج (٥٠٠ حرف)، الخطأ، و`last_status`/`last_error` على الجدول،
    و`repeat.completed` يزيد مع كل نجاح وبلوغ الحد ينهي الجدول. هدف لا يبدأ (وكيل غير مثبّت أو لا
    يعمل، سير عمل محذوف أو فارغ، جدول بلا وكيل) يُحسم فاشلًا بالسبب — لا تشغيل صامت لم يحدث.
- **الموعد التالي** يُحسب عند الحجز، من لحظة الإطلاق، بتوقيت الجدول (`cron.ts` كما هو): cron أول
  دقيقة تطابق بعد الآن، الفترة من هذا التشغيل، والمرة الواحدة لا شيء بعدها. الجدول الموقوف بلا موعد
  فلا يحلّ أبدًا، واستئنافه يبدأ من الآن بلا تعويض. `runNow` لا يحرّك الموعد.
- **وصار `next_run_at` في الـAPI هو الموعد المخزَّن** (`shownNext`) — ما سيحجزه المُجدول — لا حسابًا
  جديدًا من الآن في كل قراءة، فلا تختلف الصفحة عن المُجدول.
- **مقترح — ينتظر تأكيد المالك (proposed — owner to confirm): المواعيد الفائتة أثناء التوقف.** حين
  يعود المجلس يعمل الجدول الفائت **مرة واحدة** (لا مرة لكل موعد فات) ثم يكمل من الآن، **إن فات بأقل
  من ٢٤ ساعة**؛ الأقدم لا يعمل، ويُسجَّل في السجل «تُخطّي» مع السبب
  («missed: the hub was not running at …»)، ويكمل الجدول من الآن. وهذا نفسه يحمي الترقية: جداول
  حُفظت في نسخة لم تكن تُطلق شيئًا ومواعيدها المخزّنة قديمة لا تنطلق كلها دفعة واحدة. عمود
  `misfire_policy` في الجدول (افتراضه `skip`، وليس في العقد) لا يُقرأ؛ القاعدة واحدة للجميع.
- **مقترح — ينتظر تأكيد المالك: التداخل.** موعد يحلّ والتشغيل السابق للجدول لم ينتهِ يُتخطّى ويُسجَّل
  («skipped: the previous run was still going») — `overlap_policy` المخزّن `skip` لكل جدول. «شغّله
  الآن» لا يُتخطّى: شخص طلبه.
- **بعد إعادة التشغيل** (`onReady`): يُفشَل أولًا ما قطعته من تشغيلات سير العمل، ثم تُحسم أسطر السجل
  المفتوحة: دور انتهى قبل الانقطاع بحسب سجلّه، ودور قُطع أو سطر لم يبدأ فاشلًا بسبب واضح («the hub
  restarted while this run was going»)، وسطر سير عمل ينتظر موافقة **يبقى مفتوحًا** لأنه ما زال يعمل.
  ثم يبدأ المُجدول. وعند الإغلاق يتوقف.
- **الأحداث**: `schedule.fired` (بالجدول ومعرّف السطر كما يقول مخططه — وأُصلح حدث هرمز الذي كان يرسل
  `schedule_id`)، و`schedule_run.started/completed/failed`، و`schedule.updated`؛ وتحقّقت منها
  اختبارات العقد مقابل مخططات الأحداث.
- **خطوة الموافقة** (`workflow-engine.ts`): عقدة `approval`، أو أي عقدة عليها `approval_required`،
  ترفع **موافقة عادية** من نوع `workflow_step` (العقد يسمّيها أصلًا، ومعها `workflow_run_id` و`node_id`)
  عبر `sessions` — تُسرد في `/approvals`، ويُعلن عنها للبروفايل، وتصل صندوق مالك التشغيل بإشعار
  «… ينتظر إذنك» يفتح التشغيل — ويتوقف التشغيل (`waiting`) و**يُكتب موضعه** في
  `workflow_runs.resume_state`: العقد الباقية، والتي مرّ بها، وناتج كل خطوة. الإجابة بـ
  `respondApproval` نفسه: الموافقة تكمل من تلك الخطوة (خطوة `approval` تنجح، وغيرها تعمل عملها
  الآن)، والرفض يُفشل الخطوة بالسبب («denied by <الاسم>: <السبب>») فتتبع حوافّ `failure` أو يفشل
  التشغيل. الإجابة الثانية، أو بعد الإلغاء، `409`. الإلغاء وحذف التشغيل وحذف سير العمل تُغلق الموافقة.
  ولأن شيئًا من الانتظار لا يعيش في الذاكرة، **تصمد أمام إعادة التشغيل**: `failInterruptedRuns`
  لا يمسّ تشغيلًا ينتظر موافقة، و`failStaleRuns` في الجلسات صار لا يُلغي إلا موافقات لها دور جلسة.
- **الحدود بين الوحدات**: `schedules` لا يرى جداول الجلسات، و`sessions` لا يعرف سير العمل: الرفع
  والإغلاق عبر `workflowApprovalsFor`، والإجابة تصل الجدولة عبر `registerWorkflowGate`، وكلاهما في
  جذر التركيب (`modules/index.ts`).
- **هجرة `0011_hub_schedules_fire`**: `approvals.run_id` صار اختياريًا ومعه `workflow_run_id` و`node_id`
  والنوع `workflow_step` (إعادة بناء الجدول)، و`schedule_runs.session_id` و`trigger`،
  و`workflow_runs.resume_state`. **خطر حقيقي وُجد وعولج**: المُرحِّل يعمل داخل معاملة فلا أثر لـ
  `PRAGMA foreign_keys=OFF`، وحذف الجدول القديم كان سيُفرغ كل `tool_calls.approval_id`
  (`ON DELETE SET NULL`). الهجرة تحفظ هذه الروابط جانبًا وتعيدها؛ والاختبار يفشل إن حُذفت الإعادة
  (جرّبته). وأصلحتُ خطأ في SQL الذي ولّده drizzle-kit (كان يختار عمودين غير موجودين من الجدول القديم).
- **`WorkflowRun` صار بكلمات العقد**: `waiting` بدل `waiting_approval`، و`trigger` كائن `RunTrigger`، و
  `input` ما كتبه الشخص. كان الخادم يرسل ما لا يقبله المخطط، ولم يلحظه أحد لأن لا واجهة كانت تقرؤه؛
  كشفه اختبار العقد الجديد.
- **الويب**: «شغّله الآن» فعّال لكل جدول، ورسالة «بدأ «…»» مع «فتح المحادثة» أو «فتح التشغيل»؛ زرّ
  «السجل» في كل بطاقة يعرض آخر التشغيلات (الحالة، يدوي أو في موعده، الوقت، مقتطف الناتج، الخطأ)
  ويفتح محادثة كل سطر في بروفايل الجدول (`?profile=`، بلا تحريك الشريحة العلوية) أو تشغيل سير العمل؛
  ونافذة «تشغيل سير العمل» تعرض الخطوات، وإن انتظرت خطوة: السؤال وحقل «السبب (اختياري)» وزرّا «موافقة»
  و«رفض». إشعار الموافقة في صندوق الإشعارات يفتحها (`/schedules?workflow_run=<id>&profile=<slug>`).
  الصفحة تسمع أحداث سير العمل أيضًا، وتعيد السؤال عند كل (إعادة) اتصال للمقبس، وتسأل كل ٣ ثوانٍ ما
  دام سطر أو تشغيل جاريًا — لأن مقبسًا أُعيد اتصاله لا يسمع ما فاته (ظهر ذلك في Playwright: اتصال
  أُعيد بعد الدخول فضاع حدث النهاية). كل النصوص بالعربية والإنجليزية.
- الخريطة (Graphify) لم تُستعمل: الوحدات معروفة وقُرئت مباشرة (`schedules`، `sessions`، `notify`).
- **ليس في هذا التغيير**: صفحة لرسم سير العمل (يُنشأ عبر الـAPI، كما في الرحلة 29)؛ «شريط الإجراءات
  المعلّقة» العام في الويب غير موجود أصلًا، فالموافقة تظهر في صندوق الإشعارات ونافذة التشغيل؛ وتسليم
  الناتج `notice` يحدث عبر إشعار «أنهى الوكيل» العادي، و`delivery_status` ما زال `none`.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `ScheduleRunAccepted`: حقول `session_id` و`run_id` و`workflow_run_id` (مطلوبة، تقبل `null`)، ووصف
  `schedules.runNow` يقول ما تعنيه، وسبب `409` الجديد `target_unavailable`.
- وصف `sessions.respondApproval`: معنى الإجابة على موافقة `workflow_step`، و`x-rt-events` زاد
  `step.completed` و`step.failed`.
- `docs/contracts/DECISIONS.md` **§35** (§34 أخذه #88). ولا حدث ولا عملية جديدة.
- `pnpm contracts:lint` نظيف و`generate:ts` أُعيد.

## الملفات والتأثير
- الخادم — جديد: `modules/schedules/scheduler.ts` (+ `scheduler.test.ts`، ١٢ اختبارًا بساعة مزيّفة)،
  `modules/schedules/schedule-runs.ts`، `drizzle/0011_hub_schedules_fire.sql` واللقطة.
- الخادم — معدّل: `modules/schedules/{index,service,schema,workflow-engine}.ts`،
  `modules/sessions/{index,service,store,engine,mappers,ports,schema}.ts`، `modules/index.ts`.
- اختبارات الخادم: جديدة `tests/unit/schedule-runs.test.ts` (٥)، `tests/unit/workflow-approvals.test.ts`
  (٦)، `tests/unit/hub-schedules-migration.test.ts`، `tests/contract/schedules.contract.test.ts` (٢)؛
  ومعدّلة لتقول الحقيقة الجديدة: `schedules.test.ts` و`hermes-cron.test.ts` (كان `501`)،
  و`workflow-engine.test.ts` (كان «approval غير مبنية»).
- الويب: جديد `src/schedules/ScheduleRuns.tsx`؛ معدّل `schedules/SchedulesScreen.tsx`، `agents/AgentJobsScreen.tsx` (بعد #91)،
  `notify/{NotificationsTab.tsx,queries.ts}`، `realtime/envelope.ts`، `i18n/{ar,en}.json` (مفاتيح
  `schedules.fired`، `schedules.target_unavailable`، `schedules.history.*`، `schedules.run.*`؛ حُذف
  `schedules.run_unavailable`). اختبار جديد `tests/schedule-runs.test.tsx` (٤).
- Playwright: رحلتان جديدتان **28** و**29** في `e2e/zzzzz-hub-schedules.spec.ts`، وسيناريو «ملخص
  الجدولة» في `e2e/hub.ts`، والرحلة 11 صارت تتحقق أن «شغّله الآن» فعّال.
- اللقطات: جديدتان `schedules-hub-run-ar-light.png` و`workflow-approval-ar-light.png`، وتغيّرت
  `schedules-ar-light.png` (الزرّ فعّال وزرّ «السجل»).
- المستندات: `docs/STATUS.md` (صف الجدولة ٢٣ من ٢٣، وفقرة «لا شيء يبدأ تشغيلًا إلا…»، والويب)،
  `docs/contracts/DECISIONS.md` §35.

## الفحوص (الأوامر ونواتجها الفعلية)
كل الأوامر الثقيلة عبر `mj-run` (ذاكرة ٧ غ، عاملان).
```
$ pnpm lint                      # exit 0 — All matched files use Prettier code style!
$ pnpm typecheck                 # exit 0
$ pnpm contracts:lint
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 249 client file(s) scanned, 167 contract path(s) known.
$ pnpm i18n:check
i18n:check  web: 1023 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm change-record:check
change-record  OK — 1 record(s) valid
$ pnpm contract:test
 Test Files  3 passed (3)
      Tests  257 passed (257)
$ pnpm --filter @majlis/server test
 Test Files  88 passed | 11 skipped (99)
      Tests  924 passed | 30 skipped (954)
$ pnpm --filter @majlis/web test
 Test Files  46 passed (46)
      Tests  551 passed (551)
$ pnpm build                     # exit 0
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  40 passed (2.5m)
```
- **تفشل على الكود القديم**: اختبارات `runNow` (كان `501`)، والمُجدول (لم يكن موجودًا)، والموافقة (كانت
  تُفشل الخطوة)، وسجلّ `session_id` (كان `null` دائمًا)، واختبار الويب («شغّله الآن» كان معطّلًا لغير
  هرمز، ولا سجل ولا نافذة تشغيل)، والرحلتان 28 و29. واختبار الهجرة يفشل إن أُزيلت إعادة روابط
  `tool_calls.approval_id` — شغّلته كذلك فرأيته يفشل (`approval_id: null`)، ثم أعدت السطر.
- **وجدها الاختبار أثناء العمل**: (١) `WorkflowRun` كان يُرسل `waiting_approval` و`trigger` نصًّا بخلاف
  المخطط؛ (٢) `failStaleRuns` كان سيُلغي موافقات سير العمل عند كل إعادة تشغيل؛ (٣) drizzle-kit ولّد
  `INSERT … SELECT` بعمودين غير موجودين؛ (٤) في Playwright أُعيد اتصال المقبس بعد الدخول فضاع حدث نهاية
  التشغيل فبقي السطر «يعمل» — صار الويب يعيد السؤال عند الاتصال ويسأل كل ٣ ثوانٍ ما دام شيء جاريًا.
- **بعد دمج `origin/main` (#91، صفحتا «المهام المجدولة» و«الإضافات» للوكيل)** أُعيدت كل الفحوص:
  تعارض واحد في `DECISIONS.md` (#91 أخذ §36، فبقي هذا §35)، واختبار i18n فشل لأن صفحة «مهام الوكيل»
  الجديدة تستعمل `schedules.run_unavailable` الذي حذفته — فصار «شغّله الآن» فيها فعّالًا لكل مهمة
  (المجلس يُطلق ما ليس لهرمز) برسالة «بدأ «…»»، وعُدّل اختبارها ليقول ذلك.
```
$ pnpm lint · typecheck · contracts:lint · contracts:check-clients · i18n:check · nav:check · change-record:check
                                  # كلها exit 0 (check-clients: 254 client file(s), 167 contract path(s))
$ pnpm contract:test
      Tests  259 passed (259)
$ pnpm --filter @majlis/server test
 Test Files  89 passed | 12 skipped (101)
      Tests  942 passed | 35 skipped (977)
$ pnpm --filter @majlis/web test
 Test Files  47 passed (47)
      Tests  561 passed (561)
$ pnpm build                      # exit 0
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  41 passed (2.6m)
```
- اللقطات: أُعيدت كل اللقطات إلى نسخة `main` إلا صفحات الجدولة التي تغيّرت فعلًا.

## المخاطر والرجوع
- **الهجرة تعيد بناء `approvals`**: مغطّاة باختبار يثبت بقاء كل موافقة وكل رابط `tool_calls.approval_id`
  وسلامة المفاتيح الأجنبية بعدها. الرجوع إلى نسخة أقدم بعد ترحيل القاعدة غير مدعوم (كسائر الهجرات)؛
  موافقة `workflow_step` بلا `run_id` لن تقبلها نسخة قديمة.
- **جداول قديمة بعد الترقية**: موعدها المخزّن قديم؛ ما فات بأكثر من ٢٤ ساعة يُسجَّل «تُخطّي» ولا يعمل،
  وما فات بأقل يعمل مرة. هذا قرار ينتظر المالك (أعلاه).
- **الناتج الطويل** يُقصّ إلى ٥٠٠ حرف في السجل؛ الكامل في المحادثة.
- **دقّة الموعد**: المُجدول ينظر كل ١٥ ثانية، فقد يتأخر الإطلاق حتى ١٥ ثانية عن الدقيقة.
- **تعارض محتمل**: PR #90 يضيف هجرة `0011` أيضًا؛ من يُدمج ثانيًا يعيد توليد هجرته برقم `0012`.
- الرجوع: الفرع وحده.

## التسليم والخطوة التالية
PR #92 إلى `main` بالإنجليزية (https://github.com/twuijri/core-hub/pull/92). الدمج للمالك.
الخطوة التالية: تأكيد المالك لقاعدتي «الفائت أثناء التوقف» و«التداخل»؛ ثم شاشة رسم سير العمل في الويب.
