# clawboard

- المستودع: <https://github.com/Wadera/clawboard> (نسخة محلية مقروءة بتاريخ 2026-09-21)
- الرخصة: **MIT** — تم التحقق من ملف `LICENSE` في جذر المستودع (نص MIT الكامل، «Copyright (c) 2026 ClawBoard Contributors»). الشارة في README تقول MIT أيضًا، والملف يؤكدها.

## ماذا يفعل (في خمسة أسطر)
1. لوحة ويب (React + Express + PostgreSQL) لإدارة الوكلاء ومراقبتهم: مهام Kanban، مشاريع، تقارير، يوميات (journal)، معرفة (second brain)، أدوات، وحالة الوكلاء لحظيًا.
2. بدأ لوحةً لـ OpenClaw ثم صار Hermes هو الـ harness الأساسي؛ يختار الـ harness لكل مهمة عبر «execution profiles» ويتجه إلى أن يكون harness-agnostic (اتصال MCP على الخارطة).
3. كل ما تفعله الواجهة معروض على REST موثّق بـ OpenAPI (`GET /openapi.json`) وعلى CLI `clawboard`، فأي وكيل يملك المهارة يقدر أن يقود اللوحة.
4. نظام إضافات (plugins) على شكل حاويات Docker لكل إضافة: `plugin.json` + `/health` + Dockerfile، تُحقن في الشريط الجانبي وتُوكَّل لها مسارات API.
5. مراجعة آلية للمهام (implementation vs QA reviewer)، مراقب heartbeat (`clawbeat`) يكتشف المهام العالقة، webhooks خارجية موقّعة بـ HMAC، وسجل تدقيق كامل.

## سطح REST كما قرأناه (أسماء المسارات فقط، لا الكود)
ملفات المسارات في `backend/src/routes/`: `agents`, `agentTypes`, `audit`, `auth`, `botStatus`, `config`, `contentEngine`, `control`, `dashboard`, `files`, `gateway`, `images`, `journal`, `journalPublicationMedia`, `litellmAdmin`, `memory`, `modelStatus`, `models`, `plugins`, `projects`, `rateLimits`, `reports`, `secondBrain`, `sessionsApi`, `status`, `tasks`, `tasksBatch`, `tools`, `voice`, `webhooks`, `workspace`.

أفعال المهام التي لفتت الانتباه: `POST /tasks/:id/spawn | spawn-agent | spawn-prompt | steer | cancel | breakdown | archive | unarchive`، `POST /tasks/:id/subtasks/:index/approve | reject | block | skip`، `GET /tasks/:id/timeline | dependencies | files | context`، `PATCH /tasks/batch`، `POST /orchestration/:id/claim` و`lease/:leaseId/heartbeat | release`، `POST /reviewer/:id/run | reject`، `POST /webhooks`، غلاف خطأ موحّد `{ success:false, error, code, message, suggestion, details[] }`.

## الأفكار التي نتبنّاها (كل فكرة ↔ وحدة في ARCHITECTURE §Modules)
| الفكرة | الوحدة عندنا | كيف نطبّقها نحن |
|---|---|---|
| «الواجهة ليست بابًا خاصًا»: كل شيء عبر OpenAPI موثّق + CLI | `packages/contracts` (ADR 0003) وكل الوحدات | العقد أولًا؛ عملاؤنا مولَّدون منه؛ لا مسار خارج العقد |
| غلاف خطأ يحمل `code` و`suggestion` و`details` بالحقل | كل الوحدات (ثابت رقم 2 في ARCHITECTURE) | `{ error, code }` إلزامي، نضيف `details` للتحقق من المدخلات |
| دورة حياة المهمة مع بوابة مراجعة، `successCriteria`، `maxRetries`، `reviewHistory` | `tasks` | حقول القبول على المهمة، ومراجعة بوكيل مختلف عن المنفّذ |
| فصل «المنفّذ» عن «المراجع» (لا يشهد وكيل على عمله) | `tasks` + `rooms` | انتقال `review` يستدعي مقعد مراجعة في الغرفة |
| `PATCH /tasks/batch` بنتائج لكل معرّف | `tasks` | عملية دفعة واحدة بنتيجة لكل عنصر (200 إن نجح واحد، 422 إن فشل الكل) |
| webhooks خارجية بأسماء أحداث `task.created/updated/deleted/archived` وتوقيع HMAC | `notify` | أحداثنا `<entity>.<verb>` نفسها تُبَثّ للـ webhooks، توقيع `sha256=` على الجسم الخام |
| يوميات وتقارير ومعرفة ومرفقات | `knowledge` | المرحلة 4 |
| إحصاءات، إنفاق، سجل تدقيق | `audit` | استخدام وتكلفة لكل جلسة ومهمة |
| إضافات كحاويات Docker بمانيفست و`/health` ووكيل عكسي | `plugins` | المرحلة 4؛ المانيفست جزء من العقد |
| تصنيف الجلسات ثلاثي: `harness` / `sessionType` / `channel` | `sessions` | حقول على الجلسة بدل «kind» واحد مبهم |
| execution profile: `mode` + `accessProfile` + `requiredCapabilities` | `tasks` + `agents` (capabilities) | المهمة تعلن ما تحتاجه؛ السجل يعرف ما يقدر كل وكيل |
| «claim/lease/heartbeat/release» لتنسيق من يشغّل المهمة | `tasks` (runs) + `schedules` | كل تشغيل job له مالك وعقد إيجار ونبض؛ العالق يُكتشف |
| مراقب heartbeat يكتشف المهام العالقة ويوقظ منسّقًا | `schedules` | مهمة نظام مجدولة تفحص `tasks` وتنبّه عبر `notify` |

## الأفكار التي نرفضها ولماذا
- **قراءة ملفات الوكيل الخاصة مباشرة** (تركيب `~/.openclaw/workspace` للقراءة، قراءة `state.db` لـ Hermes): يخالف قاعدة ملكية البيانات عندنا (الوكيل يحتفظ بحالته في بيته، والمركز يخزّن مراجع ونسخًا استلمها عبر واجهة). نصل إلى Hermes عبر واجهته (انظر `hermes-agent.md`).
- **موصّل مخصّص لكل harness** (WebSocket لـ OpenClaw، spawn لـ Hermes): هذا ما يجعل الوكلاء غير قابلين للاستبدال؛ عندنا `AgentAdapter` واحد (ADR 0002).
- **PostgreSQL فقط**: عندنا SQLite أولًا (ADR 0001).
- **مسارات بلا بادئة يقصّها nginx**: عندنا `/api/v1` صريح في العقد.
- **نموذج «افرع المستودع لتنشر»** (الإعدادات والعلامة في fork خاص): عندنا التهيئة من الواجهة وتُخزَّن (الثابت 5).
- **الشخصيات (agent types) من مستودع خارجي** (`agency-agents`): محتوى برخصة أخرى ولم نتحقق منه؛ وشخصيات الوكيل عندنا إعداد لكل وكيل داخل `agents`.
- **content engine / توليد صور / إدارة LiteLLM**: خارج نطاقنا.
- **كلمة مرور واحدة + JWT**: عندنا مستخدمون وأدوار (owner/admin/member) ورموز تطبيقات.

## ما لا نأخذه تحت هذه الرخصة
MIT تسمح بالنسخ مع الإشعار، لكن ADR 0004 يقيّدنا: **لا نسخ جزئيًا أبدًا**؛ ملف كامل فقط، بإشعاره، مسجَّلًا في `THIRD-PARTY-NOTICES.md`، ومبرَّرًا في ADR. لا نتوقع أي ملف. تحديدًا لا نأخذ:
- الكود (backend/frontend/cli/scripts)، مخططات SQL في `migrations/`، ولا نص `openapi/spec.ts`.
- الأصول: لقطات الشاشة، الأيقونات، ثيم CSS، اسم «ClawBoard» وشعار السرطان.
- الصياغة: نصوص README والوثائق، رسائل الأخطاء، ونصوص واجهة الاستخدام.
- محتوى الشخصيات المستورد من `agency-agents` (رخصة مستقلة).

## روابط
- المستودع: <https://github.com/Wadera/clawboard>
- ملفات قُرئت: `README.md`, `FORK.md`, `docs/api.md`, `docs/execution-profiles.md`, `docs/task-orchestration.md`, `docs/session-taxonomy.md`, `docs/agent-types.md`, `docs/acp-integration-design.md`, أسماء الملفات في `backend/src/routes/`.
