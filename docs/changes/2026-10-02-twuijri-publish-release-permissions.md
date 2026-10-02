# نشر الإصدار لم يبدأ في v1.1.7 (صلاحيات سير عمل مستدعى)
المسؤول: twuijri · الفرع: fix/publish-release-permissions · الحالة: review

## المشكلة والهدف
وسم v1.1.7 شغّل «Publish release» فانتهى فورًا بـ`startup_failure` (run 37050711395) قبل أي وظيفة. صورة Docker وبناء iOS الموقّع اشتغلا كالعادة لأنهما في ملفات مستقلة.

## السبب
في #233 أضيفت لوظيفة «Intel Mac (x64 app smoke)» في `desktop.yml` صلاحية `actions: read` (لإعادة تنزيل الحزمة بـ`gh run download`). `publish-release.yml` يستدعي `desktop.yml` من وظيفة `desktop` التي ترث صلاحيات الملف `contents: read` فقط، وGitHub يرفض تشغيل سير عمل مستدعى يطلب صلاحية أكبر مما يمنحه المستدعي، فيفشل التشغيل كله عند البدء.

## القرار والموافقات
منح وظيفة `desktop` المستدعية `contents: read` و`actions: read` صراحةً. لا تغيير في الكود ولا في العقد. بعد الدمج يُعاد النشر يدويًا لوسم v1.1.7 الموجود (Actions → Publish release → `tag: v1.1.7`)؛ يبني من الوسم نفسه فلا حاجة لوسم جديد.

## الملفات والتأثير
- `.github/workflows/publish-release.yml`

## الفحوص
- قراءة صلاحيات كل سير عمل مستدعى: `desktop.yml` وحده يطلب `actions: read` (السطر 242)؛ `desktop-signed.yml` و`android-signed.yml` لا يطلبان أكثر من `contents: read`، ووظيفة `publish` تمنح نفسها `actions: read` من قبل.
- التحقق الحقيقي: تشغيل Publish release يدويًا على v1.1.7 بعد الدمج.

## المخاطر والرجوع
صلاحية قراءة فقط لسجلات Actions للمستودع نفسه. الرجوع: حذف الكتلة.

## التسليم والخطوة التالية
PR إلى main؛ المالك يدمج، ثم أشغّل Publish release على v1.1.7.
