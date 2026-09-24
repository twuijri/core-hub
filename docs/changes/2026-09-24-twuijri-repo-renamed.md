# المستودع صار twuijri/core-hub: شرط بوت الخريطة على الاسم الجديد
المسؤول: twuijri · الفرع: ci/repo-renamed · الحالة: review

## المشكلة والهدف
غيّر المالك (٢٠٢٦-٠٩-٢٤) اسم هذا المستودع من `twuijri/majlis` إلى `twuijri/core-hub`: «وريبو
المجلس نخليه هو كور هب ونغير كل شي الى كور هب». بوت خريطة الكود (`code-map.yml`) يعمل بشرط
`github.repository == 'twuijri/majlis'`، فبعد تغيير الاسم لا يعمل أبدًا ولا تُقترح الخريطة بعد أي دمج.

## القرار والموافقات
قرار المالك في الجلسة. هذا التغيير يصلح الشرط وحده ليعمل البوت من الدمج التالي؛ تغيير الاسم في
الواجهة والوثائق والحزم والصورة في طلب دمج مستقل بعد هذا.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `.github/workflows/code-map.yml`: الشرط على `twuijri/core-hub`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm change-record:check
change-record  OK — 1 record(s) valid
```
سلوك البوت نفسه لا يُثبت إلا بأول تشغيل على `main` بعد الدمج (docs/harness/knowledge-graph.md).

## المخاطر والرجوع
لا خطر؛ الرجوع باسترجاع الـcommit.

## التسليم والخطوة التالية
PR إلى `main`. التالي: طلب دمج يغيّر اسم المنتج إلى Core Hub في كل مكان.
