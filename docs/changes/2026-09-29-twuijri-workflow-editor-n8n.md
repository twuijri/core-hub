# محرر سير العمل بشكل n8n: المشغّلات عقد على اللوحة، «+» للخطوة التالية، نافذة لكل خطوة، وحفظ لا يُنسى
المسؤول: twuijri · الفرع: feat/wf-editor-n8n ← batch/2026-09-29d · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٩): المحرر يعمل وظيفيًا لكن المختبرين تاهوا — واحد لم يجد أين يضيف مشغّلًا (كان في
اللوحة الجانبية ولا يظهر إلا حين لا تكون خطوة محددة)، وآخر أنهى التعديل وانتقل لصفحة أخرى فضاع عمله لأن لا شيء
نبّهه أن يحفظ. المطلوب أن يشبه n8n بصريًا: المشغّلات عقد في بداية التدفق، لوحة فارغة فيها «أضف مشغّلًا» كبير،
«+» بعد كل خطوة لإضافة التالية من قائمة قابلة للبحث، تحرير الخطوة في نافذة مركّزة بدل اللوحة الجانبية المزدحمة،
وحفظ واضح بجانب الاسم مع علامة «تغييرات غير محفوظة» وCtrl/Cmd+S وتنبيه قبل المغادرة. مع بقاء كل ما يعمل
(التشغيلات، التشغيل من خطوة، الإبراز الحي، علامات الفحص، وضع المحادثة، تنسيق الإرسال، القوالب) ودون مساس بالهواتف.

## القرار والموافقات
- **بلا تغيير في العقد.** المشغّل سجلّ مستقل على الهب (webhook §123، أو جدول هدفه سير العمل، أو «تشغيل يدوي»)،
  وكل مشغّل يبدأ التشغيل بالطريقة نفسها: من الخطوات التي لا تسبقها خطوة (`workflow-engine.ts` → `start`). لذلك
  تُرسم المشغّلات عقدًا افتراضية قبل أول الخطوات مع خط من كل مشغّل إلى كل خطوة بداية — الخطوط هي قاعدة المحرك
  مرسومة، لا وصلات محفوظة. لم يلزم حقل «أول خطوات لكل مشغّل»؛ لو أراد المالك لاحقًا أن يبدأ كل مشغّل من خطوة
  مختلفة فذلك حقل إضافي اختياري في `WorkflowTrigger` بقرار مستقل. الرسم المحفوظ (`WorkflowWrite`) لم يتغير حقلًا
  واحدًا، واختبار الوحدة يتحقق أن جسم الحفظ لا يحمل غير حقوله القديمة.
- سحب خط من مشغّل إلى خطوة في المنتصف يُرفض بتلميح يشرح السبب (المشغّل يبدأ الخطوات التي لا تسبقها خطوة)،
  وسحبه إلى مكان فارغ يضيف خطوة بداية هناك. سحب خط من خطوة إلى مكان فارغ يضيف الخطوة التالية موصولة.
- عقد المشغّلات: «تشغيل يدوي» (تظهر متى وُجدت خطوة، أو اختيرت من القائمة)، وكل webhook، وكل جدول يشغّل سير
  العمل (`schedules.list` مع `workflow_id` — موجود). شكلها مميز: حافة خلفية مستديرة، لون كهرماني، أيقونة برق.
- مشغّل يُضاف قبل أول حفظ يبقى «يُنشأ عند الحفظ» (عقدة متقطعة) ويُنشأ فور حفظ سير العمل؛ بعد الحفظ يُنشأ
  الـwebhook أو الجدول فورًا كما كان (العنوان مطلوب فورًا للصقه في ClickUp). *(مقترح — المالك يؤكد.)*
- النافذة: نقرة على الخطوة (أو Enter) تفتحها؛ النموذج نفسه (`StepPanel`) بكل حقوله و«اختبر هذه الخطوة» و«شغّل من
  هذه الخطوة» و«احذف الخطوة»، وبجانبه معاينة: المدخلات (`{{input}}` والخطوات السابقة بمخرجاتها من آخر تشغيل)
  ومخرج الخطوة في آخر تشغيل. الوصلة تفتح نافذة صغيرة، والمشغّل نافذة بإعداداته (العنوان، السر، الأحداث، سجل
  الوصول، حدث تجريبي؛ أو وقت الجدول وتشغيله/إيقافه؛ أو مدخل التشغيل اليدوي وزر «شغّل»). حدود سير العمل
  وتنبيه الفشل انتقلت إلى «إعدادات سير العمل» (الترس بجانب الاسم).
- الحفظ: زر «حفظ» بجانب الاسم مع شارة «تغييرات غير محفوظة»/«محفوظ»، وCtrl/Cmd+S. المغادرة بعمل غير محفوظ —
  رابط في الشريط الجانبي أو أي رابط داخل التطبيق، أو «رجوع» المحرر — تسأل: احفظ وغادر / تجاهل / ابقَ؛ وإغلاق
  التبويب أو إعادة تحميله يسأل سؤال المتصفح (`beforeunload`). التطبيق يستخدم `BrowserRouter` بلا مانع تنقّل،
  فالرابط يُلتقط قبل الموجّه (مستمع `click` في مرحلة الالتقاط على `window`). زر الرجوع في المتصفح لا يمكن
  إيقافه: ما تُرك يُحفظ في ذاكرة التبويب ويُعرض «استعدها» عند فتح سير العمل نفسه. لا حفظ تلقائي (كما طلب المالك).
- اتجاه RTL: إصلاح عابر — نقطتا المخرج (نجاح/فشل) كانتا ترسمان على الجهة الخطأ في العربية (الوصلة تخرج من
  اليسار والنقطة على اليمين)؛ الآن على جهة المخرج، ومثلها «+» ونقطة المشغّل.
- لوحة المفاتيح: كل عقدة وكل مشغّل وكل «+» زر يصله Tab؛ Enter يفتح؛ النوافذ Radix (حبس التركيز، Esc يغلق)؛
  قائمة الاختيار combobox بالأسهم وEnter. تقليل الحركة: نبض «يعمل» صار `motion-safe`، وظهور «+» بـ`transition-ui`.
- أيقونات Lucide جديدة في `icons.tsx`: zap, play, webhook, calendar-clock, split, timer, hand, bell, save,
  flask-conical, send. مقاس نافذة جديد `xl` في `Dialog` (إضافة فقط).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. لا مسار ولا حقل ولا حدث جديد؛ الواجهة تستعمل `schedules.list` (`workflow_id`) و`schedules.create/update/delete`
و`workflowTriggers.*` الموجودة. الهواتف (محرر قائمة الخطوات الخاص بها) لا تقرأ شيئًا تغيّر شكله.

## الملفات والتأثير
- `packages/web/src/schedules/workflows/`: `WorkflowEditor.tsx` (التخطيط الجديد، الحفظ، Ctrl+S، المشغّلات المعلّقة،
  الاستعادة)، `WorkflowCanvas.tsx` (عقد المشغّلات وخطوطها، «+»، الإسقاط على الفراغ، الحالة الفارغة، أيقونات الأنواع،
  إصلاح جهة النقاط في RTL)، جديد: `trigger-nodes.ts`، `NodePicker.tsx`، `NodeDialog.tsx`، `TriggerDialog.tsx`،
  `LeaveGuard.tsx`؛ `WorkflowTriggers.tsx` (البطاقة داخل النافذة)، `model.ts` (إضافة بعد خطوة، المشغّلات المعلّقة،
  الاستعادة)، `queries.ts` (جداول سير العمل وإنشاء المشغّل بعد الحفظ).
- `packages/web/src/ui/Dialog.tsx` + `styles/kit.css` (المقاس `xl`)، `ui/icons.tsx` + `ui/lucide.generated.ts`.
- `packages/web/src/i18n/{ar,en}.json`: `workflows.nodes.*` و`workflows.leave.*` (إضافة فقط).
- الاختبارات: `tests/workflow-editor.test.tsx` (حُدّثت للواجهة الجديدة + ٤ اختبارات جديدة)، جديد
  `tests/workflow-trigger-nodes.test.ts`؛ e2e: `e2e/workflow-canvas.ts` (مساعدات)، و٣٢/٣٢ب/٣٣/٣٤/٣٤ب/٣٤ج/٤٣
  حُدّثت، وجديد ٣٢ج (رحلة n8n كاملة مع تنبيه المغادرة) و٣٢د (سير عمل قديم يُفتح بمشغّلاته عقدًا ويعمل كما كان).
- `docs/STATUS.md`، `docs/guides/clickup-webhook-trigger.md`، `docs/guides/clickup-agent-flow.md`، ولقطات
  `packages/web/e2e/shots/workflow-*.png`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!
$ pnpm --filter @corehub/web typecheck      (نظيف)
$ pnpm i18n:check
i18n:check  OK
$ pnpm i18n:limits
i18n:limits  ar: 56 measured labels, 0 too wide, 4 cut with an ellipsis as in English
i18n:limits  en: 56 measured labels, 0 too wide, 6 cut with an ellipsis as in English
i18n:limits  OK
$ pnpm nav:check
nav:check  OK — 41 destinations, 2 pre-auth screens (login, setup), 47 terms, ar/en complete, routes for web, ios, android, desktop
$ npx vitest run --maxWorkers=2 tests/workflow-editor.test.tsx tests/workflow-trigger-nodes.test.ts tests/workflow-editor-model.test.ts tests/workflow-panel-boundary.test.tsx tests/workflow-conversation.test.tsx tests/workflow-activity.test.tsx tests/i18n.test.ts tests/lucide-icons.test.tsx
 Test Files  8 passed (8)
      Tests  64 passed (64)
$ PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test e2e/zzzzzz-workflow-editor.spec.ts e2e/zzzzzz-workflow-triggers.spec.ts e2e/zzzzzz-workflow-send.spec.ts e2e/zzzzzz-workflow-send-test.spec.ts e2e/zzzzzz-workflow-send-formatting.spec.ts e2e/zzzzzzzzzzzzzzzz-workflow-conversation.spec.ts e2e/zzzzzzzzzzzzzzzz-workflow-running.spec.ts --workers=1
  ✓  32. a two-step workflow drawn on the canvas runs, and its run is read on the canvas
  ✓  32b. a new workflow is checked before it has a name, then named, saved and run by hand
  ✓  32c. like n8n: a trigger node, steps added with its +, a step edited in its dialog, Save by the name, and leaving unsaved asks first
  ✓  32d. an old workflow opens with its triggers drawn as nodes and runs as before
  ✓  34c. Telegram formatting: the selector, the preview label, and the test send
  ✓  34b. Send test message always ends in a visible result, and the last run fills its values
  ✘  34. a Send message step sends to Telegram and posts in a conversation   (سباق في المساعد: التركيز على عقدة لوحة التشغيل قبل الرجوع للتحرير — أُصلح)
  ✓  33. a ClickUp trigger starts the workflow; a test event, a filtered event and a repeat are logged
  ✓  43. an agent step talks in the same conversation every run
  ✓  44. a run a trigger started shows on its card and in the sidebar, live
$ … playwright test e2e/zzzzzz-workflow-send.spec.ts --workers=1      (بعد الإصلاح)
  ✓  1 … 34. a Send message step sends to Telegram and posts in a conversation (3.5s)
  1 passed (12.6s)
```
الاختبارات الجديدة تفشل على الكود القديم: لا توجد فيه `workflow-add-first` ولا `workflow-trigger-node` ولا
`workflow-leave-dialog` ولا `workflow-add-step`، وCtrl+S لم يكن يحفظ. الرحلة ٣٢د تُنشئ سير العمل والمشغّل والجدول
عبر الـAPI كما يفعل أي عميل قديم، وتتحقق أن فتحه لا يغيّر الرسم المحفوظ وأن التشغيل اليدوي ينتهي «تم».
CI على #227: يُحدَّث بعد الدفع.

## المخاطر والرجوع
- زر الرجوع في المتصفح لا يُمنع (BrowserRouter)؛ المُتروك يُعرض للاستعادة في التبويب نفسه فقط (ليس بعد إعادة التحميل
  — وإعادة التحميل تسأل `beforeunload`).
- الرسم في العربية: نقاط المخرج انتقلت للجهة الصحيحة؛ من اعتاد مكانها الخاطئ سيراها في الجهة الأخرى.
- الرجوع: revert لدمج هذا الفرع؛ لا بيانات ولا عقد تغيّر، والمشغّلات المُنشأة سجلات عادية تبقى صالحة.

## التسليم والخطوة التالية
دُفع إلى `batch/2026-09-29d` (PR #227، بند في قائمته). ينتظر مراجعة المالك: قرار المشغّلات المعلّقة، وهل يريد لاحقًا
أن يبدأ كل مشغّل من خطوات مختلفة (حقل عقد إضافي اختياري بقرار DECISIONS).
