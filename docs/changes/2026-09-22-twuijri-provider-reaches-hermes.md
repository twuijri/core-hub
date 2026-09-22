# وصول المزوّد إلى وقت التشغيل: التعبير عن النقاط المتوافقة مع OpenAI، والتحقّق من المفتاح، وفحص ظاهر
المسؤول: twuijri · الفرع: fix/provider-reaches-hermes · الحالة: review

## المشكلة والهدف

المالك في 2026-09-22: أضاف مزوّدًا في شاشة «النماذج»، ظهرت قائمة نماذجه، اختار نموذجًا في
المحرّر وأرسل رسالة. فشل التشغيل بنصّ Hermes نفسه:

```
Provider authentication failed: No inference provider configured. Run 'hermes model' to
choose a provider and model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.)
in ~/.hermes/.env
```

ثم — بعد توصيل OpenRouter — فشل مرّة أخرى بـ `HTTP 401: Missing Authentication header`.

وفي النهاية تبيّن من المالك أن مفتاح OpenRouter الذي ألصقه كان **مفتاح
`cli-proxy-api`**، أُلصق في حوار المزوّد الخطأ؛ وبالمفتاح الصحيح اشتغل التشغيل كما يجب.

فالحادثة حادثتان:

1. **عطل وظيفي حقيقي**: كل مزوّد لا يملك له Hermes معرّفًا خاصًّا — LM Studio و LiteLLM و
   Groq و Mistral و Ollama و«نقطة متوافقة مع OpenAI» وأي نقطة يكتبها المستخدم بنفسه — كان
   **لا يصل إلى Hermes إطلاقًا**. الفهرس يعلن `hermesProvider: null`، فيسجّل المركز سطرًا
   واحدًا («Hermes has no provider slug») ولا يكتب شيئًا؛ وأكثر من ذلك: المفتاح المكتوب في
   مزوّد كهذا **لا يدخل حتى خطّة `.env`**، لأن مدخلة الفهرس لا تسمّي متغيّرًا عالميًّا.
   وسجلّ المالك يُظهر أن `custom-cli-proxy-api` كان هو الافتراضي وقتها، فتُجوهل اختياره
   وكُتب نموذج مزوّد آخر.
2. **صمت المنتج**: مفتاح خاطئ يُحفظ بلا أي تحقّق، ثم يظهر أثره بعد اثنتي عشرة دقيقة كخطأ
   وكيل لا يستطيع المستخدم التصرّف حياله. ولا شيء في المنتج يقول أيّ خطوة بين «حُفِظ»
   و«يعمل» حدثت فعلًا.

وحالة ثالثة صامتة: مساحة عمل فيها مزوّد ونماذج ولا افتراضي محادثة — `propagate()` لا يكتب
شيئًا أصلًا، ولا يظهر ذلك في أي مكان.

## القرار والموافقات

- **الغرفة النظيفة (ADR 0004)**: لم يُفتح مصدر Hermes Studio / Ekko Studio. ما قُرئ: مصدر
  Hermes Agent (MIT) داخل الصورة على `/opt/hermes/src`، بالملفات والأسماء المذكورة أدناه،
  ووثائق هذا المستودع. لم يُنسَخ أي كود.
- **ADR 0010 قائم كما هو**: المركز يملك مخزن الاعتمادات وينشره. ما يتغيّر هنا هو **مدى**
  «لا تخمين لاسم مزوّد عند Hermes»: تبيّن من مصدر Hermes أن له طريقًا صريحًا لأي نقطة
  متوافقة مع OpenAI — كتلة باسمها تحت `providers:` في `config.yaml` تحمل `base_url` و
  `api_mode` و`key_env` (`hermes_cli/config_providers.py` §`_KNOWN_PROVIDER_KEYS`، ويحلّها
  `hermes_cli/runtime_provider_custom.py` §`_match_new_style_provider`). فالامتناع عن
  الكتابة لم يعد أمانةً بل نقصًا: الطريق موجود ونحن لم نستعمله. الامتناع الصادق يبقى لِما
  لا يمكن التعبير عنه فعلًا، وصار **ظاهرًا** لا سطرًا في السجل.
- **البادئة `majlis-` إلزامية** لكل كتلة يكتبها المركز: Hermes يتجاهل كتلة `providers:`
  اسمها أحد مزوّديه القانونيّين (`_shadowed_by_builtin`)، و`lmstudio` **هو** أحدهم — أُثبت
  ذلك بالتشغيل داخل الصورة (أدناه §الفحوص).
- **معرّف النموذج مُعتِم**: لا يُعاد كتابته ولا تطبيعه أبدًا. `openrouter/free` معرّف حقيقي
  (موجّه OpenRouter التلقائي بين النماذج المجانية)، و`z-ai/glm-5.2:free` يحمل بادئة مورّد
  ولاحقة `:free`؛ يمرّ كلاهما حرفًا بحرف من إجابة المزوّد إلى `model.default` وإلى جسم
  الطلب. مفتاح الفهرس (`Model.key` = `<slug>/<id>`) شيء آخر، يُفكّ عند أول شرطة مائلة فقط.
- **التحقّق قبل التخزين**: مفتاح يرفضه المزوّد نفسه ليس مفتاحًا. يُسأل المزوّد مرّة واحدة
  عند الحفظ؛ ورفضٌ صريح (401/403) يمنع الحفظ بكلمات المزوّد نفسها. أما نقطة متعذّر الوصول
  إليها فلا تمنع شيئًا: تعذّر الوصول لا يقول شيئًا عن المفتاح.
- لم يُدفع الفرع، ولم يُفتح PR، ولم يُنشر شيء.

## العقد (ما تغيّر في packages/contracts)

- `ErrorCode`: قيمتان جديدتان — `provider_not_configured` و`provider_unauthorized`،
  كلتاهما 422. الأولى «لم يصل أي اعتماد»، والثانية «وصل ورفضه المزوّد». سببان مختلفان
  وإصلاحان مختلفان، فلا يجوز أن يكونا `agent_error` واحدًا.
- عملية جديدة `models.getRuntime` (`GET /models/runtime`) ومخطّطان: `RuntimeReport` و
  `RuntimeCheck` بمعرّفات `runtime_writable` و`provider_keys` و`provider_verified` و
  `model_selected` و`gateway_reloaded`. كل فحص يُجاب من الملفات والعملية **كما هي الآن**،
  لا من لقطة محفوظة.

## الملفات والتأثير

**`packages/server/src/modules/models/catalogue.ts`**
- `hermesRoute` لكل مدخلة: `builtin` (معرّف Hermes نفسه) أو `openai-compatible` (كتلة
  `providers:` يكتبها المركز) أو `none`. و`hermesApiMode`، و`hermesBaseUrlSuffix` لـ Ollama
  وحدها (محوّلنا يكلّم واجهتها الأصلية، وHermes يكلّم واجهتها المتوافقة تحت `/v1`).
- دوالّ التسمية: `hermesProviderNameOf` و`hermesKeyEnvOf` (اسم عالمي إن وُجد، وإلا
  `MAJLIS_PROVIDER_<SLUG>_API_KEY` مسكوك لهذا الصف وحده) و`hermesBaseUrlOf`.
- **صفّ بلا مدخلة فهرس** (نقطة يكتبها المستخدم، `slug: custom-…`) يُعامل `openai-compatible`
  افتراضيًّا — وهذا بالضبط الشكل الذي كان يصل إلى Hermes كلا شيء.
- الحارس صار يمنع: مدخلة `llm` غير قابلة للتعبير عنها، ومعرّف Hermes بلا طريق، وطريق
  `builtin` بلا معرّف.

**`packages/server/src/modules/models/propagation.ts`**
- `HermesProviderRoute` و`writeHermesProviders`: كتابة كتل `providers:` بالحقول التي يوثّقها
  Hermes فقط (فلا يسجّل «unknown config keys ignored» عن ملف كتبناه نحن)، وحذف كتلنا وحدها
  عند اختفاء المزوّد، وإبقاء كتلة كتبها إنسان كما هي.
- `config.yaml` يُفتح ويُكتب **مرّة واحدة** لكل نشر (الكتل ثم اختيار النموذج): لو كانتا
  كتابتين لتَرك انهيارٌ بينهما Hermes مشيرًا إلى كتلة غير موجودة.
- ملف فارغ يُحوَّل إلى خريطة قبل الكتابة، و**لا يُنشأ ملف أصلًا حين لا شيء ليُقال**: كان
  ينشأ `config.yaml` نصّه `null`، وهو ما يجعل الكتابة التالية مستحيلة.

**`packages/server/src/modules/models/service.ts`**
- `state()` يُخرج الآن كتل النقاط المتوافقة مع OpenAI، **واعتمادات الصفوف التي لا تحمل اسم
  متغيّر عالمي** تحت الاسم المسكوك لها.
- `ensureChatDefault()`: مساحة عمل بلا افتراضي محادثة تأخذ واحدًا من المزوّد الذي هُيّئ
  للتوّ — **مرّة واحدة**، ولا يسرقه مزوّد يُضاف لاحقًا، ولا يُلمس اختيار المالك أبدًا.
  يُستدعى بعد وصول قائمة النماذج (وظيفة التحديث)، وعند إضافة مزوّد كانت نماذجه محفوظة،
  وعند تسجيل نموذج باليد.
- `checkKey()` + `recordCheck()`: سؤال المزوّد عن المفتاح قبل تخزينه، ووضع الجواب على الصف
  فتُظهره البطاقة بلا نقرة ثانية. الرفض الصريح يرفع `provider_unauthorized` وفيه كلمات
  المزوّد حرفيًّا في `details.detail`.
- `requireExpressible()`: افتراضي محادثة لا يمكن إخبار وقت التشغيل به يُرفض باسم المزوّد،
  بدل قبوله وتجاهله بصمت.
- `runtimeReport()`: الفحص الذاتي الخمسة.
- `reconcile()`: مصالحة عند الإقلاع.
- `resolveModelKey()`: مفتاح الفهرس أو معرّف مجرّد ← `{provider_id, model}`. الفصل عند أول
  شرطة مائلة، ولا يُقبل الجزء الأيسر إلا إن كان فعلًا أحد مزوّدي مساحة العمل.
- `hermesProviderName()`: الاسم الذي يعرف به وقت التشغيل مزوّدًا، لتسمية المزوّد في كل طلب.
- إعادة التشغيل: مؤجَّلة وموحَّدة (سلسلة واحدة لا اثنتان)، وتتنحّى ما دام هناك دور جارٍ.

**`packages/server/src/modules/models/index.ts`** — مسار `models.getRuntime`، وخطّاف
`onReady` للمصالحة عند الإقلاع لكل مساحة عمل، و`HermesTarget` صار يحمل `mode`
و`reloadedAt` و`busy` و`applyEnvironment`.

**`packages/server/src/modules/agents/`**
- `hermes-runtime.ts`: `setProviderEnv()` و`startedAt`. الاعتمادات تدخل **بيئة العملية
  المُولَّدة**، لا الملف وحده — تقوية، لا الإصلاح: الملف يُكتب كما كان لأن `hermes model`
  و`hermes config` وصَدَفة داخل الحاوية تقرؤه.
- `service.ts`: `selectionFor()` — مفتاح الفهرس يُفكّ، والمزوّد يُسمّى، والافتراضي يُورَّث
  مع مزوّده. `targetFor` يمرّر `modelProvider`.
- `runner.ts`: الاختيار يُحسب **لكل دور**، لا عند فتح المحادثة وحدها (جلسة Hermes لا
  تُطرد أبدًا، فاختيارٌ يُقرأ مرّة واحدة يثبّت المحادثة على أول نموذج مدى عمر العملية)؛
  و`failureCode()` يفرّق بين «لم نرسل اعتمادًا» و«رفضه المزوّد»؛ و`busy`.
- `adapters/hermes.ts`: `provider` في جسم `POST /v1/runs`، واختيار لكل دور.
- `ports.ts` / `adapters/types.ts`: `resolveModelKey` و`runtimeProviderName` و`modelProvider`
  و`PromptInput.model`.

**`packages/server/src/modules/sessions/mappers.ts`** و**`lib/errors.ts`** و**`i18n/*.json`** —
الرمزان الجديدان.

**`docs/domain/models.md`** — قسم «النشر» أُعيدت كتابته ليطابق السلوك الجديد.
**`docs/STATUS.md`** — عملية واحدة جديدة: الأرقام زِيدت بواحد على الأساس المسجَّل فيه
(89/247 ← 90/248)، ولم يُعَد القياس بإقلاع مركز كما يصف الملف؛ من يعيد القياس بعد مرحلة
يصحّح الأساس كلّه.

**`packages/web/src/`**
- `chat/RunFailureNotice.tsx` (جديد): إشعار لكل من الحالتين، بنصّه ورابطه — «الافتراضيات»
  لأولاهما، «المزوّدون» للأخرى — **ونصّ الوكيل نفسه تحته، كاملًا، لا يُستبدل ولا يُخفى**.
- `models/RuntimeChecks.tsx` (جديد): الفحص الذاتي، يُعرض في الشاشة وداخل الإشعار من مصدر
  واحد فلا يختلفان.
- `models/ModelsScreen.tsx`: شريط الفحص الذاتي، و`?tab=` ليصل إليه رابط باسم اللسان.
- `models/queries.ts`, `types.ts`, `chat/ChatScreen.tsx`, `i18n/{ar,en}.json`.

## الفحوص (الأوامر ونواتجها الفعلية)

### ١) الحاوية الحقيقية

الصورة مبنيّة من هذا الفرع (`docker build -f packages/server/Dockerfile -t majlis:prop-fix .`)،
وتُشغَّل كما في `docker-compose.yml` مع `host.docker.internal`. النقطة المقابلة سكربت محلي
(`scratchpad/fake-endpoint.mjs`) متوافق مع OpenAI: يسجّل كل طلب بترويسته وجسمه، ويردّ 401
بكلماته الخاصة على أي مفتاح غير الذي يقبله. السكربت الكامل: `scratchpad/prove.sh`.

**أ) مفتاح يرفضه المزوّد — يُرفض عند الحفظ، ولا يُخزَّن شيء**

```
=== CASE B — a key the provider refuses is refused on save, in its own words ===
{"error":"The provider rejected the stored key.","code":"provider_unauthorized","details":{"provider":"openai-compatible","detail":"lab: bad or missing api key","reason":"unauthorized"}}
-- providers after the refusal (must be empty) --
{"items":[]}
```

**ب) مفتاح يقبله — يُضاف، تُحمّل النماذج، ويُضبط الافتراضي بلا أن يفتح أحد لسان «الافتراضيات»**

```
=== CASE A — a key it accepts: added, models loaded, default set ===
{"id":"01M33BVX803W1QM8BZP2Z0ZT42","profile":"default","owner_id":"01M33BVW1074H1H73K1Z57T6SB","created_at":"2026-09-22T01:32:12Z","updated_at":"2026-09-22T01:32:12Z","slug":"custom-lab","label":"Lab","kind":"llm","builtin":false,"enabled":true,"api_key":"[stored]","base_url":"http://host.docker.internal:19099/v1","api_mode":"chat_completions","auth":{"kind":"none","signed_in":true},"catalogue":{"status":"loading","refreshed_at":null,"error":null,"refreshable":true},"visibility":{"mode":"all","models":[]},"models":[]}
-- catalogue --
{"items":[{"key":"custom-lab/lab/tiny-1:free","provider_id":"01M33BVX803W1QM8BZP2Z0ZT42","provider":"custom-lab","model":"lab/tiny-1:free","alias":null,"kind":"chat","visible":true,"custom":false,"preview":false,"disabled":false,"context_window":null,"capabilities":[],"pricing":null},{"key":"custom-lab/lab/tiny-2","provider_id":"01M33BVX803W1QM8BZP2Z0ZT42","provider":"custom-lab","model":"lab/tiny-2","alias":null,"kind":"chat","visible":true,"custom":false,"preview":false,"disabled":false,"context_window":null,"capabilities":[],"pricing":null}],"next_cursor":null}
-- defaults (set automatically, nobody opened the Defaults tab) --
{"default":{"provider_id":"01M33BVX803W1QM8BZP2Z0ZT42","model":"lab/tiny-1:free"},"fallbacks":[],"auxiliary":{"tasks":[{"key":"coding","label":{"ar":"وكلاء البرمجة","en":"Coding agents"}},{"key":"title","label":{"ar":"توليد العناوين","en":"Title generation"}},{"key":"summary","label":{"ar":"التلخيص","en":"Summarization"}},{"key":"embedding","label":{"ar":"التضمين","en":"Embeddings"}}],"assignments":{}}}
-- the self-check --
{"agent":"hermes","mode":"managed","ready":true,"reloaded_at":"2026-09-22T01:32:14.459Z","checks":[{"id":"runtime_writable","ok":true,"detail":"managed"},{"id":"provider_keys","ok":true,"detail":"1"},{"id":"provider_verified","ok":true,"detail":null},{"id":"model_selected","ok":true,"detail":"majlis-custom-lab/lab/tiny-1:free"},{"id":"gateway_reloaded","ok":true,"detail":null}]}
```

**ج) ما كُتب في بيت Hermes** — كتلة `providers:` ببادئة `majlis-`، و`key_env` يشير إلى
المتغيّر المسكوك، و`model.default` هو معرّف المزوّد حرفًا بحرف (لاحقة `:free` سليمة)

```
=== what the hub wrote into Hermes's home ===
--- .env ---
# managed by Majlis — edit the provider in the hub, not here
MAJLIS_PROVIDER_CUSTOM_LAB_API_KEY=sk-lab-correct-key
--- config.yaml ---
providers:
  majlis-custom-lab:
    name: majlis-custom-lab
    base_url: http://host.docker.internal:19099/v1
    key_env: MAJLIS_PROVIDER_CUSTOM_LAB_API_KEY
    api_mode: chat_completions
model:
  default: lab/tiny-1:free
  provider: majlis-custom-lab
```

**د) بيئة عملية البوّابة نفسها** (التقوية: لا الملف وحده)

```
=== the gateway's own environment (the hardening: not only the file) ===
pid=26 cmd=/opt/hermes/.venv/bin/python /opt/hermes/.venv/bin/hermes gateway run 
HERMES_HOME=/data/h…
MAJLIS_PROVIDER_CUSTOM_LAB_API_KEY=sk-lab-…
API_SERVER_PORT=8642
pid=69 cmd=sh -c for d in /proc/[0-9]*; do c=$(tr " " " " < $d/cmdline 2>/dev/null); case "$c" in *"gateway run"*) echo "pid=${d#/proc/} cmd=$c"; tr " " "
```

**هـ) تشغيل، بالنموذج الذي اختاره المحرّر**

```
=== a run, with the model the composer chose ===
agent=01M33BVW5BH9QWP6VYGF6VEKTY composer model key=custom-lab/lab/tiny-1:free
session=01M33BWDNHC5AC6VKVGRG1JK7N
run accepted: {"job_id":"01M33BWDPAJRH73Z65VZA6SV6N","run_id":"01M33BWDPAGP642TDGXNYPZ0QJ","message_id":"01M33BWDP90F4NHW10CZT5J1WH","queue_position":null}
-- the run --
{
  "status": "succeeded",
  "model": "custom-lab/lab/tiny-1:free",
  "error": null,
  "usage": {
    "input_tokens": 7,
    "output_tokens": 5,
    "cost": null
  }
}
-- the transcript --
user : [{"type": "text", "text": "say hello"}]
assistant : [{"type": "text", "text": "the lab endpoint answered"}]
```

**و) مفتاح سُحب أثناء الخدمة — الرمز يفرّق، وكلمات المزوّد تبقى**

```
=== CASE C — the upstream starts refusing the key it accepted (a revoked key) ===
{"rejecting":true}
run accepted: {"job_id":"01M33BWGS93SZ5RDKESNJB7DJ8","run_id":"01M33BWGS9E054Y4ZCGWBZT944","message_id":"01M33BWGS8P37ZJCNYH1B6QF94","queue_position":null}
{
  "status": "failed",
  "model": "custom-lab/lab/tiny-1:free",
  "error": {
    "error": "HTTP 401: lab: bad or missing api key",
    "code": "provider_unauthorized"
  }
}
```

**ز) ما وصل النقطة فعلًا** — الترويسة موجودة، والنموذج هو معرّف المزوّد لا مفتاح الفهرس

```
=== WHAT THE ENDPOINT RECEIVED ===
GET /v1/models  authorization='Bearer sk-WRONG-KEY'
GET /v1/models  authorization='Bearer sk-lab-correct-key'
GET /v1/models  authorization='Bearer sk-lab-correct-key'
GET /api/v1/models  authorization=None
GET /v1/models  authorization='Bearer sk-lab-correct-key'
GET /v1/models  authorization='Bearer sk-lab-correct-key'
   model= None
GET /v1/models  authorization='Bearer sk-lab-correct-key'
   model= None
POST /v1/chat/completions  authorization='Bearer sk-lab-correct-key'
   model= lab/tiny-1:free
POST /v1/chat/completions  authorization='Bearer sk-lab-correct-key'
   model= lab/tiny-1:free
GET /v1/models  authorization=None
GET /v1/models  authorization='Bearer sk-lab-correct-key'
   model= None
GET /v1/models  authorization='Bearer sk-lab-correct-key'
   model= None
POST /v1/chat/completions  authorization='Bearer sk-lab-correct-key'
   model= lab/tiny-1:free
```

**ملاحظة على إعادة التشغيل**: سجلّ الحاوية يُظهر كتابتين متتاليتين (`MAJLIS_PROVIDER_… +
providers.majlis-custom-lab` ثم `model.default + model.provider`) و**إعادة تشغيل واحدة**
بعدهما. ولم يُرصد أي سباق مع دور جارٍ في هذا التشغيل؛ الحماية (التنحّي ما دام هناك دور)
مُختبَرة بالوحدة لا بالحاوية.

### ٢) مصفوفة `docs/harness/validation.md`

```
$ pnpm contracts:lint
contracts:lint  redocly lint openapi.yaml
validating openapi.yaml using lint rules for api 'hub@v1'...
openapi.yaml: validated in 593ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
→ exit=0

$ pnpm contracts:check-clients
check-clients  OK — 119 client file(s) scanned, 166 contract path(s) known.
→ exit=0

$ pnpm typecheck
(no output — tsc --noEmit over every package)
→ exit=0

$ pnpm i18n:check
i18n:check  server: 98 keys, ar/en in parity
i18n:check  cli: 231 keys, ar/en in parity
i18n:check  web: 368 keys, ar/en in parity
i18n:check  desktop: apps/desktop/src/i18n not present yet — skipped
i18n:check  OK
→ exit=0

$ pnpm nav:check
nav:check  OK — 35 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
→ exit=0

$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
→ exit=0

$ pnpm test
 Test Files  3 passed (3)
      Tests  11 passed (11)
 Test Files  1 passed (1)
      Tests  89 passed (89)
 Test Files  11 passed (11)
      Tests  61 passed (61)
 Test Files  38 passed | 1 skipped (39)
      Tests  325 passed | 2 skipped (327)
 Test Files  14 passed (14)
      Tests  148 passed (148)
→ exit=0

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  254 passed (254)
→ exit=0

$ pnpm build
- Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 642ms
→ exit=0

$ pnpm web:e2e
  ✓  1 [chromium] › e2e/setup.spec.ts:18:3 › web smoke journeys (a hub with no owner) › 4. first run: the setup token from /data creates the owner and signs in (1.1s)
  ✓  2 [chromium] › e2e/smoke.spec.ts:40:3 › web smoke journeys › 1. new chat → pick a folder → streamed markdown reply with reasoning, tool card and code (2.1s)
  ✓  3 [chromium] › e2e/smoke.spec.ts:125:3 › web smoke journeys › 2. an approval card answers once / session / always / deny through the hub (777ms)
  ✓  4 [chromium] › e2e/smoke.spec.ts:143:3 › web smoke journeys › 3. a socket drop mid-run resumes with after_seq and loses nothing (8.8s)
  ✓  5 [chromium] › e2e/smoke.spec.ts:160:3 › web smoke journeys › 5. the send button becomes stop mid-stream, and stop ends the run (815ms)
  5 passed (18.8s)
→ exit=0
```


## المخاطر والرجوع

- **مخاطرة**: كتابة كتل `providers:` في ملف يملكه Hermes. مخفَّفة بالبادئة `majlis-` (لا
  تُلمس كتلة غيرها)، وبدورة YAML تحفظ التعليقات والمفاتيح الشقيقة، وبالرفض القاطع لملف
  لا يُحلَّل، وباختبار يثبت بقاء كتلة كتبها إنسان.
- **مخاطرة**: رفض حفظ مفتاح. مقصورة على رفض صريح من المزوّد (401/403)؛ كل فشل آخر —
  انقطاع، مهلة، 5xx — يحفظ المفتاح ويُظهر ما قاله المزوّد. المزوّدات التي لا تُسأل مفتاحًا
  لا يتغيّر فيها شيء.
- **مخاطرة**: الافتراضي التلقائي يختار «أول نموذج». الترتيب هو ترتيب مفاتيح النماذج
  أبجديًّا (ترتيب `store.modelsOf`)، وهو ثابت ومُختبَر؛ ولا يُكتب إلا حين لا يوجد افتراضي،
  ويظهر فورًا في شاشة الافتراضيات ليُغيَّر.
- **الرجوع**: الفرع وحده. لا هجرة قاعدة بيانات في هذه المهمة. الرجوع يترك في بيت Hermes
  كتل `majlis-*` ومتغيّرات `MAJLIS_PROVIDER_*` لا يقرؤها أحد؛ حذفها يدويًّا آمن.

## التسليم والخطوة التالية

- لم يُدفع الفرع ولم يُفتح طلب دمج (بانتظار المالك).
- الخطوة التالية بعد المراجعة: مسار `test` وصورة المعاينة حسب TEAM-RULES §2.6.
- ما لم يُنجَز عمدًا: `Run.error.details` لا يحمل قائمة الفحوص الناقصة — ذلك يحتاج عمودًا
  جديدًا وهجرة، ولقطة قديمة أسوأ من فحص حيّ؛ الإشعار يقرأ `models.getRuntime` عند ظهوره.
