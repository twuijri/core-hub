# مهلة إقلاع Hermes: قابلة للضبط، وبوابة TUI تُوقَف عند انقضائها
المسؤول: aboawadh · الفرع: fix/hermes-start-timeout · الحالة: review

## المشكلة والهدف
المركز يشغّل عند الطلب عمليتين من Hermes، ويوقف كلًّا منهما إن لم تقل «جاهزة» خلال 60 ثانية ثابتة:
- واجهة Hermes الداخلية (`hermes serve`، `hermes-dashboard.ts`) التي تُقرأ منها محادثات تيليجرام وواتساب: يكتب السجل
  `dashboard API did not become ready; stopping it`، والقائمة تقول «Couldn't read the channel conversations from Hermes just
  now; showing what was last read»، وتبقى فارغة إن لم تُقرأ قط.
- بوابة TUI (`python -m tui_gateway.entry`، `adapters/hermes-tui.ts`) التي تمر منها كل محادثة من المركز: يفشل التشغيل بـ
  `the Hermes TUI gateway did not start (agent_error)`.

إقلاع Hermes ثقيل، وعلى مضيف مزدحم يتجاوز الدقيقة: على خادم بثمانية أنوية وحاوية محدودة بثلاث، مع ضغط معالج (PSI cpu some
avg60 نحو 56%)، وقعت خمس حالات في ست ساعات على أربعة مراكز؛ وإقلاع يدوي للبوابة في الحاوية نفسها أخذ 24.5 ثانية والحمل
3.7، ويتضاعف تحت الزحام.

وخلل ثانٍ في بوابة TUI: عند انقضاء المهلة كان `stdioTuiChannel` يرفض وعد الجاهزية فقط، ويترك العملية حيّة و`alive` صحيحة.
فيعيد `HermesRuntime.tuiChannel()` القناة نفسها لكل محادثة تالية، وكل واحدة تنتظر الوعد المرفوض فتفشل فورًا بالرسالة نفسها،
إلى أن تخرج العملية وحدها (رأينا عملية عمرها 17 دقيقة والمحادثات تفشل عليها واحدة بعد أخرى).

الهدف: مهلة تكفي مضيفًا مزدحمًا وقابلة للضبط، وبوابة لم تجهز تُوقَف فيبدأ الطلب التالي بواحدة جديدة.

## القرار والموافقات
- متغيّران في `app/config.ts` بنمط `COREHUB_PLUGIN_TIMEOUT_MS`، منفصلان لأن الواجهة الداخلية عمل خلفي يُستعاد، والبوابة على
  مسار انتظار المحادثة:
  - `COREHUB_HERMES_DASHBOARD_START_TIMEOUT_MS` — افتراضيًا 180000.
  - `COREHUB_HERMES_TUI_START_TIMEOUT_MS` — افتراضيًا 120000.
  كلاهما عدد صحيح بين 10000 و1800000. يُمرَّران إلى `HermesDashboard` (`startTimeoutMs`) وإلى `HermesRuntime`
  (`tuiReadyTimeoutMs` ← `stdioTuiChannel.readyTimeoutMs`)، وكلا الصنفين يقبل الخيار أصلًا ولم يكن شيء يمرّره.
- عند انقضاء مهلة البوابة: `gone()` ثم `child.kill()` — تُرفض الطلبات المنتظرة، و`alive` تصير خاطئة، ويسمع `onExit` السبب،
  فيُسقط `HermesRuntime` القناة ويبدأ الطلب التالي عملية جديدة.
- `onReady(elapsedMs)` جديد في القناة، و`HermesRuntime` يسجّل مدة الإقلاع: معلومة عادةً، وتحذير فوق 30 ثانية، ليُرى المضيف
  البطيء قبل أن تنقضي المهلة.
- رفع الافتراضي من 60 ثانية تغيير سلوك لا يكسر شيئًا: إقلاع عالق حقًا يظهر بعد دقيقتين أو ثلاث بدل دقيقة.
- رأي ثانٍ من Codex: اقترح الفصل بين المتغيرين، وإيقاف العملية عند الانقضاء مع إعادة محاولة نظيفة، وتسجيل مدة الإقلاع؛
  أُخذ بها. ونبّه إلى أن مهلة الطلب بعد الجاهزية (60 ثانية في الواجهة الداخلية) تبدأ بعد الجاهزية فلا تأكل المهلة، وهو كذلك
  في الكود الحالي.

الموافقات: مقترح لمراجعة المالك.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/src/app/config.ts` — المتغيّران، وحقلا `hermesDashboardStartTimeoutMs` و`hermesTuiStartTimeoutMs`.
- `packages/server/src/modules/agents/index.ts` — تمريرهما إلى `HermesDashboard` و`HermesRuntime`.
- `packages/server/src/modules/agents/hermes-runtime.ts` — `tuiReadyTimeoutMs`، وتسجيل مدة إقلاع البوابة.
- `packages/server/src/modules/agents/adapters/hermes-tui.ts` — إيقاف العملية عند انقضاء المهلة، و`onReady`.
- `packages/server/tests/unit/config.test.ts`، `packages/server/src/modules/agents/adapters/hermes-tui-commands.test.ts` —
  الاختبارات.
- `docs/DEPLOY.md` — صفّان للمتغيّرين.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm --filter @corehub/server exec vitest run tests/unit/config.test.ts src/modules/agents/adapters/hermes-tui-commands.test.ts
 Test Files  2 passed (2)
      Tests  27 passed (27)

$ pnpm --filter @corehub/server typecheck
(exit 0)

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm exec vitest run --project unit --maxWorkers=4   (linux, node v24.21.0, LANG=C.UTF-8)
 Test Files  233 passed | 38 skipped (271)
      Tests  2280 passed | 147 skipped (2427)

$ pnpm contract:test   (linux)
 Test Files  20 passed (20)
      Tests  441 passed (441)
```

```
$ pnpm change-record:check
$ node scripts/check-change-record.mjs
change-record  OK — 1 record(s) valid
```

## المخاطر والرجوع
- إقلاع عالق حقًا يظهر بعد دقيقتين (البوابة) أو ثلاث (الواجهة) بدل دقيقة؛ ويُختصر بضبط المتغيّر.
- الرجوع: إرجاع الطلب، أو `COREHUB_HERMES_*_START_TIMEOUT_MS=60000` لسلوك المهلة القديم دون إرجاع إيقاف البوابة.

## التسليم والخطوة التالية
بعد الدمج: على مضيف مزدحم يُقرأ في السجل `hermes: the TUI gateway started` / `was slow to start` مع `elapsedMs`، ولا تتكرر
رسالة «did not start» على محادثات متتالية.
