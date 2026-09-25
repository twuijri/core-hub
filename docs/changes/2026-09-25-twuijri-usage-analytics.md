# صفحة «الاستخدام» كاملة و«استخدام المهارات»
المسؤول: twuijri · الفرع: feat/usage-analytics · الحالة: review

## المشكلة والهدف
صفحة «الاستخدام» كانت شارات قليلة وجدولًا بالنموذج فوق `audit.getReport` بكتلة `data` مفتوحة
ونافذة متحركة؛ و«استخدام المهارات» تجيب `501` لأن لا شيء يسجّل استخدام المهارات (`STATUS.md`، صف
`audit`). الهدف (طلب المالك عبر وصف مراقِب بكلمات عادية):
- **الاستخدام**: اختيار المدة (٧/٣٠/٩٠/٣٦٥ يومًا)؛ بطاقات: مجموع الرموز مع فصل المُدخل والمُخرج،
  القراءة والكتابة في الذاكرة المؤقتة حيث تُعرف، نسبة الإصابة، الكلفة التقديرية، المحادثات ومتوسطها
  اليومي؛ رسم يومي مكدّس (مُدخل/مُخرج/ذاكرة مؤقتة) وجدول يومي تحته؛ أشرطة حسب النموذج وحسب الوكيل مع
  الحصة؛ تصفية بالبروفايل (الكل أو واحد) وبالوكيل؛ مفتاح «إظهار الكلفة»؛ وما لا يُبلَّغ عنه يُقال
  (لا أصفار) — ومنه الوكلاء البرمجيون عبر ACP.
- **استخدام المهارات**: بدء **تسجيل** استخدام المهارات (صف لكل استخدام: المهارة، البروفايل، الوكيل،
  المحادثة، الوقت)؛ رسم يومي لأعلى ست مهارات؛ أربع بطاقات (مجموع الاستخدامات، المهارات المستخدَمة،
  الأكثر استخدامًا، ما لم يُستخدم في المدة)؛ جدول بالعدد والحصة وآخر استخدام؛ نفس التصفيات؛ وجملة
  «بدأ العدّ في <تاريخ>» لأن الماضي لا يُعاد بناؤه.

## القرار والموافقات
العقد: DECISIONS §47 (آخر رقم في `main` وقت الكتابة §46). الترحيل `0016` (آخر رقم في `main` كان
`0015`). لا ADR جديد: القرار في حدود ADR 0012 (رُصد Hermes من مصدره MIT) و ADR 0016 (قوائم كل
البروفايلات).

**كيف يُعرف استخدام المهارة** — قُرئ من مصدر Hermes (MIT، الوسم `v2026.9.14`، مستنسَخ في مجلد مؤقت،
لم يُفتح أي مصدر من Studio):
- `tools/skills_tool.py`: الأداة `skill_view(name, file_path?)` هي طريقة النموذج لتحميل مهارة، و Hermes
  نفسه يعدّ نجاحها «استخدامًا» (`_skill_view_with_bump` ← `tools/skill_usage.py` `bump_use`).
  `skill_manage` تعديل لا استخدام.
- `tui_gateway/tool_progress.py`: بوابة TUI ترسل `tool.start` بـ `name` و`args` كاملة (وضع التقدّم
  الافتراضي `all`)، و`tool.complete` بـ `args` والنتيجة.
- استدعاء المهارة بشرطة مائلة (`/skill`) لا يمر عبر `prompt.submit` الذي يستعمله المركز، فلا يخصّنا.
- ACP (`acp.ts`): استدعاء الأداة يصل بعنوان ونوع فقط بلا وسائط، فلا يُعرف اسم المهارة ⇐ **لا يُحسب
  استخدام الوكلاء البرمجيين للمهارات**، ويقال ذلك في الصفحة.

قرارات منتج جديدة — **مقترحة، والمالك يؤكد**:
- **الاستخدام الواحد = مهارة حمّلها دور**: صف واحد لكل (دور، مهارة). فتح ملف مرفق بالمهارة نفسها
  (`file_path`) أو تحميلها مرة ثانية في الدور نفسه ليس استخدامًا جديدًا؛ استدعاء فاشل ليس استخدامًا.
- **اليوم يوم تقويم الشخص**: يرسل العميل فرق توقيته عن UTC (`utc_offset_minutes`)؛ `days=7` يعني اليوم
  والأيام الستة قبله. فرق ثابت لا اسم منطقة زمنية (SQLite لا يحوّل المناطق)، فمدة تعبر تغيير التوقيت
  الصيفي قد تنحرف ساعة.
- **«غير مُبلَّغ» لا صفر**: الدفتر يخزّن الذاكرة المؤقتة غير المبلَّغ عنها صفرًا، فمدة كاملة بلا قراءة
  منها تُعرض «غير مُبلَّغ» (Hermes لا يبلّغ عنها اليوم). الكلفة بلا سعر معروف «غير مُبلَّغ» لا $0.
- **المجموع** = مُدخل + مُخرج + قراءة وكتابة الذاكرة المؤقتة؛ **نسبة الإصابة** = القراءة ÷ (المُدخل
  الطازج + القراءة)، لأن رموز المُدخل لا تشمل المخزَّن (§43). **المحادثات يوميًا** = متوسط عدد المحادثات
  النشطة في كل يوم من أيام المدة.
- **الافتراضي «كل البروفايلات»** كما في قائمة المحادثات (ADR 0016)؛ مُختار البروفايل يظهر فقط لمن له
  أكثر من بروفايل. **الجدول اليومي** يسرد الأيام التي فيها نشاط، الأحدث أولًا (سنة كاملة من الصفوف
  الفارغة لا تفيد)، ويقول ذلك تحته.
- **«إظهار الكلفة»** هو تفضيل `show_cost` الموجود نفسه الذي تتبعه المحادثة — لا تفضيل جديد.
- **«لم تُستخدم»** = المهارات المفعّلة في Hermes الذي يديره المركز داخل البروفايلات المشمولة، ولم
  يحمّلها أي دور في المدة؛ «غير معروف» حين لا يرى المركز مهاراته (Hermes خارجي).
- **الرسوم بلا مكتبة**: صناديق flex (لا SVG) تتبع اتجاه الصفحة بنفسها — في العربية أقدم يوم يمينًا
  واليوم يسارًا، كما في «المسار». ألوان `chart-1…6` جديدة في الرموز من لوحة فُحصت آليًا لعمى الألوان
  في السمتين (أداة التحقق من مهارة dataviz: CVD ΔE ≥ 8.4، الرؤية الطبيعية ≥ 19.3)؛ ثلاث خانات في
  السمة الفاتحة تحت 3:1 على السطح، لذلك لكل رسم مفتاح ألوان وقراءة لليوم تحت المؤشر/لوحة المفاتيح
  وجدول بجانبه.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عمليتان جديدتان: `audit.getUsage` — `GET /audit/usage` ⇐ `UsageReport`؛ و `audit.getSkillUsage` —
  `GET /audit/skills` ⇐ `SkillUsageReport`. معاملات مشتركة: `days` (1–365)، `profiles=all`،
  `agent_id`، `utc_offset_minutes` (−720…840).
- مخططات جديدة: `ReportPeriod`، `ActiveAgent`، `UsageReport`، `UsageDay`، `UsageModelShare`،
  `UsageAgentShare`، `SkillUsageReport`؛ ومعاملات `ReportDays`، `ReportProfiles`، `ReportAgent`،
  `UtcOffset`.
- `audit.getReport`: `skills` صار يجيب (نفس جسم `getSkillUsage` في `data` لبروفايل الترويسة) بدل
  `501`؛ ووصف وسم `audit` لم يعد «Phase 4 stub».
- لا حدث لحظي جديد. DECISIONS §47، و`COVERAGE.md` (الصفّان ١٢ و١٤).

## الملفات والتأثير
الخادم (`packages/server`):
- `modules/audit/schema.ts` + `drizzle/0016_usage_analytics.sql`: جدول `skill_uses` (فهارس
  `(workspace, used_at)` و`(workspace, agent_id, used_at)` وفريد `(run_id, skill)`)، وجدول
  `audit_counters` يكتب فيه الترحيل لحظة بدء العدّ على هذا التثبيت؛ وفهرس `runs (workspace, created_at)`.
- `modules/audit/analytics.ts` (جديد): `UsageAnalytics` — تجميع SQL حسب يوم التقويم على فهارس الزمن
  (مجموعة لكل وكيل/نموذج/يوم، لا صفوف خام)، وقاعدة «رقم فقط لما قيس».
- `modules/audit/service.ts`: `recordSkillUse` (يتجاهل التكرار في الدور نفسه).
- `modules/audit/index.ts`: المساران الجديدان، `profiles=all` بقاعدة `auth` (`listWorkspacesFor`)،
  `skills` في `getReport`، و`registerAnalyticsSources` (منفذ يربطه جذر التركيب).
- `modules/sessions/skill-use.ts` (جديد) + `engine.ts`: عند اكتمال استدعاء `skill_view` يُسجَّل
  الاستخدام (وفشل التسجيل لا يُفشل الدور). `modules/sessions/activity.ts` (جديد): الأدوار حسب
  وكيل/محادثة/يوم من جدول `runs` — يُعار لـ `audit` ولا يقرأ `audit` جداول `sessions`.
- `modules/agents/index.ts`: `installedSkillNames` (المهارات المفعّلة في بيت البروفايل).
- `modules/index.ts`: ربط المنافذ الثلاثة.

الويب (`packages/web`):
- `settings/usage/{report.ts,ReportFilters.tsx,UsagePage.tsx,SkillsUsagePage.tsx}` (جديدة).
- `ui/Chart.tsx` (جديد: `StackedBarChart` و`ShareBars`) + `ui/index.ts` + `styles/kit.css`.
- `settings/SettingsScreen.tsx` (الصفحتان)، `settings/AuditReport.tsx` (بقي للسجلات والأداء).
- `i18n/{ar,en}.json`: `nav.skills_usage` وقسما `usage.*` و`skills_usage.*`.
- `e2e/hub.ts` (سيناريو «حمّل المهارة»)، `e2e/zzzzzz-usage-analytics.spec.ts` (الرحلة ٣٢)،
  `e2e/zz-design.spec.ts` (أدوات الإعدادات صارت ٨)، ولقطات: `usage-ar-light`، `skills-usage-ar-light`،
  و`design-usage-ar-light`، `design-settings-ar-light` (تغيّرتا بالصفحة الجديدة؛ أُرجعت بقية اللقطات).

الرموز: `packages/ui-tokens/tokens.json` — `chart-1…6` في السمتين، وأزواج تباين لـ `chart-1/2/6`.

التنقّل والوثائق: `docs/clients/navigation.json` (وجهة `skills_usage` بين `usage` و`performance`،
`/settings/skills-usage`)، `docs/clients/NAVIGATION.md`، `docs/contracts/DECISIONS.md` §47،
`docs/contracts/COVERAGE.md`، `docs/STATUS.md` (208 من 266، وصف `audit` 3 من 3).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا ما يمسّه التغيير فقط (قاعدة السرعة)؛ الحزم الكاملة يشغّلها CI:
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
exit=0
$ pnpm contracts:lint
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 288 client file(s) scanned, 178 contract path(s) known.
$ pnpm --filter @corehub/contracts test
 Test Files  4 passed (4)
      Tests  19 passed (19)
$ pnpm contract:test
 Test Files  5 passed (5)
      Tests  282 passed (282)
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 35 destinations, 2 pre-auth screens (login, setup), 40 terms, ar/en complete, routes for web
$ pnpm --filter @corehub/ui-tokens test
 Test Files  1 passed (1)
      Tests  133 passed (133)
$ (server) vitest run --project unit src/modules/audit/ src/modules/sessions/skill-use.test.ts \
    src/modules/agents/adapters/hermes-tui.test.ts tests/unit/status.test.ts
 Test Files  6 passed (6)
      Tests  55 passed (55)
$ (web) vitest run tests/usage-reports.test.tsx tests/ui-layer.test.ts tests/logical-css.test.ts \
    tests/navigation.parity.test.tsx tests/settings-pages.test.tsx tests/i18n.test.ts
 Test Files  6 passed (6)
      Tests  221 passed (221)
$ pnpm build            # ✓ built in 849ms
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test \
    e2e/zz-design.spec.ts e2e/zzzzzz-usage-analytics.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zz-design.spec.ts:66:3 › the chat surface, designed › a multi-turn conversation reads as a conversation, in both languages and both themes (2.5s)
  ✓  2 [chromium] › e2e/zz-design.spec.ts:151:3 › the chat surface, designed › a live run is visibly alive: the word, the seconds counting up, and the step (8.2s)
  ✓  3 [chromium] › e2e/zz-design.spec.ts:217:3 › the rebuilt screens › agents, models, sessions, settings and the sign-in door are made of the kit (2.5s)
  ✓  4 [chromium] › e2e/zzzzzz-usage-analytics.spec.ts:27:1 › 32. Usage draws the period chosen, and Skills usage names the skill a run loaded (1.3s)
  4 passed (20.7s)
```
الاختبارات الجديدة تفشل على الكود القديم: `analytics.test.ts` و`skill-use.test.ts` و
`audit.contract.test.ts` و`usage-reports.test.tsx` تستورد أو تطلب ما لم يكن موجودًا؛ اختبار
`audit.test.ts` كان يتوقع `501` لـ `skills`؛ `status.test.ts` يفرض 266 عملية؛ والرحلة ٣٢ تفتح
`/settings/skills-usage` التي لم تكن.

`pnpm change-record:check` ⇐ `change-record  OK — 1 record(s) valid` (بعد إيداع السجل).

**CI على #108** (التشغيل 36081313582 على الالتزام `8d79507`؛ `main` لم يتحرك منذ تفرّع الفرع):
```
Lint, typecheck, contracts, tests, build                pass  13m57s
Web smoke journeys (Playwright against the real hub)    pass  4m26s
db:generate + db:migrate (SQLite and PostgreSQL)        pass  1m4s
Docker image builds and answers /health                 pass  2m59s
PR adds or updates a change record                      pass  10s
PR leaves graphify-out/ to the code-map bot             pass  8s
```

## المخاطر والرجوع
- **لم يُجرَّب على Hermes حقيقي** (لم يُحجز Docker لهذه المهمة): الالتقاط مثبت أمام بوابة TUI مكتوبة
  بإطارات Hermes كما قُرئت في مصدره، وأمام المشغّل المكتوب. إن أُطفئ وضع تقدّم الأدوات في Hermes
  (`tool_progress_mode=off`) لا يصل `tool.start` بوسائطه فلا يُحسب الاستخدام — والمركز لا يطفئه.
- **أرقام الاستخدام السابقة**: التجميع صار حسب يوم التقويم لا نافذة «الآن ناقص N×24 ساعة»، وقد يختلف
  مجموع المدة قليلًا عن `getReport` `usage` القديم (الباقي كما هو للعملاء الآخرين).
- **«غير مُبلَّغ» تقريبي**: مزوّد أبلغ فعلًا عن صفر قراءات طوال المدة يظهر «غير مُبلَّغ» — الدفتر لا
  يفرّق بين الصفر والغياب.
- **الأداء**: كل التجميع في SQL على فهارس الزمن؛ `agentName` و`installedSkills` (قراءة مجلد المهارات)
  تُستدعى مرة لكل وكيل/بروفايل في الطلب.
- الرجوع: استرجاع الـ commits. الترحيل يضيف جدولين وفهرسًا فقط؛ بقاؤهما بعد الرجوع بلا ضرر.

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية للمراجعة؛ المالك يؤكد القرارات المقترحة أعلاه ويجرّب الصفحتين على Hermes
حقيقي في بيئة التست (محادثة تستعمل مهارة ثم «استخدام المهارات»).
