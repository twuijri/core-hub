# «الوكلاء» مدخل رئيسي فوق «المهام»، وصفحات الوكيل بقائمته الجانبية
المسؤول: twuijri · الفرع: feat/agents-top-level · الحالة: review

## المشكلة والهدف
قال المالك (2026-09-24): «قراري اننا ندخل الايجنتات داخل الاعدادات كان خطا بالتصميم — تطلع فوق
Tasks في الصفحة الرئيسية». خيارات الوكيل (الذاكرة، القنوات…) تُفتح من الأزرار الصغيرة على بطاقته،
فتفتح الصفحة «كاني دخلت بمسار سريع لاعدادات الايجنت»، وداخلها الخيارات قائمة جانبية بصفّ رجوع مثل
الإعدادات، والرجوع يعيد إلى صفحة الوكلاء في المنطقة الرئيسية.

قبل التغيير: «مدير الوكلاء» صفّ في الإعدادات ← الإدارة (`/settings/agents`)، وصفحات الوكيل تحت
`/settings/agents/:agentId/…` تعرض **قائمة الإعدادات** في الجانب، فالتنقّل بين ذاكرة الوكيل وMCP
يمرّ بالبطاقات كل مرة. ومنذ #80 صارت المهارات وMCP والذاكرة والقنوات لكل بروفايل، فهي عمل متكرر
لا ضبط يُنسى.

## القرار والموافقات
موافقة المالك على النقاط الخمس في المحادثة (2026-09-24). التنفيذ مستقل بتوجيه المنسّق، بلا أسئلة.

1. **«الوكلاء» / "Agents" مدخل في الشريط الأساسي فوق «المهام» مباشرة**، مساره `/agents`، وخرج من
   الإعدادات ← الإدارة. المفتاح `agent_manager` باقٍ، ونصّه وعنوان الشاشة صارا «الوكلاء» معًا
   (المدخل = العنوان).
2. **البطاقة**: الشرائح الصغيرة (المهارات، MCP، الذاكرة، المهام المجدولة، القنوات، الإضافات — ما
   أعلنه المحوّل) وزرّ «الإعدادات» تفتح صفحة الوكيل مباشرة. الشرائح صارت تبدو قابلة للضغط (إطار،
   لون التمييز، سهم نحو الصفحة) واسمها المقروء «الذاكرة · Hermes». وسوم القدرات في الأعلى معلومات
   لا تُضغط (`agent-capabilities`). إعادة التشغيل والتثبيت والإزالة باقية.
3. **داخل صفحة الوكيل** (`/agents/:agentId/<section>`) تصير القائمة الجانبية قائمةَ الوكيل:
   «رجوع إلى الوكلاء»، ثم اسم الوكيل وعلامته، ثم صفحاته بترتيب `agentLevel`، فقط ما أعلن المحوّل
   قدرته، والحالية مميّزة (`aria-current`). الشريط والمقاطع يغيبان كما في الإعدادات.
   **الإعدادات** آخرًا لكل وكيل مثبَّت، بالقاعدة نفسها التي تُظهر زرّ الإعدادات على البطاقة
   (`configurable` في `agents/sections.ts`): `settings` ليست قدرة في العقد (`AgentCapability`)، وواصف
   الإعدادات موجود لكل محوّل (ADR 0002). فClaude Code يعرض المهارات وMCP والإعدادات فقط.
   على الهاتف: الدرج يحمل قائمة الوكيل، والصفحة نفسها تعرض «رجوع إلى الوكلاء» في أعلاها.
4. **شريحة البروفايل في الأعلى باقية** في صفحات الوكيل. تحقّقت: شاشة الإعدادات لا تُخفي شيئًا من
   الشريط العلوي (ما تُخفيه هو الشريط الأساسي في القائمة الجانبية)، والشريط العلوي يرسم
   `WorkspaceSwitcher` في كل شاشة؛ اختبار الوحدة والرحلة ٢٧ يثبتان ظهوره في صفحة الوكيل.
5. **للمالك والمشرف فقط**: العضو لا يرى المدخل. **ولم يكن في الويب أي حارس مسار** لصفحات المشرف
   (عضو يكتب `/settings/users` كان يرى الصفحة ورفض الخادم)، فأضفت `RequireRole` في الموجّه لكل وجهة
   بحسب `roles` في الملف: العضو يُعاد إلى الرئيسية من `/agents…` ومن كل صفحة للمشرف بالقاعدة نفسها.
   وأُخفيت عن العضو الروابط إلى صفحة الوكلاء من أماكن أخرى (زرّ «+» في شرائح الوكلاء، تنبيه المحادثة
   الجديدة، أسماء الوكلاء في صفحة النماذج) حتى لا تقود إلى إعادة توجيه صامتة.
- **المسارات القديمة**: `legacyRoutes.web` في `navigation.json` (`/settings/agents` ← `/agents`)،
  والويب يحوّل البادئة مع بقية المسار والاستعلام. `nav:check` يتحقق أن البادئة القديمة لا يبدأ بها
  مسار حيّ وأن الجديدة مكان مسارات حيّة.
- `navigation.json`: `agent_manager` صار `level: app` و`entry: rail`، `rail` خمسة مداخل،
  `settingsManagement` ثلاثة، مسارات `agentLevel` تحت `/agents/:agentId/…`، مصطلح جديد
  `back_to_agents`، وقسم `agentShell` يصف قائمة الوكيل لكل العملاء.
- `NAVIGATION.md`: القاعدتان ١ و٣، جدول المصطلحات، §١ (الشريط)، §٢ (الإدارة)، و§٤ أُعيدت كتابته
  بقرار المالك ونصّه وتاريخه وسبب نقض موضع 2026-09-22، قاعدةً لكل عميل (سطح المكتب والهواتف أيضًا).
- `DECISIONS.md` §33: العقد لا يتحرك مع القائمة (§30 و§31 و§32 محجوزة؛ §32 دمجها #84).
- صفحات الوكيل المؤقتة (المهام المجدولة، الإضافات) باقية بصفحتها الصريحة داخل الإطار الجديد، بلا
  مسار تنقّل مكرّر (الـBreadcrumb يُخفى حيث توجد قائمة جانبية).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء في `packages/contracts`. سُجّل في `docs/contracts/DECISIONS.md` §33 ما لا يتغيّر: صفحة الوكيل
هي العملية نفسها بـ`agent_id`، والصفحات من `capabilities`، والنطاق `X-Hub-Profile`، و`x-roles` كما هي.

## الملفات والتأثير
- العقد الملاحي: `docs/clients/navigation.json`، `docs/clients/NAVIGATION.md`،
  `scripts/navigation-check.mjs` (تحقق `agentShell` و`legacyRoutes`)، `docs/contracts/DECISIONS.md` §33.
- الويب:
  - `src/navigation/manifest.ts`: `canOpen`، `agentRoute`، `agentPageFromPath`، `legacyRedirect`.
  - `src/app.tsx`: `RequireRole` لكل مسار، و`LegacyRedirect` لبادئات `legacyRoutes`.
  - `src/agents/sections.ts` (جديد): `configurable` و`agentSections` — جواب واحد للبطاقة والقائمة.
  - `src/agents/AgentNav.tsx` (جديد): صفّ الرجوع وقائمة الوكيل.
  - `src/shell/Sidebar.tsx`: `Agents` في الشريط بأيقونته، وقائمة الوكيل داخل صفحاته.
  - `src/shell/AppShell.tsx`: رجوع الهاتف أعلى صفحة الوكيل.
  - `src/agents/AgentManagerScreen.tsx`، `src/styles/screens.css`: الشرائح روابط تبدو كذلك.
  - `src/settings/SettingsNav.tsx`، `src/screens/PlaceholderScreen.tsx`، `src/navigation/routes.tsx`.
  - `src/chat/AgentChips.tsx`، `src/screens/NewChatScreen.tsx`، `src/models/ModelsScreen.tsx`: لا رابط
    للعضو.
  - `src/i18n/{ar,en}.json`: «الوكلاء» / "Agents"، «رجوع إلى الوكلاء» / "Back to agents"،
    `agents.sections`، `agents.open_section`، `agents.not_found`، وجملة `new_chat.no_agents`.
- الاختبارات: `tests/navigation.parity.test.tsx` (الشريط، الأدوار، المسارات، التحويل)،
  `tests/agents-top-level.test.tsx` (جديد: التطبيق كاملًا على مركز مُبرمج)، الرحلة الجديدة
  `e2e/zzz-agents-top-level.spec.ts` (٢٧ و٢٧ب)، وتحديث الرحلات ١ و١٥ و٢٣ وجولة التصميم التي كانت
  تمرّ بالإعدادات ← مدير الوكلاء.
- اللقطات (عربي فاتح): جديدة `agents-page`، `agent-nav-memory`، `agent-nav-mcp`، `agent-nav-mobile`،
  `agent-nav-mobile-drawer`؛ ومحدَّثة `design-agents`، `design-settings`، `settings-management`،
  `sidebar`، `agent-{skills,mcp,memory,channels}`. أُعيدت بقية اللقطات التي تغيّرت بلا صلة.

## الفحوص (الأوامر ونواتجها الفعلية)
بعد دمج `origin/main` (4123ff3، فيه #83 و#84 و#85)، كلٌّ عبر `mj-run` واحدًا واحدًا:
```
pnpm lint                      → eslint . && prettier --check .  All matched files use Prettier code style!  (exit 0)
pnpm typecheck                 → exit 0
pnpm contracts:check-clients   → check-clients  OK — 242 client file(s) scanned, 167 contract path(s) known.
pnpm i18n:check                → web: 971 keys, ar/en in parity · OK
pnpm nav:check                 → nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
pnpm --filter @majlis/web test → Test Files  43 passed (43) · Tests  540 passed (540)
pnpm build                     → exit 0
npx playwright test --workers=1 → 37 passed (2.6m)
  ✓ smoke 15. an agent’s skills are the files in its folder
  ✓ zz-agent-tools 23. the agent tools ask Hermes …
  ✓ zz-design the rebuilt screens › agents, models, sessions, settings …
  ✓ zzz-agents-top-level 27. Agents above Tasks: a card chip opens the agent with its own side list, and back
  ✓ zzz-agents-top-level 27b. a member sees no Agents entry, and the Agents pages send them home
```
وتحقق `nav:check` يسقط فعلًا: بملف معدَّل (`agentShell.back: "nope"`، و`/settings` بادئة قديمة إلى
`/nowhere`) أعطى ثلاثة أخطاء و`FAILED with 3 problem(s)`، ثم أُعيد الملف.

## المخاطر والرجوع
- **حارس الأدوار صار لكل وجهة للمشرف**، لا للوكلاء وحدهم: عضو يكتب `/settings/users` أو
  `/settings/webhooks` يُعاد الآن إلى الرئيسية بدل صفحة يرفض الخادم بياناتها. الخادم ما زال الحَكَم.
- الروابط المحفوظة إلى `/settings/agents…` تعمل بالتحويل؛ لو أُزيل `legacyRoutes` لاحقًا تنكسر.
- لقطات الشاشة الأخرى التي تُظهر الشريط (خمسة مداخل الآن) لم تُحدَّث عمدًا؛ ستتحدّث مع أي تشغيل لاحق.
- الرجوع: revert هذا الـPR يعيد الموضع السابق كاملًا (الملف والويب والوثائق معًا).

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية؛ الدمج للمالك. سطح المكتب والهواتف يطبّقون §٤ الجديد حين يُبنون (القاعدة
مكتوبة لكل العملاء في `NAVIGATION.md` و`agentShell`/`legacyRoutes` في الملف). صفحتا «المهام المجدولة»
و«الإضافات» للوكيل مهمة أخرى.
