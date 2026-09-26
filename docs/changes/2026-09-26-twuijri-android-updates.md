# أندرويد يكتشف التحديث بنفسه من إصدارات GitHub
المسؤول: twuijri · الفرع: feat/android-updates · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٦): «خل الاندرويد والماك والويندوز واللينكس يكتشفون التحديث اذا نزل تحديث». هذا
السجل لجزء أندرويد وحده (سطح المكتب في فرع آخر `feat/desktop-updates`).

قبل التغيير كان تطبيق أندرويد يسأل «رف التحديثات» في المركز (`updates.*`) فقط، وبضغطة يدوية في «هذا الجهاز»،
والرف فارغ في كل مركز لم ينشر فيه مشرف ملف APK (يقول `not_configured`). بينما الـAPK الموقَّع يُنشر فعلًا على
إصدارات GitHub العامة للمستودع (`publish-release.yml`، باسم `Core-Hub-X.Y.Z-android.apk`). فلا يعرف المستخدم
بصدور نسخة جديدة.

الهدف: التطبيق يكتشف الإصدار الأحدث بنفسه، ويعرضه بشكل مدمج بتصميم العائلة، ويحدّث بضغطة (تنزيل بتقدم ظاهر،
تحقق من الملف، ثم مثبّت أندرويد)، ويمكن إطفاء كل ذلك لبناء Google Play لاحقًا.

## القرار والموافقات
مقترح — للمالك أن يؤكد (DECISIONS §108):
- **المصدر GitHub** لا رف المركز: `GET https://api.github.com/repos/twuijri/core-hub/releases/latest` بلا
  رمز، ولا يُرسل إلا `CoreHub-Android/<الإصدار>` في User-Agent — كالسطح المكتبي (ADR 0023) وصفحة التنزيل.
  الجوال لم يعد يسأل رف المركز؛ `updates.*` باقٍ في العقد لبقية العملاء.
- **متى**: كل مرة يعود التطبيق إلى الواجهة (`MainActivity.onStart`)، مرة كل **٦ ساعات** على الأكثر (آخر فحص
  محفوظ في الجوال)، وبزر «ابحث عن تحديث» في «هذا الجهاز» متى شاء. حدّ المعدّل (403/429) يُحسب فحصًا؛ انقطاع
  الشبكة لا يُحسب (يُعاد في العودة التالية). كل الأخطاء هادئة: لا شيء يظهر إلا عند الفحص اليدوي.
- **ما يُعتبر**: ليس مسودة ولا ما قبل الإصدار، وسم `X.Y.Z` صريح أحدث من `versionName` بترتيب semver، ويحمل
  `Core-Hub-X.Y.Z-android.apk` تحت روابط تنزيل إصدارات هذا المستودع فقط — النمط نفسه في `release-assets.mjs`
  و`site/src/releases.js` (اختبار يقرأ الملفين).
- **الواجهة**: بطاقة مدمجة صلبة (`HubCard`) تحت شريط «محادثة جديدة»: «كور هب X.Y.Z متاح» والحجم، وزرّا
  «حدّث» و«لاحقًا». **«لاحقًا» تخفي بطاقة هذه النسخة حتى تصدر أحدث منها**، ويبقى صف في «الإعدادات» (يفتح «هذا
  الجهاز») وجزء «التحديثات» في «هذا الجهاز» (المثبّت، الجديد، «ما الجديد» على GitHub، «حدّث»، «ابحث عن تحديث»).
- **«حدّث» ينزّل ويثبّت** (خلاف سطح المكتب الذي يربط بالمثبّت فقط): تنزيل إلى ذاكرة التطبيق المؤقتة بشريط
  تقدم ونسبة، ويُحفظ الملف فقط إن طابق حجمه حجم الإصدار (ويُتحقق من SHA-256 إن أعطاه GitHub في `digest`)، ثم
  يُسلَّم لمثبّت أندرويد عبر FileProvider الموجود. إن لم يُسمح بـ«تثبيت التطبيقات غير المعروفة» تفتح البطاقة
  ذلك الإعداد مع سطر شرح واحد، ثم «ثبّت». إن انتهى التنزيل والتطبيق في الخلفية ينتظر ضغطة «ثبّت».
- **لا إشعار في الخلفية**: الفحص لا يجري إلا والتطبيق أمام المستخدم، فلا حاجة لإشعار؛ إشعار لنسخة تُكتشف
  والتطبيق مغلق يحتاج عاملًا في الخلفية — لم يُضف.
- **مفتاح لكل بناء (Google Play)**: `-Pcorehub.selfUpdate=false` أو `COREHUB_ANDROID_SELF_UPDATE=false` →
  `BuildConfig.SELF_UPDATE = false`: لا فحص، لا بطاقة، و«هذا الجهاز» يقول إن Google Play يحدّثه، ويُحذف
  `REQUEST_INSTALL_PACKAGES` من الـmanifest (`app/src/noSelfUpdate/AndroidManifest.xml`). أي قيمة غير true/false
  توقف البناء. الـAPK على GitHub يبقى مفعّلًا افتراضيًا.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. قرار جديد في `docs/contracts/DECISIONS.md` §108 فقط.

## الملفات والتأثير
- `apps/android/app/src/main/java/hub/core/android/phone/SelfUpdate.kt` (جديد): قواعد الإصدار (semver، اختيار
  الـAPK، قراءة رد GitHub، الست ساعات، «لاحقًا»، الحجم)، `GitHubReleases`، التخزين (`PrefsUpdateStore`)،
  `UpdateChecker`، `ApkDownloader` (حجم + SHA-256).
- `apps/android/app/src/main/java/hub/core/android/phone/SelfUpdateUi.kt` (جديد): `SelfUpdate` (التنزيل والتثبيت
  والإذن) والبطاقة وصف الإعدادات وجزء «هذا الجهاز».
- `phone/Updates.kt`: حُذف فحص رف المركز وتنزيله؛ بقي SHA-256 ونية التثبيت. `phone/ThisDevice.kt`: الجزء القديم
  استُبدل بـ`SelfUpdateSection`.
- `AppGraph.kt` (`updates`، عميل HTTP مستقل لـGitHub)، `MainActivity.kt` (`onStart` والبطاقة على «محادثة جديدة»)،
  `ui/screens/SettingsScreen.kt` (الصف).
- `app/build.gradle.kts` (`SELF_UPDATE`)، `app/src/noSelfUpdate/AndroidManifest.xml` (جديد)،
  `src/main/AndroidManifest.xml` (تعليق الإذن).
- `res/values/strings.xml` و`res/values-ar/strings.xml` (اللغتان الوحيدتان في التطبيق): ١٣ نصًا جديدًا، تعديل
  `update_none`، وحذف `update_install` و`update_not_configured` (لم يعد يستعملهما شيء).
- اختبارات: `src/test/.../phone/SelfUpdateTest.kt` (جديد)، `src/testDebug/.../shots/UpdateShots.kt` (جديد)،
  `shots/ShotsApp.kt` (مصدر إصدارات مكتوب بدل GitHub)، `live/LiveHubTest.kt` (يسأل رف المركز مباشرة).
- وثائق: `docs/RELEASING.md` (جدول المنصات + فقرة أندرويد: كيف يحدّث نفسه وكيف يُطفأ لـPlay)،
  `docs/contracts/DECISIONS.md` §108، `docs/STATUS.md`. لا README للتطبيق. لم يُلمس `navigation.json` ولا العقد.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر mj-run، JDK 17 و Android SDK المحليان.

بناء الـAPK التجريبي وكل اختبارات الوحدة وlint (ما يشغّله CI في `android.yml`):
```
$ mj-run ./gradlew --no-daemon --max-workers=2 assembleDebug test lint
BUILD SUCCESSFUL in 1m 34s
test-results/testDebugUnitTest tests 204 skipped 2 failures 0 errors 0
test-results/testReleaseUnitTest tests 188 skipped 2 failures 0 errors 0
app-debug.apk 18585355 bytes
```
بعد حذف فحصَي SDK الزائدين (تحذير lint `ObsoleteSdkInt`) أُعيد ما يمسّه التغيير:
```
$ mj-run ./gradlew --no-daemon --max-workers=2 assembleDebug testDebugUnitTest --tests '…SelfUpdateTest' --tests '…UpdateShots' --tests '…StringsParityTest' --tests '…UiKitPolicyTest' --tests '…PhoneTest' lint
BUILD SUCCESSFUL in 51s
('hub.core.android.phone.PhoneTest', '6', '0', '0', '0')
('hub.core.android.phone.SelfUpdateTest', '12', '0', '0', '0')
('hub.core.android.shots.UpdateShots', '2', '0', '0', '0')
('hub.core.android.ui.StringsParityTest', '3', '0', '0', '0')
('hub.core.android.ui.UiKitPolicyTest', '1', '0', '0', '0')
lint: 0 errors, 53 warnings   (الخمسة في ملفاتي UseKtx، كأسلوب بقية الكود)
```
المفتاح (بناء Play) — الـmanifest المدمج وBuildConfig:
```
off: permission lines=0;   public static final boolean SELF_UPDATE = false;
default: permission lines=1;   public static final boolean SELF_UPDATE = true;
-Pcorehub.selfUpdate=maybe → corehub.selfUpdate / COREHUB_ANDROID_SELF_UPDATE must be true or false, not "maybe"
```
الاختبارات الجديدة لا تُبنى على الكود القديم أصلًا (`ReleaseRules`، `UpdateChecker`، `ApkDownloader`،
`graph.updates` غير موجودة)، فهي تفشل عليه. `SelfUpdateTest` يغطي: ترتيب الإصدارات، اختيار الـAPK والنمط
المشترك مع السكربت والموقع، رفض ما قبل الإصدار والمسودة والروابط الغريبة والردود الفاسدة، الست ساعات (والساعة
المرجوعة)، حد المعدّل مقابل الانقطاع، «لاحقًا» عبر إعادة التشغيل، المفتاح المطفأ، ردود GitHub عبر MockWebServer
(200/403/404/502/نص فاسد/خادم مغلق)، والتنزيل (سليم، أقصر، بايتات أخرى، أطول).

صورة البطاقة: لا محاكي في إعداد الـharness يناسب حدود الذاكرة، فاستُعملت لقطات Robolectric الموجودة
(`UpdateShots`): `apps/android/app/build/shots/light/en-US/android-13-update.png` و
`dark/ar-SA/android-13-update.png` و`android-14-update-this-device.png` (غير مُلتزمة، ناتج بناء). الاختبار يتحقق
أن «لاحقًا» تخفي البطاقة وأن صف الإعدادات وزر «حدّث» في «هذا الجهاز» يبقيان.

فحوص المستودع (mj-run):
```
$ pnpm lint                    → All matched files use Prettier code style!
$ pnpm i18n:check              → i18n:check  OK
$ pnpm nav:check               → nav:check  OK — 39 destinations, 2 pre-auth screens (login, setup), 44 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm contracts:check-clients → check-clients  OK — 778 client file(s) scanned, 254 contract path(s) known.
$ pnpm version:check           → version: 1.1.2 everywhere (10 places)
$ node scripts/check-change-record.mjs --files docs/changes/2026-09-26-twuijri-android-updates.md → change-record  OK — 1 record(s) valid
```

CI على الطلب #171 (أول دفع): كل الفحوص خضراء — منها:
```
Android build, unit tests, lint                          pass  3m24s
Lint, typecheck, contracts, client tests, build          pass  4m32s
Server unit tests (shard 1/3, 2/3, 3/3)                  pass
Web smoke journeys (Playwright against the real hub)     pass  9m10s
Desktop app smoke (Electron under Xvfb against the real hub)  pass
Docker image builds and answers /health                  pass
PR adds or updates a change record                       pass
```

## المخاطر والرجوع
- لم يُجرَّب على جوال حقيقي ولا على إصدار حقيقي؛ أول دليل فعلي: إصدار 1.1.3 ثم فتح 1.1.3 بعد صدور 1.1.4.
- **من يملك 1.1.2 أو أقدم ليس لديه محدّث**: يثبّت أول نسخة فيها هذا الكود يدويًا مرة واحدة.
- التثبيت فوق القديم يتطلب نفس مفتاح التوقيع (`ANDROID_TEST_*`)؛ تغيير المفتاح يوقف التحديث الذاتي.
- حد GitHub بلا رمز ٦٠ طلبًا في الساعة لكل عنوان؛ الست ساعات تبقينا بعيدًا عنه.
- الرجوع: revert لهذا الفرع يعيد فحص رف المركز كما كان؛ أو بناء بـ`-Pcorehub.selfUpdate=false` يطفئ كل شيء.

## التسليم والخطوة التالية
طلب دمج واحد إلى `main` بالإنجليزية، ينتظر مراجعة المالك. للمالك أن يؤكد §108 (المصدر GitHub، الست ساعات،
«لاحقًا» تخفي البطاقة فقط، التنزيل والتثبيت من داخل التطبيق، لا إشعار خلفي). لاحقًا: إشعار عند اكتشاف نسخة
والتطبيق مغلق إن أراده المالك؛ بناء Play بالمفتاح المطفأ.
