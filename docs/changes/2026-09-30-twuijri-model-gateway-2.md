# بوابة النماذج، المرحلة الثانية: Gemini CLI وGrok Build وPi، واستدعاء الأدوات لكل وكيل، والجوال، وجودة المنتقي
المسؤول: twuijri · الفرع: feat/model-gateway-2 (فوق feat/model-gateway، PR #229؛ هذا PR #231) · الحالة: review

## المشكلة والهدف
المرحلة الأولى (ADR 0029، DECISIONS §140) جعلت ستة وكلاء برمجيين يعملون على أي نموذج مضاف في المركز، وأثبتت استدعاء الأدوات مع
Claude Code وحده. بقي خارجها: **Gemini CLI** — أولوية المالك («من ضمنهم جيميناي اللي ودي انا اتعامل معه») — لأنه لا يتكلم إلا
Gemini API، وGrok Build وPi لأنهما لا يعرّفان مزوّدًا بعنوان خاص إلا في ملفات إعدادهما، واستدعاء الأدوات عبر البوابة لـGoose وOpenCode
وQwen وKimi (المرحلة الأولى أثبتت النص فقط)، وتطبيقا الجوال لا يقرآن `Agent.model_source`، والمنتقي يعرض نماذج لا تستدعي أدوات.

## القرار والموافقات
DECISIONS §141 (مقترح — بانتظار تأكيد المالك)، ضمن ADR 0029 المعتمد:

- **لغة Gemini في بوابة المركز**: `POST /gateway/google/v1beta/models/<model>:generateContent|streamGenerateContent|countTokens`
  و`GET /gateway/google/v1beta/models`. النموذج في المسار، فالمسار هو ما يُحَل ويُعاد كتابته إلى `/v1beta/models/h<صف>/<نموذج>:<الطريقة>`
  في CLIProxyAPI 8.0.4، الذي يخدم هذه الطرق الثلاث ويترجم Gemini إلى Chat Completions (قرأت مصدره `translator/openai/gemini`
  وجرّبته فعليًا، الأدوات ونتائجها ضمنًا). الرمز يُقرأ من `x-goog-api-key` أو `?key=` ويُحذف من الاستعلام قبل التمرير. الاستهلاك من
  `usageMetadata` (المخرجات = candidates + thoughts)، والأخطاء بغلاف Gemini.
- **نموذج في اسمه نقطتان** (`qwen3:8b` في Ollama) يُسمّى لـCLIProxyAPI باسم مستعار بـ`__` مكانهما (مسار Gemini فيه يقسم على النقطتين)،
  والاسم الحقيقي يصل للمزوّد (جرّبته).
- **Gemini CLI 0.60.0**: `GOOGLE_GEMINI_BASE_URL` و`GEMINI_API_KEY` (الرمز) و`GEMINI_MODEL=corehub-main`، وتُحذف متغيرات Vertex وتسجيل
  Google والسحابة. إن كان الشخص اختار تسجيل الدخول بـGoogle أو Vertex فإعداده يغلب المتغيرات، والإعدادات الوحيدة فوقه هي إعدادات النظام
  التي لا يقرؤها إلا من مجلد يملكه root (جرّبت: ملف المركز يُتجاهل «not owned by root»). **فالقرار**: يعمل في بيت خاص بالمركز
  (`GEMINI_CLI_HOME` تحت `<DATA_DIR>/gateway/agents/gemini-cli/home`) مجلد `.gemini` فيه روابط لكل ملفات الشخص (جلساته وذاكرته وإضافاته)
  ونسخة من `settings.json` تقول `gateway`؛ لا يتغيّر شيء من ملفات الشخص. لم يُستعمل `authenticate` في ACP لأنه يكتب النوع في إعدادات
  الشخص ويمسح اعتماد Google. العَلَم يبقى `--experimental-acp` (0.60.0 و0.62 يقبلانه، ونسخة قديمة موجودة على الجهاز قد لا تعرف `--acp`).
  نسخة أقدم من 0.60.0 تبقى على حسابها. على Windows (الروابط) يبقى الموقَّع دخوله على حسابه.
- **Grok Build 1.0.41**: لا يعرّف نموذجًا بعنوان خاص إلا بجدول `[model.<id>]` في `config.toml` (جرّبت: `GROK_CONFIG` لا يعرّف نماذج).
  يحفظ المركز جدولًا واحدًا `[model.corehub-gateway]` بين سطرين علامتين في آخر الملف، وباقي الملف كما هو حرفًا بحرف، ويختاره بـ
  `GROK_DEFAULT_MODEL` فيبقى افتراضي الشخص كما هو.
- **Pi 0.87.1**: مزوّد `corehub-gateway` في `models.json` (يُعرف أنه للمركز من عنوانه على loopback)، ثم تُحوَّل جلسة ACP إليه بـ
  `session/set_config_option` دون حفظ افتراضي. جلسة ترفض ذلك لا تبدأ، والمحوِّل يغلق العملية عند فشل فتح الجلسة.
- **لا مفتاح يُكتب**: الكتل تسمّي متغير الرمز فقط. تبقى الكتل عند العودة لحساب الوكيل (قد تستعملها محادثة أخرى، وبلا رمز لا تخدم شيئًا).
  ملف لا يُقرأ بصيغته أو أكبر من 1 ميجابايت أو رابط خارج البيت أو فيه مدخل بالاسم نفسه كتبه الشخص ← لا يُلمس، والوكيل على حسابه، والسجل يقول لماذا.
- **جودة المنتقي**: `Model.agent_tools=false` حين تقول بيانات المزوّد إن النموذج لا يستدعي أدوات (OpenRouter بلا `tools` في
  `supported_parameters`) — محفوظة علامة داخلية `no_tools` لا تُخدم قدرةً ولا تخرج في تصدير البروفايل؛ و`Agent.gateway_min_context`
  حدّ السياق لكل وكيل (64 ألفًا لـClaude Code وCodex وGemini CLI وGrok Build، و32 لـGoose وOpenCode وQwen وKimi، و16 لـPi) —
  الأرقام مقترحة. الويب وiOS وAndroid يُخفون ما لا يستدعي أدوات ويعلّمون ما دون الحد «سياق صغير».
- **الجوال**: iOS وAndroid يقرآن وكيل المحادثة (`agents.get`) فيرشّحان المنتقي ويسمّيان الافتراضي «الافتراضي · <نموذج>»، وبطاقة الوكيل تقول
  «النماذج: مزوّدو كور هب / حساب الوكيل نفسه». تغيير `model_source` من نموذج إعدادات الوكيل الذي يرسمه التطبيقان من الخادم. مركز أقدم
  بلا الحقول ← كما كان.

مقترح — بانتظار تأكيد المالك: البيت الخاص لـGemini الموقَّع دخوله، إبقاء الكتل عند العودة لحساب الوكيل، أرقام حدود السياق، إخفاء
(لا تعطيل) نماذج بلا أدوات.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
إضافات فقط (`pnpm contracts:compat`: لا كسر مقابل v1.1.5): `Model.agent_tools` (منطقي، اختياري، لا يكون إلا `false`)،
`Agent.gateway_min_context` (عدد صحيح، اختياري، مع `model_source`)، ووصف `Model.agent_gateway` يذكر الوكلاء الثلاثة. مسارات
`/gateway/google/…` ليست من `/api/v1` (منفذ loopback داخلي، ADR 0029 §2).

## الملفات والتأثير
- جديد: `packages/server/src/modules/agents/gateway-config.ts` و`gateway-config.test.ts`، هذا السجل.
- الخادم: `models/gateway/gateway.ts` (مسار Gemini)، `usage.ts` (`usageMetadata`)، `cliproxy-config.ts` (الاسم المستعار)،
  `testing/fake-cliproxy.mjs`، `models/schema.ts` و`adapters/openai.ts` و`adapters/types.ts` و`images.ts` و`service.ts` (`no_tools`،
  `agent_tools`، التصدير)، `agents/catalog/{gemini-cli,grok-build,pi,types,…}.ts` (الربط و`minContext`)، `agents/service.ts`
  (كتلة الإعداد، `sessionConfig`، `minVersion`، `gateway_min_context`)، `agents/adapters/acp.ts` و`types.ts`، `agents/ports.ts`،
  `agents/index.ts`، `agents/serialize.ts`، والاختبارات (`gateway.test.ts`، `hub-gateway.test.ts`، `adapters.test.ts` ×2،
  `runner-gateway.test.ts`، `model-gateway.real.test.ts`).
- العقد: `packages/contracts/openapi.yaml`.
- الويب: `chat/useComposerControls.ts`، `i18n/{ar,en}.json`، `tests/default-model-label.test.ts`.
- iOS: `Chat/ChatControls.swift`، `Chat/ChatControlsViews.swift`، `Chat/ChatScreen.swift`، `Screens/AgentsScreens.swift`،
  `i18n/{agents,chat_controls}.{ar,en}.json`، `CoreHubTests/ChatControlsTests.swift`.
- Android: `chat/ChatControls.kt`، `ui/components/ChatControlsUi.kt`، `ui/screens/{ChatScreen,ChatViewModel,AgentsScreen}.kt`،
  `i18n/{agents,chat_controls}.{ar,en}.json`، `test/…/chat/ChatControlsTest.kt`.
- CI: اسم مهمة `model-gateway-real` (تسعة وكلاء). الوثائق: DECISIONS §141، ADR 0029 (العواقب)، `docs/guides/any-model-any-agent.md`، STATUS.

## الفحوص (الأوامر ونواتجها الفعلية)
المجموعة الحقيقية محليًا (CLIProxyAPI 8.0.4 الحقيقي + الوكلاء الحقيقيون من npm/x.ai، مزوّد وهمي يتكلم Chat Completions فقط):

```
$ COREHUB_REAL_GATEWAY=1 COREHUB_REAL_GATEWAY_ALL=1 COREHUB_REAL_ACP_DATA=~/.cache/corehub-agent/acp-data \
    pnpm exec vitest run --project unit --maxWorkers=1 --reporter=verbose src/modules/agents/model-gateway.real.test.ts
 ✓ |unit| refuses a call with no session token, and with a revoked one 139ms
 ✓ |unit| Claude Code answers through an OpenAI-compatible provider and round-trips a tool call 563ms
 ✓ |unit| Codex answers through the Responses path 518ms
 ✓ |unit| gemini-cli round-trips a tool call through the gateway 2094ms
 ✓ |unit| goose round-trips a tool call through the gateway 255ms
 ✓ |unit| opencode round-trips a tool call through the gateway 1697ms
 ✓ |unit| qwen-code round-trips a tool call through the gateway 1125ms
 ✓ |unit| kimi-code round-trips a tool call through the gateway 773ms
 ✓ |unit| grok-build round-trips a tool call through the gateway 538ms
 ✓ |unit| pi round-trips a tool call through the gateway 1289ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

اختبارات الوحدة التي أضفتها أو غيّرتها:

```
$ pnpm exec vitest run --project unit --maxWorkers=2 src/modules/models/gateway/gateway.test.ts \
    src/modules/models/gateway/hub-gateway.test.ts src/modules/agents/gateway-config.test.ts \
    src/modules/agents/adapters/adapters.test.ts src/modules/models/adapters/adapters.test.ts \
    src/modules/agents/runner-gateway.test.ts
 Test Files  6 passed (6)
      Tests  84 passed (84)
$ pnpm --filter @corehub/web exec vitest run --maxWorkers=2 tests/default-model-label.test.ts tests/agent-versions.test.tsx
 Test Files  2 passed (2)
      Tests  15 passed (15)
$ pnpm typecheck; echo "typecheck exit $?"
typecheck exit 0
$ pnpm lint; echo "lint exit $?"
All matched files use Prettier code style!
lint exit 0
$ pnpm contract:test    # Tests  429 passed (429)
$ pnpm change-record:check  # change-record  OK — 1 record(s) valid
$ pnpm contracts:lint   # contracts:lint  OK
$ pnpm contracts:compat # contracts:compat  OK — no breaking change against v1.1.5
$ pnpm contracts:check-clients  # check-clients  OK — 1142 client file(s) scanned, 268 contract path(s) known.
$ pnpm i18n:check       # ios: 2734 keys, ar/en in parity · android: 2593 keys, ar/en in parity · OK
$ pnpm nav:check        # nav:check  OK — 41 destinations …
```

تجارب يدوية مسجّلة: CLIProxyAPI 8.0.4 يترجم `generateContent`/`streamGenerateContent` (أداة وناتجها) و`countTokens` إلى Chat؛
`grok models` يرى `[model.*]` من `config.toml` ولا يراه من `GROK_CONFIG`/`GROK_CONFIG_PATH`؛ Gemini CLI يتجاهل ملف إعدادات نظام
لا يملكه root. لا أداة Swift ولا Java على هذا الجهاز: بناء iOS وAndroid واختباراتهما في CI فقط (نتيجتها في الـPR).

## المخاطر والرجوع
- جودة النموذج مع الأدوات تبقى على النموذج نفسه؛ Anthropic لا تدعم Claude Code على غير Claude (كما في §140).
- Grok Build يرفض دفعة Chat بلا `created` (المزوّدون الحقيقيون يرسلونها)، وترجمة Gemini في CLIProxyAPI تضيف رسالة مستخدم فارغة بعد
  نتيجة الأداة قد يرفضها مزوّد صارم (لم أرها). ومن Gemini إلى مزوّد Anthropic تعمل الأدوات (جرّبتها يدويًا) لكن CLIProxyAPI 8.0.4
  يعطي عدد رموز الإدخال صفرًا، فتُحسب تكلفة ذلك الدور أقل من حقيقتها.
- الكتل في ملفات Grok وPi تبقى بعد العودة لحساب الوكيل؛ و«corehub-gateway» يظهر في قائمة نماذج الشخص فيهما (بلا رمز لا يعمل).
- بيت Gemini الخاص يعتمد على روابط: ملف جديد يكتبه Gemini في جذر `.gemini` أثناء التشغيل يبقى في بيت المركز حتى يظهر عند الشخص.
- الجوال لم يُشغَّل على جهاز؛ المنطق مغطّى باختبارات وحدة، والبناء في CI.
- **الرجوع**: وكيل بعينه ← «حساب الوكيل نفسه» في إعداداته؛ الكل ← `COREHUB_MODEL_GATEWAY=off`. لا ترحيل، والعقد إضافات.

## التسليم والخطوة التالية
PR #231 مسودة فوق #229 (يُعاد توجيهه إلى `main` بعد دمج #229). التالي: تأكيد المالك للمقترحات أعلاه؛ تجربة حيّة على مركز المالك
بمزوّد حقيقي (OpenRouter/DeepSeek/Groq) لكل وكيل؛ تشغيل الجوال على جهاز. ما يبقى بعد هذه المرحلة: `count_tokens` تقديري لمسار
Anthropic حين لا يدعمه المزوّد، ونسب استدعاءات الوكلاء الفرعيين في السجل (`x-claude-code-agent-id`).
