# الغرف، الجزء الثاني: الوكلاء يجيبون في الغرفة ويمرّرون الدور
المسؤول: twuijri · الفرع: feat/rooms-agents (مكدّس فوق feat/rooms) · الحالة: review

## المشكلة والهدف
بعد الجزء الأول تُحفظ الرسائل وتُذكر المقاعد، لكن لا وكيل يجيب. الهدف: رسالة تذكر وكيلًا
تبدأ دورًا له سياقه نص الغرفة (مقلَّمًا)، وردّه يُبثّ في الغرفة بمؤشرات الكتابة والتقدّم،
ومجيب افتراضي حين لا يُذكر أحد، وتمرير الدور بين الوكلاء بحارس للحلقات وحدّ للعمق، والإيقاف.
كل ما هنا **مقترح — ينتظر تأكيد المالك** (قرار العقد §57).

## القرار والموافقات
- **المجيب الافتراضي**: مقعد القائد (أول مقعد يُضاف، يتغيّر من لوحة الأعضاء، ويمكن إلغاؤه).
- **الدور** تشغيلة في محادثة المقعد نفسها، وموجّهه الغرفة كما **لم يرها** المقعد بعد: من هو،
  دوره وتعليماته، الوكلاء والناس الآخرون، كيف يمرّر الدور، ملخّص الغرفة، ثم الرسائل بعد آخر
  دور له من غيره — أحدث ٣٠ رسالة ونحو ١٢٠٠٠ حرف مع ذكر عدد ما حُذف. محادثته تحفظ ما رآه
  وقاله من قبل، فلا يُعاد عليه.
- **الرد** رسالة في الغرفة تُفتح فورًا (يكتب…) وتمتلئ من بثّ محادثة المقعد، يُعاد بثّها على
  `/rt/rooms` بمعرّف رسالة الغرفة، مع حالة المقعد (في الدور، يفكّر، يردّ، ينتظر موافقة)
  والأداة التي يستعملها.
- **التمرير**: الوكيل يكتب نصًا، فيُقرأ ردّه بحثًا عن `@اسم` مقعد آخر (أسماء كاملة، الأطول
  أولًا، لا داخل الشيفرة، لا نفسه)، وأول مقعد مذكور يأخذ الدور إن سمحت الغرفة. السلسلة تبدأ
  بأول تمرير بعد رسالة إنسان؛ `depth` عدد التمريرات. الحارس يوقفها عند **تكرار تمريرة** (من ← إلى)
  في السلسلة نفسها، أو إن تجاوز التمرير التالي `max_depth` (افتراضيًا ٣). السلسلة الموقوفة
  يمكن أن تمضي **جولة أخرى مرة واحدة**.
- **الإيقاف** يلغي أدوار المقعد الجارية والمنتظرة ويوقف سلاسله (`interrupted`). **مسح السياق**
  يُبقي الرسائل ويعطي كل مقعد محادثة جديدة ويصفّر الملخّص والرموز.
- إعادة تشغيل المركز تغلق الردود التي تركها تُبثّ وتوقف السلاسل النشطة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا تغيير في `openapi.yaml`. DECISIONS §57 أُضيفت إليه فقرات الوكلاء والتمرير والإيقاف والمسح.
خمس عمليات تجيب الآن: `stopSeat`، `listRuns`، `listHandoffs`، `continueHandoff`، `clearContext`،
و`postMessage` صار يعيد التشغيلات الحقيقية.

## الملفات والتأثير
- `packages/server/src/modules/rooms/context.ts` (قواعد صافية: الموجّه، التقليم، قراءة الذكر،
  حارس التمرير) و`conductor.ts` (الأدوار، إعادة البث، الإنهاء، التمرير، الإيقاف، التسوية بعد
  إعادة التشغيل)، وتعديلات في `index.ts` و`service.ts` و`store.ts`.
- `sessions/testing/fake-runner.ts`: خيار `scriptFor` لاختيار سيناريو بحسب الموجّه (أدوات اختبار).
- الويب: شريط التمرير و«جولة أخرى»، زر الإيقاف للمقعد المشغول، إعدادات الغرفة (`@all`، التمرير
  وحدّه)، مسح السياق، ونصوص عربية وإنجليزية. `e2e/hub.ts`: سيناريوهان لمقعدين مكتوبين.
- STATUS: 231 من 264.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
typecheck exit=0
$ vitest --project unit tests/unit/rooms-agents.test.ts tests/unit/rooms.test.ts src/modules/rooms/context.test.ts src/modules/rooms/rooms.test.ts tests/unit/status.test.ts tests/unit/task-runs.test.ts src/modules/sessions/sessions-run.test.ts src/modules/sessions/direct-run.test.ts
 Test Files  8 passed (8)
      Tests  59 passed (59)
$ vitest --project contract tests/contract/rooms.contract.test.ts tests/contract/contract.test.ts
 Test Files  2 passed (2)
      Tests  266 passed (266)
$ vitest (web) tests/rooms.test.tsx tests/navigation.parity.test.tsx tests/i18n.test.ts tests/logical-css.test.ts tests/ui-layer.test.ts
 Test Files  5 passed (5)
      Tests  208 passed (208)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome playwright test zzzzzz-rooms.spec.ts
  ✓  1 … makes a room, seats two agents, writes in it and archives it (2.6s)
  ✓  2 … an agent mentioned in the room answers and hands the next step to another (4.8s)
  2 passed (13.6s)
```
اختبار العقد يمرّ على العمليات الخمس بحالة نجاح وفشل، ويتحقق من كل حدث على `/rt/rooms`
(`message.delta`، `reasoning.delta`، `tool.*`، `run.completed`، `run.cancelled`، `handoff.updated`،
`room.cleared`) مقابل مخططه.

CI على #137 (التشغيل 36107708334) — كلها خضراء:
```
Lint, typecheck, contracts, tests, build	pass	18m49s
Web smoke journeys (Playwright against the real hub)	pass	4m16s
db:generate + db:migrate (SQLite and PostgreSQL)	pass	1m1s
Docker image builds and answers /health	pass	3m11s
PR adds or updates a change record	pass	11s
PR leaves graphify-out/ to the code-map bot	pass	11s
```

## المخاطر والرجوع
- مُثبت أمام وكلاء مكتوبين بالسيناريو، **لا أمام تشغيل Hermes حقيقي** بعد.
- الوكيل الذي يذكر مقعدًا آخر عَرَضًا («كما قال @فلان») يمرّر له الدور؛ الحارس وحدّ العمق
  يحدّان الأثر، وإعدادات الغرفة تطفئ التمرير.
- ما هو حيّ (أي تشغيلة لأي مقعد، حالة المقعد) في الذاكرة؛ إعادة التشغيل تسوّيه كما يفعل
  `tasks`.
- الرجوع: revert هذا الطلب يعيد سلوك الجزء الأول (الرسائل تُحفظ بلا أدوار).

## التسليم والخطوة التالية
الجزء الثالث (`feat/rooms-memory`): الملخّص المتدحرج حين يطول النص (`getMemory`، `putMemory`،
`refreshMemory`)، وتقارير تقدّم المهام في غرفة مشروعها.
