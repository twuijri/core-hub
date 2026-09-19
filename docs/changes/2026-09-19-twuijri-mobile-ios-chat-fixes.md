# إصلاحات iOS بعد تجربة المالك: الدرج والكيبورد، ونص المحادثة، وجلسة قديمة

المسؤول: twuijri
الفرع: fix/ios-chat-bugs (من `origin/mobile`)
الحالة: review

## المشكلة والهدف
ثلاثة أعطال أبلغ عنها المالك بعد تجربة التطبيق:

1. **الكيبورد يغطي الدرج.** مع تركيز حقل الكتابة وفتح الدرج، يبقى الكيبورد
   ظاهرًا فوق نصف الدرج السفلي. ظهر على المنصتين.
2. **نص المحادثة لا يطابق الخادم.** على أندرويد ظهرت كل الرسائل بكلمة
   «null» ثم كفقاعات فارغة؛ المطلوب فحص الفئة نفسها على iOS.
3. **مُعرّف جلسة قديم يُغرِق المحادثة بأخطاء.** على أندرويد أنتجت محادثة
   جديدة كومة من صفوف «Session not found» الحمراء.

الهدف: إصلاح الثلاثة على `clients/ios` فقط، بمرجعية الخادم والويب. خارج
النطاق: `clients/android` وأي تغيير في الخادم.

## القرار والموافقات
- الموافقة: تكليف المالك بإصلاح هذه الأعطال الثلاثة على iOS.
- قرارات تحتاج نظر المالك:
  1. **صفوف `tool` تُسقَط من سجل المحادثة** بدل عرضها كفقاعة. الويب يرسمها
     بطاقات أدوات لا فقاعات، ومحتواها الخام هو ناتج الأداة؛ وسجل iOS يبني
     خطوات الأدوات من البث الحي لا من التاريخ. صفوف `moa` تصبح ملاحظة نظام
     كما في الويب.
  2. **الرسالة الفارغة تمامًا تُسقَط** (بلا نص ولا تفكير ولا مرفقات) بدل
     رسم فقاعة فارغة. الويب يُبقيها بمحتوى فارغ، وهذا ما يظهر كفقاعة خالية.
  3. **«محادثة جديدة» صارت مسوّدة محلية** (`local_draft`) فلا يُرسَل لها أي
     حدث خاص بالجلسة قبل أول `run`، لأن الخادم يردّ عليها «Session not
     found». مُعرّف الجلسة نفسه لا يتغيّر: أول `run` يُنشئ الجلسة.
  4. **قياس ارتفاع الكيبورد يدويًا** في الدرج مع
     `ignoresSafeArea(.keyboard)` بدل الاعتماد على تفادي SwiftUI التلقائي،
     لأن التفادي التلقائي لا يصل إلى فرع الدرج في `ZStack` الهيكل — وهذا
     سبب العطل الأصلي. لم أستطع التحقق بصريًا (لا Xcode على الجهاز).

## الملفات والتأثير
### العطل ١ — الكيبورد والدرج
- `clients/ios/HermesStudio/Core/Keyboard.swift` (جديد): `Keyboard.dismiss()`
  يُسقط المستجيب الأول، و`Keyboard.overlap(keyboardHeight:bottomSafeArea:)`
  دالة خالصة لحساب المساحة المحجوزة، و`KeyboardObserver` ينشرها.
- `Core/AppStore.swift`: `openDrawer(page:)` جديدة تُسقط الكيبورد ثم تفتح
  الدرج في العملية نفسها بلا تأخير؛ `startNewChat` صار يستدعي
  `SessionSummary.draft`.
- `Features/RootShell.swift`: زر الهامبرغر وإيماءة الحافة يمرّان عبر
  `openDrawer()` بدل ضبط `drawerOpen` مباشرة.
- `Features/ConversationView.swift` و`Features/GroupChat/GroupRoomView.swift`:
  `onChange(of: store.drawerOpen)` يُصفّر `@FocusState` حتى تبقى حالة
  SwiftUI متوافقة مع الكيبورد.
- `Features/SidebarDrawer.swift`: حشوة سفلية بقدر تغطية الكيبورد.

### العطل ٢ — مطابقة النص للخادم
المرجع: `getConversationMessagesPaginated` و`mapMessageRow` (المحتوى دائمًا
نص، و`display_content` قابل للإفراغ) و`packages/client/src/stores/hermes/chat.ts`
(`msg.display_content ?? msg.content`).
- `Core/Models.swift`: `JSON.value(_:)` تتجاهل `NSNull`؛ السبب الجذري أن
  `json["display_content"] ?? json["content"]` لا يتجاوز `NSNull` أبدًا،
  فكانت كل الرسائل تصل بنص فارغ وتُرسم فقاعات خالية (نظير عطل أندرويد
  الذي طبع «null»). أُضيف `Message.displayRole` و`transcriptKind` و
  `transcriptRows`.
- `Features/ConversationView.swift`: الصفحات الثلاث (الأولى، الاحتياطية،
  «رسائل أقدم») تمرّ كلها عبر `Message.transcriptRows`.
- فُحص `GroupMessage.parseContent` و`ChatSocket.completion(fromResume:)`
  و`outputText`: كلها تتعامل مع `NSNull` سليمًا أصلًا، فلم تُمسّ.

### العطل ٣ — جلسة لم تعد موجودة
السبب الجذري: `socket.on('app.resume')` في
`packages/server/src/modules/studio/sockets/chat-run.ts` يردّ
`run.failed: Session not found` لأي مُعرّف لا يعرفه، و iOS يرسل `app.resume`
عند كل اتصال وكل إعادة اتصال (تراجع أسّي)، والمُخفِّض كان يُلحق صفًّا أحمر
لكل `run.failed`. ينطبق على محادثة جديدة (مُعرّفها يُولَّد على الهاتف) وعلى
جلسة حُذفت من الخادم.
- `Core/SocketIO.swift`: `ChatSocket.sessionExists` + `markSessionExists()` /
  `markSessionGone()`، وكل حدث خاص بالجلسة يمرّ عبر `emitForSession` الذي
  يشترط مُعرّفًا غير فارغ وجلسة يعرفها الخادم؛ `run` وحده يُنشئ الجلسة فيرفع
  العلم.
- `Core/ChatStream.swift`: `sessionMissing` في الحالة،
  `ChatRunReducer.isSessionGone`، وعدم تكرار صفّ خطأ مطابق للأخير.
- `Features/ConversationView.swift`: `sessionKnown`، و`isMissingSession`
  للأخطاء REST (404)، ومسح المُعرّف المخزَّن `Preferences.setSession("")`،
  وحالة فارغة واحدة محايدة.
- `Features/Chat/ChatBanners.swift`: `MissingSessionNotice`.
- نصّان جديدان في `ar.lproj` و`en.lproj`.

## الفحوص
- لا يوجد Xcode ولا Swift على هذا الجهاز: **لم يُبنَ المشروع ولم تُشغَّل
  الاختبارات محليًا.** التحقق الفعلي يقع على `mobile-test-track.yml` على
  macOS بعد الدمج.
- المراجعة اليدوية: كل موضع يقرأ `display_content` أو يفتح السوكِت أو يفتح
  الدرج فُحص بالبحث النصّي؛ لا نداء متبقٍّ يضبط `drawerOpen = true` خارج
  `openDrawer`.
- اختبارات جديدة (ملف واحد، ١٧ حالة):
  `clients/ios/HermesStudioTests/ChatBugfixTests.swift` — العيّنات مبنيّة من
  نصّ JSON حقيقي حتى يصل `null` كـ`NSNull` كما يصل في التشغيل:
  `display_content` فارغ/معدوم، محتوى فارغ، صفّ `tool`، صفّ `moa`، صفّ
  مرفقات فقط، `display_role` يتقدّم على `role`، حساب تغطية الكيبورد، تمييز
  «الجلسة مفقودة»، عدم تكديس الصفوف، ومسوّدة «محادثة جديدة».

## المخاطر والرجوع
- **إسقاط صفوف `tool`** يعني أن سجل محادثة قديمة لن يعرض ناتج الأدوات بعد
  إعادة الفتح؛ كان يُرسَم فقاعة فارغة قبل الإصلاح، فلا خسارة فعلية، لكنه
  قرار سلوكي يحتاج نظر المالك.
- **حشوة الكيبورد في الدرج** لم تُختبر بصريًا. إن ظهر فراغ زائد أسفل الدرج
  فالرجوع هو حذف `padding(.bottom, keyboard.overlap)` و
  `ignoresSafeArea(.keyboard, edges: .bottom)` من `SidebarDrawer` وحدهما؛
  إسقاط التركيز (أساس الإصلاح) مستقل عنهما.
- **بوابة `emitForSession`** تمنع `abort` و«إلغاء/إدراج/توجيه» الطابور قبل
  أن يعرف الخادم الجلسة. أوّل `run` يرفع العلم، ولا يُخفَض العلم أثناء تشغيل
  جارٍ، فلا ينبغي أن يتعطّل إيقاف الردّ؛ يحتاج تأكيدًا على جهاز.
- الرجوع الكامل: `git revert` لهذه الدفعة؛ لا هجرات ولا تغييرات خادم.

## التسليم والخطوة التالية
الفرع محلي فقط، بلا دفع وبلا PR. الخطوة التالية للمالك: مراجعة الفرق، ثم
دفع الفرع وفتح PR إلى `mobile` ليبني CI على macOS ويشغّل الاختبارات، ثم
تجربة على جهاز للتحقق من: فتح الدرج مع كيبورد ظاهر، وسجل محادثة قديمة فيها
أدوات و`moa`، ومحادثة جديدة (يجب ألا يظهر أي صفّ أحمر)، وجلسة حُذفت من
الخادم (حالة فارغة واحدة ثم إرسال يُنشئ جلسة).
