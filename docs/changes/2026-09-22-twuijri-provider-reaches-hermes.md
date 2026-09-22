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
- **ADR 0012 جديد** (`docs/adr/0012-openai-compatible-providers-reach-hermes.md`): جوهر ADR
  0010 قائم — المركز يملك مخزن الاعتمادات وينشره — لكن هذا الفرع **يُبطل فقرة بعينها** من
  §3: «عند `hermesProvider: null` لا يكتب المركز اختيار نموذج ويسجّل سطرًا». وقاعدة
  `AGENTS.md` صريحة: القرار لا يُعاد التفاوض عليه داخل طلب دمج، بل يُكتب ADR يُبطله. فكُتب.
  خلاصته: تبيّن من مصدر Hermes أن له طريقًا صريحًا لأي نقطة متوافقة مع OpenAI — كتلة باسمها
  تحت `providers:` في `config.yaml` تحمل `base_url` و`api_mode` و`key_env`
  (`hermes_cli/config_providers.py` §`_KNOWN_PROVIDER_KEYS`، ويحلّها
  `hermes_cli/runtime_provider_custom.py` §`_match_new_style_provider`). فالامتناع عن
  الكتابة لم يعد أمانةً بل نقصًا: الطريق موجود ونحن لم نستعمله. الامتناع الصادق يبقى لِما
  لا يمكن التعبير عنه فعلًا، وصار **ظاهرًا** لا سطرًا في السجل.
- **تصحيح إسناد**: التكليف أشار إلى «ADR 0004 كما عدّلها ADR 0012». لم يكن في المستودع
  ADR بالرقم 0012 عند بدء هذا الدور، و**ADR 0004 لا تحتاج تعديلًا هنا**: هي تمنع فتح مصدر
  Hermes Studio / Ekko Studio، لا مصدر Hermes Agent (MIT) الذي يقوده هذا المنتج — وADR 0008
  وADR 0010 كلتاهما كُتبتا من المصدر نفسه. الرقم 0012 استُعمل الآن لأوّل رقم شاغر، ولِما
  يحتاجه هذا التغيير فعلًا: إبطال فقرة من ADR 0010 §3.
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

**`docs/adr/0012-openai-compatible-providers-reach-hermes.md`** (جديد) — يُبطل فقرة
`hermesProvider: null` من ADR 0010 §3. **`docs/inspirations/hermes-agent.md`** — قسم «ي»
الجديد: كتلة `providers:` بمفاتيحها المقبولة، وحلّها عند التشغيل، وفخّ
`_shadowed_by_builtin` الذي تفرض البادئة `majlis-` بسببه؛ والرابطان المضافان للملفّين.

**`packages/server/tests/container/`** (جديد) — مِشدّ الإثبات نفسه، مُودَعًا في المستودع لا
في مجلّد مؤقّت: `fake-provider.mjs` (نقطة متوافقة مع OpenAI تفحص ترويسة `Authorization`،
تجيب SSE لأن Hermes يطلب تدفّقًا، وتسجّل كل طلب) و`prove.sh` (الحالات الأربع أدناه). من
يعيد الفحص يشغّل السكربت نفسه.

**`packages/web/src/`**
- `chat/RunFailureNotice.tsx` (جديد): إشعار لكل من الحالتين، بنصّه ورابطه — «الافتراضيات»
  لأولاهما، «المزوّدون» للأخرى — **ونصّ الوكيل نفسه تحته، كاملًا، لا يُستبدل ولا يُخفى**.
- `models/RuntimeChecks.tsx` (جديد): الفحص الذاتي، يُعرض في الشاشة وداخل الإشعار من مصدر
  واحد فلا يختلفان.
- `models/ModelsScreen.tsx`: شريط الفحص الذاتي، و`?tab=` ليصل إليه رابط باسم اللسان.
- `models/queries.ts`, `types.ts`, `chat/ChatScreen.tsx`, `i18n/{ar,en}.json`.

## الفحوص (الأوامر ونواتجها الفعلية)

كل ما دونه أُعيد تشغيله على الفرع **بعد إعادة الأساس على `origin/main` الحالي**
(`2f62d38`)، لا على اللقطة السابقة. الصورة أُعيد بناؤها من الشجرة المُعاد أساسها:
`docker build -f packages/server/Dockerfile -t majlis:prop-fix2 .` → `exit=0`.

### ١) الحاوية الحقيقية

الأمر: `packages/server/tests/container/prove.sh majlis:prop-fix2` → `exit=0`. حاوية واحدة
مؤقّتة، ونقطة متوافقة مع OpenAI على المضيف (`fake-provider.mjs`) تفحص ترويسة
`Authorization`، وتردّ 401 **بكلماتها هي** على أي مفتاح غير الذي تقبله، وتسجّل كل طلب.

**أ) مفتاح يرفضه المزوّد — يُرفض عند الحفظ، ولا يُخزَّن شيء**

```
=== CASE B — a key the provider refuses is refused on save, in its own words ===
{"error":"The provider rejected the stored key.","code":"provider_unauthorized","details":{"provider":"Lab","detail":"lab: bad or missing api key","reason":"unauthorized"}}
-- providers after the refusal (must be empty) --
{"items":[]}
```

**ب) مفتاح يقبله — يُضاف، تُحمّل النماذج، ويُضبط الافتراضي بلا أن يفتح أحد لسان «الافتراضيات»**

```
=== CASE A — a key it accepts: added, models loaded, default set ===
{"id":"01M347ZA4TZWCQQPVHJ97AY7NW","profile":"default","owner_id":"01M347Z6WTCWD56TD00TAA961D","created_at":"2026-09-22T09:43:24Z","updated_at":"2026-09-22T09:43:24Z","slug":"custom-lab","label":"Lab","kind":"llm","builtin":false,"enabled":true,"api_key":"[stored]","base_url":"http://host.docker.internal:19099/v1","api_mode":"chat_completions","auth":{"kind":"none","signed_in":true},"catalogue":{"status":"loading","refreshed_at":null,"error":null,"refreshable":true},"visibility":{"mode":"all","models":[]},"models":[]}
-- catalogue --
{"items":[{"key":"custom-lab/lab/tiny-1:free","provider_id":"01M347ZA4TZWCQQPVHJ97AY7NW","provider":"custom-lab","model":"lab/tiny-1:free","alias":null,"kind":"chat","visible":true,"custom":false,"preview":false,"disabled":false,"context_window":null,"capabilities":[],"pricing":null},{"key":"custom-lab/lab/tiny-2","provider_id":"01M347ZA4TZWCQQPVHJ97AY7NW","provider":"custom-lab","model":"lab/tiny-2","alias":null,"kind":"chat","visible":true,"custom":false,"preview":false,"disabled":false,"context_window":null,"capabilities":[],"pricing":null}],"next_cursor":null}
-- defaults (set automatically, nobody opened the Defaults tab) --
{"default":{"provider_id":"01M347ZA4TZWCQQPVHJ97AY7NW","model":"lab/tiny-1:free"},"fallbacks":[],"auxiliary":{"tasks":[{"key":"coding","label":{"ar":"وكلاء البرمجة","en":"Coding agents"}},{"key":"title","label":{"ar":"توليد العناوين","en":"Title generation"}},{"key":"summary","label":{"ar":"التلخيص","en":"Summarization"}},{"key":"embedding","label":{"ar":"التضمين","en":"Embeddings"}}],"assignments":{}}}
-- the self-check --
{"agent":"hermes","mode":"managed","ready":true,"reloaded_at":"2026-09-22T09:43:26.146Z","checks":[{"id":"runtime_writable","ok":true,"detail":"managed"},{"id":"provider_keys","ok":true,"detail":"1"},{"id":"provider_verified","ok":true,"detail":null},{"id":"model_selected","ok":true,"detail":"majlis-custom-lab/lab/tiny-1:free"},{"id":"gateway_reloaded","ok":true,"detail":null}]}
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
pid=37 cmd=/opt/hermes/.venv/bin/python /opt/hermes/.venv/bin/hermes gateway run 
HERMES_HOME=/data/he…
MAJLIS_PROVIDER_CUSTOM_LAB_API_KEY=sk-lab-c…
API_SERVER_PORT=8642
```

**هـ) تشغيل، بالنموذج الذي اختاره المحرّر**

```
=== a run, with the model the composer chose ===
agent=01M347Z79ZH51B3JHJNVA1YZC8 composer model key=custom-lab/lab/tiny-1:free
session=01M34804AADJ0ZN73JFETDDRXD
run accepted: {"job_id":"01M34804B4DZ6DNRS2FA0R1AKD","run_id":"01M34804B4XBVXXQF6KPQHT1B4","message_id":"01M34804B34VFWVT9SQY2QB9WA","queue_position":null}
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
user : [{"type":"text","text":"say hello"}]
assistant : [{"type":"text","text":"the lab endpoint answered"}]
```

**و) مفتاح سُحب أثناء الخدمة — الرمز يفرّق، وكلمات المزوّد تبقى**

```
=== CASE C — the upstream starts refusing the key it accepted (a revoked key) ===
{"rejecting":true}
run accepted: {"job_id":"01M34808DDHBNFAQ2EB5HFDJ9T","run_id":"01M34808DDTCRPX5GFDPX5QASB","message_id":"01M34808DCQRJ46RPD9Z24DHJC","queue_position":null}
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
GET /v1/models  authorization='Bearer sk-lab-correct-key'
GET /api/v1/models  authorization=None
GET /api/tags  authorization=None
GET /v1/props  authorization=None
GET /props  authorization=None
GET /version  authorization=None
GET /v1/models  authorization='Bearer sk-lab-correct-key'
GET /v1/models/lab/tiny-1:free  authorization='Bearer sk-lab-correct-key'
GET /v1/models  authorization='Bearer sk-lab-correct-key'
POST /api/show  authorization='Bearer sk-lab-correct-key'
   model= null
GET /v1/models/lab/tiny-1:free  authorization='Bearer sk-lab-correct-key'
GET /v1/models  authorization='Bearer sk-lab-correct-key'
POST /api/show  authorization='Bearer sk-lab-correct-key'
   model= null
GET /v1/models/lab/tiny-1:free  authorization='Bearer sk-lab-correct-key'
GET /v1/models  authorization='Bearer sk-lab-correct-key'
POST /api/show  authorization='Bearer sk-lab-correct-key'
   model= null
POST /v1/chat/completions  authorization='Bearer sk-lab-correct-key'
   model= lab/tiny-1:free
POST /v1/chat/completions  authorization='Bearer sk-lab-correct-key'
   model= lab/tiny-1:free
GET /v1/models  authorization=None
GET /v1/models/lab/tiny-1:free  authorization='Bearer sk-lab-correct-key'
GET /v1/models  authorization='Bearer sk-lab-correct-key'
POST /api/show  authorization='Bearer sk-lab-correct-key'
   model= null
POST /v1/chat/completions  authorization='Bearer sk-lab-correct-key'
   model= lab/tiny-1:free
```

السطران `GET /v1/models authorization=None` هما فحص Hermes نفسه للنقطة قبل المصادقة
(`/api/tags`، `/v1/props`، `/version` من الدفعة ذاتها)، لا كتابةً من المركز.

**ملاحظة على إعادة التشغيل**: تغيير مزوّد يعيد تدوير البوّابة (ADR 0010 §3)، وهي عملية
Python تحتاج ثوانيَ لتجيب. دورٌ يُرسَل داخل هذه النافذة يفشل بـ `agent_unavailable` —
وهو ما رُصد فعلًا في تشغيل أوّل للسكربت قبل إضافة الانتظار، ويظهر في المنتج كما يظهر أي
بوّابة غير مجيبة. السكربت ينتظر `GET /health` على 8642 قبل الدور حتى لا يُثبت غير المقصود.
السجلّ يُظهر كتابتين متتاليتين (`.env` ثم `config.yaml` مرّة واحدة بالكتل والاختيار معًا)
وإعادة تشغيل واحدة بعدهما. حماية «التنحّي ما دام هناك دور» مُختبَرة بالوحدة لا بالحاوية.

### ٢) مصفوفة `docs/harness/validation.md`

```
$ pnpm contracts:lint
contracts:lint  redocly lint openapi.yaml
validating openapi.yaml using lint rules for api 'hub@v1'...
openapi.yaml: validated in 506ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
→ exit=0

$ pnpm contracts:generate
contracts:generate:ts  wrote generated/ts/schema.ts
contracts:generate:native  Java runtime not found; Kotlin/Swift clients not generated.
(لا فرق متبقٍّ في الشجرة بعد التوليد: `git status --short` فارغ)
→ exit=0

$ pnpm contracts:check-clients
check-clients  OK — 133 client file(s) scanned, 166 contract path(s) known.
→ exit=0

$ pnpm typecheck
(no output — tsc --noEmit over every package)
→ exit=0

$ pnpm i18n:check
i18n:check  server: 98 keys, ar/en in parity
i18n:check  cli: 231 keys, ar/en in parity
i18n:check  web: 377 keys, ar/en in parity
i18n:check  desktop: apps/desktop/src/i18n not present yet — skipped
i18n:check  OK
→ exit=0

$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
→ exit=0

$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
→ exit=0

$ pnpm test
 Test Files  3 passed (3)
      Tests  11 passed (11)
 Test Files  1 passed (1)
      Tests  95 passed (95)
 Test Files  11 passed (11)
      Tests  61 passed (61)
 Test Files  38 passed | 1 skipped (39)
      Tests  325 passed | 2 skipped (327)
 Test Files  18 passed (18)
      Tests  206 passed (206)
→ exit=0

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  254 passed (254)
→ exit=0

$ pnpm build
✓ built in 703ms
→ exit=0

$ pnpm web:e2e
  ✓  1 [chromium] › e2e/setup.spec.ts:18:3 › web smoke journeys (a hub with no owner) › 4. first run: the setup token from /data creates the owner and signs in (910ms)
  ✓  2 [chromium] › e2e/smoke.spec.ts:56:3 › web smoke journeys › 1. new chat → pick a folder → streamed markdown reply with reasoning, tool card and code (3.0s)
  ✓  3 [chromium] › e2e/smoke.spec.ts:165:3 › web smoke journeys › 6. the agent row gives up labels before options, then overflows into More (1.2s)
  ✓  4 [chromium] › e2e/smoke.spec.ts:223:3 › web smoke journeys › 2. an approval card answers once / session / always / deny through the hub (1.1s)
  ✓  5 [chromium] › e2e/smoke.spec.ts:241:3 › web smoke journeys › 3. a socket drop mid-run resumes with after_seq and loses nothing (8.8s)
  ✓  6 [chromium] › e2e/smoke.spec.ts:258:3 › web smoke journeys › 5. the send button becomes stop mid-stream, and stop ends the run (1.0s)
  ✓  7 [chromium] › e2e/smoke.spec.ts:282:3 › web smoke journeys › 7. 443 models: the picker searches, and the list never stops being usable (1.8s)
  7 passed (22.1s)
→ exit=0
```

**لقطات `packages/web/e2e/shots/`**: تشغيلان متتاليان لـ `pnpm web:e2e` على الشجرة نفسها
يُخرجان ١٨ ملفًّا مختلفًا بينهما — اللقطات غير حتمية في هذه البيئة. فلم تُلتقط من هذا
الفرع أي لقطة جديدة؛ ملفّات `origin/main` تُركت كما هي، ولا يمسّها هذا التغيير بصريًّا
(الفرع الموازي يعيد بناء الطبقة البصرية، وشاشة «النماذج» ليست ضمن اللقطات أصلًا).

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
- **مخاطرة**: نافذة إعادة تدوير البوّابة. تغيير مزوّد يعيد تشغيل عملية Python؛ دور يُرسَل
  في تلك الثواني يفشل بـ `agent_unavailable` بنصّه الصريح. غير مُصلَحة هنا عمدًا: إصلاحها
  إمّا تصفيف الأدوار خلف إعادة التشغيل أو إعادة محاولة واحدة، وكلاهما قرار سلوكي يخصّه
  عملُه؛ والفشل اليوم مرئيّ ومُسمّى لا صامت.
- **الرجوع**: الفرع وحده. لا هجرة قاعدة بيانات في هذه المهمة. الرجوع يترك في بيت Hermes
  كتل `majlis-*` ومتغيّرات `MAJLIS_PROVIDER_*` لا يقرؤها أحد؛ حذفها يدويًّا آمن. ADR 0012
  وثيقة؛ التراجع عنها يكون بـ ADR يُبطلها، لا بحذفها (`docs/adr/README.md`).

## التسليم والخطوة التالية

- لم يُدفع الفرع ولم يُفتح طلب دمج (بانتظار المالك).
- **تاريخ الفرع**: أُعيد أساسه على `origin/main` (`2f62d38`) فصار ستّ التزامات خطّية،
  وحلّ التزام `wip:` (وكان دمجًا لـ `main` في الفرع) محلَّ لا شيء. لم يُعَد كتابة أي شيء
  مدفوع — الفرع لم يُدفع قطّ. تعارضات إعادة الأساس وحلولها: `i18n/{ar,en}.json` (ضمّ
  المفاتيح من الجانبين)، و`ModelsScreen.tsx` (بقي `Segmented` من `main`، ولوحة الفحص
  الذاتي فوقه — لا إعادة تنسيق، والفرع الموازي يملك الطبقة البصرية)، ولقطات `e2e/shots`
  (أُخذت نسخة `main`).
- الخطوة التالية بعد المراجعة: مسار `test` وصورة المعاينة حسب TEAM-RULES §2.6.
- ما لم يُنجَز عمدًا: `Run.error.details` لا يحمل قائمة الفحوص الناقصة — ذلك يحتاج عمودًا
  جديدًا وهجرة، ولقطة قديمة أسوأ من فحص حيّ؛ الإشعار يقرأ `models.getRuntime` عند ظهوره.
