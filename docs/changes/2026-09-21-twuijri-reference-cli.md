# العميل المرجعي `packages/cli`: إثبات المرحلة صفر من الطرفية فوق العقد
المسؤول: twuijri · الفرع: feat/reference-cli · الحالة: review

## المشكلة والهدف
تقول `docs/ROADMAP.md` إن المرحلة صفر تكتمل عندما يستطيع عميل مرجعي داخل المستودع
(`packages/cli`، مولَّد من العقد) أن يقترن ويعرض الوكلاء ويفتح جلسة ويبثّ ردًّا، ولا
يُستعمل أي عميل قديم (ADR 0007). لم يكن هذا العميل موجودًا، فلم يكن للمالك طريقة
لإثبات الخادم من طرف إلى طرف بعد وحدتي `auth` و`sessions`.

الهدف: عميل طرفية صغير ودقيق، كل نداء HTTP فيه عبر العميل المولَّد من
`packages/contracts`، وكل رسالة حية فيه هي ظرف `packages/contracts/events`، يقدّم:
`login/logout/whoami`، `pair` و`pair claim` (QR في الطرفية بمشفّر JavaScript صرف
وانتظار `pairing.claimed` على `/rt/devices`)، `agents list|get|install|remove`،
`sessions list|new|show|delete`، و`chat` تفاعليًا مع الاستئناف بـ`after_seq` والموافقات
وإلغاء التشغيل بـCtrl+C، مع `--json` و`--strict` وعربية/إنجليزية ورموز خروج ثابتة.

## القرار والموافقات
- **العقد أولًا، ولا تغيير فيه.** كل ما يفعله العميل موجود في `openapi.yaml`
  و`events/`. المسارات لا تُكتب باليد: `createHubClient` من `@majlis/contracts` لكل
  نداء (`packages/cli/src/client.ts`)، و`pnpm contracts:check-clients` يفحص الآن
  `packages/cli` أيضًا. قاعدة المسار تبقى افتراض العميل المولَّد وتُثبَّت باختبار
  يقارنها بـ`servers[0].url` في الوثيقة.
- **الغرفة النظيفة (ADR 0004):** لم يُفتح أي ملف تحت `packages/*` في Hermes/Ekko
  Studio ولا أي كود عميل لمنتج آخر؛ العميل مشتق من العقد ووثائق هذا المستودع فقط.
- **الأسرار لا تمرّ في سطر الأوامر:** `--password` و`--token` مرفوضة صراحةً (خروج 2)؛
  كلمة المرور تُطلب مخفيّة على الطرفية وتُقرأ من stdin عند التوجيه. الرمز يُحفظ في
  `$XDG_CONFIG_HOME/majlis/config.json` (أو `~/.config/majlis/`) بمجلد 0700 وملف
  0600 يُكتب ذريًّا. رمز جلسة الويب يُجدَّد مرة واحدة عند `401 token_expired`
  واستباقيًا قرب الانتهاء؛ رمز التطبيق (من `pair claim`) يُجدَّد عندما يبقى أقل من
  سبعة أيام كما يقول العقد (`auth.refresh` بحامل بلا جسم).
- **الاستئناف كما يعرّفه `events/README.md`:** يحتفظ العميل بأعلى `seq` رآه، وعند
  إعادة الاتصال يرسل `subscribe { session_id, after_seq }`؛ إن أجاب الخادم
  `truncated: true` يُعاد قراءة `sessions.get`، وإن كان التشغيل المتابَع قد انتهى
  أثناء الانقطاع يُقرأ بـ`sessions.getRun` ويُبلَّغ بحالته. الانقطاع الذي يبدؤه
  الخادم (`io server disconnect`) لا يعيده socket.io-client تلقائيًا، فالعميل يعيد
  الاتصال بنفسه بعد ثانية — وهذا ما كشفه اختبار الاستئناف.
- **الموافقات:** `approval.requested` توقف النصّ وتسأل `[1] مرة [2] الجلسة [3] دائمًا
  [4] رفض` (الـ3 فقط عند `allow_always`)، أو إجابة/رقم اختيار للأسئلة، ثم
  `sessions.respondApproval`. بلا طرفية أو مع `--approve` يكون القرار تلقائيًا ويُطبع
  على stderr؛ الافتراضي بلا طرفية هو `deny` حتى لا يعلّق سكربت أبدًا.
- **Ctrl+C** أثناء التشغيل = `sessions.cancelRun`؛ الضغطة الثانية تخرج. عند المطالبة
  يخرج مباشرة.
- **رموز الخروج:** 0 نجاح، 1 خطأ (ومنه `501 not_implemented` الذي يُطبع باسم العملية
  صراحةً)، 2 استعمال خاطئ، 3 غير مسجَّل الدخول (لا رمز محفوظ أو `401/403`).
- **i18n:** كل نص في `packages/cli/src/i18n/{ar,en}.json` بنفس آلية الخادم؛
  `pnpm i18n:check` يغطي الحزمة (167 مفتاحًا).
- **مشفّر QR:** التبعية `qrcode-generator` (MIT، بلا تبعيات، JavaScript صرف) — تبعية
  npm لا نسخ كود، فلا حاجة لإدخال في `THIRD-PARTY-NOTICES.md`. الرسم بأنصاف
  المربعات (سطر لكل صفَّي وحدات) مع هامش هادئ.
- **معايرة السلوك بالاختبار لا بالتخمين:** كشفت اختبارات التكامل سباقًا حقيقيًا
  (وكيل سريع ينهي التشغيل قبل أن يعرف العميل `run_id` من رد HTTP) فصار العميل يحفظ
  الحالة النهائية لكل تشغيل ويحلّ الانتظار فورًا إن كان قد انتهى؛ وسباقًا ثانيًا في
  إخفاء صدى رسالة المستخدم (الحدث يسبق رد HTTP) فصار الإخفاء بالنصّ المرسَل أيضًا؛
  وخطأ أسبقية في تحليل اختيار الموافقة التفاعلي فاستُخرج التحليل إلى دالة صافية
  مختبَرة (`src/chat/approvals.ts`).
- لم يُدفع الفرع ولم يُفتح PR ولم يُدمج شيء؛ القرار للمالك.

## العقد
لا شيء تغيّر في `packages/contracts/openapi.yaml` ولا في `events/`. ما لوحظ أثناء
التنفيذ ولم يُغيَّر: `meta.get` ما زال `501` على الخادم (الدخول يتسامح معه ويكمل)،
وحدث `run.queued` يحمل `queue_position: 1` حتى لتشغيل يبدأ فورًا (العميل لا يعلن
الموضع إلا عندما يكون أكبر من 1).

## الملفات والتأثير
- جديد `packages/cli/`: `package.json` (`@majlis/cli`، `bin: majlis`)، `tsconfig.json`،
  `tsconfig.test.json`، `vitest.config.ts`، `README.md`.
- `src/bin.ts`، `src/main.ts` (التحليل والإرسال ورموز الخروج)، `src/args.ts` (جدول
  أوامر فوق `node:util` parseArgs، رفض الأسرار)، `src/context.ts`، `src/config.ts`
  (مخزن الرمز)، `src/client.ts` (العميل المولَّد مع التجديد)، `src/realtime.ts`
  (المسافات على `/rt`، الظرف، مدقّق Ajv مقابل مخطّطات الأحداث)، `src/output.ts`
  (جداول بعرض العرض الفعلي للعربية، JSON على stdout فقط)، `src/prompt.ts` (readline
  واحد، إدخال مخفي، Ctrl+C كحدث)، `src/qr.ts`، `src/i18n/{ar,en}.json` + `index.ts`،
  `src/types.ts` (أنواع العقد من العميل المولَّد)، `src/errors.ts`.
- `src/chat/transcript.ts` (مخفّض صافٍ من الأظرف إلى الطرفية)، `src/chat/approvals.ts`،
  `src/commands/{auth,pair,agents,sessions,chat,shared}.ts`.
- الاختبارات `packages/cli/tests/*.test.ts` (9 ملفات وحدة) و`tests/integration/cli.test.ts`
  (يُقلع الخادم الحقيقي داخل العملية مع المشغّل الوهمي من
  `packages/server/src/modules/sessions/testing/`).
- الربط: `scripts/i18n-check.mjs` (مجموعة `cli`)، `packages/contracts/scripts/check-clients.mjs`
  (يفحص `packages/cli`)، `.github/workflows/ci.yml` (خطوة تشغيل الثنائي المبني:
  `--version`، `--help`، مساعدة عربية، و`whoami` يجب أن يخرج 3)، `AGENTS.md`،
  `docs/harness/validation.md`، `docs/harness/README.md`، `docs/clients/README.md`،
  وصفحة جديدة `docs/clients/CLI.md`.
- `pnpm-lock.yaml` (qrcode-generator وتبعيات الحزمة الجديدة). لا تغيير في
  `pnpm-workspace.yaml` لأن `packages/*` تغطي الحزمة.
- الخادم لم يُلمس.

### ما يعمل الآن من طرف إلى طرف (مُثبَت بالاختبار)
`login` → `whoami` (نص/JSON/عربي) → `sessions new` → `chat --message --once --strict`
(بث النص، سطور الأدوات، الاستهلاك، كل ظرف مطابق لمخطّطه) → NDJSON بـ`--json` →
الموافقات (`--approve session` والرفض الافتراضي بلا طرفية) → تشغيل فاشل (خروج 1) →
انقطاع المقبس أثناء التشغيل واستئناف بـ`after_seq` (يُعاد إرسال الأحداث الفائتة) →
`--timeout` → `pair` + `pair claim` (رمز تطبيق، `whoami` به) → `sessions delete` →
`logout` → `whoami` يخرج 3.

### ما يبقى مقيّدًا بـ501 (بصدق)
`agents list|get|install|remove` تجيب `501 not_implemented` حتى تصل وحدة `agents`
في فرعها؛ العميل يطبع اسم العملية ويخرج 1 (مُختبَر). `meta.get` كذلك؛ الدخول
يكمل بدونه.

## الفحوص (الأوامر ونواتجها الفعلية)
شُغِّلت محليًا على الفرع `feat/reference-cli` (Node v24.21.0، pnpm 12.5.1) بعد آخر التزام
(إصلاح تحليل اختيار الموافقة)؛ `pnpm lint` و`pnpm typecheck` و`pnpm test` أُعيدت بعده
والأرقام أدناه هي أرقام الإعادة.
```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit=0

$ pnpm i18n:check
i18n:check  server: 58 keys, ar/en in parity
i18n:check  cli: 167 keys, ar/en in parity
i18n:check  web: packages/web/src/i18n not present yet — skipped
i18n:check  desktop: apps/desktop/src/i18n not present yet — skipped
i18n:check  OK
exit=0

$ pnpm nav:check
nav:check  OK — 35 destinations, 37 terms, ar/en complete
exit=0

$ pnpm contracts:check-clients
check-clients  OK — 30 client file(s) scanned, 161 contract path(s) known.
exit=0

$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
exit=0

$ pnpm typecheck        # contracts ثم cli و server (كلٌّ يبني contracts ثم tsc)
packages/cli typecheck: Done
packages/server typecheck: Done
exit=0

$ pnpm test
packages/contracts test:  Test Files  3 passed (3)      Tests  11 passed (11)
packages/cli test:        Test Files  10 passed (10)    Tests  55 passed (55)
packages/server test:     Test Files  26 passed (26)    Tests  107 passed (107)
exit=0

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  247 passed (247)
exit=0

$ pnpm build
packages/cli build: Done
packages/server build: Done
exit=0

$ node packages/cli/dist/bin.js --version
0.0.0
exit=0
$ XDG_CONFIG_HOME=$(mktemp -d) node packages/cli/dist/bin.js whoami
Not signed in. Run `majlis login --server URL` first.
exit=3
$ node packages/cli/dist/bin.js
No command given.
Run `majlis help <command>` for details.
exit=2
$ node packages/cli/dist/bin.js login --password x
--password is not accepted on the command line; the value is asked for interactively.
Run `majlis help <command>` for details.
exit=2
$ node packages/cli/dist/bin.js --lang ar help chat
majlis chat <SESSION_ID>
  تحدّث في جلسة وابثّ الرد
… (المعاملات والخيارات بالعربية كاملة)
exit=0
```
لم يُشغَّل: `pnpm contracts:generate` (العقد لم يتغيّر؛ `generate:ts` يجري ضمن typecheck/build)،
بناء Docker وهجرة PostgreSQL (لا تمسّهما هذه المهمة)، وتشغيل يدوي ضد خادم منشور
(لا يوجد بعد؛ Checkpoint A).

## المخاطر والرجوع
- **لا وكيل حقيقي بعد.** كل الإثبات عبر `FakeAgentRunner`؛ الترتيب الفعلي لإطارات
  Hermes/ACP وأشكال موافقاتها تُختبر مع وصول وحدة `agents`.
- **`pnpm -r`** يشغّل `typecheck`/`test`/`build` لحزمتي `cli` و`server` بالتوازي وكلٌّ
  منهما يعيد بناء `contracts` (النمط القائم في الخادم)؛ مرّ نظيفًا هنا، لكن الكتابة
  المتزامنة لـ`generated/ts/schema.ts` قد تسبب تذبذبًا نادرًا. العلاج المقترح إن ظهر:
  `--workspace-concurrency=1` في سكربتات الجذر أو إزالة إعادة البناء من الحزم التابعة.
- **الاستئناف من الذاكرة** كما في الخادم؛ بعد إعادة تشغيله يجيب `truncated: true`
  فيعيد العميل قراءة الجلسة (مسار مُنفَّذ ومُوثَّق؛ المُختبَر منه آليًا هو الإعادة الكاملة).
- **الإدخال المخفي** يكتم صدى readline عبر `_writeToOutput` الداخلي (الأسلوب الشائع في
  أدوات الطرفية)؛ إن تغيّر في إصدار Node مستقبلي يعود الصدى إلى الظهور أثناء كتابة كلمة
  المرور ولا يتعطّل الدخول. مُوثَّق في `src/prompt.ts` ويُلتقط بمراجعة يدوية عند ترقية Node.
- **الرجوع:** الحزمة معزولة؛ حذف `packages/cli` وإعادة السطور الأربعة في الربط
  (`i18n-check`، `check-clients`، `ci.yml`، الوثائق) يعيد كل شيء. الخادم والعقد لم يتغيرا.

## التسليم والخطوة التالية
1. مراجعة المالك للفرع `feat/reference-cli` (فوق `feat/sessions-streaming`، فوق
   `feat/auth`). لم يُدفع ولم يُفتح PR بطلب المكلِّف؛ الدمج قرار المالك.
2. بعد وصول وحدة `agents`: تشغيل `majlis agents list` و`majlis chat` ضد Hermes حقيقي
   على الخادم (Checkpoint A) وتوثيق النتيجة هنا؛ لا تغيير متوقَّع في العميل.
3. لاحقًا: نشر الحزمة أو تغليفها في صورة الخادم كي يُستدعى `majlis` بلا مسار كامل.
