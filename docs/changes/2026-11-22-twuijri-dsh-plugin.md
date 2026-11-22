# إضافة كور هب لـ DeepSeek Harness: الهارنس في جهاز الشخص، مربوط بالهب
المسؤول: twuijri · الفرع: feat/dsh-plugin · الحالة: review

## المشكلة والهدف
- **الحاجة:** المالك (2026-11-22) ما يبي يكبّر تطبيق سطح المكتب ويسكّر ثغراته، وفيه هارنس قوي جاهز اسمه ⁨DeepSeek Harness⁩ (⁨MIT⁩)، يشتغل على الماك وويندوز، وفيه ⁨Computer Use⁩. جرّبه المالك على الماك، واشتغل معه.
- **الهدف:** إضافة لهذا الهارنس:
  - تربطه بالهب اللي على السيرفر.
  - تعطيه موديلات الهب عن طريق البوابة.
  - تخلي المالك يكلّم ⁨Hermes⁩ اللي على السيرفر من داخل الهارنس، بذاكرته وأدواته.
  - تخلي ⁨Hermes⁩ يوصل لملفات الجهاز وبرامج ⁨MCP⁩ اللي فيه، ويعطي الجهاز مهمة على الشاشة.
- **بكلامه:** «ابي اضافة للهارنس تكون بالمستقبل القريب واقل شي لو لي لحالي تستبدل تطبيق سطح المكتب».

## القرار والموافقات
- **القرار المعماري:** ⁨ADR 0033⁩ (`docs/adr/0033-deepseek-harness-plugin.md`).
- **وافق المالك في 2026-11-22 على:**
  - **الاتجاه:** الإضافة تمشي جنب التطبيق، والاستبدال قرار لاحق.
  - **الشاشة بالكلام:** ⁨Hermes⁩ يرسل للإضافة المهمة بالكلام، والإضافة تنفّذها محلياً بجلسة ⁨PTC⁩ بموديل من الهب، وترجع النتيجة وصورة. قال: «اوافق على هالطريقة».
  - **المراحل:** كل المراحل الأربع، بكلامه: «كمل كل المراحل».
- **المراحل:**
  1. باب خارجي لبوابة الموديلات، مطفي افتراضياً وبمفتاح الشخص. والإضافة تربط بكود الربط وتكتب مزوّد «كور هب» في الهارنس.
  2. ربط الجهاز من الإضافة: ⁨files⁩ و⁨apps⁩.
  3. أمر ⁨/hermes⁩ وأداة ⁨corehub_ask_agent⁩.
  4. قدرة ⁨screen_task⁩ وأداة ⁨devices.screen_task⁩.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- إضافات فقط، ولا شي ينحذف أو يتغيّر اسمه، والتفاصيل تُكتب هنا مع التنفيذ:
  - الباب الخارجي للبوابة وإعداد تشغيله.
  - قيمة ⁨screen_task⁩ في أنواع قدرات الجهاز.
  - أداة ⁨devices.screen_task⁩.
- **جهة الهب، فرع ⁨feat/dsh-plugin-hub⁩ (2026-11-22)، إضافات فقط:**
  - **إعداد الباب الخارجي:** `GET` و`PATCH /models/external-gateway` (`models.getExternalGateway` و`models.updateExternalGateway`)، للمالك والأدمن، والحقل `ExternalGateway.enabled` مطفي افتراضياً، ومعه `available` و`reason` و`openai_base_path` و`anthropic_base_path` و`rate_limit_per_minute`.
  - **مسارات البوابة على منفذ الهب:** `GET /gateway/openai/v1/models` و`POST /gateway/openai/v1/chat/completions` و`POST /gateway/openai/v1/responses` و`GET /gateway/anthropic/v1/models` و`POST /gateway/anthropic/v1/messages` (تُخدم تحت `/api/v1`). أخطاؤها بغلاف السلك نفسه (`OpenAIWireError` و`AnthropicWireError`)، ومعلَّمة `x-error-envelope: wire`.
  - **قيم جديدة:** `screen_task` في `CapabilityKind`، و`dsh` في `DevicePlatform`. ووصف `params` و`result` لـ`screen_task` في `DeviceRequest`، ومهلته 180 ثانية.
  - **أداة الهب** `devices.screen_task`، و`devices.run_status` يتابع المهمة الجارية. والأدوات ما هي في العقد، لكن سجلّها في `DECISIONS` §157.
  - **القرارات:** §156 للباب الخارجي، و§157 لمهام الشاشة.

- **بعد الدمج (⁨feat/dsh-plugin⁩):**
  - قيمة `dsh` في `DeviceProgram.source`، عشان الهب يقبل برامج الهارنس في تقرير الجهاز.
  - مخططات الأحداث (`packages/contracts/events/`) فيها الحين القيم الجديدة: `dsh` للمنصة والمصدر، و`screen_task` للقدرة. كانت ناقصة من جهة الهب.

## الملفات والتأثير
- `docs/adr/0033-deepseek-harness-plugin.md` (جديد).
- `packages/dsh-plugin/` (حزمة جديدة).
- الخادم: وحدات ⁨models/gateway⁩ و⁨devices⁩ و⁨agents/hub-tools⁩. والويب: مفتاح تشغيل الباب الخارجي ونصوصه بكل اللغات.

- **جهة الهب (⁨feat/dsh-plugin-hub⁩):**
  - العقد: `packages/contracts/openapi.yaml`.
  - الخادم: `models/gateway/external.ts` (جديد)، و`gateway.ts` و`tokens.ts` و`models/index.ts`، و`auth/principal.ts` (`x-api-key` على مسارات البوابة فقط)، و`devices/requests.ts` و`devices/schema.ts`، و`agents/hub-tools/catalog.ts`، و`audit/analytics.ts` و`audit/schema.ts` و`audit/index.ts`، و`app/config.ts` (`COREHUB_EXTERNAL_GATEWAY_RATE_LIMIT`)، و`lib/route.ts` (`bodyLimit`).
  - الترحيل `drizzle/0035_device_screen_tasks.sql`: ينسخ `devices` و`device_requests` و`usage_records` ليوسّع قيود ⁨CHECK⁩. الترتيب مدروس حتى ما تنحذف الطلبات بالتتابع داخل معاملة المرحِّل.
  - الويب: `models/ExternalGatewayCard.tsx` (جديد)، و`ModelsScreen.tsx` و`queries.ts` و`types.ts`، ونصوص `ar`/`en`.
  - نصوص مجموعة «حواسيبك» في iOS وAndroid.
  - الوثائق: `docs/contracts/DECISIONS.md` (§156، §157)، و`docs/STATUS.md`، و`docs/DEPLOY.md`.

- **جهة الإضافة (⁨feat/dsh-plugin-pkg⁩):**
  - حزمة جديدة `packages/dsh-plugin/`: `package.json` (حزمة ⁨dsh⁩ و`engines.dsh` مثبّت على ⁨0.2.2-rc.5⁩)، و`cordis.patch.yml`، و`scripts/build.mjs` (⁨esbuild⁩ إلى `dist/index.js` و`dist/screen-consent.js`)، و`README.md` بالإنجليزي.
  - `src/`: `pairing.ts` (قراءة كود الربط)، `store.ts` (ملفات ⁨0600⁩)، `hub.ts` (المطالبة بالربط وتجديد المفتاح وقائمة موديلات البوابة)، `provider.ts` (صف مزوّد «كور هب»)، `device-link.ts` و`device-answers.ts` و`folders.ts` و`programs.ts` (منقولة من تطبيق سطح المكتب: كودنا)، `consent.ts`، `screen.ts` و`screen-consent.ts` (مهام الشاشة)، `hermes.ts` (⁨/hermes⁩ والأداة)، `i18n.ts` (عربي وإنجليزي)، `host.ts` (الجزء اللي نستخدمه من واجهة الهارنس)، `core.ts` و`index.ts`.
  - `tests/`: ١١ ملف ⁨vitest⁩ للمنطق الصافي.
  - `pnpm-lock.yaml`: اعتماديات التطوير للحزمة (`@deepseek-ai/schemastery` و⁨esbuild⁩ و⁨socket.io-client⁩).
  - ما لمسنا العقد ولا الخادم ولا الويب؛ دمجنا فرع الهب في فرع الإضافة عشان الأنواع المولّدة.
## الفحوص (الأوامر ونواتجها الفعلية)
- تُلصق هنا عند التشغيل.
- **جهة الهب (⁨feat/dsh-plugin-hub⁩)، 2026-11-22، محلياً.** شغّلنا فقط ما يمسّه التغيير، والمجموعات الكاملة تشتغل على ⁨CI⁩:
  - `pnpm contracts:lint`: `Woohoo! Your API description is valid.`، مع تحذير واحد قديم في السطر 7898، ثم `contracts:lint  OK`.
  - `git fetch origin --tags` ثم `pnpm contracts:compat`: `OK — no breaking change against v1.1.10`.
  - `pnpm migrations:guard`: `35 migration(s) in v1.1.10, 1 new` و`OK — no breaking change against v1.1.10`.
  - `pnpm contracts:generate`: كتب `generated/ts/schema.ts`. أما عملاء Kotlin وSwift فما تولّدوا محلياً لأن ⁨Java⁩ غير موجود (`Java runtime not found`)، ويتولّدون على ⁨CI⁩.
  - `pnpm contracts:check-clients`: `OK — 1189 client file(s) scanned, 289 contract path(s) known.`
  - `pnpm typecheck`: `exit=0`.
  - `pnpm lint`: `exit=0`، و`All matched files use Prettier code style!`.
  - `pnpm i18n:check`: `web: 3783 keys, ar/en in parity`، و`ios: 2790`، و`android: 2653`، والنتيجة `OK`.
  - `pnpm i18n:limits`: `ar: 56 measured labels, 0 too wide` و`en: … 0 too wide`، والنتيجة `OK`.
  - `pnpm nav:check`: `OK — 41 destinations`.
  - `pnpm --filter @corehub/web build`: `✓ built`.
  - الخادم، اختبارات الوحدات (⁨vitest --project unit --maxWorkers=2⁩) على `external.test.ts` و`gateway.test.ts` و`hub-gateway.test.ts` و`hub-tools.test.ts` و`device-helper.test.ts` و`device-requests.test.ts` و`device-screen-tasks-migration.test.ts` و`config.test.ts` و`status.test.ts` و`src/modules/audit` و`auth.test.ts`: `Test Files 17 passed (17)` و`Tests 144 passed (144)`.
  - الخادم، اختبارات العقد (⁨--project contract⁩) على `external-gateway.contract.test.ts` و`contract.test.ts` و`devices` و`hub-tools` و`audit`: `Test Files 5 passed (5)` و`Tests 416 passed (416)`.
  - الويب: `external-gateway-card.test.tsx` و`i18n.test.ts` و`logical-css.test.ts` و`device-cards.test.tsx` و`hub-tools-card.test.tsx`: `Tests 368 passed` ثم `3 passed` بعد التعديل.
  - `packages/contracts` (⁨vitest⁩): `Test Files 11 passed (11)` و`Tests 130 passed (130)`.
  - النواتج كما ظهرت (مختصرة):

    ```
    $ pnpm contracts:lint
    Woohoo! Your API description is valid. 🎉  You have 1 warning.
    contracts:lint  OK
    $ pnpm contracts:compat
    contracts:compat  OK — no breaking change against v1.1.10
    $ pnpm migrations:guard
    migrations:guard  35 migration(s) in v1.1.10, 1 new
    migrations:guard  OK — no breaking change against v1.1.10
    $ pnpm contracts:check-clients
    check-clients  OK — 1189 client file(s) scanned, 289 contract path(s) known.
    $ pnpm i18n:check
    i18n:check  web: 3783 keys, ar/en in parity
    i18n:check  OK
    $ pnpm i18n:limits
    i18n:limits  OK
    $ pnpm typecheck   # exit=0
    $ pnpm lint        # exit=0, All matched files use Prettier code style!
    $ vitest --project unit (11 files/dirs touched)
     Test Files  17 passed (17)
          Tests  144 passed (144)
    $ vitest --project contract (5 files)
     Test Files  5 passed (5)
          Tests  416 passed (416)
    ```
  - **ما ما جرّبناه:** ما جرّبنا البطاقة بعيننا في متصفح، واعتمدنا على اختبار المكوّن. وما جرّبنا الإضافة الحقيقية ولا ⁨CLIProxyAPI⁩ الحقيقي، واستعملنا البديل الوهمي في الاختبارات. و⁨Playwright⁩ ما شغّلناه.


- **جهة الإضافة (⁨feat/dsh-plugin-pkg⁩)، 2026-11-22، محلياً على لينكس:**
  - `pnpm --filter @corehub/dsh-plugin typecheck`: ‏exit=0.
  - ‏⁨vitest --maxWorkers=2⁩ في الحزمة: `Test Files 11 passed (11)` و`Tests 64 passed (64)`.
  - `npx eslint packages/dsh-plugin`: ‏exit=0، و`prettier --check`: `All matched files use Prettier code style!`.
  - `pnpm contracts:check-clients` بعد دمج فرع الهب: `OK — 1189 client file(s) scanned, 289 contract path(s) known.`
  - `node scripts/version-check.mjs`: `version: 1.1.10 everywhere`.
  - **تجربة حقيقية مع الهارنس ⁨0.2.2-rc.5⁩** (مثبّت في `~/.cache/dsh-dev` مع ⁨DSH_HOME⁩ معزول، وهب وهمي محلي بشكل العقد): التثبيت بـ `dsh plugin --profile e2e add <tgz>` نجح وفحص `engines.dsh` مرّ؛ `/corehub link` بالـ ⁨JSON⁩ والمنصة `dsh`؛ `/corehub status` و`models` و`unlink`؛ صف المزوّد انكتب في `cordis.patch.yml` بدون المفتاح، وطلبات المحادثة وصلت البوابة بالمفتاح الحقيقي من خطّاف `llm-pi-ai/request-headers`؛ أداة `corehub_ask_agent` و`/hermes` رجعوا جواب الهب؛ رابط الجهاز جاوب طلب `files` بالمجلد المشارك ورفض `apps` لبرنامج غير مفعّل؛ وبروفايل مهام الشاشة اشتغل بالمشغّل الأحادي ورجع `running` ثم `done` مع معرّف الصورة (بدون ⁨Computer Use⁩ لأنه لينكس).

    ```
    $ pnpm --filter @corehub/dsh-plugin typecheck   # exit=0
    $ npx vitest run --maxWorkers=2
     Test Files  11 passed (11)
          Tests  64 passed (64)
    $ dsh plugin --profile e2e add corehub-dsh-plugin-1.1.10.tgz
    + @corehub/dsh-plugin file:…/corehub-dsh-plugin-1.1.10.tgz
    E2E /corehub link {"type":"corehub.pairing", => {"kind":"success","text":"Linked to http://127.0.0.1:47811 as Owner. …\nThe hub’s models are in the model picker under “Core Hub” (1)."}
    {"type":"tool_call","callId":"call_1","tool":"corehub_ask_agent","input":{"message":"What is in my memory?"}}
    {"type":"final",…,"reason":{"kind":"completed"},"text":"FINAL: Hermes says: your memory holds the launch plan."}
    hub: POST /gateway/openai/v1/chat/completions auth "Bearer hub_at_e2…" tools ["corehub_ask_agent"]
    hub: POST /device-requests/RQ1/respond {"status":"fulfilled",…"access":"read-only"…}
    ScreenRunner (Linux, fake hub): FIRST {"state":"running",…} END {"state":"done","outcome":"Hello from the fake hub","screenshot_attachment_id":"AT-uploaded",…}
    ```
  - **ما جرّبناه:** هب حقيقي مع الباب الخارجي، وتشغيل ⁨Computer Use⁩ على ماك، وبروفايل تطبيق الهارنس المكتبي، ونافذة الموافقة في ويندوز وماك.

- **بعد الدمج (⁨feat/dsh-plugin⁩)، 2026-11-22، محلياً:**

    ```
    $ pnpm contracts:lint
    contracts:lint  validating 98 event schema file(s)
    contracts:lint  OK
    $ pnpm contracts:compat
    contracts:compat  OK — no breaking change against v1.1.10
    $ pnpm contracts:check-clients
    check-clients  OK — 1189 client file(s) scanned, 289 contract path(s) known.
    $ pnpm i18n:check
    i18n:check  OK
    $ pnpm typecheck   # exit=0
    $ pnpm lint        # exit=0
    $ pnpm change-record:check
    change-record  OK — 1 record(s) valid
    $ vitest --project contract tests/contract/contract.test.ts
     Test Files  1 passed (1)
          Tests  398 passed (398)
    $ (packages/dsh-plugin) vitest run
     Test Files  11 passed (11)
          Tests  64 passed (64)
    ```

### بعد أول تجربة على ماك المالك (2026-11-22، ⁨feat/dsh-plugin⁩)

- **ملاحظات المالك** (مربوط بهبه الحقيقي، وكل شي يشتغل وظيفياً: مزوّد كور هب، و⁨/hermes⁩، واتصال الجهاز، ومهام الشاشة):
  1. ‎`/corehub link`‎ يختفي بعد الإرسال، والنتيجة سطر صغير مطوي بشكل الطرفية، فكأن ما صار شي.
  2. رد هيرمس من ‎`/hermes`‎ يطلع سطر أوامر مطوي: ‏Markdown‏ خام (`**` ظاهرة) والعربي مكسور الاتجاه. «طريقة الرد غريبة».
  3. صفحة الإضافة في الهارنس (الإضافات ← ‎@corehub/dsh-plugin‎) ما فيها نموذج إعدادات أصلاً، وكان ‎`/corehub status`‎ يقول «الإضافات ← كور هب ← المجلدات المشاركة».
- **السبب في (3):** الهارنس ما يرسم نموذجاً من مخطط إعدادات الإضافة بنفسه. الصفحة تظهر فقط إذا سجّل النصف المتصفّحي للإضافة صفحة في ‎`plugins.bundle.config`‎ أو ‎`plugins.row.config`‎ (‏README‏ حزمة ‎dsh-client-ui-plugin-manager‎). والإضافة ما كان لها نصف متصفّحي.
- **ما تغيّر:**
  - **نصف متصفّحي للإضافة** (`src/client/`، يُبنى إلى `dist/client.js` ويُعلن في `dsh.client`): يسجّل نفسه عند محمّل الوحدات في الصفحة كما تصفه تعريفات ‎dsh-client-modules‎ المنشورة، ويأخذ ‏React‏ فقط من جدول الوحدات المشترك.
  - **صفحة «كور هب»** في صفحة الإضافات (صفحة الحزمة، ونفسها خلف زر «Configure» لصف `corehub`): لصق كود الربط وزر «اربط» مع نتيجة واضحة (نجاح أخضر أو سبب الرفض بالأحمر)؛ حالة الربط (الهب، المستخدم، الجهاز، الاتصال، صلاحية المفتاح، عدد الموديلات) مع «حدّث الموديلات» و«اربط من جديد» و«فك الربط»؛ المجلدات المشاركة (منتقي المجلدات حق الهارنس إذا موجود، أو كتابة المسار، وكتابة/قراءة، وإزالة)؛ فتح الملفات والروابط؛ كل خادم ‏MCP‏ في البروفايل مع مفتاح وبروفايلات الهب؛ بروفايل ‎/hermes‎؛ مهام الشاشة وموديلها؛ اللغة؛ آخر النشاط. كل تغيير ينحفظ فوراً.
  - **الصفحة تكلّم الإضافة** عبر مسارات ‏Fetch‏ مضبوطة على قناة ‎`/api`‎ المصادق عليها في الهارنس (`/api/corehub/state|link|unlink|models|settings|pick-folder`، `panel.ts`) — يوصلها مالك الهارنس فقط، والمفتاح ما يوصل الصفحة أبداً. جرّبنا أولاً ‎`ctx.connection.rpc.intercept`‎ فعطّل بوابة ‏Remote‏ كلها (كل ‎/api/*‎ صار 404)، فتركناه.
  - **بطاقات المحادثة** في ‎`conversation.chat.commandview`‎ (مفتاحها اسم الأمر): رد هيرمس يُعرض كرد محادثة مفتوح بعنوان «هيرمس · كور هب»، و‏Markdown‏ مرسوم (في البداية بقارئ خاص بالإضافة، ثم بمرسِّم الهارنس نفسه — انظر السطر التالي) وكل فقرة/بند/خلية بـ `dir="auto"`. ونتيجة ‎/corehub‎ واضحة: صدى ‎`/corehub link ••••`‎ (الكود ما يُسجَّل ولا يُعرض)، وعلامة ✓ خضراء أو ✕ حمراء، وزر «افتح إعدادات كور هب».
  - **نص النتيجة** يبدأ بسطر تعليق ‏Markdown‏ (`[//]: # (corehub link ar)`) يحمل الأمر الفرعي واللغة (`outcome.ts`)، لأن ‎/corehub‎ ما يسجّل مدخله. والربط الفاشل صار نتيجة `error` (كان `success`).
  - ‎`/corehub status`‎ و`help` صاروا قائمة ‏Markdown‏، ويقولون إن الإعدادات في صفحة الإضافات ← كور هب.
  - كل نصوص الواجهة بالعربي والإنجليزي (`ui-strings.ts`)، ولغة الصفحة تتبع إعداد `language` ثم لغة المتصفح؛ والمصطلحات اللاتينية في الجمل العربية معزولة بـ ‏LRI/PDI‏.
  - ما لمسنا `hermes.ts` ولا أداة `corehub_ask_agent` (عند وكيل ثاني).
  - **الإصدار ما تغيّر (1.1.10):** قاعدة المستودع رقم واحد لكل الحزم (`scripts/version-check.mjs`)، فاسم الملف نفسه. التثبيت فوق نسخة مثبتة يرفضه الهارنس، فلازم «Uninstall» ثم التثبيت (مكتوب في ‏README‏).
- **الفحوص الفعلية:**

    ```
    $ pnpm --filter @corehub/dsh-plugin typecheck   # exit=0 (tsconfig.json + tsconfig.client.json + tsconfig.test.json)
    $ npx vitest run --maxWorkers=2   (packages/dsh-plugin)
     Test Files  15 passed (15)
          Tests  86 passed (86)
    $ npx eslint packages/dsh-plugin   # exit=0
    $ npx prettier --check packages/dsh-plugin
    All matched files use Prettier code style!
    ```

  - اختبارات جديدة: `outcome.test.ts` و`markdown.test.ts` و`panel.test.ts` (المالك فقط، الربط، تنظيف الإعدادات، ردّ ‏Fetch‏) و`ui-strings.test.ts` (تطابق العربي والإنجليزي).
  - **تجربة حقيقية في ‎`dsh web`‎** (‏0.2.2-rc.5‏، ‏DSH_HOME‏ معزول تحت ‎~/.cache/dsh-dev‎، هب بديل محلي، ‏Chromium‏ بدون واجهة): الوحدة `@corehub/dsh-plugin` ظهرت في رسم الإقلاع؛ الصفحة ظهرت تحت ‏README‏ الحزمة؛ الربط بكود غلط أعطى «Linking failed: The code is wrong.» بالأحمر، وبالكود الصحيح ربط وكتب الموديلات (2)؛ إضافة مجلد وجعله قابلاً للكتابة انكتب في `cordis.patch.yml`؛ فك الربط من الصفحة؛ في المحادثة: ‎/corehub status‎ و‎/corehub link‎ (نجاح وفشل) و‎/hermes‎ برد عربي فيه قائمة وجدول وكود، بالعربي والإنجليزي. كود الربط ما ظهر في أي ملف تحت ‏DSH_HOME‏، والمفتاح فقط في `link.json`. الصور في ‎`corehub-dsh-build/screens/`‎ (خارج المستودع).
  - **شكل الهارنس نفسه (طلب المالك بعد الصور):** الصفحة وبطاقات المحادثة صارت تستخدم مكتبة واجهة الهارنس المشتركة `@deepseek-ai/dsh-client-ui-primitives` من جدول الوحدات المشترك (‏README‏ الحزمة: «المكان الوحيد اللي يتشارك فيه عنصر تحكم»، وتعريفاتها المنشورة 0.2.2-rc.5): ‏Button‏ و‏Input‏ و‏Switch‏ و‏Checkbox‏ و‏Menu‏ (للاختيارات) و‏Modal‏ (تأكيد فك الربط) و‏Toast‏ (انحفظ) و‏StateDot‏ و‏Tag‏ و‏PathLabel‏ و‏CommandText‏ و‏UserMessageBubble‏ (سؤال ‎/hermes‎) و‏MarkdownText‏ (رد هيرمس، مع `dir="auto"` على كل كتلة بعد الرسم). الترتيب فقط بـ CSS من متغيرات الثيم `--dsw-*` (`docs/web-styling.md`، و`docs/ui-radius.md` لمادة بطاقة الإعدادات) بدون أي لون مكتوب، فالفاتح والداكن يتبعون الهارنس. انحذف القارئ الخاص `markdown.ts` واختباره. تحقّقنا في ‎`dsh web`‎ بالفاتح والداكن وقارنّا بصفحات الهارنس نفسه (‏Web search and fetch‏، ‏Agent loop‏): الصور `20-`…`23-` و`native-*` في ‎`corehub-dsh-build/screens/`‎. الفحوص: typecheck ‏exit=0‏، ‏vitest‏ `Test Files 14 passed (14)` و`Tests 80 passed (80)`، ‏eslint‏ و‏prettier‏ نظيفين.
  - **ما جرّبناه:** تطبيق الهارنس المكتبي على ماك، ومنتقي المجلدات الأصلي (لينكس هنا بدون منتقي)، وخوادم ‏MCP‏ حقيقية في الصفحة، والوضع الداكن.

## المخاطر والرجوع
- **الهارنس معاينة للمطورين:** نسخة كل يوم إلى خمسة أيام، وفيها تغييرات كاسرة. الإضافة مثبّتة على النسخ المجرَّبة.
- **الباب الخارجي سطح جديد على منفذ الهب:** مطفي افتراضياً، ومربوط بمفتاح شخص، ومحدود، ومسجَّل.
- **الرجوع:** إطفاء الباب الخارجي، وإزالة الإضافة من الهارنس. التطبيق ما تغيّر.

## التسليم والخطوة التالية
- **الحين:** كتابة القرار، ثم تنفيذ جهة الهب وجهة الإضافة.

- **جهة الإضافة (⁨feat/dsh-plugin-pkg⁩):** الحزمة جاهزة وما انرفعت. الخطوة التالية: تجربتها على ماك المالك مع هب فيه الباب الخارجي مفتوح، ثم مهمة شاشة حقيقية.
- **انحلّت:** `dsh` انضافت لـ`DeviceProgram.source`. الهب اللي فيه هذا الفرع يقبل برامج الهارنس، والهب الأقدم يرفضها، فترسل الإضافة التقرير بدونها.
- **مخالفة للقرار مكتوبة:** جلسة الشاشة تشتغل كعملية منفصلة بالمشغّل الأحادي (`dsh-headless`) لأن الهارنس ما يعطي الإضافة طريقة موثّقة تبدأ جلسة ⁨PTC⁩ داخل العملية؛ والموافقة في الغالب نافذة النظام لأن سؤال الهارنس مربوط بمحادثة.
- **الخطوة التالية:** طلب دمج واحد لـ⁨feat/dsh-plugin⁩. بعده يجرّب المالك على الماك: يشغّل الباب الخارجي، ويثبّت الإضافة، ويربط بكود الربط، ثم يجرّب الموديلات و⁨/hermes⁩ والملفات ومهمة شاشة.
- **بعد ملاحظات الماك:** نصف متصفّحي للإضافة (صفحة كور هب في الإضافات، وبطاقات ‎/corehub‎ و‎/hermes‎). الخطوة التالية: المالك يشيل الإضافة من صفحة الإضافات (Uninstall) ويثبّت الملف الجديد في تطبيق الهارنس، ويجرّب الصفحة والبطاقات على الماك.


## إصلاح منفصل: سؤال وكيل الهب الطويل (`corehub_ask_agent`) — فرع ⁨feat/dsh-plugin-ask⁩
المسؤول: twuijri · الفرع: feat/dsh-plugin-ask · الحالة: review · 2026-11-22

### المشكلة (تجربة حقيقية على ماك المالك، الهارنس بوضع ⁨PTC⁩، والهب الحقيقي)
- المالك سأل مرة وحدة، وموديل الهارنس نادى `corehub_ask_agent` داخل `run_code`.
- ⁨Hermes⁩ في الهب احتاج ٢٫٥ إلى ٤ دقايق (٢٨ خطوة أدوات).
- مهلة `run_code` الافتراضية ١٢٠ ثانية (‏README حق `dsh-tool-executor-ptc` و`dsh-ptc-runtime-node`: ‏`timeoutMs` ‏120,000 وسقفه 600,000) قطعت النداء، فسأل الموديل سؤال أقصر.
- النتيجة: رسالتين في محادثة الهب وجوابين كاملين من ⁨Hermes⁩، والهارنس عرض الثاني بس. شغل مضاعف وجواب ضايع.

### الإصلاح
- **السؤال يُتابَع بعيد عن النداء** (`src/ask-runs.ts`): الإضافة ترسل الرسالة مرة وحدة، وتتابع التشغيل في حلقة ما يوقفها إلغاء الهارنس (حتى ٣٠ دقيقة، مع إعادة محاولة لو فشل استعلام)، وتحفظ الجواب لين يوصل لموديل الهارنس.
- **الآلية المختارة: مهام الهارنس الخلفية (`ctx.jobs`)**، من وثائقه:
  - `docs/subsystems/jobs.md`: ‏`ctx.jobs.start({ kind, label, owner, run })`، ومعرّف الجلسة هو `Agent.id` (`SessionId` في تعريفات `dsh-agent`)، و`wait` اللي يلقط التسوية يخليها `awaited`.
  - `packages/jobs/tool-jobs/README.md`: لما تخلص مهمة يملكها وكيل يوصله إشعار فيه `result`، ويقرأها `job_output`، والتسوية اللي لقطها `wait` ما يجي لها إشعار.
  - السؤال يصير مهمة باسم الجلسة: لو الجواب جا خلال ٤٥ ثانية يرجع في النداء نفسه (والمهمة تنشال بدون إشعار)، ولا يرجع النداء فوراً بـ`running` ومعرّف المهمة، والجواب يوصل بإشعار المهمة أو بـ`job_output`.
  - **البديل لو الهارنس رفض المهمة** (ما فيه `tool-jobs` أو ما فيه وكيل): النداء ينتظر حتى ٩٠ ثانية ثم يرجع `running` مع `run_id`، وأداة جديدة `corehub_agent_result(run_id, wait?, wait_seconds?)` تجيب الجواب (تنتظر ٦٠ ثانية افتراضياً، وحدها ٥٤٠).
- **منع التكرار:** سؤال واحد شغّال لكل جلسة هارنس. نداء جديد وهو شغّال ما يرسل رسالة: يرجع المهمة الشغّالة (أو ينتظر جوابها لو ما فيه مهمة). والجواب اللي ما وصل للموديل (نداؤه انقطع) يُعطى للنداء اللي بعده بدل ما يُسأل الهب من جديد. `force_new: true` بس لسؤال مختلف بوضوح.
- **إلغاء المهمة** (`job_kill` أو إغلاق الجلسة) يوقف المهمة بس، وتشغيل الهب يكمل، وجوابه يبقى في محادثة كور هب ويقدر `corehub_agent_result` يجيبه.
- **وصف الأداتين:** ⁨Hermes⁩ ياخذ دقايق؛ لا تعيد السؤال؛ ولو تنتظر داخل `run_code` ارفع `timeoutMs` لين ٦٠٠٠٠٠.
- **علامة الهارنس:** العقد ما فيه حقل مصدر أو بيانات إضافية في `RunCreate`، و`Message.author` دايماً الشخص لرسالة المستخدم، فما غيّرنا العقد. الرسالة اللي يكتبها موديل الهارنس تبدأ بـ `↪ DeepSeek Harness:` ثم سطر فاضي. رسائل `/hermes` اللي يكتبها المالك بنفسه تبقى بدون علامة.

### الملفات
- جديد: `packages/dsh-plugin/src/ask-runs.ts`، `packages/dsh-plugin/src/ask-tool.ts`، `packages/dsh-plugin/tests/ask-runs.test.ts`.
- تعديل: `src/hermes.ts` (فصل `start` و`follow`، والعلامة، وتباعد الاستعلام من ١٫٥ إلى ٥ ثواني)، `src/host.ts` (نوع `JobRegistry` الضيق و`rootCallId`)، `src/index.ts` (حقن `jobs` وتسجيل الأداتين)، `src/names.ts`، `src/i18n.ts` (شلنا مفتاحي وصف الأداة؛ الوصف صار في `ask-tool.ts` بالإنجليزي لأنه للموديل)، `tests/hermes.test.ts`، `README.md`.
- ما لمسنا ملفات صفحة الإعدادات ولا رد `/corehub` ولا عرض `/hermes`.

### الفحوص (محلياً على لينكس، 2026-11-22)
```
$ pnpm --filter @corehub/dsh-plugin typecheck        # exit=0
$ (packages/dsh-plugin) npx vitest run --maxWorkers=2
 Test Files  12 passed (12)
      Tests  83 passed (83)
$ npx eslint packages/dsh-plugin                     # exit=0
$ npx prettier --check packages/dsh-plugin
All matched files use Prettier code style!
```
- **تجربة حقيقية مع الهارنس ⁨0.2.2-rc.5⁩** بوضع ⁨PTC⁩ (`tool-executor-ptc` مفعّل و`native` مطفي)، ⁨DSH_HOME⁩ معزول في `~/.cache/dsh-dev/home-ask`، بالمشغّل الأحادي `dsh --profile askptc --json`، وهب بديل محلي يجاوب بعد ١٥٠ ثانية وموديل مبرمج على بوابته:
```
04:37:15 → 04:39:49   exit 0
hub: HUB MESSAGE R1 "↪ DeepSeek Harness:\n\nWhat did I work on last week? Use your memory."
tool_result (≈45 s): {"ok":true,"state":"running","answer":"… background job corehub-b5c03c108bba4386 …"}
tool_result: {"text":"HUB-ANSWER-OK for R1 after 150 s","job":{…,"status":"completed",…}}
final: "Final: the hub answered (HUB-ANSWER-OK for R1 after 150 s)."
GET /hub-messages → {"posted":["↪ DeepSeek Harness:\n\nWhat did I work on last week? Use your memory."]}
```
- **تجربة إعادة السؤال** (الموديل المبرمج يسأل سؤال أقصر بعد `running`، والهب يجاوب بعد ١٣٠ ثانية):
```
04:40:11 → 04:42:25   exit 0
tool_result: {"ok":true,"state":"running","answer":"This is your earlier question “What did I work on last week? Use your memory.”; no new message was sent to the hub. …"}
final: "Final: the hub answered (HUB-ANSWER-OK for R1 after 130 s)."
GET /hub-messages → {"posted":["↪ DeepSeek Harness:\n\nWhat did I work on last week? Use your memory."]}
```
  رسالة وحدة في الهب في التجربتين، والجواب وصل. (نداء `job_output` واحد في التجربة الأولى فشل لأن الموديل المبرمج قص المعرّف مع فاصلة منقوطة؛ خطأ في البديل، مو في الإضافة.)

### ما ما جرّبناه والحدود
- ما جرّبنا على ماك المالك ولا مع هب حقيقي ولا ⁨Hermes⁩ حقيقي.
- ما جرّبنا إيقاظ وكيل خامل بإشعار المهمة في `dsh web` (المشغّل الأحادي يخلص بعد الدور؛ جرّبنا وصول الجواب بـ`job_output`). وما جرّبنا المسار البديل (`corehub_agent_result`) في الهارنس الحقيقي، بس في اختبارات الوحدة.
- حالة الأسئلة في الذاكرة بس: إعادة تشغيل الهارنس تنسى الأسئلة الشغّالة، والجواب يبقى في محادثة كور هب.
- **الخطوة التالية:** المالك يجرّب على الماك نفس السؤال الطويل، ويتأكد إن محادثة الهب فيها رسالة وحدة بعلامة الهارنس.

### تجربة مهمة الشاشة على ماك المالك (2026-11-22)
- **المشكلة:** مهمتين شاشة انتهوا بـ`device_timeout`، وما طلعت للمالك أي نافذة موافقة.
- **السبب:** الإضافة كانت تسأل الموافقة أول عن طريق سؤال الهارنس (`userQuestions`). والسؤال هذا ما يوصل إلا لمحادثة في الهارنس. أما طلب الهب فما له محادثة، فبقي السؤال معلّق وما شافه أحد، لين انتهت مهلة الهب.
- **التصليح:** موافقة أي طلب جاي من الهب صارت دايماً بنافذة النظام نفسه: `osascript` في الماك، ونافذة الرسائل في ويندوز، و`zenity`/`kdialog` في لينكس. وانشال ربط `userQuestions` لأنه ما عاد له استخدام.
- **الفحوص:** `typecheck` exit 0، و`eslint` نظيف، و`vitest` ⁨15⁩ ملف / ⁨99⁩ اختبار نجحوا.
