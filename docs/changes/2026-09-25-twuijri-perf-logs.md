# السجلات والأداء مباشرةً
المسؤول: twuijri · الفرع: feat/perf-logs · الحالة: review

## المشكلة والهدف
صفحتا «السجلات» و«الأداء» في أدوات الإعدادات كانتا تقرآن `audit.getReport`: السجلات = سجل
التدقيق وأحداث المهام (لا أسطر الهب ولا أسطر Hermes)، والأداء = صف في الدقيقة عن ذاكرة الهب
فقط، مع رقم «عيّنات مخزّنة». المالك يفتح هاتين الصفحتين ليعرف ماذا قال الهب وHermes للتو، وما
الذي يستهلك الجهاز الآن — ولا واحدة منهما تجيب.

الهدف (نطاق قراءة ومراقبة فقط — لا طرفية ولا تحرير ملفات):
1. **الأداء مباشرةً** للمالك والمشرف: الجهاز (المعالج، الذاكرة المستخدمة/الكلية، الحِمل)، عملية
   الهب (المعالج، RSS، تأخّر حلقة الأحداث، مدة التشغيل)، كل عملية Hermes (بوابة TUI، و`hermes
   serve`، وبوابة المراسلة لكل بروفايل من #93: PID والمعالج وRSS ومدة التشغيل)، والتشغيلات
   الجارية والمحادثات والاتصالات لكل بروفايل؛ يتحدّث كل ٥ ثوانٍ ويتوقف والتبويب مخفي، مع خطوط
   صغيرة (sparklines) لآخر دقائق بـ SVG عادي؛ `/proc` على لينكس، وبلا أرقام العمليات في غيره.
2. **سجلات أغنى**: المصادر الهب وHermes (كل بوابة باسم بروفايلها) والأخطاء فقط؛ تصفية بالمستوى
   والمصدر/البروفايل والنص؛ آخر 200 أو 1000 أو 5000 سطر؛ متابعة مباشرة وتنزيل؛ وعلى الخادم حلقة
   محدودة في الذاكرة لكل مصدر.

## القرار والموافقات
**مقترح — بانتظار تأكيد المالك** (DECISIONS §51):
1. **الأسطر في حلقات بالذاكرة**، لا في قاعدة البيانات ولا في ملف: حلقة للهب وحلقة لكل بوابة
   Hermes (لكل بروفايل، و`tui` لبوابة TUI المشتركة)، 5000 سطر لكل واحدة. صفحة السجلات لما حدث
   للتو، وسجل الحاوية الكامل في stdout أصلًا، والحلقة لا تملأ قرصًا. حلقة لكل مصدر حتى لا تدفع
   بوابة واتساب كثيرة الكلام آخرَ خطأ للهب خارج الصفحة. إعادة التشغيل تمسحها، والصفحة تقول ذلك.
2. **لا يُحفظ من سطر الهب إلا نصه ونص الخطأ** — الحلقة تُملأ قبل أن يحجب pino الأسرار، فنسخ
   الحقول كان سينسخ الأسرار. أسطر الوصول لكل طلب في Fastify مستبعدة (الصفحة تسأل كل ٣ ثوانٍ
   وستملأ الحلقة بطلباتها). مستوى سطر Hermes من كلماته (`ERROR`، `WARNING`، traceback) لا من
   الأنبوب. أسطر stderr لبوابة TUI (سجل Hermes) تدخل الحلقة وحدها، ولا تدخل سجل الهب كما كانت.
3. **الأداء يُقاس عند السؤال**، بلا مؤقّت في الخلفية: أول نظرة تأخذ عيّنتين بينهما 250 ms، وكل
   نظرة بعدها تقارن بالسابقة؛ `history` هي العيّنات المأخوذة ما دام أحد ينظر، 72 نقطة كحد أعلى
   (ست دقائق)؛ ناظران خلال ثانيتين يتشاركان عيّنة. معالج العملية من نواة واحدة مثل `top`. رقم لا
   يعطيه الجهاز `null` ويُعرض «—»، لا صفر.
4. **التحديث بالسؤال الدوري** (٥ ثوانٍ للأداء، ٣ للمتابعة) ويتوقف والتبويب مخفي؛ لا حدث مباشر
   جديد.
5. **صفحة السجلات للمالك والمشرف فقط** مثل الأداء (كانت `member` في خريطة التنقّل): أسطر الهب
   وHermes ليست من شأن العضو.
6. فلتر «المستوى» يعني «هذا المستوى وما هو أخطر»، و«الأخطاء فقط» مصدر مستقل = أسطر `error` من
   كل المصادر.
7. `audit.getReport` بنوعيه `logs` و`performance` باقٍ كما هو (الواجهة الطرفية والعملاء الأقدم)،
   لكن صفحتي الويب لم تعودا تستعملانه. فرعا `logs`/`performance` في `AuditReport.tsx` صارا غير
   مستعملين وتُركا لتجنّب التعارض مع #108 الذي يعيد كتابة الملف؛ يُحذفان بعد دمجه.

مرفوض: جدول أسطر في قاعدة البيانات (كتابة لكل سطر لا يقرؤه أحد)؛ عيّنات كل ٥ ثوانٍ في الخلفية
(عمل والصفحة مغلقة)؛ فضاء أحداث مباشر جديد (سؤال صغير كل بضع ثوانٍ أبسط ويتوقف وحده).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عملية جديدة `audit.getLivePerformance` — `GET /audit/performance/live`، `x-scope: global`،
  `x-roles: [owner, admin]`، مخططات `LivePerformance` و`HermesProcess`، ردود `200`/`401`/`403`.
- عملية جديدة `audit.listLogLines` — `GET /audit/logs/lines`، عامة وللمالك والمشرف، معاملات
  `source` (`all|hub|hermes|errors`)، `profile`، `level`، `q`، `limit` (1–5000، افتراضي 200)،
  `after`؛ مخططا `LogLine` و`LogLinesPage`؛ ردود `200`/`400`/`401`/`403`.
- `docs/contracts/DECISIONS.md` §51، و`docs/contracts/COVERAGE.md` (صفا 11 و13).

## الملفات والتأثير
- الخادم:
  - `src/lib/log-ring.ts` (جديد): الحلقات، الاستعلام، وتحويل نداء pino إلى سطر.
  - `src/lib/logger.ts`: خطّاف `logMethod` يملأ حلقة المسجّل، و`logRingOf`.
  - `src/app/server.ts`: `hub.logs`.
  - `src/modules/audit/procfs.ts` (جديد): قرّاء `/proc` صافية وقارئ بجذر قابل للحقن.
  - `src/modules/audit/live.ts` (جديد): `LiveSampler`، `registerLiveSources`، `socketsPerProfile`.
  - `src/modules/audit/index.ts`: المساران الجديدان وتصديرهما.
  - `src/modules/agents/adapters/hermes-tui.ts`: `pid` للقناة و`onStderrLine`.
  - `src/modules/agents/hermes-runtime.ts`: `processes()` و`tuiLogLine`.
  - `src/modules/agents/index.ts`: `hermesProcessesFor` وتمرير أسطر TUI إلى الحلقة.
  - `src/modules/sessions/{store,index}.ts`: `activityByWorkspace` و`sessionActivityFor`.
  - `src/modules/index.ts`: جذر التركيب يربط المصادر (`audit` لا يستورد `agents` ولا `sessions`).
- الويب: `settings/LogsTool.tsx`، `settings/PerformanceTool.tsx`، `settings/Sparkline.tsx`،
  `settings/live.ts` (جديدة)، `settings/SettingsScreen.tsx`، `styles/screens.css`،
  `i18n/{ar,en}.json` (`perf.*`، `logview.*`)، `e2e/hub.ts` (تحكّم اختباري `/__e2e/seed-logs`).
- الاختبارات: `server/src/modules/audit/{procfs,live}.test.ts`،
  `server/src/modules/agents/hermes-processes.test.ts`، `server/tests/unit/{log-ring,perf-logs}.test.ts`،
  `server/tests/contract/perf-logs.contract.test.ts`، `server/tests/fixtures/proc/**`،
  `web/tests/perf-logs.test.tsx`، `web/e2e/zzzzzz-perf-logs.spec.ts` ولقطتاه.
- المستندات: `docs/clients/navigation.json` و`NAVIGATION.md` (السجلات للمشرف)، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًّا، كل الأوامر الثقيلة عبر `mj-run`، وفق قاعدة السرعة (ما يمسّه التغيير فقط):

```
$ pnpm lint
All matched files use Prettier code style!                         (exit=0)
$ pnpm typecheck                                                    (exit=0)
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 287 client file(s) scanned, 178 contract path(s) known.
$ pnpm i18n:check
i18n:check  web: 1382 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contract:test
 Test Files  5 passed (5)
      Tests  279 passed (279)
$ pnpm --filter @corehub/server exec vitest run --project unit src/modules/audit/procfs.test.ts \
    src/modules/audit/live.test.ts src/modules/agents/hermes-processes.test.ts \
    tests/unit/log-ring.test.ts tests/unit/perf-logs.test.ts src/modules/agents/hermes-runtime.test.ts \
    src/modules/agents/adapters/hermes-tui.test.ts tests/unit/logger.test.ts
 Test Files  8 passed (8)
      Tests  61 passed (61)
$ pnpm --filter @corehub/web exec vitest run tests/perf-logs.test.tsx tests/navigation.parity.test.tsx \
    tests/i18n.test.ts tests/logical-css.test.ts
      Tests  194 passed (194)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test zzzzzz-perf-logs.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-perf-logs.spec.ts:28:1 › 30. Logs: filter by source and search the lines the hub keeps (2.5s)
  1 passed (8.7s)
```

CI على طلب الدمج #117، الدفعة الأولى: فشل فحصان كشفا ما لم يُشغَّل محليًّا —
`tests/unit/status.test.ts` (`expected 264 to be 266`: العدّ في رأس STATUS لم يُحدَّث) ورحلة
`zz-design.spec.ts` (كانت تنتظر `audit-days-7` في صفحة السجلات القديمة). أُصلحا ثم شُغّلا محليًّا:

```
$ pnpm --filter @corehub/server exec vitest run --project unit tests/unit/status.test.ts
      Tests  1 passed (1)
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test zz-design.spec.ts
  ✓  3 [chromium] › e2e/zz-design.spec.ts:217:3 › the rebuilt screens › agents, models, sessions, settings and the sign-in door are made of the kit (2.9s)
  3 passed (20.2s)
```

CI على #117 بعد الإصلاح (التشغيل 36087606942، الالتزام `5927832`) — كلها خضراء:

```
Docker image builds and answers /health               pass  4m33s
Lint, typecheck, contracts, tests, build              pass  18m5s
PR adds or updates a change record                    pass  10s
PR leaves graphify-out/ to the code-map bot           pass  7s
Web smoke journeys (Playwright against the real hub)  pass  5m28s
db:generate + db:migrate (SQLite and PostgreSQL)      pass  57s
```

## المخاطر والرجوع
- **الذاكرة**: 5000 سطر × حتى 4000 حرف لكل مصدر هو الحد الأعلى النظري؛ عمليًّا الأسطر قصيرة
  (مئات البايتات)، أي نحو 1–2 MB لكل مصدر. عدد المصادر محدود بـ 64.
- **`CLOCK_TICKS = 100`** مفترض (ثابت على لينكس x86-64 وarm64)؛ لو اختلف على جهاز ما تكون نسب
  معالج عمليات Hermes خاطئة بالنسبة نفسها، لا أرقام الجهاز ولا الهب.
- مستوى أسطر Hermes مستنتج من كلماتها؛ سطر بلا كلمة مستوى يأخذ مستوى أنبوبه (stdout = info،
  stderr = warn، وstderr لبوابة TUI = info لأنه سجلها).
- تحويل صفحة السجلات إلى المشرف يخفيها عن الأعضاء؛ الرجوع سطر `roles` في `navigation.json`.
- الرجوع كله: revert للطلب؛ لا ترحيل ولا بيانات مخزّنة (الحلقات والعيّنات في الذاكرة فقط).

## التسليم والخطوة التالية
- طلب دمج بالإنجليزية على `twuijri/core-hub`؛ المالك يؤكّد قرارات §51 أو يعدّلها.
- بعد دمج #108 (صفحة الاستخدام): حذف فرعي `logs`/`performance` غير المستعملين من `AuditReport.tsx`.
- لاحقًا إن أراد المالك: عمود «بروفايل» في جدول عمليات Hermes لبوابة TUI عند تعدد الجلسات، أو
  حدث مباشر بدل السؤال الدوري.
