# «أرسل رسالة تجريبية» لا يصمت أبدًا، و«استخدم قيم آخر تشغيل» لا يبيّض الصفحة

المسؤول: twuijri · الفرع: fix/workflow-send-test (يُدمج في batch/2026-09-29) · الحالة: review

## المشكلة والهدف

بلاغ من مختبِر المالك على v1.1.5-preview.27 (= main ‏a472d360، بعد إصلاح §133): سير عمل «test»
في البروفايل default، خطوة «أرسل رسالة» إلى تيليجرام ‎-1003938641118. الضغط على «أرسل رسالة
تجريبية» مع النص `{{steps.agent_1.output}}` ثم مع نص ثابت `CORE_HUB_TELEGRAM_TEST_OK`: لا شيء يصل،
ولا نجاح ولا خطأ، والزر كأنه لا يفعل شيئًا. و«استخدم قيم آخر تشغيل» بيّض صفحة سير العمل كلها، وبعد
إعادة الفتح لا تظهر حقول قيم التجربة بثبات.

تتبّعتُ المسار كاملًا: `SendForm.tsx` ← `useSendTest` ← `schedules.testWorkflowSend` ←
`deliverSend` ← `telegramToken` (‏`.env` البروفايل؛ البروفايل الافتراضي = جذر `HERMES_HOME`) ←
`telegramSend` (‏`COREHUB_TELEGRAM_API_BASE`). وأعدتُ سيناريو المختبِر حرفيًا في Playwright ضد الهاب
الحقيقي مع تيليجرام مزيّف (خطوة وكيل ثم خطوة إرسال بـ `{{steps.agent_1.output}}`، حفظ، تشغيل، إعادة
فتح، آخر تشغيل، إرسال): **نجح المسار ولم يصمت**، فالصمت عند المختبِر لم يتكرر حرفيًا في بيئة الاختبار.
لكن الكود فيه ما يجعل النتيجة تختفي أو الصفحة تبيضّ أو السبب لا يُعرف، وهذه هي الأسباب المؤكدة:

1. **الزر يتعطّل بصمت.** لا وجهة، أو تيليجرام بلا معرّف، أو محادثة غير مختارة، أو نص فارغ: الزر رمادي
   فقط بلا أي كلمة. ومع متغير بلا قيمة يظهر تنبيه منفصل قد لا يُربط بالزر.
2. **الانتظار بلا كلمة وبلا حد.** مؤشر دوران صغير داخل الزر فقط، والهاب ينتظر تيليجرام حتى 30 ث، والصفحة
   تنتظر الهاب بلا حد — فلا نجاح ولا خطأ ما دام الطلب معلّقًا.
3. **جواب غير متوقع يكسر الرسم.** إن رجع شيء غير `WorkflowSendResult` (صفحة وكيل/بروكسي مثلًا) فـ
   `test.data.failures.map` يرمي أثناء الرسم.
4. **لا يوجد أي حاجز أخطاء (Error Boundary) في تطبيق الويب**: أي خطأ رسم في أي لوحة يبيّض الصفحة كلها —
   وهذا ما رآه المختبِر. أضفت الحاجز، ورسالته تعرض نص الخطأ الحقيقي، فأي تكرار سيقول ما هو.
5. **الهاب لا يكتب أي سطر سجل** لإرسال تجريبي ولا لإرسال حقيقي، فلا يمكن معرفة ما حدث عند المالك.
6. **معرّف محادثة منسوخ من نص عربي** قد يحمل علامة اتجاه غير مرئية (LRM/RLM/العزل) لا يزيلها `trim()`،
   فيرد تيليجرام «chat not found» لمعرّف يبدو صحيحًا.
7. **«fetch failed» بلا سبب**: فشل الشبكة من الحاوية لا يذكر `ECONNREFUSED`/`ENOTFOUND`.
8. **قيم التجربة لم تكن مرتبطة بالخطوة** (لا `key`)، فتنتقل بين الخطوات وتضيع عند إعادة فتح الخطوة؛
   وجواب «آخر تشغيل» بقيمة غير نصية كان يُوضع في الحقل كما هو.

## القرار والموافقات

(DECISIONS §134، مقترح — للمالك أن يؤكد)

- **الويب لا يصمت** (`SendForm.tsx`، `queries.ts`): أثناء العمل «تُرسَل الرسالة التجريبية…»؛ النجاح
  يعرض الحالة و«أُرسلت إلى» الوجهة و«معرّف الرسالة» (كل منهما في عنصر LTR مستقل فيُنسخ بلا علامات)؛
  الفشل يعرض كلمات تيليجرام نفسها أو خطأ الهاب مع رقم الطلب؛ بعد 90 ث بلا جواب يقول ذلك صراحة؛ وجواب غير
  مقروء يُقال بدل رسم لا شيء. الزر المعطّل يقول السبب بكلمات تحته (وفي تلميحه).
- **الإرسال التجريبي لا يحفظ شيئًا**: يستخدم المسودة الحالية للطلب فقط، ولا يلمس الخطوة المحفوظة
  (مثبت في Playwright بإعادة التحميل).
- **حاجز أخطاء** (`PanelBoundary.tsx` جديد) حول اللوحة الجانبية والرسم وعرض التشغيل، وحول المحرر كله في
  `WorkflowsScreen`: الخطأ يغلق الجزء وحده ويعرض رسالته وزر «اعرضه مجددًا»، واختيار خطوة أخرى يعيده.
- **قيم التجربة** تبقى لكل خطوة ما دامت الصفحة مفتوحة (تعود عند فتح الخطوة مجددًا) ولا تُحفظ في الخطوة؛
  «آخر تشغيل» يحوّل أي قيمة إلى نص ويسمّي المتغيرات التي لم يكن لها قيمة.
- **سجل الهاب**: سطر لكل وجهة في كل إرسال تجريبي (`workflow send test` / `…failed`) وفي كل إرسال حقيقي
  وتنبيه فشل (`workflow send` / `…failed` مع `workflow_run_id`)، وسطر `workflow send test refused` لرفض
  قبل الإرسال. الحقول: `workflow_id`، `node_id`، `profile`، `platform`، `chat_id` أو `session_id`،
  `status`، `message_id(s)` أو `error_code` + `error`. **لا التوكن ولا نص الرسالة** أبدًا: كل نسخة من
  التوكن تُقص من أي سبب، وفشل الشبكة يذكر سببه. مهلة تيليجرام صارت 20 ث للرسالة (`timeout`).
- **تنظيف معرّف المحادثة** في الهاب والويب من المسافات وعلامات الاتجاه غير المرئية.
- الهواتف: فحصت مسار iOS وAndroid — **لا صمت فيهما** (كل فشل يُعرض: `HubFailure(...).describe` و
  `hubCall` يلفّ كل استثناء في `HubError`). ما ينقصهما مقارنة بالويب، كمتابعة: عرض الوجهة ومعرّف
  الرسالة عند النجاح، وسبب تعطّل الزر بكلمات (غير المتغيرات)، و«قيم آخر تشغيل» (مذكورة في §133).
  تنظيف معرّف المحادثة يصلهما من الهاب دون تعديل.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

إضافي فقط: `WorkflowSendTest` يقبل حقلين اختياريين `workflow_id` (Ulid|null) و`node_id`
(string|null، حتى 64) يُستعملان في سطر السجل فقط. `pnpm contracts:compat`: لا كسر مقابل v1.1.5.
تطبيقات أقدم لا ترسلهما وتعمل كما كانت؛ الويب الجديد يرسلهما لهاب بالنسخة نفسها.

## الملفات والتأثير

- الخادم: `packages/server/src/modules/schedules/{send.ts,workflow-engine.ts,index.ts}`؛
  الاختبارات `workflow-send.test.ts`.
- العقد: `packages/contracts/openapi.yaml`؛ `docs/contracts/DECISIONS.md` §134.
- الويب: `schedules/workflows/{SendForm.tsx,queries.ts,StepPanel.tsx,WorkflowEditor.tsx,PanelBoundary.tsx}`،
  `screens/WorkflowsScreen.tsx`، `i18n/{ar,en}.json`؛ الاختبارات `tests/workflow-editor.test.tsx`،
  `tests/workflow-panel-boundary.test.tsx` (جديد)، `e2e/zzzzzz-workflow-send-test.spec.ts` (جديد).
- `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)

الاختبارات الجديدة فشلت على الكود القديم (git stash للمصدر فقط) ونجحت بعد التغيير:

```text
# الخادم، send.ts/workflow-engine.ts/index.ts القديمة:
     × says what went and where, logs each test with its step and profile, and never logs the token
     × a profile with no bot answers why at once, and the run logs its sends
     × cuts invisible marks out of a chat id, and a slow Telegram is a timeout, not a hang
      Tests  3 failed | 8 passed (11)
# الويب، schedules/screens/i18n القديمة:
     × closes only the part that failed, says why, and shows it again on request or another step
     × "Send test message" always ends in words: why it is off, the ids and where it went, or the real error (2026-09-29)
     × "Use the last run's values" with an answer it did not expect never blanks the page, and the values stay when the step is opened again
     (واختباران قديمان تغيّر جسم طلبهما بإضافة node_id/workflow_id)

# بعد التغيير:
pnpm --filter @corehub/server exec vitest run --project unit src/modules/schedules/workflow-send.test.ts
      Tests  11 passed (11)
pnpm --filter @corehub/web exec vitest run tests/workflow-editor.test.tsx tests/workflow-panel-boundary.test.tsx
      Tests  20 passed (20)
PLAYWRIGHT_CHANNEL=chrome playwright test zzzzzz-workflow-send-test zzzzzz-workflow-send --workers=1
  ✓  34b. Send test message always ends in a visible result, and the last run fills its values (5.3s)
  ✓  34. a Send message step sends to Telegram and posts in a conversation (3.0s)
PLAYWRIGHT_CHANNEL=chrome playwright test zzzzzz-workflow-editor zzzzzz-workflow-triggers --workers=1
  3 passed (27.6s)
pnpm lint            → All matched files use Prettier code style!
pnpm typecheck       → نجح
pnpm contracts:lint  → Your API description is valid; contracts:lint OK
pnpm contracts:compat → OK — no breaking change against v1.1.5
pnpm contracts:check-clients → OK — 1111 client file(s) scanned, 267 contract path(s) known.
pnpm contract:test   → Test Files 20 passed (20), Tests 428 passed (428)
pnpm i18n:check      → web: 3429 keys, ar/en in parity … OK
```

CI: يُحدَّث بعد الدفع.

## المخاطر والرجوع

- لم يتكرر صمت جهاز المختبِر حرفيًا في hub الاختبار؛ إن تكرر بعد هذا التغيير فستظهر على الشاشة إحدى
  النتائج الأربع (نجاح بمعرّف / خطأ تيليجرام / خطأ الهاب / لا جواب خلال 90 ث) وسطر في سجل الهاب يحدد
  الخطوة والوجهة والسبب. ابحث في السجل عن `workflow send test`.
- مهلة تيليجرام نزلت من 30 إلى 20 ث للرسالة الواحدة.
- الرجوع: عكس الالتزامات؛ الحقلان الجديدان اختياريان فلا يتأثر أي عميل.

## التسليم والخطوة التالية

- يُدمج في `batch/2026-09-29` مع ميزة أدوات MCP، ثم PR الدفعة إلى main بقرار المالك.
- متابعة الهواتف: الوجهة ومعرّف الرسالة عند النجاح، وسبب تعطّل الزر بكلمات.
