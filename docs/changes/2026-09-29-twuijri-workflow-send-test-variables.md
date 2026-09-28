# «أرسل رسالة تجريبية» يملأ متغيرات الخطوة قبل الإرسال

المسؤول: twuijri · الفرع: batch/2026-09-28c · الحالة: review

## المشكلة والهدف

بلاغ من مختبِر المالك، وتأكّد في الكود: زر «أرسل رسالة تجريبية» في خطوة «أرسل رسالة» يرسل نص
الخطوة كما هو بمتغيراته، فوصل تيليجرام النص `{{steps.analysis.output}}` حرفيًا. السبب: الويب
(`SendForm.tsx`) يرسل `text: node.input` كما هو، والخادم (`schedules.testWorkflowSend`) يرسل `text`
بلا تعبئة. التشغيل الحقيقي يملأ المتغيرات صحيحًا ولا يُغيَّر.

المطلوب: كشف المتغيرات غير المحلولة (`{{input}}`، `{{trigger.*}}`، `{{steps.<id>.output}}`) قبل
الإرسال، منع الإرسال ما دام أحدها بلا قيمة، معاينة للنص النهائي، إدخال قيم تجريبية لكل متغير مع
تعبئتها من آخر تشغيل، والخادم يملأ بالكود نفسه الذي يستخدمه التشغيل ويرفض برسالة واضحة إن بقي
متغير.

## القرار والموافقات

(DECISIONS §133، مقترح — للمالك أن يؤكد)

- **الخادم** (`index.ts`، `sample.ts` جديد، `expr.ts`): `WorkflowSendTest` يقبل حقلين اختياريين:
  `values` (قيمة لكل متغير بمساره كما كُتب) و`workflow_run_id` (تشغيل تُؤخذ منه القيم: حدثه،
  مدخله، ومخرجات خطواته الناجحة؛ و`values` تغلب عليه). إن كان في النص متغير: تُبنى السياقات في
  `Context` واحد ويُملأ النص بـ `render` من `expr.ts` — الدالة نفسها التي يستخدمها التشغيل — وإن
  بقي متغير بلا قيمة يُرفض بـ `400 bad_request` و`details.reason: template_unresolved`
  و`details.unresolved` بأسماء المتغيرات. نص بلا متغيرات يُرسل كما هو تمامًا كما كان.
- **عميل قديم يرسل نصًا فيه متغيرات**: يحصل على الرفض الواضح بدل إرسال `{{…}}` حرفيًا (القرار
  المفضّل في الطلب). هذا ليس كسرًا للتوافق: الطلب نفسه ما زال مقبولًا، والذي تغيّر أن الهاب لم
  يعد يرسل نصًا خاطئًا.
- `setPath` في `sample.ts` يكتب القيم فقط تحت `input` و`trigger` و`steps`، ويرفض `__proto__`
  و`constructor` و`prototype`، ويعمل على نسخة فلا يمسّ بيانات التشغيل.
- **«اختبر هذه الخطوة»** (`WorkflowStepTest`) يقبل الحقلين نفسيهما، ونتيجته تضيف `values` (ما
  يقرؤه كل متغير في العيّنة) فقط حين يكون في نص الخطوة متغير — فالإجابة بلا متغيرات لم تتغيّر.
- **الويب** (`SendForm.tsx`، `template.ts` جديد): قسم «قيم التجربة» بحقل لكل متغير (مرة واحدة لكل
  مسار، بنمط الهاب نفسه)، زر «استخدم قيم آخر تشغيل» (يسأل «اختبر هذه الخطوة» مع
  `workflow_run_id` لأحدث تشغيل ويملأ الحقول، والمتغير الذي لم يكن له قيمة يبقى فارغًا للشخص)،
  أو ملاحظة «لا يوجد تشغيل بعد» مع إمكانية الكتابة يدويًا. «معاينة ما سيُرسل» تعرض النص بالقيم.
  زر الإرسال معطّل ما دام متغير بلا قيمة، مع تنبيه يسمّيها. يُرسل النص كما كُتب مع `values`،
  والهاب هو من يملأ. رفض الهاب يُعرض بأسماء المتغيرات.
- **iOS وAndroid** (كان لديهما زر الإرسال التجريبي): حقل لكل متغير، معاينة، منع الإرسال حتى تمتلئ
  كلها، ويُرسل النص مملوءًا (بلا حقول عقد جديدة، فيعمل مع هاب أقدم أيضًا). «قيم آخر تشغيل» على
  الهاتف متابعة لاحقة.
- «شغّل الخطوات السابقة أولًا»: غير منفّذ كزر جديد؛ «شغّل من هنا» الموجود يصنع تشغيلًا، ثم «استخدم
  قيم آخر تشغيل» يأخذ مخرجاته.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

إضافي فقط (`pnpm contracts:compat` نظيف):
- `WorkflowSendTest`: `values` و`workflow_run_id` اختياريان، ووصف للرفض `template_unresolved`.
- `WorkflowStepTest`: `values` و`workflow_run_id` اختياريان.
- `WorkflowStepTestResult`: `values` اختياري.
- مخطط جديد `WorkflowSampleValues`.
- العملاء الأصليون (Kotlin/Swift) يُولَّدون في CI؛ لا ملفات مولّدة في المستودع.

## الملفات والتأثير

- الخادم: `packages/server/src/modules/schedules/{index.ts,expr.ts,sample.ts}`،
  `packages/server/src/i18n/{ar,en}.json` (`errors.template_unresolved`).
- الاختبارات: `sample.test.ts` (جديد)، `expr.test.ts`، `workflow-send.test.ts`.
- العقد: `packages/contracts/openapi.yaml`؛ `docs/contracts/DECISIONS.md` §133.
- الويب: `schedules/workflows/{SendForm.tsx,template.ts,queries.ts,StepPanel.tsx,WorkflowEditor.tsx}`،
  `i18n/{ar,en}.json`، `tests/workflow-editor.test.tsx`، `tests/workflow-template.test.ts` (جديد)،
  `e2e/zzzzzz-workflow-send.spec.ts` (كان يثبّت الخطأ نفسه: توقّع وصول `التقرير: {{input}}`).
- Android: `WorkflowFlow.kt`، `WorkflowFlowUi.kt`، `i18n/workflow_tools.{ar,en}.json`،
  `parity/WorkflowFlowTest.kt`.
- iOS: `WorkflowEditRules.swift`، `WorkflowEditor.swift`، `i18n/workflow_editor.{ar,en}.json`،
  `CoreHubTests/WorkflowEditorTests.swift`.
- `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)

الاختبارات الجديدة فشلت على الكود القديم ونجحت بعد التغيير:

```text
# الخادم، index.ts القديم (git stash):
     × send-test fills the step's variables like the run does, and refuses while any has no value
      Tests  1 failed | 7 passed (8)
# الويب، SendForm/StepPanel/WorkflowEditor/queries القديمة (git stash):
     × a Send message test with variables: values from the last run or typed, a preview, and no send until each has one (§124)
      Tests  1 failed | 16 passed (17)

# بعد التغيير:
$ vitest run tests/unit/i18n-languages.test.ts src/modules/schedules/      (server)
 Test Files  13 passed | 1 skipped (14)
      Tests  136 passed | 3 skipped (139)
$ pnpm contract:test
 Test Files  20 passed (20)
      Tests  428 passed (428)
$ vitest run tests/workflow-editor.test.tsx tests/workflow-template.test.ts   (web)
      Tests  19 passed (19)
$ pnpm build   → exit 0
$ PLAYWRIGHT_CHANNEL=chrome playwright test --workers=1 e2e/zzzzzz-workflow-send.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-workflow-send.spec.ts:47:1 › 34. a Send message step sends to Telegram and posts in a conversation (3.3s)
  1 passed (12.4s)
$ pnpm contracts:lint → OK ; pnpm contracts:compat
contracts:compat  OK — no breaking change against v1.1.5
$ pnpm contracts:check-clients
check-clients  OK — 1104 client file(s) scanned, 267 contract path(s) known.
$ pnpm typecheck → exit 0 ; pnpm lint → exit 0 (eslint + prettier)
$ pnpm i18n:check
i18n:check  ios: 2710 keys, ar/en in parity
i18n:check  android: 2570 keys, ar/en in parity
i18n:check  OK
```

خلال خطوة سابقة ظهر فشل في `workflow-assembly.test.ts` لأن نتيجة «اختبر هذه الخطوة» صارت تضيف
`values: {}` دائمًا؛ صار الحقل يُضاف فقط حين في النص متغير، وعاد الاختبار ناجحًا دون تعديله.

لقطة Playwright `workflow-send-sample-ar-light` رُوجعت: الحقل مملوء من آخر تشغيل، والمعاينة
بالعربية «التقرير: كل المهام تمت».

Android وiOS لم يُبنيا محليًا (لا JDK ولا Xcode على هذا الجهاز)؛ البناء واختباراتهما على GitHub CI.

## المخاطر والرجوع

- عميل قديم (هاتف بنسخة سابقة) يضغط الإرسال التجريبي لنص فيه متغيرات سيرى رسالة الرفض بدل وصول
  `{{…}}`؛ هذا مقصود. نص بلا متغيرات لم يتغيّر.
- التشغيل لم يتغيّر: `render` كما هو، والمتغير الفارغ في التشغيل ما زال يُقرأ فارغًا (§123).
- الرجوع: التراجع عن الكومِت؛ الحقول الجديدة اختيارية فلا يتأثر أي عميل.

## التسليم والخطوة التالية

- ضمن دفعة `batch/2026-09-28c` (PR #220).
- متابعة: «استخدم قيم آخر تشغيل» على iOS/Android (يحتاج الحقول المولّدة الجديدة)، وزر «شغّل حتى
  هنا» يشغّل الخطوات السابقة فقط دون إرسال.
