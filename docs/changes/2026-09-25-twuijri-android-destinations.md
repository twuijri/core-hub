# تطبيق أندرويد — الجزء ٢: بقية الوجهات واختبار تكافؤ التنقّل
المسؤول: twuijri · الفرع: feat/android-app-destinations · الحالة: review

## المشكلة والهدف
تكملة لطلب المالك «ولو خلصت تطبيق الديسك توب … ابدا بالايفون والاندرويد». الجزء ١ (#122) بنى
الهيكل والإقران والمحادثة، وترك البحث والوكلاء والمهام والجدولة والإعدادات صفحات تقول إنها لم تصل.
هذا الجزء يبنيها، ويضيف اختبار تكافؤ التنقّل الذي يطلبه `docs/clients/README.md` من كل عميل.

الفرع مبني فوق `feat/android-app`، وطلب الدمج قاعدته ذلك الفرع حتى يُدمج #122 أولًا.

## القرار والموافقات
المالك نائم؛ القرارات التالية **مقترحة — والمالك يؤكد**:

- **المهام على الجوال**: عمود واحد في كل مرة بتبويبات أفقية («للعمل · ٣»…) بدل تسعة أعمدة لا تتسع
  لها الشاشة؛ كل البروفايلات بلا مرشّح (ADR 0016) وشارة البروفايل على البطاقة إن تعدّدت. البطاقة
  تفتح ورقة سفلية: النقل إلى عمود، الإسناد إلى وكيل من بروفايل المهمة مع «ابدأ العمل الآن»، البدء
  لمهمة مُسندة، وفتح محادثتها. السحب والإفلات مؤجَّل على الجوال: قائمة «انقل إلى…» هي المقابل
  الذي يطلبه `DESIGN.md` لكل سحب، وتكفي وحدها هنا. لا إنشاء مهام من الجوال في هذا الجزء.
- **الجدولة**: قائمة كل البروفايلات بحالة كل جدول والتشغيل التالي، وورقة فيها «شغّل الآن» والإيقاف
  والاستئناف وآخر عشرة تشغيلات (يفتح التشغيل محادثته). لا إنشاء ولا تعديل من الجوال بعد.
- **الوكلاء (للقراءة غالبًا)**: بطاقة لكل وكيل بحالته ووسوم قدراته (معلومات لا أزرار) وشرائح صفحاته
  كما يقرّرها الويب: ما أعلنه المحوّل من قدرات، و«الإعدادات» آخرًا لكل وكيل مثبّت. داخل صفحة وكيل
  على الجوال: «رجوع إلى الوكلاء» في الأعلى، ثم اسم الوكيل وصفوف صفحاته، ثم الصفحة (المهارات، MCP،
  الذاكرة، المهام المجدولة، القنوات، الإضافات، الإعدادات — كلها قراءة). للمالك والمشرف فقط؛ العضو
  يُعاد إلى المحادثة.
- **الإعدادات**: القائمة هي الصفحة، أولها «رجوع إلى المحادثات»، ثم التبويبات، ثم «الإدارة»،
  ثم «الأدوات»، وما للمشرف مخفي عن العضو. يرسم الجوال بنفسه: الحساب، العرض (اللغة والسمة)،
  الإشعارات (صندوق الإشعارات: تعليم المقروء، «علّم الكل مقروءًا»، والإشعار يفتح ما يخصّه)،
  الخصوصية (التطبيقات والأجهزة التي تعمل باسمك، للقراءة)، هذا الجهاز (الاتصال بالمركز؛ الجزء ٣ يكمله)،
  حول، السمة، البروفايلات، المستخدمون. **الباقي** (خطافات الويب، النماذج، اتصالات الأجهزة، المعرفة،
  السجلات، الاستخدام، الأداء، التحديثات، الإضافات) **يقول إنه في الويب ويفتح الصفحة نفسها في المتصفح
  على المركز نفسه** — صفحات إعداد تُضبط مرة واحدة ولا يحتاجها الجوال يوميًا.
- **البحث**: ورقة بحث حقلها مركَّز عند الدخول، تبحث في كل البروفايلات والمؤرشف أيضًا، ونتيجة الوكيل
  العام تفتح «الوكيل العام» في بروفايلها، وغيرها تفتح المحادثة في بروفايلها دون تحريك المبدّل.
- **الوكيل العام**: يُفتح بـ`openGlobalAgent` مع أول وكيل يمكن الحديث معه في البروفايل.
- **مسارات أندرويد** في `navigation.json` (`surfaceRoutes.android`): مسارات الويب نفسها ومعها
  `this_device` ← `/settings/this-device`، و`preAuth` ← `/login` و`/setup`. فرابط
  `corehub://open/<المسار>` ورابط الويب يسمّيان الصفحة نفسها، والتطبيق يفتحها.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- **تصحيح**: `TaskColumns.project_id` صار `Ulid | null` في `openapi.yaml` و`events/common.schema.json`.
  المركز يرسل `null` للوحة كل المشاريع (`tasks/index.ts`: `project_id: projectId ?? null`)، والويب
  يعامله كذلك (`project_id: string | null`)، لكن العقد كان يقول `Ulid` مطلوبًا. كشفه اختبار أندرويد
  الحيّ: عميل Kotlin رفض لوحة المهام الحقيقية. لا تغيير في سلوك المركز.
- `docs/clients/navigation.json`: `surfaceRoutes.android` و`preAuth.*.routes.android` (إضافة فقط).

## الملفات والتأثير
- `apps/android/app/src/main/java/hub/core/android/ui/screens/`: `SearchScreen.kt` (البحث والوكيل
  العام)، `AgentsScreen.kt` (البطاقات وصفحات الوكيل)، `TasksScreen.kt`، `SchedulesScreen.kt`،
  `SettingsScreen.kt` (القائمة وصفحاتها وصندوق الإشعارات)؛ `ui/components/Loadable.kt` (تحميل وقوائم).
- `nav/AppPaths.kt`: يحلّ مسارات `surfaceRoutes.android` (للروابط `corehub://open/…`) ويعطي رابط الويب
  للصفحات التي تُفتح هناك. `nav/Navigation.kt`: صفحات الوكيل من القدرات و«قابلية الإعداد» كما في الويب.
- `realtime/Realtime.kt`: الاشتراك الشامل في `/rt/tasks` و`/rt/schedules` يُعاد بعد كل اتصال.
- `app/build.gradle.kts`: يولّد `SurfaceRoutes` (الويب وأندرويد وما قبل الدخول) من `navigation.json`.
- `MainActivity.kt`: كل الوجهات، وفتح `corehub://open/<المسار>`.
- النصوص بالعربية والإنجليزية (تسميات الحالات والأولويات مطابقة للويب).
- `apps/android/.gitignore`: كان `data/` في `.gitignore` الجذري يُسقط حزمة `data` من الشيفرة؛ أُصلح في
  #122 ودُمج هنا.

الاختبارات الجديدة:
- `NavigationParityTest` (القواعد ١–٧ في `docs/clients/README.md`) يقرأ `navigation.json` من المستودع:
  كل وجهة لها شاشة وكل شاشة لها وجهة، شاشتا ما قبل الدخول ومساراهما، الشريط والمقاطع والتذييل
  وتبويبات الإعدادات والإدارة والأدوات وصفحات الوكيل بالترتيب نفسه وبلا مدخلين أساسيين لوجهة، كل
  مصطلح بالعربية والإنجليزية مطابق للمولَّد، البحث هو الطريق الثانوي إلى المحادثة والوكيل العام، وجهات
  المشرف مخفية عن العضو، صفحات الوكيل من القدرات (بوكيل مزيّف بجزء منها)، وكل مسار أندرويد يُحلّ إلى
  وجهته. القاعدة ٨ (البروفايل مرشّح): المبدّل لا يلمس المكدّس ولا المرشّح بالبناء (`ChatsListTest`)،
  ولا اختبار واجهة له لأن اختبارات Compose تحتاج جهازًا.
- `AppPathsTest`، `DestinationsTest` (أعمدة اللوحة، النقل والبدء والشارات، روابط الإشعارات).
- `LiveHubTest` (اختياري): أُضيف له اختبار يقرأ كل ما يقرؤه الجوال من مركز حقيقي — كشف تصحيح العقد
  أعلاه، وأنّ `profiles=all` لا يُجمع مع `profile` في لوحة المهام (`400`؛ أُصلح في التطبيق).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا:

```
$ ./gradlew --no-daemon --max-workers=2 :app:testDebugUnitTest
testsuite hub.core.android.chat.ChatReducerTest tests="8" failures="0" errors="0"
testsuite hub.core.android.contract.ContractExamplesTest tests="1" failures="0" errors="0"
testsuite hub.core.android.data.AuthTest tests="8" failures="0" errors="0"
testsuite hub.core.android.data.PairingTest tests="7" failures="0" errors="0"
testsuite hub.core.android.data.RealtimeTest tests="3" failures="0" errors="0"
testsuite hub.core.android.data.SecureStoreTest tests="3" failures="0" errors="0"
testsuite hub.core.android.live.LiveHubTest tests="1" skipped="1" failures="0" errors="0"
testsuite hub.core.android.markdown.MarkdownTest tests="6" failures="0" errors="0"
testsuite hub.core.android.nav.AppPathsTest tests="4" failures="0" errors="0"
testsuite hub.core.android.nav.NavigationParityTest tests="8" failures="0" errors="0"
testsuite hub.core.android.ui.ChatsListTest tests="5" failures="0" errors="0"
testsuite hub.core.android.ui.DestinationsTest tests="3" failures="0" errors="0"
testsuite hub.core.android.ui.StringsParityTest tests="2" failures="0" errors="0"

$ COREHUB_LIVE_HUB=http://127.0.0.1:8791 … ./gradlew :app:testDebugUnitTest --tests '*LiveHubTest*'
tests 2 failures 0 errors 0
live: run ended; failure=stream ended unexpectedly; messages=[(user, مرحبا), (assistant, )]; lastSeq=8
live: board 9 columns; 0 schedules; 6 notices; 1 profiles; 1 users; 0 app tokens; hub Core Hub 1.0.0; direct settings 1 sections; search 2 hits

$ ./gradlew --no-daemon --max-workers=2 assembleDebug lint
(0 errors, 17 warnings/information)
app-debug.apk  15,582,765 bytes

$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web, android
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 327 client file(s) scanned, 176 contract path(s) known.
$ pnpm lint
All matched files use Prettier code style!
$ pnpm --filter @corehub/web typecheck   (exit 0)
```

CI على #125 (قاعدته `feat/android-app`):

```
Android build, unit tests, lint                       pass   (run 36094329104, BUILD SUCCESSFUL in 5m 13s)
  Debug APK: 15M (14885947 bytes) · artifact corehub-android-debug-apk (14,314,335 bytes zipped)
Lint, typecheck, contracts, tests, build              pass
Web smoke journeys (Playwright against the real hub)  pass
Docker image builds and answers /health               pass
db:generate + db:migrate (SQLite and PostgreSQL)      pass
PR adds or updates a change record                    pass
PR leaves graphify-out/ to the code-map bot           pass
```

## المخاطر والرجوع
- `navigation.json` يتغيّر أيضًا في طلب سطح المكتب #111 (`surfaceRoutes.desktop`) في الموضع نفسه؛ من
  يُدمج ثانيًا يحلّ تعارضًا نصيًّا بسيطًا (إبقاء المفتاحين).
- ما يُفتح في الويب من الجوال يحتاج دخولًا في المتصفح؛ الجوال لا ينقل رمزه إلى المتصفح عمدًا.
- الرجوع: عكس هذا الطلب يعيد الجزء ١ كما هو؛ تصحيح العقد يطابق ما يرسله المركز ولا يغيّره.

## التسليم والخطوة التالية
الجزء ٣: الإشعارات أثناء عمل التطبيق (وحدة `devices` ما زالت 501)، المشاركة إلى كور هب، الإدخال الصوتي،
وإكمال «هذا الجهاز».
