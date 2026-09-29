# تنسيق تيليجرام لخطوة «أرسل رسالة»: نص عادي أو HTML أو MarkdownV2

المسؤول: twuijri · الفرع: batch/2026-09-29d · الحالة: review

## المشكلة والهدف

طلب المالك (2026-09-29، ميزة عامة لكل مستخدمي كور هب): خطوة «أرسل رسالة» (§124) ترسل إلى تيليجرام
بلا `parse_mode`، فتصل `**` و`<b>` كما هي حرفيًا. المطلوب: اختيار تنسيق لكل خطوة (لا لكل بوت ولا
بروفايل)، إرساله صحيحًا، وعدم كسر أي خطوة قديمة أو تطبيق هاتف قديم.

## القرار والموافقات

(DECISIONS §137، مقترح — للمالك أن يؤكد)

- **الحقل**: `WorkflowSendTarget.formatting` نص عادي (لا enum) بثلاث قيم فقط: `plain` و`html` و
  `markdown_v2`. غيابه أو `null` = `plain`، أي كل خطوة قديمة تبقى كما هي حرفيًا ولا يُعاد كتابة أي بيانات.
  أي قيمة أخرى (`HTML`، `Markdown`، فارغ…) تُرفض عند الحفظ والتجربة (`send_formatting_unknown`)، ولا
  تصل قيمة مخزّنة إلى تيليجرام كما هي أبدًا.
- **الإرسال**: `plain` بلا حقل `parse_mode` إطلاقًا؛ `html` بـ `parse_mode: "HTML"`؛ `markdown_v2` بـ
  `parse_mode: "MarkdownV2"` (وليس Markdown القديم أبدًا). التنسيق يُطبّق بعد تعبئة المتغيرات.
- **رفض تيليجرام للتنسيق**: لا رجوع صامت إلى النص العادي ولا ادعاء نجاح. الخطوة تفشل برسالة تسمّي الوضع
  وكلام تيليجرام: `Telegram HTML formatting failed: can't parse entities: …`، و`message_id` فقط لما أُرسل
  فعلًا.
- **الرسائل الطويلة**: العادي يُقسّم كما كان تمامًا. المنسّق يُقاس على النص الذي يعدّه تيليجرام بعد تحليل
  الكيانات (الوسوم والعلامات والهروب لا تُعد، و`&lt;` حرف واحد) بحد 4000 (هامش تحت 4096)، ولا يُقسم
  داخل وسم أو كيان أو هروب أو إيموجي مخصص أو تاريخ؛ الأجزاء المفتوحة تُغلق في آخر الجزء وتُفتح في أول
  التالي (مع لغة كتلة الكود، ورابط `](url)`، واقتباس `>`، والاقتباس القابل للطي `||`/`**>`، و`**`
  فارغ يفصل `_` عن `__`)، فكل جزء صالح وحده. نص طويل لا يمكن تحليل تنسيقه يُرفض قبل إرسال أي جزء. مفتاح
  منع التكرار كما هو (التشغيل/الخطوة/الوجهة/الجزء)، فإعادة المحاولة ترسل ما لم يُرسل فقط.
- **المخرجات**: `WorkflowSendResult` يضيف `formatting` و`parse_mode` (null للعادي) و`chat_id` و
  `parts_count` لوجهة تيليجرام الأولى، و`targets` لكل وجهة (`WorkflowSendTargetResult`). السجل يضيف
  `formatting` و`parse_mode` و`parts_count`؛ التوكن ما زال مقصوصًا من كل سبب وسطر (§135).
- **تنبيه الفشل (§127) عادي دائمًا**: نصه يكتبه الهاب وقد يحوي `<` أو `*`.
- **حفظ الحقل من تطبيق قديم**: تطبيق يعرف `send` ولا يعرف `formatting` يعيد بناء وجهة تيليجرام من المعرّف
  ويحفظها بلا الحقل؛ `updateWorkflow` يعطيها تنسيق وجهة تيليجرام المحفوظة في الموضع نفسه. `null` صريح =
  عادي.
- **الويب**: «تنسيق تيليجرام» (نص عادي / HTML / MarkdownV2) تحت معرّف المحادثة مع شرح ومثال LTR؛ المعاينة
  تقول «تنسيق تيليجرام: HTML» وترسم الكلمات منسّقة من شجرة كيانات تيليجرام وحدها (لا يُحقن أي HTML في
  الصفحة، والرابط يُعرض ولا يُتبع)، وتنبّه حين يبدو التنسيق مكسورًا؛ «أرسل رسالة تجريبية» يرسل بالتنسيق
  المختار. تغيير المعرّف يحفظ التنسيق وتغيير التنسيق يحفظ المعرّف. تنبيه الفشل لا يعرض الاختيار.
- **الهواتف**: iOS وAndroid يعرضان التنسيق في خطوة الإرسال ويغيّرانه (Segmented في iOS، قائمة في
  Android) ويحفظانه عند تعديل المعرّف؛ المعاينة المنسّقة على الويب فقط (متابعة).
- مقترح للمتابعة: خيار «هروب قيم المتغيرات» — قيمة متغير فيها `<` أو `&` أو `.` غير مهربة تجعل تيليجرام
  يرفض الرسالة (يُقال بوضوح، لكن لا يُصلح تلقائيًا).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

إضافي فقط: `WorkflowSendTarget.formatting` (string|null، حتى 20)؛ `WorkflowSendResult` يضيف اختياريًا
`formatting` و`parse_mode` و`chat_id` و`parts_count` و`targets`؛ مخطط جديد `WorkflowSendTargetResult`
(`status` نص عادي). لا حقل مطلوب جديد في أي طلب. `pnpm contracts:compat`: لا كسر مقابل v1.1.5.
الهواتف القديمة: Kotlin بـ `ignoreUnknownKeys = true` وSwift Codable يتجاهل المفاتيح المجهولة، فلا تتعطل
بالحقول الجديدة؛ والهاب يحفظ `formatting` حين يحفظ هاتف قديم بدونه.

## الملفات والتأثير

- الخادم: `packages/server/src/modules/schedules/telegram-format.ts` (جديد: القيم، `parse_mode`،
  التقسيم الواعي بالتنسيق)، `send.ts`، `workflow-engine.ts`، `service.ts` (`keepFormatting`)، `schema.ts`؛
  `testing/fake-telegram.ts` (جديد: تيليجرام مزيّف يحلل HTML وMarkdownV2 كتيليجرام ويرفض بكلماته)؛
  الاختبارات `telegram-format.test.ts` و`workflow-send-formatting.test.ts` (جديدان)، `workflow-send.test.ts`،
  `tests/contract/workflow-editor.contract.test.ts`.
- العقد: `packages/contracts/openapi.yaml`؛ `docs/contracts/DECISIONS.md` §137.
- الويب: `schedules/workflows/{SendForm.tsx,model.ts,telegram-preview.ts}`، `i18n/{ar,en}.json`؛
  الاختبارات `tests/telegram-preview.test.ts` (جديد)، `tests/workflow-editor.test.tsx`،
  `e2e/zzzzzz-workflow-send-formatting.spec.ts` (جديد) و`e2e/hub.ts` (يستخدم التيليجرام المزيّف المشترك)،
  لقطة `e2e/shots/workflow-send-formatting-html.png`.
- iOS: `WorkflowEditRules.swift`، `WorkflowSendForm.swift`، `WorkflowEditor.swift`، `i18n/workflow_editor.*.json`،
  `CoreHubTests/WorkflowEditorTests.swift`.
- Android: `WorkflowFlow.kt`، `WorkflowFlowUi.kt`، `i18n/workflow_tools.*.json`، `WorkflowFlowTest.kt`.
- `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)

اختبارات الخادم الجديدة فشلت على الكود القديم (`send.ts`/`workflow-engine.ts`/`service.ts`/`schema.ts`
من origin/main) ونجحت بعد التغيير:

```text
$ vitest run --project unit src/modules/schedules/workflow-send-formatting.test.ts   # الكود القديم
     × plain sends no parse_mode at all, and the tags arrive as written
     × an older step without the field stays plain: no parse_mode, nothing rewritten
     × HTML arrives bold with its link, after the variables are filled
     × MarkdownV2 arrives formatted, never as the legacy Markdown
     × markup Telegram refuses fails the step in words naming the mode, with no message id
     × a long HTML message goes in valid parts, bold closed and reopened; a rerun sends only what did not go
     × refuses a formatting it does not know when saved and when tested, and keeps it when an older app saves
     × Send test message uses the chosen formatting, and the log says it without the token
      Tests  8 failed | 1 passed (9)

$ vitest run --project unit src/modules/schedules/        # بعد التغيير
 Test Files  14 passed | 1 skipped (15)
      Tests  159 passed | 3 skipped (162)

$ pnpm contract:test
 Test Files  20 passed (20)
      Tests  429 passed (429)

$ vitest run tests/workflow-editor.test.tsx tests/telegram-preview.test.ts tests/workflow-step-output.test.ts   # الويب
      Tests  24 passed (24)
      Tests  2 passed (2)

$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzz-workflow-send-formatting.spec.ts \
    e2e/zzzzzz-workflow-send-test.spec.ts e2e/zzzzzz-workflow-send.spec.ts --workers=1
  ✓  1 … 34c. Telegram formatting: the selector, the preview label, and the test send (2.6s)
  ✓  2 … 34b. Send test message always ends in a visible result, and the last run fills its values (3.8s)
  ✓  3 … 34. a Send message step sends to Telegram and posts in a conversation (3.4s)
  3 passed (18.9s)

$ pnpm lint                 → All matched files use Prettier code style!
$ pnpm typecheck            → exit 0
$ pnpm contracts:lint       → contracts:lint  OK
$ pnpm contracts:compat     → contracts:compat  OK — no breaking change against v1.1.5
$ pnpm contracts:check-clients → check-clients  OK — 1132 client file(s) scanned, 268 contract path(s) known.
$ pnpm i18n:check           → i18n:check  OK
$ pnpm nav:check            → nav:check  OK — 41 destinations, …
```

لم تُشغَّل محليًا: اختبارات iOS وAndroid (لا Xcode ولا Java على الجهاز) ولا المجموعات الكاملة — تعمل على
GitHub CI.

CI على PR ‎#227: أول تشغيل فشل في فحص واحد للويب (`tests/theme-colors.test.ts`: الصنف `border-s-2` ليس
لونًا من الثيم في حدّ الاقتباس بالمعاينة)، أُصلح إلى `border-s border-line-strong`. بعدها كل الفحوص خضراء على
الرأس `88663291`:

```text
pass | Android build, unit tests, lint | 10m2s
pass | Build and test on the iOS simulator | 5m57s
pass | Lint, typecheck, contracts, client tests, build | 8m2s
pass | Server unit tests (shard 1/3) | 4m58s
pass | Server unit tests (shard 2/3) | 5m22s
pass | Server unit tests (shard 3/3) | 4m22s
pass | Web smoke journeys (Playwright against the real hub) | 11m10s
pass | Real Hermes suites (floor) | 8m29s
pass | Real Hermes suites (pinned) | 6m58s
pass | Docker image builds and answers /health | 4m17s
pass | Desktop app smoke (Electron under Xvfb against the real hub) | 1m32s
pass | db:generate + db:migrate (SQLite and PostgreSQL) | 1m16s
pass | Translations fit their labels (measured widths) | 41s
```

## المخاطر والرجوع

- الخطوات القديمة لا تتغير: بلا `parse_mode` وبالتقسيم نفسه، وهذا مثبت باختبار. الخطر في المنسّق فقط، وهو
  اختيار صريح من الشخص.
- مُحلِّل التقسيم مكتوب من وثائق Bot API؛ تيليجرام الحقيقي قد يختلف في حالات نادرة (مثل `||` بعد مسافة في
  اقتباس قابل للطي). النتيجة حينها فشل واضح بكلمات تيليجرام لا إرسال خاطئ صامت.
- الرجوع: revert للـ PR؛ الحقل اختياري فالبيانات المحفوظة به تُقرأ كنص عادي في الهاب القديم.

## التسليم والخطوة التالية

PR واحد «Batch 2026-09-29d». للمالك: تأكيد §137، وتجربة `<b>اختبار</b>` بـ HTML على بوت حقيقي. متابعة:
خيار هروب قيم المتغيرات، ومعاينة منسّقة على الهواتف.
