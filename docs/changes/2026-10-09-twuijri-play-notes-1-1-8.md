# ملاحظات إصدار 1.1.8 في Google Play
المسؤول: twuijri · الفرع: store/notes-1-1-8 · الحالة: review

## المشكلة والهدف
ملف ملاحظات الإصدار في Google Play (`changelogs/default.txt`) ما زال نص «أول إصدار». الاختبار المغلق سيأخذ 1.1.8، فيحتاج المختبرون ملاحظات صحيحة.

## القرار والموافقات
المالك طلب إطلاق 1.1.8 على كل المتاجر (٢٠٢٦-١٠-٠٩). النص يصف ما يراه مستخدم الجوال فقط.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `apps/android/fastlane/metadata/android/en-US/changelogs/default.txt`
- `apps/android/fastlane/metadata/android/ar/changelogs/default.txt`

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ node apps/android/scripts/play-listing.mjs --summary
en-US/changelogs/default.txt: 272/500
ar/changelogs/default.txt: 207/500
play-listing  OK — en-US, ar are within Google Play's limits.
```

## المخاطر والرجوع
نص فقط. الرجوع بإعادة النص السابق.

## التسليم والخطوة التالية
بعد الدمج: تشغيل Google Play upload من main على مسار alpha (الاختبار المغلق).
