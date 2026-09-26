# مراجعة صياغة الواجهة العربية
المسؤول: aboawadh · الفرع: fix/arabic-copy-review · الحالة: review

## المشكلة والهدف
تظهر في واجهة الويب العربية عبارات حرفية أو غير سليمة، وبعض التسميات التقنية لا توضّح معناها للمستخدم. الهدف تحسين النصوص مع الحفاظ على سلوك الواجهة والمصطلحات التي اعتمدها المشروع.

## القرار والموافقات
طلب المستخدم مراجعة عربية Core Hub ورفع التعديل في طلب دمج إلى المطور. تقتصر التغييرات على النصوص المعروضة وموضع واحد يعيد استخدام نص ناقص. ملاحظات صفحة التنزيل أُرسلت منفصلة في issue #166.

- التزمت مصطلحات خريطة التنقل («البروفايل»، «المهام»، «الجدولة») ووحّدت اسم الوكيل «هرمز» واسم الخادم «المركز» في الشرح العربي.
- صارت بعض شارات الأعداد بصيغة «المهام: {count}» لتبقى سليمة مع صفر وواحد واثنين دون إضافة نظام جمع جديد.
- أُضيفت تسميات عربية وإنجليزية لكل قدرات الوكيل المعلنة في العقد؛ تبقى أسماء المعرّفات البرمجية في العقد كما هي.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/web/src/i18n/ar.json`: تحرير نصوص المحادثة، الحساب، الوكلاء، النماذج، المهام، الجدولة، سير العمل، الغرف، وربط حسابات المراسلة.
- `packages/web/src/i18n/en.json`: تسميات قدرات الوكيل ومفتاح رابط صفحة الوكلاء، للمحافظة على تكافؤ اللغتين.
- `packages/web/src/screens/NewChatScreen.tsx`: جعل نص عدم وجود وكيل جملة كاملة في كل موضع، مع رابط مستقل إلى صفحة الوكلاء حين يحق للمستخدم فتحها.
- `packages/web/src/shell/WorkspaceSwitcher.tsx` و`packages/web/src/ui/Select.tsx`: إخفاء تلميح مكرر فوق محدّد البروفايل، لأن اسمه ظاهر بجانبه؛ كان التلميح يغطي خيار البروفايل ويمنع النقر عليه في رحلة المتصفح.
- اختبارات الويب النصية والرحلات التي كانت تعتمد على التسميات القديمة.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm i18n:check
i18n:check  web: 2696 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm contracts:check-clients
check-clients  OK — 626 client file(s) scanned, 230 contract path(s) known.
$ pnpm typecheck
exit 0
$ pnpm test --filter @corehub/web
Test Files  90 passed (90)
Tests  1044 passed (1044)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm build
exit 0 (web, server, site, desktop and other workspace packages)
$ pnpm graph
graph  Graphify is not installed: uv tool install graphifyy==0.9.66
$ pnpm web:e2e
65 passed, 6 failed (five text/tooltip failures fixed below; terminal creation failed locally)
$ pnpm --filter @corehub/web exec playwright test e2e/smoke.spec.ts e2e/zz-task-board.spec.ts e2e/zzzz-profiles-boards.spec.ts e2e/zzzzzz-schedule-templates.spec.ts e2e/zzzzzz-workflow-editor.spec.ts --grep '10\. the Tasks board|every stage is told|Tasks board and the Schedules|common schedule fills|two-step workflow drawn'
3 passed, 2 failed (task-board's remaining old short label, and profile tooltip)
$ pnpm --filter @corehub/web exec playwright test e2e/zz-task-board.spec.ts e2e/zzzz-profiles-boards.spec.ts e2e/zzzzzzzz-owner-terminal.spec.ts
1 passed (task board), 2 failed (profile tooltip and local terminal)
$ pnpm --filter @corehub/web exec playwright test e2e/zzzz-profiles-boards.spec.ts
1 passed (9.2s) after removing the redundant tooltip
$ pnpm --filter @corehub/web exec playwright test e2e/zzzzzzzz-owner-terminal.spec.ts
1 failed: terminal-screen did not appear; the server returned a generic error when creating the terminal.
```
اختبار الطرفية خارج نطاق الترجمة ولم يُغيَّر كوده. بقي إخفاقًا محليًا يُذكر في طلب الدمج كي يتحقق منه CI.

## المخاطر والرجوع
تغيّرت التسميات التي تبحث عنها بعض اختبارات الواجهة، فحُدّثت توقعاتها. إخفاء تلميح محدّد البروفايل يزيل شرحًا مكررًا، لكن تبقى تسمية الحقل مرئية ومقروءة آليًا. لا يتغير العقد أو منطق التشغيل. الرجوع بإعادة طلب الدمج.

## التسليم والخطوة التالية
مراجعة الترجمة، تشغيل الفحوص، ثم فتح طلب دمج إلى main دون دمج.
