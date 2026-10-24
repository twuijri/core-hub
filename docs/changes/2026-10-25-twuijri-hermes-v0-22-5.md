# نقل صورة المركز إلى هرمز v0.22.5 (0.22.5)
المسؤول: twuijri · الفرع: fix/hermes-v0-22-5 · الحالة: review

## المشكلة والهدف
صدر هرمز v0.22.5 والصورة على v0.22.2. مراقب هرمز فتح #256 «غير مدعوم بعد»: الصورة ما انبنت أصلًا، فما اشتغل أي اختبار حقيقي. السبب في سجل التشغيل https://github.com/twuijri/core-hub/actions/runs/40080650002:
```
error: No download found for request: cpython-3.14.9-linux-x86_64-gnu
```
هرمز v0.22.5 يثبّت في `pm/lock.json` بايثون 3.14.9 و uv 0.13.5، وصورتنا على uv 0.12.3 اللي ما تعرف 3.14.9.
المالك (٢٠٢٦-١٠-٢٥): «اشتغل على v0.22.5، ننتظر لين نحل كل شي» — إصدار 1.1.9 (#258) ينتظر هذا.

## القرار والموافقات
- `ARG UV_VERSION` من 0.12.3 إلى 0.13.5 (نسخة هرمز نفسه). تعرف 3.14.9 و3.14.7 و3.12، فالحد الأدنى والإصدار الحالي ينبنون من نفس الملف كما هم. ويقرأها CI من نفس السطر (`ci.yml`، `hermes-real-suites.yml`).
- نقل `HERMES_REF` و`HERMES_TESTED` إلى v0.22.5 (`node scripts/hermes-watch.mjs bump --ref v0.22.5 --version 0.22.5`)؛ الحد الأدنى يبقى v2026.9.14 (`0.21.3`).
- بعد uv، وقف البناء عند قنوات الرسائل: `aiohttp==3.14.5 and aiohttp==3.14.3 ... unsatisfiable`. v0.22.5 يثبّت aiohttp 3.14.5 في إضافة `messaging`، وصورتنا كانت تثبّت 3.14.3 ثابتة مع النواة ثم تستعملها قيدًا للقنوات. صار رقم aiohttp يُقرأ من pyproject حق هرمز نفسه (`scripts/hermes-image/aiohttp-version.mjs`)، و3.14.3 إذا ما ثبّت هرمز شيئًا (الحد الأدنى وv0.22.2 كما هم)، في الصورة و`ci.yml` و`hermes-real-suites.yml`.
- بعد ما انبنت الصورة فشلت ثلاثة اختبارات حقيقية على v0.22.5 (تشغيل https://github.com/twuijri/core-hub/actions/runs/40137178157). كل واحد له سببه وإصلاحه، وكلها تبقى صحيحة على الإصدارات الأقدم:
  1. **الكتابة في محادثة قناة لملف شخصي مسمّى من الهب** (`channel-sends.real.test.ts`، «reaches a named profile's conversation»): هرمز رفض الحقن: `Plugin message injection refused: plugin=corehub-bridge session=agent:work:… belongs to profile work, not the plugin's profile default`. من v0.22.3 (`gateway/run_plugin_injection.py` §_plugin_messaging_session_owned) الإضافة تحقن فقط في محادثات ملفها الشخصي، ونسخة الجذر كانت هي اللي تاخذ عناصر كل الملفات. هذا عطل حقيقي للمستخدم (رسالة الهب ما توصل)، فتصلّح في الهب:
     - `hermes-gateways.ts`: `OWN_PROFILE_INJECTION_SINCE = '0.22.3'` و`injectsOnlyIntoOwnProfile()` من نسخة هرمز اللي يقرأها الهب.
     - `channel-bridge/bridge.ts`: على هرمز v0.22.3 فما فوق كل نسخة من الإضافة تاخذ عناصر ملفها فقط؛ قبلها نسخة الجذر تاخذ الكل والنسخ المسمّاة ما تاخذ شي (نفس اللي كان يشتغل).
     - `channel-bridge/plugin.ts`: في وضع `plugins.isolation: host` صارت كل نسخة تسأل الهب (كانت نسخة الجذر فقط)، والهب يقرر وش يعطي كل وحدة.
  2. **ملف `gateway.lock` في بيت «manger»** (`gateways.real.test.ts`): الاختبار كان يتوقع ما فيه قفل هناك. من v0.22.5 البوابة الوحيدة تحجز بيت كل ملف تخدمه (`gateway/runtime_ownership.py`، `_start_gateway_reserve_profiles`) وتكتب رقم عمليتها فيه. هذا تصميم هرمز، مو بوابة ثانية. صار الاختبار يتحقق حسب النسخة: من v0.22.5 قفل «manger» يحمل رقم عملية بوابة الجذر نفسها، وقبلها ما فيه قفل. وبعدها طلع في نفس الاختبار عطل حقيقي: **الويبهوك لملف مسمّى** يرد 503 `Admission unavailable`: هرمز v0.22.3+ يتحقق من المسار مرة ثانية وقت القبول داخل نطاق الملف (`gateway/platforms/webhook_delivery.py` §route_digest يقرأ ملف الاشتراكات لبيت الملف)، والنسخة اللي يكتبها الهب كانت في ملف الجذر فقط باسم `manger--deploys`. صار `shareProfileWebhooks` يكتب نفس النسخة في ملف الملف نفسه تحت نفس الاسم (معلّمة كنسخة الهب، وصفحة الهب ما تعرضها، وتنشال لما ينشال المسار).
  3. **image-generate في دور هرمز** (`skill-library.real.test.ts`): الاختبار كان يشغّل الدور بـ `hermes -p work chat -q` داخل حاوية مؤقتة، ومن v0.22.3 الأمر هذا ينتظر «gateway runtime» وفي الحاوية المؤقتة ما جهز خلال 60 ثانية (`Gateway starting: deadline`). الهب نفسه ما يستخدم هذا الأمر أبدًا (محادثاته عبر `python -m tui_gateway.entry`)، فصار الاختبار يشغّل الدور بنفس طريق الهب (`HermesTuiSession` في الملف `work`) بنفس التحققات كلها، ومهلته 240 ثانية مثل مهلة الدور نفسه.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/Dockerfile` (`HERMES_REF`، `UV_VERSION`، والتعليق)
- `packages/server/src/modules/agents/catalog/hermes-versions.ts` (`HERMES_TESTED`)
- `scripts/hermes-image/python-version.mjs` (تعليق)
- `scripts/hermes-image/aiohttp-version.mjs` (جديد) و`scripts/hermes-image.test.mjs`
- `.github/workflows/ci.yml` و`.github/workflows/hermes-real-suites.yml` (رقم aiohttp)
- `packages/server/src/modules/agents/hermes-gateways.ts`، `channel-bridge/bridge.ts`، `channel-bridge/plugin.ts`، `index.ts` (الجسر حسب النسخة)
- `packages/server/src/modules/agents/hermes-webhooks.ts` (نسخة المسار في ملف الملف المسمّى)
- الاختبارات: `channel-bridge/channel-bridge.test.ts`، `tests/unit/hermes-webhooks.test.ts`، `tests/unit/gateways.real.test.ts`، `tests/unit/hermes-real.ts`، `tests/unit/skill-library.real.test.ts`

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ uv 0.13.5: uv python list --all-versions --only-downloads
cpython-3.14.9-linux-x86_64-gnu   <download available>
cpython-3.14.7-linux-x86_64-gnu   <download available>
cpython-3.12.15-linux-x86_64-gnu  <download available>
$ node --test scripts/hermes-image.test.mjs scripts/hermes-watch.test.mjs
tests 21, pass 21, fail 0
$ node scripts/hermes-image/aiohttp-version.mjs <pyproject كل نسخة>
v2026.9.14 3.14.3 · v0.22.2 3.14.3 · v0.22.5 3.14.5
$ node --test scripts/hermes-image.test.mjs
pass 6, fail 0
```
على الجهاز، بصور مبنية محليًا (`docker build … --build-arg HERMES_REF=v0.22.5` ثم `v0.22.2`)، عامل واحد:
```
COREHUB_HERMES_IMAGE=<v0.22.5> vitest run --project unit --maxWorkers=1 <الملف>
channel-sends.real.test.ts   10 passed
gateways.real.test.ts        3 passed | 1 skipped
skill-library.real.test.ts   2 passed
COREHUB_HERMES_IMAGE=<v0.22.2> (نفس الملفات الثلاثة)
10 passed · 3 passed | 1 skipped · 2 passed
$ vitest run --maxWorkers=2 src/modules/agents tests/unit/hermes-webhooks.test.ts tests/unit/gateways.test.ts
70 files passed, 851 tests passed, 86 skipped
$ pnpm typecheck → 0
```
وكل الاختبارات الحقيقية (الحد الأدنى v2026.9.14 و v0.22.5) وبناء الصورة في CI على هذا الفرع.

## المخاطر والرجوع
بايثون ونسخة uv أحدث داخل الصورة، وما لا تغطيه الاختبارات الحقيقية قد يتغير في هرمز. الرجوع: إعادة `HERMES_REF` و`UV_VERSION` وبناء الصورة.

## التسليم والخطوة التالية
CI كامل، ثم دمج المالك، ثم إصدار 1.1.9 (#258) بهرمز v0.22.5.
