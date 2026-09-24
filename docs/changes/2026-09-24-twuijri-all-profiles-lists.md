# القوائم تجمع كل البروفايلات، والشريحة للإنشاء والترشيح (المرحلة الأولى)
المسؤول: twuijri · الفرع: feat/all-profiles-lists · الحالة: review

## المشكلة والهدف
لاحظ المالك (٢٠٢٦-٠٩-٢٤) أن محادثات بروفايل «designer» لا تظهر إلا بعد تبديل شريحة البروفايل
في الأعلى، والرجوع لمحادثات «default» يحتاج تبديلًا آخر — متعب. الشريحة كانت تقوم بثلاث مهام معًا:
أي المحادثات تُعرض، وأين تُنشأ الجديدة، وأي بروفايل تحرّره صفحة الإعدادات. الهدف: قائمة واحدة
تجمع كل ما يحق للشخص دخوله، وكل عنصر يُفتح في بروفايله دون تبديل شيء.

## القرار والموافقات
أجاب المالك عن ثلاثة أسئلة (٢٠٢٦-٠٩-٢٤):
١) القوائم تجمع كل البروفايلات التي يحق للشخص دخولها وعلى كل عنصر شارة بروفايله، والشريحة
العلوية للإنشاء والترشيح؟ — «ايه». ٢) ماذا تعرض القوائم عند الدخول؟ — «كل البروفايلات افتراضيا».
٣) البحث يبحث دائمًا في كل بروفايلات الشخص؟ — «نعم».
مكتوب في `docs/adr/0016-lists-across-profiles.md` بمراحله الثلاث. **قراران للمالك ليؤكدهما**
(مقترحان محافظان): (أ) «محادثة جديدة» أثناء «كل البروفايلات» تُنشأ في بروفايل الشخص — آخر ما
اختاره وإلا الافتراضي — وشاشة المحادثة الجديدة تقول ذلك («محادثة جديدة في: Default») وتسمح
بتغييره؛ (ب) اختيار بروفايل في صفحة إعداد لا يرشّح القوائم، يقول فقط أي بروفايل تحرّره الصفحة.
الخريطة (Graphify) لم تُستعمل: التغيير في وحدتين معروفتين (`sessions` و`auth`) قُرئتا مباشرة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `sessions.list` يقبل `profiles=all`: الصفحة تجمع كل بروفايل يحق للمتصل دخوله (الخادم يقرّر:
  المالك والمشرف كل البروفايلات، والعضو ما سُجّل فيه)، وكل عنصر يذكر `profile`، والترويسة
  `X-Hub-Profile` ما زالت مطلوبة ويجب أن تكون بروفايلًا يحق له. المؤشر ترتيب واحد عبر الكل.
  البحث هو العملية نفسها مع `q`. بلا `profiles` السلوك كما كان تمامًا.
- المصافحة اللحظية `auth: { token, profile, profiles: 'all' }` تضمّ غرف كل بروفايل يحق للشخص
  (`packages/contracts/events/README.md` §Connecting).
- `docs/contracts/DECISIONS.md` §28 يشرح لماذا قيمة استعلام لا `X-Hub-Profile: *` ولا عملية ثانية.

## الملفات والتأثير
- الخادم: `modules/sessions/{routes,service,store,scope}.ts` (القائمة عبر البروفايلات بجملة SQL
  واحدة `workspace IN (…)`)، `modules/auth/scopes.ts` (`enterable` بقاعدة `listWorkspacesFor`
  نفسها)، `modules/auth/sockets.ts` (`profiles: 'all'`). اختبار جديد:
  `modules/sessions/sessions-profiles.test.ts` (الصلاحيات، الصفحات، البحث، اللحظي).
- الويب: `auth/context.tsx` (`homeProfile`، `allProfiles` افتراضيًا مفعّل عند كل دخول،
  `ProfileScope` و`ChromeScope`)، `shell/profileSelector.ts` (معنى الشريحة في صفحات القوائم وصفحات
  الإعداد)، `shell/ProfileBadge.tsx`، `shell/AppShell.tsx`، `shell/WorkspaceSwitcher.tsx`،
  `sessions/{SessionList,useSessionList}.ts(x)`، `hub/queries.ts`، `screens/{SearchScreen,NewChatScreen}.tsx`،
  `chat/{ChatScreen,SessionAgent,anchor,transcript}.ts(x)`، `realtime/{socket,context}.ts(x)`،
  `i18n/{ar,en}.json` (`shell.all_profiles`، `shell.in_profile`، `new_chat.in_profile`).
- **كيف يُفتح عنصر في بروفايله دون تحريك الشريحة:** `ProfileScope` يلفّ محتوى صفحة المحادثة فيرسل
  كل طلب داخله بـ`X-Hub-Profile` بروفايل المحادثة، ومفاتيح الاستعلام بها أيضًا (النماذج والوكلاء
  والإعدادات لذلك البروفايل)؛ أما الإطار (الشريط الجانبي والعلوي) فملفوف بـ`ChromeScope` فيبقى
  يتكلم باسم الشخص. العنوان يحمل `?profile=` متى كان للشخص أكثر من بروفايل، فإعادة التحميل
  والرابط المنسوخ يفتحان المحادثة في بروفايلها؛ من له بروفايل واحد تبقى روابطه كما كانت.
- مؤشر الاستئناف: `seq` لكل بروفايل، والمقبس يسمع كل البروفايلات، فالمحادثة لا تحرّك مؤشرها إلا
  بأحداث بروفايلها (وإلا تجاوزت ما فاتها).
- المستندات: ADR 0016، `docs/clients/NAVIGATION.md` (القاعدة ٤) و`navigation.json` (`profileScope`
  جديد، في مقطع منفصل عن تعديلات PR #71 على `footerChips`)، `docs/STATUS.md`.
- Playwright: رحلة جديدة `e2e/zzz-profiles.spec.ts` (تعمل أخيرًا لأنها تضيف بروفايلًا للمركز
  المشترك) وثلاث لقطات `all-profiles-*.png`. وُسّع تعبير عنوان المحادثة في `smoke.spec.ts`
  و`zz-design.spec.ts` ليقبل `?profile=` بعد أن ينشئ المشوار ١٣ بروفايلًا ثانيًا. أُعيدت كل
  اللقطات الأخرى إلى نسخة `main`.
- لا تغيير في المهام ولا الجدولة (المرحلة الثانية؛ PR #70 كان يلمس شاشة المهام).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!                       # exit 0
$ pnpm typecheck                                                  # exit 0
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 216 client file(s) scanned, 166 contract path(s) known.
$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  254 passed (254)
$ pnpm i18n:check
i18n:check  web: 815 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/server test
 Test Files  71 passed | 6 skipped (77)
      Tests  753 passed | 18 skipped (771)
$ pnpm --filter @majlis/web test
 Test Files  35 passed (35)
      Tests  455 passed (455)
$ pnpm --filter @majlis/contracts test
      Tests  15 passed (15)
$ pnpm --filter @majlis/cli test
      Tests  64 passed (64)
$ pnpm --filter @majlis/web build
✓ built in 910ms
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  ✓  27 [chromium] › e2e/zzz-profiles.spec.ts:78:3 › lists across profiles › two profiles, one list: both chats with badges, each opens and answers in its own profile, search finds both (8.6s)
  27 passed (2.9m)

# الاختبارات تسقط بدون التغيير:
# الخادم (أُعيدت ملفات sessions/auth إلى main وبقي الاختبار):
 ❯ |unit| src/modules/sessions/sessions-profiles.test.ts (10 tests | 7 failed)
     × gives the owner every profile, each item naming its own
     × gives an admin every profile too
     × gives a member with no enrolment every profile, as the header rule does
     × refuses a value it does not know rather than guessing
     × pages across profiles in one order: the pages equal one big page, no repeats, no gaps
     × finds hits in every profile the caller may enter, each carrying its profile and match
     × reaches a client that asked for every profile, and only the profiles it may enter
      Tests  7 failed | 3 passed (10)
# الويب (أُعيدت القائمة والاستعلامات والبحث والمحادثة واللحظي إلى main وبقي الاختبار):
     × opens on "All profiles": both profiles listed, each row with its badge
     × narrows to one profile when one is chosen, and back to all
     × opens each row in its own profile, and acts on it there
     × hears every profile on the sessions socket, and only there
     × opens a designer chat from the address, with its badge, without moving the selector
     × asks every profile even when the lists are narrowed, and opens each hit in its profile
     × moves the resume cursor only on its own profile’s count
      Tests  7 failed | 3 passed (10)
```

## المخاطر والرجوع
- المقبس لشخص بعدة بروفايلات يستقبل أحداث كل بروفايلاته؛ الويب يطبّقها بحسب `profile` الحدث.
- غرف المقبس تُحدَّد عند الاتصال: بروفايل يُنشأ أو عضوية تُمنح بعده تُسمع من إعادة الاتصال التالية.
- روابط المحادثة التي لا تحمل بروفايلًا (الإشعارات، محادثة مهمة) تفتح في بروفايل الشخص كما كانت.
- **ملاحظة أمنية سابقة لهذا التغيير (خارج النطاق):** `/rt/sessions` يضمّ المقبس غير الموثّق إلى غرفة
  البروفايل المذكور في المصافحة (`sessions/realtime.ts` → `attach`)، و`subscribe` لا يتحقق من
  أن الجلسة في بروفايل يحق للمقبس. هذا التغيير لا يوسّعه (`profiles: 'all'` لا يضمّ شيئًا بلا رمز)،
  لكنه يستحق مهمة مستقلة.
- الرجوع: استرجاع الـ commit؛ `profiles` اختياري فلا عميل قديم يتأثر.

## التسليم والخطوة التالية
PR إلى `main` للمراجعة (لا دمج). المرحلة الثانية: لوحة المهام تفتح على «الكل» بشارات، وفتح محادثة
مهمة ببروفايلها بدل `setProfile`، وصفحة الجدولة كذلك. المرحلة الثالثة: سطح المكتب كالويب، ومكان
الشريحة في الجوال لم يُقرَّر.
