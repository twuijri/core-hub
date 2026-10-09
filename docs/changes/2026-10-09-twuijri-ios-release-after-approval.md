# App Store: النشر تلقائيًا بعد موافقة أبل
المسؤول: twuijri · الفرع: fix/ios-release-after-approval · الحالة: review

## المشكلة والهدف
`ios-submit.yml` كان يضبط كل نسخة على «نشر يدوي بعد الموافقة» (`releaseType MANUAL`)، فبقيت 1.1.4 «Pending Developer Release» حتى ضغط المالك «Release This Version». المالك (٢٠٢٦-١٠-٠٩): «ابي على طول ينزل مو بلازم انا اللي اسوي بوش».

## القرار والموافقات
`asc-prepare-submission.mjs` يضبط `releaseType: AFTER_APPROVAL`: أبل تنشر النسخة بمجرد الموافقة. قرار المالك.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `apps/ios/scripts/asc-prepare-submission.mjs`
- `apps/ios/scripts/asc-prepare-submission.test.mjs`
- `docs/RELEASING.md`، `docs/store/apple/README.md`

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ node --test apps/ios/scripts/asc-prepare-submission.test.mjs
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

## المخاطر والرجوع
نسخة فيها خطأ تصل للناس فور الموافقة بلا محطة توقف. الرجوع: إعادة MANUAL.

## التسليم والخطوة التالية
بعد الدمج: تشغيل iOS App Store submission على 1.1.8 بلا submit ليضبطها تلقائية وهي في المراجعة؛ إن رفضت أبل التعديل في هذه الحالة يبقى زر النشر للمالك لهذه النسخة فقط.
