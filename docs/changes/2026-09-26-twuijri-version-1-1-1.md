# الإصدار 1.1.1
المسؤول: twuijri · الفرع: chore/version-1.1.1 · الحالة: review

## المشكلة والهدف
المالك يريد تجربة ما اندمج بعد 1.1.0 (صفحة المنصات، بطاقات الأجهزة، ملفات الإعداد وربط الحسابات، تحسينات الجوال،
المرحّل، الإصدارات لويندوز ولينكس، متجر الآيفون، الصور في الرد) على ستاكه وTestFlight: «وارفعه الحين بجربه» (٢٠٢٦-٠٩-٢٦).
وسم v1.1.0 سبق كود MSIX، فأول حزمة لمتجر مايكروسوفت تحتاج رقمًا جديدًا.

## القرار والموافقات
رفع الإصدار الواحد إلى 1.1.1 من `package.json` الجذر ثم `pnpm version:check --write` كما في `docs/RELEASING.md`.
الوسم `v1.1.1` بعد الدمج، بطلب المالك.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء (رقم الحزمة فقط).

## الملفات والتأثير
`package.json` الجذر وكل `package.json` في مساحة العمل، و`apps/ios/project.yml` (MARKETING_VERSION)،
و`packages/server/Dockerfile` (القيمة الافتراضية لـ COREHUB_VERSION).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ node scripts/version-check.mjs --write
version: 1.1.1 everywhere (9 places)
$ node scripts/version-check.mjs
version: 1.1.1 everywhere (9 places)
```

## المخاطر والرجوع
لا شيء غير الرقم. الرجوع بإعادة 1.1.0 قبل الوسم.

## التسليم والخطوة التالية
PR إلى `main` يُدمج بعد #151–#154، ثم الوسم `v1.1.1` ورفع iOS إلى TestFlight.
