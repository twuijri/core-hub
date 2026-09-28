# أدوات الجدولة عند الوكيل: سبب فشل آخر تشغيل
المسؤول: aboawadh · الفرع: fix/schedule-tools-last-error · الحالة: review

## المشكلة والهدف
الوكيل الذي يُسأل «ليش ما وصل التذكير؟» لا يملك إلا «فشل» بلا سبب. أدوات الجدولة في أدوات المركز
(`schedules.list` و`schedules.create` و`schedules.pause`) تمرّر من صف الجدولة ما في `SCHEDULE_KEYS` فقط، وهي لا تشمل
`last_error` ولا `last_delivery_error`، مع أن المركز يخزّنهما مما يعيده Hermes (`schedules/service.ts`) ويعيدهما في رد REST
للجدولة، والويب يعرضهما. ظهر هذا مع خلل المهام المجدولة على نقطة نهاية (#216): جرّب الوكيل تذكيرًا ففشل، ولم يستطع أن
يقول السبب (`No LLM provider configured`)، وطلب «سجل التشغيل».

الهدف: أن يرى الوكيل سبب فشل آخر تشغيل كما يراه الشخص نفسه في الويب، بلا مسار جديد ولا أداة جديدة.

## القرار والموافقات
- `last_error` و`last_delivery_error` في `SCHEDULE_KEYS`، فتعيدهما الأدوات الثلاث حين يكونان في الصف: `null` تبقى `null`،
  والمفتاح الغائب (صف من مركز لا يحمله) يبقى غائبًا ولا يُصنع.
- يُعرضان كلما كانا في الصف، لا عند الفشل فقط: الوكيل يقرؤهما مع `last_status` و`last_run_at`، لأن النص قد يكون عن تشغيل
  سابق.
- وصف `schedules.list` يقول معناهما: `last_error` سبب فشل التشغيل نفسه، و`last_delivery_error` سبب عدم تسليم رده.
- لا صلاحية جديدة: أدوات المركز تعمل بصفة الشخص نفسه عبر مسارات REST نفسها، فلا يرى الوكيل إلا ما يراه ذلك الشخص في
  الويب. ولا اقتطاع ولا تنقيح خاص بالأدوات: إن لزم يومًا فمكانه حدّ REST، ليصح للويب والوكيل معًا.
- رأي ثانٍ من Codex على التصميم: وافق على الإضافة الدنيا دون حقل ملخص، واقترح وصف الحقلين في الأداة، واختبار أن بقية
  حقول الصف لا تمر وأن الغائب لا يُصنع؛ أُخذ بها كلها.

الموافقات: مقترح لمراجعة المالك.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. `GET /schedules` يعيد الحقلين أصلًا، ومخرجات أدوات المركز تُشكَّل في `catalog.ts`.

## الملفات والتأثير
- `packages/server/src/modules/agents/hub-tools/catalog.ts` — الحقلان في `SCHEDULE_KEYS`، ووصف `schedules.list`.
- `packages/server/src/modules/agents/hub-tools/hub-tools.test.ts` — اختباران: القائمة (مع صف أقدم بلا الحقلين، وحقول الصف
  الأخرى لا تمر)، والإنشاء والإيقاف.
- الأثر: رد الأدوات الثلاث يزيد حقلين حين يكونان في الصف، ولا شيء غير ذلك.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm --filter @corehub/server exec vitest run src/modules/agents/hub-tools/hub-tools.test.ts src/modules/agents/hub-tools/hub-tools.routes.test.ts
 Test Files  2 passed (2)
      Tests  26 passed (26)

$ pnpm --filter @corehub/server typecheck
(exit 0)

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm exec vitest run --project unit --maxWorkers=4   (linux, node v24.21.0, LANG=C.UTF-8)
 Test Files  200 passed | 32 skipped (232)
      Tests  2021 passed | 90 skipped (2111)

$ pnpm contract:test   (linux)
 Test Files  20 passed (20)
      Tests  428 passed (428)
```

```
$ pnpm change-record:check
$ node scripts/check-change-record.mjs
change-record  OK — 1 record(s) valid
```

## المخاطر والرجوع
- نص خطأ Hermes يصل إلى سياق الوكيل كما يصل إلى الويب للشخص نفسه، ولا يتغير به شيء آخر.
- الرجوع: إرجاع الطلب.

## التسليم والخطوة التالية
بعد الدمج: الوكيل المسؤول عن تذكير فشل يقرأ السبب من `schedules.list` ويقوله، بدل «فشل بلا سبب».
