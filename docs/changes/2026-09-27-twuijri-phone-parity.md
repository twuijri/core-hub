# الجوال: الأقسام الناقصة في التطبيقين
المسؤول: twuijri · الفرع: feat/phone-parity · الحالة: in-progress

## المشكلة والهدف
المالك: «تطبيق الجوال ينقصه أقسام كثيرة لم تكتمل». المطلوب في الآيفون والأندرويد معًا (B8، B12–B15 من قائمة الفجوات):
سير العمل، صفحات الوكيل قابلة للتعديل في أندرويد مثل الآيفون، لوح المهام بالسحب، «مشاركة إلى كور هب» للصور والملفات،
النماذج والإدارة داخل التطبيق بدل «افتح الويب»، وأن يسأل الوكيل الجوال عن موقعه بموافقة. كله بتصميم العائلة الواحدة:
طقم أندرويد (`ui/kit`) وأيقونات Lucide، وأنماط الجوال المضغوطة (نقطة الحالة، «⋯»، الألواح، إجراء أساسي واحد)، والعربية
والإنجليزية في كل نص، واتجاه صحيح.

## القرار والموافقات
**١. سير العمل (B12/B13)** — نصف ثانٍ في صفحة الجدولة («الجدولة | سير العمل»)، كما في الويب، لا وجهة جديدة:
- قائمة سير العمل من كل البروفايلات (`profiles=all`) وشارة البروفايل حين تتعدد؛ حالة كل واحد نقطة ملوّنة، وعدد الخطوات
  والتشغيلات وحدوده سطرًا هادئًا.
- لوح سير العمل (أندرويد) / صفحته (الآيفون): مدخل اختياري، و«حدود هذا التشغيل» مطوية بالحدود الثلاثة التي يقبلها المركز
  (أطول مدة بالدقائق حتى أسبوع، أعلى تكلفة بالدولار، أطول مدة للخطوة حتى يوم؛ الحقل الفارغ يُبقي حد سير العمل)، و«شغّل»
  إجراءً أساسيًا، وآخر التشغيلات.
- عرض التشغيل للقراءة فقط ويتحدّث حيًّا: يُقرأ كل ثانيتين ما دام لم ينتهِ (كالويب) ومع أحداث `/rt/schedules`
  و`approval.*`؛ الخطوات بترتيب تنفيذها ثم ما لم يصل إليه بعد، كل خطوة بأيقونة نوعها ونقطة حالتها ومدتها وأول سطر من
  ناتجها؛ الخطوة المنتظرة تُسأل هنا: «وافق» أو «ارفض» مع سبب اختياري (`sessions.respondApproval`، `approve_once`/`deny`)؛
  «أوقف التشغيل» ما دام يعمل؛ وسبب التوقف حين يوقفه حد.
- الرسم والتحرير يبقيان على الويب (سطر يقول ذلك).

**٣. لوح المهام بالسحب (B14/B15)** — شكل لوح الويب نفسه (`packages/web/src/tasks/board.ts`): «الوارد» ثم أربعة أعمدة
(قيد العمل، بالانتظار، المراجعة، منجزة) متجاورة، يُتنقَّل بينها بالتمرير والسحب الأفقي، ورقائق أعلاها بعدد كل عمود تقفز
إليه.
- أندرويد: ضغط مطوّل يرفع البطاقة وتتبع الإصبع فوق كل شيء، والصفحة تتمرر قرب الحافة؛ الإفلات في عمود آخر نقلة يسمح بها
  الويب (تُسأل «ماذا تعني هذه النقلة؟» حين تحتمل اثنتين، ويُطلب السبب للتعطّل)، وداخل العمود إعادة ترتيب
  (`after_task_id`، بعد آخر بطاقة من البروفايل نفسه فوق نقطة الإفلات). العمود الذي لا يقبل البطاقة يخفت.
- الآيفون: `draggable`/`dropDestination` على الأعمدة والرقائق، والأعمدة بعرض 86% تلتقط عمودًا عمودًا.
- عمود «بالانتظار» الفارغ شريط ضيق حتى يُفتح أو تُسحب إليه بطاقة يقبلها؛ وعدد الأرشيف تحت «منجزة».
- شارتا الليلة (§93): «تنتظر N» (وأسماء ما تنتظره في لوح المهمة) و«تبدو عالقة» (ومتى صمت تشغيلها).

**٢. صفحات الوكيل (B14)** — أندرويد صار يعدّل مثل الآيفون: تشغيل المهارات وإيقافها، MCP (تشغيل/إيقاف و«اختبر» بنتيجته)،
تعديل الذاكرة في لوح، «شغّل الآن» وإيقاف مؤقت للمهام المجدولة، الإضافات، والإعدادات في مكانها (مفتاح، اختيار من قائمة،
نص أو رقم أو سرّ في نافذة؛ القوائم وJSON على الويب؛ الفارغ يعيد الافتراضي). وفي الجهازين:
- **الإعدادات المحفوظة (§100)** في رأس صفحة الإعدادات: «استخدمه»، «احفظ الإعدادات الحالية»، حذف؛ وما تُخطّي عند التطبيق
  يُقال.
- **ملفات الإعداد (§78)** صفحة للوكيل (للمشرفين، بقدرة `config_files`): ملف في كل مرة، Markdown بخط القراءة واتجاهه، وJSON
  وTOML من اليسار بخط ثابت؛ الحفظ بالمراجعة `revision`، و`409 changed` يقول «تغيّر في مكان آخر» مع «أعد التحميل». غيّرت
  `navigation.json` أسطح `agent_config_files` إلى الأربعة ومساراتها للجوالين — **مقترح، للمالك أن يؤكد** (كان «ليس على
  الجوال»).
- **القنوات**: المنصات المربوطة (وحالتها نقطة، والحساب، و«افصل» بتأكيد)، «بانتظار الموافقة» (وافق/ارفض) و«الموافق عليهم»
  (اسحب)، و«اربط منصة»: ما يُربط برمز بوت أو بيانات دخول يُربط من الجوال (الحقول من `listChannelPlatforms` بترتيبها، والسري
  مخفي)؛ وما يُربط بمسح رمز (واتساب) لا يُمسح من شاشة الجوال نفسه، فيُقال ذلك بوضوح مع «افتح على الويب» لشاشة أخرى.

**٤. مشاركة إلى كور هب** — تقبل الصور والفيديو والملفات، لا النص وحده:
- أندرويد: `SEND` و`SEND_MULTIPLE` لـ`image/*` و`video/*` و`audio/*` و`application/*` و`text/*`؛ تُنسخ فورًا (والصورة
  تُصغَّر أو تبقى أصلية كما يختار «+» في «هذا الجهاز»)، وتفتح محادثة جديدة مرفقاتها فيها وتُرفع؛ تعليق الصورة يصير المسودة
  (لا عنوانها، وهو غالبًا اسم الملف).
- الآيفون: الامتداد يقبل حتى 10 صور و5 فيديوهات و10 ملفات، ينسخها إلى مجلد مجموعة التطبيق (`share-inbox`) بأسمائها (مرقّمة
  عند التكرار، ولا اسم يخرج من المجلد)، والتطبيق يأخذها مرة ويرفقها في محادثة جديدة ثم يحذف النسخ.

**٥. النماذج والإدارة داخل التطبيق** (المالك سأل لماذا تنقص الأقسام، فالافتراضي أصلي لا «افتح الويب»):
- **النماذج**: أربعة أقسام — المزوّدون (حسب النوع، نطاقه، عدد نماذجه، حالته نقطة أو «يحتاج مفتاحًا/سجّل الدخول»، و«⋯»:
  تشغيل/إيقاف، اختبر، أعد قراءة النماذج، سجّل الدخول، إزالة)، و«أضف مزوّدًا» من الكتالوج بمفتاح أو بعنوان أو بتسجيل الدخول
  (رمز الجهاز: الرمز ونسخه وفتح الصفحة وانتظار الموافقة)، ولمن (كل البروفايلات أو هذا وحده)؛ الافتراضي: نموذج المحادثة
  والبدائل بترتيبها **بالسحب** (مقبض بضغط مطوّل في أندرويد، ومقابض القائمة في الآيفون)؛ الصوت: مزوّد الإملاء والنطق
  وجاهزيتهما، واختيار الصوت من كل أصوات المزوّد بكل لغاته (لغات الشخص أولًا، وبحث بالاسم أو اللغة) ومعاينة قبل الحفظ
  (`models.synthesize`، MP3)؛ الصور: نموذج الرسم من مزوّدين يرسمون فقط (§87).
- **الإدارة**: الأشخاص (القائمة، «أضف شخصًا» باسم وكلمة مرور ودور وبروفايلات، واجعله مشرفًا/عضوًا، أوقف/فعّل، عيّن كلمة
  مرور، احذف؛ المالك لا يُعدَّل)؛ جدول إعدادات الإشعارات (كل نوع إشعار: في التطبيق / تنبيه، وساعات الهدوء)؛ الأجهزة
  بطاقات #149 (نقطة الاتصال، الطراز والإصدار، آخر نشاط، التنبيه؛ «⋯»: إعادة تسمية، اختبار التنبيه، إزالة) مع رمز اقتران
  (QR ورمز ورابط للنسخ والمشاركة) في أندرويد؛ والاستخدام (٧ أو ٣٠ يومًا، كل البروفايلات للمشرف، الرموز والتشغيلات والتكلفة،
  ثم حسب النموذج والوكيل). السجلات كانت أصلية في الجهازين.
- الطرفية تبقى على الويب وحده (`surfaces: [web]`)، ولا يعرضها الجوال.

**٦. الوكيل يسأل الجوال عن موقعه (B8، DECISIONS §105 — مقترح، للمالك أن يؤكد)** — العقد أولًا:
- رمز تشغيل الوكيل صار يستطيع إنشاء طلب `location` لجهاز شخصه (كان `files` و`apps` فقط، §89)؛ غير ذلك يبقى بصلاحية
  `device`. الانتظار الافتراضي لطلب الموقع 90 ث (ليقرأ الشخص ويجيب).
- أداة جديدة في مجموعة `devices` من أدوات المركز: `devices.locate` (قراءة): الجوال المسمّى، أو الذي يعلن `location`
  مفعّلًا ويُسأل في هذا البروفايل، المتصل أولًا ثم الأحدث ظهورًا؛ الجواب `{device, latitude, longitude, accuracy_m,
  captured_at}`، و`why` يصير `purpose` الذي يقرؤه الشخص؛ الرفض أو عدم الجواب أو عدم وجود جوال رفضٌ يقرؤه الوكيل.
- الجوالان يعلنان `location` في التسجيل والتقرير عند كل تشغيل (مفعّلًا ما لم يقل الشخص «أبدًا»)، ويسمعان
  `request.created` على `/rt/devices` ويلحقان بالمعلّق (`listRequests?status=pending`) عند العودة؛ أول مرة نافذة موافقة:
  «اسمح في كل مرة» أو «هذه المرة فقط» أو «لا تسمح»، ثم إذن النظام للموقع؛ و«هذا الجهاز» فيه «الموقع للوكلاء»: اسأل /
  دائمًا / أبدًا. أندرويد يقرأ الموقع من خدمة النظام نفسها (بلا خدمات Play)، والآيفون من CoreLocation مع نص
  `NSLocationWhenInUseUsageDescription` بالعربية والإنجليزية (مولَّد من `i18n`).

**أنماط مقترحة — للمالك أن يؤكد:** حالة سير العمل والتشغيل والمزوّد والجهاز نقطة لا كلمة؛ إجراءات البطاقة الثانوية في «⋯»؛
«شغّل» و«أضف» إجراء أساسي واحد في كل لوح.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `devices.createRequest`: رمز تشغيل الوكيل يُنشئ `location` أيضًا (وصف العملية)، وDECISIONS §105. لا عملية ولا حدث جديد؛
  الأداة `devices.locate` في كتالوج أدوات المركز (الخادم).
- `docs/clients/navigation.json`: `agent_config_files` على الأسطح الأربعة ومساراتها في `surfaceRoutes.ios` و`android`.

## الملفات والتأثير
- أندرويد (`apps/android/app/src/main/java/hub/core/android/ui/screens/`): `WorkflowsScreen.kt`، `TasksBoard.kt`،
  `AgentPages.kt`، `ModelsScreen.kt`، `AdminPages.kt` (جديدة)؛ `SchedulesScreen.kt`، `TasksScreen.kt`، `AgentsScreen.kt`،
  `SettingsScreen.kt`؛ `phone/Share.kt`، `MainActivity.kt`، `AppGraph.kt`، `ChatScreen.kt`، `AndroidManifest.xml`،
  `nav/Navigation.kt`؛ النصوص في `res/values*/strings_parity.xml` (ملف خاص بالمهمة، و`StringsParityTest` صار يقرأ كل
  `strings*.xml`).
- الآيفون (`apps/ios/CoreHub/`): `Screens/Workflows.swift`، `Screens/TasksBoard.swift`، `Screens/AgentPagesMore.swift`،
  `Settings/ModelsAdminPages.swift` (جديدة)؛ `Screens/TasksSchedules.swift`، `Screens/AgentsScreens.swift`،
  `Navigation/Destinations.swift`، `Navigation/Routes.swift`، `Shell/SidebarView.swift`، `Shell/ShellView.swift`،
  `Chat/NewChatScreen.swift`، `App/AppModel.swift`، `Share/ShareInbox.swift`، `CoreHubShare/ShareViewController.swift`،
  `Settings/SettingsScreen.swift`، `Settings/ManagementPages.swift`، `Settings/SettingsPages.swift`، `project.yml` (قاعدة
  تفعيل الامتداد)، `i18n/*.json`.
- أيقونات Lucide مشتركة جديدة (`scripts/icons/lucide-mobile.json`): workflow، map-pin، file-cog، grip-vertical، volume-2،
  mail، وصار key-round وuser-plus وtrash وclock وpause وexternal-link وlist-filter وrefresh-cw وlink وpencil وarrow-left
  مشتركة.
- الخادم: `modules/devices/requests.ts` (`AGENT_CAPABILITIES` و مهلة الموقع)، `modules/devices/index.ts` (تعليق)،
  `modules/agents/hub-tools/catalog.ts` (`devices.locate`، `phoneToLocate`)؛ الاختبارات `tests/unit/device-helper.test.ts`
  و`hub-tools.test.ts`.
- الموقع: أندرويد `phone/Locate.kt` (جديد)، `phone/ThisDevice.kt`، `phone/PushService.kt`، `AppGraph.kt`،
  `MainActivity.kt`، `AndroidManifest.xml` (إذنا الموقع)؛ الآيفون `Phone/Locate.swift` (جديد)، `App/AppModel.swift`،
  `Shell/ShellView.swift`، `Settings/SettingsPages.swift`، `scripts/generate-swift.mjs` و`InfoPlist.strings`.
- `docs/STATUS.md`: سطر «أقسام الجوال الناقصة»، وسطرا `devices` و`agents` عن `location` و`devices.locate`.
- الاختبارات: أندرويد `src/test/.../parity/` (`WorkflowsTest`، `BoardTest`، `AgentPagesTest`، `ShareFilesTest`،
  `ModelsAdminTest`، `LocateTest` — بعضها أمام مركز مُبرمج `MockWebServer`)، و`PhoneTest` (تعليق الصورة)؛ الآيفون `WorkflowsTests`،
  `BoardTests`، `AgentPagesTests`، `ShareFilesTests`، `ModelsAdminTests`، `LocateTests`، و`FamilyTests` (أيقونة ملفات الإعداد).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ ./gradlew --no-daemon --max-workers=2 testDebugUnitTest      (apps/android، بعد المجموعات ١ و٣)
tests 163 skipped 2 failures 0 errors 0          # منها ScreenShots (لقطة المهام صارت اللوح)

$ ./gradlew testDebugUnitTest --tests 'hub.core.android.parity.*' …
TEST-hub.core.android.parity.WorkflowsTest.xml   tests="7" failures="0" errors="0"
TEST-hub.core.android.parity.BoardTest.xml       tests="5" failures="0" errors="0"
TEST-hub.core.android.parity.AgentPagesTest.xml  tests="6" failures="0" errors="0"
TEST-hub.core.android.parity.ShareFilesTest.xml  tests="3" failures="0" errors="0"
TEST-hub.core.android.parity.ModelsAdminTest.xml tests="6" failures="0" errors="0"
TEST-hub.core.android.phone.PhoneTest.xml        tests="6" failures="0" errors="0"
TEST-hub.core.android.nav.NavigationParityTest.xml tests="8" failures="0" errors="0"

$ pnpm contracts:check-clients
check-clients  OK — 752 client file(s) scanned, 250 contract path(s) known.
$ pnpm i18n:check
i18n:check  ios: 667 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 39 destinations, 2 pre-auth screens (login, setup), 44 terms, ar/en complete, routes for web, ios, android, desktop
$ prettier --check <الملفات المتغيرة>
All matched files use Prettier code style!
```
CI على الفرع (`workflow_dispatch`):
```
Android  36218420165  success   (المجموعات ١–٣)
iOS      36217446781  failure   # بنى الكود؛ فشل L10nTests على nav.linked_hubs — أُصلح في الفرع الليلي (bc4b4f14) ودُمج
iOS      36218418410  failure   # Tone.statusReview غير موجود في الآيفون → Color.token(\.statusReview)
iOS      36218641339  failure   # FamilyTests: أيقونة agentConfigFiles → أضيفت file-cog إلى جدول الاختبار
iOS      36219113898  success   (المجموعات ١–٤)
```

## المخاطر والرجوع
- الآيفون لا يُبنى على هذا الجهاز (لينكس)؛ كل تحقق من الآيفون من CI (`ios.yml` بـ`workflow_dispatch` على الفرع).
- السحب في أندرويد مكتوب يدويًا (Compose بلا مكتبة سحب)؛ اختُبرت قواعده، والإيماءة نفسها لم تُجرَّب على جهاز حقيقي.
- عرض التشغيل يسأل المركز كل ثانيتين ما دام يعمل (كالويب).
- الرجوع: استرجاع دمج هذا الفرع من الفرع الليلي.

## التسليم والخطوة التالية
المجموعات الست مبنية في الجهازين؛ الدمج في `night/2026-09-27` وCI على #165.
