# محادثات القنوات في الاتجاهين على الجوال: المشرف يكتب في محادثة تيليجرام أو واتساب من تطبيقي iOS وأندرويد (المرحلة 2)
المسؤول: twuijri · الفرع: feat/two-way-channels-phones · الحالة: review

## المشكلة والهدف
المرحلة 1 (طلب الدمج #239، الفرع `feat/two-way-channels`) أضافت إلى المركز والويب الكتابة في محادثة
تيليجرام أو واتساب من كور هب (DECISIONS §153). التطبيقان ما زالا يعرضان هذه المحادثات للقراءة فقط
ويسألان المركز كل 30–45 ثانية، فلا يستطيع المالك أن يرد من جواله، ولا يرى رسالة المركز باسم كاتبها.

الهدف: أن يتصرف iOS وأندرويد كما يتصرف الويب تمامًا، على العقد نفسه وبلا أي تغيير فيه:
- المشرف حين `can_send` يرى خانة كتابة بشكل خانة المحادثة العادية بدل شريط «للقراءة فقط».
- الرسالة تظهر فورًا وتحتها حالتها (تُرسل ← نُشرت ← وصلت الوكيل ← الوكيل يرد ← تم الرد، أو فشلت
  مع السبب)، ثم تصير في المحادثة رسالة «<الاسم> · من كور هب» في جهة صاحب الحساب.
- الرفض بكلمات واضحة والنص يعود إلى الخانة؛ رفض المنصة نفسها بكلماتها.
- إن لم تكن الكتابة ممكنة: السبب مكان الخانة، ولـ`not_current` زر «افتح المحادثة الحالية» يفتح
  `current_id` داخل التطبيق.
- الحدث اللحظي `channel_conversation.updated` يعيد قراءة المحادثة والقائمة ويحدّث حالة الرسالة في
  مكانها، والاستطلاع يصير احتياطًا بطيئًا (5 دقائق للقائمة، دقيقتان للمحادثة) حين `live_updates`.
- مركز أقدم لا يرسل الحقول الجديدة: يبقى العرض للقراءة والاستطلاع كما كان.
- تبقى العلامة (تيليجرام/واتساب)، ومجموعة القناة في القائمة، و«أكمل في كور هب».

## القرار والموافقات
- القرارات كلها في المرحلة 1 (قرارات المالك 2026-10-08، DECISIONS §153)؛ هذه المرحلة تنفيذها على
  الجوالين، والويب (`ChannelConversationView.tsx`، `ChannelComposer.tsx`، `channels.ts`) هو المرجع
  في السلوك والنصوص والفواصل الزمنية.
- قواعد التصميم من المالك: أندرويد بمكونات Compose الخاصة على ui-tokens (خانة المحادثة نفسها
  `Composer`، لا Material)، أيقونات lucide (`MessagesSquare`، `CornerDownRight`، `ArrowUp`)، كل نص
  بالعربية والإنجليزية، اتجاه المحتوى من أول حرف قوي، أرقام لاتينية، والتطبيق مكتفٍ بنفسه (الزر
  يفتح المحادثة الحالية داخل التطبيق، لا الويب).
- قرارات تنفيذ صغيرة (بلا أثر على العقد):
  - المنطق كله في ملف قواعد مستقل على كل منصة (`ChannelSend.kt` / `ChannelSend.swift`) لتختبره
    الوحدات: أي شيء مكان الخانة، دمج `outgoing`، التقسيم بين رسالة في المحادثة ورسالة لم تصلها بعد،
    قراءة الحدث، متى يُعاد القراءة، وترجمة الرفض.
  - خطوة وسطى في `outgoing` (`posted`/`delivered`/`answering`) تحدّث سطر الحالة فقط؛ بداية دور أو
    نهايته أو `answered`/`failed` تعيد قراءة المحادثة والقائمة (كما يفعل الويب).
  - رفض بسبب من أسباب `can_send` (مثل `not_current` أو `bridge_offline`) يعيد قراءة المحادثة فورًا
    فيتبدل مكان الخانة إلى السبب الجديد.
  - أندرويد: `HubError` صار يقرأ `details.reason` و`details.message` من ردود 5xx أيضًا (كان يقرؤها من
    4xx فقط)، لأن `503 channel_send_failed` و`bridge_offline` و`hermes_not_managed` تأتي هكذا. إضافة
    لا تغيّر شيئًا كان يعمل.
  - خانة الكتابة على الجوال هي خانة المحادثة نفسها بلا مرفقات ولا نماذج؛ اسم زر الإرسال للقارئ
    «أرسل على تيليجرام» (معامل اختياري جديد `sendLabel` في `Composer` على المنصتين، والقيمة الافتراضية
    كما كانت). تحت الخانة سطر صغير يشرح أين تذهب الكلمات وزر «أكمل في كور هب» صغيرًا بجانبه.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. التطبيقان يقرآن ما أضافته المرحلة 1 فقط:
- `ChannelConversation.can_send` / `send_unavailable` / `current_id` (غيابها = للقراءة كما كان).
- `ChannelMessage.origin` / `author_name` (رسالة `hub` تُرسم في جهة صاحب الحساب باسم كاتبها).
- `sessions.sendChannelMessage` (`POST /channel-conversations/{id}/messages`) بالنص و`client_message_id`،
  وأخطاؤه: `403 not_admin`، `409 state_invalid` (`platform_unsupported` | `not_current` | `no_route`)،
  `503` (`hermes_not_managed` | `bridge_offline` | `channel_send_failed` مع `details.message`).
- `ChannelOutgoing` بحالاته وسبب فشله، و`outgoing[]` و`live_updates` في `listChannelMessages`،
  و`live_updates` في `listChannelConversations`.
- الحدث `channel_conversation.updated` على `/rt/sessions` (على مستوى البروفايل، بلا اشتراك).

`pnpm contracts:compat` ناجح (لا كسر)، و`pnpm contracts:check-clients` ناجح (لا مسار مكتوب باليد).

## الملفات والتأثير
أندرويد:
- `apps/android/app/src/main/java/hub/core/android/ui/screens/ChannelSend.kt` (جديد): `ChannelSendRules`
  (مكان الخانة `ChannelBottom`، الكلمات وحدها الأقصى 4000، `client_message_id`، `upsert`، `split`،
  `showSending`، `fromHub`، `parse` للحدث، `settled`، `apply`، `failure` ← `ChannelSendRefusal`، فواصل
  الاستطلاع).
- `.../ui/screens/ChannelSendUi.kt` (جديد): `ChannelSendBottom` (الخانة أو السبب، «افتح المحادثة
  الحالية»، «أكمل في كور هب»)، `HubMessageView` وسطر حالته، ونصوص الرفض.
- `.../ui/screens/ChannelChatScreen.kt`: الإرسال والعرض الفوري، `outgoing` و`live_updates` من القراءة،
  الاستماع للحدث، إعادة القراءة فورًا عند الحاجة والاستطلاع بفاصل يتبع `live_updates`، رسم رسالة المركز،
  ومعامل `onOpenConversation`.
- `.../ui/screens/ChatGroups.kt`: `ChatGroupsOps.send`، `liveUpdates` في حالة القائمة، استطلاع القائمة
  بفاصل يتبعه، و`ChatExtras.heard` يعيد قراءة القائمة مرة لكل دفعة أحداث.
- `.../ui/screens/ShellViewModel.kt`: الحدث `channel_conversation.updated` يصل إلى قائمة القنوات.
- `.../MainActivity.kt`: «افتح المحادثة الحالية» يفتح `Route.ChannelChat` في التطبيق.
- `.../ui/components/ChatParts.kt`: معامل اختياري `sendLabel` في `Composer`.
- `.../data/Hub.kt`: `HubError` يقرأ `reason` و`message` و`peer_code` من ردود 5xx.
- `apps/android/i18n/channel_send.{en,ar}.json` (جديدان).
- الاختبارات: `app/src/test/.../parity/ChannelSendTest.kt` (جديد)،
  `app/src/testDebug/.../shots/ChannelSendShots.kt` (جديد، صور في `apps/android/app/build/shots/channel-send/`).

iOS:
- `apps/ios/CoreHub/Chat/ChannelSend.swift` (جديد): `ChannelSendRules` بالقواعد نفسها، و`ChannelUpdate`
  (قراءة الحدث)، و`statusLine` و`refusalText` و`unavailableText`.
- `apps/ios/CoreHub/Chat/ChannelConversationScreen.swift`: في النموذج `outgoing` و`liveUpdates` و`draft`
  و`sending` و`refusal`، `send()`، الاستماع للحدث و`readAgain()`، والاستطلاع بفاصل يتبع `live_updates`؛
  في الشاشة الخانة أو السبب، «افتح المحادثة الحالية»، و`HubMessageRow` لرسالة المركز وحالتها.
- `apps/ios/CoreHub/Sessions/SessionList.swift`: الحدث يعيد قراءة محادثات القنوات (مرة لكل دفعة)،
  و`channelsLive` يبطئ الاستطلاع.
- `apps/ios/CoreHub/Shell/ShellView.swift`: «افتح المحادثة الحالية» ينتقل إلى `.channel(...)`.
- `apps/ios/CoreHub/Chat/ChatParts.swift`: معامل اختياري `sendLabel` في `Composer`.
- `apps/ios/CoreHub/i18n/channel_send.{en,ar}.json` (جديدان).
- الاختبارات: `apps/ios/CoreHubTests/ChannelSendTests.swift` (جديد).

الوثائق: `docs/STATUS.md` (جملة في سطر `sessions`: الويب والجوالان يكتبان من شاشة المحادثة).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm contracts:generate   (JDK 17 في ~/.local/opt/jdk17)
contracts:generate:native  kotlin: explicit nulls in 95 request model(s)
contracts:generate:native  swift: explicit nulls in 86 request model(s)
contracts:generate:native  OK

$ cd apps/android && ./gradlew --max-workers=2 :app:testDebugUnitTest \
    --tests hub.core.android.parity.ChannelSendTest --tests hub.core.android.parity.SelfSufficientTest \
    --tests hub.core.android.ui.StringsParityTest --tests hub.core.android.data.RealtimeTest \
    --tests hub.core.android.data.AuthTest --tests hub.core.android.shots.ChannelSendShots \
    --tests hub.core.android.ui.UiKitPolicyTest --tests hub.core.android.shots.TextAuditTest :app:lintDebug
BUILD SUCCESSFUL in 1m 12s
  hub.core.android.parity.ChannelSendTest      tests="11" failures="0" errors="0"
  hub.core.android.parity.SelfSufficientTest   tests="24" failures="0" errors="0"
  hub.core.android.shots.ChannelSendShots      tests="5"  failures="0" errors="0"
  hub.core.android.ui.StringsParityTest        tests="4"  failures="0" errors="0"
  hub.core.android.data.RealtimeTest           tests="3"  failures="0" errors="0"
  hub.core.android.data.AuthTest               tests="8"  failures="0" errors="0"
  hub.core.android.ui.UiKitPolicyTest          tests="1"  failures="0" errors="0"
  hub.core.android.shots.TextAuditTest         tests="1"  failures="0" errors="0"
  lintDebug: 0 errors, 104 warnings (لا شيء منها في الملفات المعدّلة)
  الصور: android-composer-light-en.png, android-composer-dark-en.png, android-composer-light-ar.png,
         android-not-current-light-en.png, android-not-admin-dark-ar.png

$ pnpm typecheck
EXIT 0

$ pnpm contracts:check-clients
check-clients  OK — 1174 client file(s) scanned, 277 contract path(s) known.

$ pnpm contracts:compat
contracts:compat  OK — no breaking change against v1.1.7

$ pnpm i18n:check
i18n:check  ios: 2781 keys, ar/en in parity
i18n:check  android: 2641 keys, ar/en in parity
i18n:check  OK

$ pnpm i18n:limits
i18n:limits  ar: 56 measured labels, 0 too wide, 4 cut with an ellipsis as in English
i18n:limits  en: 56 measured labels, 0 too wide, 6 cut with an ellipsis as in English
i18n:limits  OK

$ pnpm nav:check
nav:check  OK — 41 destinations, 2 pre-auth screens (login, setup), 47 terms, ar/en complete, routes for web, ios, android, desktop

$ node scripts/check-change-record.mjs --base origin/main
change-record  OK — 2 record(s) valid
```
لم تُشغَّل محليًا: بناء iOS واختباراته (لا Xcode على لينكس؛ CI يبني ويشغّل `ChannelSendTests` وبقية
`CoreHubTests`)، وأجنحة أندرويد كاملة (`./gradlew test lint` في CI)، والتجربة على جهاز حقيقي مع مركز
حقيقي وتيليجرام/واتساب حقيقيين.

## المخاطر والرجوع
- iOS لم يُبنَ محليًا: أي خطأ ترجمة يظهر في CI لـiOS قبل المراجعة.
- سباق صغير: قراءة بدأت قبل الإرسال وانتهت بعده قد تخفي الرسالة لحظة حتى الحدث التالي أو القراءة
  التالية (كما في الويب).
- `HubError` يقرأ الآن تفاصيل 5xx: شاشات أخرى كانت تتجاهل `reason` في 5xx قد تعرض الآن سببها الصحيح
  (مثل `hermes_refused` في أدوات المشرف) — تحسين لا كسر.
- الرجوع: revert للالتزام. لا ترحيل ولا بيانات؛ التطبيق القديم يبقى يعمل مع المركز الجديد (يتجاهل
  الحقول ويستطلع كما كان)، والجديد مع مركز قديم يبقى للقراءة.

## التسليم والخطوة التالية
- طلب دمج بالإنجليزية من `feat/two-way-channels-phones` إلى `feat/two-way-channels` (يتحول إلى `main`
  حين يُدمج #239)، ويعتمد على #239. المالك يراجع ويدمج؛ لا دمج تلقائي، ولا `test`، ولا بناء صور.
- بعد الدمج: تجربة المالك على جواله (أندرويد وiOS) مع تيليجرام حقيقي، ثم واتساب.
