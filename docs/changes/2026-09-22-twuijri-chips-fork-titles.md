# صف الوكلاء للمثبَّت فقط، وتغيير الوكيل تفريع، والجلسات تسمّي نفسها
المسؤول: twuijri · الفرع: feat/chips-fork-titles · الحالة: review

## المشكلة والهدف

أربعة أشياء في سطح المحادثة طلبها المالك أكثر من مرة:

1. **صف الرقائق فوق المحرِّر يعرض وكلاء غير مثبَّتين.** قرار المالك صريح: وكيل غير
   مثبَّت لا مكان له فوق المحرِّر؛ يظهر هناك لحظة تثبيته. الاكتشاف والتثبيت مكانهما
   «مدير الوكلاء»، وعلامة «+» في نهاية الصف تفتحه أصلًا.
2. **الصف يخصّ محادثة فارغة.** بعد أول رسالة يصبح سؤالًا أُجيب عنه؛ الجلسة المفتوحة
   لها وكيلها، ويكفي أن يُذكر بهدوء في ترويسة المحادثة.
3. **تغيير الوكيل في منتصف محادثة** كان ينقل الشخص إلى محادثة جديدة فارغة ويضيّع
   السياق كلّه. الصحيح: تفريع الجلسة إلى وكيل آخر مع نقل النص الكامل.
4. **كل جلسة اسمها «محادثة جديدة»**، فالقائمة الجانبية بلا قيمة. الجلسة يجب أن تسمّي
   نفسها بعد أول ردّ.

## القرار والموافقات

- الصف مبنيّ على `agents.list` مُرشَّحًا إلى المثبَّت فقط، فالوكيل المدمج الجديد
  (`direct`) الذي يضيفه فرع موازٍ يظهر دون أي عمل إضافي هنا. «مثبَّت» قائمة موجبة من
  ثلاث حالات: `available` و`updating` و`limited`؛ أمّا `not_installed` و`installing`
  و`error` فكلها تعني للشخص الشيء نفسه: لا شيء هنا يُحادَث.
- **تغيير النموذج ليس تفريعًا**: منتقي النموذج في المحرِّر يبقى على `sessions.update`.
  تغيير الوكيل تفريع، وسطر واحد بالعربية والإنجليزية يشرح الفرق في القائمة نفسها.
- عنوان كتبه الشخص بيده لا يُستبدل أبدًا: يُعلَّم الصف في قاعدة البيانات
  (`title_set_by_user`)، و«أعد التسمية تلقائيًا» تمسح العلامة وتطلب عنوانًا جديدًا.
  لم يُضَف حقل إلى `Session` لأن أي عميل لن يعرضه، والسؤال الوحيد الذي يطرحه العميل
  فعلًا («هل لي أن أطلب عنوانًا جديدًا؟») جوابه إرسال `title: null`.
- تسمية الجلسة **نداء واحد رخيص خارج أي تشغيل**: لا صف `Run` ولا وظيفة ولا أحداث
  تشغيل على `/rt/sessions`، ويقع بعد انتهاء التشغيل لا داخله. عند تعذّره يُستعمل أول
  رسالة من الشخص مقصوصة على حدّ كلمة.
- لم يُطلب من المالك شيء خارج ما ورد أعلاه؛ لا دمج ولا نشر ولا صورة تست في هذه المهمة.
- غرفة نظيفة (ADR 0004 كما عدّله ADR 0012): لم يُفتح مصدر Hermes Studio / Ekko Studio.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

إضافي فقط؛ أي عميل قائم يعمل دون تعديل:

- `SessionForkRequest` اكتسب `agent_id` و`model` و`provider` (كلها اختيارية). تفريع
  بلا `agent_id` سلوكه كما كان حرفيًا.
- `sessions.fork` اكتسب `422` (`AgentUnavailable`) لوكيل غير مثبَّت، ويبقى `404`
  لوكيل لا وجود له — كلاهما بمغلَّف الخطأ `{ error, code, details }`.
- `SessionPatch.title` وُثِّق: نص غير فارغ عنوان يدوي لا يُستبدل، و`null` يعيد التسمية
  إلى المركز ويصل الاسم الجديد بحدث `session.updated`.
- قرار مرقَّم جديد `§26` (صار §92 في ٢٠٢٦-٠٩-٢٧: كان الرقم مكررًا) في `docs/contracts/DECISIONS.md` بشقّيه (التفريع، والتسمية).
- لا حدث جديد ولا مسار جديد.

## الملفات والتأثير

**العقد والقرارات**
- `packages/contracts/openapi.yaml` — الحقول الثلاثة، الرد `422`، وتوثيق `title`.
- `docs/contracts/DECISIONS.md` — §26 (الآن §92).

**الخادم**
- `modules/sessions/titles.ts` (جديد) — دوال صافية: صياغة السؤال، تنظيف جواب النموذج
  (اقتباسات، عناوين Markdown، نقطة أخيرة، فقرة بدل عنوان)، والقصّ على حدّ كلمة.
- `modules/sessions/naming.ts` (جديد) — `SessionNamer`: مرة واحدة لكل جلسة، بعد
  التشغيل لا داخله، ولا يعلو على عنوان كتبه شخص (يُعاد قراءة الصف قبل الكتابة).
- `modules/sessions/engine.ts` — جدولة التسمية بعد `run.completed` الناجح،
  و`settledAll()` ينتظرها كي لا يُقطع عنوان عند الإغلاق.
- `modules/sessions/service.ts` — `fork` صار غير متزامن ويقبل الوكيل والنموذج والمزوّد
  ويرفض غير المثبَّت قبل أي كتابة؛ و`update` صار يملك قاعدة ملكية العنوان.
- `modules/sessions/routes.ts` — مخطط `fork` الموسَّع.
- `modules/sessions/schema.ts` + `store.ts` + `drizzle/0003_session_title_owner.sql`
  — العمود `title_set_by_user`.
- `modules/sessions/ports.ts` + `unavailable.ts` — منفذ `AgentRunner.ask` الاختياري.
- `modules/agents/ports.ts` + `runner.ts` — تنفيذ `ask`: جلسة وكيل منفصلة تُغلق فورًا،
  لا تدخل خريطة الجلسات الحيّة، ولا تجعل `busy` صحيحًا، ومحدودة بمهلة.

**العميل**
- `chat/AgentChips.tsx` — `installedAgents` / `enabledAgents`، لا خيار معطَّل في الصف.
- `chat/SessionAgent.tsx` (جديد) — ضابط الوكيل في الترويسة، والتفريع.
- `chat/ChatScreen.tsx` — الصف لمحادثة فارغة فقط، والضابط في الترويسة.
- `screens/NewChatScreen.tsx` — «لا وكيل مثبَّت» بدل «لا وكيل جاهز».
- `hub/queries.ts` — `useForkSession`.
- `sessions/useSessionList.ts` (جديد) — القائمة الجانبية تسمع
  `session.created/updated/deleted` على `/rt/sessions`، وإلا لبقي الاسم الجديد غير
  مرئي حتى يحدث شيء آخر يعيد الجلب.
- `sessions/SessionList.tsx` — «إعادة التسمية» و«أعد التسمية تلقائيًا» في قائمة الصف
  (زر «المزيد» المرئي، ونفس البندين في قائمة الزر الأيمن).
- `ui/PromptDialog.tsx` (جديد) + `ui/index.ts` + `ui/icons.tsx` — `usePrompt` بديلًا
  عن `window.prompt` المحظور، وأيقونة «المزيد».
- `i18n/{ar,en}.json` — المفاتيح الجديدة بالعربية والإنجليزية.

**الاختبارات واللقطات**
- خادم: `sessions/naming.test.ts` (جديد)، إضافتان في `sessions-api.test.ts`،
  وتعديل تسلسلات الأحداث في `sessions-run.test.ts` و`agents/runner.test.ts`
  (حدث `session.updated` إضافي: الجلسة سمّت نفسها).
- `agents/adapters/hermes.test.ts` — `scriptedHermes` صار يجيب سؤال العنوان في محادثة
  مستقلة (`majlis-ask-…`) فلا يتسابق مع سيناريو الاختبار ولا يخلط عدّاد `createRun`.
- عميل: `session-agent.test.tsx` و`session-menu.test.tsx` (جديدان)، وتحديث
  `agent-chips.test.tsx` و`ui-layer.test.ts`.
- متصفح: رحلتان جديدتان (٨ التفريع، ٩ التسمية) وتوسعة الرحلة ١.
- اللقطات: ٣٨ لقطة تغيّرت فعلًا (الترويسة اكتسبت الوكيل، صف الرقائق اختفى من محادثة
  غير فارغة، وصفوف القائمة صارت بعناوين حقيقية وزر «المزيد») + ٤ لقطات جديدة.
  `chat-empty-ar-light.png` أُعيدت إلى ما كانت عليه: الفرق فيها ضجيج تنعيم حواف
  (أقصى فرق قناة = 2، ولا بكسل يتجاوز العتبة) لا تغيّر بصري.

## الفحوص (الأوامر ونواتجها الفعلية)

Node 24.21.0 عبر nvm، `pnpm install --frozen-lockfile`.

```
$ pnpm contracts:lint
contracts:lint  redocly lint openapi.yaml
validating openapi.yaml using lint rules for api 'hub@v1'...
openapi.yaml: validated in 510ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ pnpm contracts:generate
contracts:generate:ts  wrote generated/ts/schema.ts
contracts:generate:native  Java runtime not found; Kotlin/Swift clients not generated.
# `generated/` مُهمَل في .gitignore؛ لا فرق غير مُلتزَم بعد التوليد.

$ pnpm typecheck
# نظيف (contracts, ui-tokens, cli, server, web)

$ pnpm test
 Test Files  3 passed (3)            # contracts
      Tests  11 passed (11)
 Test Files  1 passed (1)            # ui-tokens
      Tests  105 passed (105)
 Test Files  11 passed (11)          # cli
      Tests  63 passed (63)
 Test Files  42 passed | 1 skipped (43)   # server
      Tests  390 passed | 2 skipped (392)
 Test Files  24 passed (24)          # web
      Tests  296 passed (296)

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  254 passed (254)

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm i18n:check
i18n:check  server: 100 keys, ar/en in parity
i18n:check  cli: 249 keys, ar/en in parity
i18n:check  web: 408 keys, ar/en in parity
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web

$ pnpm contracts:check-clients
check-clients  OK — 169 client file(s) scanned, 166 contract path(s) known.

$ pnpm db:generate
[✓] Your SQL migration file ➜ drizzle/0003_session_title_owner.sql 🚀
# ALTER TABLE `sessions` ADD `title_set_by_user` integer DEFAULT false NOT NULL;

$ DATA_DIR=<tmp> pnpm db:migrate     # على SQLite جديدة
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}
# والعمود موجود: pragma_table_info('sessions') -> title, title_set_by_user

$ pnpm build
✓ built in 774ms   # dist/assets/index-*.js 1,138.68 kB │ gzip: 351.06 kB

$ MAJLIS_E2E_PORT=8891 MAJLIS_E2E_SETUP_PORT=8892 pnpm web:e2e
Running 12 tests using 1 worker
  ✓ 4. first run … ✓ 1. new chat … ✓ 6. the agent row … ✓ 2. approval …
  ✓ 3. socket drop … ✓ 5. stop … ✓ 8. changing the agent mid-conversation forks …
  ✓ 9. a session names itself … ✓ 7. 443 models … ✓ design ×3
  12 passed (44.8s)
```

لم يُشغَّل: `pnpm test:coverage` (لم يُطلب في هذه الجولة) وتوليد عملاء Kotlin/Swift
(لا JRE على هذه الآلة — رسالة صريحة من المولّد، لا فشل صامت).

## المخاطر والرجوع

- **الخطر الأول: نداء إضافي إلى الوكيل بعد أول ردّ في كل جلسة.** محدود بمهلة ٢٠ ثانية،
  ولا يفتح تشغيلًا، ولا يمنع `models` من إعادة تشغيل الوقت التنفيذي، ولا يُحسب في
  الفوترة كتشغيل. فشله يُسجَّل ولا يُرى: تبقى الجلسة باسم مأخوذ من أول رسالة.
- **الخطر الثاني: حدث `session.updated` إضافي بعد كل ردّ أول.** الحدث معلَن أصلًا في
  `x-rt-events` لهذه العمليات، لكنه غيّر تسلسلات ثلاثة اختبارات — عُدِّلت صراحةً مع
  انتظار محدَّد بدل الاعتماد على التوقيت.
- **الخطر الثالث: وكيل مُعطَّل عن الظهور.** لو أخطأ السجلّ في حالة وكيل مثبَّت لظهر
  الصف فارغًا؛ لذلك الرسالة الفارغة تفرّق بين «لا وكيل مفعّل» و«لا وكيل مثبَّت»
  وتشير إلى مدير الوكلاء بدل الصمت.
- **الرجوع**: الفرع كامل قابل للعكس بـ `git revert` لالتزاماته. العمود المضاف يبقى في
  قاعدة البيانات بلا ضرر (افتراضي `false`)؛ لا حاجة إلى هجرة عكسية.
- لم يُلمس الترخيص ولا الإسناد ولا أي اسم مضيف.

## التسليم والخطوة التالية

- الفرع `feat/chips-fork-titles` من `origin/feat/chat-design-pass` (أعلى الرزمة
  المفتوحة)، لم يُدفَع ولم يُفتح له طلب دمج — بانتظار قرار المالك.
- الخطوة التالية بعد موافقة المالك: دفع الفرع، طلب دمج بالإنجليزية إلى الأساس الصحيح
  من الرزمة، ثم مسار `test` المعتاد إن طلب المالك صورة تست.
- ملاحظة للفرع الموازي الذي يضيف الوكيل المدمج `direct`: لا يلزم أي تعديل هنا — الصف
  والقائمة يقرآن `agents.list` ويُظهران الوكيل لحظة تسجيله مثبَّتًا.
