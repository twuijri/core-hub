# صفحة التحميل: زر Microsoft Store يعمل
المسؤول: twuijri · الفرع: site/microsoft-store-live · الحالة: review

## المشكلة والهدف
التطبيق منشور في Microsoft Store منذ 2026-09-29 (Partner Center: «In the Microsoft Store»، Submission 1)، لكن صفحة التحميل ما زالت تعرض زر المتجر «قريبًا». طلب المالك (2026-10-05): بطاقة ويندوز فيها التحميل المباشر ورابط المتجر معًا.

## القرار والموافقات
تشغيل مفتاح `microsoftStore` في `site/src/config.js` فقط (الطريقة الموثقة في رأس الملف). زر `.exe` المباشر باقٍ كما هو. Google Play وApp Store يبقيان «قريبًا» حتى يُنشرا.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `site/src/config.js`: `microsoftStore.enabled = true`.
- `site/tests/releases.test.ts`: اختبار أن زر المتجر صار رابطًا إلى صفحة المنتج.
- `README.md`: سطر ويندوز يربط المتجر بدل «coming».

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ cd site && npx vitest run --maxWorkers=2
 Test Files  2 passed (2)
      Tests  41 passed (41)
$ node site/build.mjs; echo $?
0
```

## المخاطر والرجوع
الرجوع: إعادة `enabled` إلى `false`.

## التسليم والخطوة التالية
PR إلى main؛ بعد الدمج يعيد `pages.yml` نشر الصفحة. ملف 1.1.7 للمتجر (Submission 2، مسودة) ينتظر قرار المالك على طريقة الرفع.
