# دعم Hermes v0.21.6 ونقل تثبيت الصورة إليه (لإصدار كور هب 1.1.8)
المسؤول: twuijri · الفرع: feat/hermes-0-21-6 · الحالة: review

## المشكلة والهدف
صدر Hermes Agent v0.21.6 في 2026-10-08: إصدار تجميعي لنحو 2,100 طلب دمج منذ v0.21.5، وأول وسم باسم
النسخة نفسها (`v0.21.6`) بدل التاريخ. فشلت مراقبة Hermes (التشغيل 37847671951، المشكلة #242) في بناء
الصورة به: خطوة عملاء القنوات تستورد `LAZY_DEPS` من `tools/lazy_deps.py` ولم يعد موجودًا.

الهدف: أن تحمل صورة كور هب 1.1.8 Hermes v0.21.6 وتمر عليه كل مجموعات Hermes الحقيقي
(`*.real.test.ts`)، مع بقاء الحد الأدنى v2026.9.14 (`0.21.3`) ناجحًا كما هو، وكل إصلاح واعٍ بالنسخة.

## القرار والموافقات
ما وجدته في مصدر Hermes (MIT، v0.21.6 مقابل v2026.9.24) وفي الصورة المبنية، وما فعلته لكلٍّ منه،
والتفاصيل في `docs/contracts/DECISIONS.md` §154 (أول رقم متاح؛ طلب الدمج المفتوح الوحيد #241 لا يمس
DECISIONS):

1. **Python 3.14 فقط**: اعتماديات Hermes الأساسية معلّنة لـ`python_version >= '3.14'`، فعلى 3.12 تُثبَّت
   بلا اعتماديات أصلًا (هذا ما أخفاه خطأ `LAZY_DEPS`). مدير حزم Hermes (`pm/lock.json`) يثبّت CPython
   3.14.7 بالضبط و uv 0.12.3. ← الصورة تقرأ Python من نسخة Hermes نفسها
   (`scripts/hermes-image/python-version.mjs`: 3.12 لما قبل `pm/`، وإلا الإصدار المثبّت بالضبط)، و
   `UV_VERSION` صار 0.12.3. والدقة مهمة: SQLite في 3.14.4 فيها خلل WAL فيترك Hermes وضع WAL، وفي 3.14.7
   لا.
2. **`tools/lazy_deps.py` أُلغي**: الميزة الاختيارية صارت «extra» في `pyproject.toml` يثبّتها مدير الحزم،
   ويرفض ذلك في صورة مختومة. ← عملاء تيليجرام وديسكورد وسلاك من `LAZY_DEPS` قديمًا ومن extra
   `messaging` (ما تخبزه صورة Hermes الرسمية) جديدًا (`prepare.py`). ومخزن الحزم الاختيارية
   `/data/hermes-packages` الذي اختفى مع الملف يبقيه للصورة كودٌ صغير لنا
   (`corehub_hermes_packages.py` عبر ملف `.pth`): يضيف المخزن آخر `sys.path` إن مُلئ لهذا المفسّر،
   وحين يرفض مدير الحزم extra يثبّت متطلباته من `pyproject.toml` هناك بـ`pip --target` وإصدارات الـvenv
   قيودًا، ما لم يقل `security.allow_lazy_installs: false`. رفضتُ ترك مدير الحزم يثبّت: يبني بيئة كاملة
   (~700 MB) مفتاحها مسار الكود، والصورة التالية تحمل المسار نفسه فتقلع على حزم القديمة.
3. **Node من مدير الحزم فقط** (Node 26.7.0 و npm 12): خادم MCP بأمر `npx`/`node` وجسر واتساب لا يستعملان
   Node الموجود في PATH أبدًا. ← تُجهَّز Node و npm وقت البناء كما تفعل صورة Hermes الرسمية
   (`prepare.py pm-tools`) في تخطيط Hermes المختوم: `/opt/hermes/pm-tools/store` للقراءة فقط
   (`HERMES_RUNTIME_DIR`) وبجانبه `manifest.json`، فكل ما يكتبه مدير الحزم (أقفاله، بيئة إضافة) يذهب
   إلى `tools/` في بيت Hermes. بلا ترويسات C ولا وثائق Node، و`libatomic1` لـNode. ffmpeg الخاص
   بـHermes (126 MB، والصورة لم تحمله قط) و ripgrep الخاص به (تجهيزه يجرّ CPython ثانيًا بـ390 MB،
   والصورة تبقي ripgrep من Debian) لم يُجهَّزا، فيطبع كل أمر `hermes` سطر
   «⚠ install out of sync (ffmpeg: …; ripgrep: …)»، وصار المركز يتجاهله حين يقرأ سبب رفض Hermes
   (`lastLine`). وإن جرّت نسخة قادمة شيئًا آخر إلى المخزن يفشل البناء بدل أن تكبر الصورة بصمت.
4. **الأسرار من نطاق البروفايل**: المتغير يُقرأ من `.env` البروفايل ومصادر أسراره و`.env` المُدار
   (`HERMES_MANAGED_DIR`)، ولا يُقرأ من بيئة العملية تحت المضاعِف أو لبروفايل تخدمه العملية وليس لها.
   فصار `${COREHUB_MCP_ORIGIN}` في ترويسة كتلة `corehub` (§79) غير محلول ← Hermes **يرفض** خادم MCP
   كله (أدوات المركز معطلة)، و`API_SERVER_KEY` للبوابة الجذرية من بيئتها لا يصل ← خادم API لا يفتح
   (البوابة «لا تعمل»). ← لكل عملية Hermes يشغّلها المركز نطاق مُدار خاص بها
   (`hermes-managed-env.ts`): `HERMES_MANAGED_DIR=<data>/hermes-managed/<role>` فيه `.env` بـ
   `COREHUB_MCP_ORIGIN` (`gateway` للبوابات، `hub` لعملية TUI، و`dashboard` لـ`hermes serve` التي صارت
   اختبارات MCP فيها تحتاجه — والمركز يقرأ هذه القيمة «مصدرًا مجهولًا» كما كان النص الحرفي قبلًا)، و
   `API_SERVER_KEY` للبوابة الجذرية فقط. القيم نفسها تبقى في بيئة العملية لنسخ Hermes الأقدم. ونطاق
   مدير النظام إن وُجد (`HERMES_MANAGED_DIR` الموروث، وإلا `/etc/hermes`) يُنسخ أولًا فيبقى ساريًا.
5. **عزل الإضافات** (`plugins.isolation: host`، الافتراضي داخل العملية): الخطافات و`ctx.inject_message`
   تعمل من عملية المضيف، ومدير الإضافات لا. ← إضافة `corehub-bridge` (§153) في المضيف: نسخة البيت
   الجذري (`hub.json` يقول `default`، وهي صاحبة الحاقن في بوابة واحدة لكل مضيف) تستطلع، وغيرها لا يفعل
   شيئًا. ومجموعة القنوات في الاتجاهين تعمل الآن مرتين على v0.21.6: داخل العملية وفي المضيف.
6. **الإصدار**: `pyproject.toml` يقول `0.0.0`، و`hermes --version` بلا `.git` يطبع
   `vunknown (2026.9.24)` فيقرأ المركز التاريخ نسخةً. ← الصورة تكتب ختم التثبيت الذي يكتبه مغلّفو Hermes
   (`scripts/write_install_stamp.py`، `external`؛ وبلا `--distribution docker` لأن مدير الحزم عندها يطلب
   بيئة تشغيل له مغلّفة بجانب الكود فتفشل كل عملياته — جرّبته) حين يكون الوسم `vX.Y.Z`، والمركز لا يقرأ
   نسخة من Hermes لا يعرف إصداره (`vunknown`، `vgit.<sha>`) بدل قراءة التاريخ. ومراقبة Hermes تقرأ
   وسم `vX.Y.Z` نسخةً إن لم يذكرها اسم الإصدار.
7. **تغييرات أصغر تمسّ الاختبارات فقط** (المركز يمرّرها كما هي): `clarify` يقبل `questions` فقط؛
   `image_generate` يحفظ في `cache/generated/images/`؛ معرّف ذكرى في Journey يُختم بتجزئة نصها.
   الاختبارات صارت تقبل الشكلين.

- نقل التثبيت بالسكربت: `node scripts/hermes-watch.mjs bump --ref v0.21.6 --version 0.21.6`.
- لا كسر (ADR 0027): لا عملية ولا حدث ولا ترحيل ولا تغيير في Compose؛ الترقية استبدال الصورة.
- **قرار مطلوب من المالك — حجم الصورة**: 386.2 MB مضغوطة بدل 321.1 (+65 MB). Node الخاص بـHermes وحده نحو 52 MB
  مضغوطة (والصورة كانت أصلًا فوق حد 300 MB). بدونه لا يعمل جسر واتساب ولا خوادم MCP بـ`npx` على
  v0.21.6؛ البديل الوحيد الذي وجدته تنزيل بيئة مدير الحزم كاملة إلى `/data` (~450 MB) عند أول حاجة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/Dockerfile` — مرحلة Hermes واعية بالنسخة: Python من النسخة، uv 0.12.3، الختم،
  عملاء القنوات، المخزن المختوم لأدوات مدير الحزم، كود المخزن الاختياري، تعميم تقليم CPython؛ وفي
  وقت التشغيل `libatomic1` و`HERMES_RUNTIME_DIR`. `HERMES_REF=v0.21.6` (بالسكربت).
- `scripts/hermes-image/` (جديد): `python-version.mjs`، `prepare.py` (`stamp`، `channel-specs`،
  `channel-check`، `lazy-target`، `pm-tools`)، `corehub_hermes_packages.py`. `scripts/hermes-image.test.mjs`.
- `packages/server/src/modules/agents/catalog/hermes-versions.ts` — `HERMES_TESTED` = v0.21.6 (بالسكربت).
- `packages/server/src/modules/agents/hermes-managed-env.ts` (+ اختبار) — النطاق المُدار لكل عملية؛
  `hermes-runtime.ts` (البوابة الجذرية، بوابات البروفايلات، TUI)، `hermes-dashboard.ts`.
- `packages/server/src/modules/agents/channel-bridge/plugin.ts` — الإضافة في مضيف الإضافات.
- `packages/server/src/modules/agents/adapters/host.ts` (+ `hermes-version.test.ts`) — لا نسخة من
  `vunknown`؛ `hermes-profiles.ts` (+ اختبار) — تجاهل سطر مدير الحزم.
- `scripts/hermes-watch.mjs` (+ اختبار) — وسم `vX.Y.Z`.
- `.github/workflows/ci.yml` و`hermes-real-suites.yml` — venv المصدر على Python النسخة.
- `scripts/image-sealed-check.mjs` — واعٍ بالنسخة، وفحصان جديدان (Node الخاص بـHermes في الصورة،
  واستيرادات جسر واتساب به).
- اختبارات Hermes الحقيقي: `channel-sends` (مرتان على v0.21.6)، `hub-tools`، `gateways`، `hermes-tui`،
  `hermes-images`، `hermes-journey`، `tests/unit/hermes-real.ts`؛ و`hermes-releases.routes.test.ts`
  نسبةً إلى `HERMES_TESTED`.
- تعليقات: `hermes-journey.ts`، `hermes-tui.ts`، `channel-platforms.ts`. الوثائق: DECISIONS §154،
  `docs/STATUS.md`، `docs/DEPLOY.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
كل الصور مبنية محليًا من `packages/server/Dockerfile` هذا الفرع (المبني القديم، بلا buildx)، وvenv المصدر
كما في CI (`HERMES_SRC`، Python من `python-version.mjs`).

```
$ docker build -f packages/server/Dockerfile --build-arg HERMES_REF=v0.21.6 -t core-hub:hermes-0216 .
Hermes v0.21.6 runs on Python 3.14.7
[write_install_stamp] wrote /opt/hermes/src/install-stamp.json -> 818c13be1dc4
Hermes Agent v0.21.6 (2026.9.24) · upstream 818c13be
channels installed: platform.telegram platform.discord platform.slack
lazy-target: installed into /opt/hermes/.venv/lib/python3.14/site-packages
pm-tools: Node 26.7.0 and npm staged, sealed, in /opt/hermes/pm-tools/store
Successfully tagged core-hub:hermes-0216

$ docker build -f packages/server/Dockerfile --build-arg HERMES_REF=v2026.9.14 -t core-hub:hermes-floor .
Hermes v2026.9.14 runs on Python 3.12
stamp: pyproject says 0.21.3; nothing to write
channels installed: platform.telegram platform.discord platform.slack
lazy-target: this Hermes keeps its own durable store; nothing to install
pm-tools: this Hermes runs the Node on PATH; nothing to stage
Hermes Agent v0.21.3 (2026.9.14)

# أول تشغيل على v0.21.6 قبل الإصلاحات (الصورة بُنيت بإصلاح البناء وحده):
 Test Files  7 failed | 26 passed | 4 skipped (37)
      Tests  11 failed | 81 passed | 47 skipped (139)
# hub-tools ×2 (${COREHUB_MCP_ORIGIN} غير محلول)، agent-tools و mcp-tool-filter ×3 (Node مدير الحزم)،
# gateways (خادم API لا يفتح تحت المضاعِف)، hermes-tui (clarify)، hermes-images ×2، hermes-journey.

$ COREHUB_HERMES_IMAGE=core-hub:hermes-0216 HERMES_SRC=… vitest run --project unit --maxWorkers=2 $(find src tests -name '*.real.test.ts')
 Test Files  33 passed | 4 skipped (37)
      Tests  97 passed | 47 skipped (144)
# منها channel-sends.real.test.ts: 10 (الخمسة داخل العملية + الخمسة بـplugins.isolation: host)

$ COREHUB_HERMES_IMAGE=core-hub:hermes-floor HERMES_SRC=… (نفس الأمر)
 Test Files  33 passed | 4 skipped (37)
      Tests  92 passed | 52 skipped (144)
# الخمسة الإضافية المتخطاة: حالة plugins.isolation: host (غير موجودة في 0.21.3)
# الملفات الأربعة المتخطاة على الصورتين: model-gateway و gateway-stream و subscriptions و acp-bridges
# (تحتاج COREHUB_REAL_GATEWAY، وتعمل في وظيفة model-gateway-real في CI لا في hermes-real)

$ COREHUB_REAL_WHATSAPP=1 vitest run … agent-tools.real.test.ts -t "WhatsApp pairing"   (الشبكة الحقيقية)
core-hub:hermes-0216:  Tests  1 passed | 3 skipped (4)
core-hub:hermes-floor: Tests  1 passed | 3 skipped (4)

$ node scripts/image-sealed-check.mjs core-hub:hermes-0216
ok    hermes runs — Hermes Agent v0.21.6 (2026.9.24) · upstream 818c13be
ok    an optional package Hermes needs lands in /data/hermes-packages — /data/hermes-packages/edge_tts/__init__.py
ok    Hermes's Telegram client is in the image (no network, nothing installed) — /opt/hermes/.venv/lib/python3.14/site-packages/telegram/__init__.py
ok    the Node Hermes insists on is in the image (no network, nothing installed) — /opt/hermes/pm-tools/store/node-26.7.0-linux-x64/bin/node /opt/hermes/pm-tools/store/npm-12.0.2-linux-x64/bin/npx v26.7.0
ok    the bridge's imports load with the Node Hermes starts it with — function
ok    the container changed nothing under /app or /opt/hermes
ok    the package survives the container being recreated — /data/hermes-packages/edge_tts/__init__.py
image:sealed-check  OK          (22 فحصًا)

$ node scripts/image-sealed-check.mjs core-hub:hermes-floor
image:sealed-check  OK

$ docker save <image> | gzip -1 | wc -c
core-hub:twoway-pinned (v2026.9.24، فرع two-way قبل الدمج)   321,149,408  (321.1 MB)
core-hub:hermes-floor (هذا الفرع، v2026.9.14)                321,903,327  (321.9 MB)
core-hub:hermes-0216 (هذا الفرع، v0.21.6)                    386,154,343  (386.2 MB)
# الفرق +65 MB: نحو 52 MB لـNode 26 و npm الخاصين بـHermes، والباقي اعتماديات Hermes على 3.14.

$ pnpm typecheck                                   → exit 0
$ pnpm contracts:check-clients                     → check-clients  OK — 1174 client file(s) scanned, 277 contract path(s) known.
$ pnpm scripts:test                                → tests 123, pass 123, fail 0
$ vitest run --project unit --maxWorkers=2 src/modules/agents src/modules/sessions
 Test Files  98 passed | 25 skipped (123)
      Tests  1066 passed | 100 skipped (1166)
$ node scripts/hermes-watch.mjs current
{"floor":{"ref":"v2026.9.14","version":"0.21.3"},"tested":{"ref":"v0.21.6","version":"0.21.6"},"dockerfileRef":"v0.21.6"}
$ npx prettier --check <changed files> && npx eslint <changed ts/mjs>   → clean
```
نتائج CI تُضاف بعد التشغيل على طلب الدمج.

## المخاطر والرجوع
- يعتمد كود الصورة على أسماء في Hermes ليست عقدًا معلنًا: `pm.extras.ensure_import`/`available`،
  `pm.install.ensure`، تخطيط المخزن المختوم، `HERMES_MANAGED_DIR`. فحص الختم ومجموعات Hermes الحقيقي
  تكشف أي تغيّر فيها عند المراقبة التالية؛ والحد الأدنى لا يمرّ بأي منها.
- سطر «⚠ install out of sync (ffmpeg…; ripgrep…)» يظهر في سجلات Hermes مع كل أمر: معلومة لا خطأ.
- بيئة TUI والبوابة صار فيها Node 26 الخاص بـHermes أولًا في PATH (Hermes يفعل ذلك بنفسه)، فأوامر
  الوكيل في الطرفية ترى Node 26 بدل 24.
- حزم اختيارية ثُبّتت لـPython 3.12 في `/data/hermes-packages` تُحذف وتُثبَّت من جديد عند أول حاجة
  (تحتاج الشبكة مرة).
- الرجوع: revert للالتزامات يعيد الصورة إلى v2026.9.24 كما كانت؛ `/data/hermes-managed/` يبقى بلا أثر.

## التسليم والخطوة التالية
- PR إلى `main` بالإنجليزية يغلق #242. لا دمج، لا دمج تلقائي، لا لمس لـ`test`، لا نشر صور، ولا لمس
  لـ#241.
- المالك: قرار حجم الصورة أعلاه، ثم الدمج قبل إصدار 1.1.8.
