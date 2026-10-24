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
- ما يحتاجه v0.22.5 بعدها يتصلّح هنا حسب نتائج الاختبارات الحقيقية في CI.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/Dockerfile` (`HERMES_REF`، `UV_VERSION`، والتعليق)
- `packages/server/src/modules/agents/catalog/hermes-versions.ts` (`HERMES_TESTED`)
- `scripts/hermes-image/python-version.mjs` (تعليق)
- `scripts/hermes-image/aiohttp-version.mjs` (جديد) و`scripts/hermes-image.test.mjs`
- `.github/workflows/ci.yml` و`.github/workflows/hermes-real-suites.yml` (رقم aiohttp)

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
الاختبارات الحقيقية (الحد الأدنى و v0.22.5) وبناء الصورة في CI على هذا الفرع.

## المخاطر والرجوع
بايثون ونسخة uv أحدث داخل الصورة، وما لا تغطيه الاختبارات الحقيقية قد يتغير في هرمز. الرجوع: إعادة `HERMES_REF` و`UV_VERSION` وبناء الصورة.

## التسليم والخطوة التالية
CI كامل، ثم دمج المالك، ثم إصدار 1.1.9 (#258) بهرمز v0.22.5.
