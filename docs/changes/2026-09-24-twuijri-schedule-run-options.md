# خياران لكل جدول: «شغّله لو فات وقته» و«إذا كان التشغيل السابق لسا شغّال»
المسؤول: twuijri · الفرع: feat/schedule-run-options · الحالة: review

## المشكلة والهدف
بعد #92 صار المجلس يُطلق جداوله بقاعدتين ثابتتين للجميع (كانتا «مقترح — ينتظر تأكيد المالك»): ما فات
أثناء التوقف بأقل من ٢٤ ساعة يعمل مرة عند العودة، وما يحلّ والتشغيل السابق لم ينتهِ يُتخطّى. قرّر المالك
(2026-09-24) أن يصير كلٌّ منهما **خيارًا لكل جدول**:

1. «شغّله لو فات وقته (خلال ٢٤ ساعة)»، **مطفأ افتراضيًا**. بكلام المالك:
   «اذا ما حطيت عليه علامه ما يشغل اذا فات لانه مرات الشي لزم ينرسل بوقت بالضبط علشان ما ينحاس المستخدم».
2. «إذا كان التشغيل السابق لسا شغّال» بأربعة اختيارات: «تخطَّ»، «انتظر ثم شغّل» (**الافتراضي**، ينتظر
   موعد واحد على الأكثر)، «شغّل معه»، «أوقف السابق».

الهدف: الخياران في العقد، ويعمل بهما المُجدول، ويُضبطان من الويب عند الإنشاء ومن بطاقة الجدول، ويأخذ كل
جدول قائم الافتراضي بهجرة.

## القرار والموافقات
- **قرار المالك (2026-09-24)**: الخياران ومعناهما وافتراضهما (مطفأ، و«انتظر ثم شغّل»)، وأن «شغّله الآن» لا
  يُتخطّى أبدًا. هذا يُنهي «المقترح» في سجل #92.
- **مهلة التأخر (مقترح — ينتظر تأكيد المالك)**: الموعد المتأخر حتى **دقيقتين** ليس «فائتًا» ويعمل أيًّا كان
  الخيار — المُجدول ينظر كل ١٥ ثانية، وانتظار نظرة ليس فواتًا. أكثر من دقيقتين: يعمل مرة إن كان الخيار
  مُعلَّمًا والتأخر ≤ ٢٤ ساعة؛ وإلا يُسجَّل في السجل «تُخطّي» بالسبب
  («missed: the hub was not running at …, and this schedule does not run a missed time» أو
  «…, more than 24 hours ago»)، ويكمل الجدول من الآن (`scheduler.ts` → `missedReason`، `LATE_GRACE_MS`).
- **التداخل** (`overlap`):
  - `skip`: يُسجَّل «skipped: the previous run was still going».
  - `wait` (الافتراضي): يُحجز الموعد سطرًا `queued` عليه `waiting` ولا يبدأ؛ حين **ينتهي** تشغيل الجدول
    (أي نهاية: نجاح، فشل، إلغاء، ومنها تشغيل «شغّله الآن») يبدأ فورًا (`ScheduleRuns.release`، يُؤخذ بـ
    compare-and-set فيبدأ مرة واحدة). **ينتظر موعد واحد فقط**؛ ما يحلّ بعده يُسجَّل «skipped: the previous run
    was still going and another time was already waiting for it». إن أُوقف الجدول أثناء الانتظار لا يبدأ
    ويُسجَّل «skipped: the schedule was paused while this time was waiting».
  - `parallel`: يبدأ في جلسة (أو تشغيل سير عمل) خاصة به بجانب السابق.
  - `replace`: يُحسم سطر السابق `cancelled` بسبب «stopped: the next run of this schedule replaced it»، ثم
    يُلغى تشغيله فعلًا — دور الجلسة كما يفعل زر «إيقاف» في المحادثة (منفذ `cancel` الجديد في
    `ScheduleRunPorts`)، وتشغيل سير العمل كما يفعل «إلغاء» (استُخرج `cancelWorkflowRunNow` ليستعمله المسار
    والمُجدول معًا) — وينتظر انتهاء دور الجلسة حتى ٣٠ ثانية، ثم يبدأ الجديد.
- **«شغّله الآن» (مقترح — ينتظر تأكيد المالك في تفصيله)**: يبدأ فورًا دائمًا بجانب ما يعمل، ولا يوقف شيئًا
  ولا ينتظر، أيًّا كان الخيار — شخص طلبه الآن؛ والخيار يحكم مواعيد الجدول وحدها. لكن تشغيله يُعدّ «التشغيل
  السابق» لموعد الجدول التالي.
- **إعادة التشغيل**: سطر كان ينتظر وانتهى ما ينتظره بالانقطاع يُحكم عليه بقاعدة الفوات نفسها، مقيسةً من
  موعده: في وقته (≤ دقيقتين) أو (الخيار مُعلَّم و≤ ٢٤ ساعة) → يبدأ عند العودة؛ وإلا يُسجَّل
  «missed: the hub restarted while this time was waiting». وسطر ينتظر تشغيلًا ما زال يعمل بعد العودة (سير
  عمل عند موافقة) يبقى منتظرًا (`ScheduleRuns.settleStranded` → `settleWaiting`).
- **هرمز**: قرأتُ مصدر هرمز (MIT) عند الوسم المثبّت `v2026.9.14` (`cron/jobs.py`، `cron/scheduler.py`،
  `hermes_cli/config_defaults.py`). **لا إعداد لكل مهمة** لأيٍّ منهما: الفوات يحكمه `cron.catch_up_missed`
  **لكل البروفايل** (مفعّل افتراضيًا، بمهلة نصف فترة المهمة بين دقيقتين وساعتين)، والمهمة التي ما زالت تعمل
  **تُتخطّى دائمًا** («already running — skipping»). فالخياران **مخفيّان** لجداول هرمز في الويب، و`null` في
  الـAPI، وكتابتهما على جدول هرمز `409 hermes_run_options`. رفضتُ ربط الخيار الأول بـ`cron.catch_up_missed`
  لأنه يغيّر كل مهام البروفايل من جدول واحد.
- **قاعدة البيانات**: «شغّله لو فات وقته» هو عمود `misfire_policy` الموجود أصلًا (`skip` = مطفأ،
  `run_once` = مُعلَّم)؛ والتداخل عمود **جديد** `overlap` (افتراضه `wait`) لأن `CHECK` العمود القديم
  `overlap_policy` لا يعرف `replace`، وتغيير `CHECK` في SQLite يعني إعادة بناء `schedules`، وهذا داخل معاملة
  المُرحِّل يحذف سجلّ كل جدول (`ON DELETE CASCADE`) — الخطر نفسه الذي عالجه #92. العمود القديم باقٍ غير
  مقروء (موثّق في `schema.ts`). و`schedule_runs.waiting` جديد.
- الخريطة (Graphify) لم تُستعمل: الوحدة معروفة من #92 وقُرئت مباشرة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `Schedule`: حقلان مطلوبان `run_if_missed` (boolean|null) و`overlap` (`ScheduleOverlap`|null)؛ `null` لجدول
  في مُجدول وكيل (`external`).
- `ScheduleWrite`: `run_if_missed` و`overlap` اختياريان (الافتراض عند الإنشاء: `false` و`wait`).
- مخطط جديد `ScheduleOverlap`: `skip | wait | parallel | replace`.
- `ScheduleRun.waiting` (مطلوب).
- `schedules.create` و`schedules.update` يوثّقان `409` (كانت رفوض هرمز `409` بلا توثيق).
- أحداث `/rt/schedules` (`schedule.created/updated/fired`، `schedule_run.*`) و`common.schema.json`: المخططات
  والأمثلة بالحقول الجديدة.
- `docs/contracts/DECISIONS.md` **§40**.

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml`، `packages/contracts/events/common.schema.json`،
  `packages/contracts/events/schedules/*.schema.json` (٦).
- الخادم: `modules/schedules/{schema,service,scheduler,schedule-runs,index,hermes-cron}.ts`،
  `modules/index.ts` (منفذ `cancel`)، هجرة `drizzle/0014_schedule_run_options.sql` واللقطة.
- اختبارات الخادم: `scheduler.test.ts` (ساعة مزيّفة: الافتراض المطفأ، مهلة الدقيقتين، المُعلَّم ≤ ٢٤ ساعة،
  أقدم من ٢٤ ساعة، الاختيارات الأربعة، قاعدة المنتظر الواحد، الحفظ والتعديل؛ واختبارا الفوات والتخطّي القديمان
  صارا يقولان الخيار صراحة)؛ `tests/unit/schedule-runs.test.ts` (جلسات حقيقية: الانتظار ثم البدء عند
  النهاية ومنتظر واحد، التخطّي، «شغّل معه»، «أوقف السابق» يوقف الدور فعلًا، «شغّله الآن» مع كل اختيار،
  الإيقاف أثناء الانتظار، وإعادة التشغيل مع سطر منتظر مطفأً ومُعلَّمًا)؛ `hermes-cron.test.ts` (لا خيارات
  لهرمز و`409`)؛ `tests/unit/schedule-run-options-migration.test.ts`؛ `tests/contract/schedules.contract.test.ts`.
- الويب: جديد `src/schedules/RunOptions.tsx`؛ معدّل `SchedulesScreen.tsx` (قسم «خيارات التشغيل» في نموذج
  الإنشاء لغير هرمز، وزرّ «خيارات التشغيل» في بطاقة كل جدول للمجلس يحفظ كل تغيير فورًا، ورسالة
  `hermes_run_options`)، `ScheduleRuns.tsx` (السطر المنتظر: «ينتظر انتهاء التشغيل السابق»)،
  `i18n/{ar,en}.json` (`schedules.options.*`، `schedules.history.waiting`، `schedules.hermes.run_options`).
  اختبار جديد `tests/schedule-run-options.test.tsx` (٤).
- Playwright: الرحلة **30** في `e2e/zzzzz-hub-schedules.spec.ts`؛ لقطة جديدة `schedule-run-options-ar-light.png`،
  وتغيّرت `schedules-ar-light`، `schedules-hub-run-ar-light`، `workflow-approval-ar-light`،
  `all-profiles-schedules-ar-light` (زرّ «خيارات التشغيل» وقسم النموذج)؛ وأُعيدت سائر اللقطات إلى `main`.
- المستندات: `docs/STATUS.md` (صف الجدولة وفقرة الويب)، `docs/contracts/DECISIONS.md` §39.

## الفحوص (الأوامر ونواتجها الفعلية)
كل الأوامر الثقيلة عبر `mj-run` (ذاكرة ٧ غ، عاملان). Playwright على المنفذين 8893/8894 لأن 8791 كان
مشغولًا بعميل آخر.
```
$ pnpm lint                      # exit 0 — All matched files use Prettier code style!
$ pnpm typecheck                 # exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 259 client file(s) scanned, 172 contract path(s) known.
$ pnpm i18n:check
i18n:check  server: 140 keys, ar/en in parity
i18n:check  cli: 249 keys, ar/en in parity
i18n:check  web: 1135 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm change-record:check
change-record  OK — 1 record(s) valid
$ pnpm contract:test
 Test Files  3 passed (3)
      Tests  265 passed (265)
$ pnpm --filter @majlis/server test
 Test Files  97 passed | 14 skipped (111)
      Tests  1014 passed | 41 skipped (1055)
$ pnpm --filter @majlis/web test
 Test Files  49 passed (49)
      Tests  578 passed (578)
$ pnpm build                     # exit 0
$ MAJLIS_E2E_PORT=8893 MAJLIS_E2E_SETUP_PORT=8894 PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  44 passed (2.8m)
```
**تفشل على الكود القديم** — نسخة عمل مؤقتة على `e290ffb` (`main` قبل هذا الفرع) بالاختبارات الجديدة فقط:
```
$ vitest --project unit scheduler.test.ts schedule-runs.test.ts hermes-cron.test.ts schedule-run-options-migration.test.ts
      Tests  16 failed | 28 passed (44)
$ vitest --project contract schedules.contract.test.ts
     × a schedule carries its run options, and a time waiting for the previous run says so
$ vitest tests/schedule-run-options.test.tsx      (web)
      Tests  4 failed (4)
$ playwright test zzzzz-hub-schedules.spec.ts -g "30\."
  ✘ 30. a schedule's run options: set when it is made, changed from its card, none for Hermes
```
الناجحة على القديم هي ما كان سلوكه أصلًا: «skips when told to» (كان التخطّي للجميع) و«"Run now" starts at
once…»، والاختبارات السابقة في الملفات نفسها.

## المخاطر والرجوع
- **تغيّر سلوك الجداول القائمة**: كانت كلها تُشغِّل الفائت خلال ٢٤ ساعة، وصارت بعد الهجرة **لا تُشغّله**
  (قرار المالك)، وكانت تتخطّى عند التداخل وصارت **تنتظر**. من أراد السلوك القديم يعلّم الخيار أو يختار «تخطَّ».
- **«أوقف السابق»** يوقف دورًا فعليًا؛ إن تجاهل الوكيل طلب الإيقاف يبدأ الجديد بعد ٣٠ ثانية بجانبه، وسطر
  السابق محسوم «أُوقف» من قبل.
- **سطر منتظر** لا يبدأ إلا بنهاية تشغيل في هذا الخادم أو عند إعادة التشغيل؛ خادمان على قاعدة واحدة: نهاية
  تشغيل في أحدهما تبدأ المنتظر فيه (compare-and-set يمنع التكرار).
- **عمود `overlap_policy` القديم** باقٍ ميتًا؛ حذفه يحتاج إعادة بناء الجدول مع حفظ السجل — ليس الآن.
- **تعارض محتمل**: هجرة `0014` — #94 أخذ `0013` فأُعيد توليد هذه بعد دمج `main`؛ إن دُمجت قبلها هجرة أخرى تُعاد برقم تالٍ.
- الرجوع: الفرع وحده؛ الرجوع بعد ترحيل القاعدة يترك عمودين لا تقرؤهما النسخة الأقدم (آمن).

## التسليم والخطوة التالية
طلب دمج إلى `main` بالإنجليزية. الدمج للمالك.
الخطوة التالية: تأكيد المالك لمهلة الدقيقتين، ولسلوك «شغّله الآن» مع «أوقف السابق» و«انتظر» (يبدأ فورًا ولا
يوقف شيئًا).
