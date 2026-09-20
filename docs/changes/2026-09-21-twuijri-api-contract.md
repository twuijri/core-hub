# عقد الواجهة التأسيسي (OpenAPI + أحداث الوقت الحقيقي)
المسؤول: twuijri · الفرع: (لم يُنشأ بعد — الملفات كُتبت في نسخة العمل بلا أوامر git بطلب المالك) · الحالة: review

## المشكلة والهدف
لا يوجد عقد لواجهة Core Hub بعد؛ العملاء الحاليون (أندرويد/iOS) يكتبون المسارات يدويًا
وانحرفوا عن الخادم مرتين (ADR 0003). الهدف: عقد واحد لمرحلتي 0 و1 (`auth`, `agents`,
`sessions`, `rooms`, `board`, `schedules`, `models`, `devices`, `notify`, `updates`) مع
مخططات لكل حدث وقت حقيقي، وبذور للوحدات المؤجلة (`knowledge`, `audit`, `plugins`)،
ومصفوفة تغطية تثبت أن كل شاشة في خريطة التنقل لها مصدر بيانات.

## القرار والموافقات
- الغرفة النظيفة (ADR 0004): لم يُفتح أي مصدر لـ Hermes Studio / Ekko Studio ولا
  `packages/*` في نسخة المالك. المصادر المقروءة: وثائق `corehub/docs/`، عميلا الهاتف
  (MIT، ملك المالك) بوصفهما جردًا للاحتياجات لا قائمة مسارات، `clawboard` (MIT، ملفا
  README وOpenAPI ومخطط قاعدة البيانات لأفكار اللوحة واليوميات)، وخريطة التنقل
  `docs/mobile/NAVIGATION.md` من فرع `chore/mobile-remove-pets`.
- ٢٤ قرارًا في `docs/contracts/DECISIONS.md`؛ أبرزها: مخطط رسالة واحد للجلسات والغرف،
  كل تشغيل وكيل هو Job داخل جلسة، مورد `Approval` واحد لكل أنواع الانتظار، الترويسة
  `X-Hub-Profile` تحمل الـ slug، الخادم يولّد كل المعرّفات (لا مسودات على العميل)،
  جدول انتقالات كانبان يفرضه الخادم، مورد `Schedule` واحد لمهام cron وجداول سير العمل.
- يحتاج قرار المالك: (أ) إضافة وحدة نواة `jobs` إلى جدول الوحدات في ARCHITECTURE
  (القرار 19)؛ (ب) نقل `docs/mobile/NAVIGATION.md` إلى `docs/clients/NAVIGATION.md` كما
  يشير AGENTS.md؛ (ج) اعتماد جدول انتقالات كانبان (القرار 8).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `packages/contracts/openapi.yaml` — OpenAPI 3.1، 160 مسارًا، 244 عملية، 247 مخططًا.
  لكل عملية `operationId` و`tags` و`security` ومخططات الطلب/الاستجابة ومثال (عربي حيث
  النص للمستخدم) و`x-rt-events`.
- `packages/contracts/events/` — 89 ملف مخطط حدث (JSON Schema 2020-12) موزّعة على
  ستة مجالات + `common.schema.json` (مولَّد من مخططات OpenAPI) + `README.md`.
- `packages/contracts/README.md` — دليل الحزمة.
- الوثائق: `docs/contracts/README.md` (المبادئ)، `COVERAGE.md`، `DECISIONS.md`.

## الملفات والتأثير
- جديد: `docs/contracts/{README,COVERAGE,DECISIONS}.md`، `packages/contracts/openapi.yaml`،
  `packages/contracts/README.md`، `packages/contracts/events/**` (91 ملفًا).
- لا تعديل على أي ملف قائم. لا كود تشغيل.
- التأثير: يصبح أساس توليد عملاء TypeScript/Kotlin/Swift ومخططات مسارات Fastify.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ npx --yes @redocly/cli@1.34.3 lint packages/contracts/openapi.yaml --format=stylish
validating packages/contracts/openapi.yaml...
Woohoo! Your API description is valid. 🎉
```
(بلا تحذيرات؛ خرج الأمر 0. الإعدادات الافتراضية `recommended` كاملة، أشد من `redocly.yaml` الذي أضافه الهيكل.)
```
$ cd packages/contracts && pnpm lint          # سكربت الهيكل: redocly + ajv لكل مخطط حدث + قاعدة الأمثلة
openapi.yaml: validated in 400ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm test
 Test Files  3 passed (3)
      Tests  11 passed (11)
```
```
$ python3 gen_events.py            # يولّد common.schema.json + 89 ملف حدث ويقارن مع x-rt-events
event files 89 distinct names 76
x-rt-events referenced but undefined: []
defined but never referenced by an operation: ['device.offline', 'device.online', 'member.typing']   # يطلقها المقبس لا HTTP (موثّق)
$ python3 validate_events.py      # jsonschema Draft 2020-12، كل مثال ضد مخططه
event examples valid: 89 invalid: 0
$ python3 check_coverage.py       # كل operationId في COVERAGE.md موجود، وكل عملية مذكورة
cited but not in contract: []  · operations not cited anywhere in COVERAGE: []
```
ملاحظتان لوكيل الهيكل: (١) `scripts/lint.mjs` يحذّر ٨٩ مرة لأن التعبير النمطي يقصّ
`.json` فقط ويترك `.schema` — يُفضَّل قصّ `.schema.json`؛ (٢) ajv فيه يترجم كل ملف على
حدة، لذلك جُعلت ملفات الأحداث مكتفية بذاتها (`$defs` مضمَّنة) ويبقى
`common.schema.json` المرجع المولَّد.

## المخاطر والرجوع
- المخاطر: حجم العقد كبير (244 عملية) قبل وجود أي كود؛ بعض الأشكال (مثل `Journey`،
  `Relay`، `Peer`) مبنية على سلوك العميل الحالي فقط وقد تُبسَّط عند التنفيذ. الأحداث
  `device.online/offline` و`member.typing` و`schedule_run.*` لا يطلقها HTTP بل طبقة
  المقبس/المجدول (موثّق في README الأحداث).
- الرجوع: حذف الملفات الجديدة؛ لا شيء آخر تأثر.

## التسليم والخطوة التالية
1. المالك يراجع `DECISIONS.md` (خاصة 8 و19) وينشئ فرع `docs/api-contract` من `origin/main`
   ويلتزم الملفات (لم تُنفَّذ أوامر git هنا بطلبه).
2. وكيل الهيكل: يضيف `pnpm contracts:lint` (redocly) و`contracts:generate` (يعيد توليد
   `events/common.schema.json` من OpenAPI ويتحقق من `x-rt-events`) وسكربت يقرأ
   `COVERAGE.md` ويسقط عند `operationId` غير موجود.
3. تحديث ARCHITECTURE §Modules بوحدة `jobs`، ونقل خريطة التنقل إلى `docs/clients/`.
