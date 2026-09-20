# مصفوفة الميزات — المشاريع الملهِمة مقابل هدف Core Hub

قراءة بتاريخ 2026-09-21 من README ووثائق كل مشروع (لا من الكود). القيم: **نعم** / **جزئي** / **لا** / — (لا ينطبق). الملاحظة بعد الشرطة قصيرة عمدًا؛ التفاصيل في صفحة كل مشروع. عمود Core Hub = الهدف بحسب `docs/ARCHITECTURE.md` و`docs/ROADMAP.md` (رقم المرحلة بين قوسين).

| القدرة | Hermes Studio / Ekko | clawboard | AionUi | Vibe Kanban | Multica | Proliferate | agenthub | Claw-Kanban | Hubcode | Hermes Agent | **Core Hub (الهدف)** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| بث المحادثة (chat streaming) | نعم — Socket.IO | جزئي — نسخ الجلسات وبث مخرجات | نعم — جلسات متوازية | نعم — جلسة داخل workspace | نعم — دردشة + بث نسخة الـ run | نعم — محادثة لكل worktree | نعم — خط زمني ACP | جزئي — عارض طرفية فقط | نعم — دردشة متعددة التبويبات | نعم — TUI/gateway/SSE | **نعم** — `sessions` + `/rt/sessions` (0) |
| غرف متعددة الوكلاء | نعم — الغرف | لا — على الخارطة | جزئي — Team Mode قائد/زملاء | لا | جزئي — squads + تعليقات | جزئي — روستر وكلاء أبناء | نعم — قنوات وخيوط `# all` | لا | جزئي — جلسة مشتركة مع بشر | جزئي — delegate + Kanban ملفات شخصية | **نعم** — `rooms` مقاعد/ذكر/تسليم (1) |
| لوحة مع تكليف الوكلاء | جزئي — Kanban تحت وكيل Hermes | نعم — مهام/مشاريع/مراجع | جزئي — لوحة فريق داخلية | نعم — issues → workspaces | نعم — الوكيل مكلَّف | جزئي — فرز runs بلا Kanban | نعم — Kanban الفريق | نعم — تكليف بالدور | نعم — بطاقة لكل worktree | نعم — `kanban.db` + dispatcher | **نعم** — `board` (1) |
| عزل worktree لكل مهمة | لا — غير موثّق | لا — دليل ملفات للمهمة | لا — مجلد مشترك للفريق | نعم | جزئي — قفل دليل محلي لكل runtime | نعم | جزئي — `default_worktree_root` للعقدة | لا — `project_path` | نعم | نعم — worktrees + Kanban | **نعم** — `board` worktree لكل مهمة (1) |
| سير عمل / جداول | نعم — Workflow | جزئي — heartbeat + مراجع آلي | نعم — cron/فاصل/مرة | لا | نعم — Autopilots | نعم — Workflows جيل 2 | جزئي — جدولة بدء وتذكيرات | لا | نعم — loops + schedules | نعم — cron + webhook | **نعم** — `schedules` cron + DAG (1) |
| اتصال ACP (Agent Client Protocol) | جزئي — وكلاء برمجة بتوصيل خاص | جزئي — «ACP» هنا بروتوكول OpenClaw لا Zed | نعم — الموصّل الأساسي | لا — harness أصلي | لا — daemon يشغّل CLI | جزئي — MCP يُقدَّم كخادم ACP | نعم | لا | لا — عمليات CLI | نعم — `hermes acp` | **نعم** — محوّل ACP (0) |
| Hermes أصلي | نعم | نعم — harness أساسي | جزئي — أحد وكلاء ACP | لا | جزئي — CLI `hermes` كـ runtime | لا | لا | لا | لا | — (هو وقت التشغيل) | **نعم** — محوّل `hermes` (0) |
| تطبيقات جوال | نعم — أندرويد وiOS (لنا) | لا — على الخارطة | جزئي — WebUI + قنوات دردشة | جزئي — ويب متجاوب | جزئي — iOS من المصدر | لا — macOS فقط | جزئي — PWA | لا — Telegram | جزئي — «قريبًا» بحسب الموقع | جزئي — Termux + المراسلة | **نعم** — أصلي أندرويد وiOS (0) |
| سطح مكتب | نعم — Electron | لا | نعم — Electron | جزئي — `npx` محلي + تطبيق ثانوي | نعم — Electron | نعم — Tauri | لا — ويب/PWA | لا | نعم — macOS Electron | نعم — Hermes Desktop | **نعم** — `apps/desktop` (3) |
| صوت | نعم — STT/TTS في النماذج | جزئي — سرد صوتي لليوميات | لا | لا | لا | لا | لا | لا | نعم — STT/TTS محلي + غرفة | نعم — voice mode + wake word | **جزئي** — مزوّدو STT/TTS + relay الجهاز (1–3) |
| معرفة / يوميات | جزئي — متصفّح ذاكرة تحت الوكيل | نعم — journal + second brain + تقارير | جزئي — تخطيط بالملفات | جزئي — ملاحظات workspace | جزئي — موارد المشروع + مهارات | جزئي — قوالب مستندات | جزئي — Nowledge Mem (قيد التنفيذ) | لا | لا | نعم — ذاكرة + بحث جلسات + مهارات | **نعم** — `knowledge` (4) |
| إضافات | جزئي — صفحة إضافات Hermes | نعم — حاويات Docker | نعم — Extension SDK + مهارات | لا | جزئي — مهارات + MCP | جزئي — MCP/مهارات مشتركة | جزئي — تسجيل أدوات التطبيق | لا | جزئي — مركز MCP + مهارات | نعم — plugins + hooks + MCP | **نعم** — `plugins` (4) |
| تدقيق / تكلفة | جزئي — Usage/Performance/Logs | نعم — audit + stats + spend | لا | لا | نعم — رموز لكل run + سجل تنفيذ | جزئي — غلاف ميزانية (هدف) | جزئي — سجلات تشغيل SQLite | جزئي — سجل أحداث البطاقة | لا | جزئي — `/usage`, `/insights` | **نعم** — `audit` (4) |
| قناة تحديثات | نعم — قناة test + محدّث سطح المكتب | لا — `git pull` | نعم — محدّث تلقائي | جزئي — `npx` آخر إصدار | جزئي — إصدارات شبه يومية | جزئي — changelog | جزئي — ثنائيات/deb/npm + PWA | لا | جزئي — صفحة إصدارات | نعم — `hermes update` | **نعم** — `updates` قنوات test/latest (4) |

## ملاحظات على القراءة
- «Hermes Studio / Ekko» مقيَّم من قائمة الميزات وخريطة التنقّل فقط (بلا مصدر)؛ خانة «عزل worktree» = لا لأنها غير موثّقة عندنا، لا لأننا تحققنا من غيابها.
- «اتصال ACP» عند clawboard يشير إلى Agent Control Protocol الخاص بـ OpenClaw (وثيقة `acp-integration-design.md`)، وهو غير Agent Client Protocol الذي نعنيه.
- Vibe Kanban في طور الإيقاف؛ خاناته تصف ما وثّقه لا ما سيبقى.
- Hubcode: README يذكر iOS/Android/Electron/ويب/CLI، والموقع يقول «iOS & Android coming soon»؛ اعتمدنا الأضعف.
- الترخيص لا يظهر في المصفوفة عمدًا؛ مرجعه الجدول في `README.md` وصفحة كل مشروع.
