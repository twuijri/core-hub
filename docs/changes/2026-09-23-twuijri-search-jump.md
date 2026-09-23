# البحث يفتح المحادثة عند الكلمة لا في آخرها
المسؤول: twuijri · الفرع: feat/search-jump-to-message · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٣):
«وفي البحث اذا بحثت عن كلمه وجابلي باي محادثه وضغطت عليها يوديني للكلمه داخل المحادثه لان بعض
المحادثات يكون فيها كلام كثير كيف اعرف وينها»

كانت نتيجة البحث تفتح المحادثة في آخرها كأي فتح عادي، فإذا كانت الكلمة في رسالة قديمة من محادثة
طويلة لا يعرف أين هي. الهدف: الضغط على النتيجة يفتح المحادثة والرسالة المطابقة في منتصف الشاشة،
مُبرَزة، والكلمة معلَّمة داخلها، دون أن تُسحب الصفحة إلى الأسفل.

## القرار والموافقات
- **الخادم كان يسمّي الرسالة من قبل**: `sessions.list` مع `q` يملأ `match.message_id` من
  `store.findMatch` (أحدث رسالة في الجلسة تطابق النص؛ وتعليقه كان يقول «الأولى» فصُحّح). ويبقى
  `null` حين تطابق الجلسة بعنوانها فقط، فيُفتح الرابط عاديًّا.
- **المقتطف يُظهر الكلمة**: كان `snippet` أول ٣٠٠ حرف من الرسالة، فكلمة في وسط رسالة طويلة لا
  تظهر في النتيجة. صار `excerpt` (في `store.ts`): إن كانت المطابقة بعد الحرف ٨٠ يبدأ المقتطف قبلها
  بقليل عند حدّ كلمة وخلف «…»، وإلا فهو `preview` كما كان. والكلمة معلَّمة في النتيجة أيضًا.
- **الرابط**: `chat/anchor.ts` — `chatHref(id, message_id, q)` يعطي
  `/chat/<id>?m=<message id>&q=<الكلمة>` (من `routeOf('chat')`)، و`readAnchor` لا يقبل في `m`
  إلا ULID. نتائج الوكيل العام (`global_agent`) بقيت كما هي: صفحتها ليست هذه المحادثة.
- **الصفحات الأقدم**: المحادثة تُحمَّل بأحدث ١٠٠ رسالة فقط (`limit: 100`، ولا يوجد «تحميل الأقدم»
  في الواجهة). فتحٌ برسالة مرساة يطلب الصفحة السابقة (`before` = أقدم رسالة لديه، `limit: 200`)
  حتى تظهر المرساة أو ينتهي التاريخ أو تُستنفد ٢٥ صفحة (`pageBackUntil`) — قبل أول عرض، وفي كل
  إعادة مزامنة، فلا يختفي ما يقرؤه الشخص عند انقطاع الاتصال.
- **القفزة**: في `ChatScreen` بعد جاهزية المحادثة (`useLayoutEffect`، قبل الرسم) تُمرَّر الرسالة
  إلى منتصف الشاشة (`scrollIntoView({block: 'center'})`)، وتحمل `data-anchored` فتظهر حولها حلقة
  تتلاشى مرة واحدة (٢٫٤ ث)، وتحت «تقليل الحركة» تبقى الحلقة ثابتة بلا حركة. الكلمة تُعلَّم بـ
  `<mark class="msg-hit">` داخل تلك الرسالة وحدها: نصّ الشخص مباشرة، ورد الوكيل بإضافة rehype
  (`rehypeMarkQuery`) تعمل بعد تحويل Markdown وبعد تلوين الشيفرة ولا تقسم إلا عُقد النص، فلا تتغيّر
  القوائم أو الجداول أو كتل الشيفرة، وزرّ النسخ ينسخ النص نفسه. الألوان من الرموز
  (`--mj-color-focus`, `--mj-color-warning-soft`).
- **لا سحب إلى الأسفل**: `useFollowBottom` صار يقبل `hold`؛ ما دام الفتح مرسًى لا ينزل عند الفتح
  ولا مع التحميل ولا مع نموّ النص. يُفَكّ عندما يرسل الشخص رسالة، أو ينزل بنفسه إلى الأسفل
  (`onBottom`)، أو إذا لم تعد الرسالة موجودة (فيُفتح في الأسفل مع تنبيه
  `chat.anchor_missing`).
- **علّة قائمة ظهرت في الرحلة**: بعد الإرسال لم تكن المحادثة تلحق الرد أحيانًا. السبب في
  `followBottom.ts`: `toBottom` يضبط الموضع، وحدث التمرير الناتج يصل في الإطار التالي بعد أن كبرت
  الصفحة برسالة الوكيل الجديدة، فيُقرأ «ابتعد عن الأسفل» (سُجّل: `scroll pinned=false gap=147`) ثم
  لا يلحق شيئًا. الآن يُحفظ الموضع الذي وضعه `toBottom`، ولا يفكّ الالتصاق إلا تمريرٌ أعلى منه.
- **الرابط يُنظَّف بعد القفزة** (`replace`): المرساة حدثٌ حصل لا عنوان للمحادثة؛ إعادة التحميل تفتح
  في الأسفل كالعادة، و«رجوع» يعيد إلى البحث. المرساة نفسها تبقى في حالة الشاشة (فيبقى التعليم ما
  دامت المحادثة مفتوحة).
- الخريطة (Graphify) قبل التعديل: `graphify affected useFollowBottom` و`useSessionStream` —
  لا يستعملهما إلا `ChatScreen.tsx`؛ `matchRanges`/`highlightParts` يستعملهما `Combobox` ولم
  يتغيّرا (أُعيد استعمالهما فقط).
- موافقة: طلب المالك أعلاه. الدمج له.

## العقد
لا تغيير. `SessionMatch {message_id, snippet}` و`sessions.listMessages` مع `before` موجودان في
العقد؛ تغيّر فقط ما يختاره الخادم نصًّا للمقتطف.

## الملفات والتأثير
- الخادم: `sessions/store.ts` (`excerpt`، وتصحيح تعليق `findMatch`)، `sessions/service.ts`
  (المقتطف من `excerpt`)، `sessions/sessions-api.test.ts` (اختبار جديد).
- الويب: `chat/anchor.ts` (جديد)، `chat/ChatScreen.tsx`، `chat/useSessionStream.ts`،
  `chat/followBottom.ts`، `chat/MessageView.tsx` (`data-message-id` لكل رسالة، `anchored`/`mark`)،
  `chat/Markdown.tsx` (`mark`)، `screens/SearchScreen.tsx`، `styles/chat.css`، واللغتان
  (`chat.anchor_missing`).
- الاختبارات: `tests/search-jump.test.tsx` (جديد، ١١ اختبارًا)، والرحلة ٢١ في `e2e/smoke.spec.ts`،
  ولقطة `e2e/shots/search-jump-ar-light.png` (الوحيدة المضافة؛ باقي اللقطات أُعيدت إلى `main`).
- `graphify-out/` أُعيد بناؤها (`pnpm graph`).

## الفحوص
```
pnpm lint            → All matched files use Prettier code style!
pnpm typecheck       → نظيف
pnpm contracts:check-clients → check-clients  OK — 208 client file(s) scanned, 166 contract path(s) known.
pnpm i18n:check      → web: 792 keys, ar/en in parity · OK
pnpm nav:check       → OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
pnpm --filter @majlis/web test    → Test Files 32 passed (32) · Tests 402 passed (402)
pnpm --filter @majlis/server test → Test Files 64 passed | 4 skipped (68) · Tests 698 passed | 14 skipped (712)
pnpm --filter @majlis/web build   → ✓ built
PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test → 24 passed (1.5m)
pnpm graph:check     → (انظر أدناه)
```
- **الرحلة ٢١ تلتقط غياب التغيير**: بإرجاع `ChatScreen.tsx` وحده إلى `main` تسقط:
  `expect(locator).toBeInViewport() failed · Locator: getByTestId('message-user').filter({ hasText: 'الزعفران' }) · Received: viewport ratio 0`
  — المحادثة فُتحت في الأسفل والرسالة خارج الشاشة.
- **وبمعالج التمرير القديم** في `followBottom.ts` سقط آخر الرحلة (الإرسال بعد النزول):
  `Expected: < 80 · Received: 2314`.

## المخاطر والرجوع
- رسالة أقدم من ٥٠٠٠ رسالة إضافية (٢٥ صفحة × ٢٠٠) لا تُحمَّل: تظهر «الرسالة … لم تعد في هذه
  المحادثة» وتُفتح في الأسفل. لا توجد محادثة بهذا الطول اليوم.
- الكلمة المقسومة بتنسيق (`**زع**فران`) لا تُعلَّم؛ الرسالة نفسها تبقى مُبرَزة. والمطابقة في
  الواجهة `toLowerCase` كما في `Combobox`، وفي الخادم `lower()` في SQLite (حروف ASCII فقط) — لا
  فرق في العربية.
- تغيير `followBottom.ts` يمسّ كل محادثة: غُطّي بالرحلتين ٢٠ و٢١.
- الرجوع: الفرع وحده.

## التسليم والخطوة التالية
PR إلى `main`. الدمج للمالك. لم تُبنَ صورة ولم يُنشر شيء.
