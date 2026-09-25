# إعفاء تشفير iOS في Info.plist
المسؤول: twuijri · الفرع: fix/ios-export-compliance · الحالة: review

## المشكلة والهدف
بناء TestFlight الأول ‎1.1.0 (109)‎ وقف عند «Missing Compliance»، فلم يصل إلى المختبرين حتى أجاب المالك عن سؤال التشفير
يدويًا في App Store Connect. سيتكرر السؤال مع كل بناء.

## القرار والموافقات
التطبيق لا يستعمل إلا تشفير النظام (HTTPS/TLS)، وهو معفى؛ المالك اختار في App Store Connect ‏«None of the algorithms
mentioned above» (٢٠٢٦-٠٩-٢٥) وسأل «هل كل مره بنسوي كذا؟». نضع `ITSAppUsesNonExemptEncryption: false` في خصائص التطبيق
فلا يُسأل مرة أخرى. امتداد المشاركة لا يحتاجه (يُقرأ من التطبيق الحاوي).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
`apps/ios/project.yml`: مفتاح واحد في `info.properties` للتطبيق.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ python3 -c "import yaml;print(yaml.safe_load(open('apps/ios/project.yml'))['targets']['CoreHub']['info']['properties']['ITSAppUsesNonExemptEncryption'])"
False
```
بناء iOS الفعلي على CI (مهمة محاكي iOS).

## المخاطر والرجوع
لو أضيف لاحقًا تشفير غير معفى يجب تغيير القيمة. الرجوع بحذف السطر.

## التسليم والخطوة التالية
PR إلى `main`. إضافة البناء لمجموعة «Owner» تلقائيًا يفعّلها المالك مرة واحدة من إعدادات المجموعة.
