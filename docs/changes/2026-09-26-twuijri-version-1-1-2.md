# الإصدار 1.1.2
المسؤول: twuijri · الفرع: chore/version-1-1-2 · الحالة: review

## المشكلة والهدف
المالك يريد إصدارًا جديدًا من كل شيء بعد دمج #165 (الليلة الثانية: تصميم الأندرويد الجديد، أيقونات Lucide، الإملاء بكل اللغات،
الأصوات، متجر الآيفون، ويندوز ولينكس) و#167 (مراجعة النص العربي من عاصم): «صدر لي نسخة جديدة من كل شيء» (٢٠٢٦-٠٩-٢٦)
ليجرّب الأندرويد.

## القرار والموافقات
رفع الإصدار الواحد إلى 1.1.2 من `package.json` الجذر ثم `node scripts/version-check.mjs --write` كما في `docs/RELEASING.md`.
الوسم `v1.1.2` بعد الدمج، بطلب المالك؛ يبني الصورة `latest` وحزم سطح المكتب والأندرويد وiOS الموقّع.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء (رقم الحزمة فقط).

## الملفات والتأثير
`package.json` الجذر وكل `package.json` في مساحة العمل و`site/package.json`، و`apps/ios/project.yml` (MARKETING_VERSION)،
و`packages/server/Dockerfile` (القيمة الافتراضية لـ COREHUB_VERSION). الأندرويد يقرأ الرقم من الجذر.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ node scripts/version-check.mjs --write
version: 1.1.2 everywhere (10 places)
$ node scripts/version-check.mjs
version: 1.1.2 everywhere (10 places)
```

## المخاطر والرجوع
لا شيء غير الرقم. الرجوع بإعادة 1.1.1 قبل الوسم.

## التسليم والخطوة التالية
PR إلى `main`، يدمجه المالك، ثم الوسم `v1.1.2` ورفع iOS إلى TestFlight وحزمة MSIX لمتجر مايكروسوفت.
