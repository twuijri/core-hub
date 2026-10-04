# وقت الرسالة تحت الرسالة بضغطة خفيفة (الجوالات) وقاعدة اليوم نفسها في الويب
المسؤول: twuijri · الفرع: feat/message-time-on-tap · الحالة: review

## المشكلة والهدف
ملاحظة من مختبري الاختبار المغلق في Google Play (2026-10-05): على الجوال لا يعرفون متى وصلت الرسالة،
ويريدون وقتها تحتها، بضغطة خفيفة على الرسالة أو دائمًا. المالك قبل أيًّا منهما، واخترنا الضغطة
الخفيفة حتى تبقى المحادثة نصًّا لا جدولًا من الأوقات.

الهدف: ضغطة خفيفة على رسالة (رسالة الشخص أو رد الوكيل) تُظهر سطر وقت صغيرًا تحتها، وضغطة ثانية
عليها أو على رسالة أخرى تخفيه (وقت رسالة واحدة في المرة). الضغط المطوّل يبقى يفتح قائمة الرسالة
(42061d15، DECISIONS §150)، والسحب للرد يبقى كما هو (معكوسًا في العربية).

نص الوقت، والقاعدة واحدة في الويب وiOS وأندرويد:
- اليوم: الساعة فقط.
- أمس: «أمس» + الساعة («Yesterday» بالإنجليزية).
- قبل ذلك: تاريخ قصير (اليوم واسم الشهر المختصر) + الساعة، والسنة فقط إن لم تكن السنة الحالية.
- اليوم يُحسب بمنطقة القارئ الزمنية، والكلمات بلغة القراءة، والأرقام لاتينية دائمًا (قرار المالك،
  DECISIONS §113).

## القرار والموافقات
- المالك قبل الضغطة الخفيفة أو الإظهار الدائم؛ نُفّذت الضغطة الخفيفة كما طلب الوكيل المنسِّق.
- الويب: لا إعادة تصميم. الوقت يظهر كما كان في صف الإجراءات عند الاقتراب من الرسالة، والتغيير
  فقط في `messageTime` لتتبع قاعدة اليوم نفسها.
- لا تغيير في العقد: `created_at` موجود في `Message` من قبل، وiOS يفكّه (`createdAt: Date`).
  أندرويد كان يفكّه في النموذج المولَّد لكن `ChatMessage` (نموذج الشاشة) لم يحمله، فأُضيف إليه حقل
  اختياري `createdAt` بقيمة افتراضية `null` (إضافة فقط).
- لم يُضف بند في `docs/contracts/DECISIONS.md` لتفادي تعارض الترقيم مع فروع أخرى مفتوحة؛ القاعدة
  موثّقة هنا وفي تعليقات الكود.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
الوثائق:
- `docs/store/google/closed-test-feedback.md`: صف ملاحظة الوقت (من مختبر في الاختبار المغلق) صار يشير إلى #236.
الويب:
- `packages/web/src/chat/MessageActions.tsx`: `messageTime(message, language, t, now)` يطبّق القاعدة
  (الساعة / أمس + الساعة / التاريخ القصير + الساعة) عبر `intlLocale` (أرقام لاتينية).
- `packages/web/src/i18n/{en,ar}.json`: `chat.time_yesterday`.
- `packages/web/tests/message-time.test.ts` (جديد).

iOS:
- `apps/ios/CoreHub/Chat/MessageTime.swift` (جديد): القاعدة بـ`DateFormatter` وقوالب `jmm` /
  `dMMMjmm` / `dMMMyjmm` على `AppLanguage.locale` (أرقام لاتينية).
- `apps/ios/CoreHub/Chat/ChatScreen.swift`: `MessageRow` يأخذ `timeShown` و`onTap` (افتراضيًا لا شيء)،
  ضغطة خفيفة على فقاعة الشخص أو على نص رد الوكيل (`simultaneousGesture` حتى تبقى الروابط والتحديد
  والقائمة والسحب تعمل)، وسطر الوقت تحت الرسالة في جهتها. الشاشة تحفظ رسالة واحدة ظاهرٌ وقتها.
- `apps/ios/CoreHub/Rooms/RoomScreen.swift`: الشيء نفسه في الغرف.
- `apps/ios/CoreHub/i18n/{en,ar}.json`: `chat.time_yesterday`.
- `apps/ios/CoreHubTests/MessageTimeTests.swift` (جديد).

أندرويد:
- `apps/android/app/src/main/java/hub/core/android/chat/MessageTime.kt` (جديد): القاعدة بـ
  `android.icu.text.DateFormat.getInstanceForSkeleton` على `Digits.latin(locale)`.
- `.../chat/ChatReducer.kt`: `ChatMessage.createdAt` اختياري يُملأ من `Message.createdAt`.
- `.../ui/screens/ChatViewModel.kt`: صدى الرسالة المرسلة يحمل وقت الآن حتى يصل نصها من المركز.
- `.../ui/components/ChatParts.kt`: `TurnView` يأخذ `timeShown` و`onTapMessage` (افتراضيًا لا شيء)؛
  فقاعة الشخص: `onClick` في `combinedClickable` الموجود (كان فارغًا) أو `clickable` في الغرف؛ بطاقة
  الوكيل: `onTap` في `detectTapGestures` نفسه الذي يحمل الضغط المطوّل، وأزرارها وملفاتها وخطواتها
  تأخذ ضغطاتها أولًا. سطر الوقت `MessageTimeLine` بحجم xs ولون `textFaint` من ui-tokens.
- `.../ui/screens/ChatScreen.kt` و`RoomScreen.kt`: حالة الرسالة الظاهر وقتها.
- `apps/android/i18n/{en,ar}.json`: `chat_time_yesterday`.
- `apps/android/app/src/test/java/hub/core/android/chat/MessageTimeTest.kt` (جديد).

ما لم يتغيّر: محادثات القنوات في iOS (`ChannelMessageRow`) خارج النطاق.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm --filter web exec vitest run tests/message-time.test.ts tests/i18n.test.ts tests/latin-digits.test.ts tests/message-layout.test.tsx --maxWorkers=2
 Test Files  4 passed (4)
      Tests  22 passed (22)

$ ./gradlew --no-daemon -q :app:testDebugUnitTest --tests 'hub.core.android.chat.MessageTimeTest' --tests 'hub.core.android.chat.ChatReducerTest' --tests 'hub.core.android.ui.StringsParityTest' --tests 'hub.core.android.phone.DigitsTest' -Dorg.gradle.workers.max=2
exit=0
<testsuite name="hub.core.android.chat.ChatReducerTest" tests="8" skipped="0" failures="0" errors="0"
<testsuite name="hub.core.android.chat.MessageTimeTest" tests="6" skipped="0" failures="0" errors="0"
<testsuite name="hub.core.android.phone.DigitsTest" tests="7" skipped="0" failures="0" errors="0"
<testsuite name="hub.core.android.ui.StringsParityTest" tests="4" skipped="0" failures="0" errors="0"

$ ./gradlew --no-daemon -q --max-workers=2 :app:lintDebug
Wrote HTML report to file:///…/apps/android/app/build/reports/lint-results-debug.html
exit=0

$ pnpm typecheck
exit=0

$ pnpm contracts:check-clients
check-clients  OK — 1166 client file(s) scanned, 274 contract path(s) known.

$ pnpm i18n:check
i18n:check  web: 3680 keys, ar/en in parity
i18n:check  desktop: 107 keys, ar/en in parity
i18n:check  ios: 2761 keys, ar/en in parity
i18n:check  android: 2621 keys, ar/en in parity
i18n:check  OK

$ pnpm exec prettier --check <الملفات المعدّلة في الويب وملفات الترجمة> && pnpm exec eslint <ملفات الويب>
All matched files use Prettier code style!
(eslint بلا مخرجات، exit=0)

$ node scripts/check-change-record.mjs --base origin/main
change-record  OK — 1 record(s) valid
```
لم تُشغَّل محليًا: بناء iOS واختبار `MessageTimeTests` (لا Xcode على لينكس؛ CI يشغّلهما)، واختبارات
الويب والأندرويد الكاملة (CI يشغّلها). لم تُجرَّب الإيماءة على جهاز حقيقي.

## المخاطر والرجوع
- الضغطة الخفيفة على iOS تُضاف بجانب إيماءات العرض (`simultaneousGesture`)، فالضغط على رابط في رد
  الوكيل يفتح الرابط ويُظهر الوقت معًا؛ مقبول وغير ضار. أزرار البطاقة (نسخ، «…») لا تُظهره لأن
  الإيماءة على نص الرد فقط؛ رد بلا نص (ملفات أو خطوات فقط) لا يُظهر وقتًا على iOS.
- على أندرويد كانت فقاعة الشخص تُظهر تموّج الضغط عند الضغطة الخفيفة من قبل (`onClick = {}`)، والآن
  الضغطة نفسها تُظهر الوقت.
- مركز أقدم أو أحدث: `created_at` في العقد منذ البداية، فلا اعتماد على نسخة. رسالة بلا وقت معروف
  (قشرة رد لم يصل `message.created` الخاص بها على أندرويد) لا تُظهر سطرًا.
- الرجوع: revert للالتزام؛ لا ترحيل ولا بيانات.

## التسليم والخطوة التالية
PR إلى main بالإنجليزية؛ المالك يراجع ويدمج. بعد الدمج يُضاف الفرع إلى `test` حسب القواعد، وتجربة
على جهاز iOS وأندرويد: ضغطة خفيفة تُظهر الوقت وتخفيه، والضغط المطوّل يفتح القائمة، والسحب للرد يعمل
بالعربية والإنجليزية.
