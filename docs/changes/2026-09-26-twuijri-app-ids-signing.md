# معرّفات التطبيقات والبناء الموقّع (أندرويد، iOS، ماك)
المسؤول: twuijri · الفرع: feat/app-ids-signing · الحالة: review

## المشكلة والهدف
التطبيقات كانت بمعرّفات مؤقتة (`hub.core.android` لأندرويد، `io.github.twuijri.corehub` لـ iOS وسطح
المكتب) ولا يوجد بناء موقّع لأي منها. المالك سجّل المعرّفات النهائية في Apple وFirebase ووضع أسرار التوقيع
في المستودع، والمطلوب: أن يحمل كل تطبيق هويته النهائية، وأن يوجد بناء موقّع يعمل يدويًا أو بوسم إصدار
فقط، بينما تبقى بناءات طلبات الدمج غير موقّعة كما هي. التسجيل في الإشعارات (FCM/APNs) داخل التطبيقات
مهمة لاحقة؛ هذه المهمة تجهّز الهوية وخط البناء فقط.

## القرار والموافقات
- قرار المالك (٢٠٢٦-٠٩-٢٥): `com.twuijri.corehub` في كل مكان؛ امتداد المشاركة `com.twuijri.corehub.share`؛
  مجموعة التطبيقات `group.com.twuijri.corehub`؛ فريق Apple `58QWJ228ZE`؛ مشروع Firebase `core-hub-66772`.
- حزم Kotlin تبقى `hub.core.android` (الـ`namespace`)، فلا يتغيّر أي ملف مصدر في أندرويد.
- **مقترح — بانتظار تأكيد المالك:** ملفات التعريف (provisioning profiles) لـ iOS يصنعها سكربت
  `apps/ios/scripts/asc-profiles.mjs` عبر مفتاح App Store Connect (ملف App Store لكل معرّف، يُعاد
  استخدامه ولا يُحذف شيء من الحساب)، ثم يعمل `xcodebuild archive/-exportArchive` بتوقيع يدوي مع
  `-allowProvisioningUpdates` ومفتاح المصادقة كما طُلب. السبب: التوقيع التلقائي وحده يوقّع الأرشيف
  للتطوير أولًا، فيحتاج شهادة تطوير على الخادم وأجهزة مسجّلة في الفريق؛ ملفات App Store لا تحتاج أيًّا منهما.
- **مقترح:** توقيع ماك يستورد شهادة Developer ID في سلسلة مفاتيح مؤقتة للوظيفة ويسمّيها لـ
  electron-builder بـ`CSC_NAME`/`CSC_KEYCHAIN` (متغيراته القياسية)، لأن استيراد electron-builder 26 عبر
  `CSC_LINK` يفشل: يفتح سلسلته بكلمة مرور الشهادة بدل كلمة مرور السلسلة (ظهر في أول تشغيل). التوثيق
  (notarization) بمتغيراته القياسية `APPLE_ID` و`APPLE_APP_SPECIFIC_PASSWORD` و`APPLE_TEAM_ID`.
- **مقترح:** `versionCode` لأندرويد و`CFBundleVersion` لـ iOS = رقم تشغيل سير العمل، لتكون كل نسخة أحدث
  من سابقتها.
- معرّف ويندوز `AppUserModelId` صار `com.twuijri.corehub` أيضًا (يغيّر هوية الإشعارات لنسخة مثبّتة سابقًا؛
  لا توجد إصدارات منشورة بعد).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا تغيير في الشكل. مثالان في `openapi.yaml` (مرسِل APNs) كانا `bundle_id: hub.core.ios` وصارا
`com.twuijri.corehub`؛ وكذلك قيم الاختبار في اختبارَي مرسِل الإشعارات في الخادم.

## الملفات والتأثير
- أندرويد: `app/build.gradle.kts` (`applicationId`، إضافة Google Services تُطبَّق فقط إن وُجد
  `app/google-services.json`، إعداد توقيع release من متغيرات البيئة `COREHUB_ANDROID_*` وإلا يبقى غير
  موقّع، `versionCode` من `COREHUB_ANDROID_VERSION_CODE`)، `build.gradle.kts`، `libs.versions.toml`
  (`com.google.gms.google-services` 4.4.3)، `.gitignore` (`google-services.json` و`*.jks`/`*.keystore`).
- iOS: `project.yml` (المعرّفات، المجموعة، `DEVELOPMENT_TEAM`، `CFBundleVersion`/`CFBundleShortVersionString`
  من إعدادات البناء، `PROVISIONING_PROFILE_SPECIFIER` في Release من متغيرين يمررهما CI فقط)،
  `ShareInbox.swift`، `LocalNotices.swift`، `scripts/asc-profiles.mjs` (جديد)، `README.md`.
- سطح المكتب: `electron-builder.config.cjs` (`appId`، التوقيع فقط مع `CSC_LINK`/`CSC_NAME`،
  `forceCodeSigning` حينها، hardened runtime)، `scripts/package.mjs`، `src/main/index.ts`، `README.md`.
- CI (جديد): `.github/workflows/android-signed.yml`، `ios-signed.yml`، `desktop-signed.yml` — يدويًا أو
  بوسم `v*` على `main` فقط، لا على طلبات الدمج؛ مدخل `keep_artifacts` (افتراضيًا لا) لأن المستودع عام؛
  `upload_testflight` (افتراضيًا لا) لـ iOS. الأسرار في متغيرات بيئة الخطوات فقط، تُكتب ملفات بـ`printf %s`
  في مجلد المؤقت وتُحذف في خطوة `always()`، ولا تُطبع ولا تُرفع السجلات. `desktop.yml` تعليق فقط. وظائف
  طلبات الدمج وأسماؤها لم تتغيّر.
- وثائق: `docs/RELEASING.md` (جديد: المعرّفات، الأسرار، كيف يوقّع كل بناء، ما على المالك)،
  `docs/DEPLOY.md` (معرّف APNs)، ADR 0023 (تحديث بند التوقيع)، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (JDK 17، Android SDK، عبر `mj-run`): بناء release موقّع بمخزن مفاتيح تجريبي مؤقت وملف
`google-services.json` وهمي، ثم بدونهما:

```
$ COREHUB_ANDROID_KEYSTORE=…/test.jks … ./gradlew --no-daemon --max-workers=2 assembleRelease bundleRelease
BUILD SUCCESSFUL in 1m 55s
$ apksigner verify --print-certs app-release.apk   → Signer #1 certificate DN: CN=test
$ aapt2 dump badging app-release.apk               → package: name='com.twuijri.corehub' versionCode='1' versionName='0.1.0'
$ aapt2 dump resources app-release.apk | grep …    → string/gcm_defaultSenderId, string/google_app_id, string/project_id
# بلا ملف Firebase وبلا مخزن مفاتيح:
$ ./gradlew --no-daemon --max-workers=2 assembleRelease
BUILD SUCCESSFUL in 1m 8s      → app-release-unsigned.apk
$ pnpm lint                     → All matched files use Prettier code style!
$ pnpm typecheck                → exit=0
$ pnpm contracts:lint           → contracts:lint  OK
$ pnpm contracts:check-clients  → check-clients  OK — 571 client file(s) scanned, 222 contract path(s) known.
$ pnpm contract:test            → exit=0
$ vitest run src/modules/devices/push.test.ts tests/unit/devices-push.test.ts
 Test Files  2 passed (2)   Tests  26 passed (26)
$ pnpm --filter @corehub/desktop test
 Test Files  8 passed (8)   Tests  94 passed (94)
$ node -e "require('./electron-builder.config.cjs')"          → com.twuijri.corehub null false
$ CSC_LINK=x node -e "require('./electron-builder.config.cjs')" → com.twuijri.corehub undefined true
```

تشغيلات يدوية على هذا الفرع بالأسرار الحقيقية (`keep_artifacts=false`، `upload_testflight=false`؛ صفر
مخرجات مرفوعة في كل تشغيل):

```
Android signed build 36145769497 — success
  package: name='com.twuijri.corehub' versionCode='3' versionName='0.1.0'
  Verifies / Verified using v2 scheme (APK Signature Scheme v2): true
  Signed APK: 2.6M, AAB: 5.7M        artifacts: 0
iOS signed build 36145773790 — success
  created profile "CoreHub CI com twuijri corehub 43A76MJ69R"
  created profile "CoreHub CI com twuijri corehub share 43A76MJ69R"
  ** ARCHIVE SUCCEEDED **   ** EXPORT SUCCEEDED **
  Version 0.1.0 (3)   Identifier=com.twuijri.corehub   TeamIdentifier=58QWJ228ZE
  "application-identifier" => "58QWJ228ZE.com.twuijri.corehub"        group.com.twuijri.corehub
  "application-identifier" => "58QWJ228ZE.com.twuijri.corehub.share"  group.com.twuijri.corehub
  Signed .ipa: 5.5M          artifacts: 0
Desktop signed macOS build 36145777678 — failure (electron-builder's CSC_LINK import:
  "security set-key-partition-list … SecKeychainUnlock: The user name or passphrase you entered is not correct")
  → fixed by importing into the job's own keychain (CSC_NAME/CSC_KEYCHAIN); re-run below.
```

## المخاطر والرجوع
- التشغيلات الموقّعة لا تعمل على طلبات الدمج، فلا خطر على الفحوص المطلوبة؛ أسوأ الحالات فشل تشغيل يدوي.
- `asc-profiles.mjs` ينشئ ملفَّي تعريف في حساب Apple (أُنشئا فعلًا في التشغيل أعلاه) ويعيد استخدامهما، ولا
  يحذف شيئًا.
- الرجوع: حذف سير العمل الثلاثة الجديدة وإرجاع الملفات؛ بناءات طلبات الدمج لا تعتمد على شيء منها.
- دعم Firebase مؤجّل: الإضافة تعالج الملف فقط؛ لا مكتبة `firebase-messaging` بعد.

## التسليم والخطوة التالية
- المهمة التالية: تسجيل التطبيقات في FCM/APNs (مكتبة Firebase Messaging، `aps-environment`، `devicesRegisterPush`).
- على المالك: أيقونة تطبيق iOS وسجل التطبيق في App Store Connect قبل أول رفع إلى TestFlight (`docs/RELEASING.md`).
