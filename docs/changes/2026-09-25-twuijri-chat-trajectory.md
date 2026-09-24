# تبويب «المسار» (Trajectory) لكل محادثة
المسؤول: twuijri · الفرع: feat/chat-trajectory · الحالة: review

## المشكلة والهدف
سأل المالك (٢٠٢٦-٠٩-٢٥): «في ديب سيك هارنس خاصية اسمها Trajectory هل نقدر نضيفها في محادثات
كور هب؟» — ثم «ايه». الهدف: أن يرى الشخص ما فعله الوكيل في المحادثة خطوةً خطوة على خط زمني
(مُدخل · نموذج · أدوات)، يصفّي الخطوات ويبحث فيها، يفتح أي استدعاء أداة على مدخلاته وناتجه، يرى
مقاييس الأداء التي يملكها المركز فعلًا، وينزّل سجل الجلسة — لكل الوكلاء (Hermes، المباشر،
الوكلاء البرمجيون عبر ACP) بما يرسله كلٌّ منهم.

## القرار والموافقات
موافقة المالك على الفكرة: «ايه». المواصفة بكلماتنا في `docs/inspirations/trajectory.md` (رُصدت
الفكرة من وصف المالك وحده؛ المنتج الأصلي لم يُفتح، ورخصته غير معروفة، فلا شيء منقول منه).
قرار العقد: DECISIONS §43 (§41 أخذه #97 تيليجرام، و§42 أخذه #99 إعادة التسمية).

قرارات منتج جديدة — **مقترحة، والمالك يؤكد**:
- **اتجاه الزمن = اتجاه القراءة**: في العربية يبدأ الخط الزمني من اليمين. يتحقق بـ
  `inset-inline-start`، ومثبَّت في رحلة Playwright (الاستدعاء الأحدث أبعد إلى اليسار).
- **الوقت الخامل يُطوى**: فجوة أطول من ٣ ثوانٍ بلا نشاط تُرسم بعرض ثابت مع خط متقطع، وإلا صارت
  محادثة تمتد أيامًا نقاطًا.
- **معنى التصفيات الثلاث**: «المدة» ترتّب من الأطول، «الأدوار» و«الاستدعاءات» تحصران القائمة في
  نوعها (معًا: كلاهما؛ بلا أيٍّ: كل الخطوات مع المُدخلات)، والبحث في النص والمدخلات والناتج.
- **التبويبان يظهران بعد أول رسالة فقط**، والتبويب في العنوان (`?view=trajectory`)، والمحادثة
  تبقى محمَّلة تحته (لا يضيع موضع القراءة ولا المسودة). المُلحِّن مخفي في «المسار».
- **سجل الجلسة** بصلاحية قراءة المحادثة نفسها (من يدخل البروفايل ويقرأ المحادثة ينزّل سجلها)،
  كما في `sessions.export` — لا قاعدة أضيق من قراءة النص نفسه.

ما لا يملكه المركز لا يُعرض (لا أصفار): الرموز حين يبلّغ المزوّد استهلاكًا، نسبة الذاكرة المؤقتة
حين يبلّغ قراءات منها، والأزمنة للتشغيلات المسجّلة بأدوارها.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عملية جديدة `sessions.getTrajectory` — `GET /sessions/{session_id}/trajectory`، و`download=true`
  يرسل الوثيقة نفسها ملفًّا `session-<id>-log.json`.
- مخططات جديدة: `Trajectory`, `TrajectoryStep`, `TrajectoryMetrics`, `TrajectoryStepKind`,
  `TrajectoryLane`, `TrajectoryStepStatus`, `TrajectoryTiming`.
- لا حدث لحظي جديد ولا تغيير في حدث قائم: العميل يعيد القراءة مع أحداث `/rt/sessions`.
- DECISIONS §43، و`COVERAGE.md` (صف المحادثة).

## الملفات والتأثير
الخادم (`packages/server`):
- `modules/sessions/run-reducer.ts`: `ModelTurnState` — يبدأ دور عند بدء التشغيل وبعد انتهاء آخر
  أداة، وينتهي عند بدء أداة أو سؤال الشخص أو النهاية؛ مع أول كلمة ومواضع النص والتفكير.
- `modules/sessions/schema.ts` + `drizzle/0015_run_timing.sql`: عمود `runs.timing` (JSON).
- `modules/sessions/engine.ts`: يكتب الأدوار عند نهاية التشغيل، و`liveState()` للتشغيل الجاري.
- `modules/sessions/trajectory.ts` (جديد): `buildTrajectory` دالة صافية — الخطوات والمدد والمقاييس.
- `modules/sessions/{service,store,routes}.ts`: القراءة والمسار.
- `modules/agents/adapters/hermes-tui.ts`: Hermes يبلّغ **مجموع جلسته الحيّة** في كل
  `message.complete` (قُرئ في مصدره MIT: `tui_gateway/server.py` `_get_usage`، و`agent/turn_usage.py`
  يجمع `session_*`)، فكان كل تشغيل بعد الأول يُسجَّل بمجموع ما قبله. الآن يُسجَّل فرق الدور؛ عدّاد
  نزل يعني أن Hermes بدأ وكيل الجلسة من جديد.
- `modules/models/adapters/{openai,google,types}.ts`: رموز الإدخال لا تشمل المخزَّن مؤقتًا (عُرف
  Anthropic)؛ OpenAI وGoogle كانا يعدّانها مرتين — في الإدخال وفي قراءات الذاكرة — فكانت
  الكلفة التقديرية تحسبها مرتين، ونسبة الذاكرة ستكون خاطئة.

الويب (`packages/web`):
- `chat/ChatScreen.tsx`: التبويبان في صف العنوان؛ المحادثة `TabPanel keepMounted flow`.
- `chat/TrajectoryView.tsx`, `chat/trajectory.ts`, `chat/useTrajectory.ts` (جديدة): العرض،
  القواعد الصافية (التصفية، المحور، طيّ الخمول، صفوف الأدوات المتوازية)، والقراءة المتابِعة (مرة في
  الثانية على الأكثر أثناء البث).
- `chat/ToolCallCard.tsx`: `ToolCallBody` مستخرَج ليعرض خطوة الأداة كما في بطاقتها.
- `ui/Tabs.tsx` (+ `ui/index.ts`, `styles/kit.css`): `TabsFrame` و`TabList` ولوحة تبقى محمَّلة.
- `ui/icons.tsx`: `IconDownload`. `styles/chat.css`, `styles/app.css`. `i18n/{ar,en}.json`: مفاتيح
  `trajectory.*`.
- `e2e/hub.ts`: سيناريو «ارسم المسار»؛ `e2e/zzzzzz-chat-trajectory.spec.ts` (الرحلة ٣١).

الوثائق: `docs/inspirations/trajectory.md` (جديد)، `inspirations/README.md`,
`inspirations/ADOPTION-BACKLOG.md` (2.18)، `contracts/DECISIONS.md` §43، `contracts/COVERAGE.md`،
`STATUS.md` (202 من 260).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، ما يمسّه التغيير فقط (قاعدة السرعة)؛ الحزم الكاملة يشغّلها CI.
```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!

$ pnpm typecheck        # exit=0 (كل الحزم)

$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 265 client file(s) scanned, 173 contract path(s) known.
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  269 passed (269)

$ pnpm i18n:check
i18n:check  web: 1177 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web

$ vitest run --project unit src/modules/sessions/trajectory.test.ts src/modules/sessions/run-reducer.test.ts \
    src/modules/agents/adapters/hermes-tui.test.ts src/modules/models/adapters/chat.test.ts
 Test Files  4 passed (4)
      Tests  61 passed (61)
$ vitest run --project unit src/modules/sessions/trajectory-api.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
$ vitest run --project unit tests/unit/status.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)

$ (web) vitest run tests/trajectory.test.tsx tests/tool-calls.test.tsx tests/ui-layer.test.ts tests/logical-css.test.ts
 Test Files  4 passed (4)
      Tests  185 passed (185)

$ pnpm build            # ✓ built
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @majlis/web exec playwright test e2e/zzzzzz-chat-trajectory.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-chat-trajectory.spec.ts:26:1 › 31. the Trajectory tab follows a run, opens a step, filters, and downloads the log (4.3s)
  1 passed (12.0s)
```
الاختبارات الجديدة تفشل على الكود القديم: `trajectory*.test.ts` و`trajectory.test.tsx` تستورد
ما لم يكن موجودًا؛ اختبار Hermes (فرق الدور) كان سيسجّل ١٢ ثم ٣٠ ثم ٤؛ واختبار OpenAI كان يتوقع
١١ رمز إدخال مع ٤ مخزّنة.

CI: يُملأ بعد الدفع.

## المخاطر والرجوع
- **الأدوار مستنتَجة** من البث لا من نداءات النموذج الفعلية؛ وكيل يبث نصًّا أثناء عمل أدواته
  (وكلاء فرعيون) يظهر دوره متداخلًا مع أشرطة الأدوات. موثّق في §43.
- **الحجم**: الوثيقة تحمل الاستدعاءات كاملة (الناتج مقصوص أصلًا عند 16 KB)، وتُقرأ مرة في الثانية
  على الأكثر أثناء البث وفقط والتبويب مفتوح. محادثة بمئات الاستدعاءات الكبيرة ثقيلة؛ التقسيم
  بالتبادلات خطوة لاحقة إن ظهرت الحاجة.
- **أرقام الاستهلاك تتغير** للمحادثات الجديدة: Hermes يسجّل الآن رموز كل دور لا مجموع جلسته
  (كانت إجماليات الجلسة تُضخَّم)، وكلفة OpenAI/Google التقديرية لم تعد تحسب المخزَّن مرتين.
  السجلات القديمة لا تُعاد كتابتها.
- **لم يُجرَّب على Hermes حقيقي**: الأدوار والأزمنة مثبتة أمام المشغّل المكتوب، وفرق Hermes أمام
  بوابة TUI مكتوبة. Hermes لا يرسل قراءات الذاكرة المؤقتة خامًا (نسبة مقرّبة فقط)، فلا نسبة له.
  ACP لا يرسل استهلاكًا، فلا رموز للوكلاء البرمجيين.
- الرجوع: استرجاع الـ commits. العمود `runs.timing` قابل للإلغاء ويبقى `NULL` بلا ضرر إن رجع الكود.

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية للمراجعة؛ المالك يؤكد القرارات المقترحة أعلاه، ويجرّب «المسار» على
محادثة Hermes حقيقية في بيئة التست.
