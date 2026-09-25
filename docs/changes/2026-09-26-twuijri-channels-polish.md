# صفحة القنوات: «كيف تبدأ» مطويّة، نصوص محدّثة، و«عنوان الردود» لواتساب
المسؤول: twuijri · الفرع: fix/channels-polish · الحالة: review

## المشكلة والهدف
ملاحظات المالك على هب 1.1.1، صفحة القنوات للوكيل:

1. **«كيف تبدأ» تنفتح وحدها في تيليجرام** كل مرة تُفتح الصفحة. المالك: «المفروض ما تطلع الا لما اضغط
   How to start». السبب قاعدة #146: الدليل يُفتح تلقائيًا ما دامت المنصة «تنتظر أول شخص معتمد» (لا معتمد بعد،
   أو طلب منتظر). ونصوص الدليل قديمة: «في البروفايل الافتراضي أعد تشغيل هرمز من بطاقته أولًا» (منذ #158 يعيد الهب
   التشغيل بنفسه)، و«وافق على الطلب في الأسفل تحت "طلبات بانتظار الموافقة"» (منذ #157 هو زر «الموافقات» في الأعلى).
   وملاحظة الصفحة «هرمز يتّصل بهذه المنصّات عند إقلاعه: أعد تشغيله…» قديمة حين يدير الهب هرمز.
2. **عنوان ردود واتساب** (وافق عليه المالك: «ممتاز»): في وضع «مراسلة نفسي» يبدأ كل ردّ بـ`☤ *Hermes Agent*` وخط.
   المطلوب إعداد «عنوان الردود» على بطاقة واتساب: اسم الوكيل (الافتراضي)، أو نص مخصص، أو بلا عنوان.

## القرار والموافقات
### ١) «كيف تبدأ» والنصوص
- الدليل مطويّ افتراضيًا لكل منصة، ولا يُفتح إلا بزر «كيف تبدأ» (`aria-expanded`). حُذفت قاعدة الفتح التلقائي
  (`starting` / `waitsForPeople`)؛ رابط «N بانتظار الموافقة — راجِع» على البطاقة يغطي المنتظرين كما هو.
- حُذف سطر إعادة التشغيل من أدلة تيليجرام وواتساب والمنصات الأخرى (والمفتاح `channels.how.step_restart`)؛ حيث لا
  يدير الهب هرمز تقول ملاحظة الصفحة ذلك.
- «وافق… في الأسفل تحت "طلبات بانتظار الموافقة"» صارت «من زر «الموافقات» أعلى هذه الصفحة» (تيليجرام والمنصات
  العامة)، و«ينتظر موافقتك في الأسفل» في نافذة ربط تيليجرام صارت «في «الموافقات» أعلى صفحة القنوات».
- ملاحظة الصفحة (`restart_note`) تظهر فقط حين لا يدير الهب هرمز (`gateway: null`) أو من هب أقدم يقول `on_restart`
  (تطبيق سطح المكتب قد يتصل بهب أقدم). هذا كان صحيحًا في الكود منذ #158، وأضفت له اختبارًا؛ نسخة 1.1.1 عند المالك
  لا تحوي #158، ولهذا رأى الملاحظة.

### ٢) عنوان الردود — ما رأيته في هرمز (ADR 0012؛ MIT، v2026.9.14 في صورة `core-hub:morechannels`)
- `gateway/platforms/whatsapp_common.py` §_effective_reply_prefix: في `self-chat` فقط؛ `reply_prefix` من الإعداد، ثم
  `WHATSAPP_REPLY_PREFIX`، ثم الافتراضي `☤ *Hermes Agent*\n────────────\n`؛ و`\n` المكتوبة تصير سطرًا جديدًا.
- لكن الذي يرسل فعلًا هو الجسر (`scripts/whatsapp-bridge/bridge.js` §formatOutgoingMessage)، والمحوّل
  (`plugins/platforms/whatsapp/adapter.py` §_bridge_env) **يُسقط المتغيّر الفارغ** من بيئة الجسر، فيرسل الجسر عنوان
  هرمز الافتراضي. أي أن القيمة الفارغة لا تلغي العنوان (جرّبته على هرمز الحقيقي، أدناه). و`reply_prefix` في
  `config.yaml` يُسقَط كذلك ما لم يكن المتغيّر مضبوطًا.

### القرار (مقترح — للمالك أن يؤكّد؛ DECISIONS §86)
- عملية جديدة `agents.setChannelReplyHeader` (`PUT /agents/{id}/channels/{platform}/reply-header`)، لواتساب فقط:
  `use: agent_name` (اسم الوكيل كما يعرضه الهب، `Agent.name`) أو `use: custom` مع `title` (سطر واحد، ١–٦٤ حرفًا).
  يكتب الهب `WHATSAPP_REPLY_PREFIX=*<العنوان>*\n────────────\n` في `.env` البروفايل — شكل عنوان هرمز نفسه باسم آخر —
  ثم تتبع البوابة عبر مسار `channelsChanged` المعتاد. `ChannelLink.reply_title` يقرؤه (null = عنوان هرمز).
- **الافتراضي اسم الوكيل**: يُكتب عند ربط رقم في `self-chat` أو التحويل إليه إن لم يكن مكتوبًا شيء. الروابط القديمة
  لا تُعاد كتابتها عند الإقلاع: تبقى على عنوان هرمز حتى يحفظ أحد الإعداد أو يغيّر الوضع. قيمة كتبها أحد يدويًا تبقى.
- **لا خيار «بلا عنوان»** — انحراف عن الطلب: مع هرمز v2026.9.14 القيمة الفارغة ترسل عنوان هرمز (مثبت بالاختبار الحقيقي)،
  والعنوان هو ما يميّز ردود الوكيل عن رسائل المالك في محادثة واحدة. النافذة تقول «يمكن تغييره لا حذفه». إن قبل جسر
  هرمز القيمة الفارغة يومًا تضاف `use: none`. رُفض تزييفه بمحرف صفري العرض أو سطر فارغ.
- الواجهة: زر «عنوان الردود» / "Reply header" على بطاقة واتساب في وضع «مراسلة نفسي» فقط، يفتح نافذة: «اسم الوكيل
  (الاسم)» أو «نص مخصص» مع حقل، ومعاينة لبداية الرد (العنوان بخط عريض ثم الخط)، وملاحظة «الآن: عنوان هرمز نفسه» حين
  لا شيء مكتوب. «حفظ» معطّل حين لا تغيير.
- تغيير اسم الوكيل لاحقًا لا يعيد كتابة العنوان (يُقرأ بعدها كنص مخصص).

## العقد (ما تغيّر في packages/contracts)
- مسار جديد `PUT /agents/{agent_id}/channels/{platform}/reply-header` (`agents.setChannelReplyHeader`) ومخطط
  `ChannelReplyHeaderWrite`.
- `ChannelLink.reply_title` (مطلوب، `string | null`) وأمثلته. `contracts:check-clients` نظيف.

## الملفات والتأثير
- `packages/server/src/modules/agents/channels.ts`: `replyPrefixFor`، `whatsappReplyTitle`، `cleanReplyTitle`،
  `setWhatsAppReplyTitle`، `defaultReplyTitle`، و`ChannelLink.replyTitle`.
- `packages/server/src/modules/agents/index.ts`: المسار الجديد، الاسم الافتراضي بعد ربط `self-chat` وبعد التحويل إليه،
  `reply_title` في الاستجابة.
- `packages/web/src/agents/AgentChannelsScreen.tsx`: الدليل مطويّ، حذف سطر إعادة التشغيل، `ReplyHeaderDialog`؛
  `packages/web/src/agents/skills.ts`: `useSetChannelReplyHeader`؛ `ar.json` و`en.json`.
- الاختبارات: `channels.test.ts`، `channels-gateway.routes.test.ts`، `tests/contract/channels.contract.test.ts`،
  `tests/unit/whatsapp-reply-header.real.test.ts` (جديد)، و`channels-pairing|picker|telegram.test.tsx`،
  و`e2e/zzzzz-channels-pairing|telegram.spec.ts` ولقطة `agent-channels-reply-header-ar-light.png`.
- `packages/contracts/openapi.yaml`، `docs/contracts/DECISIONS.md` (§86 وإشارة في §85)، `docs/STATUS.md` (313 من 324).

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبارات الجديدة على كود الواجهة القديم (نسخة `origin/main` من الشاشة وملفي اللغة) — تفشل:
```
     × explains BotFather, sends the token and the allowed ids in the profile, and names the bot
     × shows the linked and the set-up ones, nothing else, and one button
     × reads as linked with its account, offers Unlink, and says how to use it
     × is closed on every visit, even with nobody approved and somebody waiting
     × with nothing written, says Hermes’s header shows and saves the agent’s name
     × takes a typed title, and saving the same one is not a change
     × shows the mode on the linked card, explains "Message yourself", and changes it
 Test Files  3 failed (3)
      Tests  7 failed | 21 passed (28)
```
(اختبار «where the hub runs Hermes, says nothing about restarting it» ينجح على القديم أيضًا: السلوك موجود منذ #158.)
اختبارات الخادم الجديدة تعتمد مسارًا ودوالّ جديدة، فلا تعمل على القديم.

على الكود الجديد:
```
$ vitest run tests/channels-pairing.test.tsx tests/channels-picker.test.tsx tests/channels-platforms.test.tsx tests/channels-telegram.test.tsx
 Test Files  4 passed (4)
      Tests  33 passed (33)
$ COREHUB_HERMES_IMAGE=core-hub:morechannels vitest run tests/unit/whatsapp-reply-header.real.test.ts tests/unit/status.test.ts src/modules/agents/channels.test.ts src/modules/agents/channels-gateway.routes.test.ts
 ✓ whatsapp-reply-header.real.test.ts > a link made before, with nothing written, still carries Hermes’s own header 1399ms
 ✓ whatsapp-reply-header.real.test.ts > the agent’s name, written by the hub, is the header Hermes sends 1058ms
 ✓ whatsapp-reply-header.real.test.ts > a typed title with spaces and quotes survives the .env quoting 832ms
 ✓ whatsapp-reply-header.real.test.ts > an empty value is no way to drop the header: the bridge sends Hermes’s own 981ms
 ✓ whatsapp-reply-header.real.test.ts > in bot mode no reply carries a header, whatever is written 878ms
 ✓ status.test.ts > implements at least as many operations as docs/STATUS.md claims
 ✓ channels-gateway.routes.test.ts > the header … > a self-chat link carries the agent’s name; a bot link and a read write nothing
 ✓ channels-gateway.routes.test.ts > the header … > switching an old link to self-chat writes the name only where nothing is written
 ✓ channels-gateway.routes.test.ts > the header … > is set to a typed title or the agent’s name, and the gateway follows
 Test Files  4 passed (4)
      Tests  55 passed (55)
$ vitest run --project contract tests/contract/channels.contract.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzz-channels-pairing.spec.ts e2e/zzzzz-channels-telegram.spec.ts e2e/zzzzz-channels-discord.spec.ts --workers=1
  ✓  1 … 41. Discord linked like Telegram: the steps, the bot named, its settings, and Unlink (1.7s)
  ✓  2 … 30. a linked WhatsApp: how to use it, the senders waiting for approval, and Unlink (11.9s)
  ✓  3 … 31. Telegram linked by a bot token: the steps, the bot named, approvals, and Unlink (11.7s)
  3 passed (32.5s)
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 624 client file(s) scanned, 231 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop
```
الاختبار الحقيقي يشغّل صورة هرمز بلا شبكة: الهب يكتب العنوان بدواله، وقارئ `.env` في هرمز ومحوّل واتساب
(`_effective_reply_prefix`، `_bridge_env`) ودالة `formatOutgoingMessage` من `bridge.js` نفسه (تُشغَّل بـNode الصورة
على بيئة الجسر) تقول بمَ يبدأ الرد «Hello». لم يُجرَّب بجوّال حقيقي.

CI: يُضاف بعد التشغيل.

## المخاطر والرجوع
- كل حفظ للعنوان يعيد تشغيل بوابة البروفايل (الافتراضي أيضًا، لحظات)، كأي تغيير في القنوات.
- عنوان مكتوب يدويًا بشكل غير شكلنا يُقرأ نصًا في سطر واحد، والحفظ يعيد كتابته بشكلنا.
- الرجوع: إرجاع الـPR. ما كُتب في `.env` يبقى وهرمز يقرؤه؛ حذف السطر `WHATSAPP_REPLY_PREFIX` يعيد عنوان هرمز.

## التسليم والخطوة التالية
- PR إلى `main` بعد نجاح CI؛ لا دمج.
- للمالك أن يؤكّد: غياب «بلا عنوان» (قيد في هرمز)، والاسم الافتراضي عند الربط/التحويل فقط، وشكل العنوان.
