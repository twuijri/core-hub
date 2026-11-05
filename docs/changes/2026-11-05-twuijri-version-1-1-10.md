# الإصدار 1.1.10
المسؤول: twuijri · الفرع: chore/version-1-1-10 · الحالة: review

## المشكلة والهدف
- **طلب المالك (2026-11-05):** «طلعلي اصدار كامل لانه مهم التحديث هذا».
- **سبب الاستعجال:** في صورة 1.1.9 كل محادثة Hermes تفشل من أول رسالة («is owned by a running gateway»). الإصلاح في #265.
- **وش يشمل بعد 1.1.9:**
  - #265: محادثات Hermes تتصل بالبوابة الشغالة (Hermes v0.22.2 وما بعده).
  - #262: مساعد Hermes (ADR 0031).
  - #263: النماذج المحلية في تطبيق سطح المكتب عن طريق Ollama (ADR 0032).
  - #261: محادثات القنوات تفتح على آخر رسالة.
  - #260: روابط المستودع وصفحة التحميل في كل التطبيقات.

## القرار والموافقات
- **رفع الإصدار:** الإصدار الواحد صار 1.1.10 (`node scripts/version-check.mjs --write`).
- **ملاحظات المتاجر:** ملاحظات 1.1.10 لـ Google Play وApp Store، بالعربي والإنجليزي.
- **بعد ما يدمج المالك هذا الـ PR و#265:** الوسم `v1.1.10`، ثم كل المتاجر حسب موافقة المالك الدائمة (كل إصدار يروح لكل المتاجر):
  - صورة الدوكر؛
  - TestFlight وإرسال App Store للمراجعة؛
  - Google Play؛
  - متجر مايكروسوفت.
- **نسخة Hermes:** الصورة تبقى على Hermes v0.22.5 المختبرة.
  - مراقبة Hermes لقت v0.22.7، لكنها ما زالت غير مدعومة: فيه 6 اختبارات تفشل، كلها في البروفايلات والذاكرة (#264).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء (رقم الحزمة فقط).

## الملفات والتأثير
- **رقم الإصدار:**
  - `package.json` الجذر، وكل `package.json` في مساحة العمل، و`site/package.json`؛
  - `apps/ios/project.yml`؛
  - `packages/server/Dockerfile`.
- **ملاحظات المتاجر:**
  - `apps/android/fastlane/metadata/android/{en-US,ar}/changelogs/default.txt`؛
  - `apps/ios/fastlane/metadata/{en-US,ar-SA}/release_notes.txt`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ node scripts/version-check.mjs
version: 1.1.10 everywhere (10 places)
$ wc -m apps/android/fastlane/metadata/android/*/changelogs/default.txt
323 apps/android/fastlane/metadata/android/ar/changelogs/default.txt
394 apps/android/fastlane/metadata/android/en-US/changelogs/default.txt
```

## المخاطر والرجوع
- **التغيير:** الرقم والملاحظات فقط.
- **الرجوع:** نرجع لـ 1.1.9 قبل الوسم.
- **الترتيب مهم:** لازم يندمج #265 قبل الوسم، وإلا تطلع 1.1.10 ومحادثات Hermes فيها معطلة.

## التسليم والخطوة التالية
1. المالك يدمج #265 وهذا الـ PR.
2. الوسم `v1.1.10`.
3. المتاجر كلها، مع متابعة كل workflow لين يخلص.
