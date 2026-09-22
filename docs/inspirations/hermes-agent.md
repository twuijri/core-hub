# Hermes Agent (وقت التشغيل الذي نقوده)

- المستودع: <https://github.com/NousResearch/hermes-agent>
- الرخصة: **MIT** — تم التحقق من ملف `LICENSE` («Copyright (c) 2025 Nous Research»، نص MIT الكامل) بتاريخ 2026-09-21.
- الغرض من هذه الصفحة: توثيق سطح Hermes الذي يبني عليه محوّلنا `hermes` (ADR 0002، التنفيذ الثاني من `AgentAdapter`). كل ما هنا مأخوذ من وثائق الموقع كما هي في `website/docs/` بفرع `main` بالتاريخ أعلاه؛ الروابط في آخر الصفحة.

## ماذا يفعل (في خمسة أسطر)
1. وكيل ذاتي التحسين بلغة Python: CLI/TUI، حلقة تعلّم (ذاكرة يديرها الوكيل، إنشاء مهارات، بحث في الجلسات السابقة)، وأي مزوّد نماذج (`hermes model`).
2. **gateway** واحد طويل العمر يربطه بـ ‎20+‎ منصة مراسلة (Telegram، Discord، Slack، WhatsApp، Signal، Email، Matrix، Teams…) ويشغّل cron ويسلّم الصوت.
3. مهارات (معيار agentskills.io)، ذاكرة (`MEMORY.md`/`USER.md` + بحث FTS5)، cron، تفويض لوكلاء أبناء (`delegate_task`)، **Kanban** متعدّد الملفات الشخصية، ملفات شخصية (profiles) منفصلة البيوت، إضافات وخطافات وMCP.
4. ثلاث واجهات برمجية: **ACP** (JSON-RPC على stdio)، **TUI gateway** (JSON-RPC على stdio أو WebSocket)، و**API server** (HTTP + SSE متوافق مع OpenAI مع واجهة runs).
5. لوحة ويب (`hermes dashboard`، FastAPI على 9119) وتطبيق سطح مكتب، سبعة backends طرفية (محلي، Docker، SSH، Modal، Daytona…)، وأمان طبقي (موافقات، اقتران DM، عزل حاويات).

## سطح Hermes الذي يعتمد عليه محوّلنا

### 1) البروتوكولات الثلاث (developer-guide/programmatic-integration)
| البروتوكول | النقل | ما يعرضه | استخدامنا |
|---|---|---|---|
| **TUI gateway JSON-RPC** (`tui_gateway/server.py`, WebSocket عبر `tui_gateway/ws.py`) | stdio أو WebSocket | جلسات، أوامر، موافقات، أحداث بث، تعدّد المرتبطين | **الأساسي** للمحوّل: أغنى سطح |
| **API server** (`gateway/platforms/api_server.py`, منفذ 8642) | HTTP + SSE | OpenAI Chat/Responses + `/v1/runs` | احتياطي للتشغيلات بلا واجهة (cron/board) |
| **ACP** (`hermes acp`, `acp_adapter/`) | JSON-RPC على stdio | إنشاء جلسة، prompt، chunks، نداءات أدوات، طلبات إذن، fork، cancel | عبر محوّل ACP العام عندنا لو أردنا معاملة Hermes كأي وكيل ACP |

**TUI gateway — الطرق** (مختارة من الوثيقة): `prompt.submit`, `prompt.background`, `session.steer`, `session.create/list/active_list/activate/close/interrupt/history/compress/branch/title/usage/status`, `clarify.lock`, `config.get/set`, `commands.catalog`, `command.resolve/dispatch`, `cli.exec`, `reload.mcp/env`, `process.stop`, `delegation.status`, `subagent.interrupt/steer`, `spawn_tree.save/list/load`, `terminal.resize`, `image.attach`, `client.capabilities`, `gateway.capabilities`, `ping`.
- الأحداث: `message.delta`, `message.complete`, `tool.start`, `tool.generating`, `tool.complete`, `gateway.ready`, `request.cancel`، وأحداث دورة حياة الجلسة والأخطاء.
- **طلبات من الخادم إلى العميل** (ليست أحداثًا): `approval` → `{choice}`, `clarify` → `{answer|answers}`, `sudo`/`secret`/`vault.code`/`vault.unlock_prompt` → `{value}`, `connection`, `terminal.read`, `window.read`, `preview.act`, `tour`. العميل **يجب** أن يعلن `client.capabilities {server_requests:true}` بعد `gateway.ready` وإلا رُفضت الطلبات فورًا.
- تعدّد المرتبطين: استئناف/تنشيط جلسة حيّة يضيف مشتركًا ولا يستبدل الاتصال السابق؛ `session.resume`/`session.activate` تعيد `inflight` (الدور الجاري) و`open_requests` (الأسئلة المفتوحة) و`session.events.since` لإعادة التزامن.
- `session.create` يقبل `model`/`provider` لكل جلسة ويرفض التركيبات المستحيلة بـ `-32602`.
- الرجوع في التاريخ: `prompt.submit` مع `truncate_before_row_id` + `confirm_truncate` (يرفض أثناء الانشغال بـ `4009`).

**API server — المسارات**: `POST /v1/chat/completions` (بلا حالة، SSE مع حدث `hermes.tool.progress` و`reasoning_content`)، `POST /v1/responses` (حالة على الخادم عبر `previous_response_id`، عناصر `function_call`/`function_call_output`/`reasoning`)، `POST /v1/runs` (202 + `run_id`)، `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events` (SSE)، `POST /v1/runs/{id}/approval | steer | stop`، `GET /v1/capabilities`, `GET /v1/models`, `GET /api/model/options`, `GET /api/sessions/{id}/chat/stream`, `GET /health`, `/health/detailed`, تسجيل متحكّم متصفح `/v1/browser-control/*`. الترويسات `X-Hermes-Session-Id` و`X-Hermes-Session-Key`؛ التفعيل بـ `API_SERVER_ENABLED=true` و`API_SERVER_KEY`؛ تعليق `: keepalive` كل 10 ثوانٍ؛ جلسات هذا السطح تخضع لسياسة `approvals.unattended_mode` (الافتراضي `deny`).

### 2) الجلسات (user-guide/sessions)
- كل محادثة جلسة في SQLite `~/.hermes/state.db` مع FTS5: معرّف، `source`، مستخدم، عنوان فريد، نموذج، لقطة system prompt، الرسائل كاملة (أدوار، نداءات أدوات، نتائج)، عدّادات الرموز، أوقات، `parent_session_id` عند التقسيم بالضغط.
- مصادر الجلسة: `cli`, `oneshot`, `telegram`, `discord`, `slack`, `whatsapp`, `signal`, `matrix`, `mattermost`, `email`, `sms`, `dingtalk`, `feishu`, `wecom`, `weixin`, `bluebubbles`, `qqbot`, `homeassistant`, `webhook`, `api-server`, `acp`, `cron`, `batch`, `kanban`, `tool` — بعضها مخفي من منتقيات الجلسات (`kanban`, `tool`, `oneshot`).
- الاستئناف بالمعرّف أو العنوان (`--resume`, `-c`)، `/new <name>` لعنونة مسبقة، `/compress`, `hermes sessions list/prune/optimize`.
- الوسائط مدخلات لكل دور (لا يُعاد إرسال الملفات الخام في كل دور).

### 3) الذاكرة (user-guide/features/memory)
- `~/.hermes/memories/MEMORY.md` (2,200 حرفًا) و`USER.md` (1,375 حرفًا)؛ تُحقن كلقطة **مجمّدة** في system prompt عند بدء الجلسة؛ الوكيل يعدّلها عبر أداة `memory` (إضافة/استبدال/حذف)؛ الامتلاء يعيد خطأً ولا يحذف صامتًا.
- `write_approval: true` يوقف الكتابة خارج CLI التفاعلي حتى `/memory pending` و`/memory approve all`.
- الذاكرة **لكل ملف شخصي**؛ قاعدة صارمة: لا تشغّل عمليتين على بيت واحد؛ للمشاركة: مزوّد ذاكرة خارجي (`memory-providers`).
- بحث الجلسات السابقة (`session_search`) يكمل الذاكرة عند حدود الجلسات.

### 4) المهارات (user-guide/features/skills)
- `~/.hermes/skills/` مصدر الحقيقة؛ متوافقة مع agentskills.io؛ كل مهارة أمر مائل `/<skill>`، وتكديس حتى 5 مهارات في رسالة؛ أدلة مهارات خارجية؛ Skills Hub؛ `hermes skills opt-out/opt-in` وعلامة `.no-bundled-skills`.

### 5) المهام المجدولة (user-guide/features/cron)
- أداة واحدة `cronjob_manage` للوكيل، وCLI `hermes cron create/edit/--pin/--unpin/--reasoning-effort`، `/cron add` في الدردشة؛ الملف `~/.hermes/cron/jobs.json`.
- مرة واحدة أو متكرّر، إيقاف/استئناف/تشغيل يدوي/حذف، مهارات مرفقة، تسليم إلى المحادثة الأصلية أو ملف أو منصة، وضع **بلا وكيل** (سكربت فقط)، تشغيل بحدث خارجي عبر webhook (`cron_job`).
- تحقّق قبل الإرسال: مفتاح المزوّد، جاهزية المهارات، أهداف التسليم، خوادم MCP؛ الفشل → `last_status: blocked_config` بتنبيه واحد وبلا استهلاك رموز. جلسات cron لا تنشئ cron (منع الحلقات). حلّ النموذج: تثبيت لكل job → `cron.model` → النموذج الرئيسي.

### 6) قنوات المراسلة (user-guide/messaging, developer-guide/gateway-internals)
- عملية gateway واحدة لكل المنصات؛ `hermes gateway setup/start`؛ حالة المراسلة تتبع الملف الشخصي على الجهاز؛ «Saved» يعني أن الاعتمادات مخزّنة لا أن المنصة متصلة.
- مفتاح الجلسة `agent:{namespace}:{platform}:{chat_type}:{chat_id}` (يُبنى فقط بـ `build_session_key()`).
- التفويض بالترتيب: allow-all للمنصة → قائمة مسموحين → **اقتران DM** (`/pair` يعطي رمزًا) → allow-all عام → رفض افتراضي.
- Hermes Relay (تجريبي): موصّلات خارجية تملك اعتمادات المنصة وتتفاوض القدرات عند المصافحة.
- خطافات: gateway hooks (`HOOK.yaml` + `handler.py`)، plugin hooks، shell hooks، و**outbound webhooks** موقّعة لأحداث دورة الحياة.

### 7) Kanban والتفويض والملفات الشخصية
- **Kanban** (`user-guide/features/kanban`): `~/.hermes/kanban.db` مشترك بين الملفات الشخصية؛ الوكلاء يقودونه بأدوات `kanban_*` (`show/list/complete/request_review/request_changes/block/heartbeat/comment/attach/create/link/unblock`)، والبشر بـ `hermes kanban …`/`/kanban`/اللوحة؛ dispatcher يشغّل عمّالًا بملفات شخصية مسمّاة؛ عقود اكتمال PR (`--completion-contract OWNER/REPO`) تتحقق من فحوص GitHub المطلوبة قبل الإغلاق.
- **التفويض** (`delegation`, `subagent-lifecycle-api`): `delegate_task` حتى 10 أبناء متوازين، `output_schema` بتصحيح واحد، الابن يبدأ بلا سياق سوى `goal`/`context`؛ واجهة عامة للإضافات بحالات `PENDING → STARTING → RUNNING → SUCCEEDED|FAILED|INTERRUPTED|CANCELLED` و`reconnect` غير متاح بعد إعادة التشغيل.
- **الملفات الشخصية** (`profiles`): `~/.hermes/profiles/<name>/` ببيت مستقل (config، `.env`، ذاكرة، جلسات، مهارات، cron)، أمر باسم الملف (`coder chat`)، `--clone`/`--clone-all`، **كل ملف يملك اعتماداته**، ووصف يُستخدم لتوجيه Kanban.

### 8) اللوحة والأمان
- `hermes dashboard` (9119، `--host`, `--port`): سطح إدارة على مستوى الجهاز يختار الملف الشخصي بـ `?profile=`؛ صفحات Status/Chat (TUI عبر PTY على `/api/pty` WebSocket)/Sessions/Config/API Keys/Skills/MCP/Models/Cron/Logs؛ لافتة ضغط الذاكرة/القرص.
- الأمان (`security`): `approvals.mode` = `smart|manual|off`، `timeout`, `cron_mode`/`single_query_mode`/`unattended_mode` = `deny|approve`، YOLO (`--yolo`, `/yolo`)، ثماني طبقات (تفويض، موافقة الأوامر الخطرة، أمان الكتابة، عزل حاويات، تصفية اعتمادات MCP، فحص ملفات السياق، عزل الجلسات، تعقيم المدخلات).

## سطح `/v1/runs` كما نقوده فعلًا (من مصدر Hermes بترخيص MIT، 2026-09-21)
هذا القسم ليس فكرة مقتبسة بل توثيق **سطح وقت التشغيل الذي نبني عليه** (ADR 0008). قُرئ من
`gateway/platforms/api_server.py` و`api_server_runs.py` و`gateway/config_env.py` و
`tools/approval.py` على فرع `main` (النسخة 0.21.3، الوسم `v2026.9.14`)؛ روابط المصدر في آخر الصفحة.

- **التفعيل**: وجود `API_SERVER_KEY` قوي (≥16 حرفًا وليس قيمة نائبة) في بيئة `hermes gateway run`
  يفعّل الخادم (`_api_server()` في `config_env.py`)، مع `API_SERVER_HOST` و`API_SERVER_PORT`
  (الافتراضي `127.0.0.1:8642`). بلا مفتاح **يرفض الإقلاع** (`_api_key_passes_startup_guard`).
- **الاستيثاق**: `Authorization: Bearer <API_SERVER_KEY>` على كل شيء عدا `GET /health`
  (يعيد `{"status":"ok", "platform":"hermes-agent", "version":…}`). الخطأ:
  `{"error":{"message":…,"code":"gateway_auth_failed"}}` بحالة 401.
- **`POST /v1/runs`** جسم `{ input: string | [{role,content}], session_id?, instructions?, model?,
  model_options?: { reasoning_effort }, previous_response_id?, conversation_history? }` ← `202
  {"run_id":"run_<hex>","status":"started","replayed":false}`. `session_id` يختاره العميل؛ هرمس
  يحمّل تاريخ تلك الجلسة ويكتب الدور إليها، فالدور التالي بنفس المعرّف يكمل المحادثة. رأس
  `Idempotency-Key` اختياري.
- **`GET /v1/runs/{id}/events`** بث SSE: كل إطار `data: {json}` بلا سطر `event:`، والاسم داخل
  الكائن: `{"event": name, "run_id", "timestamp", …}`. تعليق `: keepalive` كل 10 ثوانٍ، و
  `: stream closed` عند النهاية. الأحداث وحقولها (`api_server_runs.py`):
  `run.started` · `message.delta {delta}` · `message.interim {text, already_streamed}` ·
  `reasoning.available {text}` · `tool.started {tool, preview}` · `tool.completed {tool, duration,
  error, preview}` · `subagent.start/complete {delegation_id, goal, status, summary, …}` ·
  `approval.request {command, pattern_key, description, allow_permanent, allow_session,
  smart_denied?, choices: [once|session|always|deny]}` · `approval.responded {choice, resolved}` ·
  ختامي واحد: `run.completed {completed, partial, interrupted, output, usage{input_tokens,
  output_tokens, total_tokens, cache_read_tokens, cache_write_tokens}, runtime{provider, model}}`
  أو `run.failed {error}` أو `run.cancelled` أو `run.interrupted {error}`؛ و`error {message}` عند
  استثناء. أحداث `tool.progress`/`subagent.tool` ضجيج للواجهات ويُسقطها المحوّل.
- **`POST /v1/runs/{id}/approval`** `{ choice: once|session|always|deny, request_id? }`؛ الحالة
  أثناء الانتظار `waiting_for_approval`؛ رفض بلا موافقة معلّقة `409 approval_not_pending`.
- **`POST /v1/runs/{id}/stop`** `{}` ← `{"run_id","status":"stopping"}` ثم `run.cancelled`.
- **`GET /v1/runs/{id}`** حالة قابلة للاستطلاع: `queued|running|waiting_for_approval|stopping|
  completed|failed|cancelled|interrupted` مع `output` و`usage` و`error`.
- **الصورة الرسمية** `nousresearch/hermes-agent` (≈6 GB مع المتصفحات وffmpeg وs6) تشغّل
  `gateway run` بـ`HERMES_HOME=/opt/data`؛ نحن لا نبني عليها بل نثبّت الحزمة من وسم git بـ`uv`
  (`packages/server/Dockerfile`، ADR 0008). `aiohttp` (الذي يحتاجه الخادم) ليس في التبعيات
  الأساسية بل في extras المراسلة، فنثبّته صراحةً.
- **الحدود المعروفة**: `/v1/runs` لا يحمل أسئلة `clarify` النصية (هذه في TUI gateway)، ولا
  يرقّم نداءات الأدوات (نطابق `tool.completed` بآخر نداء مفتوح بالاسم نفسه)، و`usage` تأتي مع
  الحدث الختامي فقط.

## مفاتيح المزوّدين واختيار النموذج (ADR 0010)

قُرئ من مصدر Hermes بترخيص MIT عند الالتزام `e7c5141f1c5b14e83bdafa3732a6c7fce7fc2465`
(فرع `main`، 2026-09-21) ومن وثائق الموقع؛ الروابط في آخر القسم. هذا هو السطح الذي يكتب
عليه المركز في ADR 0010، فكل معرّف هنا منقول حرفيًا لا مترجمًا.

### أ) بنية `HERMES_HOME`
```
~/.hermes/
├── config.yaml     # الإعدادات (النموذج، الطرفية، TTS، الضغط…)
├── .env            # مفاتيح الواجهات والأسرار
├── auth.json       # اعتمادات OAuth
├── SOUL.md · memories/ · skills/ · cron/ · sessions/ · logs/
```
- **المفاتيح في `.env` لا في `config.yaml`**؛ القاعدة الموثّقة: «الأسرار (مفاتيح الواجهات،
  رموز البوتات، كلمات المرور) في `.env`، وكل ما عداها في `config.yaml`».
- `get_config_path()` → `get_hermes_home() / "config.yaml"`، و`get_env_path()` → `.env`
  (`hermes_cli/config.py`). ترتيب حسم البيت: تجاوز محلّي → متغيّر `HERMES_HOME` → الافتراضي
  (`hermes_constants.py`). علامات البيت: `("config.yaml", ".env", "state.db")`.
- اكتشاف المسارات بلا تخمين: `hermes config path` و`hermes config env-path`.
- صيغة `.env` (`agent/secret_scope.py` §`_parse_env_text`): `KEY=value`، مع قبول بادئة
  `export `، ومسافات حول `=`، وتعليقات `#`، وفكّ اقتباسات. والكاتب
  (`_quote_env_value`) **يقتبس فقط** إذا احتوت القيمة على `#` أو `"` أو `'` أو مسافة.
  الكتابة ذرّية: ملف مؤقّت + `fsync` + إعادة تسمية، مع الحفاظ على صلاحيات الملف،
  و«الأسطر الفارغة والتعليقات تُحفظ حرفيًا».

### ب) أسماء متغيّرات البيئة لكل مزوّد
ليست جدولًا واحدًا: تُدمج من ثلاثة مصادر — `env_vars=(…)` في
`plugins/model-providers/<id>/__init__.py`، و`HERMES_OVERLAYS` في `hermes_cli/providers.py`،
وحقل `env` في فهرس models.dev (مخزّن في `<home>/models_dev_cache.json`).

| مزوّد Hermes | `env_vars` (الأول هو الأساسي) |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| `openrouter` | `OPENROUTER_API_KEY` (ويرجع إلى `OPENAI_API_KEY`) |
| `gemini` (مرادفات `google`, `google-gemini`) | `GOOGLE_API_KEY`, `GEMINI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `xai` (مرادفات `grok`, `x-ai`) | `XAI_API_KEY` |
| `zai` | `GLM_API_KEY`, `ZAI_API_KEY`, `Z_AI_API_KEY` |
| `nous` | `NOUS_API_KEY` |
| `huggingface` | `HF_TOKEN` |
| `nvidia` | `NVIDIA_API_KEY` |
| `alibaba` (`dashscope`) | `DASHSCOPE_API_KEY` |
| `copilot` | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` |

**مزلقان يقرّرهما `hermesRoute` في `modules/models/catalogue.ts`:**
1. لا يوجد مزوّد محادثة اسمه `openai` عند Hermes: `openai` **مرادف لـ `openrouter`**
   (`_ALIAS_GROUPS`)، و OpenAI المباشر هو `openai-api` / `openai-codex`.
2. `MISTRAL_API_KEY` و`GROQ_API_KEY` عند Hermes مفاتيح **صوت** (Voxtral وWhisper،
   `tools/voice_client_config.py`) لا مزوّدا محادثة؛ لا إضافة لهما في
   `plugins/model-providers/`.

### ج) `hermes config`
`config` · `edit` · `get <key>` · `set [--force] <key> <value>` · `unset <key>` · `check` ·
`migrate` · `path` · `env-path`. التوجيه في `set_config_value()`:
مفتاح بلا نقطة ينتهي بـ `_API_KEY`/`_TOKEN`/`_SECRET` (أو ضمن `_ENV_CONFIG_KEYS`) → `.env`؛
أي اسم `^[A-Z][A-Z0-9_]*$` → `.env`؛ مفتاح منقوط → `config.yaml`. **الملفان يُحفظان بلا
إتلاف** لبقية المفاتيح. الضبط غير التفاعلي متاح:
`hermes config set OPENROUTER_API_KEY sk-or-…`. هناك قائمة منع للكتابة تشمل `HERMES_HOME`
و`PATH` و`LD_PRELOAD` وغيرها.

### د) `hermes model`
**تفاعلي فقط** (لا وسيط موضعي للنموذج). ما يحفظه، من
`model_selection_config_updates()` في `hermes_cli/model_switch.py`:
`model.default` (معرّف النموذج، وهو المفتاح المعياري؛ `model.model` و`model.name` مرادفان
يُهاجَران إليه) و`model.provider` و`model.base_url` و`model.api_mode`، مع **مسح**
`model.base_url`/`model.api_mode` عند تغيّر المزوّد. والكتابة
`atomic_roundtrip_yaml_update(path, f"model.{key}", value)` مفتاحًا مفتاحًا، وتعليق المصدر
صريح: «كتابات مفتاح مستهدفة لا إعادة كتابة كتلة `model:`؛ إعادة الكتابة تُتلف المفاتيح
الشقيقة». على تثبيت جديد تكون `model: ""` (سلسلة فارغة) وتُرقّى إلى خريطة عند أول ضبط.
البديل غير التفاعلي: `hermes config set model.default <id>` + `model.provider <slug>`.

### هـ) الأسبقية
الموثّق: وسائط CLI ← `config.yaml` ← `.env` ← الافتراضيات. وفي المصدر، للاعتمادات
تحديدًا: **`$HERMES_HOME/.env` يتغلّب على بيئة الصدفة الموروثة** — `load_hermes_dotenv()`
يحمّل بـ`override=True`، و`get_env_value_prefer_dotenv()` يقرأ `.env` قبل `os.environ`
«لأن ملف المستخدم هو المرجع». و`load_hermes_dotenv()` يُستدعى عند الاستيراد في
`run_agent.py` و`cli.py` و`tui_gateway/server.py`، أي عند إقلاع البوّابة.

### و) إعادة التحميل — ولماذا يعيد المركز تشغيل البوّابة
- القراءتان مخزّنتان بتوقيع الملف (mtime/size/inode)، فالقراءة التالية بعد تحرير خارجي
  تلتقط التغيير؛ لكن `os.environ` في العملية الحيّة **لا يتحدّث** حتى يُستدعى
  `reload_env()`.
- الموثّق: «**البوّابة**: الجلسة الجديدة التالية. الجلسات القائمة تحتفظ بنموذجها. أعد
  تشغيل البوّابة (`hermes gateway restart`) لفرض التقاط التغيير على الجميع».
- `reload.env` و`reload.mcp` موجودان في **TUI gateway** فقط (JSON-RPC على stdio أو
  WebSocket على `/api/ws`)، لا في خادم الواجهة على 8642.
- **خادم الواجهة (8642) لا يعرض أي مسار لقراءة أو كتابة المفاتيح أو النموذج**: جدول مساراته
  (`_http_route_table()`) يحوي `GET /v1/models` و`GET /api/model/options` و
  `GET /v1/capabilities` وكلها للقراءة، وأعلامه الثابتة تقول `"admin_config_rw": False`.
  سطح الكتابة الوحيد هو لوحة `hermes dashboard` (`PUT /api/env`, `PUT /api/config`,
  `POST /api/model/set` برأس `X-Hermes-Session-Token`)، وهي خادم ثانٍ لا نشغّله (ADR 0008 §3).
- لذلك: المركز يكتب الملفين ثم **يعيد تشغيل الطفل الذي يشرف عليه** (ADR 0008 §2).

### ز) اختيار النموذج لكل تشغيل
`POST /v1/runs` يقبل `model` و`provider` و`model_options` في الجسم
(`_request_agent_overrides()`). الأسبقية: قفل المتصفّح المؤكَّد > تجاوز `/model` للجلسة >
نموذج الجلسة المحفوظ > مرادف `model_routes` > `provider`/`model` للطلب > الافتراضي العام.
`model` مجرّد بلا `provider` **يُقبل** على `/v1/runs` (بخلاف `/v1/chat/completions`). لا
تحقّق مسبق من فهرس النماذج: نموذج مجهول يمرّ إلى المزوّد وينتهي التشغيل `run.failed`
بخطأ المزوّد؛ ومزوّد مجهول يُنهي التشغيل بخطأ اعتماد محكوم لا بـ 500.

### ح) الملفات الشخصية
كل ملف شخصي **يملك `.env` الخاص به ولا يرث من `~/.hermes/.env`**. عند الإنشاء يُزرع
`.env` فارغ بصلاحيات `0600` تحديدًا كي «لا يرث الملف الجديد مفاتيح الصدفة صامتًا». وفي
البوّابة متعدّدة الملفات: «مفاتيح المزوّدين … من `.env` الخاص بالملف — **أبدًا قيمة الملف
الافتراضي**».

### ط) تحذيرات عند التحرير أثناء التشغيل
لا يوجد تحذير صريح «لا تحرّر أثناء التشغيل»، لكن: التغيير يصل الجلسات الجديدة فقط؛ العملية
الحيّة تحتفظ بنموذج الإقلاع؛ «لا تشغّل عمليتين على بيت واحد»؛ ولا يوجد قفل ملفات **بين**
العمليات على `config.yaml` أو `.env` (القفل داخل العملية فقط) — آخر كاتب ذرّي يفوز. لذلك
يكتب المركز بملف مؤقّت + إعادة تسمية، ويرفض إعادة كتابة `config.yaml` غير قابل للتحليل.

### ي) الطريق المتوافق مع OpenAI: كتلة تحت `providers:` (قُرئ 2026-09-22 من `/opt/hermes/src` داخل الصورة)
مزوّد لا يملك Hermes له إضافة خاصّة **ليس** بلا طريق: `config.yaml` يقبل خريطة
`providers:` مفتاحها اسم المزوّد، وكتلتها تُحلَّل في `hermes_cli/config_providers.py`.
المفاتيح التي يعرفها (`_KNOWN_PROVIDER_KEYS`) تشمل `name` و`base_url` (وبديلاه `url`/`api`)
و`key_env` (وبديله `api_key_env`) و`api_key` و`api_mode` (وبديله `transport`)؛ وأي مفتاح
خارجها يُسجَّل «unknown config keys ignored». الكتلة بلا `base_url` **تُسقَط بصمت**.

الحلّ عند التشغيل في `hermes_cli/runtime_provider_custom.py`:
`_match_new_style_provider()` يمسح `providers:`، ويقرأ المفتاح من متغيّر البيئة الذي
يسمّيه `key_env` (وإلا `api_key` المضمّن)، ويطابق الاسم بمرادفاته
(`custom_provider_aliases`). و`_shadowed_by_builtin()` **يتجاهل الكتلة كلّها** إن كان
اسمها هو الاسم المعياري لمزوّد مدمج — ولهذا كل كتلة يكتبها المركز تحمل البادئة `majlis-`
(ADR 0012). و`providers.<name>.enabled: false` يُخفي الكتلة دون حذفها.

### روابط هذا القسم (MIT، قُرئت 2026-09-21؛ الملفّان الأخيران 2026-09-22)
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/config.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/model_switch.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/providers.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/env_loader.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/auth.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/profiles.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_constants.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/secret_scope.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/credential_pool.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tui_gateway/methods_tools.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/gateway/platforms/api_server.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/cli-config.yaml.example>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/config_providers.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/runtime_provider_custom.py>
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/plugins/model-providers/anthropic/__init__.py>
- <https://hermes-agent.nousresearch.com/docs/user-guide/configuration>
- <https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models>
- <https://hermes-agent.nousresearch.com/docs/reference/environment-variables>
- <https://hermes-agent.nousresearch.com/docs/user-guide/profiles>
- <https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways>

## الأفكار التي نتبنّاها (وخريطة المحوّل)
| سطح Hermes | وحدتنا | القرار |
|---|---|---|
| `/v1/runs` في API server | `agents` (محوّل `hermes`) | **القناة الأساسية منذ ADR 0008**: `start`/`send`/`stream`/`interrupt` = `POST /v1/runs` + SSE + `/approval` + `/stop`؛ `session_id` من عندنا يحفظ استمرارية المحادثة |
| TUI gateway JSON-RPC (WebSocket) | `agents` (لاحقًا) | خطوة ثانية للتوجيه (`session.steer`) وأسئلة `clarify` النصية؛ ليست الأساس لأن تشغيلها المستقل غير موثّق وهويتها مصمّمة لتطبيق سطح المكتب |
| الجلسات ومصادرها | `sessions` | نخزّن مرجع جلسة Hermes + النسخة التي استلمناها عبر الأحداث؛ **لا نقرأ `state.db` مباشرة** (ملكية البيانات) |
| الذاكرة (`MEMORY.md`/`USER.md`، الموافقة على الكتابة) | `knowledge` (memory browser) + `agents` (per-agent settings) | متصفّح ذاكرة للقراءة والموافقة على المعلّق؛ الكتابة عبر أوامر Hermes لا عبر الملف |
| المهارات | `agents` (per-agent) + `plugins` | قائمة/تفعيل/تثبيت من Hub عبر أوامر Hermes؛ لا ننسخ محتوى المهارات |
| cron | `schedules` | مهمة مجدولة من نوع «Hermes job» تُنشأ عبر CLI/`cli.exec` وتُعرض حالتها (`blocked_config` تظهر كتنبيه في `notify`) |
| قنوات المراسلة + اقتران DM | `agents` (per-agent) + `notify` | Hermes يملك القنوات؛ نعرض الحالة (Saved ≠ متصل) ورمز الاقتران؛ لا نعيد بناء القنوات |
| outbound webhooks/hooks | `notify` + `audit` | نستقبل أحداث دورة الحياة الموقّعة كمصدر تدقيق |
| Kanban | `tasks` | قسم «المهام» عندنا هو الحقيقة لمهام المركز؛ Hermes Kanban يظهر كمرآة للقراءة لمهام Hermes الأصلية (يُقرَّر في ADR لاحق) |
| `.env` و`config.yaml` في بيت Hermes | `models` (ADR 0010) | المركز يكتب مفاتيح المزوّدين في `.env` و`model.default`/`model.provider` في `config.yaml` بدمج غير متلف، ثم يعيد تشغيل الطفل؛ المستخدم لا يشغّل `hermes model` |
| الملفات الشخصية | ADR 0005 (workspaces) + `agents` | مساحة عمل ↔ ملف شخصي Hermes بعلاقة 1:1؛ نحترم «عملية واحدة لكل بيت» |
| `session.usage`/عدّادات الرموز | `audit` | التكلفة لكل جلسة وتشغيل |
| ACP (`hermes acp`) | `agents` (محوّل ACP) | يبقى مسارًا مساندًا للتحقق من محوّل ACP على وكيل نعرفه |

## الأفكار التي نرفضها ولماذا
- **تضمين TUI عبر PTY/xterm في عملائنا** (طريقة اللوحة): عملاؤنا يعرضون أحداثًا منظّمة من العقد، لا شاشة طرفية.
- **Chat Completions كواجهة أساسية**: بلا حالة، ولا تنقل الموافقات والتوجيه.
- **قراءة `state.db`/ملفات البيت مباشرة** (كما تفعل clawboard): يخالف ملكية البيانات؛ نعبر الواجهات فقط.
- **تشغيل عمليتين على بيت واحد**: قاعدة Hermes الصريحة؛ محوّلنا يضمن عملية gateway واحدة لكل ملف شخصي.

## ما لا نأخذه تحت هذه الرخصة
MIT تسمح بالنسخ مع الإشعار، لكن ADR 0004 يسمح فقط بملف كامل بإشعاره مسجَّلًا في `THIRD-PARTY-NOTICES.md` ومبرَّرًا في ADR؛ لا نتوقع أيًا. لا نأخذ: كود Python/TypeScript، `web/` و`ui-tui/`، الأصول (`assets/banner.png`, الشعار)، `SOUL.md` والشخصيات، محتوى المهارات المدمجة (`skills/`, `optional-skills/` — رخصها قد تختلف)، نصوص الوثائق، ولا اسم «Hermes» في علامتنا (نذكره فقط كاسم وقت التشغيل).

## روابط المصدر (MIT) التي قُرئت لسطح `/v1/runs` (2026-09-21)
- <https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py>
- <https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server_runs.py>
- <https://github.com/NousResearch/hermes-agent/blob/main/gateway/config_env.py>
- <https://github.com/NousResearch/hermes-agent/blob/main/tools/approval.py>
- <https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/gateway.py> (`run_gateway`)
- <https://github.com/NousResearch/hermes-agent/blob/main/Dockerfile> و<https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml>
- <https://hermes-agent.nousresearch.com/docs/user-guide/docker>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server>

## روابط (وثائق الموقع، مصدرها `website/docs/` في المستودع بتاريخ 2026-09-21)
- <https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server>
- <https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals>
- <https://hermes-agent.nousresearch.com/docs/user-guide/sessions>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/skills>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>
- <https://hermes-agent.nousresearch.com/docs/user-guide/messaging> (`messaging/index.md`)
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/acp>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation>
- <https://hermes-agent.nousresearch.com/docs/developer-guide/subagent-lifecycle-api>
- <https://hermes-agent.nousresearch.com/docs/user-guide/profiles>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode>
- <https://hermes-agent.nousresearch.com/docs/user-guide/security>
- README الرئيسي عبر `gh api repos/NousResearch/hermes-agent/readme`.
