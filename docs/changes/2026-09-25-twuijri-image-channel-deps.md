# الصورة تحمل اعتماديات قناتي تيليجرام وواتساب
المسؤول: twuijri · الفرع: feat/image-channel-deps · الحالة: review

## المشكلة والهدف
القناتان اللتان يربطهما الهب بنفسه كانتا تنزّلان اعتمادياتهما عند أول استعمال:
- **تيليجرام:** يثبّت Hermes مكتبة `python-telegram-bot[webhooks]==22.8` أول مرة (جدول
  `tools/lazy_deps.py`، المفتاح `platform.telegram`) في `/data/hermes-packages`، وهذا يحتاج PyPI.
- **واتساب:** جسر Hermes (`scripts/whatsapp-bridge`، Node وBaileys) يشغّل `npm install` عند أول
  ربط: 71 MB مثبّتة. ولأن الصورة مختومة (`/opt/hermes` للقراءة فقط) ينسخ Hermes الجسر إلى
  `<بيت البروفايل>/scripts/whatsapp-bridge` ويثبّت هناك، مرة لكل بروفايل.

الهدف: أن يكون ربط أيٍّ منهما بلا تنزيل، وبلا 71 MB في كل بروفايل.

## القرار والموافقات
موافقة المالك (٢٠٢٦-٠٩-٢٥): «انا مع اقتراحك تكون مع الامج». الحجم داخل قاعدته (100–300 MB مضغوطة).

1. **تيليجرام في الصورة:** مرحلة Hermes في `Dockerfile` تقرأ مواصفة `platform.telegram` من
   `LAZY_DEPS` نفسه وقت البناء (فلا ينحرف التثبيت عن تثبيت Hermes)، وتثبّتها في venv الخاص به
   مقيّدة بإصدارات الحزم الأساسية الحالية (القاعدة نفسها التي يطبّقها Hermes على التثبيت الكسول؛ أي
   تعارض يُسقط البناء). آخر سطر يسأل سؤال Hermes نفسه: `lazy_deps.is_available('platform.telegram')`،
   وهو ما تسأله `ensure()` قبل أي تثبيت. يُترجم bytecode ويبقى `go-w` وملكية root كما كانا.
2. **واتساب في الصورة:** `npm ci --omit=dev` في `/opt/hermes/src/scripts/whatsapp-bridge`، ثم ختم
   `node_modules/.hermes-pkg-hash` بدالة Hermes نفسها (`_file_content_hash`)، وهو ما يقارنه محوّل
   واتساب قبل أن يثبّت من جديد.
3. **نسخة الجسر في كل بيت (`modules/agents/whatsapp-bridge.ts`):** قبل أن يبدأ Hermes الجسر يجهّز
   الهب `<البيت>/scripts/whatsapp-bridge`: ملفات الجسر نفسها منسوخة (~220 KB)، و`node_modules`
   رابط رمزي إلى نسخة الصورة. Hermes يجد النسخة فيستعملها، ويقرأ الختم عبر الرابط فلا يثبّت شيئًا.
   يُستدعى في ثلاثة مواضع:
   - مشرف بوابات البروفايلات (#93) قبل بدء بوابة بروفايل فيه واتساب (`prepareHome`)؛
   - قبل البوابة الافتراضية إن كان واتساب مفعّلًا في البيت الجذري؛
   - **قبل تشغيل واجهة Hermes (dashboard)**: قِسْتُ أن شاشة الربط بالـQR تشغّل الجسر من البيت
     **الجذري** أيًّا كان البروفايل (خيط بايثون لا يرث سياق البروفايل). بدون هذا كان Hermes سينسخ
     الـ71 MB كاملة إلى `/data/hermes/scripts/whatsapp-bridge` لأن مجلد الصورة صار فيه `node_modules`
     (رأيته فعلًا في تجربة قبل الإصلاح).
   - تُعاد النسخة كلما اختلف ملف من ملفات جسر الصورة (Hermes جديد في صورة جديدة)، بتبديل ذرّي
     (مجلد جديد بجانب القديم ثم rename).
4. **البروفايلات القائمة** التي ثبّت فيها Hermes `node_modules` حقيقيًا من قبل: **تُترك كما هي** ما دام
   Hermes سيستعملها دون تثبيت (ملفات الجسر مطابقة وختمها مطابق لختم الصورة)، لأنها تعمل ولا داعي
   لحذف شيء يعمل تحت جسر قد يكون شغّالًا. وحين يتغيّر جسر الصورة، أو لا يطابق ختمها، تُستبدل
   بالرابط. — مقترح، للمالك أن يؤكد.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/Dockerfile` — خطوتا تيليجرام وواتساب في مرحلة Hermes، وتعليق الرأس.
- `packages/server/src/modules/agents/whatsapp-bridge.ts` (+ `.test.ts`) — المساعد الجديد.
- `packages/server/src/modules/agents/hermes-gateways.ts` — `prepareHome` يجهّز الجسر لبروفايل فيه واتساب؛ خيار `whatsappBridge`.
- `packages/server/src/modules/agents/hermes-runtime.ts` — `prepareWhatsAppBridge()` للبيت الجذري قبل البوابة الافتراضية؛ يمرّر الخيار.
- `packages/server/src/modules/agents/hermes-dashboard.ts` — يستدعي `host.prepareWhatsAppBridge?.()` قبل تشغيل `hermes serve`.
- اختبارات: `hermes-gateways.test.ts`، `hermes-dashboard.test.ts`.
- `scripts/image-sealed-check.mjs` — أربعة فحوص جديدة.
- `docs/DEPLOY.md`، `docs/STATUS.md`.

**الحجم (مضغوطًا، `docker save … | gzip -1 | wc -c`):**

| الصورة | بايت | MB |
|---|---|---|
| قبل (`main` عند fd9da31) | 259,186,516 | 259.2 |
| بعد (هذا الفرع) | 284,253,952 | 284.3 |
| الفرق | +25,067,436 | +25.1 |

داخل الصورة: `node_modules` للجسر 71 MB غير مضغوطة (منها 36 MB لـ`@img`، مكتبة libvips التي يجلبها
`sharp` للصور المصغّرة؛ كان `npm install` سيجلبها أيضًا)، و`telegram` 7.6 MB و`tornado` 4.1 MB.
الحجم «قبل» بُني من main قبل دمج #99 (إعادة التسمية)، وفرقها تسميات وlabels فقط.

## الفحوص (الأوامر ونواتجها الفعلية)
اختبارات الوحدة للملفات التي أضفتها أو غيّرتها:
```
$ pnpm exec vitest run --project unit src/modules/agents/whatsapp-bridge.test.ts src/modules/agents/hermes-gateways.test.ts src/modules/agents/hermes-dashboard.test.ts
 Test Files  3 passed (3)
      Tests  50 passed (50)
```
الاختبارات الثلاثة الجديدة في ملفي البوابات والواجهة تفشل على الكود القديم (أعدت الملفات الثلاثة إلى main وشغّلتها):
```
     × gives a WhatsApp profile its copy of the bridge on the image's dependencies before it starts
     × gives the root home its bridge copy before the default gateway serves WhatsApp
     × readies the root home's WhatsApp bridge before Hermes starts (its pairing runs there)
      Tests  3 failed | 40 passed (43)
```
اختبار `whatsapp-bridge.test.ts` يشغّل Node فعليًا من نسخة البيت ويستورد حزمة ESM عبر الرابط، ومنها
حزمة تعتمد عليها موجودة فقط بجانبها في «الصورة».

`pnpm lint` و`pnpm typecheck`:
```
$ eslint . && prettier --check .
All matched files use Prettier code style!
$ pnpm typecheck   → exit 0, 0 × "error TS"
```

فحص الصورة المختومة على صورة هذا الفرع (`core-hub:channeldeps`):
```
ok    the hub answers /api/v1/health
ok    nothing under /app or /opt/hermes is writable by the hub
ok    Hermes's own code cannot be edited
ok    the hub's own code cannot be edited
ok    hermes runs — Hermes Agent v0.21.3 (2026.9.14)
ok    hermes writes a profile to its home in /data
ok    an optional package Hermes needs lands in /data/hermes-packages — /data/hermes-packages/edge_tts/__init__.py
ok    Hermes's Telegram client is in the image (no network, nothing installed) — /opt/hermes/.venv/lib/python3.12/site-packages/telegram/__init__.py
ok    a profile's WhatsApp bridge is prepared — created
ok    its node_modules is a link to the image's, not a copy — /opt/hermes/src/scripts/whatsapp-bridge/node_modules, 220 KB, stamp fabad4f584362fa4
ok    the bridge resolves Baileys and its imports through the link — function
ok    Hermes's dashboard API starts in the sealed image — ready in 871 ms, 125 MiB resident
ok    it refuses a call without the token (401) — 401
ok    it answers /api/plugins/kanban/board with the token (200) — 200
ok    the container changed nothing under /app or /opt/hermes
ok    the package survives the container being recreated — /data/hermes-packages/edge_tts/__init__.py

image:sealed-check  OK
```
والفحوص الجديدة نفسها على صورة main (قبل) تفشل:
```
FAIL  Hermes's Telegram client is in the image (no network, nothing installed) — import failed
FAIL  a profile's WhatsApp bridge is prepared
FAIL  its node_modules is a link to the image's, not a copy — no bridge
FAIL  the bridge resolves Baileys and its imports through the link — import failed
```

**Hermes حقيقي بلا شبكة (`docker run --network none`)**: بروفايل `tg` فيه تيليجرام بتوكن وهمي، وبروفايل
`wa` فيه واتساب مفعّل بجلسة وهمية. الهب شغّل بوابة لكلٍّ منهما؛ محوّل تيليجرام وصل إلى «Connecting to
Telegram» (أي أن الاستيراد و`ensure()` مرّا بلا تثبيت) وجسر واتساب بدأ بلا npm:
```
"profile":"wa","bridge":"created","msg":"hermes: WhatsApp bridge prepared for a profile"
"profile":"wa","pid":21,"channels":["whatsapp"],"msg":"hermes: messaging gateway started for a profile"
"profile":"tg", ... "[Telegram] Connecting to Telegram (attempt 1/8)…"
"profile":"wa", ... "[Whatsapp] Bridge HTTP ready, waiting for WhatsApp connection..."
$ docker logs … | grep -ciE "lazy-install|Installing WhatsApp bridge|npm install|pip install|FeatureUnavailable"
0
$ ls -la /data/hermes/profiles/wa/scripts/whatsapp-bridge | grep node_modules
lrwxrwxrwx 1 hub hub 52 … node_modules -> /opt/hermes/src/scripts/whatsapp-bridge/node_modules
$ du -sk /data/hermes/profiles/wa/scripts/whatsapp-bridge
220
```
`/data/hermes-packages` بقي فارغًا، ولا تغيير تحت `/app` أو `/opt/hermes` في `docker diff`.

**شاشة الربط بالـQR عبر API ‏Hermes، بلا شبكة:** قبل الإصلاح نسخ Hermes الجسر مع `node_modules`
(71 MB، ملك `hub`) إلى `/data/hermes/scripts/whatsapp-bridge` مع أن البروفايل المطلوب `pp`. بعد تجهيز
البيت الجذري بالمساعد: `start 200` ثم `status: waiting` (الجسر بدأ ويستورد كل شيء)، والنسخة 220 KB
برابط `node_modules`.

CI: يُلحق بعد الدفع.

## المخاطر والرجوع
- **الحجم** +25.1 MB مضغوطة (284.3 MB، داخل 100–300).
- **بروفايل ربط واتساب سابقًا** يبقى على تثبيته إلى أن يتغيّر جسر الصورة (انظر القرار ٤).
- `npm ci` لا يشغّل سكربتَي التثبيت في npm 11 (`baileys` preinstall يفحص إصدار Node، و`protobufjs`
  postinstall)؛ الاستيراد الكامل للجسر ينجح في البناء وفي الفحص وفي Hermes الحقيقي.
- `hermes whatsapp` من طرفية داخل الحاوية (ليس مسار الهب) في بيت لم يجهّزه الهب سينسخ الجسر كاملًا كما
  يفعل Hermes؛ يعمل، لكنه بالحجم الكامل.
- **الرجوع:** revert للالتزامات. في صورة قديمة يصير رابط `node_modules` في البيوت رابطًا مكسورًا؛ Hermes
  يراه غير موجود فيشغّل `npm install` كما كان (المسار القديم، يحتاج الشبكة). جرّبته على صورة main:
  `npm install` فوق رابط مكسور أنهى بـ`exit 0` واستبدله بمجلد حقيقي فيه 118 حزمة. لا ترحيل بيانات.

## التسليم والخطوة التالية
طلب دمج إلى `main` للمراجعة. لا صورة منشورة ولا فرع `test` من هذه المهمة.
