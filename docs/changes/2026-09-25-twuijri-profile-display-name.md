# إعادة تسمية أي بروفايل، والافتراضي منه، باسم يراه هرمز أيضًا
المسؤول: twuijri · الفرع: feat/profile-display-name · الحالة: review

## المشكلة والهدف
سأل المالك (2026-09-25): «هل هرمز ما تدعم اني اقدر اغير اسمه او احطه اي اسم» — عن البروفايل
الافتراضي. الهدف: في الإعدادات ← البروفايلات يأخذ كل بروفايل، والافتراضي منه، أي اسم بأي لغة، يظهر في
كل مكان يُذكر فيه البروفايل، ويكتبه المركز في هرمز أيضًا فيتفق الطرفان؛ ومعرّف الافتراضي يبقى `default`،
ومعرّف البروفايل المسمّى ومجلده في هرمز ثابتان.

ما وجدته في `main` (قبل هذا الفرع):
- **الويب** فيه «إعادة تسمية» على كل بطاقة، والافتراضي منها، ويرسل `name` فقط. يعمل في المركز.
- **الاسم لا يصل هرمز**: `auth.updateProfile` يغيّر صف المركز وحده؛ `hermes profile list` يبقى يقول
  `default` والمعرّف المجرد لكل بروفايل مسمّى.
- **تغيير المعرّف** (`slug` في `PATCH`، لا يرسله الويب لكن العقد يقبله لبروفايل مسمّى): يتغيّر في
  المركز ولا يتغيّر مجلد هرمز، والمركز يصل هرمز بالمعرّف (`runtimeProfileName`) — فيصير البروفايل
  مشيرًا إلى بروفايل هرمز غير موجود، والقائمة التالية تتبنّى المجلد القديم بروفايلًا جديدًا (من قراءة
  `profile-mirror.ts` و`routes.ts`؛ الاختبار الجديد يثبت الرفض الآن).
- مواضع تُظهر معرّف هرمز بدل الاسم: قائمة بوابات المراسلة في صفحة الوكلاء (والافتراضي نص ثابت
  «البروفايل الافتراضي»)، ورسالة «هذا البوت مربوط في البروفايل …» في ربط تيليجرام، واسم ملف التصدير
  (`<slug>-…tar.gz`). أما مبدّل البروفايل في الأعلى وشارات القوائم (المحادثات، المهام، الجداول، البحث)
  فكانت تعرض الاسم أصلًا (`useProfileName`) وتتحدّث بعد إعادة التسمية.

## القرار والموافقات
ما قرأته من مصدر هرمز (MIT، الوسم `v2026.9.14`، `hermes_cli/profiles.py` و`profile_cmd.py`
و`web_routers/profiles.py`):
- `display_name` حقل عرض فقط في `profile.yaml` داخل مجلد البروفايل، حده ٦٤ حرفًا، يظهر بجانب المعرّف
  (`الاسم (المعرّف)` في `list` و`show`) ولا يُستعمل أبدًا للوصول إلى البروفايل. الفارغ يحذفه.
- `hermes profile rename default <name>`: `default` محجوز، فالأمر يكتب `display_name` فقط ويبقى المعرّف.
- `rename` لبروفايل مسمّى **ينقل المجلد**: يوقف بوابته، ويعيد كتابة الاسم المستعار ومضيف Honcho
  و`active_profile`. ولا يوجد في هرمز أمر أو واجهة تكتب اسم العرض وحده لبروفايل مسمّى (`PATCH
  /api/profiles/{name}` هو `rename` نفسه).

القرارات (مقترحة — للمالك أن يؤكد):
- **الاسم = اسم العرض في هرمز، على الطرفين.** إعادة التسمية تكتب في هرمز أولًا: للافتراضي بأمر هرمز نفسه
  `hermes profile rename -- default <الاسم>`؛ وللمسمّى يكتب المركز المفتاح نفسه `display_name` في
  `profiles/<slug>/profile.yaml` كما يفعل هرمز (`write_profile_meta`): بقية المفاتيح (الوصف) تبقى، الفارغ
  يحذف المفتاح، والكتابة ملف مؤقت ثم إعادة تسمية واحدة. اسم يساوي المعرّف يمسح اسم العرض (هرمز يعرض
  المعرّف مجردًا). إن رفض هرمز لا يتغيّر شيء: `409 hermes_refused` بكلمات هرمز، والحوار يعرضها.
- **المعرّف لا يتحرّك.** حيث يعكس المركز هرمز يُرفض تغيير المعرّف قبل أي كتابة (`409 profile_id_fixed`)،
  ولا يُنقل مجلد أي بروفايل: عليه تعتمد القنوات والجداول والمحادثات، ونقله يوقف البوابة. بلا هرمز
  (فلتر المركز وحده) يبقى تغيير معرّف المسمّى ممكنًا كما كان. — *مقترح.*
- **الإنشاء والاستيراد** يكتبان الاسم في هرمز بالطريقة نفسها، بلا إفشال العملية (البروفايل موجود
  حينها؛ الرفض يُسجَّل في السجل، وإعادة التسمية التالية تكتبه). الاستيراد يكتب حتى الاسم الفارغ، لأن
  الأرشيف يحمل اسم عرض مصدره.
- **الحد ٦٤ حرفًا** (حد هرمز) للاسم في الإنشاء والتعديل والاستيراد، بعد قصّ المسافات (كان ٨٠).
- **ملف التصدير** باسم البروفايل: `الرئيسي-20260925-101500.tar.gz` (بلا الفواصل والرموز الممنوعة في
  أسماء الملفات وعلامات الاتجاه؛ المعرّف إن لم يبقَ شيء). الاستيراد يقترح الاسم من الملف، والمعرّف كما
  كان (فارغ لاسم عربي ليكتبه الشخص). — *مقترح.*
- قرار العقد §44 (§43 أخذها فرع مسار المحادثة).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- مخطط جديد `ProfileName` (نص مقصوص، ١–٦٤، وصفه اسم العرض في هرمز) لـ `ProfileCreate.name`
  و`ProfilePatch.name` و`ProfileImport.name`. `Profile.name` في الأجوبة يبقى ٨٠ للصفوف القديمة.
- `auth.updateProfile`: وصف كامل لإعادة التسمية والكتابة في هرمز، و`409` بسببي `hermes_refused`
  و`profile_id_fixed`؛ وصف `ProfilePatch.slug`.
- `auth.exportProfile`: اسم الملف `<اسم البروفايل>-<YYYYMMDD-HHMMSS>.tar.gz`.
- `docs/contracts/DECISIONS.md` §44. لا مسار ولا حدث جديد.

## الملفات والتأثير
- الخادم: `agents/hermes-profiles.ts` (`setDisplayName`، `writeDisplayName`)، `modules/index.ts` (المنفذ)،
  `auth/profile-mirror.ts` (`setDisplayName` في المنفذ، `runtimeDisplayName`، `mirrorDisplayName`)،
  `auth/profiles.ts` (الكتابة عند إنشاء أو استيراد، `PROFILE_NAME_MAX`)، `auth/routes.ts` (ترتيب الرفض
  ثم هرمز ثم المركز، `ProfileName`)، `auth/profile-transfer.ts` (`archiveStemOf`)، رسالتان جديدتان باللغتين.
- الويب: `people/WorkspacesTab.tsx` (عنوان الحوار باسم البروفايل، شرح أن المعرّف يبقى وأن هرمز يعرض
  الاسم، حد ٦٤، رفض هرمز داخل الحوار)، `people/ProfileTransfer.tsx` (`nameFromArchive`)،
  `people/queries.ts`، `agents/AgentManagerScreen.tsx` (البوابات باسم البروفايل)، `agents/toolErrors.ts`
  و`AgentChannelsScreen.tsx` (رسالة البوت المربوط باسم البروفايل)، النصوص باللغتين.
- الاختبارات: `tests/unit/profile-mirror.test.ts` (سبع حالات)، `agents/hermes-profiles.test.ts` (ثلاث)،
  `hermes-profiles.real.test.ts` (هرمز الحقيقي)، `tests/unit/profile-transfer.test.ts`،
  `web/tests/profile-rename.test.tsx`، رحلة `e2e/zzzzzz-profile-rename.spec.ts` مع لقطة، وتحديث توقّع
  اسم الملف في `e2e/zzzz-profile-transfer.spec.ts` ولقطتيه.
- الوثائق: `docs/STATUS.md`، DECISIONS §44.

## الفحوص (الأوامر ونواتجها الفعلية)
كل أمر ثقيل عبر `mj-run`. محليًا فقط ما لمسته (قاعدة السرعة)؛ CI يشغّل الباقي.
```
$ vitest run tests/unit/profile-mirror.test.ts src/modules/agents/hermes-profiles.test.ts tests/unit/profile-transfer.test.ts
 Test Files  3 passed (3)
      Tests  27 passed (27)
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  271 passed (271)
$ vitest run tests/profile-rename.test.tsx tests/profile-transfer.test.tsx      (web)
 Test Files  2 passed (2)
      Tests  11 passed (11)
$ COREHUB_HERMES_IMAGE=majlis:local vitest run src/modules/agents/hermes-profiles.real.test.ts --reporter=verbose
 ✓ … creates from scratch and as a copy, refuses an existing name, and lists both 2251ms
 ✓ … names default and a named profile the way Hermes shows them, ids and folders unmoved 5053ms
      Tests  2 passed (2)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzz-profile-transfer.spec.ts e2e/zzzzzz-profile-rename.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zzzz-profile-transfer.spec.ts:36:3 › profile export and import › exports a profile without its keys, and imports the file as a new profile (3.2s)
  ✓  2 [chromium] › e2e/zzzzzz-profile-rename.spec.ts:39:3 › renaming a profile › renames the default profile to «الرئيسي» and the top chip says it (1.2s)
  2 passed (10.6s)
$ pnpm lint            → All matched files use Prettier code style! (exit 0)
$ pnpm typecheck       → exit 0
$ pnpm contracts:lint  → contracts:lint  OK
$ pnpm contracts:check-clients → check-clients  OK — 270 client file(s) scanned, 174 contract path(s) known.
$ pnpm i18n:check      → i18n:check  OK
$ pnpm nav:check       → nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
```
- **هرمز الحقيقي** (صورة `majlis:local`: `Hermes Agent v0.21.3 (2026.9.14)`، الوسم المثبّت نفسه):
  بعد `setDisplayName('default','الرئيسي')` و`setDisplayName('design','فريق التصميم')` قال هرمز نفسه
  `Profile: الرئيسي (default)` و`Profile: فريق التصميم (design)`؛ الوصف الذي كتبه `hermes profile
  describe` بقي؛ القائمة والمجلدات كما هي؛ الاسم الفارغ أعاد `Profile: design`؛ واسم يبدأ بشرطة وصل
  سليمًا عبر `--`. كل `docker run` بـ `--rm`، ومجلدات البيوت المؤقتة حُذفت.
- **الاختبارات تلتقط غياب التغيير**: بإعادة `packages/server/src` و`packages/web/src` إلى `main` سقطت
  ثمانٍ في الخادم (`Tests  8 failed | 16 passed (24)`) والخمس في الويب (`Tests  5 failed (5)`).
- CI: يُضاف بعد الدفع.

## المخاطر والرجوع
- تغيير المعرّف عبر الواجهة البرمجية صار مرفوضًا حيث يعكس المركز هرمز. لم يكن الويب يرسله؛ عميل
  خارجي كان يعتمد عليه يتلقى `409 profile_id_fixed` بدل حالة متناقضة.
- اسم أطول من ٦٤ حرفًا يُرفض الآن (`400`)؛ الأسماء المخزّنة سابقًا بين ٦٥ و٨٠ تبقى وتُقرأ، وتعديلها
  يحتاج اسمًا ضمن الحد.
- اسم البروفايل الافتراضي الذي يُعطى عند الإعداد الأول لا يُكتب في هرمز حتى أول إعادة تسمية
  (لا مزامنة عند الإقلاع). وبروفايل يتبنّاه المركز من هرمز يأخذ معرّفه اسمًا ولا يقرأ اسم العرض من هرمز.
- لقطات التصدير والاستيراد تتغيّر في كل تشغيل (الختم الزمني في اسم الملف)، كما قبل.
- الرجوع: إرجاع الفرع يعيد السلوك السابق؛ `display_name` المكتوب في هرمز يبقى عرضًا فقط ولا يضر.

## التسليم والخطوة التالية
PR إلى `main`. الدمج للمالك. للمالك أن يؤكد: رفض تغيير المعرّف حيث يعمل هرمز، وحد ٦٤، وتسمية ملف
التصدير بالاسم. بعد ذلك إن أراد: قراءة اسم العرض من هرمز عند تبنّي بروفايلاته، وكتابة اسم الافتراضي
عند الإعداد الأول.
