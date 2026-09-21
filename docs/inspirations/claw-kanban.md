# Claw-Kanban

- المستودع: <https://github.com/GreenSheep01201/Claw-Kanban>
- الرخصة: **Apache-2.0** — تم التحقق من ملف `LICENSE` (نص Apache 2.0 الكامل) بتاريخ 2026-09-21. آخر دفعة في المستودع 2026-02-15؛ مشروع صغير (Express 5 في ملف `server/index.ts` واحد + React 19 + SQLite عبر `node:sqlite`).

## ماذا يفعل (في خمسة أسطر)
1. لوحة Kanban بستة أعمدة (Inbox, Planned, In Progress, Review/Test, Done, Stopped) توجّه البطاقات إلى Claude Code وCodex وGemini CLI وOpenCode (عمليات CLI ترث بيئة المستخدم) وإلى Copilot وAntigravity (HTTP + OAuth).
2. **تكليف تلقائي بحسب الدور**: جدول (DevOps/Backend/Frontend) × (New/Modify/Bugfix) → مزوّد، مع تجاوزات بحسب المرحلة (In Progress مقابل Review/Test).
3. بعد انتهاء المنفّذ (`exit 0`) تنتقل البطاقة إلى Review/Test ويُطلق **مراجعة آلية** بوكيل آخر؛ النجاح → Done مع إشعار إيقاظ، الفشل → تبقى مع تقرير.
4. عارض طرفية حيّ في المتصفح، «chat-to-card» (`# نص` من Telegram/Slack/webhook → `POST /api/inbox`)، وحقل `project_path` إلزامي: الخادم **يمنع** التشغيل إن لم يُحدَّد.
5. كشف حالة تثبيت/مصادقة كل CLI (`GET /api/cli-status` بكاش 30 ثانية)، ويُلحق قواعد تنسيق بملف `AGENTS.md` في مساحة العمل.

## الأفكار التي نتبنّاها
| الفكرة | الوحدة عندنا | كيف نطبّقها نحن |
|---|---|---|
| جدول توجيه دور × نوع مهمة → وكيل، مع تجاوز بحسب المرحلة | `tasks` (assignment rules) + `agents` (roles/capabilities) | قواعد لكل مشروع تُخزَّن وتُحرَّر من الواجهة؛ الوكيل يعلن أدواره في السجل |
| «لا تشغيل بلا مسار مشروع» (fail-closed) | `tasks` | لا run بلا worktree/مستودع محلول؛ الخطأ `{ error, code }` |
| مرحلة مراجعة تلقائية بوكيل مختلف بعد اكتمال التنفيذ | `tasks` + `rooms` | انتقال `in_review` يستدعي مقعد المراجع (كما في clawboard) |
| إدخال بطاقة من رسالة دردشة (`#` بادئة) عبر قناة | `tasks` + محوّل Hermes (قنوات) | أمر في قناة Hermes ينشئ مهمة عبر العقد |
| كشف تثبيت/مصادقة الـ CLI مع كاش وزر تحديث | `agents` (install/version state) | `discover()` يعيد `available` و`auth_state`؛ الكاش في الخادم |
| سجل أحداث لكل بطاقة | `tasks` (timeline) + `audit` | حدث `task.moved`, `run.*` مخزَّن |

## الأفكار التي نرفضها ولماذا
- **تشغيل CLI بوراثة كامل بيئة المستخدم على الخادم**: عندنا محوّلات بإعدادات وأسرار صريحة؛ لا وراثة صامتة.
- **تخزين رموز OAuth لمزوّدي HTTP في التطبيق والاتصال بواجهاتهم مباشرة**: مفاتيح المزوّدين في `models` مشفّرة، لكن «وكيل HTTP» خارج نطاقنا.
- **حقن قواعد في `AGENTS.md` داخل مستودعات المستخدم**: تدخّل في ملفات المستخدم؛ البديل: واجهة موثّقة/مهارة يقرأها الوكيل.
- **ستة أعمدة وثلاثة أدوار ثابتة**: أعمدة وأدوار قابلة للتهيئة لكل مشروع.
- **إيقاظ خاص بـ OpenClaw**: `notify` عام.

## ما لا نأخذه تحت هذه الرخصة
Apache-2.0 مع قيد ADR 0004: لا كود (`server/index.ts`, `src/`)، لا CSS، لا أيقونة `kanban-claw.svg`، لا قالب `templates/AGENTS-kanban.md`، لا نصوص README (بما فيها «AI installation guide»)، لا اسم «Claw-Kanban».

## روابط
- README عبر `gh api repos/GreenSheep01201/Claw-Kanban/readme` (قسما «Dual Execution Model» و«API Reference»)، شجرة الجذر و`server/`.
