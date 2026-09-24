# قائمة المحادثات تجمع كل البروفايلات بمرشّحها الخاص، والشريحة العلوية هي البروفايل الذي أنت فيه (المرحلة الأولى)
المسؤول: twuijri · الفرع: feat/all-profiles-lists ثم fix/all-profiles-list-filter · الحالة: review

## المشكلة والهدف
لاحظ المالك (٢٠٢٦-٠٩-٢٤) أن محادثات بروفايل «designer» لا تظهر إلا بعد تبديل شريحة البروفايل
في الأعلى، والرجوع لمحادثات «default» يحتاج تبديلًا آخر — متعب. الشريحة كانت تقوم بثلاث مهام معًا:
أي المحادثات تُعرض، وأين تُنشأ الجديدة، وأي بروفايل تحرّره صفحة الإعدادات. الهدف: قائمة محادثات
تجمع كل ما يحق للشخص دخوله، وكل عنصر يُفتح في بروفايله دون تبديل شيء.

## القرار والموافقات
أجاب المالك عن ثلاثة أسئلة (٢٠٢٦-٠٩-٢٤):
١) القوائم تجمع كل البروفايلات التي يحق للشخص دخولها وعلى كل عنصر شارة بروفايله؟ — «ايه».
٢) ماذا تعرض قائمة المحادثات عند الدخول؟ — «كل البروفايلات افتراضيا».
٣) البحث يبحث دائمًا في كل بروفايلات الشخص؟ — «نعم».

البناء الأول وضع «كل البروفايلات» في الشريحة العلوية، فصحّحه المالك:
«المفروض ما فيه خيار الكل. خيار الكل كان لتصنيف المحادثات بس… المفروض يفتح على اختيار البروفايل
الي انا عليه من فوق الصفحة على اليمين. هل انت خليت خيار فوق على اليمين اسمه الكل؟»
ثم: «كل البروفايلات تكون بس لتصنيف المحادثات بس. الكرون جوب والمهام المفروض تطلع كل البروفايلات
بدون تصنيف».

فالتصميم الآن:
- **الشريحة العلوية** بروفايل محدد دائمًا — الذي أنت فيه، ولا «الكل» فيها أبدًا. التطبيق يفتح
  عليه (آخر ما اختير، وإلا الافتراضي، كما كان). فيه تُنشأ المحادثة الجديدة، وصفحات الإعداد تحرّره،
  ولا ترشّح أي قائمة.
- **قائمة المحادثات لها مرشّحها** أعلاها: «كل البروفايلات» (الافتراضي عند كل دخول) أو بروفايل
  واحد، ويختفي لمن له بروفايل واحد. لا يحرّك الشريحة ولا تحرّكه. الشارات على الصفوف متى ظهر أكثر
  من بروفايل.
- **المحادثة الجديدة** في بروفايل الشريحة العلوية دائمًا. اخترتُ الأبسط: حُذف المختار الثاني من
  شاشة المحادثة الجديدة، وبقي سطر يسمّي البروفايل ويقول إن تغييره من أعلى الصفحة — عنصر تحكم
  واحد يقرّر أين تُنشأ الأشياء فلا يختلف معه شيء.
- **البحث** في الكل دائمًا. **المهام والجدولة** (المرحلة الثانية) تعرض كل البروفايلات **بلا
  مرشّح بروفايل**، وتُحذف قائمة مرشّح البروفايل الحالية من لوحة المهام، مع شارة لكل بطاقة.
- القراران اللذان كانا للمالك حُسما بالتصحيح: الشريحة العلوية لا ترشّح القوائم أبدًا، والمحادثة
  الجديدة في بروفايلها.
مكتوب في `docs/adr/0016-lists-across-profiles.md`. الخريطة (Graphify) لم تُستعمل: التغيير في
وحدتين معروفتين (`sessions` و`auth`) قُرئتا مباشرة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `sessions.list` يقبل `profiles=all`: الصفحة تجمع كل بروفايل يحق للمتصل دخوله (الخادم يقرّر:
  المالك والمشرف كل البروفايلات، والعضو ما سُجّل فيه)، وكل عنصر يذكر `profile`، والترويسة
  `X-Hub-Profile` ما زالت مطلوبة ويجب أن تكون بروفايلًا يحق له. المؤشر ترتيب واحد عبر الكل.
  البحث هو العملية نفسها مع `q`. بلا `profiles` السلوك كما كان تمامًا. مرشّح القائمة على بروفايل
  واحد طلب عادي بترويسة ذلك البروفايل.
- المصافحة اللحظية `auth: { token, profile, profiles: 'all' }` تضمّ غرف كل بروفايل يحق للشخص
  (`packages/contracts/events/README.md` §Connecting).
- `docs/contracts/DECISIONS.md` §28 يشرح لماذا قيمة استعلام لا `X-Hub-Profile: *` ولا عملية ثانية.
- لم يتغيّر العقد في إعادة العمل هذه.

## الملفات والتأثير
- الخادم: `modules/sessions/{routes,service,store,scope}.ts` (القائمة عبر البروفايلات بجملة SQL
  واحدة `workspace IN (…)`)، `modules/auth/scopes.ts` (`enterable` بقاعدة `listWorkspacesFor`
  نفسها)، `modules/auth/sockets.ts` (`profiles: 'all'`). اختبار جديد:
  `modules/sessions/sessions-profiles.test.ts` (الصلاحيات للمالك والمشرف والعضو المسجّل، الصفحات،
  البحث، اللحظي). لا يعتمد على معنى «عضو بلا تسجيل» لأنه يتغيّر في فرع
  `fix/member-profiles-explicit`.
- الويب: `shell/WorkspaceSwitcher.tsx` **عاد كما في `main`** (بروفايل محدد فقط)؛ `auth/context.tsx`
  (`homeProfile`، `listFilter` مرشّح القائمة في الذاكرة وافتراضيه «الكل»، `ProfileScope`
  و`ChromeScope`)؛ `shell/profiles.ts` (الشارة والرابط)؛ `shell/ProfileBadge.tsx`؛
  `shell/AppShell.tsx` (`ChromeScope` حول الإطار فقط)؛ `sessions/{SessionList,useSessionList}.ts(x)`
  (مرشّح القائمة)؛ `hub/queries.ts`؛ `screens/{SearchScreen,NewChatScreen}.tsx`؛
  `chat/{ChatScreen,SessionAgent,anchor,transcript}.ts(x)`؛ `realtime/{socket,context}.ts(x)`؛
  `i18n/{ar,en}.json` (`sessions.all_profiles`، `sessions.profile_filter`، `shell.in_profile`،
  `new_chat.in_profile`).
- **كيف يُفتح عنصر في بروفايله دون تحريك الشريحة:** `ProfileScope` يلفّ محتوى صفحة المحادثة فيرسل
  كل طلب داخله بـ`X-Hub-Profile` بروفايل المحادثة، ومفاتيح الاستعلام بها أيضًا (النماذج والوكلاء
  والإعدادات لذلك البروفايل)؛ الإطار (الشريط الجانبي والعلوي) ملفوف بـ`ChromeScope` فيبقى يتكلم
  باسم الشخص. العنوان يحمل `?profile=` متى كان للشخص أكثر من بروفايل.
- مؤشر الاستئناف: `seq` لكل بروفايل، والمقبس يسمع كل البروفايلات، فالمحادثة لا تحرّك مؤشرها إلا
  بأحداث بروفايلها.
- المستندات: ADR 0016، `docs/clients/NAVIGATION.md` (القاعدة ٤) و`navigation.json` (`profileScope`:
  `selector: concrete`، `listFilter: [chat]`، `alwaysAll: [search, tasks, schedules]`) في مقطع
  منفصل عن تعديلات PR #71 على `footerChips`/`topBarChips`، و`docs/STATUS.md`.
- Playwright: `e2e/zzz-profiles.spec.ts` (تعمل أخيرًا لأنها تضيف بروفايلًا للمركز المشترك)، ولقطات
  المرشّح فقط: `all-profiles-{sidebar,filter,search}-ar-light.png` (حُذفت لقطة التصميم الأول).
  وُسّع تعبير عنوان المحادثة في `smoke.spec.ts` و`zz-design.spec.ts` ليقبل `?profile=`. أُعيدت كل
  اللقطات الأخرى إلى نسخة `main`.
- لا تغيير في المهام ولا الجدولة (المرحلة الثانية).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!                       # exit 0
$ pnpm typecheck                                                  # exit 0
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 216 client file(s) scanned, 166 contract path(s) known.
$ pnpm contract:test
      Tests  254 passed (254)
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/server test
 Test Files  71 passed | 6 skipped (77)
      Tests  752 passed | 18 skipped (770)
$ pnpm --filter @majlis/web test
 Test Files  35 passed (35)
      Tests  457 passed (457)
$ pnpm --filter @majlis/contracts test
      Tests  15 passed (15)
$ pnpm --filter @majlis/cli test
      Tests  64 passed (64)
$ pnpm --filter @majlis/web build
✓ built in 826ms
$ MAJLIS_E2E_PORT=8891 MAJLIS_E2E_SETUP_PORT=8892 PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  ✓  27 [chromium] › e2e/zzz-profiles.spec.ts:80:3 › lists across profiles › two profiles, one list: the list filter opens on all, the top selector is one profile, each chat answers in its own, search finds both (5.8s)
  27 passed (1.8m)
# (منافذ أخرى لأن مركز e2e لفرع آخر كان يعمل على 8791/8792)

# الاختبارات تسقط بدون التغيير:
# الخادم (ملفات sessions/auth من main، والاختبار باقٍ):
     × gives the owner every profile, each item naming its own
     × gives an admin every profile too
     × refuses a value it does not know rather than guessing
     × pages across profiles in one order: the pages equal one big page, no repeats, no gaps
     × finds hits in every profile the caller may enter, each carrying its profile and match
     × reaches a client that asked for every profile, and only the profiles it may enter
      Tests  6 failed | 3 passed (9)
# الويب (القائمة والاستعلامات والبحث والمحادثة الجديدة والمحادثة واللحظي من main):
     × does not move the list filter: the list stays on every profile
     × opens on "All profiles": both profiles listed, each row with its badge
     × narrows to one profile without moving the top selector, and back to all
     × opens each row in its own profile, and acts on it there
     × hears every profile on the sessions socket, and only there
     × says which, and follows the top selector — with no second control to disagree
     × opens a designer chat from the address, with its badge, without moving the selector
     × asks every profile even when the list is narrowed, and opens each hit in its profile
     × moves the resume cursor only on its own profile’s count
      Tests  9 failed | 3 passed (12)
```

## المخاطر والرجوع
- المقبس لشخص بعدة بروفايلات يستقبل أحداث كل بروفايلاته؛ الويب يطبّقها بحسب `profile` الحدث.
- غرف المقبس تُحدَّد عند الاتصال: بروفايل يُنشأ أو عضوية تُمنح بعده تُسمع من إعادة الاتصال التالية.
- روابط المحادثة التي لا تحمل بروفايلًا (الإشعارات، محادثة مهمة) تفتح في بروفايل الشخص كما كانت.
- **ملاحظة أمنية سابقة لهذا التغيير (خارج النطاق):** `/rt/sessions` يضمّ المقبس غير الموثّق إلى غرفة
  البروفايل المذكور في المصافحة (`sessions/realtime.ts` → `attach`)، و`subscribe` لا يتحقق من
  أن الجلسة في بروفايل يحق للمقبس. هذا التغيير لا يوسّعه (`profiles: 'all'` لا يضمّ شيئًا بلا رمز)،
  لكنه يستحق مهمة مستقلة.
- الرجوع: استرجاع الـ commits؛ `profiles` اختياري فلا عميل قديم يتأثر.

## التسليم والخطوة التالية
دمج المالك PR #73 (التصميم الأول، «الكل» في الشريحة العلوية) قبل وصول تصحيحه؛ هذا التصحيح في PR
مستقل من فرع `fix/all-profiles-list-filter` فوق `main`، للمراجعة (لا دمج). المرحلة الثانية: المهام والجدولة تعرضان كل البروفايلات بلا
مرشّح بروفايل (تُحذف قائمة المرشّح من لوحة المهام) مع شارة لكل بطاقة، وفتح محادثة مهمة ببروفايلها
بدل `setProfile`. المرحلة الثالثة: سطح المكتب كالويب، ومكان الشريحة في الجوال لم يُقرَّر.
