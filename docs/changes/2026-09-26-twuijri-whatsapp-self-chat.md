# واتساب برقم شخصي («مراسلة نفسي»)، وحالة «غير متصل» بعد الربط، وزر «الموافقات»
المسؤول: twuijri · الفرع: fix/whatsapp-self-chat · الحالة: review

## المشكلة والهدف
بلاغ المالك (هب 1.1.0 الحي، ٢٠٢٦-٠٩-٢٦): أعاد ربط واتساب في البروفايل الافتراضي برقمه **الشخصي**. بطاقة القنوات
تقول «مربوط» لكن «غير متصل»، والوكيل لا يرد عليه. صديق ربط واتساب رقمه ولم يصله رد أيضًا.

الهدف:
1. أن يختار الشخص صراحةً عند الربط كيف يُستعمل الرقم: «بوت (رقم مخصص للوكيل)» أو «أنا (مراسلة نفسي)»، وأن يغيّره
   بعد الربط.
2. أن ينتهي الربط الجديد «متصلًا» بلا خطوة يدوية، وأن تقول البطاقة بوضوح متى يحتاج هرمز إعادة تشغيل، مع الزر.
3. (طلب المالك أثناء العمل، الصفحة نفسها) طلبات الموافقة والمرسلون المعتمدون ينتقلون من أسفل الصفحة إلى زر واحد
   «الموافقات» في رأسها بعدد المنتظرين، يفتح لوحة مجمّعة حسب المنصة؛ وبطاقة المنصة التي فيها منتظر تربط باللوحة؛
   وصندوق «بانتظارك» العام يوافق ويرفض مباشرة.

## القرار والموافقات
### ما رأيته في هرمز (ADR 0012؛ MIT، الوسم v2026.9.14 في الصورة تحت `/opt/hermes/src`)
- **وضعان لواتساب** يحدّدهما `WHATSAPP_MODE` في `.env` البروفايل، يقرؤه المحوّل
  (`plugins/platforms/whatsapp/adapter.py` §_bridge_env) ويمرّره إلى الجسر (`scripts/whatsapp-bridge/bridge.js`):
  - `bot`: رقم منفصل للوكيل. يراسله الآخرون، ومن يكتب أوّل مرة يصله رمز اقتران (سياسة `pairing`)، وما يكتبه صاحب
    الحساب من جوّاله نفسه يُسقَط.
  - `self-chat`: رقم الشخص نفسه. لا يصل إلى هرمز إلا ما يكتبه صاحب الحساب في محادثة «مراسلة نفسي»، ويردّ الوكيل في
    المحادثة نفسها بتوقيع قصير يميّز ردوده. رسائل أي شخص آخر يُسقطها الجسر قبل أن تصل هرمز، فلا يتلقّى أحد ردًّا ولا
    رمز اقتران.
  - بلا `WHATSAPP_MODE` يعمل هرمز `self-chat`.
- معالج الإعداد في هرمز (`hermes_cli/main_platform_setup.py`) يسأل السؤال نفسه: «رقم بوت منفصل» أو «رقمك الشخصي
  (مراسلة نفسي)».
- **البوابة ما زالت تسأل: هل المرسل مسموح؟** في `self-chat` المرسل هو صاحب الحساب؛ إن لم يكن في
  `WHATSAPP_ALLOWED_USERS` عامله هرمز كغريب وأرسل له رمز اقتران في محادثته مع نفسه. لذلك يضيف تطبيق هرمز نفسه
  (`hermes_cli/web_routers/messaging.py` §apply) رقم الحساب إلى القائمة في هذا الوضع. سياسة `pairing` تبقى «pair»
  للغرباء حتى مع وجود قائمة (`gateway/authz_mixin.py` §_get_unauthorized_dm_behavior).
- `PUT /api/messaging/platforms/whatsapp` في هرمز يقبل `WHATSAPP_ALLOWED_USERS` و`WHATSAPP_MODE` (جرّبته على هرمز
  الحقيقي، أدناه).

### السبب الجذري لـ«غير متصل»
الهب كان يكتب `WHATSAPP_MODE=bot` دائمًا — فرقم شخصي لا يردّ على صاحبه أبدًا (رسائله `fromMe` تُسقط في وضع
`bot`) — **و** لم يكن يعيد تشغيل بوابة البروفايل **الافتراضي** بعد الربط: `channelsChanged('default')` كان يعود
فورًا لأن تلك البوابة تحمل خادم الواجهة وكانت «تنتظر Restart». فبقيت البوابة تعمل بلا واتساب، ولا يُذكر واتساب في
`gateway_state.json`، فتقرأ البطاقة `offline`. الجسر لا يعمل أصلًا لأن البوابة لم تحمّل المنصة. (في بروفايل مسمّى كانت
البوابة تُعاد فعلًا.)

### القرار (مقترح — للمالك أن يؤكّد؛ DECISIONS §85)
1. **يُسأل ولا يُخمَّن.** `agents.loginChannel` يأخذ `mode` (`bot` | `self-chat`)؛ الويب يسأل قبل رسم الرمز
   «بوت (رقم مخصص للوكيل)» أو «أنا (مراسلة نفسي)» — التسميتان كما طلبهما المالك («خيارين تبيه بوت ولا يو سلف») —
   ولا يختار أيًّا منهما، و«متابعة» معطّل حتى يختار. بلا `mode` يربط الهب `bot` كما كان، والروابط القديمة تبقى
   `bot`. في `self-chat` يُضاف رقم الحساب إلى `WHATSAPP_ALLOWED_USERS` ويبقى من كان فيها.
2. **تغيير الوضع في مكانه.** `agents.setChannelMode` (`PUT /agents/{id}/channels/{platform}/mode`) لواتساب فقط:
   يُكتب الوضع والبوابة موقوفة ثم تُشغَّل من جديد، والجوّال يبقى مربوطًا. البطاقة تعرض الوضع («بوت» / «مراسلة نفسي»)
   وزر «تغيير الوضع».
3. **الربط يعمل فورًا في كل بروفايل.** بعد الربط وبعد تغيير الوضع يعيد الهب تشغيل البوابة التي تخدم البروفايل —
   الافتراضي أيضًا، بإيقافها لحظة ثم تشغيلها كما يفعل تغيير أدوات الهب (§79) (`HermesRuntime.channelLinked`).
   بقية تعديلات القنوات في البروفايل الافتراضي ما زالت تنتظر Restart كما كانت.
4. **«يحتاج هرمز إلى إعادة تشغيل»**: `Channel.restart_needed` صحيح حين تكون القناة مفعّلة ومربوطة والبوابة تعمل لكنها
   لا تذكرها (هرمز يكتب كل منصة يبدأ بها `connecting` أوّلًا). البطاقة تقولها مع «أعد التشغيل الآن» (`agents.restart`).
   ومنصة يقول هرمز إنها `connecting` تُقرأ `unknown` لا `offline`، والويب يعيد القراءة كل ٣ ث حتى تستقر.
5. **الموافقات في مكان واحد** (طلب المالك): زر «الموافقات» / "Approvals" في رأس الصفحة بعدد المنتظرين يفتح لوحة
   جانبية: «طلبات بانتظار الموافقة» مجمّعة حسب المنصة (موافقة / رفض)، و«المرسلون المعتمدون» حسب المنصة، لكل واحد
   «إزالة» (كانت «سحب الاعتماد») بعد تأكيد. البطاقة التي فيها منتظر تعرض «N بانتظار الموافقة — راجِع» يفتح اللوحة
   نفسها. صندوق «بانتظارك» يعرض لطلب الاقتران زرّي «موافقة» و«رفض» (المكوّن نفسه `PairingDecision`)، ويبقى رابط
   «افتحه في مكانه». لا تغيير في العقد لهذا الجزء.
6. نص الإرشاد داخل بطاقة واتساب ونافذته (قاعدة #146): في «أنا» — افتح «مراسلة نفسي» واكتب للوكيل، ولا أحد غيرك يصل
   إليه، بلا تحذير الرقم الشخصي؛ في «بوت» — الخطوات كما كانت مع التحذير الذي صار يدلّ على خيار «أنا».

المرفوض: تخمين الوضع من الرقم (لا يمكن معرفته)؛ استعمال `…/apply` في هرمز (يشغّل `hermes gateway restart` فيبدأ
بوابة ثانية داخل عملية لوحة هرمز في الحاوية).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `agents.loginChannel`: جسم اختياري `ChannelLoginRequest { mode: bot | self-chat }` (الافتراضي `bot`)، والوصف:
  الهب يعيد تشغيل البوابة في أي بروفايل، ونتيجة المهمة `{status, account_name, account_phone, mode, applies: now}`.
- جديد: `agents.setChannelMode` — `PUT /agents/{agent_id}/channels/{platform}/mode`، جسم `ChannelModeWrite`،
  `200 Channel`، `409` بـ`mode_not_supported` أو `not_linked`، `400` لوضع غير معروف.
- `Channel.restart_needed` (إلزامي، boolean)، و`ChannelLink.mode` (إلزامي، `bot | self-chat | null`).
- وصف `ChannelGateway.applies` في `listChannels`: الربط وتغيير الوضع يعيدان التشغيل في أي بروفايل.
- DECISIONS §85.

## الملفات والتأثير
- الخادم: `modules/agents/channels.ts` (`whatsappMode`، `withAllowedOwner`، `whatsappOwner`، `setWhatsAppMode`،
  `ChannelLink.mode`)، `hermes-tools.ts` (`pairWhatsApp` بـ`mode` و`allowedUsers`)، `hermes-runtime.ts`
  (`channelLinked`)، `index.ts` (الوضع في `loginChannel`، مسار `setChannelMode`، `restart_needed` و`connecting`).
- الويب: `agents/AgentChannelsScreen.tsx` (خطوة الوضع في نافذة الربط، شارة الوضع و«تغيير الوضع»، تنبيه إعادة
  التشغيل، زر «الموافقات» ولوحته بدل القسم السفلي، رابط «بانتظار الموافقة» في البطاقة)، `agents/PairingDecision.tsx`
  (جديد)، `agents/skills.ts`، `shell/PendingActions.tsx`، `i18n/{ar,en}.json`.
- الاختبارات: خادم `channels.test.ts`، `hermes-tools.test.ts`، `channels-gateway.routes.test.ts`،
  `tests/contract/channels.contract.test.ts`، و`tests/unit/whatsapp-mode.real.test.ts` (جديد، هرمز الحقيقي)؛ ويب
  `channels-pairing.test.tsx`، `channels-picker.test.tsx`، `channels-telegram.test.tsx`، `pending-actions.test.tsx`؛
  e2e `zz-agent-tools.spec.ts`، `zzzzz-channels-pairing.spec.ts`، `zzzzz-channels-telegram.spec.ts`.
- الوثائق: `docs/STATUS.md` (312 من 323، صف agents 57/61، فقرة صفحة القنوات)، `docs/contracts/DECISIONS.md` §85.
- التأثير على هب قائم: الروابط القديمة تبقى `bot` ولا يتغيّر فيها شيء. أوّل ربط أو تغيير وضع في البروفايل الافتراضي
  يوقف بوابته لحظات (خادم الواجهة 8642 معها)؛ المحادثات عبر بوابة TUI لا تتأثر.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (كلها عبر `mj-run`):
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck            → exit=0
$ pnpm contracts:lint
contracts:lint  OK          (تحذير واحد قديم في 6853: مثال listChannelPlatforms بلا program)
$ pnpm contracts:check-clients
check-clients  OK — 622 client file(s) scanned, 230 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  373 passed (373)
$ vitest run (server) channels.test.ts hermes-tools.test.ts channels-gateway.routes.test.ts channel-link.routes.test.ts hermes-gateways.test.ts tests/unit/status.test.ts tests/unit/whatsapp-mode.real.test.ts
 Test Files  6 passed | 1 skipped (7)
      Tests  90 passed | 3 skipped (93)
$ COREHUB_HERMES_IMAGE=core-hub:channeldeps vitest run tests/unit/whatsapp-mode.real.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
$ vitest run (web) channels-pairing channels-picker channels-telegram channels-platforms pending-actions i18n
 Test Files  6 passed (6)
      Tests  38 passed (38)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome playwright test zzzzz-channels-pairing.spec.ts zzzzz-channels-telegram.spec.ts
  ✓  1 [chromium] › e2e/zzzzz-channels-pairing.spec.ts:45:1 › 30. a linked WhatsApp: how to use it, the senders waiting for approval, and Unlink (11.9s)
  ✓  2 [chromium] › e2e/zzzzz-channels-telegram.spec.ts:42:1 › 31. Telegram linked by a bot token: the steps, the bot named, approvals, and Unlink (11.7s)
  2 passed (31.0s)
$ PLAYWRIGHT_CHANNEL=chrome playwright test zz-agent-tools.spec.ts
  ✓  1 [chromium] › e2e/zz-agent-tools.spec.ts:47:1 › 23. the agent tools ask Hermes: an MCP test, a skill pack imported, WhatsApp linked by QR (8.2s)
  1 passed (14.3s)
```
الاختبار الحقيقي على هرمز (`whatsapp-mode.real.test.ts`، حاوية من الصورة `--network none`، بلا جوّال ولا حساب واتساب
ولا جسر يتصل بواتساب — الجلسة وُضعت كما يتركها الجسر بعد المسح): (١) كتابة الهب في وضع `self-chat` تمرّ عبر
`PUT /api/messaging/platforms/whatsapp` **في هرمز نفسه** (موجّهه مخدوم داخل العملية بـ`TestClient`) فيقبلها ويخزّنها
في `.env`؛ (٢) قارئ `.env` في هرمز وإعداد بوابته ومحوّل واتساب يعطون الجسر `WHATSAPP_MODE=self-chat` وسياسة `pairing`،
وصاحب الحساب مسموح عند بوابة هرمز والغريب لا، والردود موقّعة؛ (٣) بعد `setWhatsAppMode(bot)` يقرأ هرمز `bot` بلا
توقيع. الحاوية حُذفت بعد الاختبار.

الاختبارات الجديدة تفشل على الكود القديم: إعادة تشغيل البوابة الافتراضية بعد الربط، `mode` في الربط والنتيجة، مسار
`setChannelMode`، `restart_needed`، خطوة الوضع في النافذة، لوحة «الموافقات»، وأزرار الصندوق.

CI: (يُملأ بعد الدفع.)

## المخاطر والرجوع
- إعادة تشغيل البوابة الافتراضية بعد الربط تقطع خادم الواجهة (8642) ورسائل القنوات لثوانٍ؛ الدردشة عبر TUI لا تتأثر.
  هذا ما يحدث عند Restart أصلًا ومرة واحدة عند الربط.
- `restart_needed` يعتمد على أن هرمز يذكر كل منصة يبدأ بها في `gateway_state.json` (مقروء من
  `gateway/run_startup.py`)؛ منصة لا محوّل لها أصلًا ستُعرض «تحتاج إعادة تشغيل» وإعادة التشغيل لن تصلحها.
- لم يُجرَّب مع جوّال حقيقي (ممنوع في هذه المهمة): ما ثبت هو ما يكتبه الهب وما يقرؤه هرمز منه، لا سلوك الجسر مع
  واتساب.
- الرجوع: التراجع عن هذا الفرع يعيد `bot` دائمًا والسلوك القديم؛ روابط `self-chat` التي أُنشئت تبقى في `.env`
  وهرمز يحترمها، ويمكن إعادتها بكتابة `WHATSAPP_MODE=bot`.

## التسليم والخطوة التالية
- طلب دمج واحد إلى `main` بالإنجليزية. لا دمج، ولا صورة، ولا `test`.
- للمالك: تأكيد §85 (الوضعان والتسميتان، إعادة تشغيل البوابة الافتراضية بعد الربط، زر «الموافقات»). على هبه الحي بعد
  التحديث: «تغيير الوضع» → «أنا (مراسلة نفسي)» ثم يكتب لنفسه في واتساب.
