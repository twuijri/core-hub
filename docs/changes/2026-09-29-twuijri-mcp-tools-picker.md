# أدوات خادم MCP بلا ضغط «اختبار» كل مرة، واختيار الأدوات المسموحة للوكيل

المسؤول: twuijri · الفرع: batch/2026-09-29 · الحالة: review

## المشكلة والهدف

طلب المالك (2026-09-29) في صفحة الوكيل ← Hermes ← MCP:

1. قائمة أدوات كل خادم دون ضغط «اختبار» في كل مرة. كانت نتيجة آخر اختبار تعيش في ذاكرة المتصفح
   فقط، و`toMcpServer` في الخادم يرجع دائمًا `connected: false` و`tools: []`.
2. اختيار الأدوات التي يستخدمها الوكيل من كل خادم: مربع لكل أداة، وأزرار «الكل» و«لا شيء» و«للقراءة
   فقط»، والحفظ يكتب مرشّح Hermes نفسه لكل خادم في `config.yaml` للبروفايل.
3. الجوالات تعرض العدد والقائمة؛ والاختيار على الجوال متابعة لاحقة إن كبر.
4. اختبارات للخادم والويب، واختبار على Hermes الحقيقي بأن الخادم المرشَّح لا يعرض إلا المسموح.

## القرار والموافقات

(DECISIONS §134، مقترح — للمالك أن يؤكد)

- **آخر اختبار يحفظه الهاب** في ملف JSON واحد من حالته هو (`<data>/mcp-last-tests.json`)، مفتاحه
  مجلد Hermes للبروفايل ثم اسم الخادم — لا في مجلد Hermes، ولا ترحيل قاعدة بيانات. يُحدَّث عند كل
  «اختبار» (`agents.testMcpServer`) وعند نجاح ربط OAuth (الأدوات التي يسألها الهاب لـ Hermes بعد
  الربط)، ويُحذف مع حذف الخادم. يُحفظ معه بصمة (hash) لإعدادات الاتصال (الكتلة بلا `enabled` و`tools`
  و`oauth`)؛ إن تغيّرت الإعدادات بعد الاختبار يقول `stale: true` إن القائمة قد تكون قديمة.
- **قراءة أم تعديل**: كل أداة محفوظة تحمل `access` (`read` / `write` / `unknown`) ومصدره. قرأت مصدر
  Hermes (MIT) عند v2026.9.14 وv2026.9.24: ردّ الاختبار في Hermes لا يحمل أي تعليقات MCP
  (annotations)، وHermes يحفظ فقط `readOnlyHint: true` في `cache/mcp_schema_cache.json` للبروفايل
  للأدوات التي سجّلها، ولا يحفظ `destructiveHint` أبدًا. فالهاب يأخذ `readOnlyHint` من هناك إن وُجد
  (`annotation`)، وإلا يقرأ الأفعال في اسم الأداة (`name`): أي فعل تغيير (create/update/delete/move/
  merge/add/remove/send/upload/start/stop/execute/run…) يجعلها `write`، وإلا فعل نظر (get/list/search/
  read/fetch/query…) يجعلها `read`، وإلا `unknown`. هو اقتراح يُعرض بجانب كل أداة، والشخص يقرر.
- **المرشّح هو مرشّح Hermes نفسه**: `mcp_servers.<name>.tools.include` (قائمة سماح، تغلب، و`[]` تعني
  لا شيء) و`tools.exclude` (قائمة منع)، أسماء أو أنماط `fnmatch`. هذه المفاتيح يقرؤها Hermes في
  `tools/mcp_tool_registration.py` (`_make_tool_filter`) ويكتبها أمره `hermes mcp configure`، وهي نفسها
  في النسختين. الكتابة (`setMcpToolFilter` في `mcp.ts`) تحفظ بقية الكتلة (`tools.resources`
  و`tools.prompts`) وكل تعليقات الملف. Hermes يطبّقه عند اتصاله التالي بالخادم (إعادة التشغيل التي
  تقولها الصفحة أصلًا). اختبار Hermes يعرض كل الأدوات دائمًا بلا ترشيح، فالقائمة كاملة للاختيار.
- **الويب**: الصف المطوي يعرض العدد («الأدوات: 61» أو «الأدوات: 12 من 61»، أو «فشل الاختبار»)،
  والفتح يعرض القائمة مع وقت آخر اختبار وبحث حين تزيد الأدوات عن 8. خادم لم يُختبر قط يُختبر مرة
  واحدة تلقائيًا أول ما يُفتح صفه (مع مؤشر انتظار)، لا في كل عرض. عند الحفظ: كل المربعات محددة ←
  بلا مرشّح (والأدوات الجديدة مسموحة)؛ مرشّح كان قائمة منع يبقى قائمة منع؛ وإلا قائمة سماح بالمحدد،
  والصفحة تقول إن الأداة التي يضيفها الخادم لاحقًا تبقى مغلقة حتى تُحدَّد. نمط كتبه الشخص بيده يبقى،
  والأدوات التي يحددها لا يغيّرها مربع. أداة اختفت من الخادم تبقى في القائمة بلا ضرر.
- **هاب أقدم** (بلا `last_test`): الصفحة كما كانت تمامًا — لا عدد ولا اختبار تلقائي.
- **iOS وAndroid**: العدد في الصف، والقائمة عند الفتح (قراءة/تعديل لكل أداة، و«غير مسموحة للوكيل»
  إن كان المرشّح يمنعها)، وملاحظة أن الاختيار من الويب. **الاختيار على الجوال لم يُبنَ** (متابعة).
  وبعد «اختبار» على الجوال تُعاد قراءة القائمة ليظهر ما حفظه الهاب.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

إضافي فقط (`pnpm contracts:compat`: لا كسر مقابل v1.1.5):
- `McpServer.last_test` (اختياري، `McpLastTest` أو `null`) و`McpServer.tool_filter` (اختياري).
- `McpServerPatch.tool_filter` (اختياري).
- مخططات جديدة: `McpToolFilter`، `McpLastTest`، `McpTestedTool`.
- لا عملية جديدة ولا حدث جديد. التطبيقات القديمة تتجاهل الحقول الجديدة.

## الملفات والتأثير

- العقد: `packages/contracts/openapi.yaml`؛ `docs/contracts/DECISIONS.md` §134.
- الخادم: `modules/agents/mcp.ts` (`toolFilter`، `fingerprint`، `setMcpToolFilter`)،
  `mcp-last-test.ts` (جديد: المخزن والتصنيف)، `index.ts` (الإرجاع والحفظ والكتابة والحذف)،
  `mcp-oauth-routes.ts` (حفظ نتيجة ما بعد الربط).
- اختبارات الخادم: `mcp.test.ts`، `mcp-last-test.test.ts` و`mcp-last-test.routes.test.ts` (جديدان)،
  `mcp-oauth.routes.test.ts`، و`mcp-tool-filter.real.test.ts` (جديد، على Hermes الحقيقي).
- الويب: `agents/McpToolsPanel.tsx` و`agents/mcpToolFilter.ts` (جديدان)، `agents/AgentMcpScreen.tsx`،
  `agents/skills.ts`، `styles/screens.css`، `i18n/{ar,en}.json`، `tests/mcp-tools.test.tsx`
  و`tests/mcp-tool-filter.test.ts` (جديدان)، `e2e/zzzzzzzzzzzzzzz-mcp-tools.spec.ts` (جديد)،
  `e2e/hub.ts` (خادم «picker» في Hermes المبرمج)، ولقطات `e2e/shots/agent-mcp-*`.
- iOS: `Screens/Agent/AgentMcpPage.swift`، `AgentsTwoRules.swift`، `i18n/agents2.{ar,en}.json`.
- Android: `ui/screens/agent/AgentMcpPage.kt`، `AgentsTwoRules.kt`، `i18n/agents2.{ar,en}.json`.
- `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)

الاختبارات الجديدة تفشل على الكود القديم (نسخة `origin/main` من `AgentMcpScreen.tsx` ثم من
`index.ts`) وتنجح بعد التغيير؛ الناجح الوحيد في كل منهما هو حالة التوافق/404 التي لم تتغير:

```text
# الويب، AgentMcpScreen.tsx القديم:
     × counts the tools on the folded row and lists them on opening, without a test
     × tests a never-tested server once, by itself, when its row opens
     × Read-only ticks the looking tools; Save writes an allow-list and the row says "2 of 5"
      Tests  3 failed | 1 passed (4)
# الخادم، index.ts القديم:
     × is null until tested, then comes back on the list with its tools, classified
     × goes stale when the server is edited, not when it is switched or filtered
     × is kept per profile, and goes with the server when it is deleted
     × writes Hermes's `tools.include` / `tools.exclude` and reads them back
      Tests  4 failed | 1 passed (5)
```

Hermes الحقيقي محليًا (venv من الوسم نفسه لكل نسخة، `COREHUB_HERMES_BIN`)؛ الاختبار يكتب المرشّح
بكود الهاب ثم يشغّل `discover_mcp_tools` من Hermes (ما تشغّله جلسة الوكيل) على خادم stdio حقيقي:

```text
== Hermes v2026.9.24
 Test Files  1 passed (1)
      Tests  2 passed (2)
== Hermes v2026.9.14
 Test Files  1 passed (1)
      Tests  2 passed (2)
# وقبل كتابة الاختبار، يدويًا على v2026.9.24 مع tools.include: [echo]:
["mcp__fixture__echo"]      ← ما سجّله Hermes للوكيل
["echo", "add"]             ← ما يعرضه اختبار Hermes (بلا ترشيح)
```

ما شغّلته محليًا غير ذلك:

```text
$ vitest run --project unit mcp.test.ts mcp-last-test.test.ts mcp-last-test.routes.test.ts mcp-oauth.routes.test.ts agent-tools.routes.test.ts
 Test Files  5 passed (5)      Tests  54 passed (54)
$ pnpm --filter @corehub/web exec vitest run tests/mcp-tools.test.tsx tests/mcp-tool-filter.test.ts tests/mcp-oauth.test.tsx tests/hub-tools-card.test.tsx
 Test Files  4 passed (4)      Tests  22 passed (22)
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test --workers=1 zzzzzzzzzzzzzzz-mcp-tools.spec.ts zz-agent-tools.spec.ts zzzzzzzzzzzzzz-mcp-oauth.spec.ts
  ✓  1 … 23. the agent tools ask Hermes: an MCP test, a skill pack imported, WhatsApp linked by QR (8.7s)
  ✓  2 … MCP OAuth: a remote server is signed in from the web, tested, and disconnected (3.2s)
  ✓  3 … MCP OAuth: "Add server" by its address signs in, turns Connected and tests itself (1.1s)
  ✓  4 … MCP tools: listed without Test, tested once by itself, and filtered read-only (1.4s)
  4 passed (23.6s)
$ pnpm contract:test
 Test Files  20 passed (20)    Tests  428 passed (428)
$ pnpm contracts:lint     → Your API description is valid (التحذير الوحيد قديم في السطر 7656)
$ pnpm contracts:compat   → OK — no breaking change against v1.1.5
$ pnpm contracts:check-clients → OK — 1113 client file(s) scanned, 267 contract path(s) known.
$ pnpm i18n:check         → OK (web 3442، ios 2720، android 2579 مفتاحًا، ar/en متطابقة)
$ pnpm i18n:limits        → OK (0 too wide)
$ pnpm lint               → All matched files use Prettier code style!
$ tsc --noEmit (server, web) → بلا أخطاء
$ pnpm build              → exit 0
```

iOS وAndroid لا يُبنيان على هذا الجهاز (لا macOS ولا JDK): تحقق منهما CI.

CI على طلب الدمج #223 (الرأس `b267553f`، يضم هذا العمل وعمل «أرسل رسالة تجريبية»): كل الفحوص خضراء —
Lint/typecheck/contracts/build، الخادم (3 أجزاء)، Playwright، الترجمات، db:migrate، صورة Docker،
Electron، Android، iOS simulator، وتوليد عميل Swift. واختبار Hermes الحقيقي الجديد شُغّل على الصورتين:

```text
Real Hermes suites (floor)   ref=v2026.9.14
 ✓  unit  src/modules/agents/mcp-tool-filter.real.test.ts (2 tests) 7416ms
 Test Files  32 passed (32)
Real Hermes suites (pinned)  ref=v2026.9.24
 ✓  unit  src/modules/agents/mcp-tool-filter.real.test.ts (2 tests) 10136ms
 Test Files  32 passed (32)
```

## المخاطر والرجوع

- الملف `mcp-last-tests.json` ذاكرة فقط: إن فُقد أو فسد يُقرأ كأن لا اختبار، ويُكتب من جديد عند
  الاختبار التالي. الرجوع = إرجاع الفرع؛ الملف يُترك بلا ضرر.
- المرشّح يكتبه الهاب في `config.yaml` للبروفايل بمفاتيح Hermes نفسها؛ حذفه (تحديد الكل ثم حفظ)
  يرجع الخادم إلى كل الأدوات. الخوادم الحالية بلا مرشّح تبقى كما هي.
- التصنيف بالاسم تخمين: الخطأ نحو «تعديل» (أداة آمنة تُستبعد من «للقراءة فقط») هو الجانب الآمن،
  والشخص يرى التصنيف ويعدّل قبل الحفظ.
- الاختبار التلقائي عند أول فتح يرسل طلب اختبار واحدًا لكل خادم لم يُختبر في البروفايل.

## التسليم والخطوة التالية

- في طلب الدمج المجمّع #223 مع إصلاحات «أرسل رسالة تجريبية».
- متابعة: اختيار الأدوات على iOS وAndroid (المربعات و«الكل/لا شيء/للقراءة فقط» والحفظ)، والاختبار
  التلقائي عند أول فتح على الجوال.
- للمالك أن يؤكد §134 (مكان الحفظ، والتصنيف، وأن «تحديد الكل» يحفظ بلا مرشّح).
