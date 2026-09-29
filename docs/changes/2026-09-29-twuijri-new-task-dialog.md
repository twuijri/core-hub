# الويب: «مهمة جديدة» تفتح نافذة كاملة بدل حقل العنوان وحده
المسؤول: twuijri · الفرع: batch/2026-09-29b (من feat/web-new-task-dialog) · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٩، صفحة المهام على الويب): المهمة تُضاف اليوم بكتابة عنوان فقط في حقل «مهمة جديدة في …» ثم «أضف».
مهمة بلا تفاصيل لا فائدة منها. المطلوب: زر الإضافة يفتح نافذة «مهمة جديدة» فيها كل ما تحتاجه المهمة، ومنها ما يحتاجه
Kanban الخاص بـHermes ليشغّلها.

## القرار والموافقات
- رأس اللوحة صار فيه زر واحد «مهمة جديدة» (أو «مهمة جديدة في <البروفايل>» عند تعدد البروفايلات) يفتح النافذة. **حُذف حقل العنوان
  السريع** ولم يُبقَ كحقل تعبئة مسبقة: المالك يرى المهمة بلا تفاصيل بلا فائدة، والحقل بجانب زر يفتح نافذة فيها الحقل نفسه ازدحام بلا
  مكسب. Enter في عنوان النافذة يحفظ كما كان يفعل الحقل القديم. — مقترح، ينتظر تأكيد المالك.
- ترتيب النافذة (`packages/web/src/tasks/NewTaskDialog.tsx`): العنوان والوصف أولًا؛ «من ينفّذها» (الوكيل، النموذج)؛ «التفاصيل»
  (الأولوية، موعد التسليم، الوسوم، المشروع — المشروع يظهر فقط إن كان هناك أكثر من مشروع)؛ المهام الفرعية؛ تعريف الإنجاز والقيود؛
  «متى تبدأ» (ابدأ الآن / البدء تلقائيًا `auto_start` / ليس الآن) و«أين تنتظر» (واردة افتراضيًا، للعمل، جاهزة).
- الوكيل من القائمة نفسها التي يستخدمها «إسناد إلى وكيل» (`installedAgents`)، وافتراضيًا «لا أحد الآن» كما في الهاتف.
- **النموذج:** `TaskCreate` في العقد بلا نموذج، والخادم يقبله فقط في `TaskAssign.model` عند البدء. لذلك «ابدأ الآن» (الافتراضي حين
  يُختار وكيل، كما في الهاتف) تُنشئ المهمة ثم تستدعي `tasks.assignTask(start: true, model)` — نفس ما يفعله iOS وAndroid. المهمة التي
  تبدأ لاحقًا أو تلقائيًا تعمل على النموذج الافتراضي للوكيل، والنافذة تقول ذلك تحت الحقل. لم يُضف حقل للعقد (الخادم لا يخزّن نموذجًا
  للمهمة). جهد التفكير غير موجود في `TaskAssign` فلم يُعرض.
- إن فشل البدء بعد الإنشاء: المهمة تبقى، والنافذة تقول «أُنشئت المهمة لكنها لم تبدأ» ويصير الزر «ابدأ مرة أخرى» ويعيد البدء فقط
  (لا ينشئ مهمة ثانية). الإغلاق يُبقي المهمة ويُبرزها على اللوحة.
- **بطاقة Hermes:** اختيار Hermes يضع البطاقة على لوحة Hermes عند الإنشاء (سلوك الخادم الحالي). النافذة تُخفي تعريف الإنجاز والقيود
  (العقد: «Not for a card made on Hermes's kanban»، والخادم يرفضها بـ`hermes_owns_card`) وتعرض النص الموجود `tasks.dod.hermes_card`،
  وتُخفي النموذج وخيارات البدء مع ملاحظة أن Hermes يشغّل البطاقة من لوحته بنموذجه، وتُبقي «أين تنتظر» (واردة = `--triage` عند Hermes).
- اختيار «البدء تلقائيًا» والمهمة في «واردة» ينقلها إلى «جاهزة» (البدء التلقائي لا يحدث إلا في جاهزة)، ويمكن تغييره.
- التحقق: العنوان مطلوب («اكتب عنوانًا للمهمة.» على الحقل مع `aria-invalid` والتركيز عليه)، وموعد تسليم مضى أو غير صالح مرفوض. لا
  يُرسل شيء قبل ذلك. أخطاء الخادم تظهر داخل النافذة (`describeTaskError`) والنافذة تبقى مفتوحة.
- `Idempotency-Key`: ULID واحد لكل فتح للنافذة، كما يرسله الهاتف، والحفظ بعد فشل يرسل المفتاح نفسه. **ملاحظة:** الخادم لا يعيد
  الاستجابة بالمفتاح بعد (العقد يعرّف الترويسة، ولا يوجد تنفيذ لها في `packages/server`) — متابعة لاحقة للخادم.
- بعد الإنشاء: البطاقة الجديدة تُحاط بإطار لمدة ٤ ثوانٍ (`data-fresh`) وتُمرَّر إلى مجال الرؤية، و«الواردة» تُفتح إن نزلت فيها.
- اتجاه النص: مشروع Core Hub لا يحتوي `ContentText`/`contentInputProps` ولا `docs/CONTENT-DIRECTION.md` (هذه في الـfork)؛ حقول
  النافذة تستخدم `dir="auto"` كبقية حقول المهام في الويب، وموعد التسليم `dir="ltr"`.
- اختصار لوحة مفاتيح: لم يُضف؛ التطبيق فيه اختصار واحد فقط (طيّ الشريط الجانبي) ولا نمط عام لاختصارات الصفحات.
- **المرفقات:** لم تُبنَ. الخادم يخزّن `attachment_ids` للمهمة لكن لا تشغيل المهمة ولا أي واجهة (ويب/هاتف) يقرؤها، وتفاصيل المهمة في
  الويب بلا مرفقات. متابعة: ربط المرفقات بتشغيل المهمة ثم إضافتها للنافذة.
- `CheckListEditor` أخذ `kind="subtasks"` و`ticks={false}` (بلا مربعات المراجِع قبل وجود المهمة).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. يستخدم `tasks.createTask` (كل حقول `TaskCreate` عدا `attachment_ids`) وترويسة `Idempotency-Key` المعرّفة، و`tasks.assignTask`
مع `model` الموجود. لا تغيير كاسر.

## الملفات والتأثير
- جديد: `packages/web/src/tasks/NewTaskDialog.tsx`، `packages/web/src/tasks/newTask.ts` (القواعد: الجسم المُرسل، التحقق، الوسوم،
  ULID)، `packages/web/tests/new-task-dialog.test.tsx`، `packages/web/e2e/zzzzzzzzzzzz-new-task-dialog.spec.ts`.
- `packages/web/src/tasks/TasksScreen.tsx` (زر واحد، النافذة، إبراز البطاقة)، `queries.ts` (`useCreateTask` يرسل الجسم كاملًا
  والمفتاح؛ `useAssignTask` يقبل `model`)، `CheckList.tsx`، `styles/screens.css`، `i18n/{ar,en}.json` (`tasks.new.*`، `tasks.subtasks.*`).
- اختبارات قديمة كانت تستخدم الحقل السريع حُدّثت لتستخدم النافذة: `tests/tasks-schedules-profiles.test.tsx`،
  `e2e/{smoke,zz-task-board,zzz-chat-history,zzzz-profiles-boards,zzzzzzz-task-worktrees,zzzzzzzzzzzz-task-definition-of-done}.spec.ts`
  (والتي كانت تضغط «الواردة» بعد الإنشاء صارت تتحقق أنها فُتحت وحدها).
- `docs/STATUS.md` (سطر المهام).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ npx vitest run tests/new-task-dialog.test.tsx tests/tasks-schedules-profiles.test.tsx tests/task-definition-of-done.test.tsx tests/task-bulk.test.tsx tests/task-run.test.tsx --maxWorkers=2
      Tests  35 passed (35)
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzzzzzzzz-new-task-dialog.spec.ts e2e/zzzzzzzzzzzz-task-definition-of-done.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zzzzzzzzzzzz-new-task-dialog.spec.ts:37:1 › 38. a new task is written whole in its dialog and lands where it was put (1.6s)
  ✓  2 [chromium] › e2e/zzzzzzzzzzzz-task-definition-of-done.spec.ts:37:1 › 36. a definition of done and constraints are written, kept and counted; many cards take one priority (2.0s)
  2 passed (12.6s)
$ … playwright test e2e/zz-task-board.spec.ts e2e/zzzz-profiles-boards.spec.ts e2e/zzzzzzz-task-worktrees.spec.ts e2e/zzz-chat-history.spec.ts --workers=1
  6 passed (38.4s)
$ pnpm contracts:compat
contracts:compat  OK — no breaking change against v1.1.5
$ pnpm lint
All matched files use Prettier code style!
$ pnpm i18n:check
i18n:check  web: 3491 keys, ar/en in parity
i18n:check  OK
$ pnpm i18n:limits
i18n:limits  ar: 56 measured labels, 0 too wide, 4 cut with an ellipsis as in English
i18n:limits  OK
```
typecheck نظيف. `smoke.spec.ts` (رحلتان عُدّلتا) وكامل المجموعات تُشغَّل على GitHub CI.

## المخاطر والرجوع
- من كان معتادًا على كتابة العنوان في الرأس صار يضغط الزر أولًا (قرار المالك). الرجوع: revert لهذا الدمج.
- بلا تغيير في العقد ولا في الخادم؛ التطبيقات الأقدم والمراكز الأقدم لا تتأثر.

## التسليم والخطوة التالية
دفعة 2026-09-29b (#224)، ينتظر دمج المالك. متابعات: المرفقات عند الإنشاء (بعد ربطها بتشغيل المهمة)، تنفيذ `Idempotency-Key` في
الخادم، وحقل نموذج اختياري في `TaskCreate` إن أراد المالك أن يُحفظ النموذج للبدء التلقائي (يحتاج دعمًا في الخادم).
