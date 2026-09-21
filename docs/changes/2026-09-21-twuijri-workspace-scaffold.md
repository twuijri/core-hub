# هيكل مساحة العمل الهندسية (المرحلة ٠)
المسؤول: twuijri · الفرع: chore/workspace-scaffold (مقترح؛ لم يُشغَّل git في هذه المهمة) · الحالة: review

## المشكلة والهدف
المستودع كان مواصفات فقط (README، ARCHITECTURE، ADRs، TEAM-RULES، ROADMAP) بلا
كود ولا أدوات. الهدف: هيكل pnpm workspace كامل يجعل قواعد الوثائق قابلة للفحص
آليًا: عقد أولًا (ADR 0003)، حدود الوحدات (ARCHITECTURE §Modules)، عربية/إنجليزية،
خريطة تنقّل واحدة لكل العملاء، سجل تغيير لكل مهمة، صورة Docker لصندوق واحد.

## القرار والموافقات
- Node 24 + pnpm 12 + TypeScript 5.9 (لا TypeScript 7 بعد؛ typescript-eslint لا يدعمه).
- الخادم Fastify 5 + Socket.IO 4 (مسار المحرك `/rt`، مساحات الأسماء `/rt/sessions`،
  `/rt/rooms`، `/rt/board`، `/rt/schedules`، `/rt/devices`) + Drizzle (better-sqlite3
  افتراضيًا تحت `DATA_DIR`، pg عبر `DATABASE_URL`) + zod + pino مع حجب الأسرار.
- `config` يقرأ أربعة متغيرات فقط؛ اختبار يمنع أي `process.env` خارج `app/config.ts`.
- كل عملية معلنة في العقد ولا تنفّذها وحدة تُجاب بـ`501 { error, code: "not_implemented" }`
  مركّبة عند الإقلاع، فيراها العملاء واختبار العقد بدل 404 مضلّل.
- الغرفة النظيفة (ADR 0004): لم يُفتح أي ملف من `packages/*` في Studio. خريطة التنقّل
  نُقلت من وثيقتنا (MIT) وعُمّمت على وحدات Majlis بلا أي إشارة إلى ملفات Studio.
- مهمتان متوازيتان تكتبان `packages/contracts/openapi.yaml` + `events/*` و
  `packages/server/src/modules/*/schema.ts` + `src/db/*`؛ لم تُنشأ هذه الملفات هنا.
  كُتب `openapi.yaml` مؤقت معلَّم بـ`x-majlis-scaffold-stub: true` لأنه لم يكن موجودًا؛
  الأدوات تتحمّل غيابه. ظهر `src/db/schema.ts` أثناء العمل فرُبط به `drizzle.config.ts`
  و`app/db.ts`.
- ينتظر موافقة المالك: فتح PR، الدمج، وأي نشر.

## العقد
لا شيء في محتوى العقد. أُضيفت أدواته فقط: `packages/contracts` (lint بـRedocly + قواعد
ADR 0003 للأمثلة + تحقق Ajv لمخططات الأحداث، توليد TypeScript عبر openapi-typescript مع
غلاف fetch صغير `createHubClient`، توليد Kotlin/Swift عبر openapi-generator بإعدادات
محفوظة تحت `openapi-generator/`، `scripts/check-clients.mjs` لمنع المسارات المكتوبة يدويًا).
`openapi.yaml` الحالي بديل مؤقت يعلن `GET /api/v1/health` فقط ويُستبدل بملف مهمة العقد.

## الملفات والتأثير
- الجذر: `package.json` (السكربتات بأسماء `docs/harness/validation.md` حرفيًا)،
  `pnpm-workspace.yaml`، `pnpm-lock.yaml`، `.nvmrc`، `.editorconfig`، `.gitignore`،
  `.dockerignore`، `.prettierrc.json`، `.prettierignore`، `eslint.config.js` (يمنع وحدات
  الخادم من استيراد `app/` أو دواخل وحدة أخرى)، `tsconfig.base.json`، `docker-compose.yml`،
  `.env.example`، `CONTRIBUTING.md`.
- `scripts/`: `i18n-check.mjs`، `navigation-check.mjs`، `check-change-record.mjs`.
- `.github/workflows/`: `ci.yml`، `change-record.yml`، `release.yml` (النشر على وسم `v*` فقط
  وعلى `main` فقط).
- `packages/contracts/`: `package.json`، `tsconfig.json`، `redocly.yaml`، `openapitools.json`،
  `openapi-generator/{kotlin,swift}.yaml`، `scripts/{lib,lint,generate-ts,generate-native,check-clients}.mjs`،
  `src/{index,document,client}.ts`، `tests/*`، `generated/.gitkeep`، `README.md`، `openapi.yaml` (مؤقت).
- `packages/server/`: `package.json`، `tsconfig*.json`، `vitest.config.ts`، `drizzle.config.ts`،
  `scripts/db.mjs`، `Dockerfile`، `src/main.ts`، `src/app/{server,routes,sockets,config,db,migrate}.ts`،
  `src/lib/{errors,validate,logger,module}.ts`، `src/i18n/{index.ts,ar.json,en.json}`،
  `src/modules/index.ts` و13 وحدة `src/modules/<name>/{index.ts,<name>.test.ts}`،
  `tests/unit/*`، `tests/contract/contract.test.ts`.
- `docs/`: `clients/{NAVIGATION.md,README.md,navigation.json}`، `harness/README.md`،
  `contracts/README.md`، هذا السجل.
- لم يُلمس: `LICENSE` (غير موجود بعد؛ قرار المالك)، ملفات المهام الموازية.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm install --frozen-lockfile
Lockfile is up to date, resolution step is skipped
Done in 72ms using pnpm v12.5.1
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!
$ pnpm typecheck        (contracts + server، بلا أخطاء؛ يشمل schema.ts لمهمة قاعدة البيانات)
$ pnpm test
 Test Files  3 passed (3)      Tests  11 passed (11)     # contracts
 Test Files  18 passed (18)    Tests  30 passed (30)     # server: 13 وحدة + config + logger + http + sockets + validate
$ pnpm test --filter server   → 18 passed / 30 tests ;  pnpm test --filter contracts → 3 passed / 11 tests
$ pnpm contract:test
 Test Files  1 passed (1)      Tests  2 passed (2)       # GET /api/v1/health عبر العميل المولَّد + تحقق المخطط
$ pnpm contracts:lint
  warn   openapi.yaml is still the scaffold placeholder stub.
  43:5  warning  no-unused-components  Component: "Error" is never used.
Woohoo! Your API description is valid.   contracts:lint  OK
$ pnpm contracts:generate
contracts:generate:ts  wrote generated/ts/schema.ts
contracts:generate:native  Java runtime not found; Kotlin/Swift clients not generated.   # محليًا فقط؛ CI يثبّت Java ويسقط إن غابت
$ pnpm i18n:check   → i18n:check  server: 11 keys, ar/en in parity … OK
$ pnpm nav:check    → nav:check  OK — 35 destinations, 37 terms, ar/en complete
$ pnpm contracts:check-clients → no client sources yet (packages/web, apps/*) — nothing to check.
$ pnpm build        → packages/contracts/dist + packages/server/dist
$ pnpm db:generate  (على schema.ts لمهمة قاعدة البيانات)
[✓] Your SQL migration file ➜ drizzle/0000_abnormal_thunderbolts.sql
$ DATA_DIR=<tmp> pnpm db:migrate
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}
   (حُذف ناتج db:generate بعد التحقق؛ توليد الهجرة والتزامها من نطاق مهمة المخطط)
$ docker build -f packages/server/Dockerfile -t majlis:scaffold .     # الباني القديم (بلا buildx على هذا الجهاز)
exit=0   image majlis:scaffold 425MB
$ docker run -d --name majlis-smoke -p 18080:8080 -e HUB_ADMIN_PASSWORD=… majlis:scaffold
$ curl http://127.0.0.1:18080/api/v1/health
{"ok":true,"server_version":"0.0.0","uptime_seconds":1}
$ curl -H 'Accept-Language: ar' http://127.0.0.1:18080/api/v1/nope
{"error":"العنصر المطلوب غير موجود.","code":"not_found"}
$ docker exec majlis-smoke id
uid=10001(hub) gid=10001(hub) groups=10001(hub)
$ docker inspect --format '{{.State.Health.Status}}' majlis-smoke   → healthy
$ node scripts/check-change-record.mjs --files docs/changes/2026-09-21-twuijri-workspace-scaffold.md
change-record  OK — 1 record(s) valid
```
ملاحظات: أول بناء فشل لأن `--mount=type=cache` يحتاج BuildKit وهذا الجهاز بلا buildx؛
أُزيلت (CI يستخدم كاش GHA). ثم فشل الإقلاع لأن `yaml` كان devDependency في contracts؛
نُقل إلى dependencies وحُدّث القفل. لم يُشغَّل git في هذه المهمة (بطلب المالك)، فلم
يُختبر `change-record.yml` على diff فعلي؛ اختُبر السكربت بوضعي `--files` وسلبيًا على README.

## المخاطر والرجوع
- `openapi.yaml` المؤقت قد يحلّ محله ملف مهمة العقد في أي لحظة (متوقَّع). إن بقي، فهو
  يعلن `/health` فقط والعميل المولَّد شبه فارغ. الرجوع: حذف الملف؛ كل الأدوات تتحمّل غيابه.
- `drizzle.config.ts` يشير إلى `src/db/schema.ts` (ملف مهمة المخطط) ومجلد الهجرات `./drizzle`؛
  إن اختارت تلك المهمة مجلدًا آخر يُحدَّث `drizzle.config.ts` و`app/db.ts` (سطر واحد لكل منهما)
  و`Dockerfile`.
- better-sqlite3 يُبنى من المصدر عند `pnpm install` هنا (لم يُنزَّل بناء مسبق)؛ الصورة تبنيه
  في مرحلة `node:24-bookworm` الكاملة ثم تنسخ `node_modules` إلى `bookworm-slim`.
- الرجوع الكامل: حذف الملفات المذكورة أعلاه؛ لا أثر على بيانات أو خدمات.

## التسليم والخطوة التالية
- بعد موافقة المالك: فرع `chore/workspace-scaffold`، الالتزام، PR إلى `main` بالإنجليزية.
- مهمة العقد: استبدال `openapi.yaml` المؤقت وتعبئة `events/`؛ ثم `pnpm contracts:lint`
  و`pnpm contract:test` سيغطيان كل العمليات تلقائيًا (501 لما لم يُنفَّذ).
- مهمة المخطط: توليد الهجرة الأولى والتزامها (`pnpm db:generate`) في `packages/server/drizzle`.
- `LICENSE` للمستودع لم يُقرَّر بعد (README يقول ملكية twuijri؛ `package.json` يقول UNLICENSED مؤقتًا).
- المرحلة ٠ التالية: وحدة `auth` (حساب المالك من `HUB_ADMIN_PASSWORD` في أول إقلاع، رموز التطبيق،
  الاقتران بـQR) ثم `agents` و`sessions`.
