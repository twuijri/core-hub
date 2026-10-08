# محادثات القنوات في الاتجاهين: المشرف يكتب في محادثة تيليجرام أو واتساب من كور هب (المرحلة 1)
المسؤول: twuijri · الفرع: feat/two-way-channels · الحالة: review

## المشكلة والهدف
محادثات تيليجرام وواتساب تظهر في كور هب للقراءة فقط (DECISIONS §61): المالك يرى المحادثة ولا
يستطيع أن يكتب فيها من المركز، والقائمة تُسأل كل 30–45 ثانية لأن المركز لا يسمع بوصول الرسائل.

الهدف (قرارات المالك 2026-10-08، موافَق عليها):
1. المالك يكتب من المركز في **أي** محادثة قناة (محادثته مع البوت، محادثة مع شخص آخر، مجموعة)،
   والرسالة على القناة توضّح أنها من مستخدم المركز: «من كور هب (<الاسم>): <النص>».
2. الكتابة للمشرفين فقط؛ غيرهم يبقى لهم العرض للقراءة.
3. البادئة نص قابل للترجمة بلغة المركز إن وُجدت، وإلا العربية كما كتبها المالك.
4. الترتيب: تُنشر الرسالة على القناة أولًا؛ إن فشل النشر لا تصل إلى الوكيل ويظهر خطأ للمستخدم.
5. النسخة الأولى: تيليجرام وواتساب (الجسر الذي يشغّله المركز) فقط؛ بقية المنصات للقراءة مع السبب.
6. المحادثة **تبقى** محادثة تيليجرام/واتساب في المركز (المجموعة نفسها والعلامة نفسها والشاشة
   نفسها)، ولا تتحول إلى محادثة مركز. «أكمل في كور هب» يبقى إجراءً منفصلًا.
7. الرد يظهر حين ينتهي دور الوكيل (بلا بث حرفًا بحرف في هذه النسخة).
8. حدث لحظي من الخطاف يحل محل الاستطلاع كل 30–45 ثانية، ويبقى الاستطلاع احتياطًا بطيئًا.

المرحلة 1 = إضافة Hermes الخاصة بالمركز + الخادم + العقد + الويب. الجوالات في المرحلة 2 على العقد
نفسه.

## القرار والموافقات
- القرارات الثمانية أعلاه للمالك (2026-10-08). التصميم من البحث
  (`/home/twuijri/research/hermes-two-way-channels.md`) مع تعديلات سببها الكود، وكلها في
  `docs/contracts/DECISIONS.md` §153 (أول رقم متاح بعد §152؛ طلبات الدمج المفتوحة #228 و#230 بحث
  ولا تمس DECISIONS):
  - **إضافة Hermes باسم `corehub-bridge`** في `plugins/` لكل بيت Hermes يشغّله المركز (الجذر وكل
    بروفايل مسمّى)، تُكتب قبل تشغيل كل بوابة وعند الإقلاع، وتُفعَّل في `config.yaml` بلمس ثلاثة
    مفاتيح فقط (`plugins.enabled` و`plugins.disabled` و`plugins.entries.corehub-bridge.allow_gateway_injection: true`).
    على مجلد Hermes نفسه: بلا تغيير في Compose ولا مجلدات ولا PATH.
  - **تقارير الأدوار من خطافات الإضافة نفسها** (`pre_llm_call` و`on_session_end`) لا من خطاف
    `hooks/corehub/`: ذلك الخطاف لا يُكتب إلا حين تكون أدوات المركز مفعّلة للبروفايل، والحدث اللحظي
    يجب أن يعمل دائمًا. ثبت في Hermes الحقيقي أن الخطافات تُطلق للأدوار المحقونة وللبروفايلات
    المسمّاة (كل نسخة في بيت بروفايلها).
  - **مفتاح لكل بيت** في `hub.json` بجانب الإضافة (0600)، لا مفتاح أدوات المركز (`hub_mcp_…`) لأنه
    لا يوجد إلا مع تفعيل الأدوات؛ المفتاح يحدد البروفايل، والمركز يقرؤه عند الإقلاع فتبقى البوابة
    العاملة تعمل بعد إعادة تشغيل المركز.
  - البادئة: لا يوجد في المركز إعداد لغة عام، فهي بالعربية كما كتبها المالك
    (`sessions.channel_send.prefix` بالعربية والإنجليزية، والإنجليزية للتعرّف على الرسالة عند
    قراءتها).
- لا يُستخدم `hermes send` / `send_message` للنشر على القناة: يكتبان الرسالة في المحادثة كرسالة
  **الوكيل**، فيقرأ الوكيل الكلمات مرتين.
- لا كسر (ADR 0027): كل ما أُضيف اختياري في الردود، وعملية جديدة، وحدث جديد. `pnpm contracts:compat`
  ناجح.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
إضافات فقط، والتفاصيل في DECISIONS §153:

- عملية جديدة **`sessions.sendChannelMessage`**: `POST /channel-conversations/{conversation_id}/messages`
  (`x-roles: [owner, admin]`)، الجسم `ChannelSendRequest {text (1–4000), client_message_id?}`،
  الرد `202 {outgoing: ChannelOutgoing}`. الأخطاء: `403` (`not_admin`)، `404`، `409 state_invalid`
  (`details.reason`: `platform_unsupported` | `not_current` مع `details.current_id` | `no_route`)،
  `503 service_unavailable` (`hermes_not_managed` | `bridge_offline` | `channel_send_failed` مع
  `details.message` بكلمات المنصة)، `400`.
- `ChannelConversation`: `can_send?: boolean`، `send_unavailable?: ChannelSendUnavailable | null`،
  `current_id?: string | null`.
- `ChannelSendUnavailable` (جديد): `not_admin`، `platform_unsupported`، `hermes_not_managed`،
  `bridge_offline`، `not_current`، `no_route`.
- `ChannelMessage`: `origin?: 'channel' | 'hub'`، `author_name?: string | null`.
- `ChannelOutgoing` (جديد): `id`، `conversation_id`، `client_message_id`، `text`، `author_name`،
  `status` (`posted` | `delivered` | `answering` | `answered` | `failed`)، `error`
  (`ChannelSendFailure {reason: bridge_no_answer | not_accepted | not_picked_up, message}` أو `null`)،
  `message_id`، `session_id`، `created_at`، `updated_at`.
- رد `sessions.listChannelMessages`: `outgoing?: ChannelOutgoing[]` (الصفحة الأحدث فقط) و
  `live_updates?: boolean`. رد `sessions.listChannelConversations`: `live_updates?: boolean`.
- حدث لحظي جديد **`channel_conversation.updated`** على `/rt/sessions` (على مستوى البروفايل):
  `{conversation_id, channel, reason: turn_started | turn_ended | outgoing, outgoing: ChannelOutgoing | null}`
  (`events/sessions/channel_conversation.updated.schema.json`، وصف في `events/README.md`).
- ثلاث عمليات ليست للعملاء، تستدعيها الإضافة داخل بوابة Hermes بمفتاحها:
  `agents.channelBridgeOutbox` (`GET /hub-mcp/channel-bridge/outbox?wait=0..25`)،
  `agents.channelBridgeAck` (`POST /hub-mcp/channel-bridge/outbox/{item_id}/ack`)،
  `agents.channelBridgeEvent` (`POST /hub-mcp/channel-bridge/events`)، والمخططات
  `ChannelBridgeItem` و`ChannelBridgeAck` و`ChannelBridgeEvent`.

ما على الجوالات تنفيذه في المرحلة 2: قراءة `can_send` / `send_unavailable` / `current_id` (وإخفاء
الإرسال إن غابت = مركز أقدم)، و`ChannelMessage.origin` / `author_name` لرسم رسالة المركز باسم
كاتبها، والإرسال بـ`sendChannelMessage` مع عرض فوري ثم حالة `ChannelOutgoing`، والاستماع لـ
`channel_conversation.updated` (إعادة قراءة المحادثة والقائمة، وتحديث `outgoing`)، وتخفيف الاستطلاع
حين `live_updates: true`، والنصوص بكل اللغات.

## الملفات والتأثير
العقد:
- `packages/contracts/openapi.yaml`، `packages/contracts/events/sessions/channel_conversation.updated.schema.json` (جديد)،
  `packages/contracts/events/README.md`.

الخادم — `agents`:
- `packages/server/src/modules/agents/channel-bridge/plugin.ts` (جديد): نص الإضافة (بايثون، مكتبة
  قياسية فقط)، وكتابتها في البيت، وتفعيلها في `config.yaml` دون لمس غيرها، ورفض كتابة ملف لا يُقرأ.
- `.../channel-bridge/bridge.ts` (جديد): المفاتيح لكل بيت، صندوق الصادر والاستطلاع الطويل، أي بوابة
  تخدم أي بروفايل (الجذر للكل مع بوابة واحدة لكل جهاز، وكل بروفايل لنفسه قبلها)، والإقرارات وتقارير
  الأدوار، و«هل البوابة متصلة».
- `.../channel-bridge/mirror.ts` و`telegram.ts` (جديدان): النشر على تيليجرام (أجزاء ≤ 4096، داخل
  موضوع المنتدى، دون أن يظهر رمز البوت في خطأ) وعلى جسر واتساب (`POST /send`).
- `.../channel-bridge/routes.ts` (جديد): العمليات الثلاث.
- `packages/server/src/modules/agents/index.ts`: الجسر في سياق الوحدة، يُكتب في `prepareGateway`
  وعند `onReady`/`onListen`، `channelBridgePortFor`، `registerChannelBridgeListener`،
  `channelBridgeFor`، ومنفذ اختبار `channelBridgeRoot`.

الخادم — `sessions`:
- `.../sessions/channel-sends.ts` (جديد): تسلسل الإرسال (التحقق، ثم النشر، ثم التسليم للإضافة)،
  ومتابعة الرسالة وحالاتها ومهلها، وإعلان كل دور على القنوات.
- `.../sessions/channel-conversations.ts`: `session_key` في صف Hermes، التعرّف على رسالة المركز
  (`internal_notification` + البادئة)، `routeOf` (المحادثة الأحدث للمحادثة نفسها)، `route()` للإرسال،
  `can_send` عند معرفة السائل، `invalidate()`، وحذف ملاحظة Hermes «Gateway message origin …» من
  كلمات رسالة قطعت دورًا جاريًا.
- `.../sessions/routes.ts`: `POST /channel-conversations/{id}/messages` (مشرفون فقط، مُسجَّل في
  السجل)، و`can_send` و`live_updates` و`outgoing` في القراءة.
- `.../sessions/index.ts`، `.../sessions/realtime.ts`: إنشاء المتابِع لكل تطبيق، ومستمع الجسر، واسم
  الحدث.
- `packages/server/src/modules/index.ts` (جذر التركيب): `registerChannelSender` (الجسر + أسماء
  الأشخاص + البروفايلات) و`registerChannelBridgeListener`.
- `packages/server/src/i18n/{ar,en}.json`: `sessions.channel_send.prefix`.

الويب:
- `packages/web/src/chat/ChannelComposer.tsx` (جديد): خانة الكتابة بشكل خانة المحادثة، Enter يرسل،
  الخطأ بكلمات واضحة والنص يعود إلى الخانة.
- `packages/web/src/chat/ChannelConversationView.tsx`: الخانة للمشرف حين `can_send`، وإلا السبب
  (ومركز أقدم أو مركز لا يشغّل Hermes يرى الشريط القديم كما هو)، وزر «افتح المحادثة الحالية» لـ
  `not_current`، ورسالة المركز باسم كاتبها «… · من كور هب» وتحتها حالتها، وعرض فوري قبل رد الخادم.
  العلامة والمجموعة و«أكمل في كور هب» كما هي.
- `packages/web/src/sessions/channels.ts`: `useSendChannelMessage`، `useChannelUpdates`
  (الحدث اللحظي)، `applyChannelUpdate`، واستطلاع احتياطي كل 5 دقائق للقائمة ودقيقتين للمحادثة حين
  `live_updates`.
- `packages/web/src/i18n/{ar,en}.json`: `sessions.channels.send.*`.

الوثائق: `docs/contracts/DECISIONS.md` §153، `docs/STATUS.md` (381 من 381)،
`docs/contracts/COVERAGE.md`.

الاختبارات:
- `packages/server/src/modules/agents/channel-bridge/channel-bridge.test.ts` (جديد): ملفات الإضافة
  والمفتاح، تفعيلها دون لمس إعدادات الشخص وتعليقاته، عدم كتابة ملف لا يُقرأ، صحة البايثون،
  المصادقة بالمفتاح، توزيع العناصر حسب طوبولوجيا البوابات، الاستطلاع الطويل، الإقرار مرة واحدة،
  النشر على تيليجرام وواتساب ورفضهما.
- `packages/server/src/modules/sessions/channel-sends.test.ts` (جديد): البادئة والتعرّف عليها، النشر
  قبل التسليم، **فشل النشر = لا تسليم**، أسباب الرفض قبل النشر، `can_send`، الحالات حتى
  `answered`، الفشل بأسبابه الثلاثة، الانتظار خلف دور جارٍ، ثم المسارات عبر مركز كامل مع البروتوكول
  عبر HTTP كما تستدعيه الإضافة (عضو ← 403، مفتاح خاطئ ← 401، الموضوع في تيليجرام، `not_current`).
- `packages/server/src/modules/sessions/channel-sends.real.test.ts` (جديد): Hermes الحقيقي (انظر
  الفحوص).
- `packages/server/tests/contract/channel-conversations.contract.test.ts`: `sendChannelMessage`
  بكل حالاته مقابل مخطط العقد.
- `packages/web/tests/channel-send.test.tsx` (جديد).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ COREHUB_HERMES_IMAGE=core-hub:twoway-pinned (Hermes v0.21.5) vitest run --project unit --maxWorkers=1 src/modules/sessions/channel-sends.real.test.ts
 ✓ hears a Telegram turn as it happens, without polling
 ✓ posts on Telegram first, then the agent answers there in the same conversation
 ✓ does not hand anything to the agent when Telegram refuses the post
 ✓ reaches a named profile's conversation
 ✓ records what Hermes does with a channel message during the hub’s turn
 Test Files  1 passed (1)
      Tests  5 passed (5)

$ COREHUB_HERMES_IMAGE=core-hub:morechannels (Hermes v0.21.3، الحد الأدنى) نفس الأمر
 ✓ (الخمسة نفسها)
 Test Files  1 passed (1)
      Tests  5 passed (5)

[two-way mid-turn] Hermes 0.21.5 و0.21.3 (النتيجة نفسها):
replies after the channel message: ["↪ Redirected current run. I'll adjust using your correction.","echo: [Context from the interrupted assistant response]"]
statuses: ["posted","delivered","answering","answered"]
last transcript items: [["assistant","channel","echo: من كور هب (Admin): ما آخر الأخبار؟"],["user","hub","SLOW question from the hub"],["user","channel","a message typed on Telegram meanwhile"],["assistant","channel","echo: [Context from the interrupted assistant response]"]]

$ COREHUB_HERMES_IMAGE=core-hub:twoway-pinned vitest run --maxWorkers=1 tests/unit/gateways.real.test.ts tests/unit/channels.real.test.ts tests/unit/telegram.real.test.ts src/modules/agents/hub-tools/channel-identity.real.test.ts src/modules/sessions/channel-conversations.real.test.ts
 Test Files  5 passed (5)
      Tests  13 passed | 1 skipped (14)

$ vitest run --project unit --maxWorkers=2 src/modules/agents
 Test Files  68 passed | 23 skipped (91)
      Tests  833 passed | 86 skipped (919)

$ vitest run --project unit --maxWorkers=2 src/modules/sessions tests/unit/channels.real.test.ts tests/unit/gateways.real.test.ts tests/unit/realtime-auth.test.ts tests/unit/sockets.test.ts tests/unit/webhook-events.test.ts tests/unit/hermes-webhooks.test.ts
 Test Files  33 passed | 4 skipped (37)
      Tests  263 passed | 15 skipped (278)

$ vitest run --project unit --maxWorkers=2 tests/unit/status.test.ts
      Tests  1 passed (1)

$ vitest run --project contract --maxWorkers=2 tests/contract/channel-conversations.contract.test.ts tests/contract/contract.test.ts
 Test Files  2 passed (2)

$ pnpm --filter @corehub/web exec vitest run --maxWorkers=2 tests/i18n.test.ts tests/logical-css.test.ts tests/lucide-icons.test.tsx tests/latin-digits.test.ts tests/navigation.parity.test.tsx tests/channel-send.test.tsx tests/channel-conversations.test.tsx tests/channel-continue.test.tsx tests/message-layout.test.tsx tests/composer.test.tsx
 Test Files  10 passed (10)
      Tests  411 passed (411)

$ PLAYWRIGHT_CHANNEL=chrome npx playwright test e2e/zzzzzzzz-channel-conversations.spec.ts --workers=1   (بعد pnpm build)
  ✓  33. a Telegram conversation shows under «تيليجرام» and opens read-only
  ✓  33b. a Telegram conversation is hidden from one’s list and shown again; deleting asks first
  2 passed (12.9s)

$ pnpm --filter @corehub/contracts exec vitest run --maxWorkers=2
 Test Files  11 passed (11)
      Tests  129 passed (129)

$ pnpm contracts:lint
contracts:lint  validating 98 event schema file(s)
contracts:lint  OK

$ pnpm contracts:generate   (مع Java 21 محمولة لتوليد Kotlin وSwift)
contracts:generate:native  kotlin: explicit nulls in 95 request model(s)
contracts:generate:native  swift: explicit nulls in 86 request model(s)
contracts:generate:native  OK

$ pnpm contracts:compat
contracts:compat  OK — no breaking change against v1.1.7

$ pnpm contracts:check-clients
check-clients  OK — 1168 client file(s) scanned, 277 contract path(s) known.

$ pnpm typecheck
EXIT 0

$ pnpm i18n:check
i18n:check  server: 247 keys, ar/en in parity
i18n:check  web: 3702 keys, ar/en in parity
i18n:check  OK

$ npx eslint <الملفات المعدّلة> ; npx prettier --check <المجلدات المعدّلة>
(eslint بلا مخرجات، EXIT 0) · All matched files use Prettier code style!

$ node scripts/check-change-record.mjs --base origin/main
change-record  OK — 1 record(s) valid
```
لم تُشغَّل محليًا: الأجنحة الكاملة (CI يشغّلها)، وكل أجنحة Hermes الحقيقي الأخرى، وصورة المركز
كاملة في حاوية واحدة (الاختبار الحقيقي يشغّل البوابة في الحاوية والمركز على الجهاز). واتساب: مسار
`/send` مُثبت مقابل جسر مزيّف فقط، لا مقابل جسر Baileys الحقيقي مع رقم حقيقي.

ما بقي غير مُثبت:
- واتساب الحقيقي (الجسر وحسابه): النشر عبر `/send` ثم الحقن. الحقن نفسه لا يعتمد على المنصة، لكن
  لم يُجرَّب على محادثة واتساب حقيقية.
- مركز يُعاد تشغيله وبوابته تعمل: المفتاح يُقرأ من `hub.json` فيعمل الاستطلاع، لكن العناصر غير
  المسلَّمة تضيع (تظهر `bridge_no_answer` لمن انتظرها) — مُصمَّم، غير مجرَّب على Hermes حقيقي.
- السلوك عند وصول رسالة القناة أثناء دور المركز: **مُثبت ومسجَّل** (Hermes يعيد توجيه الدور ويرد على
  الاثنين معًا)، لكنه ليس مؤكَّدًا في الاختبار بل مطبوعًا، حتى لا يفشل الجناح إن غيّر Hermes سلوكه.

## المخاطر والرجوع
- الإضافة تعمل داخل عملية بوابة Hermes (ليست صندوقًا معزولًا): مكتبة قياسية فقط، الاستدعاءات في
  خيوط جانبية فلا تؤخر دورًا، وكل خطأ يُبلع. خيط الاستطلاع يعمل فقط في نسخة البيت التي تملك
  الحاقن، والنسخ الأخرى تنتظر بلا عمل.
- النشر والحقن ليسا ذرّيين: قد تظهر الرسالة على القناة ثم لا يأخذها Hermes (البوابة توقفت، الصلاحية
  تغيّرت) — يقول المركز ذلك صراحة (`bridge_no_answer` / `not_accepted` / `not_picked_up`)،
  وإعادة الإرسال تنشرها مرة أخرى.
- رسالة من القناة أثناء دور المركز تعيد توجيهه (سلوك Hermes الافتراضي، كرسالتين متتاليتين من
  القناة).
- في وضع المحادثة الذاتية في واتساب يضع الجسر عنوان الوكيل قبل كل ما يرسله، ومنه رسالة المركز.
- المفتاح في `hub.json` (0600) داخل بيت Hermes: من يقرأ البيت يقرأ `.env` أصلًا.
- `plugins.enabled` غائب في `config.yaml` قديم: يُنشأ بالإضافة وحدها؛ إن كان لدى الشخص إضافات قديمة
  ثُبّتت قبل قائمة التفعيل فلن يفعّلها Hermes تلقائيًا بعدها (حالة نادرة في بيوت يديرها المركز).
- الرجوع: revert للالتزامات. الإضافة تبقى في البيوت لكنها لا تعمل بلا المركز (الاستطلاع يفشل
  بصمت)، ويمكن حذف `plugins/corehub-bridge/` ومفاتيحها من `config.yaml` يدويًا. لا ترحيل ولا بيانات.

## التسليم والخطوة التالية
- PR إلى `main` بالإنجليزية؛ المالك يراجع ويدمج. لا دمج تلقائي، ولا تغيير على `test`، ولا بناء صور.
- المرحلة 2 (وكيل آخر): iOS وأندرويد على العقد أعلاه (انظر «ما على الجوالات» في قسم العقد).
- بعد الدمج وتجربة المالك: تجربة واتساب حقيقي، وتحديد ما إذا كان يريد بثًّا حيًّا للرد (`on_stream_*`)
  لاحقًا.
