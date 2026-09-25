# زر «ربط منصة» ومنتقٍ لكل منصات هرمز في صفحة القنوات
المسؤول: twuijri · الفرع: feat/channels-link-picker · الحالة: review

## المشكلة والهدف
طلب المالك (2026-09-25، مع لقطة من صفحة قنوات هرمز):
> «ودي ما يكونون لسته كذا تحت، يكون زر "ربط قناة"، اذا ضغطت عليها يعلمك كل الخدمات الي يدعمها هرمز
> وتربط الي تبي، وكل واحد له الخصائص الي يطلبها»

كانت الصفحة تعرض القناة المربوطة، ثم قائمة طويلة تحتها: «منصات أخرى» (ديسكورد وسلاك وMatrix
وMattermost والبريد، لكل واحدة زر ربط)، ثم «منصات أخرى يدعمها هرمز». وفي الرأس زرّا «ربط واتساب»
و«ربط تيليجرام». وتظهر إرشادات «كيف تبدأ» وملاحظة «هذه الصفحة تكتب في ملف إعداد الوكيل…» كلافتات
فوق الصفحة كلها.

ثم أضاف المالك تحسينين:
1. اسم الزر «ربط منصة» / "Link a platform"، وكلمة «منصة» في كل المنتقي، لا «قناة» ولا «إضافة».
2. إرشادات كل منصة تكون داخل صندوقها فقط: في نافذة ربطها أثناء الربط، وفي بطاقتها المربوطة ما دامت
   تنتظر الاقتران أو الموافقة. ولا لافتة على مستوى الصفحة. وملاحظة «هذه الصفحة تكتب…» تصير سطرًا
   خافتًا واحدًا.

الهدف: صفحة نظيفة لا تعرض إلا المربوط، وزر واحد يفتح منتقيًا فيه كل منصات هرمز، ولكل منصة نموذجها.

## القرار والموافقات
**ما قرأته في هرمز** (MIT، الوسم المثبّت `v2026.9.14`، نسخة مطابقة للوسم محليًا)، بكلماتنا (ADR 0012):
- تعمل المنصة حين توجد متغيّرات دخولها في البيئة (`gateway/config_env.py` §_ENV_STEPS، و
  `plugins/platforms/<p>/plugin.yaml` للإضافات)، ما لم يقل `config.yaml` صراحة `enabled: false`.
- المنصات الخمس التي طلبها المالك ولم تكن في الكتالوج **كلها موجودة** في هرمز المثبّت:

  | المنصة | المفتاح | ما يلزم | عنوان عام؟ | تنزيل أول تشغيل؟ |
  |---|---|---|---|---|
  | iMessage via Photon | `photon` | `PHOTON_PROJECT_ID`، `PHOTON_PROJECT_SECRET`؛ القائمة `PHOTON_ALLOWED_USERS` | لا (تيار gRPC عبر جسر Node) | نعم: جسر Node يُثبَّت بـ npm (`spectrum-ts`) |
  | WeCom Callback | `wecom_callback` | معرّف الشركة وسرّها، ومعرّف التطبيق، والرمز، ومفتاح AES؛ المنفذ 8645 | نعم (callback HTTP) | نعم: `defusedxml` |
  | Yuanbao | `yuanbao` | `YUANBAO_APP_ID`، `YUANBAO_APP_SECRET`؛ قائمته الخاصة `YUANBAO_DM_ALLOW_FROM` | لا (WebSocket) | لا (`websockets` في هرمز) |
  | Raft | `raft` | `RAFT_PROFILE` | لا | لا، لكنه يشغّل برنامج `raft` (`raft agent bridge`) غير الموجود في الصورة |
  | Buzz | `buzz` | `BUZZ_RELAY_URL`، `BUZZ_PRIVATE_KEY`؛ القائمة `BUZZ_ALLOWED_USERS` | لا | لا، لكنه يشغّل برنامج `buzz` غير الموجود في الصورة |

- المحوّلات التي تأخذ قفل المنصة على هويتها (`_acquire_platform_lock`) تشمل أيضًا LINE وQQ
  وYuanbao وBuzz، فصارت `exclusive` (هوية واحدة في بروفايل واحد).
- اسم Hermes لـ BlueBubbles هو «iMessage via BlueBubbles»، فصار ذلك وسمه.
- في هرمز منصات لم يذكرها المالك وتركتها عمدًا: `api_server` و`webhook` و`msgraph_webhook` و`relay`
  (واجهة المركز البرمجية وwebhooks وموصل تجريبي، لا مكان يراسل فيه الناس الوكيل)، و`a2a` (بين
  الوكلاء، ولا متغيّر مطلوبًا فيه فلا شيء يُربط). لا منصة في قائمة المالك غائبة عن هرمز.

**القرار** (مقترح، والتأكيد للمالك — DECISIONS §77):
1. الصفحة تعرض **المربوط فقط** (أو ما عليه طلب اقتران ينتظر، أو قناة كُتبت يدويًا في الملف). لا
   كتالوج تحتها، ولا زرّا واتساب وتيليجرام في الرأس.
2. زر واحد «ربط منصة» / "Link a platform" في الرأس. وحين لا يُربط شيء تصير الصفحة حالة فارغة
   فيها جملة قصيرة والزر نفسه.
3. المنتقي نافذة فيها بحث ثابت أعلاها، ثم «الأكثر استخدامًا» بترتيب ثابت: تيليجرام، واتساب،
   ديسكورد، سلاك، البريد، مايكروسوفت تيمز، قوقل شات، سيجنال. ثم «منصات أخرى» أبجديًا بلغة القارئ.
   البحث يطابق الاسم باللغتين، واسم المنصة الأصلي، ومفتاح هرمز (فـ"telegram" و«تيليجرام» كلاهما
   يجدها). على كل منصة شاراتها: «يُنزَّل عند أول تشغيل»، «يحتاج عنوانًا عامًّا»، وجديدة «يحتاج برنامج
   {program}». والمنصة المربوطة عليها «مربوط» ولا تُختار مرة ثانية.
4. اختيار منصة يفتح نموذجها: تيليجرام نافذته، وواتساب نافذة QR، وديسكورد وسلاك وMatrix وMattermost
   والبريد نوافذها، والباقي النموذج العام. والنموذج العام يذكر البرنامج الخارجي إن احتاجته.
5. **الإرشادات داخل صندوق المنصة:** «كيف تبدأ» (تيليجرام: افتح البوت وأرسل رسالة ووافق؛ واتساب:
   راسل الرقم ووافق، مع تنبيه الرقم الشخصي؛ المنصات الكاملة: خطوتها) صارت داخل بطاقة المنصة. تُفتح
   وحدها ما دامت المنصة التي تقترن تنتظر أول شخص (لا معتمد عليها بعد، أو طلب ينتظر). وفي غير ذلك
   يفتحها زر «كيف تبدأ» في البطاقة. ديسكورد والبريد لا يقترنان، فإرشادهما خلف الزر. وخطأ المنصة
   داخل البطاقة أيضًا. ونوافذ الربط تُبقي خطواتها وحالة «تم» كما هي.
6. ملاحظة إعادة التشغيل وحالة البوابة سطر خافت واحد تحت العنوان، ونصها أقصر.
7. الأسماء العربية كما أعطاها المالك: تيليجرام، واتساب، واتساب للأعمال، ديسكورد، سلاك، مايكروسوفت
   تيمز، قوقل شات، سيجنال، لاين، البريد الإلكتروني، الرسائل النصية (Twilio). والبقية باسمها
   الإنجليزي في اللغتين، ومنها Matrix وMattermost (كانتا «ماتريكس» و«ماترموست»). وأضفت «(Twilio)»
   لتسمية المزوّد — مقترح، والتأكيد للمالك.
8. شارة «طلبات بانتظار الموافقة» تسمّي المنصة باسمها المعروض (واتساب) لا بمفتاحها (whatsapp).

لم ألمس صفحة إعدادات الشخص ولا كود ربط الهويات: يعمل عليهما وكيل آخر.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `ChannelPlatform.program` (`string | null`، مطلوب): اسم البرنامج الخارجي الذي يشغّله هرمز للمنصة
  ولا تحمله الصورة (`raft`، `buzz`)، و`null` لغيرهما. إضافة لا تكسر العملاء القدامى.
- وصف `agents.listChannelPlatforms` يذكر `program`.
- DECISIONS §77.

## الملفات والتأثير
- `packages/contracts/openapi.yaml`: الحقل `program`.
- `packages/server/src/modules/agents/channel-platforms.ts`: الحقل `program`، والمنصات الخمس،
  و`exclusive` لـ LINE وQQ، ووسم BlueBubbles.
- `packages/server/src/modules/agents/index.ts`: يرسل `program`.
- `packages/server/src/modules/agents/channel-link.routes.test.ts`: الكتالوج يشمل المنصات الجديدة،
  وربط Buzz يكتب متغيّراته وقائمته.
- `packages/web/src/agents/ChannelPlatformPicker.tsx` (جديد): المنتقي، والتجميع، والترتيب، والبحث.
- `packages/web/src/agents/AgentChannelsScreen.tsx`: المربوط فقط، والزر الواحد، والحالة الفارغة،
  والإرشادات داخل البطاقة، وملاحظة البوابة سطرًا خافتًا، وإشعار إلغاء الربط على مستوى الصفحة (لأن
  الصف يختفي بعده). حُذف كتالوج «منصات أخرى».
- `packages/web/src/agents/skills.ts`: `program` في النوع.
- `packages/web/src/styles/screens.css`: `.channel-card` و`.channel-card-body`.
- `packages/web/src/i18n/{ar,en}.json`: نصوص المنتقي والأسماء. وحُذفت نصوص الكتالوج و«ربط واتساب»
  و«ربط تيليجرام» وملخّصات المنصات التي لم تعد تُعرض.
- الاختبارات: `tests/channels-picker.test.tsx` (جديد)، و`tests/helpers/channel-catalog.ts` (جديد)،
  وتحديث `channels-platforms` و`channels-telegram` و`channels-pairing`. ورحلات Playwright:
  `zz-agent-tools` و`zzzzz-channels-{discord,pairing,telegram}` و`smoke` (القنوات الفارغة).
  ولقطات القنوات، ومنها لقطة جديدة للمنتقي `agent-channels-picker-ar-light.png`.
- `docs/STATUS.md`، `docs/contracts/DECISIONS.md` §77.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، ما يمسّه التغيير فقط (عبر `mj-run`):

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck            → exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 584 client file(s) scanned, 222 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 37 destinations, 2 pre-auth screens (login, setup), 42 terms, ar/en complete, routes for web, ios, android, desktop
$ vitest run src/modules/agents/channel-link.routes.test.ts      (server)
 Test Files  1 passed (1)
      Tests  16 passed (16)
$ vitest run --project contract tests/contract/channels.contract.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
$ vitest run tests/channels-picker.test.tsx tests/channels-platforms.test.tsx \
    tests/channels-telegram.test.tsx tests/channels-pairing.test.tsx tests/i18n.test.ts tests/logical-css.test.ts
 Test Files  6 passed (6)
      Tests  292 passed (292)
$ pnpm build                → exit 0
$ PLAYWRIGHT_CHANNEL=chrome playwright test --workers=1 e2e/zz-agent-tools.spec.ts \
    e2e/zzzzz-channels-discord.spec.ts e2e/zzzzz-channels-pairing.spec.ts e2e/zzzzz-channels-telegram.spec.ts
  ✓  1 … 23. the agent tools ask Hermes: an MCP test, a skill pack imported, WhatsApp linked by QR (8.1s)
  ✓  2 … 41. Discord linked like Telegram: the steps, the bot named, its settings, and Unlink (1.8s)
  ✓  3 … 30. a linked WhatsApp: how to use it, the senders waiting for approval, and Unlink (1.2s)
  ✓  4 … 31. Telegram linked by a bot token: the steps, the bot named, approvals, and Unlink (1.9s)
  4 passed (19.1s)
```

اختبارات المنتقي الجديدة تفشل على الكود القديم: لم يكن فيه `platform-picker-open` ولا `channels-empty`.
لم أشغّل محليًا رحلة `smoke` كاملة ولا حزم الخادم والويب كاملة: يشغّلها CI على كل دفع. نتيجة CI في
قسم التسليم.

## المخاطر والرجوع
- من ربط منصة ثم ألغى ربطها يبقى لها عقدة `enabled: false` في `config.yaml`. لم تعد تظهر في الصفحة،
  ويعاد ربطها من المنتقي.
- منصة عليها طلب اقتران ينتظر تبقى ظاهرة حتى بعد إلغاء ربطها، ليُردّ على الطلب. هذا مقصود.
- Raft وBuzz لن يعملا حتى يُثبَّت برنامجهما في الخادم. المنتقي والنموذج يقولان ذلك قبل الربط.
- جعل LINE وQQ `exclusive` يعني أن ربط الهوية نفسها في بروفايل ثانٍ يُرفض بـ `token_in_use`. هذا
  ما يفعله هرمز نفسه عند التشغيل.
- الرجوع: revert لهذا الـ PR. الحقل `program` إضافي، فلا عميل يتعطّل برجوعه.

## التسليم والخطوة التالية
- PR إلى `main` بالإنجليزية. لا دمج، ولا فرع `test`، ولا صورة.
- للمالك تأكيده: ترتيب «الأكثر استخدامًا»، وإبقاء Matrix وMattermost بالإنجليزية، و«(Twilio)» في
  اسم الرسائل النصية، وأن إرشادات ديسكورد والبريد خلف زر «كيف تبدأ».
- نتيجة CI: تُضاف بعد اكتماله.
