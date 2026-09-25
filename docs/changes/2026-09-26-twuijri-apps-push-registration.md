# تطبيقا الجوال يستقبلان الإشعارات الفورية (FCM وAPNs)
المسؤول: twuijri · الفرع: feat/apps-push-registration · الحالة: review

## المشكلة والهدف
المركز صار يملك سجل الأجهزة ومرسِلَي FCM وAPNs (#132، `docs/changes/2026-09-25-twuijri-devices-push.md`)،
لكن تطبيقي أندرويد وiOS لا يسجّلان رمز دفع، فيبقيان على الفحص الدوري: WorkManager كل ١٥ دقيقة في
أندرويد، وBackground refresh في iOS، و`notice.created` من المقبس ما دام التطبيق حيًّا. والمعرّفات النهائية
(`com.twuijri.corehub`) والبناء الموقّع جاهزان منذ `docs/changes/2026-09-26-twuijri-app-ids-signing.md`.

الهدف: أن يسجّل كل تطبيق رمزه عند المركز بعد الدخول ويجدّده، ويزيله عند الخروج، ويعرض الإشعار ويفتح عند
الضغط الصفحة التي يخصها، ويبقى على الفحص الدوري حين لا يتوفر الدفع — دون إرسال أي دفع حقيقي ودون وضع
بيانات اعتماد في أي مركز.

## القرار والموافقات
طلب المالك المهمة ضمن ليلة ٢٠٢٦-٠٩-٢٦ (#144). كل ما يلي **مقترح — ينتظر تأكيد المالك**:

1. **على أي جهاز يُسجَّل الرمز**: الجوال المقترن بالرمز (QR) يستعمل الجهاز الذي صنعه الاقتران (رقمه من ردّ
   `auth.claimPairing`، يُحفظ مع الجلسة؛ والتثبيت الأقدم يجده بـ`this_device` في `devices.list`). والدخول
   باسم المستخدم وكلمة المرور يسجّل هذا التثبيت جهازًا بـ`devices.register` بمفتاحه الثابت `device_key`
   (الصف نفسه كل مرة)، فيظهر الجوال في قائمة الأجهزة. صف أُزيل من الويب يُسجَّل من جديد مرة واحدة.
2. **لا عقد جديد ولا تغيير في الخادم**: الحمولة تحمل ما يحتاجه الضغط (`resource_kind`/`resource_id`/
   `profile` في FCM، و`resource`/`profile` بجانب `aps` في APNs)، و`PushRegistration.provider` يحدد نوع الرمز.
3. **أندرويد**: Firebase Messaging (BoM 34.19.0) مربوط في كل بناء، لكنه لا يبدأ إلا في بناء فيه
   `google-services.json` (`BuildConfig.FIREBASE` و`FirebaseApp.getApps`)؛ غيره يقول في «هذا الجهاز» إنه
   بلا دفع ويبقى على الفحص. التهيئة التلقائية لـ FCM مطفأة: لا رمز قبل الدخول، ويُحذف الرمز
   (`deleteToken`) عند أي خروج — حتى الخروج الذي يقرره المركز — فيردّ FCM على المركز `UNREGISTERED` وينسى الرمز.
4. **رموز التسجيل لا معرّف التثبيت**: Firebase Messaging 25.1 جعل `getToken`/`deleteToken`/`onNewToken`
   «deprecated» لصالح التسجيل بمعرّف التثبيت (`register()`/`onRegistered`)، لكن مرسِل المركز يرسل إلى رمز
   تسجيل (`message.token` في HTTP v1)، فبقي التطبيق على الرموز (والتحذير مكتوم بتعليق يشرح السبب).
5. **الفحص الدوري**: ما دام الرمز مسجلًا يتوقف WorkManager في أندرويد، ولا يُجدول Background refresh في
   iOS؛ وفي كل حالة أخرى (بناء بلا Firebase، لا مرسِل في المركز، رفض أو خطأ، إشعارات غير مسموحة في iOS)
   يبقى كما كان. و«هذا الجهاز» في التطبيقين يقول أي حالة قائمة.
6. **لا إشعار مكرر**: أندرويد يضع إشعاره في خانة FCM نفسها (الوسم = `notice_id`، الرقم 0) مع
   `setOnlyAlertOnce`، ولا يعرض إشعار المقبس في الخلفية ما دام الدفع فعّالًا. iOS يشارك قائمة «ما عُرض» بين
   المقبس والفحص والدفع، فالدفع الذي سبقه المقبس في المقدمة لا يُعرض ثانية.
7. **وقت الإذن**: أندرويد ١٣+ يسأل مرة بعد الدخول (كما كان، `NotificationPermission`)؛ iOS يسأل مرة بعد
   الدخول (كما كان) ويسجّل للدفع فقط إن سُمح.
8. **`aps-environment`**: من إعداد بناء `COREHUB_APS_ENVIRONMENT`: `production` في Release (App Store
   وTestFlight)، و`development` في Debug من Xcode؛ وسير العمل الموقّع يفشل إن لم تكن `production`.
9. **الضغط**: أندرويد — الإشعار الذي يعرضه النظام يفتح `MainActivity` ومعه `data` الدفع، فيحوَّل إلى المسار
   نفسه الذي يفتحه الإشعار في الوارد (`/chat/<id>?profile=…`، `/tasks`، `/schedules`، وإلا
   `/settings/notifications`). iOS — `NoticeRouting.tap` يقرأ الشكلين (مفاتيح الإشعار المحلي، وحمولة المركز)،
   والضغط الذي أطلق التطبيق قبل معرفة الجلسة يُحفظ ويُتبع بعد الدخول (المندوب يُعيَّن في
   `didFinishLaunching`).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. التطبيقان يستدعيان عمليات موجودة عبر العميلين المولَّدين فقط: `devices.getPushConfig`،
`devices.register`، `devices.list`، `devices.registerPush`، `devices.unregisterPush`.

## الملفات والتأثير
- أندرويد: `gradle/libs.versions.toml` (Firebase BoM وMessaging)، `app/build.gradle.kts`
  (`BuildConfig.FIREBASE`)، `AndroidManifest.xml` (`PushService`، إطفاء التهيئة التلقائية، القناة والأيقونة
  الافتراضيتان)، `phone/Push.kt` (جديد: `PushState`، `PushPayload`، `PushRegistrar`)، `phone/PushService.kt`
  (جديد: `PushManager`، `PushService`، `thisPhone`)، `phone/Notices.kt` (المسار من أجزاء الدفع، خانة الإشعار)،
  `phone/ThisDevice.kt` (حالة الدفع)، `AppGraph.kt` (التسجيل مع الجلسة، جدولة الفحص، `signOut`)،
  `MainActivity.kt` (ضغط الدفع، تبديل المركز يزيل الدفع)، `data/SessionStore.kt` (`deviceId`)، `data/Hub.kt`
  (`DevicesApi`)، `ui/screens/ConnectViewModel.kt`، `ui/screens/ShellViewModel.kt`، `res/values{,-ar}/strings.xml`،
  `app/src/test/.../phone/PushTest.kt` (جديد).
- iOS: `project.yml` (`aps-environment`)، `CoreHub/Phone/Push.swift` (جديد: `PushRegistrar`، `HubPushBackend`،
  `PushCenter`، `AppDelegate`)، `Phone/LocalNotices.swift`، `App/AppModel.swift`، `App/CoreHubApp.swift`،
  `Auth/Credentials.swift` (`deviceID`)، `Settings/SettingsScreen.swift`، `i18n/{ar,en}.json`، `README.md`،
  `CoreHubTests/PushTests.swift` (جديد).
- CI: `.github/workflows/ios-signed.yml` (فحص `aps-environment` = `production` فقط؛ لا تغيير في الوظائف أو
  أسمائها).
- وثائق: `docs/STATUS.md`، `docs/RELEASING.md` (أندرويد لا يملك README؛ فقرته في RELEASING)، هذا السجل،
  وسطر في `docs/changes/2026-09-26-twuijri-night-pr.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (JDK 17، Android SDK، عبر `mj-run`):
```
$ pnpm --filter @corehub/contracts generate:native      → contracts:generate:native  OK
$ ./gradlew --no-daemon --max-workers=2 testDebugUnitTest --tests 'hub.core.android.phone.*'
BUILD SUCCESSFUL in 11s
<testsuite name="hub.core.android.phone.PhoneTest" tests="6" skipped="0" failures="0" errors="0"
<testsuite name="hub.core.android.phone.PushTest" tests="8" skipped="0" failures="0" errors="0"
$ ./gradlew --no-daemon --max-workers=2 assembleDebug test lint          (بلا google-services.json، كما في CI)
BUILD SUCCESSFUL in 50s        (lint: لا جديد في الملفات المعدّلة؛ التحذيرات الموجودة كما هي)
# بملف google-services.json وهمي (غير مرفوع، git-ignored) لإثبات مسار Firebase:
$ ./gradlew --no-daemon --max-workers=2 assembleRelease
BUILD SUCCESSFUL in 1m 14s
  public static final boolean FIREBASE = true;      → app-release-unsigned.apk 3094138 bytes
$ node apps/ios/scripts/generate-swift.mjs --check  → generate-swift  OK — every generated file matches its source
$ pnpm i18n:check                  → i18n:check  ios: 284 keys, ar/en in parity · OK
$ pnpm contracts:check-clients     → check-clients  OK — 576 client file(s) scanned, 222 contract path(s) known.
$ pnpm lint                        → All matched files use Prettier code style!
```
لا Xcode محليًا، فشُغّل سير عمل iOS وأندرويد يدويًا على فرع المهمة (`workflow_dispatch`):
```
iOS 36152191252 — success
  ** TEST SUCCEEDED **   Executed 61 tests, with 0 failures
  Test Case '-[CoreHubTests.PushTests testAPasswordSignInRegistersThisPhoneThenItsToken]' passed
  … والثمانية كلها passed (paired, no sender/409, removed device, sign-out, hex, tap routing, This device strings)
Android 36152196140 — success
  BUILD SUCCESSFUL in 4m 48s   Debug APK: 17M (17245331 bytes)
```
ما تثبته الاختبارات: الدخول بكلمة المرور يسجّل الجهاز مرة ثم الرمز (والرمز المتجدد يذهب إلى الجهاز نفسه
بلا تسجيل ثانٍ)؛ المقترن يستعمل جهاز الاقتران أو يجد `this_device`؛ مركز بلا مرسِل (أو 409) يترك الفحص؛
الجهاز المحذوف يُسجَّل مرة؛ الخروج يرسل `DELETE …/push` ولا شيء بلا جهاز؛ الحمولة ← المسار (ومعرّف غريب
يُرمَّز فلا يخرج من المسار)؛ الرمز hex؛ نصوص الحالات موجودة بالعربية والإنجليزية. تسقط كلها على الكود
القديم (الأصناف غير موجودة).

CI على #144 بعد الدمج في فرع الليلة: يُضاف أدناه.

## المخاطر والرجوع
- **الرجوع**: revert للطلب. لا ترحيل، لا عقد، لا خادم. الجلسات المحفوظة تقرأ `deviceId`/`deviceID` كحقل
  اختياري، فالنسخة الأقدم تتجاهله.
- **لم يُرسل أي دفع حقيقي** ولم يُجرَّب على هاتف: المرسِلان مطفآن حتى يُدخل المالك بياناتهما، والاختبارات
  على مركز مزيّف.
- iOS: إن أنهى المركز جلسة كلمة المرور (انتهت أو أُلغيت) فلا يستطيع التطبيق إزالة تسجيله، فيبقى الرمز عند
  المركز حتى يُحذف الجهاز من الويب (الجهاز المقترن يلغيه المركز مع رمزه). أندرويد يحذف رمز FCM في تلك الحال.
- الدخول بكلمة المرور صار يضيف الجوال إلى قائمة الأجهزة (مرة واحدة لكل تثبيت).
- حجم التطبيق: Firebase Messaging يضيف مكتباته؛ نسخة release غير الموقّعة ٣٫٠ م.ب.
- واجهات FCM المستعملة «deprecated» في 25.1؛ الانتقال إلى التسجيل بمعرّف التثبيت يحتاج دعمًا في مرسِل المركز.

## التسليم والخطوة التالية
- **ليصل دفع حقيقي إلى أندرويد**: في المركز، اتصالات الأجهزة ← الأجهزة ← مرسِلات الإشعارات ← FCM:
  ملف JSON لحساب خدمة مشروع Firebase `core-hub-66772`. ثم ثبّت نسخة من `android-signed.yml` (هي وحدها فيها
  `google-services.json`)، وادخل، واسمح بالإشعارات، وتأكد أن «هذا الجهاز» يقول إن الدفع يعمل، ثم «تجربة» على
  الجهاز من الويب (`devices.testPush`).
- **ليصل إلى الآيفون**: مرسِل APNs بمفتاح `.p8` وKey ID وTeam ID `58QWJ228ZE` وBundle ID
  `com.twuijri.corehub` وبيئة `production`؛ ثم نسخة TestFlight من `ios-signed.yml` (تحتاج أيقونة التطبيق وسجل
  App Store Connect)، أو `sandbox` لنسخة Debug من Xcode.
- متابعة ممكنة: التسجيل بمعرّف تثبيت FCM حين يدعمه المرسِل؛ إزالة تسجيل iOS عند خروج يقرره المركز.
