# الجوال، المرحلة الرابعة (آيفون): الجلسات والمجموعات وسير العمل والإعدادات

المسؤول: twuijri
الفرع: mobile-m4-ios (من `mobile`)
الحالة: review

## المشكلة والهدف
بعد M3 صارت الدردشة الفردية مطابقة للويب، لكن بقية التطبيق متأخرة: قائمة
الجلسات بلا بحث في نص الرسائل ولا أرشيف ولا اختيار جماعي ولا تصفيح، و«المحادثة
الجماعية» ما زالت على واجهة M1 التجريبية التي تستدعي نقاط REST محذوفة (لا تُترجَم
أصلًا)، وسير العمل شاشة قوائم بسيطة بمحرّر JSON خام بلا حالة حيّة ولا خط زمني
للعقد، والإعدادات ترتيبها لا يطابق تبويبات الويب وفيها «إدارة الحسابات» كعنصر
نائب وتبويب نماذج لا يحرّر المزوّدين ولا الأسماء البديلة ولا حدود السياق. الهدف:
إكمال M4 على عقد `/api/studio/*` ومساحات الأسماء `/group-chat` و`/workflow` كما
في `packages/client`. خارج النطاق: أندرويد، أي تغيير في السيرفر، وتحرير مخططات
سير العمل على الهاتف.

## القرار والموافقات
- الموافقة: المالك (تكليف M4 iOS في الطلب: الجلسات، المجموعات، سير العمل،
  الإعدادات، ومفتاح الامتثال التصديري).
- بنية: نفس نمط M3 — نقل (REST + سوكت) ومخفِّض نقي في `Core/`، والواجهة بلا
  منطق. الغرفة تعيد استخدام صف رسالة M3 عبر محوّل `GroupRunLines` بدل صفوف
  جديدة، وسير العمل يدمج الحالة الحيّة مع جلسات العقد في `WorkflowGraph.timeline`.
- قرارات تحتاج نظر المالك:
  1. **لا تُرسل `mentions` المهيكلة** من الهاتف. السيرفر
     (`sockets/group-chat.ts` → `normalizeStructuredMentions`) يستخرج الإشارات
     من نص الرسالة عندما يكون المرسل بشريًا ويرفض أي بيانات لا تطابق النص
     حرفيًا؛ إرسالها من عميل بسيط يعرّض كل رسالة لخطأ `Invalid structured
     mentions`. قائمة @ تُدرج نصًا فقط.
  2. **لا محرّر مخططات على الهاتف.** حُذف محرّر JSON القديم واستُبدل بملخص
     مخطط للقراءة فقط؛ الإنشاء يصنع مسارًا فارغًا والاستيراد يبقى المسار العملي.
  3. **«هذا الجهاز»** قسم جديد في الإعدادات يجمع ما هو محلي (عنوان الخادم، مصدر
     الإدخال الصوتي، جهد الاستدلال الافتراضي، إظهار نداءات الأدوات، الوضع
     الصوتي، محادثات كل البروفايلات)، بينما «العرض» صار سمة الخادم واللغة وحجم
     النص كما في الويب.
  4. **`X-Hermes-Profile` على كل نداء** عبر `APIClient.activeProfile` بدل تمريره
     يدويًا في كل دالة (كان ناقصًا في أغلب نقاط M4).
- لا دفع ولا PR ولا دمج من المساعد؛ الفرع محلي بانتظار مراجعة المالك.

## الملفات والتأثير
`clients/ios/**` فقط (لم يُمس `clients/android` ولا السيرفر):
- الالتزام `5c1aa024` (سابق، من جلسة أخرى): الجلسات + بنية M4 التحتية
  (`Core/{GroupChatModels, GroupChatAPI, GroupChatSocket, GroupChatStream,
  SessionsAPI, StudioModels, WorkflowAPI, WorkflowSocket}.swift`،
  `Features/{ChatsView, SessionListView, SessionActions, ConversationView}`).
- جديد في هذه الجلسة: `Core/{GroupChatDraft, WorkflowLive}.swift`،
  `Features/GroupChat/{GroupRoomsView, GroupRoomView, RoomSettingsView,
  RoomAgentEditorView, RoomComposer, RoomPanels, RoomRowView}.swift`
  (و`RoomQRView.swift` من لقطة WIP)، `Features/Workflow/{WorkflowsView,
  WorkflowDetailView, WorkflowRunView, WorkflowSchedulesView,
  WorkflowGraphView}.swift`، `Features/Settings/{ModelCatalogView,
  AccountManagementView}.swift`، `HermesStudioTests/M4ParityTests.swift`.
- محذوف: `Features/GroupsView.swift` (واجهة M1 التي تنادي REST محذوفًا)،
  وكتلة سير العمل القديمة داخل `Features/AgentHubView.swift` (محرّر JSON،
  صف التشغيل، محرّر الجدولة).
- معدّل: `Core/APIClient.swift` (`activeProfile`)، `Core/AppStore.swift` (ضبط
  البروفايل النشط وحجم النص)، `Core/SocketIO.swift` (إصلاح وسم `payload:` في
  `emitWithAck`)، `Core/GroupChatSocket.swift` + `Core/GroupChatStream.swift`
  (`RoomTypingUser` بمعرّف المستخدم)، `Core/GroupChatAPI.swift` (ترويسة
  البروفايل في الطلبات الخام)، `Theme/CoreHubTokens.swift` (`Typography.scale`)،
  `Features/{RootShell, SettingsView}.swift`، `Info.plist`
  (`ITSAppUsesNonExemptEncryption = false`، التزام منفصل)،
  `Resources/{en,ar}.lproj/Localizable.strings` (+224 / +214 مفتاحًا)،
  `clients/ios/README.md`.
- وثائق: `docs/mobile/PLAN.md` (§ «M4 iOS» مع قائمة تحقق Xcode)، هذا السجل.
- `HermesStudio.xcodeproj` لم يُعدَّل: المشروع يستخدم مجلدات Xcode 16 المتزامنة
  (`PBXFileSystemSynchronizedRootGroup`)، فكل ملف `.swift` تحت `HermesStudio/`
  و`HermesStudioTests/` ينضم إلى هدفه تلقائيًا ولا يحتاج مدخلات `PBXBuildFile`.

## الفحوص
- لا Xcode ولا Swift على جهاز التطوير (لينكس)؛ الكود **غير مُترجَم محليًا**.
  المراجعة اليدوية: توقيعات الدوال بين الملفات، فحص توازن الأقواس على كل ملفات
  Swift بسكربت، مطابقة مفاتيح السلاسل بين en/ar (لا مفاتيح مكررة جديدة؛ تكرار
  `"Disabled"` في الملف العربي سابق لهذا العمل)، وتجنّب السلاسل الشرطية غير
  المترجمة (`cond ? "A" : "B"`) في كل النصوص الجديدة.
- الاختبارات الجديدة (35) في `M4ParityTests.swift` تغطي المنطق النقي فقط؛
  تُشغَّل في CI على macOS بعد الدمج مع 41 + 21 + 25 السابقة.
- الأدلة على العقد قُرئت من السيرفر نفسه:
  `packages/server/src/modules/studio/sockets/group-chat.ts` (شكل إقرار `join`،
  `handleMessage`، `normalizeStructuredMentions`، حمولات
  `member_joined/left`، `agents_updated`، `execution_queue_updated`،
  `room_agent_activity`، `room_updated`، `room_cleared`، `getTypingUsers`)،
  و`packages/client/src/api/studio/group-chat.ts` و`workflows.ts`.
- لم يُشغَّل CI (لا دفع)؛ لم يُجرَّب على جهاز.

## المخاطر والرجوع
- تغيير سلوكي: كل نداء REST يحمل الآن `X-Hermes-Profile` افتراضيًا. النقاط التي
  كانت تتجاهل الترويسة لن تتأثر، لكن أي نقطة تتصرف بحسب البروفايل ستصير مرتبطة
  بالبروفايل المختار (وهو سلوك الويب).
- حُذفت واجهة المجموعات القديمة ومحرّر مخططات سير العمل؛ الرجوع: إعادة الفرع
  إلى رأس `mobile`.
- المحدوديات: لا تحرير للمخططات على الهاتف؛ «مخرجات العقدة» تُقرأ من آخر رسالة
  غير مستخدم في جلسة العقدة وقد تكون فارغة لعقد بلا جلسة؛ هوية العضو الحالي في
  الغرفة تُستنتج بمطابقة اسم المستخدم بأسماء الأعضاء ثم بمعرّف الحساب (لا تعيد
  نقطة الانضمام معرّف العضو الخاص بي صراحة)؛ إنشاء الغرفة يفترض أن الخادم يقبل
  `summary.provider/model` الفارغين عند اختيار «افتراضي البروفايل».
- لم تُجرَّب أي من الشاشات على جهاز؛ كل الأخطاء البصرية والترجمية محتملة حتى
  المرور على قائمة التحقق.

## التسليم والخطوة التالية
الحالة: الالتزامات على `mobile-m4-ios` محليًا، بلا دفع. الخطوة التالية للمالك:
البناء في Xcode وتشغيل الاختبارات، ثم قائمة التحقق في `docs/mobile/PLAN.md`
§ «M4 iOS» على جهاز حقيقي (غرفة جديدة، انضمام برمز، بث ردّ وكيل، موافقة، طابور،
QR، تشغيل مسار عمل ومتابعته، إدارة حساب، تبويب النماذج، RTL)، ثم الدفع وفتح PR
إلى `mobile`، ثم M4 أندرويد.
