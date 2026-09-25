# الغرف، الجزء الثالث: الملخّص المتدحرج، وتقارير المهام في غرفة المشروع
المسؤول: twuijri · الفرع: feat/rooms-memory (مكدّس فوق feat/rooms-agents) · الحالة: review

## المشكلة والهدف
المقعد لا يُعطى إلا أحدث ما لم يره من الرسائل، فما قبلها يحتاج ملخّصًا؛ وعمليات الذاكرة
الثلاث (`getMemory`، `putMemory`، `refreshMemory`) كانت `501`. وخارطة الطريق (المرحلة ١) تقول
«تُبلِّغ المهمة عن تقدّمها في غرفة»، والفجوة التي تركها #105 في ذلك بقيت لأن الغرف لم تكن
موجودة. **مقترح — ينتظر تأكيد المالك** (§57).

## القرار والموافقات
- **الملخّص** يُعطى لكل دور مقعد، ويُعاد كتابته تلقائيًا حين تتجاوز الرسائل غير المشمولة
  `summary_policy.every_turns` (الافتراضي ٢٠، و٠ = لا تلقائي)، وبطلب المدير (مهمة `run` في
  `/rt/jobs`، و`409` إن كان تلخيص جاريًا)، أو بيده.
- **من يكتبه**: الوكيل القائد، بسؤال واحد خارج أي تشغيلة (السطح نفسه الذي يسمّي المحادثة)،
  وبنموذج الملخّص إن حُدّد. إن لم يكن للوكيل هذا السطح أو لم يجب، **يكتبه المركز بنفسه**:
  الملخّص السابق وسطر لكل رسالة جديدة، مع إبقاء أحدث ٤٠٠٠ حرف. اخترت هذا الترتيب لأن الوكيل
  يلخّص أفضل، والبديل يضمن ألا يبقى الملخّص فارغًا.
- **تقارير المهام**: المشروع الذي فيه `report_room_id` يتلقّى في غرفته سطرًا من المركز
  (`author.kind: system`) حين تبدأ تشغيلة مهمة من مهامه وحين تنتهي (أنجزت مع آخر كلام الوكيل،
  أو تعثّرت مع السبب، أو أُوقفت)، بلغة من بدأها. لا يُكتب شيء في غرفة محذوفة أو مؤرشفة.
  الربط من إعدادات الغرفة في الويب («المشروع الذي يرسل تقاريره هنا»).
- التنفيذ في جذر التركيب (`modules/index.ts`) حول منفذ تشغيل المهام، **دون لمس**
  `tasks/runs.ts` حتى لا يتعارض مع #105.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا تغيير في `openapi.yaml`. DECISIONS §57: فقرتا الملخّص وتقارير المهام. ثلاث عمليات تجيب الآن،
فتكتمل الغرف: ٢٨ من ٢٨.

## الملفات والتأثير
- `packages/server/src/modules/rooms/memory.ts` (الملخّص: موجّه الوكيل وملخّص المركز) وتعديلات
  في `service.ts` و`index.ts` و`conductor.ts` (التلخيص حين يحين بعد كل رد).
- `sessions/index.ts`: `ask` في منفذ المقاعد (إضافة).
- `modules/index.ts`: تقارير المهام في غرفة المشروع؛ `src/i18n/{ar,en}.json`: نصوص التقارير.
- الويب: قسم «الملخّص» في لوحة الأعضاء (لخّص الآن، تعديل)، واختيار مشروع التقارير في إعدادات
  الغرفة؛ نصوص عربية وإنجليزية.
- STATUS: 234 من 264؛ الغرف ٢٨ من ٢٨.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
typecheck exit=0
$ vitest --project unit tests/unit/rooms-memory.test.ts tests/unit/rooms-agents.test.ts tests/unit/rooms.test.ts src/modules/rooms/context.test.ts tests/unit/task-runs.test.ts tests/unit/status.test.ts
      Tests  53 passed (53)
$ vitest --project contract tests/contract/rooms.contract.test.ts tests/contract/contract.test.ts
      Tests  266 passed (266)
$ vitest (web) tests/rooms.test.tsx tests/i18n.test.ts tests/navigation.parity.test.tsx tests/logical-css.test.ts
      Tests  199 passed (199)
$ pnpm i18n:check
i18n:check  OK
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome playwright test zzzzzz-rooms.spec.ts
  ✓  1 … makes a room, seats two agents, writes in it and archives it (2.6s)
  ✓  2 … an agent mentioned in the room answers and hands the next step to another (4.7s)
  2 passed (13.6s)
```
CI: يُكمَّل بعد الدفع.

## المخاطر والرجوع
- لم يُجرَّب مع Hermes حقيقي: هل يجيب Hermes على السؤال الواحد بملخّص حسن؟ إن لم يجب فالمركز
  يكتب ملخّصه.
- التلخيص التلقائي يستهلك رموزًا عند الوكيل كل ٢٠ رسالة افتراضيًا؛ `every_turns: 0` يطفئه.
- الرجوع: revert يعيد الجزء الثاني (بلا ملخّص ولا تقارير).

## التسليم والخطوة التالية
الغرف مكتملة من جهة العقد. يبقى: اختبار على Hermes حقيقي (ثلاث تمريرات بين وكيلين، وملخّص)،
وربط المرفقات برسائل الغرفة (النص وحده الآن).
