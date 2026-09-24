# أدوات هرمز الحيّة: فحص خادم MCP، ربط القناة برمز QR، واستيراد حزمة مهارات
المسؤول: twuijri · الفرع: feat/agent-tools-live · الحالة: review

## المشكلة والهدف
ثلاث عمليات من صفحات أدوات هرمز بقيت ⁨501⁩ منذ PR أدوات الوكيل: `agents.testMcpServer`
و`agents.loginChannel` و`agents.importSkills` — «لأن لا أحد يستورد بايتات، ولا يفتح اتصال MCP،
ولا يقترن برمز QR بعد» (`docs/STATUS.md`). والمطلوب: أن تعمل الثلاث **عبر هرمز حيث يملك هرمز
الطريق**، وفي **البروفايل المختار**، وبخطأ صريح مسمّى حيث لا يدير المجلس هرمز.

قبل الكتابة قرأت مصدر هرمز (MIT، الوسم المثبّت `v2026.9.14`، `hermes_cli/web_routers/`) وشغّلت
`hermes serve` من الصورة المحلية وجرّبت كل طريق بيدي:

- **MCP**: `POST /api/mcp/servers/{name}/test?profile=<p>` يتصل فعلًا ويعدّد الأدوات ثم يقطع
  (`_probe_single_server`، مهلته `connect_timeout` من إعداد الخادم، 30 ث افتراضًا). مع خادم stdio
  صغير: `{"ok":true,"tools":[{"name":"echo",…},{"name":"add",…}]}` في 44 مللي ثانية. أمر غير موجود:
  `{"ok":false,"error":"[Errno 2] No such file or directory: 'definitely-not-a-command'"}`. وخادم
  لا يردّ: `{"ok":false,"error":""}` بعد 5 ث — **جملة فارغة**، فلا بد أن يسمّي المجلس السبب بنفسه.
  وخادم في بروفايل آخر: `{"detail":"Server 'workonly' not found"}`، وبروفايل غير موجود:
  `{"detail":"Profile 'nope' does not exist."}`.
- **واتساب**: `POST /api/messaging/whatsapp/onboarding/start` ثم `GET …/{pairing_id}` كل ثانية:
  `installing` ← `waiting` ومعه `qr_payload` (رابط `https://wa.me/settings/linked_devices#…`) في
  نحو خمس ثوانٍ على الصورة، ثم `connected` أو `error` أو `expired` (410، بعد عشر دقائق).
  **لكن `…/apply` في هرمز يعيد تشغيل البوابة** (`hermes gateway restart`)، وفي حاوية بلا systemd
  هذا يوقف بوابة المجلس المُدارة ويشغّل أخرى داخل خادم اللوحة (`hermes_cli/gateway.py`
  §_cmd_restart) — أي بوابتين تتنازعان. فلا أستدعيه.
- **المهارات**: لا مسار في لوحة هرمز يستورد ملفًا أو حزمة. `POST /api/skills` ينشئ مهارة واحدة
  لكنه يفرض على المهارة **الجديدة** وصفًا لا يتجاوز 60 حرفًا (`SKILL_PROMPT_DESC_LIMIT`) — قاعدة
  للمهارات التي يكتبها الوكيل، وترفض أغلب الحزم المنشورة. وهرمز يقرأ المهارة المسطّحة
  `skills/<name>/SKILL.md` في البروفايل (جرّبت: `GET /api/skills?profile=work` أعادها).

## القرار والموافقات
- **فحص MCP عبر هرمز** (`POST /api/mcp/servers/{name}/test?profile=`): المجلس يتحقق أولًا أن الخادم
  في ملف البروفايل (وإلا 404)، ثم يسأل هرمز بمهلة من عنده = `connect_timeout` + 15 ث. ردّ هرمز
  يُنقل كما هو (`ok`، الأدوات، `error` بكلماته)، و`duration_ms` يقيسه المجلس. جملة هرمز الفارغة
  تصير «لم يردّ الخادم خلال N ثانية» بلغة الطالب. ورفض هرمز (بروفايل غير موجود مثلًا) = `409
  hermes_refused` بجملته.
- **ربط واتساب مهمّة (job) من نوع `channel_login`** — العقد كان يقول ذلك أصلًا. المهمة تبدأ الإعداد
  في هرمز وتسأله كل ثانية، وكلما تغيّر الرمز أو الحالة تنشر `job.progress`: `progress.message` جملة
  للإنسان بلغته، و**`result` يحمل `{status, qr, expires_at}` أثناء التشغيل** — لا نضع حمولة الرمز
  في سطر يُفترض أنه للقراءة. عند `connected` يكتب المجلس التفعيل **عبر هرمز**
  (`PUT /api/messaging/platforms/whatsapp?profile=` بـ`WHATSAPP_ENABLED`/`WHATSAPP_MODE=bot`/
  `WHATSAPP_DM_POLICY=pairing`، وهو المسار الذي لا يعيد تشغيل البوابة)، ويحذف جلسة الإعداد، وتنتهي
  المهمة بـ`{status: 'connected', account_name, account_phone}`. **لا نستدعي `apply`** للسبب أعلاه؛
  والصفحة تقول إن القناة تعمل بعد إعادة تشغيل الوكيل كما تقول لكل تغيير في القنوات.
  الإلغاء (`jobs.cancel`) يحذف جلسة الإعداد في هرمز. الانتهاء = فشل بـ`state_invalid` وجملة هرمز،
  والخطأ = فشل بـ`agent_error` وجملة هرمز.
- **واتساب فقط** — مقترح، ينتظر المالك: هو المنصّة الوحيدة التي يقترن فيها هرمز برمز QR من الجهاز
  نفسه. تيليجرام في هرمز «إنشاء بوت» عبر خدمة Nous الخارجية ويطلب أرقام المستخدمين المسموحين —
  منتَج آخر، وليس ربطًا. غير واتساب = `409 login_not_supported`.
- **استيراد المهارات يكتبه المجلس** لأن هرمز لا يملك مستوردًا، بقواعد هرمز للقراءة لا بقاعدة
  «المهارة الجديدة»: `SKILL.md` يبدأ بترويسة YAML مغلقة، فيها `name` و`description`، وجسم غير فارغ،
  وحتى 100٬000 حرف؛ والاسم بقاعدة هرمز `^[a-z0-9][a-z0-9._-]*$` حتى 64. الحزمة ملف `SKILL.md` واحد
  أو `zip` (أو `.skill`) فيه مهارة أو أكثر؛ كل مجلد فيه `SKILL.md` مهارة، وملفاتها المصاحبة
  (`references/` و`scripts/` …) تُنسخ معها **حرفيًا**، والترويسة **لا تُمسّ**. الكل أو لا شيء: أي
  مهارة معطوبة أو موجودة مسبقًا ترفض الحزمة كلها قبل كتابة بايت، والكتابة إلى مجلد مؤقت ثم إعادة
  تسمية. قارئ zip صغير فوق `node:zlib` (لا تبعية جديدة): يرفض التسلّق والمسارات المطلقة والروابط
  الرمزية والتشفير، ويحدّ عدد الملفات والحجم بعد الفك (ضد قنابل الضغط).
- **`category` في `SkillImport` صار اختياريًا** — مقترح، ينتظر المالك: المهارة المستوردة تُكتب بجانب
  أخواتها في `skills/<name>/`، والفئة التي تظهر تحتها تُقرأ من المهارة نفسها (حزمتها) كما في
  القراءة اليوم. حقلٌ إلزامي لا يُستعمل كان سيكذب.
- **الصفحات الأربع تعمل على البروفايل المختار**: بيت البروفايل = بيت هرمز للبروفايل الافتراضي،
  و`profiles/<slug>` لغيره (ADR 0014 §1). بروفايل لا مجلد له في هرمز = `409
  hermes_profile_absent` بدل أن نعرض ملفات البروفايل الافتراضي كأنها ملفاته. هذا ما جعل الاستيراد
  يظهر في القائمة نفسها التي استورد إليها.
- **حيث لا يدير المجلس هرمز**: فحص MCP وربط القناة = `409 hermes_not_supervised`؛ وإن فشل تشغيل
  خادم هرمز = `503 hermes_api_unavailable` بجملته.

## العقد
- `JobKind`: إضافة `channel_login` (في `openapi.yaml` وفي `$defs` أحداث `/rt/jobs` السبعة).
- `agents.testMcpServer`: وصف الطريق عبر هرمز والمهلة، وإضافة `409` و`503`.
- `agents.loginChannel`: وصف `result` أثناء التشغيل وبعده، وإضافة `503`.
- `agents.importSkills`: وصف الحزمة وقواعدها، `category` اختياري، وإضافة `409`.
- `Job.result`: ذكر `channel_login`.
- `docs/contracts/DECISIONS.md` §30.

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml` (الأوصاف، `409`/`503`، `ServiceUnavailable`،
  `JobKind.channel_login`)، و`events/common.schema.json` و`events/jobs/job.*.schema.json` (السبعة)،
  و`docs/contracts/DECISIONS.md` §30.
- الخادم (`packages/server/src/modules/agents/`):
  - `hermes-tools.ts` (جديد): فحص MCP وربط واتساب عبر واجهة هرمز، وترجمة أخطاء هرمز.
  - `skill-import.ts` و`zip.ts` (جديدان): قراءة الحزمة وقواعد هرمز والتثبيت الذرّي، وقارئ zip صغير.
  - `profile-home.ts` (جديد): بيت البروفايل واسمه في هرمز.
  - `index.ts`: المسارات الثلاث، والصفحات الأربع على بيت البروفايل، و`registerAgentAttachments`،
    وبديلا الاختبار `hermesApi` و`pairingPollMs`.
  - `hermes-dashboard.ts`: مهلة لكل طلب، و`timedOut` في `HermesDashboardUnavailable`.
  - `testing/make-zip.ts` (أداة اختبار)، و`tests/fixtures/mcp-stdio-server.mjs` (خادم MCP صغير بلا تبعيات).
- `modules/audit/{jobs,service}.ts`: `progress()` يقبل `result` أثناء التشغيل (إضافة اختيارية).
- `modules/index.ts`: وصل ملفات `knowledge` بالاستيراد.
- `packages/server/src/i18n/{ar,en}.json`: جمل المهمة ونتيجة الفحص.
- الويب (`packages/web/src/agents/`): زر «اختبار» ونتيجته في MCP، و«ربط واتساب» ونافذة الرمز في
  القنوات، و«استيراد» في المهارات، و`toolErrors.ts` لأسباب الرفض، و`skills.ts` (الخطافات)،
  و`screens/DeviceConnectionsScreen.tsx` (تصدير `QrCode` فقط)، و`i18n/{ar,en}.json`.
- `packages/web/e2e/hub.ts` (واجهة هرمز مكتوبة للرحلات) و`e2e/zz-agent-tools.spec.ts` (الرحلة 23)
  وأربع لقطات جديدة.
- `docs/STATUS.md`: صفّ `agents` والعدد (188 من 251).

## الفحوص
```
$ mj-run pnpm lint                         → exit 0 (eslint + "All matched files use Prettier code style!")
$ mj-run pnpm typecheck                    → exit 0
$ mj-run pnpm contracts:lint               → "Your API description is valid" · "contracts:lint  OK" (90 event schemas)
$ mj-run pnpm contracts:check-clients      → check-clients  OK — 226 client file(s) scanned, 166 contract path(s) known.
$ pnpm --filter @majlis/contracts test     → Test Files 4 passed · Tests 15 passed
$ mj-run pnpm i18n:check                   → web: 883 keys, ar/en in parity · OK
$ mj-run pnpm nav:check                    → OK — 34 destinations
$ mj-run pnpm --filter @majlis/server test -- --maxWorkers=2
 Test Files  78 passed | 8 skipped (86)
      Tests  827 passed | 23 skipped (850)
$ mj-run pnpm contract:test -- --maxWorkers=2
 Test Files  2 passed (2)
      Tests  254 passed (254)
$ mj-run pnpm --filter @majlis/web test -- --maxWorkers=2
 Test Files  38 passed (38)
      Tests  483 passed (483)
$ mj-run pnpm build                        → exit 0
$ PLAYWRIGHT_CHANNEL=chrome mj-run pnpm web:e2e
  29 passed (2.0m)
$ MAJLIS_HERMES_IMAGE=majlis:local MAJLIS_REAL_WHATSAPP=1 vitest run src/modules/agents/agent-tools.real.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
```
- هرمز الحقيقي (أول تشغيل، على صورة بنيتها من `main` — الاختبار يستعمل منها هرمز وحده): فحص MCP الأول مع بدء `hermes serve`
  4516 مللي ثانية؛ خادم يخرج قبل أن يردّ: 5019 مللي ثانية و«The server did not answer within 5 s
  (its connect_timeout).»؛ مهارة مثبّتة في بروفايل `work` أعادها `GET /api/skills?profile=work`
  وأعاد `…/content` نصّها حرفيًا؛ ربط واتساب حقيقي وصل أول رمز QR بعد 9167 مللي ثانية ثم أُلغي (لم
  يُربط شيء). الإعادة الثانية على `majlis:local` الحالي (بناه وكيل آخر بعد إعادة التشغيل، والإصدار
  المثبّت لهرمز نفسه) نجحت كذلك. لا حاويات باقية.
- الاختبارات الجديدة تفشل على الكود القديم: كانت المسارات الثلاث ⁨501⁩، وصفحات الأدوات كانت تقرأ
  بيت هرمز الجذري لكل بروفايل (اختبار «the tool pages act on the selected profile»).
- لقطات الرحلات الأخرى التي تغيّرت بالتشغيل أُرجعت؛ الأربع الجديدة لهذه الرحلة فقط.

## المخاطر والرجوع
- **عيب قائم في `knowledge` (خارج النطاق، لم أصلحه)**: رفع الملف نفسه بعد حذفه، أو بالبايتات نفسها
  واسم آخر، يعطي ⁨500⁩ (`UNIQUE constraint failed: attachments.storage_key` — الفهرس فريد على
  مفتاح التخزين بينما إزالة التكرار تفترض عدّة صفوف). لذلك لا يحذف الويب ملف الحزمة بعد الاستيراد:
  يبقى في ملفات البروفايل، ورفع الحزمة نفسها ثانية يعود بالمرفق نفسه فيُرفض بـ`skill_exists` كما يجب.
  يحتاج إصلاحًا وهجرة في `knowledge`.
- **الصفحات الأربع صارت على بيت البروفايل**: بروفايل لا مجلد له في هرمز (أُنشئ قبل المرآة أو بلا
  هرمز) يرى الآن `409 hermes_profile_absent` بدل ملفات البروفايل الافتراضي. هذا هو الصحيح، لكنه
  تغيّر مرئي.
- **القائمة لا ترى المهارات المصنّفة في مجلدات** (`skills/<category>/<name>/`، شكل مهارات هرمز
  المرفقة): قراءة الصفحة بعمق مستوى واحد — عيب قائم قبل هذا الـPR. الاستيراد يكتب مسطّحًا
  (`skills/<name>/`) فيظهر في القائمة ويقرؤه هرمز.
- رمز QR يمرّ في `result` المهمة، وأحداث `/rt/jobs` لكل من في البروفايل: من يمسحه يربط **جوّاله هو**
  بالوكيل، لا يسرق شيئًا من المالك؛ والنتيجة النهائية لا تحمل الرمز.
- بعد الربط يلزم إعادة تشغيل الوكيل ليبدأ الردّ على واتساب (كل تغييرات القنوات كذلك).
- الرجوع: الفرع وحده. لا هجرة؛ `channel_login` قيمة مضافة للتعداد.

## التسليم والخطوة التالية
الفرع `feat/agent-tools-live` فوق `main` (c62e3e8)، وطلب دمج إلى `main`.

القرارات المقترحة للمالك: واتساب فقط لربط QR؛ `category` اختياري في `SkillImport`؛ عدم استدعاء
`apply` في هرمز. الخطوة التالية: إصلاح عيب رفع الملف نفسه في `knowledge`، وقراءة المهارات المصنّفة
في صفحة المهارات.
