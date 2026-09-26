# صفحة التحميل تعرض آخر إصدار دائمًا
المسؤول: twuijri · الفرع: fix/download-always-latest · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٦): «بعد اي تحديث مستقبلي يصير نفس صفحة الداونلود… ما تنزل نسخه اقدم من النسخه اللي المفروض انها تكون موجوده».
الصفحة كانت تقرأ آخر إصدار من GitHub، لكنها تحفظ الجواب في `sessionStorage` عشر دقائق، فمن فتحها قبل الإصدار بدقائق
يرى النسخة الأقدم حتى تنتهي المدة.

## القرار والموافقات
لا حفظ بين الزيارات: كل فتح للصفحة يسأل `GET /repos/twuijri/core-hub/releases/latest` بـ `cache: 'no-cache'`
(المتصفح يتحقق من GitHub بالـ ETag بدل نسخته). عند تعذّر القراءة تبقى الأزرار على صفحة الإصدارات `releases/latest`
(وهي الأحدث دائمًا). حد GitHub ‏60 طلبًا في الساعة لكل زائر يكفي لصفحة تُفتح مرة.
`publish-release.yml` لا ينشئ الإصدار إلا بعد نجاح بناء كل المنصات، فـ«Latest» فيه كل الملفات.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `site/src/releases.js`: `loadLatest` بلا تخزين، و`cache: 'no-cache'`؛ حُذف `CACHE_MS`.
- `site/src/app.js`: حُذف مساعد `sessionStorage` الذي لم يعد له استعمال.
- `site/tests/releases.test.ts`: اختبار «يسأل كل زيارة، والإصدار الجديد يظهر فورًا ولا يرجع الأقدم» بدل اختبار الحفظ.
- `docs/RELEASING.md`: قسم صفحة التحميل.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm --filter @corehub/site test
Test Files  2 passed (2)
     Tests  40 passed (40)
$ pnpm --filter @corehub/site build
site: built site/dist
$ npx prettier --check site/src site/tests docs/RELEASING.md   # نظيف بعد --write
```

## المخاطر والرجوع
زائر يعيد تحميل الصفحة كثيرًا قد يبلغ حد GitHub فتشير الأزرار إلى صفحة الإصدارات بدل الملف المباشر، وهي أيضًا الأحدث.
الرجوع بإرجاع هذا الـ PR.

## التسليم والخطوة التالية
PR إلى `main`؛ دمجه يعيد نشر الصفحة عبر `pages.yml`.
