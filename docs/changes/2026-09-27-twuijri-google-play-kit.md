# عدّة Google Play لتطبيق أندرويد
المسؤول: twuijri · الفرع: feat/google-play-kit · الحالة: review

## المشكلة والهدف
المالك سجّل حساب مطوّر **شخصي** في Google Play وينتظر التحقق من هويته. المطلوب أن يكون كل ما
يلزم لنشر تطبيق أندرويد (`com.twuijri.corehub`) جاهزًا قبل انتهاء التحقق: نصوص المتجر بالعربية
والإنجليزية، والأيقونة وصورة الواجهة ولقطات الشاشة، وبناء AAB بلا تحديث ذاتي موقّع بمفتاح نسخة
GitHub نفسه، وسير عمل يرفع إلى Play، وإجابات نماذج Play Console كلها مكتوبة من الكود الفعلي.

## القرار والموافقات
- قرار المالك (2026-09-27): النشر على Google Play من حساب شخصي (اختبار مغلق بـ12 مختبِرًا لمدة
  14 يومًا قبل الإنتاج).
- مقترح — للمالك أن يؤكّد (DECISIONS §120): بناء Play بـ`-Pcorehub.selfUpdate=false` وبمفتاح
  الإصدار نفسه؛ رفع مفتاحنا الحالي مفتاحًا لتوقيع التطبيق في Play App Signing (توقيع واحد لنسختَي
  GitHub وPlay)؛ versionCode = 100000 + رقم تشغيل سير العمل؛ الفئة Productivity؛ الجمهور 18+ فقط؛
  إجابات Data safety التي تعلن ما يرسله التطبيق إلى مركز المستخدم نفسه (Play يعدّ أي بيانات تخرج
  من الجهاز «مجموعة»)، و«التشفير أثناء النقل: لا» لأن التطبيق يقبل مركزًا على `http://` في الشبكة
  المنزلية.
- مخالفة مقصودة لنص المهمة: عنوان المركز التجريبي وعنوان المرحّل **لم يُكتبا** في المستودع؛
  AGENTS.md يمنع كتابة أسماء خوادم المالك. الوثيقة تستعمل `<DEMO_HUB_URL>` كما في ملاحظات Apple.
- مسار الوثيقة `docs/store/google/README.md` (لا `docs/stores/google-play.md`) ليوافق
  `docs/store/apple` و`docs/store/microsoft`.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `apps/android/fastlane/metadata/android/{en-US,ar}/`: `title.txt`، `short_description.txt`،
  `full_description.txt`، `changelogs/default.txt`، و`images/icon.png` (512، RGBA)،
  `images/featureGraphic.png` (1024×500، RGB)، و`images/phoneScreenshots/` (ست لقطات 1320×2346 بلا
  قناة شفافية).
- `scripts/icons/build-icons.mjs`: يكتب أيقونة Play وصورة الواجهة من علامة كور هب وألوان
  `tokens.json` (`pnpm icons:build`، و`--check` يقارنها).
- `apps/android/app/src/testDebug/.../shots/PlayStoreShots.kt` (جديد): اللقطات من التطبيق الحقيقي
  على المركز التجريبي (بيانات iOS نفسها)، بمقاس 440×782dp عند 3× (نسبة 9:16؛ مقاس الآيفون
  1320×2868 أطول من حدّ Play 2:1).
- `apps/android/scripts/play-listing.mjs` + `play-listing.test.mjs` (جديدان): فحص حدود Play للنصوص
  والصور، و`--take-shots` لنسخ اللقطات؛ الاختبارات ضمن `pnpm scripts:test` (`package.json`).
- `.github/workflows/play-upload.yml` (جديد، يدوي فقط): يبني AAB ويرفعه و/أو القائمة بـfastlane
  supply؛ يفشل برسالة واضحة إن غاب `PLAY_SERVICE_ACCOUNT_JSON`.
- `docs/store/google/README.md` (جديد): كل إجابات Play Console.
- `docs/privacy.md` و`docs/privacy.ar.md`: تغطّي أندرويد الآن (Firebase Cloud Messaging، الموقع،
  التعرّف على الكلام في الهاتف، التحديث الذاتي لنسخة GitHub فقط، وقسم «حذف حسابك وبياناتك» الذي
  يحتاجه رابط الحذف في Play).
- `docs/RELEASING.md`، `docs/STATUS.md`، `docs/contracts/DECISIONS.md` (§120).
- لم يتغيّر بناء APK الخاص بـGitHub (`android-signed.yml`، `publish-release.yml`) ولا `build.gradle.kts`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (Node 24، JDK 17، Android SDK 35):

```
$ ./gradlew --max-workers=2 testDebugUnitTest --tests 'hub.core.android.shots.PlayStoreShots'
BUILD SUCCESSFUL in 9s          (اختباران: english، arabic)

$ node apps/android/scripts/play-listing.mjs --take-shots --summary
en-US/title.txt: 8/30
en-US/short_description.txt: 77/80
en-US/full_description.txt: 2010/4000
en-US/changelogs/default.txt: 457/500
en-US/images/phoneScreenshots/01-chat.png: 1320 × 2346   … 06-new-chat.png: 1320 × 2346
ar/title.txt: 6/30
ar/short_description.txt: 66/80
ar/full_description.txt: 1765/4000
ar/changelogs/default.txt: 382/500
ar/images/phoneScreenshots/01-chat.png: 1320 × 2346      … 06-new-chat.png: 1320 × 2346
play-listing  OK — en-US, ar are within Google Play's limits.

# AAB موقّع بمفتاح محلي مؤقت (لا أسرار الإصدار محليًا)، versionCode 100001:
$ COREHUB_ANDROID_KEYSTORE=<throwaway.jks> … ./gradlew --max-workers=2 --no-build-cache bundleRelease -Pcorehub.selfUpdate=false
BUILD SUCCESSFUL in 1m 27s
-rw-rw-r-- 11106104 app-release.aab
$ jarsigner -verify -verbose:summary app-release.aab
- Signed by "CN=local throwaway"
jar verified.
# المانيفست المدمج للإصدار: package="com.twuijri.corehub" versionCode="100001" targetSdkVersion="35"،
# REQUEST_INSTALL_PACKAGES: 0 مرة؛ BuildConfig: SELF_UPDATE = false (FIREBASE = false: لا google-services.json محليًا)
# خطوة الفحص في play-upload.yml شُغّلت محليًا على هذا الـAAB (بلا سطر Firebase):
::warning::targetSdk is 35; Google Play takes new apps and updates only at API 36 or later since 31 August 2026 …
jar verified.
Play AAB: versionCode 100001, targetSdk 35, 11M

$ pnpm lint
All matched files use Prettier code style!
$ pnpm scripts:test
ℹ tests 90
ℹ pass 90
ℹ fail 0
$ node scripts/icons/build-icons.mjs --check
icons: 58 files up to date
```

CI على PR #195 (الدفعة الأولى): كل الفحوص الخمسة عشر نجحت، منها «Android build, unit tests, lint»
(3m14s، يشمل `PlayStoreShots`) و«Lint, typecheck, contracts, client tests, build» (6m54s، يشمل
`pnpm scripts:test`).

لم يُشغَّل: `play-upload.yml` نفسه (لا حساب Play ولا `PLAY_SERVICE_ACCOUNT_JSON`)، ولا بناء بمفتاح الإصدار
الحقيقي وFirebase (يحدث في CI عند التشغيل)، ولا actionlint (غير مثبّت). بقية اختبارات أندرويد
وlint يشغّلها `android.yml` على GitHub. TypeScript لم يُمسّ، فلم يُشغَّل `pnpm typecheck`.

## المخاطر والرجوع
- **عائق قبل أول رفع:** Play يشترط targetSdk 36 للتطبيقات الجديدة منذ 2026-08-31 (مهلة ممكنة حتى
  2026-11-01)، والتطبيق على 35. رفعه تغيير مستقل يمسّ نسخة GitHub أيضًا؛ سير العمل يحذّر منه.
- سياسة Play للمحتوى المولَّد بالذكاء الاصطناعي قد تطلب زر «إبلاغ» داخل التطبيق؛ مذكورة كمتابعة.
- لم يُشغَّل سير العمل ضد Play (لا حساب ولا سرّ بعد)؛ قد تحتاج أول حزمة رفعًا يدويًا (`keep_aab`).
- الرجوع: حذف الملفات الجديدة؛ لا شيء في التطبيق أو الخادم يعتمد عليها.

## التسليم والخطوة التالية
- المالك: إكمال التحقق، إنشاء التطبيق في Play Console، حل عائق API 36 أو طلب المهلة، اختيار
  Play App Signing، إنشاء حساب الخدمة والسرّ `PLAY_SERVICE_ACCOUNT_JSON`، تعبئة نماذج App content
  من الوثيقة، وتجنيد 12 مختبِرًا.
