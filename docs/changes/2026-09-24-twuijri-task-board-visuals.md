# لوحة المهام: لغة الألوان — إطار لكل مرحلة، زر الترقية، شريط الانتظار، والأرشيف خلف «منتهية»
المسؤول: twuijri · الفرع: feat/task-board-visuals · الحالة: review

## المشكلة والهدف
المالك يريد أن يعرف من نظرة واحدة أيّ مهمة تعمل، وأيّها متوقفة، وأيّها تنتظر. شكل اللوحة (شريط
«وارد» وأربعة أعمدة) موجود منذ `2026-09-22-twuijri-board-columns.md`، لكن البطاقة لم تكن تقول
مرحلتها إلا بحافة جانبية رفيعة وكلمة رمادية. وكان في اللوحة نقصان آخران:
- زر «أرشفة» على البطاقة المنتهية يؤرشف **بلا تأكيد**: طريق الزر لم يكن يمرّ على قاعدة
  `transitionFor('done','archived')` التي تطلب التأكيد (لأن «مؤرشفة» ليست في أيّ عمود).
- «المؤرشفة» لا تظهر أبدًا: اللوحة تطلب `task-columns` بلا `include_archived`، فعمود الأرشيف
  يصل فارغًا دائمًا.

## القرار والموافقات
هذا تنفيذ **لفكرة** قرار المالك القديم عن اللوحة (سجلّ قراره في ٢٠٢٦-٠٩-١٧ لمنتج آخر)،
مبنيٌّ هنا من جديد بمكوّنات مجلس ورموزه (Clean room: لم يُقرأ ولم يُنسخ أيّ كود من
`agent-studio` أو غيره). لكل مرحلة إطار حول البطاقة كلها، مرسوم بطريقة مختلفة حتى لا يكون
اللون وحده هو ما يميّزها، وتبقى كلمة الحالة على البطاقة لقارئ الشاشة ولمن لا يميّز الألوان:
- **تعمل**: إطار أخضر كامل يدور (`conic-gradient` بزاوية متحرّكة `@property`) مع هالة خفيفة؛
  وبقيت النقطة النابضة داخل الشارة بلون الشارة.
- **متوقّفة**: إطار أحمر متّصل.
- **مجدولة**: إطار كهرماني **متقطّع** وأيقونة ساعة بجانب الكلمة.
- **للمراجعة**: إطار بنفسجي، وشارة بنفسجية.
- **جاهزة**: حافة زرقاء هادئة في بداية البطاقة وشارة «جاهزة» — تمييز خفيف عن «للعمل» لا إنذار.
- **`prefers-reduced-motion`**: يتوقّف الدوران ويبقى إطارًا أخضر متّصلًا (عرضه 2px)، وتتوقّف
  النقطة. التمييز باقٍ: متّصل/متقطّع/حافة + الكلمة + الأيقونة.
- زر **«جاهزة»** السريع على بطاقة «للعمل» كان موجودًا؛ أُضيف له اختبار، وهو لـ«للعمل» وحدها.
- **شريط الانتظار**: القاعدة صارت دالة واحدة مختبرة (`isColumnCollapsed` في `board.ts`):
  يطوى وهو فارغ، ويفتح وحده حين يحمل مهمة، وحين يُضغط، وأثناء سحب بطاقة **يمكن** إسقاطها فيه.
  تغيير سلوكي صغير: كان يفتح عند سحب أيّ بطاقة؛ الآن لا يفتح لبطاقة سيرفضها (وارد، مراجعة).
- **منتهية**: رابط «عرض المؤرشفة (n)» تحت بطاقاتها يكشف المؤرشفة للقراءة فقط (بلا مقبض ولا
  قائمة ولا زر). والرابط لا يظهر حين لا أرشيف. زر «أرشفة» صار يسأل قبل التنفيذ في كل الطرق
  (الزر والقائمة والسحب) عبر دالة واحدة `moveTo` تسأل القاعدة نفسها.
- الإسقاط في «انتظار» ما زال يسأل: جدولة أم إيقاف (لم يتغيّر).
- الألوان رموز جديدة في `ui-tokens` بأسماء أدوار لا ألوان (`status-running`، `status-blocked`،
  `status-scheduled`، `status-review`، `status-ready`، `status-running-sweep`، `review-soft`،
  `review-soft-text`) في الوضعين الفاتح والداكن، وأُضيفت أزواجها إلى اختبار التباين (3:1 للإطار
  على `surface` و`surface-2`، و4.5:1 لنصّ الشارة البنفسجية).

## العقد
لا شيء. `include_archived` موجود في `tasks.getColumns` أصلًا، والأرشفة تستعمل `tasks.moveTask`
الموجود. لا تغيير في الخادم.

## الملفات والتأثير
- `packages/ui-tokens/tokens.json` — ثمانية رموز لكل وضع، و11 زوج تباين.
- `packages/web/src/tasks/board.ts` — `cardFrame`، `showsStatusWord`، `isColumnCollapsed`.
- `packages/web/src/tasks/queries.ts` — `useArchive` (استعلام منفصل بـ`include_archived`، لا يدخل
  في إعادة الطلب كل ٤ ثوانٍ أثناء التشغيل، ومفتاحه تحت مفتاح اللوحة فيتحدّث مع كل كتابة).
- `packages/web/src/tasks/TasksScreen.tsx` — `data-frame` على البطاقة، `StatusBadge`، `ArchivedCard`،
  رابط الأرشيف في «منتهية»، و`moveTo` الموحّدة (إصلاح الأرشفة بلا تأكيد).
- `packages/web/src/styles/screens.css` — الإطارات، الدوران، الحركة المخفّضة، الأرشيف.
- `packages/web/src/i18n/{ar,en}.json` — `tasks.show_archived`، `tasks.hide_archived`.
- اختبارات: `web/tests/board.test.ts` (+9)، `web/tests/task-board-visuals.test.tsx` (جديد، 17)،
  `web/e2e/smoke.spec.ts` (الرحلة ١٠: زر الترقية وفتح الانتظار أثناء السحب؛ الرحلة ١٧: تأكيد
  الأرشفة قبل رفض هرمز)، `web/e2e/zz-task-board.spec.ts` (جديد)، و`web/e2e/hub.ts` (سيناريو تشغيل
  لا ينتهي لـ«ترجم الدليل» حتى تُصوَّر البطاقة وهي تعمل).

## الفحوص (الأوامر ونواتجها الفعلية)
```
pnpm lint                      → All matched files use Prettier code style! (eslint نظيف)
pnpm typecheck                 → exit 0
pnpm i18n:check                → i18n:check  web: 812 keys, ar/en in parity · OK
pnpm nav:check                 → nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
pnpm --filter @majlis/ui-tokens test → Tests  127 passed (127)
pnpm --filter @majlis/web test → Test Files  34 passed (34) · Tests  443 passed (443)
pnpm --filter @majlis/web build → ✓ built in 736ms
PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e → 26 passed (1.7m)
```
اللقطات (أُعيدت بقية اللقطات إلى ما في `main`):
- `packages/web/e2e/shots/tasks-colours-ar-light.png` — كل المراحل معًا، والأرشيف مفتوح.
- `packages/web/e2e/shots/tasks-colours-en-dark.png` — الإنجليزية، الداكن.
- `packages/web/e2e/shots/tasks-colours-mobile-ar-light.png` — هاتف 390px.
- محدَّثة: `tasks-running-ar-light.png`، `tasks-review-ar-light.png`، `tasks-blocked-ar-light.png`،
  `tasks-hermes-card-ar-light.png`.

## المخاطر والرجوع
- الأرشيف استعلام ثانٍ لـ`task-columns` عند فتح اللوحة وبعد كل كتابة (لا أثناء الاستطلاع). إن
  كبر الأرشيف كثيرًا فالأفضل لاحقًا طلبه عند الضغط فقط، أو عدّاد في العقد.
- `@property` لزاوية الدوران: متصفّح لا يدعمه يعرض إطارًا أخضر ثابتًا (نفس شكل الحركة المخفّضة).
- الرجوع: الفرع وحده، لا هجرة ولا تغيير عقد.

## التسليم والخطوة التالية
PR إلى `main`. الدمج للمالك. لم يُنشر أيّ image ولم يُلمس أيّ خادم.
