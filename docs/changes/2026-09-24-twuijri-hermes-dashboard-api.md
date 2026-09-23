# لوحة هرمز كواجهة داخلية تُشغَّل عند الطلب
المسؤول: twuijri · الفرع: feat/hermes-dashboard-api · الحالة: review

## المشكلة والهدف
أمر `hermes kanban` لا يستطيع تعديل عنوان البطاقة أو وصفها، ولا حذفها، ولا التعليق عليها، ولا
إعادة إسنادها، ولا إيقاف تشغيلها. هرمز نفسه يستطيع كل ذلك عبر واجهة إضافة الكنبان في لوحته
(`plugins/kanban/dashboard/plugin_api.py`: `PATCH /tasks/{id}` للعنوان والوصف والأولوية
والحالة والمُسنَد، و`DELETE`، و`comments`، و`reassign`، و`runs/{id}/terminate` …). اقترح المالك
(2026-09-24) تشغيل لوحة هرمز نفسها داخل الحاوية بدل استدعاء دوال خاصة.

الهدف في هذا الـ PR: **خدمة** في وحدة `agents` تشغّل خادم هرمز عند أول طلب وتوقفه عند الخمول،
وتضيف الرمز لكل طلب، وتعيد جملة هرمز حرفيًا عند الرفض. مرآة المهام الكاملة (استعمال الخدمة
من وحدة `tasks`) في PR لاحق؛ لم يُلمس `modules/tasks/**` ولا واجهة المهام.

## القرار والموافقات
- **`hermes serve` بدل `hermes dashboard` مع ملف وهمي** — انحراف واعٍ عن الخطة المكتوبة: الخطة
  طلبت وضع `web_dist/index.html` وهمي في الصورة لأن `hermes dashboard --skip-build` يرفض البدء
  بدونه. قراءة مصدر هرمز (MIT) أظهرت أن `hermes serve` هو الوضع بلا واجهة للأمر نفسه
  (`cmd_dashboard` مع `headless_backend`): تطبيق FastAPI نفسه ومسارات الإضافات نفسها، بلا واجهة
  تُبنى أو تُركَّب، وهو ما يشغّله تطبيق هرمز المكتبي خلفيةً له. جرّبته على الصورة كما هي: يبدأ،
  و`/api/plugins/kanban/board` يعطي 401 بلا رمز و200 به. فلا تغيير في الصورة، ولا ملف وجوده
  لإرضاء فحص فقط. لو فضّل المالك `dashboard` فالتغيير سطر في argv وسطر في `Dockerfile`.
- **داخلي فقط**: على `127.0.0.1` بمنفذ يختاره النظام (`--port 0`)، والجاهزية سطر هرمز
  `HERMES_BACKEND_READY port=N` بعد ربط المنفذ. لا يُعرض للمستخدم ولا للشبكة.
- **عند إدارة المجلس لهرمز فقط** (`managed`، مع وجود `hermes` ومنزله): غير ذلك
  `hermesDashboardFor(app)` يعيد `null`.
- **عند الطلب**: أول طلب يشغّله، والطلبات المتزامنة تتشارك تشغيلًا واحدًا؛ يُوقف بعد **10 دقائق**
  بلا طلب (ثابت في الكود)، ويُعاد تشغيله بشفافية مع الطلب التالي، أو إن مات؛ ويُوقف مع إغلاق
  المجلس (SIGTERM ثم SIGKILL بعد مهلة، كما يفعل `HermesRuntime`). مهلة البدء 60 ثانية وخطأ واضح
  فيه آخر سطر كتبه هرمز. طلب لم يصل لأن الخادم مات للتو يُعاد مرة واحدة على خادم جديد، ولا شيء
  غيره يُعاد.
- **الرمز**: يُولَّد مرة ويُحفظ في `/data/keys/hermes-dashboard.secret` (0600، بجانب مفتاح
  `hermes-api.secret`، بالدالة نفسها بعد تعميمها إلى `loadOrCreateSecret`)، ويُمرَّر في بيئة
  الابن `HERMES_DASHBOARD_SESSION_TOKEN`، ويُرسل في `X-Hermes-Session-Token`. لا يُسجَّل (وإن ظهر في
  مخرجات هرمز يُستبدل بـ`[token]`)، ولا يوضع في سطر أوامر، ولا تعيده أي واجهة.
- **البيئة** من `HermesRuntime.cliEnv()` (مفاتيح المزوّدين + `HERMES_HOME` نفسه للبوابة)، مع حذف
  `HERMES_DESKTOP`: خلفية تظن أن التطبيق المكتبي شغّلها تشغّل الكرون داخلها، فيعمل كل جدول مرتين.
- **الأخطاء**: `HermesDashboardRefusal` (الفعل، حالة HTTP، و`detail` هرمز حرفيًا — على شكل
  `HermesRefusal` في `tasks/hermes-kanban.ts`)، و`HermesDashboardUnavailable` حين لا خادم.
- **خارج النطاق**: خادم لكل بروفايل (`--isolated`) وتوجيه البروفايلات. كنبان هرمز واحد لكل
  البروفايلات (`kanban_db.kanban_home`)، فالمرآة لا تحتاجه.
- ADR جديد: `docs/adr/0015-hermes-dashboard-internal-api.md` (مقترح، ينتظر المالك).

## العقد
لا شيء. لا مسار ولا حدث جديد؛ الخدمة داخلية.

## الملفات والتأثير
- `packages/server/src/modules/agents/hermes-dashboard.ts` (جديد): الخدمة.
- `packages/server/src/modules/agents/hermes-runtime.ts`: `loadOrCreateSecret` العامة، و
  `loadOrCreateHermesApiKey` تستعملها (السلوك نفسه).
- `packages/server/src/modules/agents/index.ts`: إنشاء الخدمة في سياق الوحدة، إغلاقها قبل
  `runtime.stop()`، `hermesDashboardFor(app)`، وتصدير الأنواع والأخطاء، وبدائل الاختبار
  (`overrideAgents({ dashboard })`). لم يتغيّر `modules/index.ts` (فيه عمل PR #66).
- `packages/server/src/modules/agents/hermes-dashboard.test.ts` (جديد): 18 اختبارًا بمشغّل وهمي.
- `packages/server/src/modules/agents/hermes-dashboard.real.test.ts` (جديد): هرمز الحقيقي من الصورة.
- `scripts/image-sealed-check.mjs`: ثلاثة فحوص جديدة (يبدأ في الصورة المقفلة، 401 بلا رمز،
  200 به) قبل فحص `docker diff`.
- `docs/adr/0015-hermes-dashboard-internal-api.md` (جديد)، `docs/DEPLOY.md` (ملف الرمز في جدول
  «أين تعيش الأشياء»).
- `docs/STATUS.md` لم يتغيّر: لا شيء مرئي للمستخدم بعد.

## الفحوص (الأوامر ونواتجها الفعلية)
القياس (الصورة المقفلة المبنية محليًا `majlis:dash`، بمستخدم المجلس، بجانب مجلس وبوابة
يعملان): **جاهز خلال 1.0–3.8 ثانية (تشغيلان)، 132–133 MiB ذاكرة مقيمة**. من الاختبار الحقيقي على هذا
الجهاز: أول طلب شاملًا تشغيل الحاوية و`PATCH` **1.2 ثانية**، والحاوية كلها 173–175 MiB؛ إعادة
التشغيل مع قراءة اللوحة 1.2–1.3 ثانية.

```
$ docker build -f packages/server/Dockerfile -t majlis:dash .
Successfully tagged majlis:dash

$ node scripts/image-sealed-check.mjs majlis:dash
ok    the hub answers /api/v1/health
ok    nothing under /app or /opt/hermes is writable by the hub
ok    Hermes's own code cannot be edited
ok    the hub's own code cannot be edited
ok    hermes runs — Hermes Agent v0.21.3 (2026.9.14)
ok    hermes writes a profile to its home in /data
ok    an optional package Hermes needs lands in /data/hermes-packages — /data/hermes-packages/edge_tts/__init__.py
ok    Hermes's dashboard API starts in the sealed image — ready in 1019 ms, 132 MiB resident
ok    it refuses a call without the token (401) — 401
ok    it answers /api/plugins/kanban/board with the token (200) — 200
ok    the container changed nothing under /app or /opt/hermes
ok    the package survives the container being recreated — /data/hermes-packages/edge_tts/__init__.py

image:sealed-check  OK
# (التشغيل الأول، قبل إعادة البناء بالكود النهائي: ready in 3814 ms, 133 MiB resident؛ كل الفحوص ok)

$ MAJLIS_HERMES_IMAGE=majlis:dash pnpm --filter @majlis/server exec vitest run --project unit \
    src/modules/agents/hermes-dashboard.real.test.ts src/modules/agents/hermes-profiles.real.test.ts \
    src/modules/agents/adapters/hermes-tui.real.test.ts
 Test Files  3 passed (3)
      Tests  8 passed (8)
hermes serve: first call (start + PATCH) 1236 ms, memory 175.2MiB / 28.52GiB
hermes serve: restart + GET board 1208 ms

$ pnpm --filter @majlis/server test
 Test Files  68 passed | 6 skipped (74)
      Tests  727 passed | 18 skipped (745)
# (التشغيل الأول فشل في tests/unit/config.test.ts: تعليق في hermes-dashboard.ts ذكر
#  «process.env» حرفيًا فعدّه الحارس لمسًا للبيئة؛ أُعيدت صياغة التعليق)

$ pnpm lint
All matched files use Prettier code style!        # exit 0
$ pnpm typecheck                                   # exit 0
$ pnpm contracts:check-clients
check-clients  OK — 208 client file(s) scanned, 166 contract path(s) known.
$ pnpm change-record:check
change-record  OK — 1 record(s) valid

# بعد دمج origin/main (PR #66، مهام تشغّل الوكيل) في الفرع:
$ pnpm typecheck   # exit 0
$ pnpm lint        # exit 0
$ pnpm --filter @majlis/server test
 Test Files  70 passed | 6 skipped (76)
      Tests  743 passed | 18 skipped (761)
```

## المخاطر والرجوع
- أثناء التشغيل: عملية Python إضافية ~130–170 MiB تختفي بعد 10 دقائق خمول، وتشغّل خوادم MCP
  المضبوطة ما دامت تعمل (كما يفعل `hermes dashboard`).
- أول طلب بعد الخمول ينتظر البدء (1–4 ثوانٍ مقيسة).
- سرّ إضافي في `/data/keys`؛ من يقرأ مجلد البيانات يستطيع النداء — مثل مفتاح API بجانبه، وعلى
  loopback الحاوية فقط.
- ترقية هرمز قد تغيّر سطر الجاهزية أو المسارات؛ الاختبار الحقيقي وفحص الصورة يكشفانها.
- الرجوع: استرجاع هذا الـ commit. لا شيء يستعمل الخدمة بعد، ولا هجرة ولا عقد.

## التسليم والخطوة التالية
PR إلى `main` للمراجعة، بلا دمج ولا صورة. الخطوة التالية (PR «مرآة كنبان هرمز الكاملة»): منفذ في
`modules/index.ts` يبني من `hermesDashboardFor(app)` ما تحتاجه `tasks` — `request('PATCH',
'/api/plugins/kanban/tasks/{id}', {title, body, priority})` لرفع `409 hermes_owns_text`،
و`DELETE /api/plugins/kanban/tasks/{id}` لرفع `hermes_owns_card`، و`POST …/comments`
و`POST …/reassign` و`POST /api/plugins/kanban/runs/{run_id}/terminate` — وتحويل
`HermesDashboardRefusal` إلى `409 hermes_refused` برسالته، و`HermesDashboardUnavailable` إلى
خطأ صريح.
