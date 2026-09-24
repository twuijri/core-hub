# القوائم المنسدلة: السهم في آخر الزر لا لاصقًا بالنص
المسؤول: twuijri · الفرع: fix/select-chevron-end · الحالة: review

## المشكلة والهدف
أرسل المالك (٢٠٢٦-٠٩-٢٤، بلقطة «Choose the profile») أن سهم القائمة المنسدلة يلتصق بالنص في وسط
الزر: «المفروض … السهم الي نازل … يكون داخل الزر بس اخر شي». الزر يرتّب أيقونته ثم النص ثم السهم
متجاورة، فإذا كان الزر أعرض من محتواه (حقل في نموذج) بقي السهم بجانب النص.

## القرار والموافقات
طلب المالك الإصلاح في الجلسة. السهم (`RadixSelect.Icon`) أخذ الصنف `mj-select-chevron` بهامش
منطقي `margin-inline-start: auto`، فيذهب إلى نهاية الزر: يسارًا في العربية ويمينًا في الإنجليزية.
الأزرار الضيقة التي بقدر محتواها لا يتغيّر شكلها.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/web/src/ui/Select.tsx`: صنف السهم.
- `packages/web/src/styles/app.css`: `.mj-select-chevron`.
- `packages/web/e2e/shots/workspace-origin-ar-light.png`: قائمة «اختر البروفايل» في نافذة البروفايل
  الجديد، والسهم في طرفها. باقي اللقطات أُعيدت كما في `main`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm --filter @majlis/web test
      Tests  443 passed (443)
$ pnpm --filter @majlis/web build        # ok
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  26 passed (1.7m)
```

## المخاطر والرجوع
شكل فقط، في مكوّن واحد. الرجوع باسترجاع الـ commit.

## التسليم والخطوة التالية
PR إلى `main`.
