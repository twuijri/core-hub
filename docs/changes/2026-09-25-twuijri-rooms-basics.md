# الغرف، الجزء الأول: الغرفة وأعضاؤها ومقاعدها ورسائلها
المسؤول: twuijri · الفرع: feat/rooms · الحالة: review

## المشكلة والهدف
وحدة `rooms` كانت كلها `501` (صفر من ٢٨ عملية) وتبويب «الغرف» في الويب لافتة «لاحقًا».
المالك طلب «كمل كل الشغل»، والغرف كانت مؤجّلة، فكل ما هنا **مقترح — ينتظر تأكيد المالك**.
الهدف في هذا الجزء (من ثلاثة، مكدّسة): غرفة تُنشأ وتُسرد وتُعاد تسميتها وتُؤرشف؛ أعضاء
من الناس ومقاعد من الوكلاء (لكل مقعد اسمه ودوره وتعليماته ونموذجه)؛ دعوة برمز
(`join_by_code`)؛ رسائل بأحداث حيّة؛ وتبويب الغرف في الويب: القائمة، وشاشة الغرفة بالرسائل
والملحن ولوحة الأعضاء، بالعربية والإنجليزية. ردّ الوكلاء داخل الغرفة هو الجزء الثاني،
والملخّص وتقارير المشاريع الجزء الثالث.

## القرار والموافقات
قرار العقد §69 (مقترح — ينتظر تأكيد المالك):
- **الغرفة لأعضائها**: من أنشأها يديرها (`owner`)، ومن انضم برمزها عضو. غيرهم — ولو كان
  مشرف المركز — يجد `404` كأنها غير موجودة. القائمة غرف المتصل وحده.
- **رمز الدعوة** ثمانية أحرف وأرقام بلا I وO و0 و1، والرابط `<hub>/join/<code>`. الرمز لا
  يفتح بروفايلًا: يعمل فقط لمن يستطيع دخول بروفايل الغرفة أصلًا. الانضمام مرتين ليس خطأ.
  تدوير الرمز يُبطل القديم.
- **من يجيب**: المقاعد المذكورة بـ@ (منظّمة في `mentions` لا من النص)، وكل المقاعد بـ`@all`
  إن سمحت الغرفة، و**مقعد القائد** إن لم تُذكر أحدًا (`lead_seat_id`: أول مقعد يُضاف،
  يتغيّر، `null` = لا أحد). اخترت «القائد» على «لا أحد» لأن غرفة بوكيل واحد يجب أن تردّ كما
  تردّ المحادثة. (الإجابة الفعلية في الجزء الثاني.)
- **الأرشفة** حقل `archived` في `RoomPatch` لا عملية جديدة؛ الغرفة المؤرشفة تُقرأ ولا
  يُكتب فيها (`409`).
- **المقعد** له محادثته في `sessions` (مصدر `room`) تُفتح عند إضافته، فيُرفض المقعد قبل أن
  يوجد إن كان الوكيل غير متاح، ولا تظهر هذه المحادثات في قائمة المحادثات. الاسم فريد في
  الغرفة بلا اعتبار لحالة الأحرف، و`all` محجوز.
- **الويب**: رسائلك يمينًا، وكل من سواك — ناس ووكلاء — يسارًا باسمه؛ لأن «الطرف الآخر» في
  الغرفة أكثر من متحدّث.
- `room.created` يذهب لمنشئ الغرفة وحده لا للبروفايل كله، لأنه يحمل رمز الدعوة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `Room`: حقلان جديدان مطلوبان `lead_seat_id` و`archived_at` (والأمثلة حُدّثت).
- `RoomPatch`: `can_mention_all` و`lead_seat_id` و`archived`. `RoomCreate`: `can_mention_all`.
- `rooms.list`: معامل `archived`. `rooms.postMessage`: وصف قاعدة من يجيب، واستجابة `409`.
- `events/common.schema.json` و`room.created`/`room.updated`: تعريف `Room` المضمّن.
- لا عمليات جديدة: المجموع باقٍ ٢٦٤.

## الملفات والتأثير
- الخادم: `packages/server/src/modules/rooms/{schema,store,serialize,service,realtime,index}.ts`
  و`drizzle/0020_rooms.sql` (أعمدة جديدة لـ`rooms` و`seats` و`room_messages`، وجدولا
  `room_handoff_chains` و`seat_presets`؛ رقم 0020 لأن 0016 محجوز في عدة طلبات مفتوحة).
  في `sessions`: منفذ `SeatSessions` (فتح محادثة المقعد، دوره، إيقافه، تشغيلاته، والاستماع
  لأحداث محادثته) — إضافات فقط. الربط في `modules/index.ts`.
- الويب: `packages/web/src/rooms/*`، ومسار `/rooms/:roomId?` و`/join/:code`، وقائمة الغرف في
  الشريط الجانبي، وإخفاء محادثات المقاعد من قائمة المحادثات، ونصوص `rooms.*` بالعربية
  والإنجليزية.
- الوثائق: DECISIONS §69، `docs/domain/rooms.md`، `docs/STATUS.md` (226 من 264).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (المجموعات الكاملة في CI):
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
exit=0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 292 client file(s) scanned, 176 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm db:generate
No schema changes, nothing to migrate 😴
$ vitest --project unit tests/unit/rooms.test.ts src/modules/rooms/rooms.test.ts tests/unit/status.test.ts src/modules/sessions/{sessions-run,sessions-api,global-agent}.test.ts tests/unit/sockets.test.ts
 Test Files  7 passed (7)
      Tests  55 passed (55)
$ vitest --project contract tests/contract/rooms.contract.test.ts tests/contract/contract.test.ts
 Test Files  2 passed (2)
      Tests  266 passed (266)
$ vitest (web) tests/rooms.test.tsx tests/navigation.parity.test.tsx tests/session-menu.test.tsx tests/i18n.test.ts tests/logical-css.test.ts tests/ui-layer.test.ts tests/all-profiles.test.tsx
 Test Files  7 passed (7)
      Tests  225 passed (225)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome playwright test zzzzzz-rooms.spec.ts
  1 passed (9.3s)
```
CI على #135 (التشغيل 36106538540) — كلها خضراء:
```
Lint, typecheck, contracts, tests, build	pass	14m25s
Web smoke journeys (Playwright against the real hub)	pass	5m16s
db:generate + db:migrate (SQLite and PostgreSQL)	pass	1m2s
Docker image builds and answers /health	pass	2m44s
PR adds or updates a change record	pass	15s
PR leaves graphify-out/ to the code-map bot	pass	9s
```

## المخاطر والرجوع
- الترحيل 0020 يضيف أعمدة وجدولين فقط، ولا يلمس بيانات (لم تكن هناك غرف). إن دُمج قبله
  طلب يحمل 0016 فيلزم إعادة توليد لقطة drizzle عند الدمج.
- الرجوع: revert الطلب؛ الأعمدة الإضافية لا تضر إن بقيت.
- اختبار Playwright كشف سباقًا: رسالة تُرسل قبل أن ينضم المقبس إلى قناة الغرفة لا تُعاد؛
  الحل أن كل انضمام يطلب آخر صفحة من الرسائل ويدمجها.

## التسليم والخطوة التالية
الجزء الثاني (`feat/rooms-agents`): تشغيل الوكلاء المذكورين وبثّ ردودهم بمؤشرات الكتابة
والتقدّم، التسليم بين الوكلاء بحارس الحلقات وحدّ العمق، والإيقاف. ثم الجزء الثالث: الملخّص
المتدحرج وتقارير تقدّم المهام في غرفة المشروع.
