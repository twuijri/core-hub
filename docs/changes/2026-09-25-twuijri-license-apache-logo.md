# ترخيص Apache 2.0 وشعار Core Hub في README
المسؤول: twuijri · الفرع: chore/license-apache-logo · الحالة: review

## المشكلة والهدف
بعد إعادة كتابة README (#96) بقي أمران سأل عنهما المالك (٢٠٢٦-٠٩-٢٥):
- الشعار لم يظهر في README لأن GitHub لا يعرض SVG مكتوبًا داخل الملف. المالك: «ايه حط الشعار».
- ملف `LICENSE` يقول «جميع الحقوق محفوظة، لم يُختر ترخيص» والمستودع عام. المالك: «والرخصة خلها ابراتشي».

## القرار والموافقات
قرارا المالك في الجلسة. التفاصيل في `docs/adr/0018-apache-2-license.md`:
- `LICENSE` نص Apache License 2.0 كما هو، و`NOTICE` باسم المنتج وصاحب الحقوق.
- `package.json` الجذر `Apache-2.0`، و`info.license` في العقد كذلك.
- الشعار ملفان `docs/assets/core-hub-mark-light.svg` (التركوازي الغامق) و`-dark.svg`
  (الفاتح)، من مسار العلامة نفسه في `MajlisMark.tsx` (#85)، وREADME يختار بينهما حسب سمة GitHub
  بعنصر `<picture>`.
- الغرفة النظيفة (ADR 0004) لا تتغيّر.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
`info.license` فقط (اسم الترخيص ورابطه)؛ لا عملية ولا مخطط.

## الملفات والتأثير
`LICENSE`، `NOTICE` (جديد)، `package.json`، `packages/contracts/openapi.yaml`، `README.md`،
`docs/assets/*.svg` (جديد)، `docs/adr/0018-apache-2-license.md` (جديد).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint   # exit 0
All matched files use Prettier code style!
$ pnpm contracts:lint   # exit 0
contracts:lint  OK
$ pnpm contracts:check-clients   # exit 0
check-clients  OK — 260 client file(s) scanned, 172 contract path(s) known.
$ pnpm change-record:check
change-record  OK — 1 record(s) valid
```
وفتحت README محليًا: الملفان SVG يُعرضان بلون كل سمة.

## المخاطر والرجوع
الترخيص قرار قانوني: من حصل على نسخة بعد الدمج يحتفظ بحقوق Apache 2.0 عليها حتى لو تغيّر الترخيص
لاحقًا. الرجوع التقني باسترجاع الـcommit.

## التسليم والخطوة التالية
PR إلى `main`. طلب دمج تغيير الاسم الجاري يغيّر روابط المستودع في العقد وقد يتعارض في سطر
`info.license` المجاور؛ الحل إبقاء الترخيص من هنا.
