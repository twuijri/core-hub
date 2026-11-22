# إضافة كور هب لـ DeepSeek Harness: الهارنس في جهاز الشخص، مربوط بالهب
المسؤول: twuijri · الفرع: feat/dsh-plugin · الحالة: in-progress

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

## المخاطر والرجوع
- **الهارنس معاينة للمطورين:** نسخة كل يوم إلى خمسة أيام، وفيها تغييرات كاسرة. الإضافة مثبّتة على النسخ المجرَّبة.
- **الباب الخارجي سطح جديد على منفذ الهب:** مطفي افتراضياً، ومربوط بمفتاح شخص، ومحدود، ومسجَّل.
- **الرجوع:** إطفاء الباب الخارجي، وإزالة الإضافة من الهارنس. التطبيق ما تغيّر.

## التسليم والخطوة التالية
- **الحين:** كتابة القرار، ثم تنفيذ جهة الهب وجهة الإضافة.
