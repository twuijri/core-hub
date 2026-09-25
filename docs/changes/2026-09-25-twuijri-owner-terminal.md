# طرفية ويب للمالك وحده
المسؤول: twuijri · الفرع: feat/owner-terminal · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٥) طرفية في الويب، وحدّد لمن هي: «الا خله للمشرف الرئيسي بس» — أي الحساب
الواحد بدور `owner`، لا المشرفين ولا الأعضاء.

الهدف: صدفة (shell) على جهاز المركز من صفحة في الإعدادات، وكل قيودها على الخادم لا في الواجهة:
- مطفأة ما لم يُشغَّل المركز بـ`COREHUB_WEB_TERMINAL=1`.
- حتى وهي مفعّلة: المالك فقط؛ المشرف والعضو ‎403‎، والويب لا يُظهر لهما المدخل.
- كل بدء جلسة وانتهائها في سجل التدقيق (من، ومتى، وفي أي مجلد).
- الجلسة الخاملة تُغلق بعد مهلة (١٥ دقيقة افتراضيًا)، ولا يزيد المفتوح عن ثلاث.
- الصدفة بحساب المركز نفسه (لا root أبدًا)، في `/data/workspaces/<البروفايل المختار>`، والصورة
  تبقى مختومة: `/app` و`/opt/hermes` للقراءة فقط.

## القرار والموافقات
- الموافقة: طلب المالك في المحادثة (الاقتباس أعلاه). لا دمج ولا نشر من المساعد.
- قرار العقد **§60** في `docs/contracts/DECISIONS.md`. **الرقم أُخذ والدمج التكاملي لـ٣٦ طلب دمج
  جارٍ** (`integration/2026-09-25` لم يُدفع بعد؛ أعلى رقم في `main` §47 وفي الطلبات المفتوحة §59):
  **قد يحتاج إعادة ترقيم**.
- **الخادم (وحدة `terminal` جديدة):**
  - `GET /terminal` (`terminal.get`، `x-roles: [owner]`): للمالك ‎200‎ بالحالة وجلساته الحية؛
    للمشرف والعضو ‎403‎ (`required_role: owner`)؛ وللمالك والطرفية مطفأة ‎403‎
    (`reason: terminal_disabled`). الويب يُظهر المدخل على ‎200‎ فقط.
  - مساحة `/rt/terminal` مصادقة كغيرها (وسيط `auth` نفسه من إصلاح ٢٠٢٦-٠٩-٢٤)، ثم وسيط الطرفية
    يرفض المصافحة بـ`forbidden` مع السبب (`terminal_disabled`، `owner_only`،
    `web_session_required`). وتغيّر الدور أو الخروج يقطع الاتصال (`revalidateSockets` يمر على كل
    المساحات).
  - أوامر: `open`، `attach`، `input`، `resize`، `close`؛ وحدثان: `terminal.output`،
    `terminal.exited`. الكتابة عبر المقبس استثناء من «التعديل عبر HTTP» (كـ`typing`).
  - **الجلسة للمالك لا للمقبس:** إعادة تحميل الصفحة أو انقطاع الاتصال يعيد الربط (`attach` مع آخر
    ٦٤ ألف حرف من المخرجات لإعادة رسم الشاشة)، حتى تنقضي مهلة الخمول. المخرجات وحدها ليست نشاطًا
    (برنامج يطبع باستمرار لا يُبقي الجلسة حية)؛ الكتابة والتحجيم وإعادة الربط نشاط.
  - **PTY حقيقي عبر `node-pty` 1.1.0 (MIT)**، وإن لم يُحمَّل ثنائيه يرجع المركز إلى صدفة عبر
    الأنابيب بلا PTY ويقول ذلك (`pty: false` وسطر في السجل). **بُني في الصورة** فلم نحتج
    البديل هناك.
  - الصدفة ترث قائمة قصيرة من المتغيرات فقط (PATH، HOME، اللغة، متغيرات Hermes) لا بيئة المركز
    كلها — ترتيب لا جدار (انظر نموذج التهديد).
  - تدقيق: `terminal.opened` (المستخدم، المجلد، البروفايل، الصدفة، العنوان) و`terminal.closed`
    (السبب `closed`/`exited`/`idle`/`shutdown`، والمدة). يظهران في الإعدادات ← السجلات. **ما يُكتب
    لا يُسجَّل.**
- **الويب:** أداة «الطرفية» / "Terminal" في قسم الأدوات من الإعدادات، `roles: ["owner"]` و`surfaces:
  ["web"]` في `navigation.json`، ولا تظهر إلا إذا أجاب `GET /terminal` بـ‎200‎ (ولا يُسأل عنها
  أصلًا لغير المالك). `xterm.js` 6 مع إضافة fit (MIT) **محمّلة كسولًا** في جزء مستقل (٨٤ KB مضغوطة)
  لا يصل حزمة أحد غير المالك. تبويبات متعددة، نسخ/لصق (أزرار، وCtrl+Shift+C/V، ويبقى Ctrl+C
  للصدفة)، تحجيم تلقائي، إعادة الربط بعد التحميل. شريط التحذير «هذه طرفية على الخادم بصلاحيات حساب
  المركز» ثابت في الصفحة. الشاشة LTR دائمًا، ومسار المجلد معزول `bdi dir="ltr"`.
- **مقترح — للمالك أن يؤكد:** المهلة متغير بيئة (`COREHUB_WEB_TERMINAL_IDLE_MINUTES`)؛ رفض رموز
  التطبيقات حتى للمالك (رمز تكامل مسرّب يجب ألا يكون صدفة)؛ الحد ثلاث جلسات على مستوى المركز؛ عدم
  تسجيل ما يُكتب (كلمة مرور `sudo` أو محتوى `.env` كانت ستقع في قاعدة البيانات)؛ الطرفية على الويب
  فقط الآن.
- رُفض: إدخال المشرفين بمفتاح ثانٍ (المالك قال المالك فقط)؛ جلسة لكل مقبس (التحديث يقتل الأمر
  الجاري)؛ تشغيل الصدفة بمستخدم أضعف (الصورة فيها مستخدم واحد غير مميز، والتبديل يحتاج root).
- ملاحظة على `docs/inspirations/hermes-agent.md`: رفضنا هناك «تضمين TUI عبر PTY/xterm في عملائنا»
  طريقةً للحديث مع الوكلاء. هذه ليست تلك: أداة إدارة للمالك، والمحادثة باقية أحداثًا منظّمة.

### نموذج التهديد
| السؤال | الجواب |
|---|---|
| **من يصل إليها؟** | من يسجّل دخوله **مالكًا من متصفح** على مركز شُغّل بـ`COREHUB_WEB_TERMINAL=1`. لا المشرف ولا العضو (‎403‎ ورفض المصافحة، مُختبر)، ولا رمز تطبيق ولو للمالك (مُختبر)، ولا مجهول (المصافحة بلا رمز مرفوضة منذ ٢٠٢٦-٠٩-٢٤). فكلمة مرور المالك صارت بقيمة صدفة على الخادم. |
| **ماذا تلمس؟** | كل ما يصل إليه المستخدم `hub` (uid 10001): كل `/data` — قاعدة البيانات، مفتاح توقيع JWT، مفاتيح المزوّدين المشفّرة وما يفكّها، بيت Hermes و`.env` كل بروفايل، ملفات البروفايلات وبيوت الوكلاء؛ الشبكة التي على الحاوية؛ وعمليات المركز وبيئتها (المستخدم نفسه يقرأ `/proc/<pid>/environ`، فتصفية المتغيرات ترتيب لا حماية). |
| **ماذا لا تلمس؟** | كود المركز وHermes (`/app` و`/opt/hermes` لـroot وللقراءة فقط — `image:sealed-check` يفتح صدفة PTY في الصورة ويحاول الكتابة فيهما: `uid=10001 app=denied hermes=denied`)؛ لا root؛ ولا المضيف خارج الحاوية ما لم يركّب الستاك فيها شيئًا (مقبس Docker، مجلد من المضيف). |
| **ما يحدّها** | مطفأة افتراضيًا؛ المالك فقط؛ ثلاث جلسات؛ إغلاق بعد ١٥ دقيقة بلا كتابة؛ إغلاق كل الجلسات عند توقف المركز؛ ٦٤ ألف حرف حدًّا لكل إدخال. |
| **أثر التدقيق** | `terminal.opened` / `terminal.closed` في `audit_events` (المستخدم، الوقت، البروفايل، المجلد، العنوان، السبب، المدة)، وسطر تحذير في سجل الإقلاع حين تكون مفعّلة. ما يُكتب داخل الطرفية **لا** يُسجَّل. |

## العقد
- `openapi.yaml`: وسم `terminal`، والعملية `terminal.get` (`GET /terminal`، `x-scope: global`،
  `x-roles: [owner]`) بردود ‎200/401/403‎ وأمثلة، والمخططان `TerminalStatus` و`TerminalSession`؛
  و`/rt/terminal` في أمثلة `realtime_namespaces`.
- `events/terminal/terminal.output.schema.json` و`terminal.exited.schema.json`.
- `events/README.md`: أوامر `/rt/terminal` الخمسة، وقسم «طرفية المالك»، وفهرس الحدثين، وأن
  `profile` اختياري في مصافحتها.
- `DECISIONS.md` §60 (قد يحتاج إعادة ترقيم).

## الملفات والتأثير
- الخادم: `modules/terminal/{index,manager,shell}.ts` (جديدة)، `app/config.ts` (متغيّران)،
  `lib/module.ts` (الوحدة والمساحة)، `modules/index.ts`، `i18n/{ar,en}.json`، و`node-pty` في
  `package.json` و`pnpm-workspace.yaml` (`allowBuilds`).
- الصورة: `packages/server/Dockerfile` — `node-pty` يُبنى في مرحلة `prod-deps` (أدوات البناء فيها
  أصلًا من `node:24-bookworm` ولا تصل الصورة النهائية)، ويُقلَّم إلى ثنائي لينكس (**٢٩٦ KB في
  الصورة** بدل ٦٠ MB)، وسطر يفتح صدفة على PTY حقيقي فيفشل البناء إن لم يعمل.
  `scripts/image-sealed-check.mjs` صار يفحص صدفة PTY في الصورة.
- الويب: `terminal/{TerminalTool,XtermPane,queries}.tsx|ts` (جديدة)، `settings/SettingsNav.tsx`،
  `settings/SettingsScreen.tsx`، `realtime/socket.ts`، `styles/screens.css`، `i18n/{ar,en}.json`.
- الملاحة: `docs/clients/navigation.json` و`NAVIGATION.md` (وجهة `terminal`).
- المستندات: `docs/DEPLOY.md` §3c (التفعيل والخطر)، `THIRD-PARTY-NOTICES.md`، `ARCHITECTURE.md`
  (صف الوحدة)، `STATUS.md` (207 من 265).
- الاختبارات: `modules/terminal/manager.test.ts`، `tests/unit/terminal.test.ts`،
  `tests/contract/terminal.contract.test.ts`، `web/tests/terminal.test.tsx`،
  `web/e2e/zzzzzzzz-owner-terminal.spec.ts` (مركز ثالث في Playwright بـ`COREHUB_WEB_TERMINAL=1`،
  بصدفة `sh` حتى لا يظهر اسم جهاز في اللقطة)؛ وتعديل `config.test.ts` و`sockets.test.ts`
  و`realtime-auth.test.ts` (مساحة الطرفية الاستثناء الوحيد من «كل مساحة تقبل المسجَّل»).

## الفحوص
محليًا (عبر `mj-run`)، على الفرع قبل دمج `main`:
```
pnpm lint                     eslint . && prettier --check .  → All matched files use Prettier code style! (exit 0)
pnpm typecheck                exit 0
pnpm contracts:lint           92 event schema file(s) … contracts:lint  OK
pnpm contracts:check-clients  check-clients  OK — 289 client file(s) scanned, 177 contract path(s) known.
pnpm i18n:check               i18n:check  OK
pnpm nav:check                nav:check  OK — 35 destinations, 2 pre-auth screens (login, setup), 40 terms, ar/en complete, routes for web

server (vitest --project unit):
  tests/unit/status.test.ts tests/unit/config.test.ts tests/unit/sockets.test.ts
  tests/unit/realtime-auth.test.ts tests/unit/http.test.ts tests/unit/terminal.test.ts
  src/modules/terminal/manager.test.ts
   Test Files  7 passed (7)
        Tests  48 passed (48)
  (terminal.test.ts ثلاث مرات متتالية: 6 passed (6) في كل مرة)

server (vitest --project contract):
  tests/contract/terminal.contract.test.ts tests/contract/contract.test.ts
        Tests  268 passed (268)

web (vitest):
  tests/terminal.test.tsx tests/navigation.parity.test.tsx tests/i18n.test.ts
  tests/logical-css.test.ts tests/realtime-socket.test.ts tests/realtime-context.test.tsx
  tests/settings-pages.test.tsx
   Test Files  7 passed (7)
        Tests  212 passed (212)

pnpm --filter @corehub/web build  → dist/assets/XtermPane-*.js 334.34 kB │ gzip: 84.28 kB (جزء مستقل)
PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzzzz-owner-terminal.spec.ts
  ✓  1 [chromium] › e2e/zzzzzzzz-owner-terminal.spec.ts:33:1 › the owner opens the terminal, runs echo hi and sees hi, and a reload brings it back (2.2s)
  1 passed (11.2s)

docker build -f packages/server/Dockerfile -t core-hub:terminal .   → Successfully built (node-gyp بنى node-pty)
  du -sh …/node-pty → 296K
node scripts/image-sealed-check.mjs core-hub:terminal
  ok    nothing under /app or /opt/hermes is writable by the hub
  ok    the web terminal's PTY gives the hub's own user, who cannot write /app or /opt/hermes — uid=10001 app=denied hermes=denied
  … (17 فحصًا كلها ok)
  image:sealed-check  OK
الصورة نفسها مع COREHUB_WEB_TERMINAL=1: GET /terminal للمالك →
  200 {"enabled":true,"pty":true,"shell":"/bin/bash","idle_timeout_seconds":900,"max_sessions":3,"sessions":[]}
(الحاوية والصورة أُزيلتا بعد الفحص.)
```
الاختبارات الجديدة تفشل على الكود القديم: لا مسار `/terminal` ولا مساحة `/rt/terminal` ولا وجهة
`terminal` قبل هذا الفرع.

CI على طلب الدمج #141 (الالتزام `d76beb6`، التشغيل 36123405650) — كله أخضر:
```
Lint, typecheck, contracts, tests, build              pass  19m29s
Web smoke journeys (Playwright against the real hub)  pass  5m31s
Docker image builds and answers /health               pass  3m47s
db:generate + db:migrate (SQLite and PostgreSQL)      pass  1m8s
PR adds or updates a change record                    pass  11s
PR leaves graphify-out/ to the code-map bot           pass  8s
```

## المخاطر والرجوع
- **الخطر الأكبر مقصود:** من يملك كلمة مرور المالك والطرفية مفعّلة يملك صدفة بحساب المركز (نموذج
  التهديد أعلاه، و`DEPLOY.md` §3c). لذلك مطفأة افتراضيًا.
- `node-pty` وحدة أصلية: إن تغيّرت منصة البناء ولم يُبنَ، البناء يفشل عند سطر الفحص في
  `Dockerfile` لا في جلسة. خارج الصورة (نسخة تطوير بلا أدوات بناء) يعمل البديل بلا PTY.
- CI يبني `node-pty` بـnode-gyp عند `pnpm install` (يحتاج python3 وmake وg++، موجودة في مشغّلات
  GitHub).
- مركز ثالث في Playwright يزيد زمن الرحلات ثوانيَ قليلة.
- تعارضات متوقعة مع الدمج التكاملي في الملفات المشتركة: `STATUS.md` (العدّ)، `DECISIONS.md`
  (الرقم)، `navigation.json`، ملفات اللغة، `openapi.yaml`، `lib/module.ts`، `modules/index.ts`،
  و`zz-design.spec.ts` لم يُلمس (مركز الرحلات الأساسي بلا طرفية، فعدد أدوات الإعدادات فيه باقٍ ٧).
- الرجوع: إزالة `COREHUB_WEB_TERMINAL` من الستاك تطفئها فورًا بلا نسخة جديدة؛ أو عكس الطلب كاملًا
  (لا ترحيل قاعدة بيانات: التدقيق يستعمل جدول `audit_events` الموجود).

## التسليم والخطوة التالية
- طلب دمج بالإنجليزية إلى `main`؛ مراقبة CI حتى يخضرّ.
- للمالك: تأكيد القرارات المقترحة أعلاه، ورقم §60 بعد الدمج التكاملي.
- لاحقًا إن أراد: الطرفية في تطبيق سطح المكتب (الوجهة `surfaces: ["web"]` الآن).
