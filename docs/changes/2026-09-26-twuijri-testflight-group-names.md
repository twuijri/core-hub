# مطابقة اسم مجموعة TestFlight رغم الحروف المخفية
المسؤول: twuijri · الفرع: fix/testflight-group-names · الحالة: review

## المشكلة والهدف
رفع الإصدار 1.1.2 إلى TestFlight (run 36244723288، ٢٠٢٦-٠٩-٢٦) رفع النسخة لكن خطوة إضافتها للمجموعة فشلت:
`No TestFlight group named "Owner" for com.twuijri.corehub. The app's groups: "Owner⁩".` اسم المجموعة في App Store Connect
محفوظ ومعه حرف اتجاه مخفي (U+2069) لأنه نُسخ من نص عربي، والسكربت يطابق الاسم حرفيًا.

## القرار والموافقات
`groupKey` يحذف حروف الاتجاه والوصل المخفية (U+200B–U+200F، U+202A–U+202E، U+2060–U+2069، U+FEFF) ويقصّ المسافات
ويتجاهل حالة الأحرف، والمطابقة به. لا يتغيّر شيء آخر.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
`apps/ios/scripts/testflight-distribute.mjs` و`testflight-distribute.test.mjs`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ node --test apps/ios/scripts/testflight-distribute.test.mjs
ℹ tests 15
ℹ pass 15
ℹ fail 0
```

## المخاطر والرجوع
اسمان يختلفان بحرف مخفي فقط يُعدّان واحدًا؛ لا يُتوقع هذا في مجموعات حقيقية. الرجوع بإرجاع الطلب.

## التسليم والخطوة التالية
بعد الدمج: إعادة تشغيل «iOS signed build» بإضافة 1.1.2 للمجموعة، أو إعادة تسمية المجموعة في App Store Connect إلى «Owner» مكتوبة باليد.
