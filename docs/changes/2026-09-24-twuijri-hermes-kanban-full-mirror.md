# بطاقات هرمز على لوحة المهام: مرآة كاملة عبر واجهة هرمز
المسؤول: twuijri · الفرع: feat/hermes-kanban-full-mirror · الحالة: review

## المشكلة والهدف
بطاقات هرمز تظهر على لوحة «المهام» وتُنقل عبر أمر `hermes kanban`، لكن المجلس **يرفض** كل ما
سوى النقل: تعديل العنوان والوصف (`409 hermes_owns_text`)، والحذف، والإيقاف، والتعديل الجماعي
(`hermes_owns_card`)، لأن أمر هرمز لا يعرف هذه الأفعال. قرار المالك: «اقدر اشوفها من التاسك في
المجلس واعدل عليها وانقلها للي ابي ويعدلها هو للي داخل هرمز كانها مراه». وPR ‏#69 أضاف خادم
هرمز الداخلي (`hermes serve`، ADR 0015) الذي يملك هذه الأفعال. الهدف: أن تصير بطاقة هرمز
قابلة للتعديل والحذف والتعليق والإيقاف والتسليم إلى بروفايل آخر من المجلس، **على هرمز أولًا**.

## القرار والموافقات
- **منفذ جديد في `modules/index.ts`**: `HermesBoardPort` صار فيه `api()` (من
  `hermesDashboardFor(app)`، و`null` حين لا يدير المجلسُ هرمز) و`profiles()` (كل مساحة عمل
  مع اسم بروفايل هرمز الخاص بها، ADR 0014). أخطاء خادم هرمز تُترجم هناك إلى أخطاء وحدة المهام
  (`HermesRefusal` بجملة هرمز نفسها، و`HermesApiUnavailable`)، فلا تستورد وحدةٌ الأخرى.
- **`tasks/hermes-api.ts` (جديد)**: أي نداء يعني ماذا، بأي جسم — مأخوذ من
  `plugins/kanban/dashboard/plugin_api.py` في الصورة (MIT، قراءة فقط):
  - التعديل: `PATCH …/tasks/{id}` بـ`{title?, body?, priority?}` ← `{task}`. الوصف الفارغ يُرسل
    `""` لأن هرمز يعدّ `null` «غير مُرسل».
  - الحذف: `DELETE …/tasks/{id}`. التعليق: `POST …/tasks/{id}/comments` بـ`{body, author}`.
  - التسليم: `POST …/tasks/{id}/reassign` بـ`{profile, reclaim_first}`.
  - الإيقاف: `GET …/tasks/{id}` لقراءة `current_run_id` ثم `POST …/runs/{run_id}/terminate`؛
    وإن لم يكن تشغيل، `POST …/tasks/{id}/reclaim` حتى يكون الرفض بكلام هرمز لا بكلامنا.
  - **سلّم الأولوية**: هرمز عدد صحيح، الافتراضي `0`، والأعلى يُلتقط أولًا. `low=-1`،
    `normal=0`، `high=1`، `urgent=2`؛ وعند القراءة: ما دون الصفر `low`، ومن ٢ فما فوق `urgent`.
- **القاعدة في كل كتابة**: هرمز أولًا؛ لا يتغيّر صفّ المجلس إلا بعد قبوله؛ الرفض يعود `409` مع
  `details.reason: 'hermes_refused'` وجملة هرمز كما هي ولا يتغيّر شيء؛ وخادم لا يُوصل إليه يعود
  `503 service_unavailable` مع `details.reason: 'hermes_api_unavailable'` ونصّ يقول إن واجهة هرمز
  غير متاحة. بعد القبول تُحدَّث المرآة **من جواب هرمز** (هرمز يقصّ المسافات من العنوان مثلًا).
- **ما صار ممكنًا على بطاقة هرمز**: تعديل العنوان والوصف والأولوية (`updateTask` و`bulkUpdate`)،
  والحذف (`deleteTask` و`bulkDeleteTasks`)، والتعليق (`createComment`: يُقال على بطاقة هرمز باسم
  الشخص الظاهر أو اسم المستخدم، ثم يُقرأ من هرمز ويُعاد)، والإيقاف (`stopTask`)، والتسليم إلى
  مساحة عمل أخرى (`assignTask` بحقل جديد `profile`؛ البطاقة الجارية تُرسل `reclaim_first: true`
  بعد أن يؤكّد الشخص في الواجهة).
- **القراءة**: فتح البطاقة (`getTask`) يقرؤها من هرمز مع تعليقاته، وتُضاف التعليقات التي لا يعرفها
  المجلس بوقتها في هرمز (لا يُحذف شيء: هرمز لا يحذف التعليقات، وتعليق كُتب قبل هذا التغيير
  يبقى). كاتب التعليق الذي اسمه بروفايل من بروفايلات هرمز وكيلٌ، وغيره شخص. وحيث يدير المجلس
  هرمز صارت القراءة تعكس أيضًا **أولوية هرمز** و**البروفايل الذي أُعطيت له البطاقة**: البطاقة
  تنتقل إلى مساحة العمل التي هي ذلك البروفايل (إلى مشروعها الافتراضي، برقم جديد فيه، ومعها
  تعليقاتها وسجلّها). وحين لا يدير المجلس هرمز تبقى الأولوية والمساحة للمجلس كما كانتا.
- **الإنشاء**: البطاقة التي تُصنع لهرمز من مساحة عمل تُعطى لبروفايل تلك المساحة
  (`--assignee`) وبأولويتها (`--priority`). لم يكن هذا موجودًا في `main` رغم ما في وصف المهمة؛
  كانت البطاقة تُصنع بلا مُسنَد.
- **التسخين**: قراءة اللوحة (`getColumns`) تنادي `warm()` حين يكون للمجلس هرمز — دالة جديدة في
  `HermesDashboard` تبدأ الخادم في الخلفية بلا انتظار ولا رمي، وتُحسب استخدامًا، فالدقائق العشر
  تُعدّ من آخر من فتح اللوحة. لم تكن `warm()` موجودة في `main` فأُضيفت (مع اختباراتها).
- **بلا خادم هرمز** (هرمز خارجي أو لا هرمز): السلوك كما هو بالضبط — الرفض نفسه (`hermes_owns_text`،
  `hermes_owns_card`)، والتسليم يُرفض بـ`hermes_owns_card` و`action: 'reassign'`، والتعليق يبقى
  للمجلس.
- **الويب**: قائمة بطاقة هرمز صار فيها «التفاصيل…» و«إعادة التسمية» و«حذف» (مع تنبيه أنها
  تُحذف من لوحة هرمز أيضًا)، و«تسليم إلى بروفايل آخر…»، و«إيقاف» للبطاقة الجارية. نافذة التفاصيل
  (جديدة، لكل البطاقات): العنوان والوصف والأولوية والتعليقات مع خانة تعليق؛ على بطاقة هرمز تقول
  «كل تعديل يُجرى على هرمز أولًا». نافذة التسليم تعرض البروفايلات بأسماء مساحات العمل عدا مساحة
  البطاقة، وتسأل قبل تسليم بطاقة جارية. رفض هرمز يظهر بكلامه، وتعذّر واجهته برسالة صريحة.
  **وكل كتابة من اللوحة صارت تُرسل مساحة عمل البطاقة نفسها** (`X-Hub-Profile`) لا مساحة
  الرأس، فبطاقة من مساحة أخرى — ومنها بطاقة سُلّمت للتوّ — تُعدَّل حيث هي بدل `404`.

### قرارات للمالك
1. **حقل عقد جديد `TaskAssign.profile`** (اختياري): لم أجد طريقة للتعبير عن «سلّمها لبروفايل
   هرمز آخر» بلا حقل، لأن البروفايل ليس وكيلًا في السجل. يُتجاهل لأي بطاقة ليست لهرمز.
2. **مساحة البطاقة تتبع مُسنَدها في هرمز**: وهذا يعني أن بطاقة أعطاها هرمز نفسه لبروفايل
   `design` تظهر في مساحة «design» لا في الافتراضية.
3. **الإيقاف بلا تشغيل** يُرسل `reclaim` ليكون الرفض بجملة هرمز.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
في `openapi.yaml`: حقل اختياري `profile` (`ProfileSlug` أو `null`) في `TaskAssign` بوصفه، و`409
Conflict` معلنة على `tasks.updateTask` و`tasks.deleteTask` و`tasks.createComment` (كانت الأوليان
ترميانها أصلًا). لا عملية ولا حدث جديد. `pnpm contracts:lint` نظيف، و`contract:test` أخضر.

## الملفات والتأثير
- `packages/server/src/modules/tasks/hermes-api.ts` (جديد)، و`hermes-api.test.ts` (جديد، ١٦
  اختبارًا بخادم مزيّف خلف `createHermesCardApi` الحقيقي)، و`hermes-api.real.test.ts` (جديد).
- `packages/server/src/modules/tasks/{index,hermes-mirror,service,hermes-kanban}.ts`: المسارات،
  والمرآة (رأسها بالقاعدة ٣ الجديدة)، و`reflectExternal` بالأولوية والمساحة، و`reflectComments`،
  و`--assignee`/`--priority` عند الإنشاء.
- `packages/server/src/modules/agents/{hermes-dashboard,index}.ts` و`hermes-dashboard.test.ts`:
  `warm()` وثلاثة اختبارات، وتصدير نوعين للاختبار الحقيقي.
- `packages/server/src/modules/index.ts`: تركيب المنفذ.
- `packages/web/src/tasks/{TaskDialog,HandOverDialog,errors}.tsx|ts` (جديدة)،
  و`TasksScreen.tsx` و`queries.ts`، و`i18n/{ar,en}.json`.
- `packages/web/tests/task-hermes-card.test.tsx` (جديد، ٧ اختبارات)، وتحديث
  `task-run.test.tsx` و`task-board-visuals.test.tsx`، و`e2e/hub.ts` (خادم هرمز مزيّف)،
  و`e2e/smoke.spec.ts` (الرحلة ١٧ تعدّل بطاقة هرمز)، ولقطة جديدة `tasks-hermes-details-ar-light.png`.
- `docs/STATUS.md` (صفّ المهام)، و`docs/adr/0015-…` (العواقب: أول مستخدم).
- لم يُمسّ شيء من الجلسات ولا قائمة الجلسات ولا البحث ولا `WorkspaceSwitcher`/`TopBar`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!
$ pnpm typecheck                 -> exit 0
$ pnpm contracts:lint            -> contracts:lint  OK
$ pnpm contracts:check-clients   -> check-clients  OK — 216 client file(s) scanned, 166 contract path(s) known.
$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  254 passed (254)
$ pnpm i18n:check                -> web: 831 keys, ar/en in parity ... i18n:check  OK
$ pnpm nav:check                 -> nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/server test
 Test Files  71 passed | 7 skipped (78)
      Tests  762 passed | 19 skipped (781)
$ pnpm --filter @majlis/web test
 Test Files  35 passed (35)
      Tests  453 passed (453)
$ pnpm --filter @majlis/web build  -> ✓ built
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  ✓  11 [chromium] › e2e/smoke.spec.ts:559:3 › web smoke journeys › 17. Hermes's own cards: marked as Hermes's, edited on Hermes, and Hermes's refusal in its own words (2.0s)
  26 passed (2.8m)

# هرمز الحقيقي من الصورة (ghcr.io/twuijri/majlis:latest، sha256:ddbc7cd4…، 2026-09-23):
$ MAJLIS_HERMES_IMAGE=ghcr.io/twuijri/majlis:latest pnpm --filter @majlis/server exec \
    vitest run src/modules/tasks/hermes-api.real.test.ts src/modules/agents/hermes-dashboard.real.test.ts
 Test Files  2 passed (2)
      Tests  3 passed (3)
tasks → hermes serve: first edit 1658 ms
```
الاختبار الحقيقي يمرّ عبر مسارات المجلس نفسها: بطاقة يصنعها أمر هرمز، ثم تعديل العنوان والوصف
بالعربية، والأولوية `urgent` (تُقرأ `2`)، وتعليق باسم `Admin`، ورفض عنوان فارغ بجملة هرمز
`title cannot be empty` بلا تغيير، والتسليم إلى بروفايل `design` (المُسنَد في هرمز `design`)،
ثم الحذف من مساحة `design` — كلّه متحقَّق بـ`hermes kanban show --json`. لا حاويات متبقية بعده.
اللقطات غير المتعلقة التي أعاد e2e رسمها أُرجعت.

## المخاطر والرجوع
- **الإيقاف لم يُجرَّب على هرمز حقيقي**: يحتاج تشغيلًا حقيقيًا لعامل هرمز (نموذج). جُرّب بالخادم
  المزيّف (terminate ثم reclaim)، والمسار مأخوذ من المصدر.
- **التسليم لبروفايل لا يعرفه هرمز**: هرمز لا يتحقق من وجود البروفايل (`assign_task`)؛ المجلس لا
  يعرض إلا مساحات العمل، وكل مساحة بروفايل (ADR 0014)، فالخطر في المساحات القديمة التي أُنشئت قبل
  مرآة البروفايلات فقط.
- **التعليقات**: تُضاف ولا تُحذف؛ مفتاح المطابقة (الكاتب، النص، الثانية). تعليقان متطابقان في
  الثانية نفسها يُعدّان واحدًا.
- **فتح البطاقة يقرأ من هرمز** (خادمه)؛ إن تعذّر يُعرض آخر انعكاس ويُسجَّل السبب في السجل.
- **قراءة اللوحة تسخّن الخادم في كل مرة** (ومنها السؤال كل ٤ ثوانٍ أثناء تشغيل بطاقة)، فيبقى
  الخادم حيًّا ما دامت اللوحة مفتوحة على بطاقة جارية — ~١٣٠–١٧٠ ميبي بايت، كما في ADR 0015.
- بطاقة يعيد هرمز إسنادها بينما هي مفتوحة في مساحة أخرى: قراءة التفاصيل بعدها `404` في المساحة
  القديمة حتى تُقرأ اللوحة من جديد.
- الرجوع: الفرع وحده، بلا هجرة ولا تغيير في الصورة.

## التسليم والخطوة التالية
PR إلى `main` من `feat/hermes-kanban-full-mirror`. الدمج والنشر وبناء صورة الاختبار للمالك.
التالي المقترح: عرض أحداث هرمز وتشغيلاته في نافذة التفاصيل، ونقل الأولوية والتعليق في «مرآة»
التعديل الجماعي في الويب إن احتاجها المالك.
