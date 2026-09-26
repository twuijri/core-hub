# رفع الصور من الأندرويد يفشل بـ «Unexpected header: Content-Type»
المسؤول: twuijri · الفرع: fix/android-upload-multipart · الحالة: review

## المشكلة والهدف
المالك (٢٠٢٦-٠٩-٢٦، صورة من تطبيق الأندرويد 1.1.2): كل صورة تُرفق في المحادثة تفشل بـ `Unexpected header: Content-Type`.
السبب: عميل Kotlin المولَّد (openapi-generator 7، `jvm-okhttp4`) يضع نوع الجزء في ترويسات الجزء
(`"Content-Type" to "*/*"` لملف `sessions.uploadAttachment`)، ثم يمررها لـ `MultipartBody.Builder.addPart`، وOkHttp يرفض
ترويسة Content-Type في ترويسات الجزء. الطلب لا يخرج من الجوال أصلًا.

## القرار والموافقات
بعد التوليد (`packages/contracts/scripts/generate-native.mjs`) يُحذف مفتاح Content-Type من ترويسات الجزء قبل `addPart`
(`withoutPartContentType` في `kotlin-openapi.mjs`)؛ نوع الجسم يضعه المولِّد أصلًا من الملف. إن تغيّر سطر المولِّد يفشل التوليد صراحة.
لا تغيير في العقد ولا في كود التطبيق.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء في `openapi.yaml`؛ التغيير في سكربت توليد العميل فقط.

## الملفات والتأثير
- `packages/contracts/scripts/kotlin-openapi.mjs`، `packages/contracts/scripts/generate-native.mjs`، `packages/contracts/tests/kotlin-openapi.test.ts`.
- `apps/android/app/src/test/java/hub/core/android/chat/UploadAttachmentTest.kt` (جديد): يرفع صورة عبر `AttachmentUploader` والعميل المولَّد إلى خادم تجريبي.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm --filter @corehub/contracts generate:native      # JDK 17
contracts:generate:native  OK
$ ./gradlew :app:testDebugUnitTest --tests 'hub.core.android.chat.UploadAttachmentTest'
tests="1" skipped="0" failures="0" errors="0"
# على الكود المولَّد القديم (بلا التصحيح) نفس الاختبار:
failures="1"  java.lang.IllegalArgumentException: Unexpected header: Content-Type
$ pnpm --filter @corehub/contracts exec vitest run tests/kotlin-openapi.test.ts
      Tests  10 passed (10)
$ pnpm lint
All matched files use Prettier code style!
```

## المخاطر والرجوع
الملف يُرسل بنوع يخمّنه العميل من اسمه (كما كان مقصودًا). الرجوع بإرجاع الطلب.
رسالة «stream ended unexpectedly» في الصورة نفسها من المركز (انقطع بث الرد) ولا علاقة لها بالرفع؛ تُتابع منفصلة.

## التسليم والخطوة التالية
طلب إلى `main`؛ يصل الجوال مع أول إصدار بعده (1.1.3).
