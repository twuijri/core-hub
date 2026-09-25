# أدوات كور هب نفسه لوكلائه عبر MCP
المسؤول: twuijri · الفرع: feat/hub-mcp · الحالة: review

## المشكلة والهدف
الوكيل داخل كور هب لا يستطيع أن يقود المنصّة نفسها: لا يرى المهام ولا ينشئها، ولا يجدول،
ولا يقرأ المحادثات، ولا ينبّه الشخص. المطلوب (تقرير المراقب): أن يقدّم الهب نفسه لوكلائه
**خادم MCP** بمجموعات أدوات (المهام، الجداول، المحادثات، التنبيهات، سير العمل، ملفات
البروفايل)، يُحقن في إعداد Hermes لكل بروفايل آليًا، وكل استدعاء يعمل **باسم صاحب
التشغيل وفي بروفايله فقط** وبفحوص الصلاحيات نفسها التي في واجهة REST، ولا يكون مديرًا أبدًا.

## القرار والموافقات
كل ما يلي **مقترح — ينتظر تأكيد المالك** (قرار العقد §58؛ المالك نائم، فاتُّخذ القرار وسُجّل):

1. **النقل: Streamable HTTP على منفذ الهب نفسه** (`POST /api/v1/hub-mcp`، رسالة JSON-RPC
   واحدة في كل طلب وجوابها `application/json`، والإشعار `202` بلا جسم) — لا أمر `corehub mcp`
   عبر stdio. السبب: Hermes يعمل بجانب الهب (ADR 0008) ويصل إليه على الـloopback ويتكلم
   HTTP MCP بترويسات جاهزة؛ أمر stdio يحتاج Node والـCLI في بيئة كل وكيل وعملية لكل اتصال،
   ثم يضطر أن ينادي HTTP الهب ليفعل شيئًا.
2. **الحقن:** تشغيل البطاقة يكتب كتلة واحدة اسمها `corehub` في `config.yaml` للبروفايل
   (`url` و`Authorization: Bearer ${COREHUB_MCP_TOKEN}` وتعليق فوقها بأنها للهب) ومفتاحًا
   جديدًا في `.env` البروفايل؛ Hermes يملأ الترويسة من `.env` البروفايل نفسه، فالمفتاح لا
   يدخل ملف الإعداد الذي يحمله تصدير البروفايل. تُعاد الكتلة عند كل إقلاع إن تغيّرت (بمفتاح
   جديد إن ضاع القديم)، وتُحذف مع المفتاح عند الإطفاء، ومسارات MCP العامة ترفض تعديلها
   (`409 mcp_managed`). وكيل البرمجة عبر ACP يأخذ الخادم نفسه في `session/new` إن أعلن أنه
   يصل إلى خادم MCP عبر HTTP.
3. **المفتاح يسمّي البروفايل، والتشغيل الحيّ يسمّي الشخص.** Hermes يُبقي اتصال MCP واحدًا لكل
   بروفايل ولا يقول في الاستدعاء أي محادثة طلبته، فلا يمكن حمل رمز لكل محادثة على السلك.
   لذلك كل تشغيل يبدؤه الهب يفتح «عقدًا» ويصكّ **رمز تشغيل** لصاحبه يُلغى عند انتهائه؛
   `initialize` و`tools/list` تكفيهما المفتاح، و`tools/call` يحتاج تشغيلًا حيًّا في بروفايل
   المفتاح ويمرّ بمسارات REST نفسها برمز ذلك التشغيل. إن كان لعدة أشخاص تشغيل حيّ معًا فالحَكَم
   إعلان الوكيل نفسه عن الاستدعاء (`mcp__corehub__…` أو عبر جسر `tool_call` في Hermes)، وإن
   بقي الالتباس بعد ثانيتين يُرفض (`hub_tools_run_ambiguous`) ولا يُخمَّن. لا تشغيل حيًّا
   (رسالة من قناة، سؤال العنوان) = رفض (`hub_tools_no_live_run`). الرفض نتيجة أداة بـ`isError`
   ورمز الهب، لا خطأ HTTP، ليقرأ الوكيل السبب.
4. **ذلك الشخص، ذلك البروفايل، ولا مدير أبدًا:** رمز التشغيل يدخل بروفايل تشغيله وحده (ترويسة
   بروفايل آخر أو `profiles=all` لا تتجاوزه)، نطاقاته `read` و`write`، ودوره `member` مهما كان
   دور الشخص، فكل مسار للمديرين يرفضه. يُقرأ الشخص عند كل استدعاء. التنبيه يُكتب في صندوق صاحب
   التشغيل وحده، وأدوات الملفات لا تخرج من `${DATA_DIR}/workspaces/<profile>` ولا تتبع رابطًا.
5. **مطفأ افتراضيًا؛ وعند التشغيل قراءة فقط:** كل مجموعة تقرأ ولا تكتب حتى يُفتح مفتاح
   «السماح بالتعديل» الخاص بها.
6. مجموعات `browser` و`devices` و`usage` التي ذكرها المراقب «ربما» لم تُبنَ: لا عمليات تُربط بها بعد.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `GET` و`PATCH /agents/{agent_id}/hub-tools` (`agents.getHubTools`، `agents.updateHubTools`
  للمديرين) بالمخططات `HubTools` و`HubToolsPatch` و`HubToolGroup` و`HubToolGroupId` و`HubTool`
  و`HubToolCall`.
- `POST /hub-mcp` (`agents.hubMcp`، `security: []`، مفتاح البروفايل في `Authorization`) بالمخطط
  `JsonRpcMessage`؛ `200` و`202` و`400` و`401`.
- قرار العقد §58 في `docs/contracts/DECISIONS.md`.

## الملفات والتأثير
- الخادم: `packages/server/src/modules/agents/hub-tools/` (`catalog.ts` الأدوات الـ18،
  `protocol.ts` JSON-RPC، `leases.ts` نسبة الاستدعاء إلى تشغيل، `block.ts` الكتلة والمفتاح،
  `service.ts`، `routes.ts`)؛ `auth/run-tokens.ts` ورموز التشغيل في `principal.ts` والتثبيت
  على بروفايل واحد في `workspace.ts`؛ `agents/runner.ts` يفتح العقد ويغلقه ويعدّ إعلانات الوكيل؛
  `sessions/engine.ts` يمرّر صاحب التشغيل؛ `adapters/acp.ts` يمرّر الخادم في `session/new`؛
  `hermes-runtime.ts` `refreshTui()`؛ حارس `mcp_managed` في مسارات MCP؛ ترحيل
  `drizzle/0016_hub_tools.sql` (جدولا `hub_tool_settings` و`hub_tool_calls`)؛ منفذ التنبيه في
  `modules/index.ts`.
- الويب: `HubToolsCard.tsx` (بطاقة «أدوات كور هب» في صفحة MCP للوكيل: المجموعات بوصفها، مفتاح
  للكل ولكل مجموعة ولتعديلها، آخر الاستدعاءات بكلمات الهب، زر «اختبار» يعيد استعمال اختبار #80)،
  `McpTestResultView.tsx` (نتيجة الاختبار مشتركة)، `skills.ts` (الخطافات)، قائمة الخوادم تُخفي
  كتلة الهب؛ النصوص عربية وإنجليزية في `ar.json`/`en.json`.
- الوثائق: `DECISIONS.md` §58، `STATUS.md` (209 من 267)، `docs/domain/agents.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (عبر `mj-run`)، ما يمسّه التغيير فقط:

```
$ pnpm contracts:lint
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 284 client file(s) scanned, 178 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck        (بلا أخطاء)

# الخادم: ملفات الاختبار الجديدة والمتأثرة
$ vitest run hub-tools.test.ts hub-tools.routes.test.ts adapters.test.ts runner.test.ts tests/unit/status.test.ts
 Test Files  5 passed (5)
      Tests  65 passed (65)
$ vitest run --project contract        (يشمل hub-tools.contract.test.ts الجديد)
 Test Files  5 passed (5)
      Tests  278 passed (278)

# الويب
$ vitest run tests/hub-tools-card.test.tsx tests/agents-top-level.test.tsx
 Test Files  2 passed (2)
      Tests  10 passed (10)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zz-agent-tools.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zz-agent-tools.spec.ts:47:1 › 23. the agent tools ask Hermes: an MCP test, a skill pack imported, WhatsApp linked by QR (8.0s)
  1 passed (15.3s)

# Hermes الحقيقي من الصورة (Hermes Agent v0.21.3 (2026.9.14))، بنموذج مُبرمَج على هذا الجهاز
$ COREHUB_HERMES_IMAGE=core-hub:channeldeps vitest run src/modules/agents/hub-tools/hub-tools.real.test.ts
 ✓ … > Hermes lists the hub tools, an agent turn calls tasks.create, and the task is on the board 3566ms
 ✓ … > the card's Test: Hermes's own MCP test connects to the hub and lists the tools offered 2614ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

ما أثبته الاختبار الحقيقي: Hermes اتصل بالهب عبر الكتلة التي كتبها، وعرض أدواته على النموذج
(خلف جسر `tool_search` — Hermes يؤجّل أدوات MCP حين تكثر الأدوات)، والنموذج نادى
`mcp__corehub__tasks_create` عبر `tool_call`، فظهرت المهمة في اللوحة باسم صاحب المحادثة وسُجّل
الاستدعاء بجلسته. وسؤال العنوان الذي يطرحه الهب بعد الدور (محادثة خارج أي تشغيل) رُفض حين جرّب
النموذج الأداة فيه — وهذا هو المقصود. واختبار Hermes نفسه (`/api/mcp/servers/corehub/test`) سرد
الأدوات المعروضة ولم يسرد `files.write` المقفلة.

CI على GitHub: (يُضاف بعد الدفع)

## المخاطر والرجوع
- **الترحيل `0016`** قد يتصادم رقمه مع فروع مفتوحة أخرى تضيف ترحيلًا؛ عند الدمج يُعاد توليده
  برقم تالٍ (الجدولان جديدان ولا يلمسان جداول غيرهما).
- **نسبة الاستدعاء:** مع عدة أشخاص يشغّلون في البروفايل نفسه في اللحظة نفسها قد يُرفض استدعاء
  لم يُعلَن حدثه خلال ثانيتين — رفض لا تنفيذ باسم خاطئ. قنوات المراسلة (تيليجرام/واتساب) لا
  تستطيع استعمال الأدوات لأن لا شخص يملك تشغيلها.
- **قائمة أدوات Hermes** تتحدّث حين تبدأ محادثته التالية (يُتقاعد بوابة TUI الحالية)؛ رفض
  مجموعة مطفأة يسري فورًا عند الاستدعاء.
- الرجوع: إطفاء البطاقة يزيل الكتلة والمفتاح؛ أو revert للفرع (الجدولان يبقيان فارغين بلا أثر).

## التسليم والخطوة التالية
- طلب دمج بالإنجليزية إلى `main`؛ المالك يؤكد القرارات 1–5 أعلاه أو يغيّرها.
- لاحقًا: مجموعات `browser`/`devices`/`usage` حين توجد عملياتها، وتجربة على مكدّس التست بـHermes
  والوكلاء الحقيقيين.
