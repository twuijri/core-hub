# تصدير البروفايل واستيراده (المرحلة ٢ من ADR 0014)
المسؤول: twuijri · الفرع: feat/profile-export-import · الحالة: review

## المشكلة والهدف
`docs/STATUS.md` كان يقول في صفّ `auth`: «التصدير والاستيراد ما زالا يضعان مهمة في الطابور ولا
شيء يشغّلها». العمليتان `auth.exportProfile` و`auth.importProfile` كانتا تجيبان `202` بمهمة تبقى
`queued` إلى الأبد. الهدف (المرحلة ٢ من ADR 0014): تصدير بروفايل إلى أرشيف هرمز نفسه يُنزَّل من
المجلس، واستيراد أرشيف ليصير بروفايلًا جديدًا، عبر مهمة حقيقية على `/rt/jobs`، بلا تسريب مفاتيح
المزوّدين (ADR 0010)، ومن صفحة الإعدادات ← البروفايلات.

## القرار والموافقات
ما قرأته من مصدر هرمز (MIT، داخل الصورة `/opt/hermes/src`، الوسم `v2026.9.14`):
- `hermes_cli/profiles.py` §`export_profile`: بروفايل مسمّى يُنسخ مجلده كله **ما عدا** `.env`
  و`auth.json`؛ والبروفايل الافتراضي (جذر البيت) قائمة سماح فقط (config وSOUL وMEMORY وskills وcron
  وsessions …، لا `state.db` ولا `logs` ولا `profiles/`). وفي الحالتين يطمس هرمز النصوص التي
  تشبه الأسرار في الملفات النصية. الأرشيف `tar.gz` بصيغة GNU فيه مجلد واحد باسم البروفايل.
- `import_profile`: مجلد واحد في الأعلى، يرفض `default` والاسم الموجود (`FileExistsError`)، ويفك
  الملفات والمجلدات العادية فقط.
- لوحة هرمز (`hermes serve`، ADR 0015) فيها `POST /api/profiles/{name}/export` و
  `POST /api/profiles/import`، وتتبادل **مسارات** لا بايتات (نفس نظام الملفات).

القرارات (مقترحة — للمالك أن يؤكد ما هو اختيار منتج جديد):
- **عبر خادم هرمز** (ADR 0015) لا عبر CLI، كما طُلب؛ فهي تعمل فقط حيث يشغّل المجلس هرمز بنفسه.
  غير ذلك (هرمز خارجي) يُجاب قبل إنشاء أي مهمة: `409 state_invalid` مع
  `details.reason = hermes_not_supervised` — الاسم نفسه الذي اعتمده §30 لأدوات الوكيل.
- **قفل ثانٍ على المفاتيح**: لا يُكتفى بما يفعله هرمز. المجلس يعيد كتابة الأرشيف تدفّقًا
  (`auth/profile-archive.ts`: gunzip ← tar كتلة كتلة ← gzip، بلا تحميل الملف في الذاكرة)، يحذف كل
  `.env` و`auth.json` في أي عمق، ويطمس **كل مفتاح مزوّد مخزَّن في المجلس** (ومفتاح خادم API لهرمز)
  أينما ظهرت بايتاته، في أي ملف ولو ثنائيًا (`state.db`)، بنجوم بنفس الطول فيبقى الأرشيف صالحًا.
  النتيجة تذكر `removed` و`masked`، والواجهة تقول ذلك. — *مقترح، للمالك أن يؤكد.*
- **أين يُحفظ وكم**: الأرشيف الناتج مرفق تحت `/data/attachments/<بروفايل>/kept/<ulid>`
  (`source_kind = export`)، **لصاحب الطلب وحده** (غيره يرى `404` ولو كان في البروفايل نفسه)، لا
  يظهر في قائمة ملفات المعرفة، و**يُحذف بعد ٢٤ ساعة** (مسح عند الإقلاع وكل ساعة). حد الأرشيف ١
  غيغابايت. — *مقترح، للمالك أن يؤكد المدة.*
- **الاستيراد**: رفع الملف بـ `purpose: import` (حد الرفع الحالي ٥٠ ميغابايت)، ثم المهمة تتحقق أنه
  أرشيف بروفايل (مجلد واحد، لا روابط، لا مسارات خارجه، لا يتفكك لأكثر من ٤ غيغابايت)، وتطلب من هرمز
  إنشاءه بالمعرّف المطلوب، ثم تضيف البروفايل باسمه. المعرّف المأخوذ يُرفض قبل المهمة (`409`)،
  والواجهة تقترح معرّفًا حرًّا من اسم الملف (`design` ← `design-2`). الملف المرفوع يُحذف بانتهاء
  المهمة. رفض هرمز يعود بكلماته: «Hermes refused to import the archive: Profile 'x' already exists».
- **أين تعيش المهمة**: العمليتان عالميتان، والمهمة تُسجَّل في البروفايل الحالي للطالب
  (`X-Hub-Profile`) لتصل غرفته على `/rt/jobs` ويجدها `jobs.get` (قرار العقد §33؛ §30–§32 محجوزة).
- مجلد العمل المؤقت `/data/tmp/profile-transfer/<job>/` يُحذف بانتهاء المهمة أيًّا كانت نتيجتها.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `auth.exportProfile`: وصف كامل (ما في الأرشيف، ما يُحذف، النتيجة `{attachment_id, profile, name,
  size_bytes, expires_at, removed, masked}`، المدة) واستجابة `409`.
- `auth.importProfile`: وصف كامل، `404`، والحقل الاختياري `name` في `ProfileImport`.
- `JobKind` + `import`؛ `ResourceRef.kind` + `profile` و`attachment` (في OpenAPI وكل مخططات
  الأحداث التي تحملها).
- `docs/contracts/DECISIONS.md` §33.

## الملفات والتأثير
- الخادم: `auth/profile-archive.ts` (جديد: قراءة/إعادة كتابة tar.gz تدفّقًا)، `auth/profile-transfer.ts`
  (جديد: المنفذ ومهمتا التصدير والاستيراد)، `auth/routes.ts` (المساران)، `auth/index.ts`،
  `auth/testing/{tar,fake-profile-runtime}.ts` (للاختبارات ولمركز e2e)؛ `agents/hermes-profiles.ts`
  (`createHermesProfileArchives` فوق خادم هرمز بمهلة ١٠ دقائق)؛ `knowledge` (`keepExport`،
  `discardUpload`، حجب ملف التصدير عن غير صاحبه وبعد انتهائه، إخفاؤه من القائمة، المسح الدوري،
  `BlobStore.keepCopy`، `AttachmentStore.purge`)؛ `models` (`storedSecretValues` للفحص وحده)؛
  `modules/index.ts` (الربط)؛ رسائل الخادم باللغتين.
- الويب: `people/ProfileTransfer.tsx` (جديد: حوار التصدير بالتقدم والتنزيل التلقائي وتنبيه المفاتيح،
  وحوار الاستيراد باختيار الملف والمعرّف والاسم وتقدم الرفع ثم المهمة)، `WorkspacesTab.tsx` (زرّا
  «تصدير» لكل بروفايل و«استيراد»)، `people/queries.ts` (`useFollowedJob`: أحداث `/rt/jobs` مع قراءة
  كل ثانية حتى النهاية)، النصوص باللغتين (المصطلحات اللاتينية معزولة بـ LRI/PDI).
- الاختبارات: `auth/profile-archive.test.ts`، `tests/unit/profile-transfer.test.ts`،
  `auth/profile-transfer.real.test.ts` (هرمز الحقيقي)، إضافات في `hermes-profiles.test.ts`
  و`hermes-dashboard.test.ts` و`auth.contract.test.ts`، `web/tests/profile-transfer.test.tsx`،
  ورحلة Playwright `e2e/zzzz-profile-transfer.spec.ts` مع لقطتين.
- الوثائق: `docs/STATUS.md`، DECISIONS §33.

## الفحوص (الأوامر ونواتجها الفعلية)
كل أمر ثقيل عبر `mj-run` (عاملان لـ vitest، حد ٧ غيغابايت)، بعد دمج `origin/main` (4123ff3، مع #84 و#85):
```
$ pnpm --filter @majlis/server test
 Test Files  83 passed | 10 skipped (93)
      Tests  882 passed | 27 skipped (909)
$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  255 passed (255)
$ pnpm --filter @majlis/web test
 Test Files  43 passed (43)
      Tests  534 passed (534)
$ pnpm --filter @majlis/contracts test
      Tests  15 passed (15)
$ MAJLIS_HERMES_IMAGE=majlis:profexport vitest run src/modules/auth/profile-transfer.real.test.ts
export job: 2051 ms {"profile":"design","name":"design-20260924-135651.tar.gz","size_bytes":899414,"expires_at":"2026-09-25T13:56:51Z","removed":[],"masked":[]}
 ✓ exports a profile with its SOUL and memory, and imports it under a new name 6223ms
      Tests  1 passed (1)
$ pnpm contracts:lint            → contracts:lint  OK
$ pnpm contracts:check-clients   → check-clients  OK — 241 client file(s) scanned, 167 contract path(s) known.
$ pnpm i18n:check                → i18n:check  OK (server 136, cli 249, web 986 keys)
$ pnpm nav:check                 → nav:check  OK — 34 destinations
$ pnpm typecheck / eslint . / prettier --check . / pnpm build → بلا أخطاء
$ PLAYWRIGHT_CHANNEL=chrome npx playwright test --workers=1
  36 passed (2.4m)
```
- **هرمز الحقيقي** (صورة محلية `docker build -f packages/server/Dockerfile`): بروفايل `design` فيه SOUL
  وذاكرة مميّزتان و`.env` فيه مفتاح مخزَّن في المجلس أيضًا ← صُدِّر عبر مسار المجلس (`hermes serve`
  كتب الأرشيف) ← نُزِّل: فيه `design/SOUL.md` و`design/memories/MEMORY.md` بنفس المحتوى، بلا `.env`،
  والمفتاح غير موجود في البايتات ← رُفع واستُورد باسم `design-copy`: بروفايل هرمز الجديد فيه SOUL
  والذاكرة نفسها بلا `.env`، وظهر في القائمة ← استيراد باسم يملكه هرمز (`taken`) رُفض بكلمات هرمز.
  وتصدير البروفايل الافتراضي (جذر البيت) لا يحوي `.env` ولا `profiles/` ولا `state.db` ولا المفتاح.
  مجلد العمل المؤقت يُفرَّغ، ولم تبقَ حاويات بعد الاختبار.
- **الاختبارات تلتقط غياب الإصلاح**: بإعادة `auth/routes.ts` إلى نسخة `main` سقطت الستة في
  `tests/unit/profile-transfer.test.ts` (`Tests  6 failed (6)`).
- قبل الدمج الأخير فشلت رحلة `zzz-profiles` مرة (تعدّ ردود المساعد قبل تحميلها) ونجحت بإعادتها؛
  أصلحها #84 في `main`، وبعد دمجه نجحت الرحلات كلها (٣٦).

## المخاطر والرجوع
- التصدير يحمل **ذاكرة البروفايل ومحادثاته** (هذا قرار هرمز لبروفايل مسمّى)؛ لذلك الملف لصاحبه
  وحده ولمدة يوم. مفتاح لا يعرفه المجلس (كُتب يدويًا بصيغة لا يلتقطها طمس هرمز) لا يستطيع المجلس
  معرفته؛ الواجهة تقول بالضبط ما يُحذف.
- حد الرفع ٥٠ ميغابايت يمنع استيراد أرشيف أكبر (بروفايل بتاريخ محادثات طويل)؛ رفع الحد مسألة منفصلة.
- الرجوع: إرجاع الفرع يعيد العمليتين إلى المهمة المعلّقة؛ الأرشيفات المحفوظة تُمسح بانتهاء مدتها،
  والبروفايلات المستوردة تبقى في هرمز.

## التسليم والخطوة التالية
PR إلى `main`. الدمج للمالك. للمالك أن يؤكد: الطمس الإضافي، ومدة ٢٤ ساعة، وحصر التنزيل على صاحبه.
بعد ذلك: المرحلة ٤ من ADR 0014.
