# بوابة النماذج، المرحلة الأولى: كل وكيل برمجي يعمل على أي نموذج مضاف في المركز
المسؤول: twuijri · الفرع: feat/model-gateway (فوق batch/2026-09-29d، PR #229) · الحالة: review

## المشكلة والهدف
هدف المالك بكلماته: أي وكيل في كور هب يكلّم أي نموذج مضاف مرة واحدة في المركز. قبل هذا كان المركز يعطي كل وكيل برمجي
مفتاح مزوّده فقط (Claude Code مفتاح Anthropic، وCodex مفتاح OpenAI)، والنموذج الذي يختاره الشخص في المنتقي لوكيل برمجي
لا يُطبَّق أصلًا (`acp.ts` يتجاهله). والوكلاء يتكلمون ثلاث لغات سلكية مختلفة (Anthropic Messages وOpenAI Responses
وOpenAI Chat Completions) وأغلب المزوّدين يتكلمون واحدة أو اثنتين.

وافق المالك (2026-09-29) على التصميم الهجين: بوابة من المركز نفسه في الأمام، وCLIProxyAPI (MIT، ملف Go واحد) خلفها مترجمًا.
وقواعده: في Docker كل وكيل برمجي على البوابة افتراضيًا؛ على سطح المكتب الوكيل المسجَّل دخوله بحسابه يبقى على حسابه ما لم يُحوَّل؛
اشتراكات هرمز (ChatGPT وغيرها) لا تُعار لوكلاء آخرين؛ ميزات تسجيل الدخول بالاشتراك في CLIProxyAPI مطفأة؛ المفاتيح الحقيقية لا تصل للوكلاء أبدًا.

## القرار والموافقات
ADR 0029 (معتمد من المالك 2026-09-29) وDECISIONS §140 (تفاصيل المرحلة الأولى: مقترح — بانتظار تأكيد المالك):

- **CLIProxyAPI 8.0.4 مثبّت بالبصمة** (`scripts/cliproxy/pin.json` + `scripts/cliproxy/fetch.mjs` يرفض أي ملف بصمته مختلفة):
  في الصورة في مرحلة بناء خاصة إلى `/opt/corehub/bin` (ملك root، للقراءة فقط)، وفي كل مثبّت سطح مكتب في `resources/cliproxy/`
  (after-pack)، وللمطوّر `pnpm cliproxy:fetch`. ملف رخصته بجانبه (`LICENSE.CLIProxyAPI`) وإشعاره في `THIRD-PARTY-NOTICES.md`.
  **القرار: داخل المثبّت لا تنزيل عند أول استخدام** — الزيادة 16–24 ميجابايت لكل مثبّت (مقاسة) ضمن ميزانية المالك (100–300)، يعمل بلا إنترنت،
  ولا يضيف مسار «نزّل وشغّل» وقت التشغيل.
- **المشرف** (`modules/models/gateway/cliproxy.ts`) مثل مشرف بوابة هرمز: loopback فقط، منفذ عشوائي، مفتاح داخلي عشوائي يعرفه المركز
  وحده، إعادة تشغيل بتأخير متزايد، سطوره في سجل المركز تحت `cliproxy`، ويتوقف مع المركز. يُشغَّل أول مرة يحتاجه وكيل.
  ملف إعداده يُولَّد من مزوّدي المركز (كل صف مجموعة بادئتها `h<معرّف الصف>`)، مفاتيحه في ملف 0600 داخل `<DATA_DIR>/gateway/` (0700)،
  وواجهة إدارته ولوحة تحكمه وتسجيلات OAuth والإضافات والاكتشاف في الشبكة كلها مطفأة. تغيّر المزوّدين يشغّل عملية جديدة بالملف الجديد
  ويوقف القديمة بعد آخر طلب فيها (8.0.4 لا يعيد قراءة ملفه بثبات — جرّبته).
- **بوابة المركز** (`modules/models/gateway/gateway.ts`) على منفذ loopback خاص بها (ليس منفذ الـAPI): المسارات
  `/gateway/anthropic/v1/messages` (+`count_tokens` و`api/hello` و`models`) و`/gateway/openai/v1/responses` و`/chat/completions` و`models`.
  رمز جلسة لكل عملية وكيل (256 بت، في الذاكرة فقط، مربوط بالبروفايل والشخص والوكيل والمحادثة، يُسحب عند إغلاق الجلسة ويموت بموت
  العملية وينتهي بعد 24 ساعة). الأسماء `corehub-main` و`corehub-small` وأي اسم لا تعرفه تُحلّ إلى نموذج الدور الحالي (اختيار المنتقي
  وإلا الافتراضي)، ويُمرَّر الطلب إلى CLIProxyAPI بالمفتاح الداخلي والاسم `h<صف>/<نموذج>`. الإجابة تمر كما هي (تدفقًا)، وأخطاء المزوّد
  تمر كما جاءت، والاستهلاك يُقرأ منها ويُضاف لتشغيل الدور بسعر صف النموذج (`estimated`)؛ ونداء ينتهي بعد دوره يُضاف لصف ذلك التشغيل
  (`recordUsage` صار يقبل `accumulate`).
- **ربط الوكلاء عند التشغيل** (بيانات في ملف كل وكيل في الكتالوج، `gateway`؛ الستة مجرّبة حقيقيًا): Claude Code (`ANTHROPIC_BASE_URL` و`ANTHROPIC_AUTH_TOKEN`
  و`ANTHROPIC_MODEL=corehub-main` و`ANTHROPIC_DEFAULT_HAIKU_MODEL=corehub-small` و`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` …)،
  Codex (`CODEX_CONFIG` بمزوّد `corehub` على Responses، و`DEFAULT_AUTH_REQUEST` بطريقة `gateway` في codex-acp — لا `api-key` لأنها
  تكتب الرمز في `auth.json` فوق تسجيل ChatGPT)، وGoose وOpenCode وQwen Code وKimi Code بالأسماء الموثّقة في البحث.
  يُعطى الوكيل عنوان البوابة والرمز فقط: لا مفتاح من مفاتيح البروفايل، وتُحذف متغيرات المفاتيح ومسارات الاعتماد الأخرى حتى لو كانت في
  بيئة المضيف (`AgentTarget.envRemove`)، و`NO_PROXY` يضم عناوين loopback. Gemini CLI وGrok Build وPi للمرحلتين 2–3.
- **مصدر النماذج لكل وكيل** (حقل جديد في إعدادات الوكيل → النماذج: تلقائي / نماذج كور هب / حساب الوكيل نفسه):
  التلقائي في الصورة = المركز (`COREHUB_AGENT_MODEL_SOURCE=hub` في Dockerfile)، وعلى الجهاز = المركز إلا إن كان للوكيل تسجيل دخول
  أو مزوّد خاص به (`ownSignIn`). وفي كل الحالات حساب الوكيل إذا لم يكن عند المركز نموذج يعطيه (لا اختيار ولا افتراضي) — فلا ينكسر شيء
  كان يعمل. البطاقة تقول أيهما (`Agent.model_source`). تغيير المصدر يسري من الرسالة التالية (يُعاد تشغيل الوكيل). إن تعذّر تشغيل البوابة
  يعمل الوكيل على حسابه والسجل يقول السبب.
- **المنتقي**: وكيل برمجي على نماذج المركز يُعرض له ما تخدمه البوابة فقط (`Model.agent_gateway`: ليس اشتراكًا مسجّلًا عبر هرمز)،
  و«افتراضي · …» هو افتراضي البروفايل.
- **مفاتيح تشغيل جديدة**: `COREHUB_MODEL_GATEWAY` (on/off)، `COREHUB_CLIPROXY_BIN`، `COREHUB_AGENT_MODEL_SOURCE` (موثّقة في DEPLOY.md).

مقترح — بانتظار تأكيد المالك: كل ما سبق من تفاصيل المرحلة الأولى (أسماء الحقول، التلقائي على الجهاز، سلوك الرجوع لحساب الوكيل).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
إضافات فقط (`pnpm contracts:compat`: لا كسر مقابل v1.1.5): `Agent.model_source` (نص: `hub`/`agent`، اختياري) و`Model.agent_gateway`
(منطقي، اختياري). اختيار المصدر حقل في نموذج الإعدادات الذي تحمله عمليات الإعدادات الموجودة. مسارات البوابة ليست من `/api/v1`:
سطح داخلي على منفذ loopback لبرامج يشغّلها المركز، موثّق في ADR 0029 §2.

## الملفات والتأثير
- جديد: `packages/server/src/modules/models/gateway/` (`cliproxy-config.ts`، `cliproxy.ts`، `gateway.ts`، `tokens.ts`، `usage.ts`، `locate.ts`،
  واختباراتها و`testing/fake-cliproxy.mjs`)، `packages/server/src/modules/agents/gateway-models.ts`،
  `agents/model-gateway.real.test.ts`، `agents/runner-gateway.test.ts`، `audit/usage-accumulate.test.ts`،
  `scripts/cliproxy/pin.json` و`fetch.mjs`، `docs/adr/0029-model-gateway.md`، `docs/guides/any-model-any-agent.md`.
- معدَّل: `models/service.ts` (مصادر البوابة + `agent_gateway`)، `models/index.ts` (البوابة والمنفذ)، `agents/runner.ts` (الرمز لكل عملية
  والدور لكل تشغيل وإعادة التشغيل عند تغيّر المصدر)، `agents/service.ts` (`modelSourceFor` وبيئة البوابة)، `agents/adapters/acp.ts`
  (`envRemove` وحقل الإعدادات)، `agents/catalog/*` (الربط)، `agents/agent-credentials.ts` (`ownSignIn`)، `audit/service.ts` (`accumulate`)،
  `app/config.ts`، `packages/server/Dockerfile`، `scripts/image-sealed-check.mjs`، `apps/desktop` (after-pack والمسار)، الويب
  (المنتقي والبطاقة والنصوص عربي/إنجليزي)، `.github/workflows/ci.yml` (مهمة `model-gateway-real` داخل `gate`).
- الحجم: الصورة **+22.6 ميجابايت مضغوطة** (68.3 على القرص) — مقاسة ببناء المرحلة الجديدة وحدها وضغط طبقتها (gzip -6)؛
  المثبّتات **+16–24 ميجابايت** مقاسة في CI (مهمة Desktop installers على هذا الفرع مقابل v1.1.5):
  `.exe` 106.5→122.4 (+15.9)، `.deb` 100.5→118.1 (+17.6)، `.dmg` 119.6→140.5 (+20.9)، `.AppImage` 127.1→149.8 (+22.7)،
  `.msix` 155.4→179.1 (+23.7) — كلها الآن 118–179 ميجابايت.
  لم أبنِ الصورة كاملة محليًا؛ المثبّتات بُنيت في CI.

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبار الحقيقي: CLIProxyAPI 8.0.4 الحقيقي + بوابة المركز + جسرا ACP الحقيقيان (`claude-agent-acp` 0.84.0 و`codex-acp` 2.0.0)
مقابل مزوّد وهمي محلي لا يتكلم إلا Chat Completions. Claude Code كتب ملفًا بأداة `Write` بطلب من المزوّد ورجعت النتيجة في الطلب التالي،
وCodex أجاب عبر Responses، وGoose وOpenCode وQwen Code وKimi Code أجاب كل منها عبر Chat Completions بإعداد الكتالوج وحده،
والنداء بلا رمز أو برمز مسحوب رُفض، ومفتاح المزوّد لم يظهر في بيئة الوكيل ولا في سجل المركز. (أول تشغيل للأربعة فشل لأن الاختبار
نسي وسائط البروتوكول (`acp` و`--acp`) في الأمر — خطأ في الاختبار لا في الربط؛ صُحّح):

```
$ COREHUB_REAL_GATEWAY=1 COREHUB_REAL_GATEWAY_ALL=1 COREHUB_REAL_ACP_DATA=~/.cache/corehub-agent/acp-data \
    pnpm exec vitest run --project unit --maxWorkers=1 --reporter=verbose src/modules/agents/model-gateway.real.test.ts
✓ |unit| src/modules/agents/model-gateway.real.test.ts > the model gateway, for real (COREHUB_REAL_GATEWAY=1) > refuses a call with no session token, and with a revoked one 126ms
✓ |unit| src/modules/agents/model-gateway.real.test.ts > the model gateway, for real (COREHUB_REAL_GATEWAY=1) > Claude Code answers through an OpenAI-compatible provider and round-trips a tool call 519ms
✓ |unit| src/modules/agents/model-gateway.real.test.ts > the model gateway, for real (COREHUB_REAL_GATEWAY=1) > Codex answers through the Responses path 295ms
✓ |unit| src/modules/agents/model-gateway.real.test.ts > the model gateway, for real (COREHUB_REAL_GATEWAY=1) > goose answers through the Chat Completions path 4692ms
✓ |unit| src/modules/agents/model-gateway.real.test.ts > the model gateway, for real (COREHUB_REAL_GATEWAY=1) > opencode answers through the Chat Completions path 1499ms
✓ |unit| src/modules/agents/model-gateway.real.test.ts > the model gateway, for real (COREHUB_REAL_GATEWAY=1) > qwen-code answers through the Chat Completions path 944ms
✓ |unit| src/modules/agents/model-gateway.real.test.ts > the model gateway, for real (COREHUB_REAL_GATEWAY=1) > kimi-code answers through the Chat Completions path 698ms
Test Files  1 passed (1)
Tests  7 passed (7)
```

قبل ذلك جرّبت CLIProxyAPI يدويًا: ترجمة Anthropic→Chat وResponses→Chat، ونماذج بأسماء فيها «/»، وتمرير خطأ 401 من المزوّد بصيغة
Anthropic، و`count_tokens` تقديريًا دون نداء المزوّد، وأنه **لا يعيد قراءة ملفه** بعد التعديل (لذلك عملية جديدة عند كل تغيير).

اختبارات الملفات التي لمسها التغيير والقريبة منها (`--maxWorkers=2`): البوابة ومشرفها مقابل CLIProxyAPI بديل، والمركز كاملًا
(المزوّدون → ملف الإعداد، `agent_gateway`، بيئة الوكيل بلا مفاتيح، الرمز يصل للصف المختار، البطاقة والإعداد، التلقائي على الجهاز)،
والمشغّل، والسجل، والإعداد:

```
$ pnpm exec vitest run --project unit --maxWorkers=2 src/modules/agents/adapters src/modules/agents/agent-credentials.test.ts \
    src/modules/agents/agents.test.ts src/modules/agents/runner.test.ts src/modules/agents/runner-gateway.test.ts \
    src/modules/agents/bridge-rename.test.ts src/modules/agents/presets.test.ts src/modules/models src/modules/audit \
    tests/unit/config.test.ts src/modules/agents/hub-tools/hub-tools.test.ts src/modules/agents/update-policy.test.ts
RUN  v5.0.1 /home/twuijri/project/corehub-wt-mgw1/packages/server


 Test Files  46 passed | 9 skipped (55)
      Tests  566 passed | 26 skipped (592)
   Start at  02:49:44
   Duration  57.10s (tests 88%, import 8%, transform 4%)
$ pnpm --filter @corehub/server exec vitest run --project contract --maxWorkers=2
Test Files  20 passed (20)
      Tests  429 passed (429)
   Start at  02:51:26
   Duration  15.85s (tests 62%, import 28%, transform 10%)
$ pnpm --filter @corehub/contracts exec vitest run --maxWorkers=2
 Test Files  11 passed (11)
      Tests  129 passed (129)
$ pnpm --filter @corehub/web exec vitest run --maxWorkers=2 tests/agent-versions.test.tsx tests/composer.test.tsx tests/default-model-label.test.ts
      Tests  30 passed (30)
```

الفحوص العامة:

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm --filter @corehub/server typecheck && pnpm --filter @corehub/web typecheck && pnpm --filter @corehub/desktop typecheck
(بلا أخطاء)
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  OK
$ node packages/contracts/scripts/check-clients.mjs
check-clients  OK — 1142 client file(s) scanned, 268 contract path(s) known.
$ node packages/contracts/scripts/compat.mjs
contracts:compat  compared packages/contracts/openapi.yaml and 95 event schemas with v1.1.5
contracts:compat  OK — no breaking change against v1.1.5
$ node scripts/navigation-check.mjs
nav:check  OK — 41 destinations, 2 pre-auth screens (login, setup), 47 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm i18n:check
i18n:check  web: 3610 keys, ar/en in parity
i18n:check  OK
$ pnpm change-record:check
change-record  OK — 5 record(s) valid
```

حجم مرحلة الصورة الجديدة (بُنيت وحدها ثم حُذفت):

```
$ docker build -f packages/server/Dockerfile --target cliproxy -t corehub-mgw-cliproxy:test .
cliproxy: CLIProxyAPI 8.0.4 (linux-x64) verified and unpacked into /opt/corehub/bin
$ docker run --rm corehub-mgw-cliproxy:test sh -c 'du -sb /opt/corehub; tar -C / -cf - opt/corehub | gzip -6 | wc -c'
68322629	/opt/corehub
22573622
```

CI: يُستكمل بعد الدفع.

## المخاطر والرجوع
- Anthropic لا تدعم Claude Code على نماذج غير Claude: ميزات تنادي Anthropic مباشرة (WebSearch، الوضع السريع) لا تعمل هناك، والجودة
  تتبع قدرة النموذج على الأدوات. الدليل يقول ذلك.
- CLIProxyAPI برنامج خارجي يشغّله المركز: مثبّت بالبصمة، على loopback، لا يُعطى إلا ما يكتبه المركز. معروف أنه يسأل GitHub عن نسخة
  Antigravity كل ثلاث ساعات ولا مفتاح لإطفائه.
- Goose وOpenCode وQwen Code وKimi Code جُرّبت حقيقيًا بدور نصي فقط؛ نداءات الأدوات مثبتة مع Claude Code وحده. إن فشل أحدها فالرجوع لحسابه من إعداداته.
- توقيع macOS: الملف داخل الحزمة يُوقَّع مع التطبيق (electron-builder)؛ لم أتحقق من التوثيق (notarization) بعد — يظهر في أول بناء موقَّع.
- **الرجوع**: `COREHUB_MODEL_GATEWAY=off` يعيد السلوك السابق كاملًا (المفاتيح للوكلاء كما كانت)، أو «حساب الوكيل نفسه» لوكيل واحد.
  لا ترحيل قاعدة بيانات؛ الحقول إضافية.

## التسليم والخطوة التالية
- PR #229 (مسودة) فوق #227؛ ينتقل إلى `main` بعد دمج #227.
- بعد الدمج: تجربة على مركز المالك بمزوّد حقيقي (OpenRouter/DeepSeek/Groq) لكل الوكلاء الستة، ونداء أداة حقيقي مع Goose وOpenCode
  وQwen وKimi (مثبت اليوم مع Claude Code وحده).
- المرحلة 2: Grok Build وPi (ملف إعداد يملكه المركز)، وقراءة `model_source` في تطبيقي الجوال، وحد أدنى للسياق والأدوات في المنتقي.
  المرحلة 3: Gemini CLI (لغة Gemini الواردة، يدعمها CLIProxyAPI أصلًا).
