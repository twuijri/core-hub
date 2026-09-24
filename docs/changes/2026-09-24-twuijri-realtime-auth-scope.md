# إصلاح أمني: الاتصال اللحظي لا يُفتح بلا دخول، ولا يتابع إلا ما يحق للمتصل
المسؤول: twuijri · الفرع: fix/realtime-auth-scope · الحالة: review

## المشكلة والهدف
وجد وكيل #73 (القوائم عبر البروفايلات) ثغرة قديمة في `main`، وقال المالك (٢٠٢٦-٠٩-٢٤): «ايه صلحها
دامها مشكله خطيره».

الثغرة في طبقة Socket.IO:
1. **اتصال بلا رمز دخول يُضمّ إلى غرفة بروفايل.** وسيط `auth` كان يترك الاتصال بلا رمز يمرّ
   (`return next()`)، ثم كان معالج `/rt/sessions` نفسه يضمّ **كل** اتصال إلى
   `profile:<ما كتبه العميل في المصافحة، أو default>` دون أي تحقق. فأي أحد يصل إلى المنفذ يسمع
   `session.*` و`approval.*` (عناوين المحادثات ونص ما يطلب الوكيل الموافقة عليه) لأي بروفايل يسمّيه.
2. **متابعة أي محادثة بلا تحقق.** أمر `subscribe` كان يضمّ الاتصال إلى `session:<id>` لأي معرّف،
   ويعيد إرسال ما فاته من الذاكرة مع `after_seq`. فيصل نص المحادثة لحظة بلحظة (`message.delta`،
   `reasoning.delta`، `tool.*`، `run.*`) لمن ليس له حق: مجهول، أو عضو في بروفايل آخر.
3. **الاتصال يعيش بعد سحب الصلاحية.** الخروج، وإلغاء الرمز، وتعطيل المستخدم أو حذفه، وتغيير دوره أو
   عضويته، وأرشفة البروفايل — لا شيء منها كان يقطع الاتصالات المفتوحة.

الهدف: كل مساحة لحظية تشترط رمزًا صالحًا بنفس تحقق REST، والغرف يقررها الخادم من هوية المتصل،
ومتابعة المحادثة تمر بنفس سؤال `GET /sessions/{id}`، وما يسحب الصلاحية يقطع الاتصال.

## القرار والموافقات
- الموافقة: المالك في المحادثة (الاقتباس أعلاه). إصلاح أمني؛ لا دمج ولا نشر من المساعد.
- **المصافحة (`modules/auth/sockets.ts`)**: بلا رمز أو برمز مرفوض ← رفض برمز الخطأ رسالةً وفي
  `data.code` (`unauthorized`، `token_expired`، `rate_limited`)، وبروفايل لا يحق دخوله ←
  `profile_not_found`. التحقق هو `resolvePrincipal` نفسه (JWT وجلسة غير ملغاة ومستخدم مفعّل، ورموز
  التطبيقات). غرفة `profile:<slug>` فقط عبر `resolveWorkspaceFor`، ومع `profiles: 'all'` (ADR 0016)
  كل ما يعطيه `listWorkspacesFor` — لم نُعِد كتابة القاعدة، فتغيير قاعدة العضوية في فرع آخر يسري هنا
  تلقائيًا. تُحفظ البروفايلات المقبولة في `socket.data.workspaces`.
- **المتابعة (`modules/sessions`)**: حُذف ضمّ غرفة البروفايل من ادعاء العميل. `subscribe` يمر بفحص
  (`FollowCheck`) يحل نطاق المتصل لكل بروفايل قُبل فيه بنفس `ScopeResolver` الذي يستعمله REST، ثم
  يبحث عن الجلسة في ذلك النطاق — كما يفعل `GET /sessions/{id}` (REST لا يقيّد الجلسة بمالكها داخل
  البروفايل، فلا نقيّدها هنا). غير موجودة أو في بروفايل آخر ← `{ ok:false, code:'not_found' }` دون
  كشف وجودها. وقبل توصيل الفحص يُرفض كل اشتراك (مغلق لا مفتوح). منفذ `ScopeResolver` صار يقبل
  «المتصل» (`principal`/`authError`) لا طلب HTTP كاملًا.
- **التركيب (`app/sockets.ts`)**: وسيط أخير على كل مساحة يرفض أي اتصال بلا هوية، فلو غاب `auth` من
  تركيبٍ ما يبقى الخادم مغلقًا؛ ومساحة `/` الرئيسية (لا تحمل شيئًا) مغلقة أيضًا.
- **`lib/realtime.ts`**: حدث لا يسمّي غرفة ولا بروفايلًا لا يُبث إلى المساحة كلها بعد اليوم.
- **سحب الصلاحية**: `revalidateSockets` يقطع كل اتصال لم يعد رمزه أو مستخدمه أو دوره أو بروفايلاته
  تقبله. يُستدعى بعد: الخروج، إلغاء رمز، إعادة إقران جهاز، تعديل مستخدم (حالة/دور/عضوية/كلمة مرور)،
  حذف مستخدم، تغيير كلمة المرور، أرشفة بروفايل.
- **الويب**: socket.io لا يعيد محاولة مصافحة مرفوضة. عند رفض الرمز يطلب المزوّد رمزًا جديدًا مرة
  واحدة لكل رمز (أو يعود فورًا إن كان رمز أحدث موجودًا)، وأي رمز جديد يعيد الاتصالات المرفوضة.

### جرد المساحات
| المساحة | ما وُجد | الإصلاح |
|---|---|---|
| `/rt/sessions` | الثغرتان ١ و٢ كاملتين (غرفة بروفايل للمجهول، ومتابعة أي جلسة لأي أحد، مع إعادة ما فات) | رمز إلزامي، غرفة البروفايل من `auth` فقط، `subscribe` بفحص النطاق |
| `/rt/jobs` | المجهول كان يتصل بلا غرفة (لا يسمع شيئًا اليوم)، لكن مسار «لا بروفايل ← بث للمساحة كلها» كان سيصله | رمز إلزامي، وإلغاء البث العام |
| `/rt/tasks`، `/rt/schedules`، `/rt/rooms` | لا أوامر عميل منفّذة؛ الغرف من `auth` فقط؛ المجهول يتصل ولا يسمع إلا بثًا عامًا (غير مستعمل) | رمز إلزامي. أوامر `subscribe`/`join` الموثقة في العقد غير منفّذة بعد، ومن ينفّذها يمر بالنمط نفسه |
| `/rt/devices` | غرفة المستخدم فقط برمز؛ المجهول يتصل ولا يسمع | رمز إلزامي. **لا حاجة لمجهول**: الهاتف يطالب بالإقران عبر REST بالرمز، والويب الذي يعرض الـQR مسجّل دخوله |
| `/` | يقبل أي أحد ولا يحمل شيئًا | مغلقة |
| كل المساحات | الاتصال يعيش بعد الخروج/التعطيل/الإلغاء | `revalidateSockets` |

## العقد
`packages/contracts/events/README.md` §Connecting: الرمز إلزامي على كل مساحة ولا اتصال لحظي مجهول،
ورموز الرفض، وأن الغرف يقررها الخادم، و`subscribe` خارج البروفايلات المقبولة ← `not_found`، وأن سحب
الصلاحية يقطع الاتصال. حُذفت جملة «Without a token, `profiles` joins nothing» (من #73) لأن المصافحة بلا
رمز لم تعد ممكنة. لا حدث ولا مسار جديد.

## الملفات والتأثير
- الخادم: `modules/auth/sockets.ts`، `modules/auth/routes.ts`، `modules/auth/scopes.ts`،
  `modules/auth/index.ts`، `modules/auth/README.md`، `modules/sessions/realtime.ts`،
  `modules/sessions/index.ts`، `modules/sessions/scope.ts`، `app/sockets.ts`، `lib/realtime.ts`.
- الويب: `auth/client.ts` (`refresh` مكشوف)، `auth/context.tsx`، `realtime/socket.ts`
  (`onAuthRefused`)، `realtime/context.tsx`.
- الاختبارات: `tests/unit/realtime-auth.test.ts` (جديد، ١٣)، وتحديث `sockets.test.ts`
  و`sessions-run.test.ts` و`naming.test.ts` (كانت تتصل بلا رمز)؛ الويب `realtime-socket.test.ts`
  (جديد) و`realtime-context.test.tsx`؛ الرحلة ٢٣ `e2e/zzz-realtime-token.spec.ts` ونقطة الاختبار
  `/__e2e/expire-token` في `e2e/hub.ts`.
- دُمج `main` بعد #73: `profiles: 'all'` محفوظ، وصار يملأ `socket.data.workspaces` فتعمل متابعة
  محادثة من بروفايل آخر يحق دخوله، ولا تتجاوزه.

## الفحوص
```
pnpm lint                      All matched files use Prettier code style! (exit 0)
pnpm typecheck                 exit 0
pnpm contracts:lint            contracts:lint  OK
pnpm contracts:check-clients   check-clients  OK — 218 client file(s) scanned, 166 contract path(s) known.
pnpm contract:test             Test Files  2 passed (2) · Tests  254 passed (254)
pnpm i18n:check                i18n:check  OK
pnpm nav:check                 nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
pnpm --filter @majlis/server test   Test Files  72 passed | 6 skipped (78) · Tests  766 passed | 18 skipped (784)
pnpm --filter @majlis/web test      Test Files  36 passed (36) · Tests  461 passed (461)
pnpm --filter @majlis/cli test      Test Files  11 passed (11) · Tests  64 passed (64)
pnpm --filter @majlis/web build     ✓ built in 709ms
PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e   28 passed (1.8m)
```
**الاختبارات تلتقط الثغرة** (كود `main` بعد #73 مكان الإصلاح، والاختبارات الجديدة كما هي):
```
server tests/unit/realtime-auth.test.ts على كود main:
  × refuses a socket with no token on every namespace, saying why
  × keeps the main namespace, which carries nothing, closed even to a signed-in person
  × refuses a session in another workspace and an id that does not exist
  × delivers nothing from another workspace: not its chat, not its session list
  × never reaches past what the member may enter, even when asking for every profile
  × drops a disabled member at once, and refuses them on the way back
  × drops the sockets of a session that signed out, and refuses its token after
  × drops a socket whose workspace the member was moved out of
  Tests  8 failed | 5 passed (13)
web tests/realtime-{socket,context} على كود main:
  × reports a refused token, with the token the handshake carried
  × asks for a new token once when the hub refuses the old one, and comes back with it
  × comes back at once when a newer token is already there
  Tests  3 failed | 8 passed (11)
e2e الرحلة ٢٣ على ويب main:
  ✘ 23. an access token that expired while away … — Locator: getByRole('status', { name: 'متصل' }) not found
```
الخمسة الناجحة على `main` كانت صحيحة أصلًا (رفض الرمز المزيّف والمنتهي، وقبول المسجّل، ورفض بروفايل
لا يحق للعضو عند تسميته صراحةً، وبث محادثة في بروفايله) — تبقى حارسة ضد التراجع.
لقطات e2e أُعيدت كما في `main` (لا تغيير مرئي). `graphify-out/` لم يُلمس.

## المخاطر والرجوع
- **عميل قديم بلا رمز** لن يتصل لحظيًا بعد اليوم — هذا هو المقصود. الويب والـCLI يرسلان الرمز أصلًا.
- **انتهاء JWT أثناء اتصال قائم** لا يقطعه: الاتصال يعيش ما دامت الجلسة (صف `app_tokens`) صالحة،
  ويُقطع عند إلغائها أو أي سحب صلاحية أعلاه. عند إعادة الاتصال يُطلب رمز صالح.
- `revalidateSockets` يفحص اتصالات هذه العملية فقط (المحور عملية واحدة اليوم).
- تغيير دور المستخدم أو عضويته يقطع كل اتصالاته؛ الويب يعود بعد ثانية ويُقبل من جديد بصلاحيته الجديدة.
- الـCLI لا يجدد رمزه تلقائيًا عند رفض المصافحة (لم يتغير سلوكه؛ كان يُرفض بالرمز المنتهي قبل هذا).
- الرجوع: التراجع عن الفرع وحده. لا ترحيل بيانات.

## التسليم والخطوة التالية
PR إلى `main` بعلامة إصلاح أمني. الدمج للمالك وحده. بعد الدمج: عند تنفيذ أوامر `subscribe` في
`/rt/tasks` و`/rt/schedules` و`join` في `/rt/rooms` يجب أن تمر بفحص مثل `FollowCheck` قبل ضمّ الغرفة.
