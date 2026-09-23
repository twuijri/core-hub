# الصورة مقفلة: لا يعدّل الوكيل كود المجلس ولا كود Hermes
المسؤول: twuijri · الفرع: feat/sealed-image · الحالة: review

## المشكلة والهدف
على ستاك الاختبار أظهر `docker diff majlis` (٢٠٢٦-٠٩-٢٣، شغّله المالك) أن وكيل Hermes عدّل
`/opt/hermes/src/tui_gateway/server.py` داخل الحاوية. السبب أن الصورة تنسخ `/opt/hermes` و`/app`
مملوكين للمستخدم `hub` (uid 10001)، وهو نفسه المستخدم الذي يشغّل المركز وHermes وكل الوكلاء. أي أمر
طرفية ينفّذه وكيل (بالخطأ، أو لأن صفحة قرأها طلبت ذلك) يستطيع تغيير كود Hermes أو المركز، ويبقى
التغيير صامتًا إلى أن تُعاد الحاوية.

باقي ما ظهر في `docker diff` ليس عبثًا:
- حزم أُضيفت إلى venv هرمز: `boto3 1.42.89` و`google-auth 2.55.1` و`pyasn1 0.6.4` و`edge-tts 7.2.7`
  وتوابعها و`pip`. طابقتها بقائمة `tools/lazy_deps.py` في الصورة: نفس الإصدارات المثبتة هناك، أي
  أن Hermes ثبّتها بنفسه أول مرة احتاجت ميزة إليها (صوت Edge، Bedrock، Vertex).
- ملفات `__pycache__` كتبها بايثون.
- لا شيء تحت `/app`.

الهدف (المالك: «انا اكيد ما ابيه يعدل على المجلس لزم … بس على هرمز اخاف يصير هرمز عقيم»، ثم
«ايه» على خطة الاختبار بهرمز الحقيقي): الكود كله للقراءة فقط، وHermes يعمل كما كان.

## القرار والموافقات
موافقة المالك في الجلسة (٢٠٢٦-٠٩-٢٣). التصميم:

- **الملكية لـ root.** حُذف `--chown=hub:hub` من كل `COPY` في مرحلة التشغيل، فصار `/app`
  و`/opt/hermes` ملك root، والمستخدم `hub` يقرأ ولا يكتب. و`chmod -R go-w /opt/hermes` في مرحلة
  Hermes لأن uv يترك ملفات `.lock` قابلة للكتابة للجميع.
- **مفتاح Hermes نفسه للصورة المقفلة.** `HERMES_DISABLE_LAZY_INSTALLS=1` مع
  `HERMES_LAZY_INSTALL_TARGET=/data/hermes-packages`، وهو نفس الزوج الذي يضعه Dockerfile الرسمي
  لـ Hermes عند الوسم المثبّت (`v2026.9.14`، قُرئ من المصدر MIT). الحزم الاختيارية تذهب إلى
  البيانات، تُلحق بآخر `sys.path` فتضيف وحدات ولا تستبدل وحدة أساسية، وتبقى بعد إعادة إنشاء الحاوية
  (وختم ABI يمسحها لو تغيّر المفسّر في صورة لاحقة). المجلد خارج `HERMES_HOME` عمدًا كي لا يدخل
  في تصدير البروفايل.
- **pip داخل venv وقت البناء.** لا يوجد uv في صورة التشغيل، فيثبّت Hermes بـ
  `python -m pip install --target`. في venv مقفل لا يستطيع `ensurepip` إضافة pip، فالتثبيت فشل في
  أول تجربة؛ الآن `ensurepip` يجري وقت البناء. البديل (نسخ uv إلى الصورة) أكبر حجمًا.
- **ملفات بايثون المجمّعة وقت البناء.** مع `PYTHONDONTWRITEBYTECODE=1` والكود للقراءة فقط لا يكتب
  بايثون `__pycache__`. قياس على الصورة الحالية: أمر `hermes` بلا ملفات مجمّعة ~٦٠٠ مللي ثانية،
  ومعها ~٢٠٠. لذلك `compileall --invalidation-mode unchecked-hash` في مرحلة Hermes (المصادر لا
  تتغيّر داخل الصورة).
- **ما لا يتغيّر:** بيانات Hermes (الذاكرة، الإعدادات، المفاتيح، البروفايلات) تبقى قابلة للكتابة
  لأن الوكيل يحتاجها. حمايتها بالموافقات على الأدوات، لا بهذا التغيير.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/Dockerfile`: pip وbytecode و`go-w` في مرحلة Hermes؛ لا `--chown` في مرحلة
  التشغيل؛ `PYTHONDONTWRITEBYTECODE` و`HERMES_DISABLE_LAZY_INSTALLS` و`HERMES_LAZY_INSTALL_TARGET`.
- `scripts/image-sealed-check.mjs` (جديد) و`pnpm image:sealed-check`: يشغّل الصورة ويتحقق أن لا
  شيء تحت `/app` و`/opt/hermes` قابل للكتابة للمستخدم `hub`، وأن تعديل `server.py` و`main.js`
  يُرفض، وأن `hermes` يعمل وينشئ بروفايلًا في `/data`، وأن ميزة اختيارية (`tts.edge`) تُثبَّت في
  `/data/hermes-packages`، وأن `docker diff` لا يُظهر أي تغيير تحت `/app` و`/opt/hermes`، وأن
  الحزمة تبقى في حاوية جديدة على نفس البيانات.
- `.github/workflows/ci.yml`: خطوة الفحص أعلاه في مهمة Docker (اسم المهمة لم يتغيّر: فحص مطلوب
  على `main`).
- `docs/DEPLOY.md`: جدول «أين تعيش الأشياء» يذكر `/data/hermes-packages` و`/data/workspaces` وأن
  الباقي للقراءة فقط.
- **الحجم:** الصورة كاملة مضغوطة (`docker save | gzip -1`) ~٢٤٦ ميغابايت مقابل ~٢١٠ للحالية؛ الفرق
  ملفات بايثون المجمّعة وpip. ضمن حد المالك (١٠٠–٣٠٠).
- **على الستاكات القائمة:** تحديث الصورة وإعادة إنشاء الحاوية يكفي؛ لا تغيير في compose ولا في
  الحجم `/data`. يُمسح تلقائيًا تعديل `server.py` والحزم التي كانت داخل الحاوية، ويعيد Hermes تثبيت
  ما يحتاجه في `/data/hermes-packages` عند أول استخدام.

## الفحوص (الأوامر ونواتجها الفعلية)
- `docker build -f packages/server/Dockerfile -t majlis:sealed .` ← نجح.
- `node scripts/image-sealed-check.mjs majlis:sealed` ← `image:sealed-check  OK` (٩ من ٩).
  التشغيل الأول قبل إضافة pip و`go-w` فشل في ثلاثة (ملفات `.lock` قابلة للكتابة، و«pip not
  available and ensurepip failed»)، وهذا ما أدّى إلى الإصلاحين.
- `MAJLIS_HERMES_IMAGE=majlis:sealed pnpm --filter @majlis/server exec vitest run
  src/modules/agents/adapters/hermes-tui.real.test.ts src/modules/agents/hermes-profiles.real.test.ts`
  ← `Tests 5 passed (5)`: محادثة Hermes الحقيقية، والأسئلة التوضيحية المفردة والمجمّعة، وإنشاء
  البروفايل ونسخه، كلها على الصورة المقفلة.
- ناتج الأوامر كما ظهر:

```
$ node scripts/image-sealed-check.mjs majlis:sealed
ok    the hub answers /api/v1/health
ok    nothing under /app or /opt/hermes is writable by the hub
ok    Hermes's own code cannot be edited
ok    the hub's own code cannot be edited
ok    hermes runs — Hermes Agent v0.21.3 (2026.9.14)
ok    hermes writes a profile to its home in /data
ok    an optional package Hermes needs lands in /data/hermes-packages — /data/hermes-packages/edge_tts/__init__.py
ok    the container changed nothing under /app or /opt/hermes
ok    the package survives the container being recreated — /data/hermes-packages/edge_tts/__init__.py

image:sealed-check  OK

$ MAJLIS_HERMES_IMAGE=majlis:sealed pnpm --filter @majlis/server exec vitest run \
    src/modules/agents/adapters/hermes-tui.real.test.ts src/modules/agents/hermes-profiles.real.test.ts
      Tests  5 passed (5)

$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck        # exit 0
$ pnpm graph:check
graph:check  OK — 6294 nodes, 14991 edges, current
```

## المخاطر والرجوع
- ميزة في Hermes تكتب داخل مجلد كوده ولم تظهر في الفحص ستفشل. ما رأيناه في `docker diff` الحقيقي
  (bytecode وحزم اختيارية) مغطّى؛ ونسخة الاختبار تكشف الباقي قبل `latest`.
- لا يستطيع الوكيل بعد الآن «إصلاح» Hermes أو المركز من الداخل؛ هذا هو المقصود.
- طلبات المركز القصيرة التي لا تخص محادثة (تسمية محادثة، مثلًا) تعمل في `/app` ولا تكتب ملفات؛
  لو احتاج أحدها الكتابة سيفشل. كل محادثة لها مجلد عمل تحت `/data/workspaces`.
- الرجوع: استرجاع هذا الـ commit (إعادة `--chown=hub:hub` وحذف المتغيّرات الثلاثة). الحزم في
  `/data/hermes-packages` لا تضر لو بقيت.

## التسليم والخطوة التالية
PR إلى `main` للمراجعة. بعد الدمج وبطلب المالك: صورة اختبار، ثم على ستاك الاختبار محادثة فيها
أدوات، وصوت Edge، وإنشاء بروفايل، و`docker diff majlis | grep -E "opt/hermes|/app"` يجب أن يكون
فارغًا.
