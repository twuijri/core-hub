# خيار غير صالح في رفع قائمة App Store
المسؤول: twuijri · الفرع: night/2026-09-27 · الحالة: review

## المشكلة والهدف
أول تشغيل لرفع صور المتجر ونصوصه (`ios-screenshots.yml` برفع مفعّل، ٢٠٢٦-٠٩-٢٦، بإذن المالك: «ارفع ما عندي مشكلة») فشل:
`invalid option: --skip_submission`. هذا الخيار ليس من خيارات `fastlane deliver`؛ عدم الإرسال للمراجعة يضمنه `--submit_for_review false`.

التشغيل الثاني فشل أيضًا: deliver توقف يسأل «No deliver configuration found… setup deliver?» لأنه لا يوجد Deliverfile، وهو في CI غير تفاعلي.
والتشغيل الثالث رفع نصوص القائمة ثم توقف: `No data` في `fetch_app_store_review_detail`، لأن إصدار 1.1.1 أُنشئ للتو بلا سجل «App Review Information».

## القرار والموافقات
حذف الخيار من `ios-screenshots.yml` و`ios-store-metadata.yml`، وتصحيح `docs/store/apple/README.md`. وإضافة `apps/ios/fastlane/Deliverfile` صغير (معرّف التطبيق، والمنصة، و`submit_for_review(false)`)، وتشغيل deliver من `apps/ios`. وقبله `apps/ios/scripts/asc-review-detail.mjs` ينشئ الإصدار إن لم يوجد وسجل مراجعة فارغًا عبر واجهة App Store Connect (لا يملأ حساب التجربة ولا يرسل شيئًا؛ هذه خانات المالك). لا يتغير السلوك: لا يُرسل شيء للمراجعة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
`.github/workflows/ios-screenshots.yml`، `.github/workflows/ios-store-metadata.yml`، `docs/store/apple/README.md`، `apps/ios/fastlane/Deliverfile`، `apps/ios/scripts/asc-review-detail.mjs`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ grep -c skip_submission .github/workflows/ios-screenshots.yml .github/workflows/ios-store-metadata.yml
.github/workflows/ios-screenshots.yml:0
.github/workflows/ios-store-metadata.yml:0
```
التحقق الحقيقي: إعادة تشغيل الرفع من فرع الليلة.

## المخاطر والرجوع
لا شيء؛ الرجوع باسترجاع الـcommit.

## التسليم والخطوة التالية
ضمن طلب الليلة #165.
