# تجهيز إصدار App Store وإرساله للمراجعة
المسؤول: twuijri · الفرع: ci/app-store-submit · الحالة: review

## المشكلة والهدف
المالك (٢٠٢٦-٠٩-٢٦): «ارفع لي … على متجر iOS عشان يوافقون ارفع، أعطيتك كل الأشياء اللي تحتاجها». إصدار 1.1.1 موجود في
App Store Connect بنصوصه وصوره (`ios-screenshots.yml`، التشغيل 36208321800)، والبناء 1.1.1 (110) معالَج في TestFlight.
الباقي قبل الإرسال كان يُعمل باليد: اختيار البناء، وأسئلة التصنيف العمري، والسعر والتوفر، وإقرار حقوق المحتوى، وطريقة
النشر، ثم معرفة ما ينقص.

## القرار والموافقات
- سكربت `apps/ios/scripts/asc-prepare-submission.mjs` (Node فقط، عبر مساعدات `testflight-distribute.mjs`) لإصدار معيّن:
  يربط البناء (المعطى، وإلا أحدث بناء VALID للإصدار)، ويجيب أسئلة التصنيف العمري من جدول `docs/store/apple/README.md`
  (بيانات في السكربت، 13+)، ويجعل التطبيق مجانيًا (0.00، الإقليم الأساسي USA) إن لم يُحدَّد سعر، ومتاحًا في كل الأقاليم
  إن لم يُحدَّد توفر، ويعلن «لا يستخدم محتوى طرف ثالث» إن لم يُعلَن شيء، ويجعل النشر يدويًا بعد الموافقة (`MANUAL`)،
  ثم يطبع ما ينقص.
- **مقترح — للمالك أن يؤكد:** التوفر في كل الأقاليم **ما عدا الصين القارية** (`EXCLUDED_TERRITORIES = ['CHN']`)، لأنها
  تتطلب رقم تسجيل ICP وترخيصًا لميزات الذكاء الاصطناعي التوليدي، وبدونها تعطّل مراجعة Apple الإصدار. الأقاليم الجديدة
  تُضاف تلقائيًا (`availableInNewTerritories`). إن أراد المالك الصين تُحذف من القائمة.
- وضع `--submit`: يعيد الخطوات نفسها، ولا يرسل إلا إذا لم ينقص شيء؛ وإلا يخرج بـ 1 ويعدّد الناقص. يعيد استعمال طلب
  مراجعة مسودة إن وُجد، ولا يرسل مرتين. **لا يكتب اسم حساب التجربة ولا كلمة مروره أبدًا، ولا يطبعها.**
- App Privacy: الواجهة العامة لـ App Store Connect ليس لها أي نقطة لقراءته أو كتابته (بحثت في فهرس وثائق Apple للواجهة
  في ٢٠٢٦-٠٩-٢٦: لا شيء باسم privacy أو dataUsage). لذلك يظهر دائمًا في التقرير كفحص المالك نفسه، وApple ترفض
  الإرسال إن لم يُنشر.
- أسماء الحقول وقيمها من وثائق Apple (`AgeRatingDeclaration.Attributes`): القيم الجديدة `INFREQUENT`/`FREQUENT`، ويرجع
  السكربت للأسماء القديمة `INFREQUENT_OR_MILD` إن رفضها الخادم، ويترك أي سؤال لا يعرفه الخادم ويذكره في الناقص.
- مسار عمل `ios-submit.yml` يدوي فقط (`workflow_dispatch`) بمدخلات `version` و`build` و`submit` (افتراضيًا false)،
  ويكتب المفتاح بـ `asc-api-key-json.sh` مثل بقية مسارات iOS ويحذفه في النهاية.
- `AscError` صار يحمل أخطاء Apple (`errors`) ليعرف السكربت أي حقل رُفض؛ لا يتغير سلوك `testflight-distribute.mjs`.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- جديد: `apps/ios/scripts/asc-prepare-submission.mjs`، `apps/ios/scripts/asc-prepare-submission.test.mjs`،
  `.github/workflows/ios-submit.yml`.
- `apps/ios/scripts/testflight-distribute.mjs` (حقل `errors` في `AscError`).
- `docs/store/apple/README.md`، `docs/RELEASING.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (Node 24):

```
$ pnpm scripts:test
  ✔ attaches the given build, sets manual release and content rights, and never submits
  ✔ picks the newest VALID build of the version when no number is given
  ✔ does not attach a build that is not VALID, and lists it
  ✔ leaves an attached build, release type and content rights alone
  ✔ answers the age rating questionnaire of the editable App Information
  ✔ falls back to the older frequency names and lists questions App Store Connect does not know
  ✔ makes the app free and available everywhere but the excluded territories when unset
  ✔ leaves a price and availability that are already set
  ✔ reports what only the owner can enter, without printing the demo password
  ✔ lists nothing when everything the API can see is complete
  ✔ --submit refuses while App Review Information is incomplete
  ✔ --submit adds the version to a review submission and submits it when complete
  ✔ changes nothing on a version that is already waiting for review
✔ asc-prepare-submission
ℹ tests 26
ℹ pass 26
ℹ fail 0
$ pnpm lint
All matched files use Prettier code style!
```

أثناء الكتابة كشف الاختبار خطأً حقيقيًا: مقارنة الإجابة بالاسم القديم كانت تعدّ السؤال غير المُجاب (`undefined`) مُجابًا،
فلا يُرسل؛ صُحّح قبل الـcommit. لم يُشغَّل `actionlint` (غير مثبت)؛ صحة YAML فُحصت بـ `yaml.safe_load`.

التشغيل الحقيقي: **لم يُشغَّل بعد.** GitHub لا يقبل تشغيل مسار `workflow_dispatch` غير موجود في الفرع الافتراضي:

```
$ gh workflow run ios-submit.yml --repo twuijri/core-hub --ref night/2026-09-27 -f version=1.1.1 -f build=110 -f submit=false
HTTP 404: Not Found (https://api.github.com/repos/twuijri/core-hub/actions/workflows/ios-submit.yml)
```

طريقة التسجيل البديلة (فرع مؤقت بمشغّل `push` يتخطّى الوظيفة) رُفضت بصلاحيات الجلسة، فلم تُجرَّب. يُشغَّل بعد دمج #165 في
`main` (أو بإذن المالك لتلك الطريقة) بالمدخلات `version=1.1.1` و`build=110` و`submit=false`.

CI على #165 (التشغيل 36210610471، رأس يحتوي f74b7e8b): خطوة «Release script tests (apps/ios/scripts, against fake APIs)»
نجحت (`ℹ pass 26`، `ℹ fail 0`)، و«Change record» و«iOS store listing» نجحا. فشل واحد ليس من هذه المهمة: `status.test.ts`
(«the contract grew or shrank: update docs/STATUS.md: expected 329 to be 337») من عمليات عقد أضافتها مهام أخرى.

## المخاطر والرجوع
- التشغيل الحقيقي يغيّر حالة التطبيق في App Store Connect (البناء، التصنيف، السعر، التوفر، الحقوق، طريقة النشر)؛ كلها
  قابلة للتعديل يدويًا بعد ذلك. لا إرسال للمراجعة بدون `submit`.
- إن كان دور مفتاح API لا يسمح بالسعر أو التوفر (يحتاج Admin أو App Manager) يفشل التشغيل برسالة Apple.
- الرجوع: استرجاع الـcommit؛ وما تغيّر في App Store Connect يُعدَّل من صفحاته.

## التسليم والخطوة التالية
دُمج في `night/2026-09-27` (#165). تشغيل المسار مرة بـ `submit=false` بعد وصوله إلى `main`، ثم يكمل المالك في App Store Connect ما يطبعه التقرير، ثم يشغّله
بـ `submit`.
