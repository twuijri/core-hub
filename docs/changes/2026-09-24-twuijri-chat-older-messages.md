# تحميل الرسائل الأقدم، والأرشفة توقف العمل الجاري
المسؤول: twuijri · الفرع: feat/chat-older-messages · الحالة: review

## المشكلة والهدف
فجوتان في المحادثة (مهمة ليلة ٢٠٢٦-٠٩-٢٤ لإكمال الويب):

1. **المحادثة تُحمَّل بأحدث ١٠٠ رسالة فقط** (سجّلها `2026-09-23-twuijri-search-jump.md`): لا طريقة
   للرجوع إلى ما قبلها بالتمرير. الهدف: عند الاقتراب من أعلى المحادثة تُحمَّل الصفحة السابقة، وتبقى
   الرسالة التي في أعلى الشاشة في مكانها بالضبط (بلا قفزة)، مع سطر «جارٍ تحميل الرسائل الأقدم…»
   و«بداية المحادثة» عند البداية. ويعمل ذلك مع القفز من البحث إلى رسالة قديمة (تُحمَّل حولها)، ومع
   البثّ الحي في الأسفل (الردّ الذي ينمو لا يسحب من يقرأ التاريخ).
2. **الأرشفة لا توقف شيئًا**: `sessions.update`/`sessions.bulkUpdate` مع `archived: true` كانت
   تكتب العلامة فقط؛ الوكيل يستمر في العمل (والصرف) في محادثة أخفاها الشخص، والمهمة التي كانت
   المحادثة لتشغيلها تبقى `running` على اللوحة. تحقّقتُ على `main` قبل أي تغيير: الاختبار الجديد
   `session-archive-runs.test.ts` يسقط ٣ من ٤ (`expected [] to include '<run id>'`؛ الرابع — أرشفة
   محادثة خاملة — هو الضابط).

## القرار والموافقات
- **الخادم — الأرشفة توقف التشغيلات**: `update` صار غير متزامن، ومع `archived: true` يستدعي
  `stopLiveRuns`: كل تشغيل حيّ يُلغى بـ`cancelRun` نفسه الذي يستعمله زر الإيقاف في المحادثة —
  المنتظِر في الطابور يُلغى قبل أن يبدأ، والجاري يُقاطَع وينتهي `cancelled` بحدثه `run.cancelled`.
  **المنتظِرة أولًا**، وإلا لأعطى انتهاءُ الجاري المحوِّلَ التاليَ في الطابور. `bulkUpdate` يمرّ على
  الجلسات واحدة بعد أخرى بالطريقة نفسها. الإلغاء من الأرشيف (`archived: false`) لا يبدأ شيئًا.
- **المهمة**: لا تغيير في وحدة `tasks`. متابعة التشغيل الموجودة تعامل الإلغاء كما وصف
  `2026-09-24-twuijri-task-runs.md` («`cancelled` من المحادثة ← `ready` وتبقى مُسندة»)، والاختبار
  يثبت ذلك عبر الوحدتين.
- **الخادم — مؤشّر الصفحات**: العقد فيه `before` و`has_more` أصلًا، والتقسيم مفتاحي على `seq`. لكن
  `before` لرسالة من محادثة أخرى (أو غير موجودة) كان **يُتجاهل** فيُعاد أحدث صفحة، فيأخذ العميل
  رسائل عنده على أنها أقدم. صار يُجاب `404 not_found` (`details.resource = message`).
- **الويب**:
  - `ChatState` فيه `hasOlder` (من `has_more`) و`pagedBack`، و`prependOlder` يضمّ الصفحة الأقدم
    بلا تكرار، ولا يأخذ `has_more` إلا من صفحة تصل فعلًا إلى ما قبل المحفوظ.
  - `olderMessages.ts` (جديد): `useLoadOlderOnScroll` يطلب الصفحة (١٠٠ رسالة) حين يقترب سطر
    الأعلى إلى ٦٠٠ بكسل من الشاشة — **التمرير وحده يطلب**، فالفتح في الأسفل لا يحمّل شيئًا، إلا
    محادثة أقصر من الشاشة فتطلب فورًا. بعد وصول صفحة يُعاد الفحص (سحب سريع إلى الأعلى يستمر)،
    والفشل لا يُعاد تلقائيًا بل بزر «إعادة المحاولة» في السطر.
  - `keepPlace`: قبل الإضافة تُقاس الرسالة الأولى الظاهرة في أعلى الشاشة، ثم تُطبَّق الإضافة
    بـ`flushSync` (لا رسم بينهما)، ثم يُصحَّح `scrollTop` بمقدار ما تحرّكت. القياس قبل وبعد يجعله لا
    يتعارض مع تثبيت التمرير الذي يفعله المتصفح نفسه.
  - **علّة كانت ستظهر**: `ChatScreen` كان يستدعي `follow()` كلما تغيّر **عدد** الرسائل وكانت الأخيرة
    للشخص؛ إضافة صفحة أقدم تغيّر العدد فكانت ستسحب القارئ إلى الأسفل. صار المفتاح معرّف الرسالة
    الأخيرة لا العدد.
  - **القفز من البحث**: `pageBackUntil` يعيد `{items, has_more, pages}`، وإذا وقعت المرساة ضمن أول
    ٢٠ رسالة مما حُمِّل يجلب صفحة إضافية قبلها (`AROUND`)، فتُفتح والتاريخ على جانبيها. ولا يبدأ
    التحميل بالتمرير قبل أن تتمّ القفزة.
  - **إعادة المزامنة** (`resync` بعد انقطاع مقطوع الإعادة) تحفظ ما رجع إليه الشخص: تمشي إلى أقدم
    رسالة محفوظة بدل أن تعيد المحادثة إلى آخر ١٠٠.
  - السطر في أعلى المحادثة بارتفاع ثابت في كل حالاته (`.chat-older`)، ونصوصه بالعربية والإنجليزية.
- الخريطة (Graphify): `useFollowBottom` و`useSessionStream` و`pageBackUntil` لا يستعملها إلا
  `ChatScreen` والاختبارات.

### قرارات للمالك (مقترحة — للتأكيد)
1. **أرشفة محادثة توقف كل تشغيلاتها الحيّة، بما فيها المنتظِرة في الطابور** (زرّ الإيقاف في
   المحادثة يوقف الجاري فقط). السبب: المؤرشَف مُخفًى، وتشغيل ينتظر فيه سيعمل دون أن يراه أحد.
2. **«بداية المحادثة» لا تظهر إلا بعد رجوع فعلي إلى صفحات أقدم** (أو قفزة جلبت صفحات)، لا في كل
   محادثة قصيرة، كي لا يُضاف سطر فوق كل محادثة من رسالتين.
3. `before` غريب عن المحادثة صار `404` بدل أحدث صفحة (قرار العقد §30).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `sessions.update` و`sessions.bulkUpdate`: وصف يقول إن `archived: true` يوقف كل تشغيل حيّ كما
  يفعل `sessions.cancelRun`، وأُضيف `run.cancelled` إلى `x-rt-events` في كليهما.
- `sessions.listMessages`: وصف التقسيم المفتاحي، و`404` لمؤشّر ليس رسالة في هذه المحادثة (الرمز
  `404` كان معلنًا).
- `docs/contracts/DECISIONS.md` §30. لا عملية ولا حدث جديد؛ العملاء المولَّدون أعيد توليدهم
  (`generate:ts`) بلا ملفات مُودَعة.

## الملفات والتأثير
- الخادم: `modules/sessions/service.ts` (`update`/`bulkUpdate` غير متزامنين، `stopLiveRuns`،
  `404` للمؤشّر)، `modules/sessions/store.ts` (المؤشّر محصور في جلسته).
- اختبارات الخادم (جديدة): `tests/unit/session-archive-runs.test.ts` (٤)،
  `tests/unit/session-history.test.ts` (٣).
- الويب: `chat/olderMessages.ts` (جديد)، `chat/transcript.ts`، `chat/useSessionStream.ts`،
  `chat/anchor.ts`، `chat/followBottom.ts` (تصدير `scrollParent`)، `chat/ChatScreen.tsx`،
  `styles/chat.css`، `i18n/{ar,en}.json` (`chat.older_loading`, `chat.older_start`,
  `chat.older_failed`).
- اختبارات الويب: `tests/older-messages.test.tsx` (جديد)، `tests/search-jump.test.tsx` (الشكل الجديد
  لـ`pageBackUntil` واختبار «حولها»).
- Playwright: `e2e/zzz-chat-history.spec.ts` (جديد، الرحلات ٢٤ و٢٥ و٢٦)، `e2e/hub.ts` (تحكّم
  اختباري `/__e2e/seed-messages` يكتب تاريخًا طويلًا في المخزن، وسيناريو «حتى أوقفك» لا ينتهي إلا
  بمقاطعة)، ولقطتان جديدتان: `chat-older-ar-light.png`، `chat-older-start-ar-light.png`. باقي
  اللقطات أُعيدت إلى `main`.
- `docs/STATUS.md`: صفّ الجلسات وفقرة الويب.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck            -> exit 0
$ pnpm contracts:lint       -> contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 227 client file(s) scanned, 166 contract path(s) known.
$ pnpm i18n:check           -> web: 841 keys, ar/en in parity ... i18n:check  OK
$ pnpm nav:check            -> nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/server test
 Test Files  77 passed | 7 skipped (84)
      Tests  799 passed | 19 skipped (818)
$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  254 passed (254)
$ pnpm --filter @majlis/web test
 Test Files  39 passed (39)
      Tests  496 passed (496)
$ pnpm build                -> exit 0 (✓ built)
$ PLAYWRIGHT_CHANNEL=chrome npx playwright test e2e/zzz-chat-history.spec.ts
  ✓  24 ... scrolling up pages back through history and keeps the reader’s place (10.9s)
  ✓  25 ... a search result deep in history opens there, with history on both sides
  ✓  26 ... archiving several conversations at once stops a running chat and a running task (3.4s)

# الاختبارات الجديدة تسقط بلا التغيير:
# الخادم على main (service.ts/store.ts مخبّآن):
session-archive-runs.test.ts  Tests  3 failed | 1 passed (4)   # الناجح: أرشفة محادثة خاملة
  AssertionError: expected [] to include '01M38NPVXBQ0WM2GXHB3HFJP26'
session-history.test.ts       Tests  1 failed | 2 passed (3)
  AssertionError: expected 200 to be 404
# الرحلة ٢٦ بخادم main:   Expected: "interrupted" — failed
# الرحلة ٢٤ بويب main:    Expected: "loading" · element(s) not found (لا سطر للرسائل الأقدم)
# الرحلة ٢٥ بويب main:    Expected: 1 · Received: 0 (الرسائل قبل المرساة لم تُحمَّل)
```
أول تشغيل لاختبارات الويب كاملة سقط بمهلات (`Test timed out in 5000ms`، `Timeout waiting for worker`)
والجهاز تحت حمل ١٦٦ من وكلاء آخرين؛ أُعيد فنجح كله (أعلاه).

الحزمة الكاملة بعد إعادة تشغيل الجهاز، تحت غلاف الذاكرة (`mj-run`، عامل Playwright واحد):
```
$ PLAYWRIGHT_CHANNEL=chrome mj-run pnpm web:e2e
  ✓  27 … 24. scrolling up pages back through history and keeps the reader’s place (10.5s)
  ✓  28 … 25. a search result deep in history opens there, with history on both sides (3.0s)
  ✓  29 … 26. archiving several conversations at once stops a running chat and a running task (4.0s)
  31 passed (2.1m)
```
اللقطات التي أعاد التشغيل رسمها أُعيدت إلى `main`؛ المضاف لقطتان فقط.

## المخاطر والرجوع
- `update` صار ينتظر المقاطعة (`requestInterrupt`) قبل أن يجيب: أرشفة محادثة تعمل أبطأ قليلًا
  بقدر ما يأخذ المحوِّل ليقبل المقاطعة (محوِّل يرفضها يُسجَّل تحذيرًا ولا يُفشل الأرشفة).
- محادثة من آلاف الرسائل تبقى كلها في الصفحة بعد الرجوع إليها (لا نافذة افتراضية)؛ ١٠٠ رسالة لكل
  صفحة. القفز من البحث محدود كما كان بـ٢٥ صفحة × ٢٠٠.
- رسالة حُذفت بين صفحتين تجعل المؤشّر `404`: يظهر «تعذّر تحميل الرسائل الأقدم» مع إعادة المحاولة؛
  إعادة فتح المحادثة تحلّها.
- لا يُوقف أرشيفُ **مهمة** (`tasks.bulkUpdateTasks`) تشغيلها — المهمة لا تُؤرشف إلا من `done`، فلا
  تشغيل لها حينها؛ خارج النطاق.
- الرجوع: الفرع وحده، بلا هجرة.

## التسليم والخطوة التالية
PR إلى `main` من `feat/chat-older-messages`. الدمج للمالك. لم تُبنَ صورة ولم يُنشر شيء.
