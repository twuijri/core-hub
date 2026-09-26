# الجوال: الغرف (فتح، بثّ، الأعضاء، غرفة جديدة، الانضمام برمز) وقائمة «بانتظارك» ووضع التحديد والتصدير في المحادثات
المسؤول: twuijri · الفرع: feat/phone-rooms-sessions · الحالة: review

## المشكلة والهدف
- **الغرف على الجوال** (B5 وB6 في قائمة الفجوات): التطبيقان كانا يعرضان أسماء الغرف فقط، و«غرفة جديدة»
  في أندرويد لا تفعل شيئًا. الغرف مكتملة في المركز والويب. المطلوب على الجهازين: فتح الغرفة، وبثّ
  ردود المقاعد (الوكلاء) أثناء كتابتها، ومحرّر المحادثة نفسه (المايك بالإملاء المتواصل، والمرفقات مع
  اختيار الجودة، و`@` لتسمية الوكلاء)، وورقة الأعضاء، و«غرفة جديدة» و«انضمام برمز»، وأن تظهر أسئلة
  الغرفة وطلبات موافقتها في قائمة الجوال لما ينتظر الشخص.
- **المحادثات**: وضع تحديد في قائمة المحادثات (أرشفة، إلغاء أرشفة، حذف)، وتصدير المحادثة إلى
  نافذة المشاركة باستعمال تصدير المركز.
- **هوية الوكيل** (أُضيفت أثناء العمل، من تجربة المالك على جواله): رأس الرد في المحادثات يقول «agent» بلا
  أيقونة. السبب: المركز يكتب اسم مؤلف رسالة الوكيل `agent` دائمًا ومعه معرّفه فقط، والتطبيقان يعرضان
  الاسم كما هو. المطلوب اسم الوكيل الحقيقي ووجهه (صورته من `agents.getAvatar` §76، أو شعار الكتالوج
  لهرمز وClaude Code وCodex…) في ردود المحادثة ومقاعد الغرف وقائمة المحادثات ومنتقي الوكيل.
- **ما كان ناقصًا في المركز لهذا** (اكتُشف أثناء العمل، فبُدئ بالعقد):
  1. رسالة الغرفة كانت نصًا فقط (`400 text_only`)، فلا يمكن إرسال صورة أو ملف من محرّر الغرفة.
  2. `Approval.room_id` كان دائمًا `null`، و`RoomDetail.pending_approvals` دائمًا فارغة، فلا يعرف الجوال
     أن سؤالًا ما من مقعد في غرفة ولا يفتحه فيها.
  3. الجوال لم تكن فيه قائمة لما ينتظر الشخص أصلًا.

## القرار والموافقات
- **DECISIONS §99** (مقترح — للمالك أن يؤكد): رسالة الغرفة تقبل كتل `image` و`file` لمرفقات مرفوعة في
  بروفايل الغرفة (كلمات أو ملفات أو كلاهما)؛ معرّف لا يسمّي مرفقًا هناك `404`، والصوت والموقع
  `400 unsupported_block` (الجوال يرسل التسجيل ملفًا). تُحفظ الكتلة باسم المرفق ونوعه وحجمه وعنوانه،
  وتذهب الملفات مع دور كل مقعد التالي كما تذهب ملفات المحادثة مع تشغيلها، ويُذكر اسمها في نص الغرفة
  الذي يقرؤه المقعد `(attached: …)`. وسؤال المقعد أو طلب موافقته يحمل `room_id` غرفته أينما قُرئ (قائمة
  الموافقات، الأحداث، `RoomDetail.pending_approvals`). `sessions` يعرف غرفة المقعد من `rooms` عبر
  جذر التركيب (`registerRoomOfSeat`)، فلا يستورد أحدهما الآخر.
- **قائمة «بانتظارك» على الجوال** (مقترح — للمالك أن يؤكد): جرس بعدد في الشريط العلوي (المحادثة، والمسودة،
  والغرفة على أندرويد؛ كل الصفحات تحت الدرج على iOS) يجمع الموافقات والأسئلة في كل بروفايل يدخله الشخص
  (`sessions.listApprovals` لكل بروفايل، تتحدث مع `approval.*` على مقبس الجلسات الذي يسمع كل البروفايلات)،
  الأقدم أولًا؛ يُجاب كل عنصر في الورقة نفسها، أو يُفتح حيث يعيش: الغرفة، أو المحادثة، أو الجدولة لخطوة سير
  عمل. لم يُضف كوجهة في `navigation.json` لأنه ليس صفحة (كما في الويب شريطٌ لا وجهة).
- **الغرفة على الجوال**: رسائلك يمينًا، وبقية الناس والوكلاء يسارًا بأسمائهم (DECISIONS §69). تُنضمّ القناة
  (`join`) ما دامت الغرفة ظاهرة وتُترك عند الخروج؛ الغرف بلا إعادة تشغيل للأحداث، فبعد انقطاع تُقرأ الغرفة
  من جديد. فوق المحرّر سطر لكل مقعد يعمل (ينتظر دوره / يفكّر / يردّ / ينتظر إجابة) مع الأداة الحالية وزر
  إيقاف (`rooms.stopSeat`)، ومن يكتب الآن (`typing` مرة كل ثانيتين على الأكثر). `@` يعرض المقاعد التي
  تبدأ بما كُتب ثم التي تحتويه، و«@all · الجميع» حين تسمح الغرفة؛ وترسل الرسالة `mentions` منظّمة (أطول
  الأسماء أولًا، اسم كامل فقط، لا داخل عنوان بريد) — نفس قواعد الويب.
- **ورقة الأعضاء**: الوكلاء بحالتهم والقائد، والأشخاص مع الموجود الآن، ولصاحب الإدارة: الرمز ومشاركة
  الرابط `<hub>/join/<code>` ورمز جديد وإزالة عضو؛ و«مغادرة الغرفة» لكل من ليس منشئها (المغادرة هي إزالة
  النفس، كما في §69).
- **غرفة جديدة**: الاسم ووكلاء البروفايل القابلون للتشغيل؛ اسم المقعد اسم الوكيل، ويُرقَّم المكرر
  («hermes 2») ولا يكون `all`. **انضمام برمز**: رمز أو رابط يُلصق، ثم «البحث» (`rooms.previewInvite`:
  الاسم وعدد الوكلاء والأشخاص، و«أنت فيها من قبل») ثم «انضمام» أو «فتح».
- **وضع التحديد**: أندرويد بالضغط المطوّل على المحادثة (ثم النقر يحدد)، وiOS بالضغط المطوّل ثم «تحديد»
  (قائمة السياق؛ لأن الإيماءة المطوّلة على زر في iOS تطلق النقر أيضًا). الإجراءات لكل بروفايل على حدة
  (القائمة قد تجمع بروفايلات والنداء يسمّي واحدًا)، ١٠٠ معرّف على الأكثر في النداء؛ الحذف بعد سؤال؛ ما
  رفضه المركز يُقال بكلماته، والباقي يمضي.
- **التصدير**: `sessions.export` بصيغة Markdown، والطلب من العميل المولَّد نفسه (`RequestConfig` في
  كوتلن، و`WithRequestBuilder` في سويفت) ويُقرأ الجواب نصًا لأن العميل كان سيقرؤه JSON؛ الملف باسم
  المحادثة `.md` إلى نافذة المشاركة. لا مسار مكتوب باليد (`contracts:check-clients` نجح).
- **التنقل**: `surfaceRoutes.ios/android.rooms` صار `/rooms/:roomId?` (كالويب)، فـ`corehub://open/rooms/<id>`
  يفتح الغرفة في بروفايلها (`?profile=`). الغرفة جذر مثل المحادثة في مكدس أندرويد. اختبارا التكافؤ صارا
  يتحققان من فتح الغرفة (كان أندرويد يستثني `rooms`).
- **هوية الوكيل**: الاسم من سجل الوكلاء (`agents.list` لبروفايل المحادثة، يُقرأ مرة ويُحفظ ما دام
  التطبيق يعمل) لا من `author.name` حين يكون `agent`؛ في الغرفة يبقى اسم المقعد ويلبس وجه وكيله. الوجه:
  صورة الوكيل إن كانت له (`avatar.kind: image`، تُجلب مرة بالعميل المولَّد وتُخبأ)، وإلا شعاره من الكتالوج
  بالـ`slug`، وإلا حرفه الأول. **الشعارات** مصدرها واحد: `packages/web/src/ui/brand/marks.tsx` (مسارات
  الويب وخريطة `MARKS`)، يكتبها `scripts/icons/agent-marks-mobile.mjs` (`pnpm icons:agents`، و`--check`)
  إلى `Assets.xcassets/AgentMarks` وقائمة `AgentMarks.swift` في iOS، و`drawable/agent_mark_*.xml` و
  `AgentMarks.kt` في أندرويد، بقالب لون واحد يتبع السمة كما في الويب؛ ويُعاد كتابة أعلام الأقواس في
  المسارات بفواصل (`a.5.5 0 0 1 …`) لأن بعض قارئي المتجهات لا يفهمون الشكل المضغوط، والشكل لا يتغير.
  الإشعار في `THIRD-PARTY-NOTICES.md` صار يذكر التطبيقين. **الويب** يعرض «agent» أيضًا (نفس السبب)؛ لم
  يُمسّ هنا (خارج النطاق) — يُصلَح بالطريقة نفسها أو في المركز.
- **إعادة الاستعمال لا النسخ**: `Composer` و`AttachButton`/`AttachmentTray` و`rememberDictation`/
  `DictationStrip`/`MicButton` و`MessageFiles`/`MessageAttachments` و`ApprovalCard`/`QuestionCard`
  كما هي؛ `TurnView` (أندرويد) و`MessageRow` (iOS) أخذا معاملًا اختياريًا «هل هي لي» فقط.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
`openapi.yaml`: وصف `rooms.postMessage` و`RoomMessageCreate.content` (كتل الصور والملفات، §99)، ووصف
`RoomDetail.pending_approvals` و`Approval.room_id`. لا حقول ولا عمليات جديدة؛ العملاء المولَّدون لا يتغيرون
إلا في التعليقات.

## الملفات والتأثير
- المركز: `modules/rooms/{service,conductor,store,schema,index}.ts` (قبول الملفات وحفظها وتمريرها للمقعد،
  وقراءة ما ينتظر في المقاعد)، `modules/sessions/{ports,mappers,service,index}.ts` (`room_id` و`pending`
  و`files` في دور المقعد، و`registerRoomOfSeat`)، `modules/index.ts` (التركيب)،
  `tests/unit/rooms-files-pending.test.ts` (جديد).
- أندرويد: `rooms/{RoomMentions,RoomReducer}.kt`، `ui/screens/{RoomScreen,RoomViewModel,RoomsPanel,
  PendingSheet,Waiting}.kt` (جديدة)، `Shell.kt` (قائمة الغرف الجديدة ووضع التحديد)، `ShellViewModel.kt`
  (بانتظارك، التحديد، التصدير)، `MainActivity.kt` (مسار الغرفة، الجرس، «المزيد ← تصدير»)، `realtime/Realtime.kt`
  (`/rt/rooms`: join/leave/typing وإعادة الانضمام)، `nav/{Navigation,AppPaths}.kt`، `chat/ChatReducer.kt`
  (`authorId`)، `ui/components/ChatParts.kt` (`mine`)، النصوص بالعربية والإنجليزية، واختبار
  `rooms/RoomsTest.kt` (جديد) و`NavigationParityTest.kt`.
- iOS: `Rooms/{RoomMentions,RoomState,RoomModel,RoomScreen,RoomsList}.swift` و`Shell/PendingList.swift`
  (جديدة)، `ShellView.swift` و`SidebarView.swift` و`AppModel.swift` (مقبس الغرف والمسار) و`Routes.swift`،
  `Sessions/SessionList.swift` (التحديد)، `Chat/ChatModel.swift` و`ChatScreen.swift` (التصدير و`mine`)،
  حذف `RoomsList` القديم من `TasksSchedules.swift`، `i18n/{ar,en}.json`، واختبار `RoomsTests.swift` (جديد)
  و`NavigationParityTests.swift`.
- الهوية: `ui/components/AgentIdentity.kt` و`AgentMarks.kt` (مولَّد) و`res/drawable/agent_mark_*.xml` (مولَّدة)
  و`AppGraph.kt` (`agents`) و`ChatScreen.kt`/`RoomScreen.kt`/`RoomsPanel.kt`/`Shell.kt` واختبار
  `ui/AgentIdentityTest.kt` في أندرويد؛ `Shell/AgentIdentity.swift` و`Generated/AgentMarks.swift` و
  `Assets.xcassets/AgentMarks` و`AppModel.swift` (`agentDirectory`) و`ChatScreen.swift`/`RoomScreen.swift`/
  `RoomsList.swift`/`NewChatScreen.swift`/`SessionList.swift` واختبار `AgentIdentityTests.swift` في iOS؛
  `scripts/icons/agent-marks-mobile.mjs` و`package.json` (`icons:agents`) و`THIRD-PARTY-NOTICES.md`.
- `docs/clients/navigation.json` (مسار الغرف للجوالين)، `docs/contracts/DECISIONS.md` (§99)، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run` (لا Java ولا Xcode على هذه الآلة، فكوتلن وسويفت يُبنيان ويُختبران في CI):

```
$ pnpm --filter @corehub/server exec vitest run tests/unit/rooms-files-pending.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
$ pnpm --filter @corehub/server exec vitest run tests/unit/rooms-agents.test.ts tests/unit/rooms.test.ts \
    tests/unit/rooms-memory.test.ts tests/contract/rooms.contract.test.ts src/modules/rooms \
    src/modules/sessions/sessions-run.test.ts tests/unit/workflow-approvals.test.ts
 Test Files  8 passed (8)
      Tests  58 passed (58)
$ pnpm --filter @corehub/server typecheck      → خرج بـ0
$ pnpm contracts:check-clients
check-clients  OK — 671 client file(s) scanned, 235 contract path(s) known.
$ pnpm i18n:check
i18n:check  ios: 418 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop
```

CI على الفرع (`workflow_dispatch`): يُملأ أدناه.

## المخاطر والرجوع
- لم يُجرَّب على جوالَي المالك ولا على مركزه؛ الاختبارات وحدات ونماذج عرض، لا واجهات حقيقية.
- واجهات أندرويد لهذه الميزات دنيا عمدًا: المالك طلب إعادة تصميم أندرويد كاملة بوكيل آخر يبني عليها
  (نماذج العرض والبيانات والنداءات هنا هي الأساس).
- الويب لا يرفق ملفات في الغرفة بعد (المركز يقبلها الآن)؛ ولا يفتح عنصر الغرفة من شريط الانتظار (a17).
- iOS: الجرس يظهر في كل صفحة تحت الدرج (منها المهام والجدولة)؛ أندرويد في المحادثة والمسودة والغرفة فقط.
- الرجوع: استرجاع دمج الفرع؛ لا ترحيل قاعدة بيانات (عمود `attachment_ids` موجود من قبل).

## التسليم والخطوة التالية
دمج في `night/2026-09-27` (#165) بلا طلب دمج خاص. بعده: تجربة المالك على جهازيه، وقراره في §99 وفي مكان
الجرس على الجوال.
