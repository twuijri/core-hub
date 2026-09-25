# حدود تشغيل سير العمل، وجداول شائعة مع المرات القادمة
المسؤول: twuijri · الفرع: feat/schedule-extras · الحالة: review

## المشكلة والهدف
بقيت ثلاث ميزات صغيرة في الجدولة وسير العمل:

1. **حدود تشغيل سير العمل**: لا شيء يمنع تشغيلًا من أن يعمل ساعات أو يصرف بلا سقف. المطلوب أن يضع سير
   العمل — أو تشغيل واحد منه — **حد وقت** (أطول وقت يعمله التشغيل)، و**حد تكلفة** (أقصى تكلفة بتقدير
   المركز لكل دور)، و**مهلة لكل خطوة**؛ وإذا تجاوز التشغيل حدًّا يتوقف بنظافة وبسبب واضح، وتظهر الحدود في
   نموذج إعدادات سير العمل وفي عرض التشغيل. العقد أولًا، والمحرّك هو من يفرضها.
2. **جداول شائعة**: قائمة «جداول شائعة» في نموذج الجدول تملأ الـcron أو الفاصل: كل ساعة، كل يوم الساعة
   ٨، أيام العمل الساعة ٩، كل اثنين، أول الشهر، كل ١٥ دقيقة — مع معاينة مقروءة **لأقرب ثلاث مرات** بتوقيت
   الجدول، **من حساب الخادم نفسه** لـ`next_run_at`.
3. **«أكمل في كور هب»** لمحادثة تيليجرام/واتساب المقروءة فقط (#126). #126 مكدّس على #121 وكلاهما غير
   مدموج، فهذا الجزء **ليس في هذا الفرع**: يُعمل في طلب دمج منفصل مكدّس على `feat/channel-conversations`
   (انظر «التسليم»).

## القرار والموافقات
قرار العقد **§57** (مقترح — ينتظر تأكيد المالك). التفاصيل:

- **مكان الحدود**: في `definition` سير العمل (`limits`) وفي `definition_snapshot` للتشغيل — بلا هجرة ولا
  أعمدة، والتشغيل يحفظ الحدود التي عمل بها، وإعادة التشغيل من خطوة تأخذ حدود التشغيل الذي تعيده.
- **حد لتشغيل واحد (مقترح)**: `runWorkflow` يقبل `limits` — الحقل المعطى يحلّ محل حد سير العمل لهذا التشغيل،
  و`null` يرفعه، والغائب يبقيه. و`timeout_ms` (كان في العقد ولا يقرؤه أحد) صار الاسم القديم لحد الوقت
  بالمللي ثانية، و`limits.max_duration_seconds` يغلبه.
- **التكلفة بالدولار فقط (مقترح)**: تقدير المركز لكل دور (`Usage.cost`) بالدولار، ولا سعر صرف عند
  المركز؛ عملة أخرى أو مبلغ ≤ صفر `409 limit_invalid` مع الحقل.
- **كيف يتوقف التشغيل (مقترح)**:
  - حد الوقت وحد التكلفة يوقفان التشغيل **فورًا**: الخطوة العاملة تُلغى (دور الوكيل يُوقف كما يفعل زر
    «إيقاف» في المحادثة؛ والانتظار `delay` ينتهي)، وحالتها `cancelled`، والتشغيل `failed` مع `stopped_by`
    ونص يقول الحد: «stopped: the run went over its cost limit of $1.00 (it cost about $1.25)».
  - التكلفة تُقرأ أثناء خطوة الوكيل **كل ثانيتين** وعند نهايتها؛ وميزانية استُنفدت بخطوات انتهت توقف
    التشغيل قبل الخطوة التالية. خطوة أخيرة تتجاوز بين قراءتين وليس بعدها شيء: التشغيل ينجح (لم يبق ما
    يُوقف).
  - **مهلة الخطوة تُفشل الخطوة لا التشغيل**: «timed out after 30 s»، فيأخذها فرع `failure` إن وُجد؛ ولا
    ينتهي التشغيل (`stopped_by: step_timeout`) إلا إن لم يتولّها شيء.
  - **انتظار موافقة شخص لا يُحسب** على أي حد: ما استُهلك قبل الانتظار يُكتب مع مكان التشغيل ويكمل بعد
    الجواب (وبعد إعادة التشغيل).
  - دور بلا سعر عند المركز يُحسب صفرًا؛ عرض التشغيل يقول «لا دور مسعّر بعد».
- **المعاينة من الخادم**: عملية جديدة `schedules.previewTrigger` (`POST /schedules/preview`) — الفحص نفسه
  والحساب نفسه (`cron.ts`) الذي يضع `next_run_at`، وكل مرة تُحسب من التي قبلها كما يفعل المُجدول. لم
  أكتب قارئ cron في المتصفح: قارئ ثانٍ قد يخالف الخادم في «يوم الشهر أو يوم الأسبوع» أو في التوقيت الصيفي.
  جدول هرمز يوقّته هرمز، والـcron ذو الخمسة حقول يُقرأ هناك بالطريقة نفسها.
- **الجداول الشائعة (مقترح في التفاصيل)**: الست كما طلبها المالك؛ «كل اثنين» و«أول الشهر» الساعة **٩:٠٠**
  (لم يُذكر وقت)، و«كل ١٥ دقيقة» **فاصل** (interval) والبقية cron.
- **مكان نموذج الحدود في الويب (مقترح)**: محرّر سير العمل (#109) غير مدموج، وفي `main` لا يوجد أي نموذج
  لإعدادات سير العمل ولا قائمة لسير العمل. فوضعتُ الحدود في **عرض التشغيل** (الذي يفتح من سجل الجدول ومن
  صندوق الإشعارات): تظهر الحدود التي عمل بها التشغيل وتكلفته وسبب توقفه، وزر «غيّر حدود سير العمل هذا»
  يفتح نموذج حدود سير العمل (`WorkflowLimitsForm`) ويحفظها بـ`updateWorkflow`. المكوّن مستقل ليوضع في
  لوحة إعدادات المحرّر حين يُدمج #109. وحد التشغيل الواحد متاح من الـAPI فقط في `main` (لا زر «شغّل سير
  العمل» في الويب بعد).
- الخريطة (Graphify) لم تُستعمل: الوحدة `schedules` قُرئت مباشرة (المحرّك والخدمة والمسارات).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `WorkflowLimits` جديد (`max_duration_seconds` ≤ أسبوع، `max_cost` `Money|null`، `step_timeout_seconds`
  ≤ يوم) و`WorkflowLimitsOverride` جديد.
- `Workflow.limits` مطلوب؛ `WorkflowWrite.limits` اختياري.
- `WorkflowRun`: `limits` و`cost` (`Money|null`) و`stopped_by` (`max_duration|max_cost|step_timeout|null`)
  مطلوبة.
- `WorkflowRunRequest.limits` جديد، و`timeout_ms` صار له وصف (الاسم القديم لحد الوقت).
- `schedules.createWorkflow` يوثّق `409` (كان يرده أصلًا لـ`workflow_invalid`).
- عملية جديدة `schedules.previewTrigger` (`POST /schedules/preview`) مع `SchedulePreviewRequest` و
  `SchedulePreview`.
- أحداث `workflow.created|updated` و`workflow_run.*`: نسخ `$defs` لـ`Workflow`/`WorkflowRun` حُدّثت بالحقول
  الجديدة (مع `Money` و`WorkflowLimits`)، و`events/common.schema.json` بالمخططات الجديدة والمعدّلة.
- `docs/contracts/DECISIONS.md` §57.

## الملفات والتأثير
- الخادم: `modules/schedules/limits.ts` (جديد: قراءة الحدود ودمجها وحساب الميكرو-دولار)،
  `workflow-engine.ts` (سباق كل خطوة مع حدودها، `Budget`، منفذا `TurnControl` و`cost`)، `service.ts`
  (`previewTrigger`، الحدود في التعريف واللقطة)، `schema.ts` (أنواع فقط)، `index.ts` (المسار الجديد،
  `limits`/`cost`/`stopped_by` في الردود). جذر التركيب `modules/index.ts`: دور خطوة الوكيل صار
  `runs.start` مع إلغاء عند انتهاء حد، والتكلفة من دفتر الاستخدام (`auditFor().totalsForRun`).
- الويب: `schedules/ScheduleTemplates.tsx` (جديد: القائمة والمعاينة)، `schedules/WorkflowLimits.tsx`
  (جديد)، `SchedulesScreen.tsx` (سطران لإدراجهما)، `ScheduleRuns.tsx` (قسم «الحدود» في عرض التشغيل)،
  ونصوص `ar.json`/`en.json`.
- الاختبارات: `workflow-limits.test.ts` (خادم، وقت مزيّف وتكلفة مكتوبة)، إضافة في
  `tests/contract/schedules.contract.test.ts`، `tests/schedule-extras.test.tsx` (ويب)، و
  `e2e/zzzzzz-schedule-templates.spec.ts` مع لقطة `schedule-templates-ar-light.png`.
- `docs/STATUS.md`: 207 من 265 عملية، وسطر schedules والويب.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا ما يمسّه التغيير فقط (قاعدة السرعة)؛ الحزم كاملة في CI.

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
typecheck exit 0
$ pnpm contracts:lint
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 285 client file(s) scanned, 177 contract path(s) known.
$ pnpm i18n:check
i18n:check  web: 1352 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  276 passed (276)
$ vitest run src/modules/schedules/workflow-limits.test.ts            (server)
 Test Files  1 passed (1)
      Tests  10 passed (10)
$ vitest run src/modules/schedules tests/unit/workflow-approvals.test.ts tests/unit/status.test.ts
 Test Files  1 failed | 8 passed | 1 skipped (10)     ← status.test قبل تحديث STATUS (264 → 265)؛ بعده:
 Test Files  9 passed | 1 skipped (10)
      Tests  108 passed | 3 skipped (111)
$ pnpm change-record:check
change-record  OK — 1 record(s) valid
$ vitest run tests/schedule-extras.test.tsx tests/schedule-runs.test.tsx tests/schedule-run-options.test.tsx tests/tasks-schedules-profiles.test.tsx tests/i18n.test.ts tests/logical-css.test.ts   (web)
 Test Files  6 passed (6)
      Tests  195 passed (195)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzz-schedule-templates.spec.ts
  1 passed (9.3s)
```

أول تشغيل لـPlaywright فشل بحق: «Sat 09:00» — القائمة كانت ما تزال تعرض مرات القيمة السابقة (`0 9 * * *`)
أثناء مهلة الكتابة (300 مللي ثانية). أضفتُ `data-trigger` و`data-state` على المعاينة وصار الاختبار ينتظر
جواب الخادم للقيمة الجديدة. حساب الخادم نفسه كان صحيحًا (Mon/Tue/Wed/Thu).

الاختبارات الجديدة تفشل على الكود القديم: لا حقل `limits` ولا مسار `/schedules/preview` ولا قائمة.

CI على #133 (التشغيل 36106683863)، كلها ناجحة:
```
Lint, typecheck, contracts, tests, build              pass
Web smoke journeys (Playwright against the real hub)  pass
Docker image builds and answers /health               pass
db:generate + db:migrate (SQLite and PostgreSQL)      pass
PR adds or updates a change record                    pass
PR leaves graphify-out/ to the code-map bot           pass
```

## المخاطر والرجوع
- **تغيير منفذ دور الوكيل**: خطوة الوكيل صارت `runs.start` + `handle.done` بدل `oneTurn` (الذي هو
  `startTurn` + `done` نفسه)، مع إلغاء الدور عند انتهاء حد. بلا حدود لا يُلغى شيء.
- **قراءة التكلفة كل ثانيتين** أثناء خطوة وكيل **فقط** إن كان للتشغيل حد تكلفة؛ استعلام SQLite صغير على
  `usage_records` بمعرّف الدور.
- **دقة حد التكلفة**: بقدر دقة تقدير المركز؛ نموذج بلا سعر لا يوقف شيئًا. وتقرير الاستخدام قد يتأخر عن
  الإنفاق الفعلي بدور نموذج واحد.
- **الإصدار**: تغيير الحدود يرفع `version` سير العمل (كتعديل الرسم) — التشغيلات السابقة تحفظ لقطتها.
- **تعارض متوقع مع #109** (محرّر سير العمل) في `openapi.yaml` و`SchedulesScreen.tsx` و`ScheduleRuns.tsx`
  والنصوص؛ التعديلات هنا صغيرة وإضافية لتسهيل الدمج.
- **الرجوع**: إلغاء الطلب كاملًا؛ لا هجرة ولا أعمدة. سير عمل حُفظت فيه حدود يبقى حقل `limits` في JSON
  تعريفه ولا يقرؤه الكود القديم.

## التسليم والخطوة التالية
- طلب الدمج على `main` بالإنجليزية؛ ينتظر مراجعة المالك وتأكيد «المقترح» في §57.
- **«أكمل في كور هب»**: طلب منفصل مكدّس على `feat/channel-conversations` (#126، المكدّس على #121) —
  رابطه وقراره في سجله الخاص.
- بعد دمج #109: وضع `WorkflowLimitsForm` في لوحة إعدادات المحرّر، وحد التشغيل الواحد في زر «شغّل».
