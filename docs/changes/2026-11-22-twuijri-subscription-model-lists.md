# اشتراك ChatGPT في الهب يعرض نماذج أقل وأقدم من CLIProxyAPI نفسه
المسؤول: twuijri · الفرع: fix/subscription-model-lists · الحالة: review

## المشكلة والهدف
- **البلاغ (المالك، 2026-11-22):** «البروكسي الحقيقي يعطيني 17 نموذج ChatGPT، والهب يعرض 13 — وهذا من يوم أضفنا الاشتراكات». قائمة الهب فيها `gpt-5.5` اللي ما عاد موجود في كتالوج CLIProxyAPI الحالي، وتنقصها أحدث النماذج.
- **السبب الحقيقي (بالدليل):** الهب يشغّل CLIProxyAPI بالخيار `-local-model` (`gateway/cliproxy.ts`، وموثّق في DECISIONS §140 «no remote model catalogue»).
  - في مصدر 8.0.4 (`cmd/server/main.go`): `-local-model` = «Use embedded models.json and codex_client_models.json only, skip remote model catalog fetching»؛ و`modelCatalogUpdaterPlan` يرجع `false, false, false` معه، فلا يُجلب `models.json` ولا `codex_client_models.json` أبدًا.
  - فيبقى الهب على الكتالوج المضمّن في إصدار 8.0.4 للأبد: `codex-pro` فيه 8 نماذج (`gpt-5.5`، `gpt-6-astra`، `gpt-6-sol`، `gpt-6-luna`، `gpt-5.6-sol`، `gpt-5.6-terra`، `gpt-5.6-luna`، `codex-auto-review`).
  - CLIProxyAPI يضيف لكل حساب Codex خمس نماذج صور ثابتة (`WithCodexBuiltins`: `gpt-image-1.5`، `gpt-image-2`، `gpt-image-2.5`، `-flare`، `-sunburst`) → **8 + 5 = 13** (رقم الهب).
  - الكتالوج المنشور اليوم فيه 12 لـ `codex-pro` → **12 + 5 = 17** (رقم بروكسي المالك).
- **سبب ثانٍ أصغر:** حتى بعد الجلب، الهب يقرأ قائمة الاشتراك مرة واحدة عند تسجيل الدخول، ثم لا يقرأها إلا إذا ضغط الشخص «تحديث النماذج». وCLIProxyAPI يحدّث كتالوجه بعد التشغيل بثوانٍ وكل 3 ساعات، فقراءة لحظة التشغيل قد تكون القائمة المضمّنة (أو فارغة قبل تسجيل الحساب).
- **ما ليس سببًا:** لا فلتر في الهب يُسقط نماذج (`models(prefix)` يأخذ كل ما تحت `h<row>/`)؛ بيئة الهب لا تمنع الاتصال (الصورة فيها `ca-certificates` وتورث `HTTPS_PROXY` إن وُجد).
- **الهدف:** اشتراك ChatGPT (وكل اشتراك عبر CLIProxyAPI) يعرض ما يعرضه CLIProxyAPI نفسه الآن، ويتبعه تلقائيًا إذا تغيّر.

## القرار والموافقات
- **المهمة من المالك (2026-11-22):** إصلاح القائمة، أضيق تغيير صحيح.
- **القرار:**
  1. CLIProxyAPI الشغّال ما عاد يأخذ `-local-model`: يجلب كتالوجه المنشور (`router-for-me/models` على GitHub، واحتياطيًا `models.router-for.me`؛ JSON عام بلا حساب ولا مفتاح) عند التشغيل وكل 3 ساعات، ويبقى على المضمّن إذا فشل الجلب (هب بلا إنترنت). عملية تسجيل دخول ChatGPT المؤقتة (`-codex-device-login`) تبقى بـ `-local-model` لأنها لا تخدم نماذج.
  2. الهب يتبع الكتالوج: مع قراءة الاشتراكات كل دقيقة، أي صف اشتراك تختلف معرّفات نماذجه المخدومة عن المخزّنة يأخذ القائمة الجديدة (النماذج اللي اختفت تُؤرشف مثل «تحديث النماذج»). لا يعمل في أول دقيقتين من عمر عملية CLIProxyAPI (قد يكون الجلب الأول لم يصل)، ولا يشغّل CLIProxyAPI ليعرف، ويترك الصف إذا كان تحديثه جاريًا أو لم يُخدم شيء.
  3. **رفع النسخة إلى v8.1.0: مؤجَّل** لطلب مستقل. ليس لازمًا لهذا العطل (الجلب على 8.0.4 أعطى 17 بالضبط)، وبين 8.0.4 و8.1.0 سبعة وسبعون إصدارًا فيها تغييرات في واجهة الإدارة اللي يستدعيها الهب (مثل 8.0.5 «remove deprecated credential quota endpoints from v8 API»، 8.0.29 نقل إعداد `tls-handshake-timeout-seconds`، 8.0.44 إلغاء `discovery advertise-management`) — يحتاج قراءة ومراجعة واختبارات حقيقية كاملة (ADR 0027).
  4. **مراقبة إصدارات CLIProxyAPI:** يوجد نمط مراقبة (`hermes-watch.yml`، `models-catalog-watch.yml`)، فأضفت `cliproxy-watch.yml` على شكل الأبسط منهما: أسبوعيًا، تذكرة واحدة مفتوحة ما دام هناك إصدار أحدث من المثبّت، بلا رفع تلقائي للنسخة.
- **التوثيق:** تعديل مؤرخ على DECISIONS §140 (وإشارة في §143)، وقسم «The CLIProxyAPI watch» في `docs/RELEASING.md`.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- لا شيء.

## الملفات والتأثير
- `packages/server/src/modules/models/gateway/cliproxy.ts`: حذف `-local-model` من العملية الشغّالة؛ `readyAt` لكل عملية و`runningForMs()`.
- `packages/server/src/modules/models/gateway/cliproxy-login.ts`: تعليق فقط (لماذا يبقى `-local-model` هناك).
- `packages/server/src/modules/models/gateway/gateway.ts`: `runningForMs` في واجهة الاشتراكات.
- `packages/server/src/modules/models/subscriptions.ts`: `runningForMs?()` اختياري في `SubscriptionBackend`.
- `packages/server/src/modules/models/service.ts`: `followSubscriptionCatalogues()` و`SUBSCRIPTION_CATALOGUE_SETTLE_MS` (دقيقتان)؛ استخراج `storeCatalogue()` من `refreshProvider` (نفس السلوك) ليستعمله الاثنان.
- `packages/server/src/modules/models/index.ts`: قراءة الدقيقة تنادي `followSubscriptionCatalogues` بعد `syncSubscriptionRows`.
- اختبارات: `gateway/subscriptions.test.ts` (اختبار جديد)، `gateway/subscriptions.real.test.ts` (كتالوج بديل يُجلب من الثنائي الحقيقي)، `gateway/testing/fake-cliproxy-accounts.mjs` (`FAKE_CLIPROXY_CATALOGUE`)، `gateway/testing/vendor-mitm.ts` (`raw.githubusercontent.com`).
- `.github/workflows/cliproxy-watch.yml` (جديد)، `docs/RELEASING.md`، `docs/contracts/DECISIONS.md`.
- **الأثر على الناس:** بعد التحديث، CLIProxyAPI يتصل بـ GitHub عند التشغيل وكل 3 ساعات لجلب ملف JSON عام (كان أصلًا يسأل GitHub عن نسخة Antigravity بنفس الوتيرة). صفوف المفاتيح لا تتغير: نماذجها هي اللي في ملف الإعداد. لا تغيير في الصورة ولا حجمها ولا الترحيلات.

## الفحوص (الأوامر ونواتجها الفعلية)
- **إعادة إنتاج بالثنائي الحقيقي 8.0.4** (`~/.cache/corehub/cliproxy/8.0.4/linux-x64/cli-proxy-api`، إعداد مثل إعداد الهب، حساب Codex وهمي خطته `pro` وبادئته `htest`، قراءة `/v1/models` عند الجاهزية وبعد 20 ثانية):
  ```
  -local-model, t0:   0  []
  -local-model, t20: 13  [... gpt-5.5 ... 5 × gpt-image-*]
  بدونه, t0:         13  (نفس القائمة المضمّنة)
  بدونه, t20:        17  [gpt-6.2-astra, gpt-6.2-sol, gpt-6.1-sol, gpt-6.1-terra, gpt-6-chat-thinking, ... 5 × gpt-image-*]  (بلا gpt-5.5)
  log: startup model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json, changes detected for providers: [... codex ...]
  log: re-registered models for 1 auth(s) due to model catalog changes
  ```
- `COREHUB_REAL_GATEWAY=1 npx vitest run --maxWorkers=2 src/modules/models/gateway/subscriptions.real.test.ts` → `Tests 4 passed (4)`. وبإرجاع `-local-model` مؤقتًا: `× signs in to ChatGPT …` `AssertionError: expected false to be true` (`Tests 1 failed | 3 passed`) — الاختبار يمسك العطل.
- `COREHUB_REAL_GATEWAY=1 npx vitest run --maxWorkers=2 gateway-stream.real.test.ts codex-subscription.real.test.ts agents/model-gateway.real.test.ts` → `Test Files 2 passed | 1 skipped (3)`، `Tests 32 passed | 9 skipped (41)` (المتخطّى: مرحلة `COREHUB_REAL_GATEWAY_ALL` واختبار اشتراك Codex عبر هرمز).
- `npx vitest run --maxWorkers=2 src/modules/models/gateway models-api.test.ts models.test.ts codex-subscription.test.ts fallback-signin.test.ts` → `Test Files 12 passed | 2 skipped (14)`، `Tests 140 passed | 15 skipped (155)`.
- `pnpm typecheck` → exit 0.
- `pnpm lint` → exit 0، `All matched files use Prettier code style!`.
- `node scripts/check-change-record.mjs --base origin/main` → `change-record  OK — 1 record(s) valid`.
- منطق مقارنة النسخ في `cliproxy-watch.yml` جُرّب محليًا (قراءة فقط): `Pinned: 8.0.4; newest stable release: 8.1.0`، `behind=77`.

## المخاطر والرجوع
- **اتصال خارجي جديد:** إن كان الهب بلا إنترنت يفشل الجلب بصمت (سطر تحذير في سجل `cliproxy`) ويبقى على الكتالوج المضمّن — نفس سلوك اليوم.
- **كتالوج منشور خاطئ:** CLIProxyAPI يتحقق منه (`validateModelsCatalog`) قبل استعماله؛ والهب لا يتبع قائمة فارغة.
- **نموذج اختفى من الكتالوج ومختار لوكيل:** يُؤرشف كما يحدث اليوم عند «تحديث النماذج». هذا مقصود: CLIProxyAPI نفسه لم يعد يخدمه.
- **غير متحقَّق منه:** حساب ChatGPT حقيقي (لا يمكن تسجيل الدخول هنا) — أن النماذج الجديدة (`gpt-6.2-*` مثلًا) تجيب فعلًا عبر تنفيذ Codex في 8.0.4. الكتالوج بيانات فقط، والطلب يمرّر اسم النموذج كما هو، لكن لم يُجرَّب بحساب حقيقي. ولم يُشغَّل `cliproxy-watch.yml` على GitHub.
- **الرجوع:** revert للالتزام؛ يعود الهب للكتالوج المضمّن.

## التسليم والخطوة التالية
- الفرع جاهز للمراجعة (لم يُدفع). بعد دمج المالك: دمج في `test` وبناء صورة التست حسب TEAM-RULES.
- **بعد التحديث:** لا شيء مطلوب من المالك؛ خلال دقيقتين إلى ثلاث من تشغيل الهب تتحدث قائمة اشتراك ChatGPT وحدها. الضغط على «تحديث النماذج» بعد دقيقة من التشغيل يعطي نفس النتيجة فورًا.
- **التالي:** طلب مستقل لرفع CLIProxyAPI إلى 8.1.0 (قراءة ملاحظات 77 إصدارًا، مقارنة نداءات الإدارة، الاختبارات الحقيقية كاملة)؛ تذكرة `cliproxy-watch` ستذكّر به.
