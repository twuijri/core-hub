# نقل صورة المركز إلى هرمز v0.23.4 (0.23.4)
المسؤول: aboawadh · الفرع: fix/hermes-v0-23-4 · الحالة: review

## المشكلة والهدف
صدر هرمز v0.23.4 والصورة على v0.22.5. مراقب هرمز فتح #264 «غير مدعوم بعد»: 7 من 148 اختبارًا حقيقيًا فشلت على صورة
مبنية بـ `HERMES_REF=v0.23.4` (التشغيل https://github.com/twuijri/core-hub/actions/runs/45839204964). الصورة نفسها انبنت
بدون أي تغيير في `Dockerfile` (نفس uv 0.13.5 ونفس طريقة اختيار بايثون وaiohttp).

الفشل له سببان فقط، وكلاهما تغيير مقصود في هرمز:

1. **مفتاح المزوّد في ملف شخصي مسمّى** (ستة اختبارات: `hermes-profile.real.test.ts` ×2، `memory.real.test.ts` ×2،
   `channel-sends.real.test.ts` «reaches a named profile's conversation» ×2). الخطأ:
   ```
   No API key for custom provider 'corehub-fake': it reads COREHUB_FAKE_KEY, which is not set for this profile, so the
   request was not sent. COREHUB_FAKE_KEY is set in this server's environment, but profile 'b' reads keys only from its
   own .env.
   ```
   من v2026.9.21 (`0.21.4`) الملف المسمّى يقرأ المفاتيح من `.env` حقه فقط (`agent/secret_scope.py` §get_secret)، والهب
   أصلًا يكتب كل مفتاح يستخدمه الملف في `.env` حقه قبل كل دور وبعد إنشاء الملف (`models/service.ts` §prepareProfileWith،
   DECISIONS §132). الاختبارات الستة كانت تحط المفتاح في بيئة العملية فقط، ونجحت لأن النموذج المزيّف ما يتحقق من المفتاح:
   هرمز كان يرسل الطلب بلا مفتاح. من v0.22.6 هرمز يرفض الدور قبل الإرسال إذا المزوّد يعلن `key_env` وما لقاه
   (`hermes_cli/runtime_provider_missing_key.py` §raise_if_declared_key_missing). يعني الهب في الإنتاج سليم، والعطل في
   تجهيز الاختبارات: صارت تحط المفتاح حيث يحطه الهب — `.env` الجذر و`.env` كل ملف مسمّى، وبيئة العملية كما كانت. نسخة
   `default` (`--clone-from`) تاخذ `.env` الجذر معها (`hermes_cli/profiles.py` §_CLONE_CONFIG_FILES)، مثل الإنتاج.
2. **توقيع ويبهوك خاطئ** (`hermes-webhooks.real.test.ts`): `expected 404 to be 401`. من v0.23.2 هرمز يرد على توقيع خاطئ بنفس
   رد المسار غير الموجود، `404 Unknown route: <name>`، حتى ما يقدر أحد يكتشف أسماء المسارات بالتوقيع
   (`gateway/platforms/webhook.py` §_read_authenticated_body). قبله كان `401 Invalid signature`. باب الهب العام
   (`agents.receiveWebhook`) يمرّر رد هرمز كما هو، وهذا الصح: لو حوّل الهب الـ404 إلى 401 لكشف للمتصل الخارجي إن المسار
   موجود، وهو بالضبط اللي سدّه هرمز.

## القرار والموافقات
- الاختبارات الحقيقية الأربعة تحط المفتاح في `.env` كما يكتبه الهب (`models/propagation.ts`). يشتغل على كل نسخة: الملف
  المسمّى يقرأ `.env` حقه أولًا على الحد الأدنى أيضًا.
- اختبار الويبهوك الحقيقي يتحقق حسب نسخة هرمز اللي في الصورة: `401 unauthorized` قبل 0.23.2، و`404 not_found` من 0.23.2،
  وفي الحالتين `details.reason = hermes_refused` و`hermes_status` رد هرمز (`wrongWebhookSignatureStatus` في
  `tests/unit/hermes-real.ts`).
- اختبار وحدة جديد في `hermes-webhooks.test.ts`: رد هرمز `404 Unknown route` يمر من الباب `404 not_found` بكلمات هرمز.
- نقل `HERMES_REF` و`HERMES_TESTED` إلى v0.23.4 بـ `node scripts/hermes-watch.mjs bump --ref v0.23.4 --version 0.23.4`؛ الحد
  الأدنى يبقى v2026.9.14 (`0.21.3`).
- ما فيه تغيير في كود الخادم: الهب كان يتصرف صح مع هرمز v0.23.4، والفشل كان في الاختبارات.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
وصف `agents.receiveWebhook` فقط في `openapi.yaml`: من هرمز v0.23.2 التوقيع الخاطئ يرجع `404` مثل المسار غير الموجود. الردود
المعلنة نفسها (401 و404 كانا معلنين)، فلا تغيير يكسر شيئًا.

## الملفات والتأثير
- `packages/server/Dockerfile` (`HERMES_REF`) و`packages/server/src/modules/agents/catalog/hermes-versions.ts`
  (`HERMES_TESTED`)، بسكربت `hermes-watch.mjs bump`
- `packages/contracts/openapi.yaml` (وصف فقط)
- الاختبارات: `adapters/hermes-profile.real.test.ts`، `memory.real.test.ts`، `sessions/channel-sends.real.test.ts`،
  `hermes-webhooks.real.test.ts`، `tests/unit/hermes-real.ts`، `tests/unit/hermes-webhooks.test.ts`

## الفحوص (الأوامر ونواتجها الفعلية)
من مصدر هرمز (نفس الملف في كل وسم):
```
hermes_cli/runtime_provider.py  raise_if_declared_key_missing(:  v0.22.5 0 · v0.22.6 1 · v0.23.0 1 · v0.23.4 1
gateway/platforms/webhook.py    توقيع خاطئ:  v0.22.5..v0.23.1 → 401 "Invalid signature" · v0.23.2..v0.23.4 → 404 "Unknown route"
```
صور مبنية محليًا من نفس `Dockerfile` (`--build-arg HERMES_REF=v0.23.4` و`v2026.9.14`)، والاختبارات تشتغل في حاوية Linux على
شبكة المضيف ومعها مقبس Docker (على macOS ما توصل `--network host` إلى loopback الجهاز):
```
$ hermes --version → Hermes Agent v0.23.4 (2026.9.24) · Hermes Agent v0.21.3 (2026.9.14)
COREHUB_HERMES_IMAGE=<v0.23.4> vitest run --project unit --maxWorkers=1 \
  hermes-webhooks.real memory.real channel-sends.real hermes-profile.real
  قبل التعديل (CI #264): 7 فشلت
  بعد التعديل، التشغيل الأول: Tests 2 failed | 15 passed — channel-sends in_process «reaches a named profile's
    conversation» (بوابة الجذر علقت، سجل faulthandler) و«records what Hermes does…» بعده (bridge_offline)
  إعادة channel-sends.real وحده: Tests 10 passed (10)
COREHUB_HERMES_IMAGE=<v2026.9.14> (نفس الملفات الأربعة)
  Test Files 4 passed (4) · Tests 12 passed | 5 skipped (17)   (host: لا يوجد قبل v0.21.6)
$ node scripts/hermes-watch.mjs bump --ref v0.23.4 --version 0.23.4
Hermes pin moved to v0.23.4 (0.23.4)
$ node --test scripts/hermes-image.test.mjs scripts/hermes-watch.test.mjs
tests 24, pass 24, fail 0
$ vitest run --project unit tests/unit/hermes-webhooks.test.ts → 7 passed
$ vitest run --project unit --maxWorkers=4 src/modules/agents src/modules/sessions tests/unit/hermes-webhooks.test.ts tests/unit/gateways.test.ts
Test Files 2 failed | 100 passed | 27 skipped · Tests 4 failed | 1103 passed | 102 skipped
  الأربعة (sessions/files.test.ts، sessions/working-dir.test.ts) تفشل كذلك على main بدون التعديل على macOS
  (/tmp → /private/tmp)، ولا علاقة لها بالتغيير
$ pnpm typecheck → 0
$ pnpm lint → 0 (All matched files use Prettier code style!)
$ pnpm contracts:compat → OK — no breaking change against v1.1.10
$ pnpm migrations:guard → OK — no breaking change against v1.1.10
$ pnpm contract:test → 449 passed, 1 failed (terminal.contract.test.ts، يفشل كذلك على main بدون التعديل على macOS)
$ node scripts/check-change-record.mjs → OK
```
كل `*.real.test.ts` على صورة v0.23.4 (بدون `HERMES_SRC`، فمجموعات kanban و cron تتخطى):
```
COREHUB_HERMES_IMAGE=<v0.23.4> vitest run --project unit --maxWorkers=2 $(find src tests -name '*.real.test.ts')
Test Files 1 failed | 32 passed | 7 skipped (40) · Tests 2 failed | 89 passed | 57 skipped (148)
  الاثنين في hermes-plugins.real.test.ts: `install failed: [Errno 40] Too many levels of symbolic links:
  '/hh/tools/.staging-…/tree/python/share/terminfo/n/…'` — هرمز يفك بايثون في بيت مربوط من نظام ملفات macOS
  (غير حساس لحالة الأحرف، وterminfo فيه `N` و`n`). ما فشلا في CI على Linux (#264)، ولا علاقة لهما بالتغيير.
```
وCI على هذا الفرع يشغّل كل الاختبارات الحقيقية على الحد الأدنى وعلى v0.23.4 كما في الإصدار.

## المخاطر والرجوع
هرمز أحدث داخل الصورة، وما لا تغطيه الاختبارات الحقيقية قد يتغير فيه. من يرسل ويبهوك بتوقيع خاطئ يشوف 404 بدل 401 (سلوك هرمز
نفسه). الرجوع: إعادة `HERMES_REF` و`HERMES_TESTED` إلى v0.22.5 وبناء الصورة؛ تعديلات الاختبارات تبقى صحيحة على v0.22.5.

## التسليم والخطوة التالية
CI كامل (الاختبارات الحقيقية على الحد الأدنى وعلى v0.23.4)، ثم مراجعة المالك ودمجه.
