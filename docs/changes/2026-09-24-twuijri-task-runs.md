# إسناد المهمة يشغّل الوكيل فعلًا (المرحلة الأولى)
المسؤول: twuijri · الفرع: feat/task-assign-runs · الحالة: review

## المشكلة والهدف
«المهام» أولوية المالك الأولى (٢٠٢٦-٠٩-٢٤)، واللوحة كانت تبدو كأنها تعمل وهي لا تشغّل شيئًا:
`tasks.assignTask` يسجّل المُسنَد إليه ويجيب `{job_id: null, run_id: null, session_id: null}`،
لأن «العامل الذي يفتح جلسة ويضع تشغيلًا في الطابور غير مبني». و`dispatch` يُسند ولا يبدأ،
و`stopTask`/`unassignTask` يحرّكان البطاقة ولا يوقفان شيئًا.

الهدف: أن يكون «أسند وابدأ» تشغيلًا حقيقيًا يتبعه تحريك البطاقة بحسب نهايته، بالعقد الموجود.

## القرار والموافقات
- **`assignTask` مع `start: true`**: تُفتح جلسة مصدرها `task` وأصلها المهمة
  (`origin: {kind: task, id}`) للوكيل المُسنَد إليه، في مجلّد الجلسة العادي تحت
  `/data/workspaces/<profile>/`، ويوضع تشغيل واحد طلبه المهمة نفسها: العنوان، والوصف، وقائمة
  التحقق بما أُنجز منها `[x]` وما لم يُنجز `[ ]`، والتعليمات المرسلة مع الإسناد، وسطر يطلب
  ملخصًا قصيرًا في آخر الرد. يُحترم `model`/`provider` إن أُرسلا. تنتقل المهمة إلى `running`
  وتُحفظ الجلسة عليها ويزيد `attempt_count`، ويُجاب `202` **بمعرّفات حقيقية** فورًا.
- **الجلسة والتشغيل يُفتحان أولًا**: وكيل غير معروف (`404`) أو لا يستطيع التنفيذ (`422`) يترك
  المهمة كما كانت، ولا تبقى جلسة فارغة خلفه.
- **عند انتهاء التشغيل** (متابعة داخل العملية نفسها، عبر `TasksService.moveTask` فتُكتب
  الانتقالات ويُبثّ `task.moved`):
  - `succeeded` ← `review`، و`latest_summary` = آخر كلام الوكيل (حتى ٦٠٠ حرف من **آخر** الرد،
    لأن الطلب يطلب الملخص في آخره). الفاعل: الوكيل.
  - `failed`/`timed_out` ← `blocked` وسببه «فشل التشغيل: <رسالة الخطأ>» في `blocked_reason`
    وملاحظة الانتقال. الفاعل: `system`.
  - `cancelled` من المحادثة ← `ready` وتبقى مُسندة.
  - **لا يحرّك المهمةَ إلا التشغيلُ الذي هي عليه**: الإيقاف وإلغاء الإسناد وإعادة الإسناد
    والنقل اليدوي خارج `running` تحرّك المهمة بنفسها وتنسى التشغيل **قبل** إلغائه، فإذا وصلت
    نهايته وجدت المهمة على تشغيل آخر أو بلا تشغيل فتركتها. لا تحريك مزدوج.
- **`stopTask`** يلغي التشغيل فعلًا (`sessions.cancelRun`)، والمهمة تبقى مُسندة وتعود إلى
  `ready`. **`unassignTask`** يلغيه ويعيد المهمة الجارية إلى `ready` بلا مُسند (المهمة `ready`
  غير الجارية تعود إلى `todo` كما كانت). **إعادة الإسناد** أثناء التشغيل تقطعه ثم تبدأ الجديد.
  **نقل مهمة جارية يدويًا** إلى عمود آخر، أو **حذفها**، يوقف تشغيلها كذلك.
- **`dispatch`** يبدأ ما يُسنده بالطريقة نفسها. مهمة لا يستطيع وكيلها التنفيذ تُسند ولا تبدأ،
  ونتيجة الوظيفة تذكر السبب (`error`) و`started` يعدّ ما بدأ فعلًا.
- **بعد إعادة تشغيل المجلس**: عند `onReady` تُسوّى كل مهمة للمجلس بقيت `running`: إن كان
  تشغيلها قد انتهى قبل الانقطاع (ولم تلحق المتابعة) تُحرَّك بحسب نهايته، وإلا — تشغيل قطعه
  الانقطاع (`stale`) أو لا أثر له — تذهب إلى `blocked` بسبب واضح: «أُعيد تشغيل المجلس أثناء
  تنفيذ المهمة، فلم يكتمل تشغيلها». لا تبقى مهمة «تعمل» إلى الأبد.
- **بطاقات هرمز**: لا يبدأ المجلس تشغيلًا لمهمة على لوحة هرمز ولا لمهمة تُسند إلى هرمز؛
  موزّع هرمز هو المالك. ويبقى السلوك القائم كما هو، مع إضافة واحدة محافظة: بطاقة للمجلس
  تُسند إلى هرمز **مع `start`** تُسلَّم إلى لوحة هرمز بالمفتاح نفسه (معرّف المهمة) كما يحدث
  لبطاقة تُنشأ لهرمز — وإلا لكانت «أسند وابدأ» لا تشغّل شيئًا على الإطلاق. بلا `start` تُسند
  فقط. الإجابة في الحالتين `null`، والويب يقول إن الوكيل يبدأها من لوحته.
- **الحدود بين الوحدات**: `tasks` تعرّف ما تحتاجه (`TaskRunPort` في `tasks/runs.ts`) ولا ترى
  جداول الجلسات، و`modules/index.ts` يملؤه من `sessions` (`registerTaskRunner`)، كما في
  سير العمل وجسور هرمز. وأُضيف إلى `sessions` أخٌ غير منتظِر لـ`oneTurn` هو `startTurn`
  (يعيد المعرّفات و`done`)، وصار `oneTurn` مبنيًّا عليه، مع `turnResult` لقراءة نهاية تشغيل
  بمعرّفه. وصار أصل الجلسة والتشغيل (`origin_kind`/`origin_id`) يُكتب فعلًا (كان المخزن يتجاهله).
- **الويب**: قائمة البطاقة فيها «إسناد إلى وكيل…» (أو «إعادة الإسناد…»)، ونافذة تعرض الوكلاء
  القادرين على التنفيذ فقط، وحقل تعليمات اختياري، وزرّان: «إسناد وبدء» (الأساسي) و«إسناد فقط».
  البطاقة الجارية تتنفّس بنقطة صغيرة، ولها زر «إيقاف» وقائمة فيها «إيقاف» و«إلغاء الإسناد»،
  ورابط «فتح المحادثة» (ينتقل إلى مساحة عمل المهمة إن كانت غير الحالية). بطاقة «المراجعة» تعرض
  ملخّص الوكيل (ثلاثة أسطر)، و«الموقوفة» سببها مع تلميح بالنص كاملًا. اللوحة تستمع إلى
  `/rt/tasks` وتعيد السؤال كل ٤ ثوانٍ ما دامت بطاقة جارية (لبطاقات مساحات العمل الأخرى).
  اسم الوكيل على البطاقة من سجل الوكلاء.

### قرارات للمالك
1. **`TaskAssign.start` صار افتراضه `false`** (كان `true` في العقد). السبب: المهمة طلبت صراحةً
   أن يكون الغياب «إسنادًا فقط»، والافتراض المحافظ ألّا يُصرف على نموذج ما لم يُطلب البدء.
   العملاء المولَّدون يرسلون `start` دائمًا، ولا عميل كان يستدعي `assignTask` قبل هذا.
2. **تسليم بطاقة المجلس إلى لوحة هرمز** عند «أسند وابدأ» لهرمز (أعلاه).
3. **لغة أسباب النقل**: تُكتب بلغة من طلب البدء، وعند التسوية بعد إعادة التشغيل بالعربية
   (لا لغة طلب حينها).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
تغيير واحد صغير في `openapi.yaml`: `TaskAssign.start` من `default: true` إلى `default: false`
مع وصف يقول إن غيابه إسناد فقط والمعرّفات `null`. `pnpm contracts:lint` نظيف و`generate:ts`
أُعيد (العملاء المولَّدون غير مُودَعين). لا عملية ولا حدث جديد: `task.assigned`/`task.moved`
و`run.*`/`session.created` معلنة أصلًا في `x-rt-events`، وصار `task.moved` من هذه المسارات
يحمل `{task, from, to, actor}` كما في مخطّطه.

## الملفات والتأثير
- `packages/server/src/modules/tasks/runs.ts` (جديد): المنفذ `TaskRunPort`، وبناء الطلب،
  والملخّص، والمتابعة، والتسوية عند الإقلاع. `runs.test.ts` (جديد).
- `packages/server/src/modules/tasks/index.ts`: `registerTaskRunner`، و`taskRunsFor`،
  و`assignTask`/`dispatch`/`stopTask`/`unassignTask`/`moveTask`/`deleteTask`، وخطّاف `onReady`،
  وتعليق رأس الوحدة بالحقيقة الجديدة.
- `packages/server/src/modules/tasks/service.ts`: `startRun`، و`finishRun`، و`detachRun`،
  و`runningEverywhere`، و`run_id` على الانتقالات، و`unassign` لمهمة جارية.
- `packages/server/src/modules/sessions/{service,store,index}.ts`: `startTurn`، و`turnResult`،
  و`sessionRunsFor`، وكتابة الأصل.
- `packages/server/src/modules/index.ts`: ربط المنفذ.
- `packages/server/tests/unit/task-runs.test.ts` (جديد، ١٢ اختبارًا عبر الوحدتين)،
  و`tasks/tasks.test.ts` (اختبارا الإسناد و`dispatch` بالحقيقة الجديدة).
- `packages/web/src/tasks/{AssignDialog.tsx (جديد),TasksScreen.tsx,queries.ts}`،
  و`realtime/{socket,envelope}.ts`، و`styles/screens.css`، و`i18n/{ar,en}.json`.
- `packages/web/tests/task-run.test.tsx` (جديد، ٨ اختبارات)، و`e2e/hub.ts` (سيناريو لمهمة)،
  و`e2e/smoke.spec.ts` (الرحلة ٢٢)، ولقطتان: `tasks-running-ar-light.png`،
  `tasks-review-ar-light.png`.
- `docs/STATUS.md`: صفّ المهام وفقرة «لا شيء يبدأ تشغيلًا إلا…».

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!

$ pnpm typecheck                 -> exit 0
$ pnpm contracts:lint            -> contracts:lint  OK
$ pnpm contracts:check-clients   -> check-clients  OK — 210 client file(s) scanned, 166 contract path(s) known.
$ pnpm i18n:check                -> web: 805 keys, ar/en in parity ... i18n:check  OK
$ pnpm nav:check                 -> nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web

$ pnpm --filter @majlis/server test
 Test Files  67 passed | 4 skipped (71)
      Tests  717 passed | 15 skipped (732)
$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  254 passed (254)
$ pnpm --filter @majlis/web test
 Test Files  33 passed (33)
      Tests  412 passed (412)
$ pnpm --filter @majlis/web build  -> ✓ built
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  ✓  22 [chromium] › e2e/smoke.spec.ts › 22. a task assigned and started runs the agent, lands in Review, and opens its conversation (4.6s)
  25 passed (1.6m)

# الاختبارات الجديدة تفشل بلا التغيير (المصدر مخبّأ بـ git stash):
$ vitest run tests/unit/task-runs.test.ts
      Tests  10 failed | 1 passed (11)   # الناجح الوحيد: «إسناد فقط بمعرّفات null»
```

## المخاطر والرجوع
- **المتابعة في الذاكرة**: تعيش ما دامت العملية. إعادة التشغيل تسوّي المهام العالقة عند
  الإقلاع إلى `review` أو `blocked`، ولا تستأنف تشغيلًا مقطوعًا.
- **غير مبني في هذه المرحلة**: شجرة عمل git لكل مهمة (الصفّ يبقى `creating` ولا يصنع شيء
  شجرة؛ التشغيل في مجلّد الجلسة العادي)، والإبلاغ في غرفة المشروع `report_room_id` (الغرف
  `501`؛ يُتجاهل)، و`auto_start`، واحترام الاعتماديات قبل البدء، وإيقاف التشغيل في
  `bulkUpdateTasks` عند أرشفة مهمة جارية.
- `last_run` على المهمة يبقى `{id, status: null}` (حالة التشغيل ملك `sessions`)، ويصير `id`
  `null` بعد انتهاء التشغيل؛ الجلسة تبقى في `session_id`.
- وُجد ولم يُصلَح هنا: `overrideTasks({nameOf})` لم يُربط قطّ في الإنتاج، فاسم المُسنَد إليه
  في الخادم هو معرّفه؛ الويب صار يأخذ الاسم من سجل الوكلاء. و`tasks.dispatch` يجيب بـ`Job`
  كاملًا لا `JobAccepted` (سابق لهذا التغيير).
- الرجوع: الفرع وحده، بلا هجرة (الأعمدة كلّها موجودة).

## التسليم والخطوة التالية
PR إلى `main` من `feat/task-assign-runs`. الدمج والنشر للمالك.

المرحلة الثانية: شجرة عمل git حقيقية لمشروع له مستودع، والإبلاغ في الغرف حين تُبنى، و`auto_start`
مع احترام الاعتماديات، وعرض حالة التشغيل الأخير (`last_run.status`) من `sessions`.
