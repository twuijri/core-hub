# تهيئة أول تشغيل من المتصفح (رمز مطالبة كما في Jenkins)
المسؤول: twuijri · الفرع: feat/first-run-setup · الحالة: review

## المشكلة والهدف
اليوم يُنشأ حساب المالك من متغيّر البيئة `HUB_ADMIN_PASSWORD` في `docker-compose.yml`، أي أن
كلمة مرور المالك تُكتب في ملف `.env` على الخادم وتبقى فيه. طلب المالك (2026-09-22): «مثل أي
نظام احترافي» — عند تركيب جديد يفتح الموقع فيطلب منه إنشاء الحساب من الواجهة، بلا كلمة مرور
في ملف المكدّس.

القيد الأمني الذي لا يجوز تجاهله: المركز يُنشر خلف Caddy على نطاق عام. «تهيئة مفتوحة» (أول من
يفتح الرابط ينشئ الحساب) تعني أن أول غريب يصل إلى العنوان يستولي على النسخة، بين لحظة
`docker compose up -d` ولحظة فتح المالك للمتصفح، والمالك لا يعرف أن ذلك حدث. الهدف: تهيئة من
المتصفح **محمية برمز مطالبة** يولّده المركز ويقرأه صاحب الخادم من السجل أو من ملف داخل مجلد
البيانات — النموذج نفسه الذي يستخدمه Jenkins في `initialAdminPassword`.

## القرار والموافقات
- **ADR 0011** الجديد يسجّل القرار كاملًا، ويذكر ما رُفض ولماذا: التهيئة المفتوحة، ونافذة
  زمنية بعد الإقلاع، وقائمة عناوين مسموحة، وكعكة «أول زائر يفوز»، ومتغيّر بيئة خامس
  (`HUB_SETUP_TOKEN`)، وإبقاء `HUB_ADMIN_PASSWORD` طريقًا وحيدًا، وآلية حدّ محاولات ثانية.
- **الأسبقية**: `HUB_ADMIN_PASSWORD` يفوز حيثما ضُبط — يُنشئ `admin` عند أول إقلاع، ولا
  يُكتب أي رمز، ولا تظهر شاشة التهيئة أصلًا. التركيب غير التفاعلي باقٍ كما هو.
- **الرمز**: ٢٤ بايتًا عشوائية (٤٨ محرفًا hex) تُكتب في `<DATA_DIR>/setup-token.txt` بصلاحية
  `0600` وتُطبع مرة واحدة في السجل بمستوى `info` مع سطر يقول أين تُقرأ مجددًا. رمز جديد عند
  كل إقلاع ما دامت التهيئة معلّقة (فالرمز الذي تسرّب في سجل قديم يبطل)، ويُحذف الملف لحظة
  وجود المالك — عند نجاح التهيئة، وعند الإقلاع إن وُجد ملف متخلّف.
- **المقارنة** بزمن ثابت: `timingSafeEqual` على بصمتَي SHA‑256، فلا يتسرّب حتى الطول.
- **حدّ المحاولات**: أُعيد استخدام `login_lockout` نفسه بنوع `password` (لا آلية ثانية):
  خمس محاولات خاطئة في ١٥ دقيقة تقفل عنوان IP ١٥ دقيقة، وتظهر في شاشة العناوين المقفلة.
- **٤٠٩ أولًا**: إن وُجد مالك تُرفض العملية بـ`conflict` قبل النظر في الرمز، فإعادة استخدام
  رمز قديم لا تتميّز عن تخمين عشوائي.
- **سياسة كلمة المرور** هي سياسة بقية `auth` (٨ محارف فأكثر، Argon2id)، واسم المستخدم بالنمط
  نفسه.
- **رمز التهيئة في الطرفية يُعرض ولا يُخفى**: المركز طبعه في سجلّه أصلًا، ولصقٌ لا يستطيع
  المشغّل قراءته لصقٌ لا يستطيع التحقق منه. كلمة المرور وحدها مخفية، وتُطلب مرتين.
- **الغرفة النظيفة (ADR 0004)**: لم يُفتح أي ملف تحت `agent-studio/packages/*` ولا أي مصدر
  آخر؛ كل شيء من العقد ووثائق هذا المستودع. النموذج المرجعي (Jenkins) فكرة معروفة، لا كود.
- لم يُدفع الفرع، ولم يُفتح PR، ولم تُبنَ صورة ولم يُنشر شيء.

## العقد
عمليتان جديدتان في وسم `auth` من `packages/contracts/openapi.yaml` (المجموع ٢٤٥ ← ٢٤٧):

- `GET /auth/setup` (`auth.getSetup`، `security: []`) → `SetupState` = `{ required }` فقط. لا
  يكشف الرمز ولا وجود ملفه؛ بت واحد يكفي العميل ليقرر أي شاشة يعرض.
- `POST /auth/setup` (`auth.completeSetup`، `security: []`) ← `SetupRequest`
  = `{ token, username, password, display_name?, workspace_name? }` → `200 TokenPair` (نفس
  جواب `auth.login`، فالعميل يدخل فورًا)، و`400` تحقق، و`401` رمز خاطئ، و`409` مالك موجود،
  و`429` حدّ المحاولات.

سُجّل القرار في `docs/contracts/DECISIONS.md` §26 مع البدائل المرفوضة. لم تتغيّر أي عملية
قائمة، ولا أي مخطط حدث في `events/` — إضافة فقط، فلا كسر توافق.

## الملفات والتأثير
**العقد**: `packages/contracts/openapi.yaml` (مساران + مخططان)،
`docs/contracts/DECISIONS.md` (§26).

**الخادم**:
- جديد `packages/server/src/modules/auth/setup.ts` — توليد الرمز وكتابته `0600`، قراءته،
  حذفه، المقارنة بزمن ثابت، نص سطر السجل، و`completeSetup` التي تنشئ المالك ومساحة
  `default` في معاملة واحدة (نفس صفوف `bootstrap`).
- `modules/auth/index.ts` — عند الإقلاع: إصدار رمز جديد وطباعته إن كانت التهيئة مطلوبة،
  وحذف أي ملف متخلّف إن وُجد المالك (كان سطر تحذير فقط).
- `modules/auth/routes.ts` — المساران، مع `assertNotLocked`/`recordFailure`/`clearFailures`
  على نوع `password`، وسجلّي تدقيق `auth.setup` و`auth.setup_failed`.
- `src/i18n/{ar,en}.json` — `auth.setup_done` و`auth.setup_token_invalid`، وتحديث
  `auth.setup_required` (كانت تقول «اضبط HUB_ADMIN_PASSWORD»).
- `tests/unit/helpers.ts` — `testHub` صار يقبل `logger` (لاختبار سطر السجل).
- `vitest.config.ts` — مهلة مشروع `unit` ٣٠ ثانية بدل ٥ الافتراضية (انظر المخاطر).
- جديد `modules/auth/setup.test.ts` (٩ فحوص) وتعديل `auth.test.ts`.
- `tests/contract/auth.contract.test.ts` — العمليتان على مركز مهيَّأ (`false` و`409`)، وكتلة
  جديدة على مركز بلا مالك: `getSetup=true` ← `401` برمز خاطئ ← `200` بالرمز الحقيقي من الملف
  ← `false` ← `409` عند الإعادة، وكل جواب يُتحقق من مخططه.

**الويب**:
- جديد `src/screens/SetupScreen.tsx` — عربية أولًا مع RTL كامل وإنجليزية، رموز التصميم
  نفسها (`glass`, `card`, `field`, `btn`), شرح داخل الشاشة لمكان الرمز مع الأمرين، حقول
  معنونة بـ`htmlFor`/`id` (لوحة المفاتيح وقارئ الشاشة)، كلمة المرور في حقل `password`
  مرتين ولا تُطبع في أي مكان، وتحويل إلى الدخول عند `409`.
- `src/auth/context.tsx` — `completeSetup` و`remember` (مكان واحد يخزّن `TokenPair`).
- `src/hub/queries.ts` — `useSetupState()` على `GET /auth/setup` بلا تخزين مؤقت.
- `src/screens/LoginScreen.tsx` — يحوّل إلى `/setup` حين يقول الخادم إن التهيئة مطلوبة
  (كان يعتمد على `meta.setup_required`، و`meta.get` ما زالت `501` فلم يكن الإشعار يظهر أصلًا).
- `src/navigation/{manifest,routes}.tsx` + `src/app.tsx` — `SETUP_PATH` من الخريطة.
- `src/i18n/{ar,en}.json` — عائلة `setup.*` و`nav.login`/`nav.setup` و`login.setup_unknown`
  (حُذفت `login.setup_required` الميتة). المصطلحات اللاتينية داخل العربية معزولة بـFSI/PDI.
- `tests/setup-screen.test.tsx` (٤ فحوص) و`tests/navigation.parity.test.tsx` (فحص `preAuth`).

**الخريطة**: `docs/clients/navigation.json` — قسم `preAuth` جديد (`login` و`setup` بمسار لكل
سطح ومصطلح عربي/إنجليزي)؛ ليستا وجهتين ولا مدخل لهما. `scripts/navigation-check.mjs` يتحقق
منه (مصطلح معروف، مسار مطلق، لا تصادم مع مسارات الوجهات ولا بين الشاشتين).
`docs/clients/NAVIGATION.md` §٠ و§٥، و`docs/clients/README.md`.

**العميل المرجعي**: `packages/cli/src/commands/auth.ts` (`setupCommand`)، `src/main.ts`،
`src/i18n/{ar,en}.json`، `docs/clients/CLI.md`، وجديد
`tests/integration/setup.test.ts` (٤ فحوص ضد مركز حقيقي بلا مالك). الرمز وكلمة المرور
مرفوضان على سطر الأوامر أصلًا بـ`SECRET_OPTIONS` في `args.ts`.

**الرحلات**: `packages/web/e2e/hub.ts` (وضع `setup`: بلا كلمة مرور، مجلد بيانات مسمّى
يُمسح ويُعاد إنشاؤه عند كل تشغيل فتكون الإعادة كالمرة الأولى)، `playwright.config.ts`
(خادمان)، وجديد `e2e/setup.spec.ts` (الرحلة الرابعة)، `.gitignore`.

**التشغيل والوثائق**: `docker-compose.yml` و`.env.example` (لا كلمة مرور مطلوبة)،
`docs/DEPLOY.md` §١ و§٢ (قسم أول تشغيل كامل بسطر السجل الحقيقي) و§٢ب، `docs/DEVELOPMENT.md`،
`docs/ARCHITECTURE.md` (الثابت ٥)، `docs/STATUS.md` (أرقام مقيسة من جديد)،
`docs/harness/validation.md`، `packages/server/src/modules/auth/README.md`،
`packages/server/src/db/README.md`، `docs/domain/auth.md`، `packages/web/README.md`،
وجديد `docs/adr/0011-first-run-setup.md`.

### تجربة المشغّل على تركيب جديد
`docker compose up -d` بلا أي سرّ في `.env` ← `docker compose logs hub` يطبع الرمز مرة واحدة
(أو `docker compose exec hub cat /data/setup-token.txt`) ← فتح الموقع يعرض «إنشاء حساب
المالك» لا شاشة الدخول ← لصق الرمز واختيار اسم المستخدم وكلمة المرور (واختياريًا الاسم
الظاهر واسم مساحة العمل) ← الدخول فورًا إلى `/chat`، ويُحذف ملف الرمز وتُغلق الشاشة نهائيًا.
من الطرفية: `majlis setup --server URL`.

## الفحوص (الأوامر ونواتجها الفعلية)
Node v24.21.0، pnpm 12.5.1، على الفرع `feat/first-run-setup` بعد آخر التزام:

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm i18n:check
i18n:check  server: 95 keys, ar/en in parity
i18n:check  cli: 212 keys, ar/en in parity
i18n:check  web: 274 keys, ar/en in parity
i18n:check  desktop: apps/desktop/src/i18n not present yet — skipped
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 35 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web

$ pnpm contracts:lint
openapi.yaml: validated in 430ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ pnpm contracts:check-clients
check-clients  OK — 100 client file(s) scanned, 162 contract path(s) known.

$ pnpm typecheck        # contracts, ui-tokens, cli, server, web
exit=0

$ pnpm test
 Test Files  3 passed (3)                Tests  11 passed (11)     # contracts
 Test Files  1 passed (1)                Tests  89 passed (89)     # ui-tokens (التباين)
 Test Files  11 passed (11)              Tests  60 passed (60)     # cli
 Test Files  36 passed | 1 skipped (37)  Tests  276 passed | 2 skipped (278)   # server
 Test Files  10 passed (10)              Tests  88 passed (88)     # web

$ pnpm contract:test
 Test Files  2 passed (2)     Tests  250 passed (250)

$ pnpm build
✓ built in 576ms
exit=0
$ node packages/cli/dist/bin.js --help | head -8
Majlis reference client: a terminal client over the contract.
Usage: majlis [global options] <command> [options]
Commands
  setup             Create the owner account on a hub that has none yet
  login             Sign in to a hub and remember the token

$ pnpm db:generate
No schema changes, nothing to migrate 😴
$ DATA_DIR=… pnpm db:migrate        # على ملف SQLite جديد
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}

$ pnpm web:e2e        # Playwright، chromium، ضد مركزين حقيقيين
  ✓  1 … 4. first run: the setup token from /data creates the owner and signs in (1.4s)
  ✓  2 … 1. login → new session → streamed markdown reply with reasoning, tool card and code (1.9s)
  ✓  3 … 2. an approval card answers once / session / always / deny through the hub (772ms)
  ✓  4 … 3. a socket drop mid-run resumes with after_seq and loses nothing (3.2s)
  4 passed (11.7s)
```

تجربة يدوية على مركز حقيقي (الخادم المبني، `DATA_DIR` فارغ، بلا `HUB_ADMIN_PASSWORD`):

```
سطر السجل عند الإقلاع:
auth: first-run setup is required — no owner account exists yet.
Open the hub in a browser and paste this setup token: 67bff3ab0a456df56dbad3188ce3b7f9dd01f752ad82348a
It is also in the data directory: …/opdata/setup-token.txt
  docker compose logs hub          # this line again
  docker compose exec hub cat /data/setup-token.txt
A new token is generated on every restart until the owner account exists.

$ ls -l $DATA_DIR/setup-token.txt
-rw------- … 49 … setup-token.txt

$ curl -s localhost:8899/api/v1/auth/setup
{"required":true}

$ curl … -H 'accept-language: ar' -d '{"token":"0000…00ff","username":"tariq","password":"…"}' …/auth/setup
{"error":"رمز التهيئة غير صحيح.","code":"unauthorized"}          [401]

$ curl … -d '{"token":"<الرمز>","username":"tariq","password":"…","display_name":"طارق","workspace_name":"مساحتي"}' …
HTTP 200
access_token eyJhbGciOiJIUzI1NiIsInR5…
refresh_token hub_rt_d4241e529…
expires_in 900
user {"username": "tariq", "display_name": "طارق", "role": "owner", "profiles": ["default"], "default_profile": "default", "locale": "en"}

$ ls -l $DATA_DIR/setup-token.txt   →  No such file or directory
$ curl -s …/auth/setup              →  {"required":false}
$ curl … (إعادة الرمز نفسه)         →  {"error":"This hub is already set up; sign in instead.","code":"conflict"} [409]
```

لقطتا الشاشة من الرحلة الرابعة: `setup-ar-light` و`setup-done-ar-light` — أُنتجتا في مجلد
العمل المؤقت للمساعد (`MAJLIS_SHOTS`)، لا في المستودع.

**لم يُشغَّل**: `pnpm contracts:generate` كاملًا (Kotlin/Swift يحتاجان JRE غير متوفّر هنا؛
`generate:ts` يجري ضمن كل typecheck/test/build ولا يترك فرقًا غير مُلتزَم)، وبناء صورة Docker،
وهجرة PostgreSQL (لا تغيير في المخطط)، وتشغيل ضد Hermes حقيقي (ليس من نطاق المهمة).

## المخاطر والرجوع
- **الرمز في السجل**: من يقرأ سجلّ الحاوية يستطيع التهيئة. هذا هو التصميم (إثبات الوصول إلى
  الخادم)، ومخاطره أقل من كلمة مرور دائمة في `.env`. يخفّفه: رمز جديد عند كل إقلاع، وحذف
  الملف فور وجود المالك، وحدّ المحاولات.
- **قفل مشترك**: محاولات التهيئة الخاطئة تُحسب على صف `password` نفسه لعنوان IP، فدفعة رموز
  خاطئة تؤخّر تسجيل الدخول من ذلك العنوان ١٥ دقيقة. مقبول (المهاجم نفسه والحماية نفسها)،
  ويستطيع المالك مسحه من شاشة العناوين المقفلة بعد الدخول.
- **مركز بلا وصول إلى سجلّه أو مجلد بياناته** لا يمكن تهيئته من المتصفح؛ لهؤلاء يبقى
  `HUB_ADMIN_PASSWORD`. موثّق في DEPLOY وADR.
- **مهلة اختبارات الوحدة** رُفعت من ٥ إلى ٣٠ ثانية لمشروع `unit`. السبب ليس هذه المهمة: على
  هذا الجهاز كان الفرع الأساس `origin/main` نفسه يسقط اختبارًا مختلفًا في كل تشغيل بمهلة ٥
  ثوانٍ (أُعيد إنتاجه في نسخة عمل منفصلة من `origin/main`: مرة `runner.test.ts`، ومرة
  `sessions-run.test.ts`، ومرة نظيفة). كل اختبار وحدة هنا يقلع مركزًا كاملًا (Fastify +
  هجرات SQLite + Argon2id بـ19 ميغابايت)، والمهلة الافتراضية موضوعة لدوال صافية. بعد الرفع
  نجح المشروع ثلاث مرات متتالية. المخاطرة: اختبار معلّق فعلًا سيأخذ ٣٠ ثانية قبل أن يسقط.
- **`locale` المالك** يتبع `Accept-Language` للطلب (العميلان يرسلانه؛ curl بلا ترويسة يعطي
  `en`)، ويُغيَّر من الإعدادات.
- **`meta.get` ما زالت `501`**، فحقل `setup_required` فيها غير مخدوم؛ العملاء يستعملون
  `auth.getSetup`. لم أوسّع النطاق لتنفيذ `meta.get`.
- **الرجوع**: حذف `modules/auth/setup.ts` والمسارين وشاشة `/setup` وأمر `setup` و`preAuth`،
  وإعادة `HUB_ADMIN_PASSWORD` إلزاميًا في `docker-compose.yml`. المخطط لم يتغيّر، فلا هجرة
  للرجوع عنها، والمراكز المهيَّأة أصلًا لا تتأثر إطلاقًا (تجيب `409`/`false`).

## التسليم والخطوة التالية
1. مراجعة المالك للفرع `feat/first-run-setup` (٦ التزامات فوق `origin/main`). لم يُدفع ولم
   يُفتح PR بطلب المكلِّف.
2. بعد الدمج: بناء صورة `test` وتجربة تركيب نظيف فعلي (حاوية جديدة، `.env` بلا كلمة مرور،
   قراءة الرمز من `docker compose logs hub`) قبل تحديث المكدّس الحيّ.
3. لاحقًا: تنفيذ `meta.get` كي يتسق `setup_required` فيها مع `auth.getSetup`، وشاشة «العناوين
   المقفلة» في الويب كي يُمسح القفل من الواجهة لا من الـAPI.
