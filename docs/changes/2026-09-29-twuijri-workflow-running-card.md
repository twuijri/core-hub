# سير العمل: البطاقة تُظهر التشغيل وهو يجري
المسؤول: twuijri · الفرع: feat/workflow-running-card ← batch/2026-09-29c · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٩): في صفحة سير العمل، إذا اشتغل سير عمل «ابي اشوفه وهو يشتغل» — إطار أخضر يدور حول
البطاقة مثل بطاقة المهام الجارية، وشارة «يعمل» بدل «متوقف»، ويرجع لحاله إذا انتهى. والحالة الأهم: تشغيل
بدأه **مشغّل** (وصل webhook من ClickUp) والمالك فاتح الصفحة — يجب أن تتحول البطاقة وحدها بلا تحديث.

وُجد السبب الأساسي: صفحة سير العمل لم تكن تستمع لأحداث `/rt/schedules` أصلًا منذ انفصلت عن صفحة الجدولة
(٢٠٢٦-٠٩-٢٨، §126) — المستمع بقي داخل `SchedulesScreen` فقط، فلا يظهر أي تشغيل إلا بعد إعادة تحميل الصفحة.
والخادم يطلق `workflow_run.started` لكل تشغيل (زر، جدولة، مشغّل) من نفس المكان (`WorkflowEngine.start`)،
فلا تغيير مطلوب في الخادم.

## القرار والموافقات
- مستمع `/rt/schedules` انتقل إلى `schedules/events.ts` (`useScheduleEvents`) وتستخدمه الصفحتان: الجدولة
  وسير العمل. ويتصل بالمقبس فقط إن لم يكن متصلًا ولا في طريقه (نفس قاعدة `background/queries.ts`).
- قائمة سير العمل تُسأل من جديد كل ثانيتين ما دام فيها تشغيل جارٍ، وكل ٣٠ ثانية غير ذلك — احتياط لغياب المقبس.
- البطاقة الجارية: نفس لغة لوحة المهام — إطار أخضر بتدرّج مخروطي يدور (`--task-frame-angle` و`task-frame-turn`
  وألوان `status-running` / `status-running-sweep` من ui-tokens)، وشارة خضراء بنقطة تنبض: «يعمل · <عنوان
  الخطوة>». المنتظر لموافقة: إطار كهرماني ثابت (`status-scheduled`) وشارة «ينتظر الموافقة · <الخطوة>».
  عنوان الخطوة من التشغيل الحي (`GET /workflow-runs/{id}` الموجود) فقط للبطاقة التي لها `active_run_id`.
  عند الانتهاء ترجع «متوقف» (القائمة لا تحمل نتيجة آخر تشغيل؛ عرضها متابعة لاحقة).
- الشريط الجانبي: نقطة خضراء صغيرة تنبض على «سير العمل» (أو على عنوان «الأدوات» إذا كانت مطوية) ما دام أي
  سير عمل في البروفايل المختار يعمل. النقطة للعين فقط (`aria-hidden`) حتى لا يتغير اسم الرابط أثناء التشغيل.
- `prefers-reduced-motion`: لا دوران ولا نبض — إطار أخضر ثابت والشارة فقط.
- مقترح — للمالك أن يؤكد: الهواتف تعرض أصلًا شارة «يعمل» (أندرويد بلون النجاح)؛ الإطار الأخضر على بطاقات
  الهاتف متابعة لاحقة ولم يُبنَ هنا.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. الويب يقرأ حقولًا موجودة (`Workflow.active_run_id`، `WorkflowRun.status/steps`) وأحداثًا موجودة.

## الملفات والتأثير
- جديد: `packages/web/src/schedules/events.ts`، `packages/web/src/schedules/workflows/activity.ts`،
  `packages/web/src/schedules/workflows/WorkflowActivity.tsx`.
- `packages/web/src/schedules/SchedulesScreen.tsx` (نُقل المستمع فقط)، `packages/web/src/screens/WorkflowsScreen.tsx`
  (يستمع الآن)، `packages/web/src/schedules/workflows/WorkflowsSection.tsx` (البطاقة والشارة)،
  `packages/web/src/schedules/workflows/queries.ts` (استطلاع `useWorkflows` فقط)، `packages/web/src/shell/Sidebar.tsx`
  (النقطة)، `packages/web/src/styles/screens.css`، `packages/web/src/i18n/{ar,en}.json` (`workflows.activity.*`).
- اختبارات: `packages/web/tests/workflow-activity.test.tsx`، `packages/web/e2e/zzzzzzzzzzzzzzzz-workflow-running.spec.ts`
  وصورتها `packages/web/e2e/shots/workflow-running-card-ar-light.png`.
- لم تُلمس ملفات المحرر/StepPanel/المحرّك التي يعمل عليها الفرع الآخر في الدفعة.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm --filter @corehub/web typecheck      (نظيف)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm i18n:check
i18n:check  web: 3526 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 41 destinations, 2 pre-auth screens (login, setup), 47 terms, ar/en complete, routes for web, ios, android, desktop
$ npx vitest run --maxWorkers=2 tests/workflow-activity.test.tsx tests/schedule-runs.test.tsx tests/schedule-run-options.test.tsx tests/schedule-extras.test.tsx tests/navigation.parity.test.tsx tests/hub-tools-card.test.tsx tests/agents-top-level.test.tsx tests/agent-jobs-plugins.test.tsx tests/workflow-editor.test.tsx tests/sidebar-tools.test.tsx tests/tasks-schedules-profiles.test.tsx tests/sidebar-rail.test.tsx
 Test Files  12 passed (12)
      Tests  94 passed (94)
$ PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test e2e/zzzzzzzzzzzzzzzz-workflow-running.spec.ts e2e/zzzzzzzzzzzzzzz-sidebar-tools.spec.ts e2e/zzzzzz-workflow-editor.spec.ts --workers=1
  ✓  1 … 32. a two-step workflow drawn on the canvas runs, and its run is read on the canvas (3.5s)
  ✓  2 … 32b. a new workflow is checked before it has a name, then named, saved and run by hand (5.3s)
  ✓  3 … Tools folds away, Search sits by the toggle, and Workflows has its own page (1.6s)
  ✓  4 … 44. a run a trigger started shows on its card and in the sidebar, live (6.1s)
  4 passed (25.8s)
```
الرحلة ٤٤ على الهب الحقيقي: سير عمل بخطوة انتظار ٥ ثوانٍ ومشغّل `token`، الصفحة مفتوحة وهادئة، ثم POST
لعنوان المشغّل العام (لا أحد ضغط «شغّل») ← البطاقة `data-frame=running` وشارة «يعمل · انتظار قصير» ونقطة
الشريط الجانبي، والحركة `task-frame-turn` تصبح `none` مع تقليل الحركة، ثم ترجع «متوقف» وتختفي النقطة.
اختبار الوحدة يطلق `workflow_run.completed` على المقبس ويتحقق أن البطاقة ترجع بلا إعادة تحميل (يفشل على الكود
القديم: الصفحة لم تكن تستمع). الحزم الكاملة تعمل على CI عند الدفع.

## المخاطر والرجوع
- الشريط الجانبي يقرأ `GET /workflows?profiles=all` في كل صفحة (فقط حين يظهر مدخل سير العمل) مع استطلاع كل
  ٣٠ ثانية؛ الحِمل صغير. البطاقة الجارية تقرأ تشغيلها كل ثانيتين ما دام جاريًا (نفس `useWorkflowRun` الموجود).
- عرض فقط، بلا تغيير في العقد أو البيانات؛ العملاء والهب القديمة غير متأثرة. الرجوع: revert.

## التسليم والخطوة التالية
ضمن دفعة 2026-09-29c (PR #225). متابعات: إطار أخضر على بطاقات الهاتف (iOS/Android)، وعرض نتيجة آخر تشغيل
على البطاقة بعد انتهائه (يحتاج حقلًا إضافيًا اختياريًا في القائمة).
