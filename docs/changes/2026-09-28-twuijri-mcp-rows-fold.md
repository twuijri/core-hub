# صفحة MCP: الصف يُطوى ويُفتح، وزر «تحرير» مستقل

المسؤول: twuijri · الفرع: batch/2026-09-28c · الحالة: review

## المشكلة والهدف

في صفحة الوكيل ← Hermes ← MCP (الإصدار 1.1.5) الضغط على صف الخادم يفتح نافذة التحرير مباشرة،
وبطاقة «أدوات كور هب» طويلة جدًا (كل المجموعات وأدواتها ظاهرة دائمًا)، وأزرار «إعادة الربط عبر
OAuth» و«فصل» ظاهرة على الصف فيسهل ضغطها بالخطأ.

طلب المالك: الضغط على رأس الصف يفتح ما تحته ويطويه (العنوان/الأمر، حالة OAuth وأزراره، أدوات آخر
اختبار، الأخطاء)، و«تحرير» زر صريح بجانب «اختبار» بأيقونة قلم من Lucide، وبطاقة «أدوات كور هب»
تُطوى كذلك. يُحفظ المفتوح/المطوي لكل خادم على الجهاز، والافتراضي مطوي إلا الخادم الذي يحتاج
انتباهًا (خطأ / غير متصل / منتهي). إضافة المالك أثناء العمل: «إعادة الربط» و«فصل» داخل الجزء
المفتوح فقط، والصف المطوي يعرض: المفتاح، الاسم، شريحة النقل، شريحة الحالة، العنوان، اختبار،
تحرير، حذف؛ و«فصل» يبقى بتأكيد.

## القرار والموافقات

- الويب (`AgentMcpScreen.tsx`): رأس الصف زر `aria-expanded` / `aria-controls` فيه سهم (chevron)
  يشير باتجاه القراءة وهو مطوي (يمين في LTR، يسار في RTL) ولأسفل وهو مفتوح. المفتاح و«اختبار»
  و«تحرير» و«حذف» عناصر شقيقة للزر لا داخله، فلا تغيّر الطيّ. «اختبار» يفتح الصف ليظهر الناتج،
  وتسجيل دخول بدأ من «إضافة خادم» يفتح صفه.
- الجزء المطوي يبقى في الصفحة بخاصية `hidden` (لا يُزال): تسجيل الدخول الجاري يكمل متابعته ويشغّل
  الاختبار تلقائيًا عند نجاحه حتى لو طوى الشخص الصف، ولا يمكن الوصول لأزراره وهو مخفي.
- الافتراضي يُحسب مرة واحدة عند أول ظهور للصف ولا يُكتب: فلا ينطوي الصف فجأة لحظة نجاح تسجيل
  الدخول، والصف الذي لم يلمسه الشخص يتبع الافتراضي في الزيارة التالية. اختيار الشخص (ضغط الرأس
  أو «اختبار») يُحفظ في `localStorage` تحت `corehub.mcp-expanded` داخل try/catch، ويُنسى عند حذف
  الخادم. (`mcpExpanded.ts`)
- «يحتاج انتباهًا» = `server.error` موجود، أو OAuth منتهٍ / غير مقروء، أو غير متصل لخادم يشترطه.
- بطاقة «أدوات كور هب» (`HubToolsCard.tsx`): عنوانها زر طيّ داخل `h3`، والمفتاح بجانبه؛ تحت الطيّ:
  «يعمل باسم…»، المجموعات، الاختبار، آخر الاستدعاءات. مطوية افتراضيًا، ومفتوحة إن لم يستطع المركز
  تقديم أدواته. أخطاء القراءة/الحفظ تبقى ظاهرة خارج الطيّ.
- زر «تحرير» يستخدم `IconEdit` الموجود (Lucide `square-pen`، أيقونة التحرير المعتمدة في الويب)
  ونص `common.edit` («تحرير»). مقترح — للمالك أن يؤكد أو يطلب `pencil` / «تعديل».
- أندرويد: كان الضغط على البطاقة كلها يفتح المحرر؛ طُبّق النمط نفسه: الرأس (سهم، الاسم، النقل،
  الحالة، المفتاح) يطوي ويفتح مع `stateDescription` وإجراءي expand/collapse، و«تحرير» زر صريح
  بأيقونة `Pencil` بجانب «اختبار»، و«حذف» زر أيقونة (بدل قائمة «…»). مطوي: العنوان في سطر واحد
  وشارة OAuth فقط؛ مفتوح: عدد الأدوات، الخطأ، ناتج الاختبار، «ربط / إعادة ربط» وتقدّم تسجيل الدخول
  (المتابعة الدورية تستمر وهو مطوي). الحالة تُحفظ بـ `rememberSaveable` داخل الشاشة فقط.
- iOS: الضغط على الصف لا يفتح المحرر أصلًا (التحرير من قائمة «…» والسحب)، فلم يُغيَّر.
- لا تغيير كاسر: لا عقد، لا خادم، لا تخزين قديم يُحذف؛ مفتاح `localStorage` جديد فقط.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

لا شيء.

## الملفات والتأثير

- `packages/web/src/agents/AgentMcpScreen.tsx` — الصف القابل للطيّ، زر «تحرير»، الجزء المفتوح.
- `packages/web/src/agents/mcpExpanded.ts` (جديد) — حفظ المفتوح/المطوي على الجهاز.
- `packages/web/src/agents/HubToolsCard.tsx` — طيّ بطاقة «أدوات كور هب».
- `packages/web/src/styles/screens.css` — `.mcp-card*`، `.mcp-chevron` (مع RTL)، `.hub-tools-*`.
- `packages/web/src/i18n/{ar,en}.json` — `mcp.address`، `mcp.command`.
- `packages/web/tests/mcp-oauth.test.tsx`، `packages/web/tests/hub-tools-card.test.tsx` — 6 اختبارات جديدة.
- `packages/web/e2e/zz-agent-tools.spec.ts` — رحلة الطيّ/الفتح، لوحة المفاتيح، «تحرير»، الحفظ بعد إعادة التحميل، طيّ البطاقة.
- `apps/android/.../agent/AgentMcpPage.kt`، `McpOAuthRow.kt`، `apps/android/i18n/agents2.{ar,en}.json`،
  `apps/android/app/src/testDebug/.../AgentsTwoShots.kt`.
- `docs/STATUS.md` — سطر في صف agents.

## الفحوص (الأوامر ونواتجها الفعلية)

الاختبارات الجديدة فشلت على الكود القديم (الكود المصدري مخبّأ بـ `git stash`) ونجحت بعد التغيير:

```text
$ vitest run --maxWorkers=2 tests/mcp-oauth.test.tsx tests/hub-tools-card.test.tsx   # قبل التغيير
     × folds from its title: closed by default, opened by a press and kept on this device
     × starts open when the hub cannot offer its tools, so the reason is read
     × starts closed, but open where the person is needed (a sign-in never made)
     × opens and folds on a press of its header, never opens the editor, and remembers it
     × edits from its own Edit button
     × keeps Reconnect and Disconnect inside the folded part, and Test opens it
      Tests  6 failed | 7 passed (13)

$ vitest run --maxWorkers=2 tests/mcp-oauth.test.tsx tests/hub-tools-card.test.tsx   # بعد التغيير
 Test Files  2 passed (2)
      Tests  13 passed (13)

$ pnpm build   → exit 0
$ PLAYWRIGHT_CHANNEL=chrome playwright test --workers=1 e2e/zz-agent-tools.spec.ts e2e/zzzzzzzzzzzzzz-mcp-oauth.spec.ts
  ✓  1 [chromium] › e2e/zz-agent-tools.spec.ts:48:1 › 23. the agent tools ask Hermes: an MCP test, a skill pack imported, WhatsApp linked by QR (8.8s)
  ✓  2 [chromium] › e2e/zzzzzzzzzzzzzz-mcp-oauth.spec.ts:35:1 › MCP OAuth: a remote server is signed in from the web, tested, and disconnected (3.2s)
  ✓  3 [chromium] › e2e/zzzzzzzzzzzzzz-mcp-oauth.spec.ts:92:1 › MCP OAuth: "Add server" by its address signs in, turns Connected and tests itself (1.0s)
  3 passed (23.3s)

$ pnpm --filter @corehub/web typecheck   → exit 0
$ eslint packages/web/src/agents <test files> <e2e spec>   → exit 0
$ pnpm i18n:check
i18n:check  web: 3409 keys, ar/en in parity
i18n:check  android: 2566 keys, ar/en in parity
i18n:check  OK
$ pnpm i18n:limits
i18n:limits  ar: 56 measured labels, 0 too wide, 4 cut with an ellipsis as in English
i18n:limits  en: 56 measured labels, 0 too wide, 6 cut with an ellipsis as in English
i18n:limits  OK
```

لقطة Playwright (`agent-mcp-rows-folded-ar-light`) رُوجعت: السهم المطوي يشير يسارًا في العربية،
والمفتوح لأسفل، و«تحرير» بأيقونة القلم بجانب «اختبار».

أندرويد: لا يوجد JDK على هذا الجهاز، فلم يُبنَ محليًا؛ التحقق من `assembleDebug test lint`
واختبار اللقطة `AgentsTwoShots` (طيّ/فتح الرأس، زر التحرير لا يُستدعى بضغط الرأس) على GitHub CI.
نتيجة GitHub CI على PR #220 (الكومِت الأول) — كلها ناجحة:

```text
pass | Android build, unit tests, lint | 8m18s
pass | Lint, typecheck, contracts, client tests, build | 7m50s
pass | Web smoke journeys (Playwright against the real hub) | 13m26s
pass | Translations fit their labels (measured widths) | 33s
pass | Server unit tests (shard 1/3, 2/3, 3/3) | 5m2s, 5m59s, 3m10s
pass | Real Hermes suites (floor / pinned) | 6m25s / 7m22s
pass | Desktop app smoke (Electron under Xvfb against the real hub) | 1m24s
pass | Docker image builds and answers /health | 2m46s
pass | db:generate + db:migrate (SQLite and PostgreSQL) | 1m11s
pass | PR adds or updates a change record | 12s
```

## المخاطر والرجوع

- خطر منخفض: واجهة فقط، بلا عقد ولا خادم. من اعتاد الضغط على الصف للتحرير سيجد الصف يُفتح
  بدلًا من ذلك، و«تحرير» ظاهر بجانب «اختبار».
- مفتاح `localStorage` غير قابل للقراءة يُعامل كأنه فارغ؛ نافذة خاصة تبدأ بالافتراضي.
- الرجوع: التراجع عن الكومِت؛ المفتاح `corehub.mcp-expanded` يبقى في المتصفح بلا أثر.

## التسليم والخطوة التالية

- ضمن دفعة `batch/2026-09-28c` (PR واحد).
- متابعة مقترحة: حفظ حالة الطيّ على أندرويد عبر التشغيلات (الآن داخل الشاشة فقط)، وطيّ بطاقة
  «أدوات كور هب» على أندرويد وiOS، وزر «تحرير» صريح على iOS للتماثل (ليس مطلوبًا لأن الضغط هناك لا
  يفتح المحرر).
