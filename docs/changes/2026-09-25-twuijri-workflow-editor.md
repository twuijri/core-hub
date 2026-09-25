# محرّر مرئي لسير العمل في صفحة الجدولة
المسؤول: twuijri · الفرع: feat/workflow-editor · الحالة: review

## المشكلة والهدف
محرّك سير العمل يعمل في الخادم (#92): خطوات `agent` و`condition` و`delay` و`notify` و`approval`،
وقوالب `{{steps.<id>.output}}`، والتحقّق عند الحفظ، والتشغيل والإلغاء وإعادة التشغيل من عقدة
والسجلّ. لكن الويب لا يملك شاشة **ترسم** سير العمل: يشغّله ويوافق على خطواته فقط، وسير العمل
يُصنع عبر الـAPI (رحلة e2e رقم 29 تقول ذلك صراحةً: «No drawing surface for workflows yet»).

الهدف: قسم «سير العمل» في صفحة الجدولة فيه لوحة رسم (إضافة عقد، سحب، وصل بحوافّ نجاح وفشل،
تحريك وتكبير، حذف، لوحة مفاتيح)، ونماذج لكل نوع خطوة، وتحقّق حيّ من الخادم تظهر نتائجه على
العقد، وإنشاء وتعديل ونسخ وحذف، و«شغّل» و«شغّل من هذه الخطوة»، وعرض التشغيل على اللوحة.

## القرار والموافقات
- **المكان**: قسمان داخل صفحة «الجدولة» نفسها — «الجداول» و«سير العمل» (تبويبان) — والمحرّر يُفتح
  بعنوان داخل الصفحة: `/schedules?section=workflows&workflow=<id|new>&profile=<slug>[&run=<id>]`.
  فلا وجهة جديدة في خريطة التنقّل ولا تغيير في `navigation.json` (المدخل «الجدولة» وعنوانه كما هما).
  شيفرة المحرّر تُحمَّل عند فتح سير عمل فقط (`lazy`): ١٠٫٥ ك.ب مضغوطة.
- **بلا مكتبة رسم**: HTML للعقد فوق SVG واحد للحوافّ، بأحداث المؤشّر. React Flow كان سيضيف
  مكتبة ونمطًا ليسا من عُدّتنا مقابل بضع مئات من الأسطر؛ ولا حاجة إلى `THIRD-PARTY-NOTICES`.
- **الاتجاه (مقترح — ينتظر تأكيد المالك)**: الرسم يجري باتجاه القراءة. `position.x` في العقد
  **منطقي** (المسافة على اتجاه القراءة)، واللوحة تنعكس بتحويل واحد في العربية، وكل عقدة تعكس
  محتواها مرّة ثانية فيُقرأ نصّها عاديًا. فسير عمل رُسم بالعربية يجري من اليمين إلى اليسار، ويُفتح
  بالإنجليزية من اليسار إلى اليمين، بلا تخطيط ثانٍ مخزَّن. سجّلته في DECISIONS §48.
- **التحقّق الحيّ من الخادم لا من العميل** (مقترح — ينتظر تأكيد المالك): عملية جديدة
  `validateWorkflow` تشغّل القاعدة نفسها التي يطبّقها الحفظ على رسم لم يُحفظ، وكل ملاحظة تسمّي
  العقدة أو الحافّة بـ`code` ثابت يترجمه العميل، و`message` هي الكلمات الإنجليزية نفسها التي يحملها
  `409 workflow_invalid` منذ البداية. «المشكلات» تمنع الحفظ، و«التنبيهات» لا تمنعه. يُفحص الرسم
  بعد ٣٥٠ م.ث من كل تغيير، وتُعلَّم العقدة بعدد ملاحظاتها (أحمر للمشكلة وكهرماني للتنبيه).
- **قائمة سير العمل تجمع كل البروفايلات** (ADR 0016): `listWorkflows?profiles=all`، وكل فعل على سير
  عمل يُرسل ببروفايله؛ الجديد يُنشأ في بروفايل الشريحة العلوية والقسم يسمّيه.
- **عرض التشغيل يحتاج ما أنتجته كل خطوة وأيّ طريق سلكت**: أضفت `output` و`route` إلى
  `WorkflowStep`. شرط «لا» خطوة ناجحة تتبع حوافّ الفشل، فلا يستنتج العميل الطريق من الحالة. المحرّك
  يكتب الطريق مع الناتج؛ الخطوات الأقدم تُقرأ من حالتها.
- **نموذج كل نوع يعرض ما يفعله المحرّك فقط**: الوكيل (وكيل، نموذج اختياري — وصار المحرّك يمرّره
  إلى دور الوكيل بعد أن كان يتجاهله — وطلب مع قائمة «أدرج» لـ`{{input}}` ولناتج كل خطوة سابقة
  متّصلة)، والشرط (المسار، والمقارنات العشر التي يقرؤها `expr.ts`، والقيمة؛ وشرط لا يُقسَم يُحرَّر
  نصًّا)، والانتظار (ثوانٍ أو دقائق حتى ساعة)، والإشعار (نصّه، ويصل إلى صندوق من يشغّل سير العمل)،
  والموافقة (سؤالها؛ يجيبها أي شخص يجيب الموافقات في البروفايل، ولا مهلة لها)، و«اطلب موافقة قبل
  هذه الخطوة» لغير الموافقة. **لا حقول لما ليس في المحرّك**: مستلمو الإشعار، مهلة الموافقة، مرفقات
  الخطوة — يقول النموذج ذلك بدل حقل لا يفعل شيئًا.
- **الوصل**: بالسحب من نقطة النجاح (خضراء) أو الفشل (حمراء) إلى عقدة، أو من اللوحة الجانبية
  («الخطوة التالية» و«متى») لمن لا يستعمل المؤشّر؛ وتغيير طريق الوصلة أو حذفها من لوحتها.
- **لوحة المفاتيح**: كل عقدة ووصلة زرّ يُركَّز عليه (Tab) فيُحدَّد؛ الأسهم تحرّك العقدة المحددة
  (Shift أبعد) أو تحرّك اللوحة؛ Delete/Backspace يحذف؛ + و− للتكبير؛ 0 يعرض الكل؛ Escape يلغي
  التحديد. والعجلة تكبّر حول المؤشّر، والسحب على الخلفية يحرّك اللوحة.
- **التشغيل من اللوحة**: «شغّل» (يحفظ أولًا إن تغيّر الرسم) مع مدخل اختياري لـ`{{input}}`؛ و«شغّل من
  هذه الخطوة» (`start_node_ids`)؛ وفي عرض التشغيل «أعد التشغيل من هذه الخطوة» (`rerun`، يعيد استعمال
  نواتج الخطوات السابقة). عرض التشغيل يلوّن كل عقدة بحالتها (تنتظر، تعمل، تمّت، فشلت، تُخطّيت)،
  ويُبرز الوصلات المسلوكة ويخفّت غيرها، ويعرض ناتج الخطوة (يُطوى إن طال)، وعلى عقدة الموافقة
  المنتظِرة زرّا «وافق» و«ارفض» (`ApprovalGate` نفسه من #92، بنسخة مدمجة على العقدة وكاملة مع
  السبب في اللوحة الجانبية)، و«أوقف التشغيل».
- **النسخ**: «نسخ» ينشئ «<الاسم> (نسخة)» في بروفايل الأصل ويفتحه.

## العقد
DECISIONS §48 (مقترح — ينتظر تأكيد المالك):
- جديد: `schedules.validateWorkflow` — `POST /workflows/validate`، الجسم `WorkflowWrite`، الجواب
  `200 WorkflowValidation { valid, problems[], warnings[] }`، و`WorkflowIssue { code, node_id,
  edge_id, detail, message }`.
- `schedules.listWorkflows` يقبل `profiles=all`.
- `WorkflowStep` صار فيه `output` (نص أو `null`، حتى ٢٠٠٠٠ حرف) و`route` (`success`/`failure`/`null`)،
  وكذلك مخطط الحدث `step.waiting`.
- لا هجرة: الطريق يُكتب في عمود `output` (JSON) الموجود.
العمليات: 265 (كانت 264)، والمبني 207.

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml`، `packages/contracts/events/schedules/step.waiting.schema.json`.
- الخادم (`modules/schedules`): `service.ts` (`problemsOf`/`warningIssuesOf` بملاحظات منظّمة،
  و`validateDefinition`/`warningsFor` كما كانتا نصًّا)، `index.ts` (المسار الجديد و`profiles=all`)،
  `workflow-engine.ts` (`output`/`route` في `stepOf`، كتابة الطريق، تمرير نموذج الخطوة).
- اختبارات الخادم: `modules/schedules/workflow-editor.test.ts` (٥)، و`tests/contract/workflow-editor.contract.test.ts` (٢).
- الويب: `src/schedules/workflows/` (جديد: `model.ts` الحالة الصافية، `geometry.ts` حساب اللوحة،
  `queries.ts`، `WorkflowCanvas.tsx`، `StepPanel.tsx`، `WorkflowEditor.tsx`، `WorkflowsSection.tsx`)،
  `SchedulesScreen.tsx` (التبويبان والمحرّر)، `ScheduleRuns.tsx` (`ApprovalGate` مُصدَّرة بنسخة
  مدمجة)، `realtime/envelope.ts` (`workflow.created/updated/deleted`)، ملفا اللغة (مفتاح `workflows`
  جديد بعد `schedules`، إضافة فقط).
- اختبارات الويب: `tests/workflow-editor-model.test.ts` (١٣)، `tests/workflow-editor.test.tsx` (٥).
- e2e: `e2e/zzzzzz-workflow-editor.spec.ts` (الرحلة 32) وجواب مكتوب له في `e2e/hub.ts`،
  ولقطتان `workflow-editor-ar-light.png` و`workflow-run-ar-light.png`.
- الوثائق: `docs/contracts/DECISIONS.md` §48، `docs/STATUS.md`.
- لقطات الجدولة الحالية ستتغيّر في CI لأن الصفحة صار فيها صفّ التبويبين؛ لم أُعِد توليدها محليًا.

## الفحوص
محليًا (بحسب قاعدة السرعة: ما مسّه التغيير فقط، والمجموعات الكاملة في CI):
```
$ pnpm contracts:lint
openapi.yaml: validated in 435ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ vitest run src/modules/schedules/workflow-editor.test.ts src/modules/schedules/workflow-engine.test.ts   (server)
 Test Files  2 passed (2)
      Tests  15 passed (15)

$ vitest run tests/contract/workflow-editor.contract.test.ts   (server, contract project)
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ vitest run tests/contract/schedules.contract.test.ts tests/contract/contract.test.ts tests/unit/workflow-approvals.test.ts
 Test Files  3 passed (3)
      Tests  275 passed (275)

$ vitest run tests/unit/status.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)

$ vitest run tests/workflow-editor-model.test.ts tests/workflow-editor.test.tsx   (web)
 Test Files  2 passed (2)
      Tests  18 passed (18)

$ vitest run tests/schedule-runs.test.tsx tests/i18n.test.ts tests/logical-css.test.ts tests/schedule-run-options.test.tsx tests/tasks-schedules-profiles.test.tsx tests/all-profiles.test.tsx
 Test Files  6 passed (6)
      Tests  206 passed (206)

$ pnpm build   (web chunk of the editor, loaded on demand)
dist/assets/WorkflowEditor-rtZfSbmi.js     35.91 kB │ gzip:  10.54 kB

$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzz-workflow-editor.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-workflow-editor.spec.ts:44:1 › 32. a two-step workflow drawn on the canvas runs, and its run is read on the canvas (3.9s)
  1 passed (10.1s)

$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck        → exit 0
$ pnpm contracts:check-clients
check-clients  OK — 291 client file(s) scanned, 177 contract path(s) known.
$ pnpm i18n:check       → i18n:check  OK
$ pnpm nav:check        → nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
```
CI: يُضاف ناتجه بعد الدفع.

## المخاطر والرجوع
- **عرض التشغيل يرسم الرسم المحفوظ الآن**، لا لقطة الرسم التي عمل بها التشغيل (العقد لا يعيدها).
  إن تغيّر الرسم بعد التشغيل، تظهر خطوات التشغيل على العقد الموجودة فقط.
- **القائمة بلا ترقيم صفحات** كما كانت (`next_cursor: null`)؛ `profiles=all` يجمع كل البروفايلات في
  جواب واحد. يكفي لعشرات سير العمل، لا لآلاف.
- **إعادة الملاءمة**: اللوحة تلائم نفسها عند الفتح وعند أول خطوة، وتُظهر كل خطوة جديدة بأقلّ تحريك؛
  لا خريطة مصغّرة.
- المحرّك ما زال بلا مستلمين للإشعار ولا مهلة للموافقة ولا مرفقات للخطوات؛ النماذج تقولها.
- الرجوع: الفرع وحده، ولا هجرة؛ الحقلان الجديدان في `WorkflowStep` والعملية الجديدة إضافات.

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية؛ الدمج للمالك. ينتظر تأكيد المالك: اتجاه اللوحة، و`validateWorkflow`
وشكل ملاحظاته، و`output`/`route` في الخطوة (DECISIONS §48).

التالي المقترح: لقطة الرسم في `WorkflowRun` ليُرسم التشغيل برسمه، ومستلمون للإشعار ومهلة للموافقة
إن أرادها المالك في المحرّك أولًا.
