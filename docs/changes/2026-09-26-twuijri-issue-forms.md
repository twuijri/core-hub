# نماذج البلاغات وإغلاقها التلقائي عند الدمج
المسؤول: twuijri · الفرع: chore/issue-forms · الحالة: review

## المشكلة والهدف
بلاغ عاصم #166 جاء نصًا حرًّا بلا رقم إصدار ولا جهاز، لأن البلاغات الفارغة مسموحة والقوالب الحالية Markdown يمكن تجاوزها.
وأغلقه بيده قبل دمج #167 لأن وصف الطلب قال «addresses #166» لا «Closes #166». المالك (٢٠٢٦-٠٩-٢٦): «نموذج يمشي عليه…
نسأل المستخدم وش رأيك وش هو الحل… عشان يصل للمطور شغل جاهز»، وأن يُغلق البلاغ تلقائيًا بعد الدمج.

## القرار والموافقات
- نماذج GitHub (YAML) بدل قوالب Markdown، بالإنجليزية أولًا ثم العربية، مع حقول إلزامية:
  - بلاغ خطأ: الإصدار، أين يحدث، طريقة تشغيل المركز، ما حدث، المتوقع، الخطوات؛ واختياريًا الجهاز، التكرار، **فكرة المبلّغ للحل**، السجلات.
  - اقتراح ميزة: المشكلة، **الحل المقترح**، الجزء؛ واختياريًا البدائل، الأهمية، أين رآها (مع تذكير الغرفة النظيفة).
  - النصوص والترجمة (جديد، على شكل بلاغ عاصم): اللغة، المكان، الإصدار، ولكل نص «الحالي / المقترح / السبب».
  - مربعات «بحثت ولم أجده مكررًا» و«حذفت المفاتيح» إلزامية في بلاغ الخطأ، و«أرغب في إرسال طلب دمج» اختيارية.
- `blank_issues_enabled: false` ورابط لدليل المساهمة.
- قالب الطلبات يبدأ بقسم «Issue / البلاغ» فيه `Closes #`، و`CONTRIBUTING.md` يطلبه وينهى عن إغلاق البلاغ يدويًا قبل الدمج.
- لم تُنشأ وسوم جديدة؛ النماذج تستعمل `bug` و`enhancement` و`documentation` الموجودة.
- مقترح للمالك (لم يُفعَّل): تشغيل «Private vulnerability reporting» في إعدادات المستودع ليكون للثغرات طريق خاص.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
`.github/ISSUE_TEMPLATE/{bug_report,feature_request,copy_translation}.yml` (حُذف `bug_report.md` و`feature_request.md`)،
`.github/ISSUE_TEMPLATE/config.yml`، `.github/pull_request_template.md`، `CONTRIBUTING.md`. لا أثر على الكود.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ python3 -c "yaml.safe_load(...) لكل نموذج، وتفرّد المعرّفات"
ok .github/ISSUE_TEMPLATE/copy_translation.yml
ok .github/ISSUE_TEMPLATE/config.yml
ok .github/ISSUE_TEMPLATE/bug_report.yml
ok .github/ISSUE_TEMPLATE/feature_request.yml
$ npx prettier --check .github/ISSUE_TEMPLATE .github/pull_request_template.md CONTRIBUTING.md
All matched files use Prettier code style!
```
عرض النماذج نفسه لا يظهر إلا بعد الدمج في `main` (GitHub يقرأها من الفرع الافتراضي).

## المخاطر والرجوع
نموذج فيه خطأ في المخطط يختفي من قائمة «New issue» بدل أن يكسر شيئًا؛ يُتحقق بعد الدمج بفتح «New issue».
الرجوع بإرجاع هذا الطلب.

## التسليم والخطوة التالية
طلب إلى `main`؛ بعد الدمج أفتح صفحة «New issue» وأتأكد أن النماذج الثلاثة تظهر.
