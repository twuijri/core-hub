# اشتراك ChatGPT: كل موديلات الصور، والقائمة تتبع أحدث نسخة من Codex
المسؤول: twuijri · الفرع: fix/codex-image-models · الحالة: review

## المشكلة والهدف
المالك بعد تحديث المركز إلى 1.1.2 (٢٠٢٦-٠٩-٢٦): موديلات المحادثة صارت مثل CLI Proxy API، لكن الصور «ما انسحبت»
— هناك أربعة أو خمسة موديلات صور وعندنا واحد (`gpt-image-2`)؛ و«هناك على طول… أول ما حدث ChatGPT وزودت موديلات
على طول انسحبت عندنا لا».

ما وُجد في CLI Proxy API (MIT، router-for-me/CLIProxyAPI، قراءة فقط):
- خادم Codex لا يعطي أي قائمة لموديلات الصور. CLI Proxy API يكتب أسماءها في كوده (`internal/registry/model_definitions.go`):
  `gpt-image-1.5`، `gpt-image-2`، `gpt-image-2.5`، `gpt-image-2.5-flare`، `gpt-image-2.5-sunburst`، ويمرر الاسم المختار إلى
  أداة `image_generation` نفسها التي يستعملها المركز (§84).
- قائمة المحادثة عنده فهرس يحدّثه من مستودعه (`router-for-me/models`) أثناء التشغيل، مأخوذ من الخادم بنسخة Codex حديثة.
  عندنا الرقم ثابت في الكود (0.157.0)، فالموديل الذي تخفيه OpenAI خلف نسخة أحدث يتأخر حتى إصدار جديد من المركز.

## القرار والموافقات
مقترح، ينتظر تأكيد المالك (DECISIONS §110):
- المركز يعرض موديلات الصور الخمسة كلها في قائمة الاشتراك، الأحدث أولًا، وكل واحد يرسم باسمه عبر الأداة.
  `COREHUB_CODEX_IMAGE_MODELS` يضيف اسمًا جديدًا قبل الإصدار. هذا الاستثناء الوحيد من «لا قائمة مخترعة» لأن المزوّد لا يعطي قائمة للصور.
- المركز يقرأ أحدث إصدار `rust-v*` من github.com/openai/codex (بلا رمز) مرة كل ١٢ ساعة بالكثير عند طلب القائمة،
  ويستعمله إن كان أحدث من الرقم المكتوب؛ لا ينزل عنه أبدًا، ولا ينتظر GitHub أكثر من ٥ ثوانٍ، و`COREHUB_CODEX_CLIENT_VERSION` يبقى هو الأعلى.
- رقم القرار ١١٠ لأن ١٠٨ محجوز لفرع تحديث الأندرويد و١٠٩ لفرع تحديث سطح المكتب.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/src/modules/models/images.ts`: `CODEX_IMAGES.models` و`codexImageModels()`؛ `imageProtocolOf` يقبل أيًّا منها.
- `packages/server/src/modules/models/service.ts`: يضيف كل موديلات الصور الناقصة إلى قائمة الاشتراك.
- `packages/server/src/modules/models/live-models.ts`: `codexVersionSource` و`codexReleaseVersion` و`compareVersions`، و`codexClientVersion` يأخذ الأحدث.
- `packages/server/src/modules/models/sign-in.ts` و`index.ts`: الرقم يُطلب بشكل غير متزامن من المصدر الجديد.
- `packages/server/skill-library/image-{generate,edit}/scripts/image_api.py`: نص التوثيق فقط.
- اختبارات: `codex-catalogue.test.ts` (جديد)، وتحديث `codex-subscription.test.ts` و`fallback-signin.test.ts`.
- `docs/contracts/DECISIONS.md` (§110) و`docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm --filter @corehub/server exec vitest run src/modules/models/codex-catalogue.test.ts \
    src/modules/models/codex-subscription.test.ts src/modules/models/fallback-signin.test.ts \
    src/modules/models/images-role.test.ts
 Test Files  4 passed (4)
      Tests  36 passed (36)
$ (cd packages/server && npx tsc --noEmit -p tsconfig.json)   # بلا أخطاء
$ pnpm lint
All matched files use Prettier code style!
```
الاختبارات الكاملة على GitHub.

## المخاطر والرجوع
- خطة المالك قد ترفض أحد موديلات 2.5؛ يفشل الرسم بسبب الخادم نفسه ويبقى البقية. لم يُجرَّب رسم حقيقي بعائلة 2.5 بعد.
- طلب GitHub يخرج من المركز كل ١٢ ساعة بالكثير؛ عند المنع أو انقطاع الشبكة يبقى الرقم المكتوب.
- الرجوع بإرجاع هذا الطلب.

## التسليم والخطوة التالية
طلب إلى `main`؛ بعد الدمج وإصدار جديد: «تحديث القائمة» في مزوّد اشتراك ChatGPT، ثم تجربة الرسم بكل موديل صور من دور الصور.
