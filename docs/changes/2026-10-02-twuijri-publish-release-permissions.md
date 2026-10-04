# نشر الإصدار لم يبدأ في v1.1.7 (صلاحيات سير عمل مستدعى)
المسؤول: twuijri · الفرع: fix/publish-release-permissions · الحالة: review

## المشكلة والهدف
وسم v1.1.7 شغّل «Publish release» فانتهى فورًا بـ`startup_failure` (run 37050711395) قبل أي وظيفة. صورة Docker وبناء iOS الموقّع اشتغلا كالعادة لأنهما في ملفات مستقلة.

## السبب
في #233 أضيفت لوظيفة «Intel Mac (x64 app smoke)» في `desktop.yml` صلاحية `actions: read` (لإعادة تنزيل الحزمة بـ`gh run download`). `publish-release.yml` يستدعي `desktop.yml` من وظيفة `desktop` التي ترث صلاحيات الملف `contents: read` فقط، وGitHub يرفض تشغيل سير عمل مستدعى يطلب صلاحية أكبر مما يمنحه المستدعي، فيفشل التشغيل كله عند البدء.

## القرار والموافقات
منح وظيفة `desktop` المستدعية `contents: read` و`actions: read` صراحةً. لا تغيير في الكود ولا في العقد. بعد الدمج يُعاد النشر يدويًا لوسم v1.1.7 الموجود (Actions → Publish release → `tag: v1.1.7`)؛ يبني من الوسم نفسه فلا حاجة لوسم جديد.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `.github/workflows/publish-release.yml`

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ for f in desktop.yml desktop-signed.yml android-signed.yml; do git show origin/main:.github/workflows/$f | grep -n -A3 "permissions:"; done
desktop.yml:      41:permissions: / 42:  contents: read
desktop.yml:      242:    permissions: / 243: contents: read / 244: actions: read
desktop-signed.yml: 38:permissions: / 39:  contents: read
android-signed.yml: 29:permissions: / 30:  contents: read
$ gh api repos/twuijri/core-hub/actions/runs/37050711395 --jq '{status,conclusion,path}'
{"conclusion":"startup_failure","path":".github/workflows/publish-release.yml","status":"completed"}
```
لم يُشغَّل Publish release نفسه بعد التعديل (يعمل على وسم فقط)؛ التحقق الحقيقي تشغيله يدويًا على v1.1.7 بعد الدمج.

## تصدير مفتاح التوقيع لجوجل بلاي (2026-10-04)
قرار المالك: Play App Signing بمفتاحنا الحالي (مفتاح APK في GitHub) لا بمفتاح يولّده Google. المفتاح موجود فقط في أسرار GitHub (`ANDROID_TEST_*`)، فأُضيف `.github/workflows/play-signing-key.yml` (يدوي فقط): يأخذ مفتاح التشفير العام من Play Console كمدخل (يعيد بناء PEM إن ضاعت الأسطر)، ينزّل PEPK من Google ويتحقق من sha256 مثبّت (`aaccc077…e24e`، نُزّل وفُحص محليًا: خيارات `--keystore-pass` و`--key-pass` و`--rsa-aes-encryption` و`--include-cert` من help.txt داخل الحزمة)، ويخرج zip مشفّرًا لا يفتحه إلا Google Play، يُحفظ artifact ليوم واحد. لم يُشغَّل بعد؛ يُشغَّل بعد الدمج بمفتاح Play Console.

## المخاطر والرجوع
صلاحية قراءة فقط لسجلات Actions للمستودع نفسه. الرجوع: حذف الكتلة.

## التسليم والخطوة التالية
PR إلى main؛ المالك يدمج، ثم أشغّل Publish release على v1.1.7.
