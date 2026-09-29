# الهب يقلع مهما كان في المجلد: لا فحص للوكلاء أثناء تركيب الـAPI
المسؤول: twuijri · الفرع: fix/boot-plugin-timeout · الحالة: review

## المشكلة والهدف
هب المالك الحي دخل في حلقة إعادة تشغيل كل ~30 ثانية:
`db: migrations applied` ثم بعد 12–15 ثانية
`AVV_ERR_PLUGIN_EXEC_TIMEOUT: Plugin did not start in time: 'async (api) => { api.get('/health' …`.
حدث ذلك مع صورة الاختبار من 416e858a، ثم مع `:latest` (v1.1.5) على نفس المجلد، إذن ليس تراجعاً من #225.

**السبب الجذري (بالدليل):**
- الصورة المؤقتة f6514220 سجّلت زمن كل وحدة على مجلد المالك:
  `agents: reconciling an agent took long {agent:"claude-code", ms:30137}` و
  `boot: a module took long to register {module:"agents", ms:34659}`.
- وحدة `agents` كانت تنتظر أثناء تركيب الـAPI (`registerRoutes` → `service.bootstrap`) فحص صحة كل وكيل مثبّت.
  فحص Claude Code هو `claude-code-acp --version`. هذا الجسر (`@zed-industries/claude-code-acp@0.16.2`) يتجاهل
  `--version`، ويبدأ بخدمة ACP على stdin، ويبقى حياً بـ`process.stdin.resume()`. تأكدت من ذلك بقراءة `dist/index.js` في الحزمة المثبّتة.
- كانت `runCommand` (عبر `execFile`) تترك stdin مفتوحاً، فلا ينتهي الجسر إلا عند مهلة الـ30 ثانية.
  لكن Fastify يعطي الـplugin كلها 10 ثوانٍ.
- المشكلة تظهر عند كل من ثبّت Claude Code في المجلد، أياً كانت نسخة الصورة. تجربة الإصدار المثبّت نفسه محلياً:
  مع stdin مفتوح استمر الجسر حتى قُتل بالمهلة، ومع stdin مغلق (`/dev/null`) خرج بـ0 في 165 ms.

الهدف: لا شيء يُنتظر أثناء التركيب يعتمد على حجم البيانات أو على برنامج خارجي. الفحوص تتم بعد الجاهزية، ومحدودة بمهلة،
والسجل يسمّي البطيء.

## القرار والموافقات
- **فصل الإقلاع عن الفحص:**
  - `AgentsService.seed()` يكتب صفوف الكتالوج ويسوّي التثبيتات المقطوعة. هو عمل قاعدة بيانات فقط ويجري أثناء التركيب.
  - `reconcileInstalls()` يشغّل فحوص الوكلاء في `onReady`: بالتوازي، ولكل فحص صحة مهلة 10 ثوانٍ (`BOOT_HEALTH_TIMEOUT_MS`).
    ينتظر الإقلاع ثانية واحدة على الأكثر (`RECONCILE_BOOT_WAIT_MS`) ثم يكمل الخدمة، ويستمر الفحص في الخلفية مع تسجيل ذلك.
  - الوكيل الذي بدأ شخص تثبيته أثناء الفحص يُترك لذلك التثبيت، إذ يُعاد قراءة الصف بعد كل انتظار.
  - `bootstrap()` باقية (seed ثم reconcile) لمن يستدعيها.
- **`runCommand`:**
  - stdin مغلق.
  - كل أمر في مجموعة عمليات خاصة، وعند المهلة تُقتل المجموعة كلها (SIGKILL) مع رسالة `did not finish within N s`.
  - الحد 1 MB لكل مخرَج.
  - صار مبنياً على `spawn` بدل `execFile`.
- **فحص الصحة:**
  - يُمرَّر له `CI=1` و`DISABLE_AUTOUPDATER=1` و`DISABLE_TELEMETRY=1` و`NO_UPDATE_NOTIFIER=1`.
  - الجسر الذي لا يطبع نسخة يحتفظ بالنسخة المسجّلة عند تثبيته بدل `null`.
  - الفحص الذي لا ينتهي يجعل الوكيل `failed` مع السبب، كما كان قبل التغيير لكن بمهلة 10 ثوانٍ لا 30.
- **هامش أمان وتشخيص:**
  - `pluginTimeout` صار 120 ثانية، ويمكن تغييره بـ`COREHUB_PLUGIN_TIMEOUT_MS` (0 = بلا حد). متغيّر اختياري جديد، لا كسر.
  - يُسجَّل زمن كل وحدة إن تجاوز ثانية، وزمن فحص كل وكيل إن تجاوز نصف ثانية.
- **مقترح — للمالك أن يؤكد:** لا توجد حالة «checking» للوكيل أثناء الفحص. إضافتها تعني قيمة enum جديدة في العقد، فأبقيت ما
  عرفه الإقلاع السابق حتى ينتهي الفحص، وعادة يكون ذلك خلال أجزاء من الثانية.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/src/app/config.ts`، `server.ts`: `COREHUB_PLUGIN_TIMEOUT_MS` و`pluginTimeout`.
- `packages/server/src/app/routes.ts`: تسجيل زمن كل وحدة.
- `packages/server/src/modules/agents/service.ts`: `seed` و`reconcileInstalls` والحماية من سباق التثبيت.
- `packages/server/src/modules/agents/index.ts`: الفحص في `onReady` مع انتظار محدود، و`bootHealthTimeoutMs` كمنفذ اختبار.
- `packages/server/src/modules/agents/installer.ts`: مهلة الفحص وبيئة CLI هادئة.
- `packages/server/src/modules/agents/adapters/host.ts`: `runCommand` الجديدة.
- اختبارات جديدة:
  - `tests/unit/boot-slow-agents.test.ts`: مجلد فيه 400 محادثة، ومحادثة فيها دور جارٍ، ووورك فلو بخطوة تعيد استخدام
    تلك المحادثة ولها تشغيلات مقطوعة، ووكيل يتعلق فحصه، وجسر يقرأ stdin حتى نهايته.
  - `src/modules/agents/adapters/run-command.test.ts`.
- `tests/unit/config.test.ts`: قائمة المتغيرات.
- `docs/DEPLOY.md` و`docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبارات الجديدة فشلت على الكود القديم (أعدت ملفات الوكلاء الأربعة إلى origin/main مؤقتاً):
```
 × gives the program a closed stdin, so a bridge that serves stdin ends at once 20013ms
 × stops a program that never ends at the deadline, with its helpers, and says so 406ms
 × reports a failing program with its output, and a missing one without throwing 6ms
 × mounts and answers /health at once, and checks its agents after, each bounded 60017ms
      Tests  4 failed (4)
```
ونجحت بعد الإصلاح، ومعها كل اختبارات وحدة agents وconfig:
```
$ vitest run --project unit --maxWorkers=2 src/modules/agents tests/unit/boot-slow-agents.test.ts tests/unit/config.test.ts
 Test Files  58 passed | 21 skipped (79)
      Tests  759 passed | 55 skipped (814)
$ tsc --noEmit -p packages/server/tsconfig.json   (لا أخطاء)
$ eslint … ; prettier --check …                     All matched files use Prettier code style!
```
إعادة إنتاج على السيرفر من المصدر، بجسر Claude Code الحقيقي `@zed-industries/claude-code-acp@0.16.2` مثبتاً في
`<DATA_DIR>/agents/claude-code/bin`، على مجلد فيه 800 محادثة و48 ألف رسالة ووورك فلو له تشغيلات جارية:
```
58421c1b: FastifyError: Plugin did not start in time: 'async api=>{api.get("/health",…   code: 'AVV_ERR_PLUGIN_EXEC_TIMEOUT'   (11s)
هذا الفرع: 18:48:26.686 db: migrations applied (sqlite)
           18:48:28.071 agents: registry reconciled with the data volume {"installed":3,"ms":164}
           18:48:28.090 Server listening   → claude-code: installed
```
وعلى صورة المالك نفسها سجّلت نسخة التشخيص f6514220: `claude-code ms:30137` و`agents ms:34659`.
نتيجة CI: تُضاف بعد الدفع.

## المخاطر والرجوع
- `runCommand` صارت تُشغَّل بـ`spawn` مع stdin مغلق ومجموعة عمليات مستقلة. من يستدعيها (فحوص النسخة والصحة، وفك tar،
  واستدعاء npm) لم يكن يكتب شيئاً على stdin.
- رسالة الفشل تغيّرت من نص `execFile` إلى `Command failed: … (exit code N)`.
- في أول ثانية بعد الإقلاع قد تُعرض حالة الوكيل كما عرفها الإقلاع السابق.
- الرجوع: revert لهذا الـPR. الإعداد الجديد اختياري.
- متابعة لم تُنجز: تركيب الوحدات يستهلك نحو 1.2 ثانية CPU على جهاز سريع، ونحو 1–2 ثانية لكل وحدة على سيرفر المالك.
  أغلبه تجميع ajv الذي يمرّ على كل `components` مع كل مسار. هذا مقترح PR منفصل، وهامش الـ120 ثانية يغطيه الآن.

## التسليم والخطوة التالية
PR واحد إلى `main` للمراجعة، دون دمج. بعد نجاح CI تُبنى صورة اختبار من الفرع ليجربها المالك.
