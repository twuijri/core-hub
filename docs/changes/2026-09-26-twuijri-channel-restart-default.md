# كل تغيير في القنوات يعيد تشغيل بوابة البروفايل الافتراضي
المسؤول: twuijri · الفرع: fix/channel-restart-default · الحالة: review

## المشكلة والهدف
المالك (٢٠٢٦-٠٩-٢٦): «التيليقرام المفروض يسوي رستارت بعد». PR #157 جعل ربط واتساب بالـQR يعيد تشغيل
بوابة البروفايل الافتراضي (`channelLinked`)، لكن بقية تغييرات القنوات تمر عبر `followChannels` →
`runtime.channelsChanged`، وهذه لا تفعل شيئًا في البروفايل الافتراضي وتقول `applies: 'on_restart'`.
فتيليقرام (وديسكورد وسلاك وماتريكس وماترموست والبريد والمنصات العامة) المربوط في الافتراضي يبقى صامتًا
حتى يضغط أحد «إعادة التشغيل»، وكذلك حفظ إعداداتها وتشغيلها وإيقافها ومسحها.
الهدف: كل تغيير في القنوات يسري فورًا في كل بروفايل، مع إعادة تشغيل واحدة لكل دفعة تغييرات متتالية.

## القرار والموافقات
- دمج `channelLinked` في `HermesRuntime.channelsChanged(profile)` بمعنى واحد: البروفايل المسمّى كما كان
  (تشغيل/إعادة تشغيل/إيقاف بوابته)، والافتراضي يُوقَف لحظة ويُشغَّل من جديد (`withGatewayStopped`، كما في
  تغيير أدوات الهب §79). حُذف `channelLinked`؛ مسار ربط واتساب يستدعي `channelsChanged`.
- تأجيل لاحق (trailing debounce) لكل بروفايل: التغييرات التي تصل خلال `channelSettleMs` (افتراضيًا ١ ث)
  من بعضها تُطبَّق مرة واحدة بعد آخرها، والوعد يُحسم بعد تلك الإعادة. `followChannels` في المسارات يبقى
  غير منتظَر كما كان. الإيقاف (`stop`) يلغي المؤقتات المعلّقة.
- `ChannelGateway.applies` صار دائمًا `now` من هذا الهب. أثناء انتظار التأجيل لا تُعرض قناة لا تسمّيها
  البوابة الجارية كـ`restart_needed` بل `unknown` (`channelsSettling`)، فلا تظهر بطاقة «يحتاج هرمز إلى إعادة
  تشغيل» لحظةً بعد الربط. بطاقة `restart_needed` (#157) تبقى لما رُبط خارج الهب. ملاحظة #146
  (`restart_note`) تظهر الآن فقط حين لا يدير الهب هرمز (`gateway: null`) أو من هب أقدم — وهي صحيحة هناك،
  فلم تتغير أي نصوص واجهة.
- فكّ الربط وتغيير الوضع كانا أصلًا يعيدان تشغيل الافتراضي عبر `withGatewayStopped`، ولم يتغيّرا.
- DECISIONS §85 عُدّل بملاحظة قصيرة. اقتراح — للمالك التأكيد (مدة التأجيل ١ ث).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
وصف `gateway` في `agents.listChannels` ومثاله فقط (`applies: now`). التعداد `[now, on_restart]` باقٍ
لتوافق الهبات الأقدم؛ لا مسار ولا مخطط جديد. `contracts:check-clients` نظيف.

## الملفات والتأثير
- `packages/server/src/modules/agents/hermes-runtime.ts`: `channelsChanged` بالتأجيل، `channelsSettling`،
  خيار `channelSettleMs`، إلغاء المؤقتات في `stop`، حذف `channelLinked`.
- `packages/server/src/modules/agents/index.ts`: `applies: 'now'`، ربط واتساب عبر `channelsChanged`،
  `restart_needed` لا يُرفع أثناء التأجيل، تمرير `channelSettleMs` للاختبارات.
- الاختبارات: `telegram-link.routes.test.ts` (خمسة اختبارات جديدة + تحديث اختبار الافتراضي)، و`channelSettleMs: 5`
  في إقلاع `channels-gateway.routes.test.ts` و`channel-link.routes.test.ts` و`gateway-providers.test.ts`.
- `packages/contracts/openapi.yaml`، `docs/contracts/DECISIONS.md` (§85)، `docs/STATUS.md`، تعليق في
  `packages/web/src/agents/skills.ts`.
- الأثر: البروفايل الافتراضي يحمل خادم الـAPI، فكل دفعة تغييرات في القنوات توقفه لحظة (ثوانٍ).

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبارات الجديدة على الكود القديم (بعد `git stash` لملفي `hermes-runtime.ts` و`index.ts`) — تفشل كلها:
```
     × in the default profile, restarts its gateway so the bot answers without a Restart 711ms
     × linking Telegram restarts the default gateway exactly once 1687ms
     × saving Telegram settings restarts it exactly once 1745ms
     × switching Telegram off restarts it exactly once 1823ms
     × unlinking Telegram restarts it exactly once 1837ms
     × a burst of changes restarts it once, after the last 1802ms
      Tests  6 failed | 10 passed (16)
```
(اختبار فكّ الربط يفشل على القديم لأن خطوة الربط قبله لا تعيد التشغيل؛ فكّ الربط نفسه كان يعيد التشغيل.)

وعلى الكود الجديد:
```
$ vitest run src/modules/agents/telegram-link.routes.test.ts
 Test Files  1 passed (1)
      Tests  16 passed (16)
$ vitest run src/modules/agents/channels-gateway.routes.test.ts src/modules/agents/channel-link.routes.test.ts tests/unit/gateway-providers.test.ts
 Test Files  3 passed (3)
      Tests  28 passed (28)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 622 client file(s) scanned, 230 contract path(s) known.
```
CI على PR #158 (التشغيل 36197411226 وما معه) — كلها ناجحة:
```
Server unit tests (shard 1/3)	pass	4m4s
Server unit tests (shard 2/3)	pass	3m10s
Server unit tests (shard 3/3)	pass	2m3s
Lint, typecheck, contracts, client tests, build	pass	6m13s
Web smoke journeys (Playwright against the real hub)	pass	7m17s
Docker image builds and answers /health	pass	2m39s
Build and test on the iOS simulator	pass	6m3s
Android build, unit tests, lint	pass	2m22s
```

## المخاطر والرجوع
- كل تغيير في قنوات الافتراضي يقطع خادم الـAPI لحظة (محادثة جارية عبر بوابة TUI لا تتأثر؛ هي عملية منفصلة).
  التأجيل يجمع الدفعات فلا تتكرر الإعادة.
- البروفايلات المسمّاة صارت تنتظر ١ ث قبل أن تتبع بوابتها.
- الرجوع: إعادة هذا الـPR.

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية، لا دمج. بعد الدمج يدخل في 1.1.1.
