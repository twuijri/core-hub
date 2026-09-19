# تحديث تطبيق الجوال من داخل التطبيق: الجانب الخادمي

المسؤول: twuijri
الفرع: feat/mobile-app-updates
الحالة: review

## المشكلة والهدف

بناء «Core Hub Test» للأندرويد يُنشر في الإصدار المتحرك `latest-test-mobile`
داخل المستودع الخاص `twuijri/core-hub-test-builds`. لتحميله يحتاج الجهاز رمز
GitHub، ولا يجوز أن يحمل الهاتف رمزًا كهذا.

الهدف: يسأل الهاتف خادم Core Hub الخاص بصاحبه، والخادم وحده يقرأ الإصدار الخاص
برمز يضبطه المالك مرة واحدة على الخادم. هذا التغيير هو الجانب الخادمي فقط؛ عميل
الأندرويد يُنفَّذ بالتوازي على العقد نفسه.

خارج النطاق: واجهة ويب لضبط الإعداد، دعم iOS للتثبيت من داخل التطبيق (تبقى
TestFlight)، وأي تعديل على مسار البناء في `test-track.yml`.

## القرار والموافقات

- التصميم اختاره المالك بنفسه: الهاتف بلا رمز، والخادم وسيط يقرأ ويبثّ.
- العقد مثبَّت كما سُلِّم (لم يُغيَّر حرف منه) لأن عميل الأندرويد يُبنى عليه:
  - `GET /api/studio/app-updates/mobile?platform=android&channel=test` →
    `{ available, version, buildNumber, notes, sizeBytes, publishedAt, downloadPath }`
    و`downloadPath` مسار خادم دائمًا، لا رابط GitHub.
  - `GET /api/studio/app-updates/mobile/download?platform=android&channel=test`
    يبثّ الملف مع `Content-Length` ونوع `application/vnd.android.package-archive`
    ودعم Range (206/416) لاستئناف تحميل منقطع.
  - `GET/PUT /api/studio/app-updates/settings` و
    `DELETE /api/studio/app-updates/settings/token`.
- المصادقة: المسارات تحت `/api` محمية أصلًا بـ `requireUserJwt`، فرمز التطبيق
  المربوط بالجهاز (`app_access`) يكفي. الكتابة وحدها تمرّ بـ `requireSuperAdmin`.
- التخزين في جدول Studio الجديد `app_update_settings` (مفتاحه القناة) بجوار
  إعدادات STT/TTS، والسرّ يُقنَّع بعلامة `[stored]` نفسها المستعملة هناك. لم
  نستخدم متغير بيئة حتى يبقى الإعداد بعد استبدال الصورة.
- «غير مضبوط» ليس خطأ خادم: الفحص يردّ 200 مع
  `{ available: false, reason: 'not_configured' }` والتنزيل 409 مع
  `code: 'updates_not_configured'`. أخطاء GitHub لها رموز ثابتة يعرضها العميل
  (`github_auth_failed`، `github_rate_limited` مع `retryAfterSeconds`،
  `github_release_not_found`، `github_unavailable`).
- iOS يُجاب بصدق: `reason: 'ios_not_supported'` في الفحص و409 في التنزيل، لا
  ادّعاء بإمكان التثبيت.
- اختيار الملف: نمط `Core.Hub.Mobile-<version>-android.apk`، ونختار الأحدث
  (النسخة ثم رقم البناء ثم وقت الرفع) لا «الملف الوحيد»، لأن الوسم المتحرك قد
  يحمل أكثر من ملف.
- منطق Range لم يُكتب مرتين: نُقلت الدالة من `controllers/download.ts` إلى
  `services/files/http-range.ts` ويستوردها المتحكّمان. هذا النقل هو التعديل
  الوحيد على كود قائم.

## الملفات والتأثير

جديد:
- `packages/server/src/modules/studio/routes/app-updates.ts`
- `packages/server/src/modules/studio/controllers/app-updates.ts`
- `packages/server/src/modules/studio/services/app-updates/mobile-app-updates.ts`
- `packages/server/src/modules/studio/repositories/app-update-settings-store.ts`
- `packages/server/src/modules/studio/services/files/http-range.ts`
- `tests/server/mobile-app-updates.test.ts`
- `docs/mobile-app-updates.md` (موثّق في `README.md`)

معدَّل:
- `packages/server/src/bootstrap/routes.ts` (تسجيل المسارات قبل catch-all)
- `packages/server/src/modules/studio/controllers/download.ts` (استيراد الدالة المنقولة)
- `packages/server/src/modules/studio/infrastructure/database/schemas.ts` (جدول `app_update_settings`)
- `scripts/generate-openapi.mjs` + `docs/openapi.json`

ملاحظة على `docs/openapi.json`: الملف مولَّد بـ `npm run openapi:generate`
(يعمل ضمن `npm run build`)، وكان متأخرًا عن `main` بخمسة مسارات سابقة
(`/api/auth/app-refresh`، مسارات `devices/bindings` و`peer-connections/.../screen`).
إعادة التوليد أدخلتها مع مساراتنا الأربعة؛ لم نكتب أي منها يدويًا.

## الفحوص

نُفِّذت فعلًا على Node 24 في worktree منفصل:

- `npx vitest run tests/server/mobile-app-updates.test.ts` → 9/9 نجحت.
  تغطي: غير مضبوط (فحص 200 + تنزيل 409)، فحص مضبوط يعيد النسخة ورقم البناء
  المفسَّرين، اختيار الأحدث من عدة ملفات (مع تجاهل ملف ليس APK)، تنزيل بمدى
  206 مع تمرير `Range` إلى GitHub و416 لمدى غير صالح، فشل مصادقة GitHub (401)،
  حد المعدل 503، صدق iOS، تقنيع السرّ وعدم مسحه عند إعادة حفظ العلامة، ورفض
  مستودع غير صالح. كل أجسام الاستجابات تُجمع ويتحقق `afterEach` أن الرمز لا
  يظهر في أي منها.
- `npx vitest run tests/server/download-streaming.test.ts` → 2/2 نجحت (إثبات أن
  نقل منطق Range لم يغيّر سلوك تنزيل الملفات).
- `npx tsc --noEmit -p packages/server/tsconfig.json` → نظيف.
- `npm run harness:check` → نجح (حدود الوحدات + توثيق Ekko).

لم يُنفَّذ: `npm run test` الكامل و`npm run test:e2e` و`npm run build` (لا تغيير
في العميل، والفحوص الأوسع تُترك لـ CI على الفرع). لم يُجرَّب اتصال حقيقي بـ
GitHub: كل الاختبارات تستخدم `fetch` مموّهًا، فهي **لا تثبت** عمل الرمز الحقيقي
على المستودع الخاص؛ ذلك يتحقق عند أول ضبط على ستاك التجربة.

## المخاطر والرجوع

- جدول جديد فقط، بلا ترحيل بيانات ولا تعديل جدول قائم. الرجوع: إلغاء الدمج؛
  الجدول الفارغ يبقى بلا أثر.
- الرمز يُخزَّن نصًّا في قاعدة بيانات Studio كما تُخزَّن مفاتيح STT/TTS اليوم.
  لا تسجيل له في اللوق (نسجّل المستودع والوسم والحالة فقط) ولا إعادته في أي رد.
- التنزيل يبثّ عبر الخادم، فحمل الشبكة يمر مرتين على الخادم لكل تحديث (~25 م.ب).
  مقبول لجهاز أو جهازين؛ لو كثر الاستهلاك يُضاف تخزين مؤقت لاحقًا.
- `parseByteRange` صار مشتركًا: أي تعديل عليه يمسّ تنزيل الملفات أيضًا، لذا
  اختبار `download-streaming` يبقى حارسًا له.

## التسليم والخطوة التالية

محلي فقط في worktree: **لم يُدفع الفرع ولم يُفتح PR** بطلب صاحب المهمة؛ المالك
سيراجع ويدفع ويفتح الطلب بنفسه، ثم يدمج في `test` حسب المسار المعتاد.

ما يلزم المالك لتشغيله على خادمه بعد النشر:

1. إنشاء رمز GitHub دقيق لحسابه بصلاحية **Contents: read** على
   `twuijri/core-hub-test-builds` فقط (منفصل عن `TEST_RELEASE_TOKEN` الذي ينشر).
2. `PUT /api/studio/app-updates/settings` بحساب super admin مع
   `{ repository, releaseTag, githubToken }` — الافتراضيات هي القيم نفسها فلا
   يلزم إلا الرمز.
3. التأكد بـ `GET /api/studio/app-updates/mobile?platform=android&channel=test`.

الخطوة التالية بعدها: ربط عميل الأندرويد بالعقد نفسه، ثم تجربة تحديث كامل على
ستاك التجربة.
