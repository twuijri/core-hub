# وحدة `auth`: الحساب الأول، الدخول، رموز التطبيق، الاقتران بـQR، المستخدمون، مساحات العمل
المسؤول: twuijri · الفرع: feat/auth · الحالة: review

## المشكلة والهدف
الخادم يجيب كل عمليات وسم `auth` في العقد بـ`501 not_implemented`، ولا يوجد حساب
مالك ولا رمز دخول ولا مبدأ موحّد (`principal`) تبني عليه بقية الوحدات. الهدف:
تنفيذ كل عملية في وسم `auth` (30 عملية: الدخول/التجديد/الخروج، `me`، كلمة المرور،
التفضيلات، إدارة المستخدمين، الصورة الشخصية، الأقفال، رموز التطبيق، الاقتران،
مساحات العمل وإعداداتها والتصدير/الاستيراد)، مع الإضافات (plugins) التي تستعملها
بقية الوحدات: `requireUser`، `requireRole`، `requireAppToken`، `requireScope`،
`requireWorkspace` (حلّ `X-Hub-Profile`، ADR 0005)، و`request.principal` الموحّد.

## القرار والموافقات
- كلمات المرور: Argon2id (`argon2` 0.45، معاملات OWASP: m=19 MiB, t=2, p=1).
- رمز الوصول: JWT HS256 (`jose` 6.2) مدته 900 ثانية؛ المفتاح يُولَّد عند أول إقلاع في
  `<DATA_DIR>/keys/jwt.secret` (وضع 0600). يحمل `sub` و`role` و`sid` (صف الجلسة).
- رمز التجديد = صف `app_tokens` من نوع `web` (مخزَّن بـSHA-256، يدور في مكانه عند كل
  تجديد، 30 يومًا). رموز الأجهزة والتكامل `hub_at_…` مخزَّنة بالتجزئة وتُعرض مرة واحدة.
- الحساب الأول: عند الإقلاع، إن لم يوجد مستخدم و`HUB_ADMIN_PASSWORD` مضبوط، يُنشأ
  المستخدم `admin` بدور `owner` ومساحة العمل `default` (`is_default`). بلا كلمة مرور
  يبقى الخادم في حالة `setup_required` ويسجّل تحذيرًا.
- الأقفال: 5 إخفاقات لكل IP في 15 دقيقة تقفل 15 دقيقة (`password`, `pairing`, `token`)؛
  يجيب الخادم `429 rate_limited` مع `Retry-After`.
- الاقتران: الكود `XXXX-XXXX` من أبجدية بلا التباس، صالح 300 ثانية افتراضيًا (60–900).
  الاستحقاق (claim) في معاملة واحدة: جهاز (عبر واجهة وحدة `devices` العامة) + رمز جهاز
  90 يومًا + تعليم الكود مستهلكًا، ثم `pairing.claimed` و`device.linked` على `/rt/devices`
  إلى غرفة المستخدم `user:<id>` فقط.
- الحلّ الموحّد للهوية hook واحد يقرأ `Authorization: Bearer` (JWT أو رمز تطبيق) ويضع
  `request.principal` أو `null`؛ الفرض يتم لكل مسار بالإضافات المصدَّرة. المقابس (Socket.IO)
  تقبل `auth.token` نفسه وتنضم لغرفة المستخدم؛ بلا رمز تبقى بلا غرف.
- حدود الوحدات: كتابة صف الجهاز من وحدة `devices` عبر `index.ts` الخاص بها (أُضيفت لها
  دوال عامة صغيرة ومطابقة مخططها للعقد: `device_key`, `kind`, `brand`, `model`,
  `connection`, قدرات كمصفوفة). سجل التدقيق (`audit_events`) والمهام (`jobs`) يُكتبان عبر
  بديل مؤقت داخل `auth` (`audit-stub.ts`) إلى أن تصدّر وحدة `audit` واجهتها؛ مهام
  التصدير/الاستيراد تُصطفّ (`queued`) ولا يوجد عامل ينفّذها بعد.
- الصور الشخصية (مستخدم/مساحة عمل) تُحفظ ملفات تحت `<DATA_DIR>/avatars/` لا كمرفقات
  `knowledge` لأن المرفقات مقيّدة بمساحة عمل والمستخدمون عالميون.
- عضوية مساحات العمل تتبع العقد: عضو بلا صفوف عضوية يدخل كل المساحات («Empty means every profile»).
- `delete profile` = أرشفة + حذف العضويات؛ التطهير عبر الوحدات مهمة لاحقة (README §Archive).
- الغرفة النظيفة (ADR 0004): لم يُفتح أي ملف من `packages/*` في Studio؛ اطُّلع فقط على
  تطبيق أندرويد (MIT، ملكنا) لمعرفة ما يرسله العميل (`Authorization: Bearer`).
- ينتظر موافقة المالك: الدمج. فتح PR مطلوب في التكليف.

## العقد
لا تغيير في محتوى `packages/contracts/openapi.yaml`. ما لاحظته أثناء التنفيذ ولم أغيّره:
`AppToken` بلا حقل `kind` (فجلسات الويب لا تظهر في قائمة الرموز)، ومثال
`realtime_namespaces` يذكر `/rt/jobs` غير الموجود في الخادم (مثال فقط).
أُضيف إلى الخادم رمزا الخطأ `token_expired` و`profile_not_found` الموجودان في `ErrorCode`.

## الملفات والتأثير
- `packages/server/src/modules/auth/`: `schema.ts` (أعمدة جديدة: `users.avatar_mime`,
  `workspaces.avatar_mime`, `pairing_codes.connection/hub_url/cancelled_at`,
  `login_lockouts.kind`)، `index.ts`، `routes.ts`، `principal.ts`، `workspace.ts`،
  `passwords.ts`، `tokens.ts`، `lockouts.ts`، `users.ts`، `profiles.ts`، `pairing.ts`،
  `avatars.ts`، `sockets.ts`، `audit-stub.ts`، `serialize.ts`، `README.md`، الاختبارات.
- `packages/server/src/modules/devices/`: `schema.ts` (مطابقة العقد)، `index.ts` (واجهة عامة
  صغيرة: `registerPairedDevice`, `revokeDeviceByToken`, `serializeDevice`).
- `packages/server/src/lib/errors.ts` (رموز جديدة + مفتاح رسالة)، `src/lib/db.ts` (جديد).
- `packages/server/src/app/server.ts` (تزيين `hub` قبل تسجيل المسارات لتصل الوحدات إلى
  القاعدة والإعدادات عند الإقلاع)، `src/app/db.ts` (هجرات PostgreSQL تُتخطّى بتحذير
  صريح حتى يوجد `drizzle/pg`).
- `packages/server/src/i18n/{ar,en}.json`، `packages/server/drizzle/` (الهجرة الأولى)،
  `packages/server/package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml` (argon2, jose).
- `packages/server/tests/contract/auth.contract.test.ts` (مسارات النجاح لكل عملية `auth`
  عبر العميل المولَّد)، `tests/contract/schema.ts` (مساعد Ajv مشترك)، `contract.test.ts`
  (يستورد المساعد؛ إصلاح فهرس `match[1]` تحت `noUncheckedIndexedAccess`).
- `.prettierignore` (تجاهل `packages/server/drizzle/` المولَّد).
- `docs/domain/auth.md`، `docs/domain/devices.md` (الأعمدة الجديدة).

## الفحوص (الأوامر ونواتجها الفعلية)
شُغِّلت محليًا على الفرع `feat/auth` (Node v24.21.0، pnpm 12.5.1)؛ CI لا يعمل على المستودع
الخاص (`docs/harness/README.md` §CI on a private repository).
```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit=0

$ pnpm typecheck        # contracts: generate:ts + tsc ; server: tsc --noEmit -p tsconfig.json
exit=0
$ npx tsc --noEmit -p packages/server/tsconfig.test.json    # src + tests + vitest/drizzle configs
exit=0

$ pnpm test
 Test Files  3 passed (3)      Tests  11 passed (11)     # contracts
 Test Files  22 passed (22)    Tests  53 passed (53)     # server unit: 13 وحدات + auth (passwords, tokens, pairing, roles, first boot) + config/logger/http/sockets/validate
exit=0

$ pnpm contract:test
 Test Files  2 passed (2)      Tests  247 passed (247)   # contract.test.ts: كل عملية في العقد (245) ؛ auth.contract.test.ts: مسار النجاح لكل عمليات auth عبر createHubClient
exit=0

$ pnpm i18n:check
i18n:check  server: 42 keys, ar/en in parity
i18n:check  OK
exit=0

$ pnpm db:generate                     # المرة الأولى
[✓] Your SQL migration file ➜ drizzle/0000_mean_cerise.sql 🚀     # 55 جدولًا، 1236 سطرًا، مع meta/_journal.json و 0000_snapshot.json
$ pnpm db:generate                     # بعد الالتزام بالمخطط النهائي
No schema changes, nothing to migrate 😴
exit=0

$ DATA_DIR=$(mktemp -d) pnpm db:migrate
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}
exit=0

$ pnpm build
exit=0                                 # packages/contracts/dist + packages/server/dist

$ pnpm change-record:check -- --files docs/changes/2026-09-21-twuijri-auth-module.md
change-record  OK — 1 record(s) valid
```
لم يُشغَّل: `pnpm contracts:lint` / `contracts:generate` (العقد لم يتغيّر)، بناء Docker (غير مطلوب في
التكليف)، هجرة PostgreSQL (لا توجد بعد؛ `db:migrate` مع `DATABASE_URL` يتخطّاها بتحذير صريح).

## المخاطر والرجوع
- الهجرة الأولى `0000_*` تُنشئ كل الجداول (55 جدولًا)؛ أي تغيير مخطط لاحق هجرة جديدة.
- هجرات PostgreSQL غير موجودة بعد (كانت كذلك قبل هذه المهمة)؛ صار التخطي صريحًا في السجل.
- مهام التصدير/الاستيراد تبقى `queued` حتى يوجد عامل مهام؛ موثَّق في README الوحدة.
- الرجوع: إلغاء الدمج يعيد 501 لكل عمليات `auth`؛ لا بيانات تُفقد إلا ما أُنشئ عبرها.

## التسليم والخطوة التالية
- PR إلى `main` بالإنجليزية؛ الدمج قرار المالك.
- التالي: وحدة `audit` تصدّر `record()`/`createJob()` فيُحذف `audit-stub.ts`؛ وحدة
  `devices` تكمل مساراتها فوق الصفوف التي ينشئها الاقتران؛ عامل المهام للتصدير/الاستيراد.
