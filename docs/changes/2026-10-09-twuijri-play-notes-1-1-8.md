# ملاحظات إصدار 1.1.8 في Google Play و App Store
المسؤول: twuijri · الفرع: store/notes-1-1-8 · الحالة: review

## المشكلة والهدف
ملفا ملاحظات الإصدار في Google Play (`changelogs/default.txt`) و App Store (`release_notes.txt`) ما زالا نص «أول إصدار». الاختبار المغلق سيأخذ 1.1.8، فيحتاج المختبرون ملاحظات صحيحة.

## القرار والموافقات
المالك طلب إطلاق 1.1.8 على كل المتاجر (٢٠٢٦-١٠-٠٩). النص يصف ما يراه مستخدم الجوال فقط.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `apps/android/fastlane/metadata/android/en-US/changelogs/default.txt`
- `apps/android/fastlane/metadata/android/ar/changelogs/default.txt`
- `apps/ios/fastlane/metadata/{en-US,ar-SA}/release_notes.txt` (ملاحظات App Store تغطي ما بعد 1.1.4 لأنها أول تحديث في المتجر)

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ node apps/android/scripts/play-listing.mjs --summary
en-US/changelogs/default.txt: 272/500
ar/changelogs/default.txt: 207/500
play-listing  OK — en-US, ar are within Google Play's limits.
$ node apps/ios/scripts/store-metadata.mjs --summary
en-US/release_notes.txt: 463/4000
ar-SA/release_notes.txt: 365/4000
store-metadata  OK — en-US, ar-SA are within App Store Connect's limits.
```

## المخاطر والرجوع
نص فقط. الرجوع بإعادة النص السابق.

## التسليم والخطوة التالية
بعد الدمج: تشغيل Google Play upload من main على مسار alpha (الاختبار المغلق).
