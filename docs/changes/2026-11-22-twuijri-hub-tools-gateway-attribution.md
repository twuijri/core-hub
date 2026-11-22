# أدوات الهب ترفض طلبات محادثة الهب نفسها بعد ربطها ببوابة هرمز
المسؤول: twuijri · الفرع: fix/hub-tools-gateway-attribution · الحالة: review

## المشكلة والهدف
- **العطل (مركز المالك على خط 1.1.10، هرمز v0.22.5):**
  - محادثة ويب جديدة في الهب، وهرمز استدعى `mcp__corehub__devices_list` مرتين.
  - المرتين انرفض الطلب بـ `hub_tools_run_ambiguous` («several people have conversations running…»).
  - المالك وحده يستخدم الهب، وما كان أحد يكلّم البوت وقتها.
  - كل أدوات الهب متأثرة بنفس الطريقة، مو بس الأجهزة.
- **السبب (تأكدت منه بتشغيل حقيقي، مو تخمين):**
  - من #265 صارت محادثات الهب تشتغل **داخل** بوابة هرمز (اتصال `/api/ws`).
  - داخل البوابة، محادثة الهب دورة مثل دورة تيليجرام بالضبط، وتمر بنفس `_handle_message_with_agent`.
  - فخطّاف الهب (`hooks/corehub/handler.py`) يرسل `turn_started` لمحادثة الهب نفسها.
  - الهب ما يعرف إنها محادثته: المنصة `local` والمرسل `uid:1000`، وهذا مو حساب مربوط.
  - فيفتح «دورة قناة لا تمثّل أحدًا» (`hub_tools_sender_not_linked`).
  - المحادثة نفسها تعلن عن استدعاء الأداة، فيصير قدام `decideGateway` مالكان: صاحب المحادثة، و«لا أحد».
  - النتيجة: كل استدعاء ينرفض كـ «غامض».
- **الاحتمالات الثانية اللي استبعدتها بالدليل:**
  - **عقد قناة قديم:** لا. العقد انفتح من نفس الدورة قبل الاستدعاء بـ 0.8 ثانية، وانقفل بـ `turn_ended` بعدها.
  - **الإعلان (`tool.started`) ما وصل:** لا. عقد التشغيل كان فيه `pending: 1` لحظة الرفض، والإعلان وصل عن طريق جسر `tool_call`.
  - **ترويسة `X-Corehub-Origin`:** لا. وصلت `gateway` صحيحة.
- **الهدف:**
  - طلبات محادثة الهب داخل البوابة تنحسب لصاحبها.
  - قاعدة الأمان تبقى زي ما هي: لو فيه دورة قناة لشخص غير مربوط جنب تشغيل معلن، الطلب ينرفض ولا يتصرف الهب باسم شخص غلط.

## القرار والموافقات
- **الطلب:** المالك طلب الإصلاح في هذه المهمة: «Fix a Core Hub server bug… narrowest safe change». ما فيه دفع ولا PR إلا بموافقته.
- **الطريقة (أضيق تغيير آمن، في الخادم بس، بدون ما نغيّر ملفات الخطّاف):**
  - عقد التشغيل (run lease) صار يحفظ معرّف جلسة هرمز اللي أعطاه `session.create` (`agentSessionId`).
  - إذا وصل `turn_started` بمعرّف جلسة تخص تشغيلًا حيًّا للهب، الهب ما يفتح عقد قناة، والاستدعاء ينحسب للتشغيل بالقاعدة الموجودة (الإعلان).
  - أي دورة `local` لجلسة ثانية تبقى «لا أحد» مثل قبل، سواء كانت عميل ثاني متصل بالبوابة أو دورة يبدأها هرمز بعد ما ينتهي التشغيل.
  - تيليجرام وواتساب ما تغيّر عليهم شيء.
- **ليش ما عدّلنا الخطّاف (`handler.py`):**
  - تعديله يعيد كتابة الملف ويعيد تشغيل البوابة عند كل مركز يترقى.
  - تجاهل `local` كله بالخطّاف يفتح ثغرة: عميل `local` غريب يتصل بالبوابة ممكن يستعير تشغيل الهب المعلن.
- **التشخيص:** إذا ما مثّل الاستدعاء أحدًا، الهب يكتب سطر `info` فيه عدد العقود الحية وأنواعها لهذا البروفايل:
  - التشغيلات، والمعلن منها، وعقود القنوات، والقنوات اللي ما تمثّل أحدًا.
  - لكل عقد: النوع، ومعرّف التشغيل، ومعرّف الشخص، والمنصة، والسبب، والعمر.
  - ما يكتب أي رمز ولا معرّف مرسل ولا نص رسالة.
- **التوثيق:** إضافة على DECISIONS §79 بتاريخ 2026-11-22.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- لا شيء. الإضافة في `docs/contracts/DECISIONS.md` نص بس.

## الملفات والتأثير
- **`packages/server/src/modules/agents/hub-tools/leases.ts`:**
  - `Lease` فيه حقلين جديدين: `agentSessionId` و`platform`، والثاني للسجل بس.
  - `open()` يقبل `agentSessionId` اختياري، و`openChannel()` يقبل `platform` اختياري.
  - دالة جديدة `runOfAgentSession()`، ودالة جديدة `describe()` تعطي ملخص العقود للسجل.
  - قواعد `decide`/`decideGateway` ما تغيّرت.
- **`.../hub-tools/service.ts`:**
  - `channelEvent`: دورة جلسة تشغيل حي ما يفتح لها عقد قناة، ويكتب عنها سطر `debug`.
  - `call`: يكتب سطر التشخيص إذا ما مثّل الاستدعاء أحدًا.
- **`.../agents/runner.ts`:** يمرّر `live.session.id` (معرّف جلسة هرمز) للعقد.
- **الاختبارات:**
  - `leases.test.ts`: حالتين جديدتين، `runOfAgentSession` و`describe`. الثانية تتأكد إن رقم المرسل ما يطلع في السجل.
  - `channel-identity.routes.test.ts`: حالة جديدة تمشي عبر المسارات الحقيقية:
    - دورة `local` لجلسة التشغيل ما تفتح عقد، والاستدعاء ينجح.
    - غريب تيليجرام جنبه: `hub_tools_run_ambiguous`، مع سطر التشخيص.
    - `local` لجلسة ثانية: يبقى مرفوض.
    - بعد ما ينتهي التشغيل: دورة نفس الجلسة صارت «لا أحد».
  - `runner.test.ts`: حالة جديدة تتأكد إن العقد يحمل معرّف جلسة الوكيل.
  - `hub-tools-gateway.real.test.ts` (جديد): بوابة الصورة الحقيقية `hermes gateway run` والخطّاف محمّل فيها، ومحادثة هب متصلة بها، ونموذج وهمي يستدعي `mcp__corehub__tasks_list`. يتأكد إن الاستدعاء نجح باسم صاحب المحادثة وفي جلسته.
    - على هرمز أقدم من v0.22.2 يتأكد إن البوابة ما تُربط، ويرجع.
    - هذا أول اختبار حقيقي يجمع البوابة والخطّاف وتشغيل الهب مع بعض.

## الفحوص (الأوامر ونواتجها الفعلية)
- **إعادة إنتاج العطل بهرمز حقيقي (v0.22.5 نفس اللي تثبّته الصورة):**
  - المكان: venv تحت `~/.cache/hubattr-dev`، و`HOME` و`DATA_DIR` معزولين، وبوابة مُدارة على منفذ 18642 (تعديل محلي مؤقت للمنفذ، رجّعته).
  - نموذج OpenAI-compatible وهمي، وأدوات الهب مفعّلة ومعها مجموعة الأجهزة.
  - **قبل الإصلاح (سطور سجل مؤقتة، انحذفت):**
    ```
    REPRO lease opened   agentSession=local-7ab5f7ab…  liveId=local-7ab5f7ab…
    REPRO channel event  {"event":"turn_started","platform":"local","sender_id":"uid:1000",
                          "session_id":"local-7ab5f7ab…","chat_type":"dm"}  live=[run]
    REPRO refused        origin=gateway reason=hub_tools_run_ambiguous
                         live=[run pending=1 user=owner, channel user=null refusal=hub_tools_sender_not_linked]
    ```
    وبطاقة الأدوات: `devices.list ok=false error_code=hub_tools_run_ambiguous`.
  - **بعد الإصلاح (نفس المكان):**
    - النموذج استلم `{"result": "{\"devices\":[]}"}`.
    - البطاقة: `devices.list ok=True user_id=<owner> session_id=<session>`.
  - **غريب تيليجرام جنب محادثة الهب (أرسلت `turn_started` من نقطة الخطّاف بمفتاح البروفايل):** ما زال يُرفض، وطلع سطر التشخيص:
    ```
    "reason":"hub_tools_run_ambiguous","live":{"runs":1,"announced":1,"channels":1,"channels_for_nobody":1,
     "leases":[{"kind":"channel","platform":"telegram","refusal":"hub_tools_sender_not_linked",…},
               {"kind":"run","run_id":"01M80JAQ…","user_id":"01M80J14…","pending":1,…}]}
    ```
```
$ pnpm exec vitest run --maxWorkers=2 src/modules/agents/hub-tools src/modules/agents/runner.test.ts src/modules/agents/runner-gateway.test.ts src/modules/agents/runner-stream.test.ts
 Test Files  7 passed | 3 skipped (10)
      Tests  85 passed | 4 skipped (89)

$ COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:1.1.9 pnpm exec vitest run --maxWorkers=1 src/modules/agents/hub-tools/hub-tools-gateway.real.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
# ونفس الاختبار مع تعطيل الإصلاح مؤقتًا:
 × acts for the person whose chat it is, though the hook reports the chat's turn too
 AssertionError: expected '<untrusted_tool_result source="mcp__c…' not to contain 'hub_tools_'

$ COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:1.1.9 pnpm exec vitest run --maxWorkers=1 src/modules/agents/hub-tools/hub-tools.real.test.ts src/modules/agents/hub-tools/channel-identity.real.test.ts
 Test Files  2 passed (2)
      Tests  3 passed (3)

$ pnpm typecheck          # exit 0
$ pnpm lint               # exit 0 — All matched files use Prettier code style!
```
- **اختبار المسارات الجديد مع تعطيل الإصلاح مؤقتًا:** فشل بـ `expected [ 'run', 'channel' ] to deeply equal [ 'run' ]`.
- **صورة 1.1.9:** فيها هرمز v0.22.5 نفسه. الاختبار الحقيقي يستخدم بوابتها وخطّاف الفرع، والهب من كود الفرع.
- **ما شغّلته:** الحزمة الكاملة تشتغل على CI بس، حسب قاعدة الفريق.

## المخاطر والرجوع
- **تطابق المعرّف:**
  - يعتمد على إن معرّف الجلسة في الخطّاف (`session_entry.session_id`) هو نفسه اللي أعطاه `session.create` أو `session.resume` للهب.
  - هذا اللي شفته على v0.22.5، والاستكمال يرجع نفس المعرّف (`hermes-gateway-attach.real.test.ts`).
  - لو غيّر هرمز معرّف الجلسة في نص الدورة (ضغط ينشئ جلسة جديدة مثلًا)، يرجع السلوك القديم ويُرفض الطلب. الفشل آمن، ما يتصرف باسم أحد، والسجل الجديد يبيّن السبب.
- **دورة يبدأها هرمز بنفسه بعد نهاية التشغيل** (تنبيه عملية في الخلفية مثلًا): تبقى «لا أحد» مثل قبل.
- **الأمان:**
  - معرّف الجلسة يجي من هرمز، مو من المرسل، والخطّاف موثّق بمفتاح البروفايل.
  - حتى لو تطابق المعرّف غلط، الأثر الوحيد إن الهب ما يفتح عقد قناة. والاستدعاء ما ينحسب لتشغيل إلا إذا هذا التشغيل أعلن عنه.
- **الرجوع:** نرجع الالتزام. يرجع العطل، لكن ما فيه بيانات ولا ترحيل ولا عقد تغيّر.

## التسليم والخطوة التالية
- **الحالة:** الالتزام على الفرع محليًا وما انرفع. ننتظر موافقة المالك على الدفع وفتح PR إلى `main`.
- **بعد الدمج:** يُدمج الفرع في `test` لصورة التست، والمالك يجرّب `devices.list` من محادثة ويب جديدة على مركزه.
- **ملاحظة للمالك:** الاختبار الحقيقي الجديد ينضم تلقائيًا لـ `hermes-real-suites.yml`، لأن الأمر يجمع كل ملفات `*.real.test.ts`.
