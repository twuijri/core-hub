# محادثات تيليجرام وواتساب في قائمة المحادثات (للقراءة فقط)
المسؤول: twuijri · الفرع: feat/channel-conversations (فوق feat/session-categories، طلب #121) · الحالة: review

## المشكلة والهدف
طلب #121 أضاف مجموعتي «تيليجرام» و«واتساب» في قائمة المحادثات، لكنهما تبقيان فارغتين: رسائل
القنوات يستقبلها `hermes gateway` ويحفظها في مخزن جلسات Hermes نفسه (`state.db` لكل بروفايل)،
ولا يصل منها شيء إلى جداول المركز. المطلوب:
- عقد أولًا: عملية تسرد محادثات القنوات لكل بروفايل (وعبر كل البروفايلات المسموحة كـADR 0016)،
  وعملية تقرأ رسائل محادثة واحدة.
- الخادم يقرؤها من Hermes في البروفايل الصحيح، مع ذاكرة قصيرة، ويحوّل الحقول: المنصة، اسم
  الطرف الآخر أو معرّفه، آخر رسالة ووقتها، عدد الرسائل. حيث لا يدير المركز Hermes: قائمة فارغة
  مع السبب. تحديث عند نشاط جديد، وإلا استطلاع كل ٣٠–٦٠ ثانية والقائمة مفتوحة.
- الويب: المجموعتان تمتلئان؛ فتح محادثة يعرض نصها للقراءة فقط بشكل شاشة المحادثة مع شريط
  «محادثة من تيليجرام — للقراءة فقط؛ الرد يكون من تيليجرام»؛ والبحث يشمل عناوينها.

## القرار والموافقات
المالك نائم؛ القرارات التالية **مقترحة — المالك يؤكد**، ومكتوبة في DECISIONS §55 (آخر رقم
مأخوذ §54: أخذه #121 وأخذه أيضًا #123 feat/voice — تعارض بينهما لا يخص هذا الطلب):
- **قراءة لا نسخ.** المحادثات تُقرأ من خادم Hermes الداخلي (`hermes serve`، ADR 0015) كما يقرؤها
  تطبيق Hermes المكتبي، ولا تُنسخ إلى جداول المركز. تحقّقتُ من المسارات في مصدر Hermes المثبّت
  (MIT، `v2026.9.14`، `hermes_cli/web_routers/sessions.py`): `GET /api/sessions?profile=&sources=&order=recent&limit≤100`،
  `GET /api/sessions/{id}`، `GET /api/sessions/{id}/messages` (أحدث ٥٠٠ افتراضًا، و`limit`/`order=latest`).
  الحقول من `hermes_state_common.py` (جدول `sessions`: `source`، `user_id`، `chat_id`،
  `chat_type`، `display_name`، `origin_json`، `title`، `message_count`، `started_at`) ومن
  `list_sessions_rich` (`last_active`، و`preview` = أول رسالة من الشخص)، و`display_name` هو اسم
  المحادثة كما تعطيه القناة (`gateway/session.py`: `display_name=source.chat_name`).
- **ليست `Session`.** مخططان جديدان `ChannelConversation` و`ChannelMessage`؛ لو كانت جلسات لوجب
  على كل عملية جلسة (تسمية، أرشفة، تشغيل، حذف) أن ترفضها.
- **للقراءة فقط.** لا شيء يُكتب إلى Hermes؛ الرد من القناة نفسها. في الويب يحل الشريط محل مربع
  الكتابة.
- **أي المصادر قنوات:** منصّات Hermes للمراسلة (`telegram`، `whatsapp` و`whatsapp_cloud` كـ
  `whatsapp`، `discord`، `slack`، `signal`، `matrix`، `mattermost`، `email`، `sms`، `dingtalk`،
  `feishu`، `wecom`، `weixin`، `bluebubbles`، `qqbot`). محادثات المركز نفسه تجري في Hermes عبر
  TUI فلا تظهر هنا ولا تُفتح بمعرّفها (`404`).
- **حتى ١٠٠ لكل بروفايل** (حد صفحة Hermes)، الأحدث أولًا، دون المؤرشفة عند Hermes؛ وتظهر في
  «النشطة» و«الكل» لا في «المؤرشفة».
- **حين تتعذّر القراءة القائمة تقول السبب** (`200` مع `unavailable[]` لكل بروفايل):
  `hermes_not_managed`، `profile_not_in_hermes`، `hermes_unreachable` (مع كلام Hermes، ويبقى
  ما قُرئ قبلًا معروضًا مع سطر «تعذّرت قراءة محادثات القنوات من Hermes الآن»). فتح محادثة حينها
  `503 service_unavailable`.
- **الذاكرة والتحديث:** Hermes لا يعلن شيئًا حين تصل رسالة قناة (`/api/events` عنده قناة دردشة
  لوحته فقط)، فلا حدث يُنتظر. الخادم يحفظ ما قرأه لكل بروفايل Hermes ولا يسأل مجددًا إلا إذا تغيّر
  حجم أو وقت `state.db`/`state.db-wal` لذلك البروفايل، وليس قبل ٥ ثوانٍ، وعلى الأكثر كل ٥ دقائق؛
  وبلا ملف للمقارنة كل ٢٠ ثانية. آخر رسالة لكل محادثة تُقرأ مرة لكل تغيّر (٢٠ في النداء على الأكثر،
  والبقية تعرض معاينة Hermes مؤقتًا). الويب يستطلع كل ٤٥ ثانية والقائمة ظاهرة والتبويب مرئي، وكل
  ٣٠ ثانية والنص مفتوح. النتيجة: استطلاع قائمة مفتوحة لا يكلّف Hermes شيئًا ما دام لا جديد، وخادمه
  يتوقف بعد دقائقه العشر الخاملة كما في ADR 0015 — أثبته الاختبار على Hermes الحقيقي.
- **العنوان في القائمة** هو الطرف الآخر (كما تسمّي تطبيقات المراسلة المحادثة)، ثم عنوان Hermes،
  ثم المعرّف، ثم «محادثة على تيليجرام». السطر تحته آخر رسالة («الوكيل: …» إن كانت من الوكيل).
- **العنوان في الويب:** المحادثة تُفتح في وجهة المحادثة نفسها `/chat/<معرّف Hermes>?source=channel&profile=…`
  — لا وجهة جديدة في `navigation.json`.
- **لم يُبنَ «متابعة في كور هب»** (الاختياري): يحتاج عملية جديدة تنشئ محادثة في المركز وتمرّر النص
  سياقًا لأول تشغيل، أو آلية لملء مسودة الكتابة لا يملكها المُلحِّن اليوم؛ ليس رخيصًا ولا محصورًا.
  مقترح خطوةً تالية.
- رُفض: حدث لحظي يغذّيه استطلاع في الخلفية على الخادم (حلقة لكل بروفايل ولو لم ينظر أحد)؛ قراءة
  `state.db` مباشرة (مخطط Hermes الخاص، وADR 0015 اختار ألا يعتمد عليه).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عمليتان جديدتان (وسم `sessions`):
  - `sessions.listChannelConversations` — `GET /channel-conversations` (`profiles=all`، `channel=`)
    → `{ items: ChannelConversation[], unavailable: ChannelConversationsUnavailable[] }`.
  - `sessions.listChannelMessages` — `GET /channel-conversations/{conversation_id}/messages`
    → `{ conversation, items: ChannelMessage[], has_more }`؛ `404` (`resource: channel_conversation`)
    و`503`.
- مخططات جديدة: `ChannelConversation`، `ChannelMessagePreview`، `ChannelMessage`،
  `ChannelConversationsUnavailable`. لا أحداث جديدة. DECISIONS §55.

## الملفات والتأثير
الخادم (`packages/server`):
- `modules/sessions/channel-conversations.ts` (جديد): المنفذ `ChannelSource`، القارئ
  `ChannelConversations` (التحويل، الذاكرة بالختم، آخر رسالة، أسباب الغياب، فتح محادثة).
- `modules/sessions/routes.ts`: المساران. `modules/sessions/index.ts`: قارئ لكل تطبيق، وتصدير المنفذ.
- `modules/index.ts`: `registerChannelSource` و`hermesChannelSourceOver` — خادم Hermes الداخلي +
  أي بروفايل Hermes هي مساحة العمل + ختم ملف المخزن. حيث لا يُدار Hermes لا مصدر.
- `modules/sessions/testing/scripted-channels.ts` (جديد): Hermes مُبرمَج يجيب كخادمه.
- اختبارات: `channel-conversations.test.ts` (القارئ والمسارات)، `channel-conversations.real.test.ts`
  (Hermes الحقيقي)، `tests/contract/channel-conversations.contract.test.ts`.

الويب (`packages/web`):
- `sessions/channels.ts` (جديد): الاستعلامان (مع الاستطلاع)، العنوان، الاسم، المعاينة، البحث.
- `sessions/groups.ts`: مجموعة القناة تحمل `conversations` أيضًا.
- `sessions/SessionList.tsx`: صف `ChannelRow` داخل مجموعة القناة (بلا سحب ولا قائمة)، العدّ،
  البحث، سطر «تعذّرت القراءة»، ولا شيء في «المؤرشفة».
- `chat/ChannelConversationView.tsx` (جديد) و`chat/ChatScreen.tsx` (تفرّع `?source=channel`).
- `i18n/{ar,en}.json`: خمسة مفاتيح تحت `sessions.channels`.
- `e2e/hub.ts`: Hermes مُبرمَج بمحادثة تيليجرام، مطفأ إلا حين تشغّله الرحلة (`/__e2e/channels`)
  حتى لا تتغيّر قوائم الرحلات الأخرى ولقطاتها. `e2e/zzzzzzzz-channel-conversations.spec.ts`
  (الرحلة ٣٣) ولقطتها `e2e/shots/channel-conversation-ar-light.png`.
- `tests/channel-conversations.test.tsx` (جديد).

الوثائق: `docs/contracts/DECISIONS.md` §55، `docs/domain/sessions.md`، `docs/STATUS.md`
(صف sessions ٣٤ من ٣٤، والعدد ٢١٢ من ٢٦٦).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، كلها عبر `mj-run`:

```
$ pnpm exec vitest run src/modules/sessions/channel-conversations.test.ts src/modules/sessions/categories.test.ts src/modules/sessions/sessions-api.test.ts tests/unit/status.test.ts   (packages/server)
 Test Files  4 passed (4)
      Tests  40 passed (40)

$ pnpm exec vitest run --project contract   (packages/server — ومنها الملف الجديد)
 Test Files  6 passed (6)
      Tests  280 passed (280)

$ COREHUB_HERMES_IMAGE=core-hub:channeldeps pnpm exec vitest run src/modules/sessions/channel-conversations.real.test.ts
   (Hermes Agent v0.21.3 (2026.9.14) — الإصدار المثبّت؛ صورة موجودة محليًا، لم تُبنَ صورة)
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  6.47s

$ pnpm exec vitest run tests/channel-conversations.test.tsx tests/session-categories.test.tsx tests/all-profiles.test.tsx tests/i18n.test.ts tests/logical-css.test.ts tests/navigation.parity.test.tsx tests/session-menu.test.tsx   (packages/web)
 Test Files  7 passed (7)
      Tests  222 passed (222)

$ pnpm build && COREHUB_E2E_PORT=8861 COREHUB_E2E_SETUP_PORT=8862 PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzzzz-channel-conversations.spec.ts
  ✓  1 [chromium] › e2e/zzzzzzzz-channel-conversations.spec.ts:31:1 › 33. a Telegram conversation shows under «تيليجرام» and opens read-only (791ms)
  1 passed (8.0s)
   (المنفذ 8791 كان مشغولًا بعامل آخر، فشُغّلت على منفذين آخرين)

$ pnpm typecheck               → exit 0
$ pnpm lint                    → All matched files use Prettier code style! (exit 0)
$ pnpm i18n:check              → i18n:check  web: 1344 keys, ar/en in parity … OK
$ pnpm nav:check               → nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contracts:check-clients → check-clients  OK — 289 client file(s) scanned, 178 contract path(s) known.
$ pnpm contracts:lint          → Your API description is valid. … contracts:lint  OK
```

ما يثبته اختبار Hermes الحقيقي: محادثات تُكتب بكود Hermes نفسه (`SessionDB.create_session`
بمصدر `telegram`/`whatsapp` وهوية القناة، ثم رسائل بينها نداء أداة ونتيجته، ومحادثة `tui`)،
في `default` وفي بروفايل `designer` أنشأه `hermes profile create`؛ `hermes serve` يشغّله
`HermesDashboard` الحقيقي؛ فيرى القارئ بالمصدر نفسه الذي يركّبه `modules/index.ts`: القناتين فقط،
كلًّا في بروفايلها، الاسم والمعرّف ونوع المحادثة وآخر رسالة، والنص بلا أدوات، و`404` لمحادثة
TUI ولمحادثة بروفايل آخر؛ ثم لا نداء جديدًا لقائمة لم يتغيّر مخزنها، ونداء واحد بعد رسالة جديدة
تظهر آخرَ رسالة.

الاختبارات الجديدة تفشل على الكود القديم: العمليتان والمخططات لم تكن موجودة، ومجموعة القناة لم
تكن تحمل غير جلسات المركز.

CI على GitHub (طلب الدمج #126، الالتزام `f74c550`) — كله أخضر من الدفعة الأولى:

```
Docker image builds and answers /health — pass (2m30s)
Lint, typecheck, contracts, tests, build — pass (13m49s)
PR adds or updates a change record — pass (11s)
PR leaves graphify-out/ to the code-map bot — pass (9s)
Web smoke journeys (Playwright against the real hub) — pass (5m25s)
db:generate + db:migrate (SQLite and PostgreSQL) — pass (53s)
```

الدفعة التالية تضيف هذا الدليل إلى السجل فقط.

## المخاطر والرجوع
- **خادم Hermes الداخلي يعمل ما دامت القائمة تُستطلع ومخزن Hermes يتغيّر** (~١٣٠–١٧٠ م.ب، ADR 0015).
  حين لا جديد لا نداء، فيتوقف بعد عشر دقائق خاملة. لكن محادثات المركز نفسها تكتب إلى `state.db`
  نفسه (تجري في Hermes)، فتشغيل محادثة في المركز والقائمة مفتوحة يُعيد القراءة كل ٥ ثوانٍ على الأكثر
  أثناء التشغيل (قراءة واحدة لكل استطلاع ٤٥ ثانية فعليًا).
- `limit=100` لكل بروفايل: الأقدم من ذلك لا يظهر (لا ترقيم صفحات بعد).
- حين يعيد Hermes تسمية حقوله (`display_name`، `last_active`…) يظهر ذلك في الاختبار الحقيقي عند
  ترقية Hermes، لا في CI العادي (يتخطّاه بلا صورة).
- يلمس `SessionList.tsx` و`groups.ts` من #121؛ لذلك الطلب مكدّس عليه.
- الرجوع: إرجاع الالتزامات؛ لا جداول ولا ترحيلات ولا كتابة إلى Hermes، فلا أثر يبقى.

## التسليم والخطوة التالية
- طلب دمج مكدّس فوق #121 (القاعدة `feat/session-categories`)؛ المالك يؤكد قرارات §55.
- مقترح تالٍ: «متابعة في كور هب» — عملية `POST /channel-conversations/{id}/continue` تنشئ محادثة
  في المركز مع الوكيل، وتمرّر نص المحادثة سياقًا لأول تشغيل (لا نسخ رسائل تبدو كأنها جرت هنا).
- لاحقًا: ترقيم صفحات لأكثر من ١٠٠ محادثة، وعرض المرفقات (صور تيليجرام) إن احتاجها المالك.
