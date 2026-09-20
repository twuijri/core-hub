# agenthub

- المستودع: <https://github.com/hawkingrei/agenthub>
- الرخصة: **Apache-2.0** — تم التحقق من ملف `LICENSE` (نص Apache 2.0 الكامل) بتاريخ 2026-09-21.

## ماذا يفعل (في خمسة أسطر)
1. «control plane» ذاتي الاستضافة لوكلاء برمجة طويلة العمر: خلفية Rust واحدة + واجهة React مضمّنة (PWA) + SQLite؛ ثنائيان `agenthub` و`agenthubd`.
2. **ACP timelines** منظّمة: رسائل، خطط، نداءات أدوات، مخرجات أوامر، تيارات تصحيح، قابلة لإعادة التشغيل، وتبقى حيّة بعد إغلاق المتصفح.
3. **Team**: قائد/عمّال، قنوات وخيوط (`# all` مسار افتراضي)، Kanban هو سطح المهام القياسي للفريق، فحص ACP لكل عضو.
4. **عقد بعيدة**: سجل عقد (`id`, `name`, `grpc_target`, `tls_server_name`, `default_worktree_root`)، انضمام بالرمز أولًا، نقل عبر gRPC مشفّر (TLS/mTLS)، والوكيل يحمل `target_node_id`.
5. نموذج «loop activation» مستهدف: الوكيل يُنشَّط بموجّه دور واحد، يقرأ الحالة عبر أدوات، يسجّل نتيجة، وقد يخرج؛ التقدّم يعيش في المهام والرسائل والذاكرة لا في العملية.

## الأفكار التي نتبنّاها
| الفكرة | الوحدة عندنا | كيف نطبّقها نحن |
|---|---|---|
| خط زمني ACP مخزَّن ومُعاد تشغيله، منفصل عن جلسة المزوّد؛ التنفيذ لا يعتمد على المتصفح | `sessions` (messages, streaming runs, tool calls) | الأحداث تُخزَّن في وحدتنا وتُبَثّ عبر `/rt/sessions`؛ الاتصال اللاحق يعيد `since` |
| مفردات صارمة: `task` (ملكية) / `attempt` (محاولة) / `run` (تقسيم تنفيذ) | `board` + العقد | نستخدم `task` و`run` ونوثّق الفرق في العقد |
| سجل عقد يخزّن التوجيه فقط، **أبدًا** أسرارًا أو رموز انضمام أو مسارات TLS | `devices` + `auth` | الجهاز المقترن سجل توجيه؛ الأسرار في `auth` مشفّرة |
| `target_node_id` على الوكيل (أين يعمل) | `agents` + `devices` | حقل `device_id` اختياري في سجل الوكيل |
| انضمام العقدة بالرمز أولًا من شاشة الوكلاء | `auth` (pairing) + `devices` | يوازي اقتران QR عندنا |
| طبقات ACP الثلاث: مزوّد / وضع (محلي، بعيد، إعادة استخدام جلسة) / سياسة proxy | `agents` (ACP adapter) | المحوّل يفصل «من يتكلم ACP» عن «أين يعمل» عن «الخروج للشبكة» |
| قاعدة صيغة واحدة للأسماء (snake_case) وتطبيع camelCase القادم من ACP عند الحدّ | `packages/contracts` | نختار صيغة واحدة في العقد؛ التطبيع في المحوّل |
| تنشيط حلقي: العملية قد تخرج والمهمة تستمر من حالة دائمة | `schedules` + `board` | run لا يفترض عملية حيّة؛ إعادة التنشيط حدث |
| Kanban هو سطح مهام الفريق، والقنوات/الخيوط للتنسيق | `rooms` + `board` | الغرفة تشير إلى مهام اللوحة ولا تنسخها |
| إشعار اكتمال في الواجهة | `notify` | حدث `run.completed` يصل كإشعار |

## الأفكار التي نرفضها ولماذا
- **gRPC داخلي + gossip للعضوية**: أثقل من احتياج جهاز واحد؛ عندنا قناة Socket.IO للأجهزة (`/rt/devices`).
- **Rust/Bazel**: ADR 0001.
- **Nowledge Mem كخدمة ذاكرة خارجية**: ذاكرتنا من Hermes + `knowledge`.
- **PWA فقط**: عندنا تطبيقات أصلية.
- **تثبيت إصدار Codex CLI في المنتج**: الإصدارات في سجل `agents`.

## ما لا نأخذه تحت هذه الرخصة
Apache-2.0 مع قيد ADR 0004 (لا نسخ جزئي): لا كود Rust، لا ملفات `proto/`، لا أصول `web/`، لا نصوص `docs/features/*.md` (نعيد صياغة الأفكار بكلماتنا)، لا اسم «AgentHub».

## روابط
- README، `docs/api_naming.md`, `docs/architecture-map.md`, `docs/features/acp-runtime.md`, `docs/features/agent-nodes.md`, `docs/features/agent-loop-product-model.md`, `docs/features/team-execution-vocabulary.md`, `docs/features/distributed-node-architecture.md`.
