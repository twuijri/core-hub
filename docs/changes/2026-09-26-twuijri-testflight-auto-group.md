# إضافة بناء TestFlight إلى مجموعة Owner تلقائيًا
المسؤول: twuijri · الفرع: ci/testflight-auto-group · الحالة: review

## المشكلة والهدف
`ios-signed.yml` يرفع البناء إلى TestFlight بـ`altool` عند تفعيل `upload_testflight`. المجموعة
الداخلية «Owner» في App Store Connect مضبوطة على «Build Distribution: Automatic for Xcode Builds»،
أي أنها لا تأخذ إلا ما يُرفع من Xcode نفسه، فالبناء القادم من CI لا يدخلها. كان المالك يضيف كل بناء
بيده: TestFlight ← المجموعة ← Builds ← +. الهدف: بعد رفع ناجح يُضاف البناء إلى المجموعات تلقائيًا
بمفتاح App Store Connect الذي يستعمله الـworkflow أصلًا.

## القرار والموافقات
- مدخل جديد `testflight_groups` (افتراضيًا `Owner`، أسماء مفصولة بفواصل، الفارغ لا يضيف شيئًا).
- سكربت `apps/ios/scripts/testflight-distribute.mjs` بمكتبات Node المدمجة فقط: JWT من نوع ES256
  (يُجدَّد كل ١٠ دقائق لأن الانتظار قد يتجاوز عمر الرمز، ولا يُطبع أبدًا)، البحث عن التطبيق بـ
  `com.twuijri.corehub`، انتظار `processingState = VALID` عبر `GET /v1/builds` بالفلاتر الثلاثة
  (رقم البناء ورقم الإصدار)، ثم `GET /v1/apps/{id}/betaGroups` و`POST
  /v1/builds/{id}/relationships/betaGroups` باستدعاء واحد لكل المجموعات.
- التأخر: بعد ٣٠ دقيقة يتوقف الانتظار بتحذير ظاهر (`::warning::`) لا بفشل، مع طريقة الإضافة اليدوية.
  أخطاء الشبكة و٤٢٩ و5xx أثناء الانتظار تُعاد المحاولة. `FAILED`/`INVALID` أو تطبيق غير موجود أو اسم
  مجموعة غير موجود يُفشل الخطوة، والخطأ يسرد مجموعات التطبيق.
- `MISSING_EXPORT_COMPLIANCE` (من `buildBetaDetail.internalBuildState`): تحذير بطريقة الحل، ويُضاف
  البناء إلى المجموعات مع ذلك. **لا** يجيب السكربت عن التشفير نيابةً عن المالك عبر الـAPI، لأنه
  إقرار قانوني — مقترح، والمالك يؤكد.
- المجموعات الخارجية: يُضاف إليها البناء، مع ملاحظة أن مختبريها لا يرونه إلا بعد Beta App Review،
  والـworkflow لا يرسل للمراجعة.
- مهلة المهمة `signed` صارت ٩٥ دقيقة بدل ٦٠ لتتسع للانتظار، ومهلة الخطوة ٣٥ دقيقة. لم يُغيَّر اسم
  أي مهمة.
- اختبارات السكربت بـ`node:test` على خادم App Store Connect وهمي، عبر `pnpm scripts:test`، وخطوة
  جديدة في مهمة CI الأولى.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `apps/ios/scripts/testflight-distribute.mjs` (جديد) و`apps/ios/scripts/testflight-distribute.test.mjs` (جديد).
- `.github/workflows/ios-signed.yml`: المدخل `testflight_groups`، خطوة «Add the build to TestFlight
  groups» بعد الرفع، حفظ `BUILT_VERSION` في خطوة الفحص، مهلة المهمة.
- `.github/workflows/ci.yml`: خطوة `pnpm scripts:test`.
- `package.json`: السكربت `scripts:test`.
- `docs/RELEASING.md` و`docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm scripts:test
✔ makeToken (…)
✔ parseGroups (…)
▶ distribute
  ✔ finds the app, waits for processing, and adds the build to the group
  ✔ never prints the token
  ✔ adds to several groups in one call and says external groups need Beta App Review
  ✔ gives up after the timeout with a warning, not a failure, and adds nothing
  ✔ keeps polling through a 5xx or a rate limit
  ✔ fails when Apple rejects the build
  ✔ reports missing export compliance and still adds the build
  ✔ fails on an unknown group, naming the ones that exist, after adding the known ones
  ✔ fails when the app is not in App Store Connect
  ✔ does nothing without groups
  ✔ remakes the token while waiting longer than one token lives
ℹ tests 13
ℹ pass 13
ℹ fail 0
$ python3 -c "import yaml; yaml.safe_load(open(f))"  # ci.yml و ios-signed.yml
ok .github/workflows/ci.yml
ok .github/workflows/ios-signed.yml
$ pnpm lint
All matched files use Prettier code style!
$ pnpm change-record:check
change-record  OK — 1 record(s) valid
```
CI على PR #159 (commit `0bfc984e`): كل الفحوص الـ13 ناجحة، ومنها خطوة «Release script tests» في
مهمة «Lint, typecheck, contracts, client tests, build»:
```
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

## المخاطر والرجوع
- لم يُجرَّب على App Store Connect الحقيقي؛ الاختبارات على خادم وهمي فقط. أول تشغيل يدوي بـ
  `upload_testflight` هو الإثبات. لم أشغّل الـworkflow.
- المفتاح يحتاج صلاحية إدارة TestFlight (Admin أو App Manager، كما هو مطلوب أصلًا للملفات الشخصية).
- إن أبطأت Apple أكثر من ٣٠ دقيقة يبقى البناء خارج المجموعة مع تحذير، ويضيفه المالك بيده كما قبل.
- الرجوع: استرجاع الـcommit، أو تشغيل الـworkflow مع `testflight_groups` فارغًا.

## التسليم والخطوة التالية
PR إلى `main` (لا دمج). بعد الدمج: تشغيل *iOS signed build* يدويًا مع `upload_testflight` والتأكد
أن البناء ظهر في مجموعة Owner.
