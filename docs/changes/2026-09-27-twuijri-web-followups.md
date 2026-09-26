# متابعات الويب: مدخلات الذاكرة وحدّها، ما غيّره التشغيل الجاري، النافذة حسب الفئة، لون التصنيف، حدود سير العمل
المسؤول: twuijri · الفرع: feat/web-followups · الحالة: review

## المشكلة والهدف
دفعتا **B10** (متابعات الويب) و**B19** (الغرف وتغييرات التشغيل وتلميع سير العمل) من قائمة الفجوات
(`fork-gap-list.md`، البنود a6 وa7 وa10 وa12 وa13 وa16 وa17 وa25). كلها أشياء تركتها سجلات سابقة «لاحقًا»:

1. صفحة الذاكرة تعرض كل قائمة نصًّا واحدًا فيه أسطر `§`، ولا تقول كم بقي من حدّ هرمز (سجل memory-page-paths).
2. العضو الذي سُحب منه البروفايل المحفوظ في جهازه وبقي له غيره يرى صفحات «غير موجود» (سجل member-profiles-explicit).
3. شريط «بانتظارك» لا يعدّ كتابات الذاكرة والمهارات المعلّقة للمراجعة (سجل hermes-settings، §58).
4. تصنيف المحادثات بلا لون يُختار من الواجهة (سجل session-categories، §60).
5. عنصر الغرفة في ورقة «بانتظارك» بلا «افتحه في مكانه» (سجل global-agent، §46) — للغرف صفحة الآن.
6. عدّاد السياق لا يفصّل النافذة حسب الفئة، وهرمز يبلّغ عنها (`session.context_breakdown`، سجل slash-commands-compression).
7. بطاقة «غيّر N ملفات» تظهر بعد نهاية التشغيل فقط (سجل run-file-changes).
8. حدود سير العمل تُحرَّر من نافذة التشغيل لا من المحرّر، ولا حدّ لتشغيل واحد من زر «شغّل» (سجل schedule-extras).

تُرك «مرفقات رسائل الغرف» لأنه بُني الليلة (§99).

## ما رأيته في هرمز قبل الكتابة (ADR 0012)
قرأت مصدر هرمز (MIT) داخل صورة المشروع (`core-hub:morechannels`، هرمز `v0.21.3` = الوسم المثبّت `v2026.9.14`)،
ولم أنسخ منه شيئًا. بكلماتي:

- `tui_gateway` فيه الطريقة `session.context_breakdown` (المعاملات `session_id`). قبل أن يبني هرمز الوكيل (الجلسة
  «كسولة») يجيب بلا فئات والأعداد أصفار. بعد البناء يحسب بلا طلب إلى المزوّد ثماني فئات بالترتيب: `system_prompt`،
  `tool_definitions`، `rules`، `skills`، `mcp`، `subagent_definitions`، `memory`، `conversation`، لكل منها
  `id` و`label` (إنجليزي) و`color` (متغيّر CSS خاص بواجهته) و`tokens`، ويُسقط الفئة التي عددها صفر. ومعها
  `context_used` و`context_max` و`context_percent` و`context_estimated` و`context_source` و`estimated_total` و`model`.
  أعداد الفئات تقديرية (أحرف ÷ نسبة)، و`context_used` أفضل رقم عنده للنافذة كلها، فلا يلزم أن يتساوى المجموع.
- جرّبت ذلك مرة على الصورة (دوكر، حاوية مؤقتة حُذفت): `session.create` ثم `session.context_breakdown` أجاب
  `{"categories": [], "context_max": 0, "context_used": 0, "context_estimated": false, …}` — الشكل كما قرأته. لم أرَ
  فئات من دور حقيقي لأن ذلك يحتاج مزوّدًا بمفتاح.

## القرار والموافقات
المالك نائم؛ كل ما يلي **مقترح — للمالك أن يؤكد**، ومكتوب في DECISIONS **§102**.

- **الذاكرة مدخلات منفصلة مع حدّها.** `MemoryItem` يحمل `entries` و`char_limit` و`char_count` (اختيارية، `null`
  للشخصية). الصفحة ترسم كل مدخل سطرًا بزرّي «حرّر» و«أزل» (بتأكيد)، و«أضف مدخلًا» في الآخر، و«حرّر الكل» يبقى
  للنص كاملًا، وشريطًا رفيعًا «N من الحد حرفًا» يصفرّ من ٨٠٪ ويحمرّ فوق الحد مع «ممتلئة: لا يستطيع الوكيل أن يحتفظ
  بجديد». المدخل الذي يكبّر القائمة فوق حدّها يُمنع قبل الحفظ مع السبب (والتصغير مسموح دائمًا، كما في الهب). الحفظ
  يرسل القائمة كلها كما كان — لا عملية لكل مدخل، لأن ملف هرمز بلا معرّفات.
- **التشغيل الجاري:** `sessions.getRunChanges` على تشغيل لم ينتهِ يجيب المجلد الآن مقارنةً ببداية التشغيل مع
  `live: true` بدل `404`، لا يُحفظ، وتُشارك النظرة الواحدة ثانيتين. الويب يرسم البطاقة نفسها تحت الرد الحي بعلامة
  «حتى الآن»، ويعيد القراءة كل ٤ ثوانٍ ومع نهاية كل أداة، وصفوفها لا تفتح فرقًا حتى ينتهي التشغيل فتحلّ محلها البطاقة
  المسجّلة. مرفوض: حدث لحظي لكل تغيير، والفروق أثناء التشغيل.
- **النافذة حسب الفئة:** عملية جديدة `sessions.getContextBreakdown` (`GET /sessions/{id}/context`) تسأل المحادثة
  المفتوحة لدى الوكيل فقط، ولا تفتح واحدة لأجلها؛ وإلا `available: false`. الويب يطلبها فقط حين تُفتح تفاصيل العدّاد،
  ويرسم شريطًا واحدًا بألوان الرسوم (`chart-1…6`) وسطرًا لكل فئة باسمها العربي، واسم هرمز لأي فئة لا يعرفها،
  وملاحظة «كما يعدّها الوكيل تقريبًا».
- **لون التصنيف:** ثمانية ألوان ثابتة أو «بلا لون» من قائمة التصنيف، ونقطة قبل اسمه. مجموعة ثابتة لا منتقٍ حر، ليقرأ
  اللون نفسه في الفاتح والداكن؛ ويُخزَّن `#rrggbb` الذي في العقد أصلًا.
- **ورقة «بانتظارك»:** للمشرف، كتابات الذاكرة والمهارات المعلّقة في البروفايل الذي هو فيه، بزرّي «اعتمد» و«ارفض»
  نفسيهما، ورابط إلى إعدادات الوكيل؛ وسؤال الغرفة يفتح غرفته (`/rooms/<id>` مع `?profile=` إن كان في بروفايل آخر،
  وصفحة الغرفة صارت تحترمه) بشارة «غرفة».
- **العضو الذي فقد بروفايله المحفوظ** يُنقل إلى أول بروفايل مُنح له، كما يفعل «تحقق مرة أخرى».
- **حدود سير العمل** في اللوحة الجانبية للمحرّر حين لا خطوة محددة (سير عمل غير محفوظ: «احفظ سير العمل لتضبط
  حدوده»)، وبجانب «شغّل» زر بأيقونة المقياس «شغّل بحدود لهذا التشغيل» يفتح على حدود سير العمل ويرسل
  `WorkflowRunRequest.limits` لذلك التشغيل وحده.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عملية جديدة `sessions.getContextBreakdown` — `GET /sessions/{session_id}/context`، ومخططان جديدان
  `SessionContextBreakdown` و`SessionContextCategory`.
- `MemoryItem`: حقول اختيارية `entries`، `char_limit`، `char_count` (ومثال `agents.listMemory`).
- `RunChanges.live` اختياري، ووصف `sessions.getRunChanges` (تشغيل جارٍ يجيب ما غيّره حتى الآن).
- لا حدث جديد ولا ترحيل. DECISIONS §102، وCOVERAGE (صف المحادثة وصف شريط «بانتظارك»)، وSTATUS (348 من 348).

## الملفات والتأثير
الخادم (`packages/server`):
- `modules/agents/memory.ts` و`index.ts`: المدخلات والحد والعدّ في كل وثيقة قائمة.
- `modules/agents/adapters/hermes-tui.ts` و`types.ts`: `contextBreakdown()` و`contextBreakdownOf`؛ `runner.ts` و`ports.ts`:
  `contextBreakdown(sessionId)` من المحادثة المفتوحة فقط.
- `modules/sessions/engine.ts` (`liveChanges`)، `service.ts` (`runChanges` صار غير متزامن، `contextBreakdown`)، `routes.ts`،
  `mappers.ts` (`toLiveRunChanges`)، `ports.ts`، `testing/fake-runner.ts` (خيار `contextBreakdown`).
- اختبارات: `memory.routes.test.ts`، `changes-api.test.ts` (التشغيل الجاري)، `context-breakdown.test.ts` (جديد)،
  `hermes-tui-commands.test.ts`.

الويب (`packages/web`):
- `agents/AgentMemoryScreen.tsx`، `agents/memoryEntries.ts` (جديد)، `agents/skills.ts`.
- `pending/pending.ts`، `pending/queries.ts`، `shell/PendingActions.tsx`، `agents/PendingWritesCard.tsx` (تصدير الخطافين).
- `rooms/RoomsScreen.tsx` (`?profile=`)، `shell/ProfileGate.tsx`.
- `sessions/CategoryColour.tsx` (جديد)، `sessions/SessionList.tsx`، `sessions/categories.ts`.
- `chat/ContextRing.tsx`، `chat/contextBreakdown.ts` (جديد)، `chat/ChatScreen.tsx`.
- `files/RunChangesCard.tsx` (`LiveRunChanges`)، `files/queries.ts`، `chat/MessageView.tsx`.
- `schedules/WorkflowLimits.tsx` (`RunLimitsDialog`، الحقول مشتركة)، `schedules/workflows/WorkflowEditor.tsx`،
  `StepPanel.tsx`، `queries.ts`.
- `ui/icons.tsx` (`IconEdit`، `IconPalette`، `IconGauge` من Lucide الموجودة)، `styles/screens.css`، `styles/chat.css`،
  `i18n/ar.json` و`en.json`.
- اختبارات: `memory-entries.test.tsx` (جديد)، `pending-actions.test.tsx`، `profile-gate.test.tsx`، `context-meter.test.tsx`،
  `run-changes.test.tsx`، `session-categories.test.tsx`، `workflow-editor.test.tsx`.
- رحلات Playwright: `zzzzzzzzzzzz-memory-entries.spec.ts` (جديدة)، وإضافات في `zzzzzz-run-changes`،
  `zzzzzz-slash-compress`، `zzzzzzz-session-categories`، `zzzzzz-workflow-editor`، و`smoke.spec.ts` (يعدّ الوثائق
  بمعرّفها لأن مدخلات القائمة صارت عناصر قائمة أيضًا)؛ `e2e/hub.ts` (سيناريو «اكتب ببطء» وتفصيل النافذة).
- لقطات: جديدة `33-run-changes-live`، `context-breakdown-ar-light`، `agent-memory-entries-ar-light`،
  `workflow-limits-ar-light`، `workflow-run-limits-ar-light`؛ ومحدّثة للشاشات التي تغيّرت فقط: `agent-memory-ar-light`،
  `agent-nav-memory-ar-light`، `agent-nav-mobile-ar-light`، `agent-nav-mobile-drawer-ar-light`،
  `session-categories-ar-light`، `workflow-editor-ar-light`، `workflow-run-ar-light` (وأُعيد كل ما سواها كما كان).
- `docs/contracts/DECISIONS.md` (§102)، `docs/contracts/COVERAGE.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، عبر `mj-run`، ما مسّه التغيير فقط (القواعد):

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
exit 0
$ pnpm contracts:lint
  7226:21  warning  no-invalid-media-type-examples  Example value must conform to the schema: `0` property must have required property 'program'.
openapi.yaml: validated in 840ms
Woohoo! Your API description is valid. 🎉
You have 1 warning.
contracts:lint  validating 96 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 738 client file(s) scanned, 251 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 39 destinations, 2 pre-auth screens (login, setup), 44 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  401 passed (401)
$ vitest run (server) memory.routes memory changes-api context-breakdown hermes-tui-commands run-changes sessions-compress status
 Test Files  8 passed (8)
      Tests  62 passed (62)
$ vitest run (web) 18 files: pending-actions profile-gate context-meter run-changes session-categories workflow-editor memory-entries schedule-extras schedule-runs schedule-run-options hermes-settings i18n lucide-icons logical-css theme-colors message-layout tool-calls agents-top-level
 Test Files  18 passed (18)
      Tests  604 passed (604)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome playwright test setup smoke zzz-agents-top-level zzzzzz-run-changes zzzzzz-slash-compress zzzzzz-workflow-editor zzzzzzz-session-categories zzzzzzzzzzzz-memory-entries
  30 passed (2.0m)
```

التحذير الوحيد في `contracts:lint` قائم قبل هذا الطلب (مثال برامج الجهاز، §89)، لا من تغييراتي.
الاختبارات الجديدة تفشل على الكود القديم: `404` للتشغيل الجاري، وغياب `entries`/`char_limit`، والمسار
`/sessions/{id}/context` غير موجود، و`pendingHref` لغرفة كان `null`، ولا نقل للبروفايل المفقود، ولا زر لون ولا لوحة
حدود.

فحص هرمز مرة على الصورة (دوكر، حاوية `--rm` حُذفت): `session.context_breakdown` على جلسة لم تُبنَ أجاب
`{"categories": [], "context_max": 0, "context_percent": 0, "context_used": 0, "estimated_total": 0, "context_estimated": false, "context_source": "provider_usage", "model": ""}`.

CI: النتيجة على طلب الليلة #165 في «التسليم».

## المخاطر والرجوع
- **النظرة الحية** تكتب كائنات git للملفات غير المتتبَّعة (حتى ٢ م.ب) في كل مقارنة، كما تفعل نهاية التشغيل؛ مقيّدة
  بنظرة كل ثانيتين لكل تشغيل مهما كثر المشاهدون، ولا تُطلب إلا والبطاقة على الشاشة.
- **تفصيل النافذة** لا يظهر بعد إعادة تشغيل الهب حتى أول دور (لا محادثة مفتوحة)، وهذا مقصود؛ ولم يُرَ من دور هرمز
  حقيقي بعد.
- **الكتابات المعلّقة** تُسأل كل ١٥ ثانية للمشرف ما دام التطبيق مفتوحًا (قراءة ملفات محلية)، ولوكيل هرمز فقط.
- الرجوع: استرجاع دمج `feat/web-followups` من فرع الليلة؛ الحقول الجديدة في العقد اختيارية، فلا عميل آخر ينكسر.

## التسليم والخطوة التالية
- لا طلب دمج خاص: دُمج في `night/2026-09-27` (#165) عند `2b5732bd`. CI على #165 لهذا الالتزام: ١٨ نجاحًا
  وتخطٍّ واحد (رفع قائمة App Store، لا يعمل إلا بمفتاح)، منها اختبارات الخادم الثلاث، وفحص العقد والعملاء والبناء،
  ورحلات Playwright كاملة (8m6s)، وصورة دوكر، وأندرويد وiOS، وسطح المكتب والمثبّتات.
- للمالك: تأكيد §102 (خصوصًا: الألوان الثمانية الثابتة، و«حتى الآن» بلا فروق، وعدم فتح محادثة لأجل التفصيل).
- لاحقًا إن أراد المالك: فروق التشغيل الجاري، ولون التصنيف في تطبيقي الجوال، وتفصيل النافذة لوكلاء غير هرمز إن
  أبلغوا عنه.
