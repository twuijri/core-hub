# بوابة رسائل لكل بروفايل، وموافقات الاقتران، وإلغاء ربط واتساب
المسؤول: twuijri · الفرع: fix/channels-gateway-per-profile · الحالة: review

## المشكلة والهدف
بلاغ المالك (2026-09-24): ربط واتساب برمز QR من «الوكلاء ← هرمز ← القنوات» والبروفايل المختار
أعلى الصفحة «manger»، ثم أعاد تشغيل هرمز وراسل الرقم: «سويت رستارت وراسلته ولا رد».

ثم لقطة شاشة من هب التست: صف واتساب في «manger» يقول «غير مهيّأة» و«0 حقل»، ومفتاحه مطفأ، ولا زر
إلا «ربط برمز QR» — مع أن الربط نجح. وطلب المالك: «المفروض اجل اقدر احذف الربط».

ثم بلاغ ثالث: بعد أن وافق على مُرسِل في البروفايل الافتراضي ردّ واتساب «⚠️ Provider authentication
failed»، وسجل البوابة يقول `Unknown provider 'majlis-custom-cli-proxy-api'`، بينما محادثات الويب تعمل.

الأسباب كما وجدتها في الكود وفي مصدر هرمز (MIT، الوسم المثبّت `v2026.9.14`، `Hermes Agent v0.21.3`):
1. **لا بوابة تخدم البروفايل المسمّى.** المركز يشغّل عملية `hermes gateway run` واحدة بـ
   `HERMES_HOME=${DATA_DIR}/hermes`، وهذه تخدم البروفايل الافتراضي وحده: هرمز يربط البوابة ببروفايل
   واحد (`hermes_cli/profiles.py` §profiles_to_serve: البروفايل النشط فقط، إلا إن فُعّل
   `gateway.multiplex_profiles`). ومنذ #80 تكتب صفحة القنوات والربط في البروفايل المختار، فجلسة
   واتساب محفوظة في `profiles/manger/` ولا عملية تقرؤها.
2. **الصفحة تقرأ الحقول لا الجلسة.** هوية واتساب ليست حقلًا في `config.yaml`: الربط يكتب
   `WHATSAPP_ENABLED=true` في `.env` البروفايل والجلسة في `platforms/whatsapp/session/creds.json`.
   والصفحة كانت تعدّ «مهيّأة» ما فيه حقول فقط. (أما المفتاح المطفأ: القاعدة القديمة `enabled !== false`
   تقرأ عقدة ليس فيها `enabled`، وهرمز نفسه يعدّ العقدة بلا `enabled: true` مطفأة ما لم يقل `.env` غير
   ذلك؛ الآن تُقرأ القاعدتان كما يقرؤها هرمز.)
3. **البوابة لا تعرف المزوّد.** المحادثة تسمّي مزوّدها ونموذجها في كل دور (`/model … --provider …`).
   البوابة لا تسمّي شيئًا، تقرأ `model.provider` من `config.yaml` بروفايلها وتبحث عنه في كتل
   `providers:` **في الملف نفسه** (`gateway/run.py` §_resolve_runtime_agent_kwargs). وكل حفظ لمزوّدات
   بروفايل كان يعيد كتابة ملف الجذر بمزوّدات ذلك البروفايل وحده (وعند الإقلاع يمرّ على كل البروفايلات
   بالترتيب)، فيبقى النموذج الافتراضي يسمّي كتلة حُذفت. أعدت إنتاج الخطأ بالنص نفسه في اختبار (أدناه)
   قبل الإصلاح.
4. **لا واجهة للموافقات.** الربط بسياسة `WHATSAPP_DM_POLICY=pairing`: كل مُرسِل جديد يتلقّى رمز اقتران
   وينتظر موافقة، ولا مكان في الويب للموافقة.

الهدف: كل بروفايل فيه قناة يُخدم، وصف واتساب يقول الحقيقة ويُلغى ربطه، وكل بوابة تعرف المزوّدات التي
تعرفها المحادثة في بروفايلها، والموافقات من الصفحة نفسها، مع شرح بكلام بسيط لطريقة الاستخدام.

## القرار والموافقات
**ما قرأته في مصدر هرمز** بكلماتنا:
- بوابتان متجاورتان لا تتشاركان ملفات: `gateway.pid` و`gateway.lock` و`gateway_state.json` ومقبس
  التحكم كلها في منزل البروفايل (`gateway/status.py`، `gateway/control_socket.py`)، وأقفال المنصّات
  على مستوى الجهاز مفتاحها هوية المنصّة (رمز البوت، مجلد جلسة واتساب)، فهوية واحدة في بروفايلين يرفضها
  هرمز بكلماته.
- خادم الـAPI يفتح المنفذ 8642 متى وُجد `API_SERVER_KEY` في البيئة (`gateway/config_env.py`
  §_api_server).
- جسر واتساب يستمع على 3000 ما لم يقل البروفايل `bridge_port`، وجسر ثانٍ على المنفذ نفسه **يتبنّى جسر
  البروفايل الأول** إن كان متصلًا — فيردّ على أسماء بروفايل من جوّال بروفايل آخر — أو يقتله ليأخذ المنفذ
  (`plugins/platforms/whatsapp/adapter.py` §_reuse_running_bridge و§_kill_port_process).
- هرمز يقدّم وضعًا بديلًا: بوابة واحدة تخدم كل البروفايلات (`gateway.multiplex_profiles`). فيه
  `os.environ` مشترك «أوّل كاتب يغلب»، فلا يختلف مفتاح بروفايل عن الافتراضي — عكس اتجاه #90 (مزوّدات
  مشتركة ومفاتيح خاصة ببروفايل في `.env` الخاص به).
- الاقتران: `GET /api/pairing?profile=`، `POST /api/pairing/approve` بـ`request_id`، `POST
  /api/pairing/revoke` (`hermes_cli/web_routers/ops.py`)، والمخزن `gateway/pairing.py`. لا فعل لرفض
  طلب واحد، فقط `clear-pending` الذي يمسح كل طلبات كل المنصّات.
- لا تسجيل خروج في الجسر ولا في هرمز (`scripts/whatsapp-bridge/bridge.js` بلا مسار logout).

**القرار** (مقترح — للمالك التأكيد):
1. **بوابة لكل بروفايل مسمّى فيه قناة مفعّلة وقادرة على الدخول** (`hermes -p <profile> gateway run`)،
   يشرف عليها المركز كما يشرف على الافتراضية: إعادة تشغيل مع تراجع عند الانهيار، سطورها في سجل المركز
   باسم البروفايل، تتوقّف مع المركز. **الذاكرة**: كل بوابة عملية بايثون بحدود ~200 م.ب، فلا تُشغَّل
   إلا لبروفايل فيه قناة؛ بروفايل بلا قناة لا بوابة له. اخترت عملية لكل بروفايل لا وضع الدمج (السبب
   أعلاه: البيئة المشتركة تعارض مفاتيح البروفايل الخاصة).
2. **خادم الـAPI للبوابة الافتراضية وحدها**: متغيّراته تُحذف من بيئة كل بوابة أخرى (المركز لا يكلّم
   غيرها). **جسر واتساب**: كل بروفايل غير الافتراضي يُعطى `platforms.whatsapp.bridge_port` خاصًا به
   (3001–3999) قبل تشغيل بوابته، يُكتب مرة ويبقى.
3. **متى يسري التغيير**: في البروفايل المسمّى يشغّل المركز بوابته أو يعيد تشغيلها أو يوقفها عند كل ربط
   أو تفعيل أو تعطيل أو تعديل أو نسيان أو إلغاء ربط، وعند الإقلاع. في البروفايل الافتراضي تحمل البوابة
   أيضًا خادم الـAPI ومجدولات هرمز، فيبقى التغيير بانتظار «إعادة التشغيل» كما كان، والصفحة تقول ذلك.
   «إعادة التشغيل» في بطاقة هرمز تعيد تشغيل كل البوابات، والبطاقة تعرض حالة كل واحدة.
4. **المزوّدات**: قبل تشغيل أي بوابة — الافتراضية أيضًا — يجهّز المركز بروفايلها بما تستعمله المحادثة
   فيه (`models` §prepareGateway، عبر منفذ `prepareGatewayProfile`). **مساعد واحد لا اثنان**: بعد دمج
   #90 (نطاق المزوّد: مشترك أو خاص ببروفايل) صار التجهيز هو نفسه تجهيز #90 قبل كل دور محادثة
   (`prepareProfileWith`: كتل المزوّدات المشتركة والخاصة في `config.yaml`، والمفاتيح التي تختلف عن الجذر في
   `.env` البروفايل)، **مع النموذج** زيادةً للبوابة، لأن الدور يسمّي نموذجه والبوابة لا تسمّي شيئًا. وللبروفايل
   الافتراضي تُكتب تهيئة الجذر كاملة كما يكتبها الحفظ. فتجد كل بوابة المزوّدات نفسها التي تجدها المحادثة،
   بما فيها المزوّد الخاص بالبروفايل ومزوّدات المركز المخصّصة مثل `majlis-custom-cli-proxy-api`.
8. **المهام المجدولة** (طلب لاحق من المالك): بوابة البروفايل المسمّى تُشغَّل أيضًا إن كان فيه **مهمة مجدولة
   نشطة لهرمز** ولو بلا قناة، وتُوقف حين لا تبقى قناة ولا مهمة. شرح «تُنفَّذ المهام المجدولة في بوابة
   البروفايل» بكلام بسيط: هرمز يحفظ مهام كل بروفايل في ملف ذلك البروفايل (`profiles/<اسم>/cron/jobs.json`)،
   والذي «يدقّ الساعة» ويشغّل المهمة حين يحين وقتها هو عملية البوابة التي تخدم ذلك البروفايل تحديدًا، مرة
   كل دقيقة تقريبًا. فإن لم تكن للبروفايل بوابة تعمل، تبقى مهامه مكتوبة في ملفها ولا يشغّلها أحد أبدًا — وهذا
   كان حال كل بروفايل مسمّى قبل هذا التغيير (وحال بروفايل بلا قناة حتى الإضافة الأخيرة). الآن: مهمة نشطة
   (غير موقوفة ولا منتهية) في البروفايل = بوابة تعمل له = المهمة تعمل في موعدها بإعدادات ذلك البروفايل
   ومفاتيحه ومهاراته. المركز يتحقّق كل نصف دقيقة (المهام قد يضيفها الوكيل نفسه في محادثة، أو شخص بـ
   `hermes cron`، دون أن يعلم المركز)، وبعد كل كتابة يكتبها في مجدول هرمز من صفحة الجدولة. ملاحظة
   صادقة: صفحة الجدولة في المركز تكتب مهام هرمز في مجدول **البروفايل الافتراضي** اليوم (مسار `/api/jobs`
   في بوابته بلا بروفايل)، فبوابته تعمل دائمًا؛ البوابات المسمّاة تهمّ المهام المكتوبة داخل البروفايل نفسه.
   **لوحة المهام (kanban)**: لهرمز لوحة واحدة لكل البروفايلات ومُوزِّع واحد لها. كل بوابة تشغّل الموزّع ما لم
   تُمنع، وأول بوابة تأخذ قفله تحتفظ به — فلو سبقت بوابة بروفايل لوزّعت بطاقات الجميع ببيئتها. لذلك تُشغَّل
   بوابات البروفايلات بـ`HERMES_KANBAN_DISPATCH_IN_GATEWAY=false`، ويبقى الموزّع الوحيد في البوابة
   الافتراضية (مثبت على هرمز الحقيقي من سجلاته).
5. **واتساب**: «مربوط» من `creds.json` لا من الحقول، مع اسم الحساب ورقمه إن عرفهما هرمز، والتفعيل
   بقاعدة هرمز (`.env` و`config.yaml`). **إلغاء الربط** (`agents.unlinkChannel`) يوقف البوابة التي
   تشغّل الجسر، ويوقف جسرًا تركته خلفها (بعد التحقّق أنه `node` لهذه الجلسة بالذات)، ويحذف مجلد الجلسة،
   ويطفئ القناة في المكانين، ويعيد تشغيل البوابة إن بقيت قناة أخرى. لا خروج في هرمز ولا الجسر، فالصفحة
   تطلب حذف الجهاز من «الأجهزة المرتبطة» في الجوّال أيضًا. المنفذ والمعتمدون يبقون.
6. **الموافقات**: «طلبات بانتظار الموافقة» في صفحة القنوات (البروفايل المختار): المنصّة والمُرسِل
   واسمه وعمر الطلب، مع «موافقة» و«رفض»؛ وتحتها «المرسلون المعتمدون» مع «سحب الاعتماد». عبر API هرمز
   بـ`profile`، **إلا الرفض**: هرمز لا فعل له، فالمركز يحذف ذلك الطلب وحده من ملف هرمز
   `<platform>-pending.json` (كتابة ذرّية كما يكتبه هرمز). تحديث كل عشر ثوانٍ ما دامت الصفحة مفتوحة.
   العمليات للمالك والمشرف فقط: القوائم أرقام هواتف أشخاص.
7. **الشرح**: بعد الربط تقول الصفحة: راسل الرقم من حساب واتساب آخر، ثم وافق على أوّل طلب هنا (وفي
   البروفايل الافتراضي: أعد تشغيل هرمز أولًا)، مع تنبيه أن ربط رقم شخصي يجعل كل من يراسله يتلقّى ردّ
   الاقتران. والتنبيه نفسه في نافذة الربط قبل المسح.

قرار العقد: `docs/contracts/DECISIONS.md` §38.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `Channel.link` (جديد، مطلوب، `ChannelLink | null`)؛ `agents.listChannels` يعيد `gateway`
  (`ChannelGateway | null`: `profile`, `state`, `applies: now|on_restart`, `error`).
- `AgentRuntime.gateways` (اختياري): مصفوفة `MessagingGateway`.
- عمليات جديدة: `agents.unlinkChannel` (`POST /agents/{agent_id}/channels/{platform}/unlink`)،
  `agents.listPairing` (`GET /agents/{agent_id}/pairing` → `PairingList`)، `agents.approvePairing`
  (`POST …/pairing/{platform}/requests/{request_id}/approve` → `PairedSender`)، `agents.denyPairing`
  (`DELETE …/pairing/{platform}/requests/{request_id}`)، `agents.revokePairing`
  (`DELETE …/pairing/{platform}/approved/{user_id}`)؛ معاملا المسار `PairingRequestId` و`PairedUserId`.
- العدد: 259 عملية، 201 منفّذة بعد دمج `main` (كان 254؛ خمس عمليات جديدة كلها منفّذة، وثلاث من #92).

## الملفات والتأثير
- الخادم: `modules/agents/hermes-gateways.ts` (جديد: المشرف على بوابات البروفايلات، قراءة
  `gateway_state.json`، إيقاف جسر متروك)، `hermes-pairing.ts` (جديد)، `hermes-runtime.ts` (يملك
  البوابات: الإقلاع، إعادة التشغيل، الإيقاف، `withGatewayStopped`، `prepareGateway`)، `channels.ts`
  (جلسة واتساب، قاعدة التفعيل، `.env`، إلغاء الربط، منفذ الجسر)، `index.ts` (المسارات، حالة القناة من
  البوابة، `gateway` في القائمة، بطاقة هرمز)، `service.ts` و`serialize.ts` و`ports.ts`؛
  `modules/models/propagation.ts` (`writeHermesRoute`)، `service.ts` (`prepareGateway`)، `index.ts`
  (المنفذ).
- العقد: `packages/contracts/openapi.yaml`.
- الويب: `agents/AgentChannelsScreen.tsx`، `agents/skills.ts`، `agents/toolErrors.ts`،
  `agents/AgentManagerScreen.tsx`، `i18n/ar.json` و`en.json`؛ `e2e/hub.ts` (هرمز مُمثَّل للاقتران
  وجلسة الربط)، رحلة جديدة 30 `e2e/zzzzz-channels-pairing.spec.ts`.
- الاختبارات: `hermes-gateways.test.ts`، `hermes-pairing.test.ts`، `channels-gateway.routes.test.ts`،
  إضافات `channels.test.ts`، `tests/unit/gateway-providers.test.ts` (إعادة إنتاج `Unknown provider`)،
  `tests/unit/gateways.real.test.ts` (هرمز الحقيقي)، `packages/web/tests/channels-pairing.test.tsx`.
- الوثائق: `docs/STATUS.md`، `docs/contracts/DECISIONS.md` §38، هذا السجل.

**الذاكرة**: بوابة إضافية (~200 م.ب) لكل بروفايل مسمّى فيه قناة مفعّلة ومربوطة، ولا شيء لغيره.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run` (حدّ ذاكرة 7 غ.ب)، بعد دمج `origin/main` (#92 ثم #90) في الفرع.

إعادة إنتاج `Unknown provider` **قبل الإصلاح** (منفذ `prepareGatewayProfile` معطّل مؤقتًا)، ثم بعده.
المرة الأولى على `main` القديم فشل الاختباران معًا؛ بعد دمج #90 صار الجذر سليمًا، فكتبت حالة ما زالت
تفشل مع #90 وحده (البروفايل المسمّى نسخة من الافتراضي، ثم حُذف المزوّد الذي يسمّيه ملفه):
```
$ vitest run --project unit tests/unit/gateway-providers.test.ts   # بلا الإصلاح، على main القديم
     × the default one, after another profile's save rewrote the root file 1809ms
     × a named profile one, on the model that profile chats with 1674ms
AssertionError: providers.majlis-custom-cli-proxy-api (Hermes: "Unknown provider 'majlis-custom-cli-proxy-api'"): expected undefined to be defined
$ vitest run --project unit tests/unit/gateway-providers.test.ts   # بلا الإصلاح، بعد دمج #90
     × a named profile one, after the provider its copied file names was removed 1731ms
AssertionError: providers.majlis-custom-cli-proxy-api (Hermes: "Unknown provider 'majlis-custom-cli-proxy-api'"): expected undefined to be defined
      Tests  1 failed | 1 passed (2)
$ vitest run --project unit tests/unit/gateway-providers.test.ts   # بالإصلاح (ومعه حالة المزوّد الخاص بالبروفايل)
      Tests  3 passed (3)
```

هرمز الحقيقي من الصورة (`ghcr.io/twuijri/majlis:latest`، ثلاث بوابات في حاوية واحدة كما في الإنتاج):
```
$ MAJLIS_HERMES_IMAGE=ghcr.io/twuijri/majlis:latest vitest run --project unit --reporter=verbose --silent=false tests/unit/gateways.real.test.ts
the container with three gateways: 642.4MiB / 28.52GiB; provider calls: 18
 ✓ … runs the default gateway and «manger»'s side by side, each answering through the custom provider 8898ms
 ✓ … fires «reports»'s scheduled job in its own gateway, with no channel there, and leaves the one kanban dispatcher to the default gateway 63300ms
 ✓ … lists, approves, denies and revokes pairing requests in «manger» through Hermes's API 3034ms
      Tests  3 passed (3)
```
(في محاولة قبلها ظهر في سجلّ هرمز: «another gateway already holds the dispatcher lock … will NOT dispatch» —
قفل هرمز الاحتياطي يعمل، لكن المتغيّر لم يصل لأن غلاف الاختبار كان يسقطه؛ بعد تمريره يقول سجلّ البوابتين
المسمّاتين «disabled via HERMES_KANBAN_DISPATCH_IN_GATEWAY».)

باقي الفحوص:
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck            # exit 0، صفر أخطاء
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 257 client file(s) scanned, 172 contract path(s) known.
$ pnpm i18n:check
i18n:check  web: 1117 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/server test
 Test Files  96 passed | 14 skipped (110)
      Tests  998 passed | 41 skipped (1039)
$ pnpm --filter @majlis/web test
 Test Files  48 passed (48)
      Tests  573 passed (573)
$ pnpm contract:test
 Test Files  3 passed (3)
      Tests  264 passed (264)
$ pnpm build               # exit 0
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e --workers=1
  ✓  23 … 23. the agent tools ask Hermes: an MCP test, a skill pack imported, WhatsApp linked by QR (7.6s)
  ✓  40 … 30. a linked WhatsApp: how to use it, the senders waiting for approval, and Unlink (1.1s)
  43 passed (2.7m)
```
لقطات الشاشة: أُعيدت كل لقطة لا علاقة لها بالقنوات إلى ما كانت عليه؛ لقطات القنوات فقط تغيّرت أو أُضيفت
(`agent-channels-pairing-ar-light.png` و`agent-channels-unlinked-ar-light.png` جديدتان).

## المخاطر والرجوع
- **مخاطر**: مهام مجدولة في بروفايل مسمّى لم تكن تعمل قط صارت تعمل (هذا المقصود، لكنه جديد: مهمة
  قديمة منسية في بروفايل ستبدأ بالعمل وتستهلك من المزوّد). بروفايل فيه مهمة نشطة يكلّف بوابة (~200
  م.ب) ولو بلا قناة. منصّات تفتح منفذًا (webhook
  وغيرها) على المنفذ نفسه في بروفايلين تتعارض؛ المركز يوزّع منافذ جسر واتساب فقط، والباقي إعداد
  الشخص. رفض الطلب تعديل مباشر لملف هرمز (لا فعل له في هرمز): إن غيّر هرمز شكل الملف فشل الرفض بـ404 لا
  أكثر. إلغاء الربط لا يسجّل خروجًا من واتساب؛ الصفحة تقول ذلك.
- **الرجوع**: عكس الدمج. بوابات البروفايلات تتوقّف مع المركز القديم ولا تُشغَّل؛ `bridge_port` المكتوب
  في `config.yaml` بروفايل يبقى ولا يضرّ؛ الموافقات ملفات هرمز نفسها.

## التسليم والخطوة التالية
- طلب الدمج: https://github.com/twuijri/core-hub/pull/93 (بالإنجليزية إلى `main`)؛ بعد الدمج صورة التست عند طلب المالك.
- للمالك: في «manger» بعد التحديث يظهر واتساب «مربوطًا» وتعمل بوابته فورًا؛ راسله من رقم آخر ووافق
  من «طلبات بانتظار الموافقة».
- دُمج #90 في الفرع: تجهيز البوابة يستعمل تجهيز #90 للبروفايل نفسه مع النموذج (لا كاتب ثانٍ للمزوّدات).
- قرار العقد صار §38 (أخذ #90 الرقم §37). لا ترحيل في هذا الطلب؛ ترحيلات `main` حتى `0012` لا تتعارض.
