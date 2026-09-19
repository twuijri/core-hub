# أندرويد: ثلاثة عيوب بلّغ عنها المالك في الدردشة

المسؤول: twuijri
الفرع: fix/android-chat-bugs (من `origin/mobile`)
الحالة: review — التزامات محلية فقط، بلا دفع وبلا PR

## المشكلة والهدف
ثلاثة بلاغات من تجربة المالك على تطبيق Core Hub Mobile (أندرويد):

1. **لوحة المفاتيح تغطي الدرج الجانبي.** مع تركيز المحرّر ولوحة المفاتيح
   ظاهرة، فتح الدرج يترك اللوحة على الشاشة فتغطي نصفه السفلي (صف الملف
   الشخصي، «تسجيل الخروج»، الإعدادات).
2. **محادثة جديدة تعرض شريط خطأ وخمسة صفوف حمراء «Session not found».**
3. **محادثة قديمة تُعرض بلا أي نص** — فقاعات فيها الوقت والصورة الرمزية
   واسم الوكيل بلا كلمة واحدة، بعد إصلاح `6d6afe60` الذي عالج ظهور كلمة
   «null».

النطاق: `clients/android` و`docs/` فقط. لا مساس بـ `clients/ios` ولا
بالسيرفر ولا بالرخصة أو حارسها.

## الأسباب الجذرية

### 1) لوحة المفاتيح فوق الدرج
`CoreHubDrawerHost` كان يحرّك الدرج فقط ولا يتعامل مع IME إطلاقًا، والمحرّر
يحتفظ بالتركيز، فتبقى اللوحة ظاهرة. كذلك كان جسم الدرج يطبّق
`navigationBarsPadding()` وحدها، فلا يحسب حساب IME أصلًا.

### 2) «Session not found»
`requireSocketSessionAccess` في
`packages/server/src/modules/studio/sockets/chat-run.ts` يرفض `run` و`resume`
و`app.resume` لأي معرّف لا يعرفه بحدث `run.failed: Session not found`،
ووحدات التحكّم في `controllers/chat-run.ts` تعيد 404 بالنص نفسه. في التطبيق:
- `ChatSocket` يرسل `app.resume` عند كل إعادة اتصال، و`AppViewModel` كان
  يضيف صفًّا أحمر لكل `RunEvent.Failed` — صف مكرّر لكل محاولة، وهو تفسير
  «شريط واحد وخمسة صفوف».
- `send()` كان يقرأ `store.sessionFor(profile)` **قبل** الجلسة المفتوحة، فمعرّف
  قديم محفوظ (و`Store.setSessionFor` يبقى بعد إعادة التشغيل) يسبق المحادثة
  التي ينظر إليها المستخدم.
- `selectModel()` كان يكتب `POST /api/studio/sessions/{id}/model` بمعرّف من
  المتجر حتى لمحادثة لم تُرسل رسالتها الأولى بعد — وهذه الجلسة لا وجود لها
  على الخادم، فالجواب 404 وشريط خطأ فوق محادثة جديدة تمامًا.

### 3) محادثة بلا نص
عيبان متراكبان:
- `HermesApi.parseConversationPage` كان يسطّح المحتوى بـ
  `GroupJson.blocksToText` (مساعد مخصّص لغرف المجموعات) بينما الويب لا يفعل
  ذلك إطلاقًا؛ `packages/client/src/stores/hermes/chat.ts` يكتفي بـ
  `msg.display_content ?? msg.content`. النتيجة: (أ) كتل الرفع تتحوّل إلى نص
  «📎 اسم» بدل بطاقة تنزيل، (ب) أي مصفوفة كتل لا يعرفها المسطِّح تعود ""،
  (ج) **أي رسالة نصّها يبدأ بـ «[» فقط** — رابط ماركداون في أوّلها أو مرجع
  مثل `[1]` — لأن `JSONArray("[التقرير](/path) …")` يُحلَّل بتساهل فيعيد ""،
  ثم يسقط الصفّ كلّه عند حارس `content.isBlank()`. صفوف تختفي من النص.
- `parseStudioContentBlocks` في `ChatFiles.kt` كان يعيد
  `ParsedChatMessage("", emptyList())` متى تعرّف على مصفوفة كتل ولم يستطع
  استخراج نص ولا ملف محلّي؛ عندها يرسم `MessageRow` الصورة الرمزية والاسم
  وصفّ الإجراءات بالوقت حول لا شيء — الفقاعة الفارغة نفسها.
- وعلى المسار الحيّ: `RunEvent.Done` بمخرَج فارغ (وكذلك ردّ REST فارغ في
  `sendOverRest`) كان يضيف `ChatLine("")`، أي صفّ مساعد فارغ تمامًا.
- `GroupJson.message` يحمل العيب نفسه، و`GroupRoomState` لا يُسقِط الصفّ
  الفارغ أصلًا، فالغرف تنتج الأعراض ذاتها.

**عيب إضافي وُجد أثناء التحقيق:** `offset` على الخادم يُعدّ من الأحدث
(`ORDER BY id DESC LIMIT ? OFFSET ?` في `session-store.ts` و`sessions-db.ts`،
وهو ما يمرّره الويب في `loadOlderMessages`). `loadLatestPage` كان يطلب
`total - HISTORY_PAGE`، أي **أقدم** صفحة، فالمحادثة الطويلة تُفتح على أوّل
رسائلها، و`historyHasMore = page.offset > 0` مقلوب.

## ما تغيّر
- `ui/navigation/CoreHubDrawer.kt`: إخفاء لوحة المفاتيح وإفلات التركيز داخل
  انتقال الفتح نفسه عبر `LocalSoftwareKeyboardController`/`LocalFocusManager`
  (بلا مؤقّت)، وهامش سفلي = `max(navigationBars, ime)`.
- `ChatSocket.kt`: `RunEvent.SessionGone`، و`isSessionGoneError`/
  `runFailureEvent` قابلان للاختبار، و`emitForSession` يُسقِط أي إرسال
  بمعرّف فارغ، ولا `app.resume` بمعرّف فارغ، وجلسة مفقودة تُنهي التدفّق بدل
  أن تتكرّر مع كل إعادة اتصال.
- `AppViewModel.kt`: `chatSessionIdFor` (الجلسة المفتوحة أوّلًا)،
  `withErrorLine` (لا تكرار لصفّ خطأ نفسه)، `Throwable.isMissingSession()`،
  و`forgetMissingSession()` يمسح المعرّف المخزَّن ويعيد الشاشة إلى حالة فارغة
  محايدة برسالة واحدة؛ مطبَّق على السوكت وعلى `loadLatestPage` و`selectModel`
  و`setReasoningEffort` و`togglePushEnabled` و`sendOverRest`. `selectModel`
  لم يعد يكتب لجلسة غير موجودة على الخادم. لا صفّ لردّ فارغ. تصحيح اتجاه
  الترقيم.
- `HermesApi.kt`: `parseConversationPage` يطابق الويب (`display_content ??
  content` بلا تسطيح)، ويُسقِط الصفّ فقط عبر `hasRenderableChatContent`،
  و`MessagePage.fetched` و`hasMore` مشتقّ عند غيابه.
- `ChatFiles.kt`: `parseStudioContentBlocks` لا يعيد نتيجة فارغة أبدًا
  (مرفق غير محلّي يُذكَر باسمه، وإلا يعود النص الأصلي)، و
  `hasRenderableChatContent`.
- `ui/chat/MessageRow.kt`: صفّ دردشة بلا نص ولا مرفق ولا أدوات ولا تفكير ولا
  بثّ لا يُرسم إطلاقًا.
- `GroupModels.kt`: `GroupJson.message` يطابق التغيير نفسه، وحُذف
  `blocksToText` (لم يعد له مستخدم).
- `res/values*/strings.xml`: `conversation_session_gone` بالعربية والإنجليزية.
- `tools/mock-studio.py`: مسار `/messages/paginated` بدلالة الخادم نفسها
  (offset من الأحدث، `hasMore`)، وجلسة `s4` تعيد إنتاج عيب «بلا نص»، وجلسة
  `s5` وأي معرّف مجهول يعيدان 404 «Session not found».

## الفحوص
```
JAVA_HOME=~/.local/opt/jdk17 ANDROID_HOME=~/Android/Sdk \
  gradle --offline testDebugUnitTest assembleDebug   → BUILD SUCCESSFUL
201 اختبار وحدة، 0 إخفاق، 0 خطأ (كانت 171)
```
اختبارات جديدة: `DrawerKeyboardTest` (٣)، `SessionRecoveryTest` (١١)،
وتوسعة `ConversationPageTest` (٩) و`ChatFilesTest` (٥).

تحقّق من طرف إلى طرف مقابل `tools/mock-studio.py` الحيّ عبر `HermesApi`
الحقيقي: الصفوف الخمسة للجلسة `s4` كلها تُرسم بنص أو ببطاقة تنزيل
(`o1` يحتفظ بنصّه وببطاقته، `o2` تبقى بطاقة لا نص «📎»، `o3` يُسمّى مرفقه،
`o4` لم يعد يسقط)، والجلسة `s5` وكتابة نموذج بمعرّف جديد يعودان
`HTTP 404: Session not found` مع `isMissingSession() = true`.

## لم يُتحقق (يحتاج سيرفر المالك)
- لم أرَ قاعدة بيانات المالك، فلا أستطيع الجزم بالحمولة الدقيقة التي أنتجت
  الفقاعات الفارغة عنده. أثبتّ بالتجربة أن المحلّل **قبل** الإصلاح يُسقِط أي
  رسالة يبدأ نصّها بـ «[»، وأن الفقاعة الفارغة تأتي من
  `parseStudioContentBlocks` ومن ردّ حيّ فارغ ومن مسار الغرف؛ الثلاثة
  مُصلَحة. يبقى على المالك فتح المحادثة نفسها للتأكيد.
- لم تُجرَّب لوحة مفاتيح حقيقية ولا الدرج على جهاز؛ اختبار الدرج بنيوي على
  المصدر مثل `NavigationStructureTest` لأن Compose لا يُختبر على JVM هنا.
- لم يُجرَّب سوكت `/chat-run` حيًّا (المحاكي REST فقط)، فمسار
  `SessionGone` مثبَّت بالاختبار على `runFailureEvent` لا على اتصال حقيقي.
- `moa` ما زال يُستبعد من النص بدل أن يظهر ملاحظةً نظامية كما في الويب؛
  خارج نطاق هذه البلاغات.
- لم يُشغَّل CI، ولا دفع ولا PR.

## الخطوة التالية
مراجعة المالك للفرق، ثم تشغيل التطبيق على سيرفره لفتح المحادثة القديمة
نفسها ومحادثة جديدة والدرج مع لوحة المفاتيح، ثم الدفع وفتح PR إلى `mobile`
حسب `docs/TEAM-RULES.md` §3.
