# AionUi

- المستودع: <https://github.com/iOfficeAI/AionUi>
- الرخصة: **Apache-2.0** — تم التحقق من ملف `LICENSE` (نص Apache License 2.0 الكامل) عبر `gh api repos/iOfficeAI/AionUi/license` بتاريخ 2026-09-21. الشارة في README مطابقة.

## ماذا يفعل (في خمسة أسطر)
1. تطبيق سطح مكتب (Electron) «Cowork» يعمل مع وكلاء AI على جهاز المستخدم: قراءة ملفات، كتابة كود، تصفح، أتمتة، مع محرك وكيل مدمج (`aionrs`/AionCore بلغة Rust) يعمل بأي مفتاح API.
2. يكتشف تلقائيًا أدوات CLI المثبتة (Claude Code، Codex، Gemini CLI، Qwen Code، Goose، OpenClaw، Hermes، Cursor Agent، ‎20+‎) ويشغّلها عبر **ACP (Agent Client Protocol)** في واجهة واحدة بجلسات متوازية.
3. طبقة «مساعدين» (21 مساعدًا مدمجًا) ومهارات ثلاثية المصدر (مدمجة/مخصّصة/إضافات) فوق محركات التنفيذ، وإدارة MCP موحّدة تُحقن حسب قدرات كل وكيل.
4. Team Mode: وكيل قائد يوزّع مهامًا فرعية على وكلاء زملاء عبر خادم MCP مدمج، بريد غير متزامن ولوحة مهام مشتركة، وحوار صلاحيات مستقل لكل وكيل.
5. وصول عن بعد: WebUI بتسجيل دخول QR أو كلمة مرور، قنوات Telegram/Lark/DingTalk/WeChat، ومهام مجدولة (cron/فاصل/مرة واحدة) مربوطة بمحادثة.

## كيف يكتشف الوكلاء ويستخدم ACP (من `packages/desktop/src/common/types/agent/detectedAgent.ts` وREADME)
- طبقة «اكتشاف» تُمثّل محركات التنفيذ المتاحة: النوع `DetectedAgent<K>` بحقول `id`, `name`, `kind`, `available`, `backend`.
- الأنواع `kind`: `acp` | `remote` | `aionrs` | `openclaw-gateway` | `nanobot`؛ لكل نوع حقول خاصة:
  - `acp`: `cli_path` (المسار المحلول للثنائي)، `acpArgs`، وهل جاء من إضافة (`isExtension`, `extensionName`, `custom_agent_id` بصيغة `ext:name:adapterId`).
  - `remote`: `url` (WebSocket)، `protocol` ∈ {`openclaw`, `zeroclaw`, `acp`}، `authType` ∈ {`bearer`, `password`, `none`}.
- **المساعدون ليسوا وكلاء مكتشفين**: هم طبقة إعداد (قواعد + مهارات) تشير إلى محرك تنفيذ. الفصل صريح في التعليق التوثيقي.
- الوكلاء الخارجيون يتصلون عبر ACP، وAionUi ينسّق الفريق؛ أي واجهة ACP خلفية تعلن `mcpCapabilities.stdio` تُدعم تلقائيًا في Team Mode.

## الأفكار التي نتبنّاها
| الفكرة | الوحدة عندنا | كيف نطبّقها نحن |
|---|---|---|
| ACP موصّلًا عامًا، واكتشاف CLI المثبتة على المضيف | `agents` (ADR 0002 — ACP adapter) | `discover()` في المحوّل يعيد سجلًا من الخادم؛ لا قائمة ثابتة في أي عميل |
| فصل «المحرك المكتشف» عن «الإعداد/المساعد» | `agents` | سجل الوكلاء (registry) منفصل عن الإعدادات لكل وكيل (presets) |
| حقول `available` و`cli_path` وإصدار في السجل | `agents` (install/version state) | الحالة تُخزَّن وتُبَثّ كأحداث، لا تُستنتج في العميل |
| وكيل «بعيد» بعنوان وبروتوكول وطريقة مصادقة | `agents` + `devices` | الوكيل قد يعمل على جهاز مقترن؛ الجهاز يعلن قدراته |
| محوّلات تسهم بها الإضافات (`ext:name:adapterId`) | `plugins` | المرحلة 4: إضافة تسجّل محوّل ACP بمعرّف مسبوق باسمها |
| إدارة MCP موحّدة تُحقن حسب قدرات كل وكيل | `agents` (capabilities) + `plugins` | قدرة `mcp.stdio` جزء من `capabilities()` في المحوّل |
| جدولة بثلاثة أنماط (cron مع منطقة زمنية/فاصل/مرة واحدة) وربط المهمة بمحادثة قائمة أو جلسة جديدة | `schedules` | خيار «تابع في الجلسة» أو «جلسة جديدة» لكل job |
| قائد/زملاء مع حوار صلاحيات لكل وكيل وشارة للمعلّقات | `rooms` + `sessions` (approvals) | الغرفة تملك المقاعد والتسليم؛ الموافقات لكل تشغيل وتُعرض كشارة عامة |
| تسجيل دخول WebUI بـ QR | `auth` (device pairing) | عندنا أصلًا؛ نؤكده |

## الأفكار التي نرفضها ولماذا
- **شحن محرك وكيل مدمج**: Majlis لا يشحن محركًا؛ يقود Hermes Agent ووكلاء ACP (ARCHITECTURE «الوكلاء قابلون للاستبدال»).
- **سطح المكتب أولًا والعمليات داخل التطبيق**: عندنا الخادم هو المنتج والعملاء رقيقة.
- **مساعدو Office (PPT/Word/Excel) والحيوان الأليف (pet) والشراكات الإعلانية**: خارج النطاق.
- **قائمة ‎30+‎ منصة نماذج داخل المنتج**: `models` تحفظ كتالوج المزوّدين كبيانات، لا كتسويق.
- **وضع YOLO كمفتاح عام**: الموافقات عندنا لكل تشغيل داخل `sessions`، ويقرّرها الخادم.

## ما لا نأخذه تحت هذه الرخصة
Apache-2.0 يسمح بالنسخ مع `NOTICE`، لكن ADR 0004 يمنع النسخ الجزئي. تحديدًا لا نأخذ:
- كود `packages/desktop` (Electron/React)، ولا أنواع TypeScript حرفيًا (نصمّم أنواعنا في العقد).
- ملفات اللغات `locales/*.json` (نصوص واجهة)، وكتالوج المساعدين `assistants.json` والمهارات المدمجة (تعيش في AionCore).
- الصور والشعارات والـ GIF في `resources/`، واسم «AionUi».
- صياغة README والوثائق.

## روابط
- README عبر `gh api repos/iOfficeAI/AionUi/readme`، `docs/README.md`، قائمة `docs/prds/*` (agent-browser, assistants, conversations, cron, pet, previews, remote, settings, teams, workspaces).
- `packages/desktop/src/common/types/agent/detectedAgent.ts` (أنواع الاكتشاف).
