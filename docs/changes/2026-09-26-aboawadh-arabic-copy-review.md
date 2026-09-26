# مراجعة صياغة الواجهة العربية
المسؤول: aboawadh · الفرع: fix/arabic-copy-review · الحالة: review

## المشكلة والهدف
تظهر في واجهة الويب العربية عبارات حرفية أو غير سليمة، وبعض التسميات التقنية لا توضّح معناها للمستخدم. أبرز ما ظهر بعد المراجعة الأولى «خطافات الويب» و«7 يوم». كذلك تكرر اسم المركز بصيغة «الهب» في نصوص الهاتف، وتحتاج صفحة التحميل إلى صياغة أوضح. الهدف تحسين النصوص مع الحفاظ على سلوك الواجهة والمصطلحات التي اعتمدها المشروع.

## القرار والموافقات
طلب المستخدم مراجعة عربية Core Hub ورفع التعديل في طلب دمج إلى المطور. بعد جولة أولى طلب مراجعة جميع القوائم والرسائل الظاهرة، واستخدام النسخة الحية لاكتشاف العبارات، ثم طلب إدراج تصحيحات صفحة التنزيل في طلب الدمج بدل الاكتفاء بـ issue #166. لم تُغيَّر بيانات النسخة الحية.

- التزمت مصطلحات خريطة التنقل («البروفايل»، «المهام»، «الجدولة») ووحّدت اسم الوكيل «هرمز» واسم الخادم «المركز» في الشرح العربي.
- صارت بعض شارات الأعداد بصيغة «المهام: {count}» لتبقى سليمة مع صفر وواحد واثنين دون إضافة نظام جمع جديد.
- أُضيفت تسميات عربية وإنجليزية لكل قدرات الوكيل المعلنة في العقد؛ تبقى أسماء المعرّفات البرمجية في العقد كما هي.
- فُحصت في النسخة الحية قوائم الإعدادات وأقسام الحساب والمستخدمين والعرض والإشعارات والخصوصية والنماذج والأجهزة والمعرفة والسجلات والتقارير والأداء والبروفايلات والتحديثات والإضافات والملفات، إضافةً إلى المحادثة الجديدة والوكلاء والمهام والجدولة وسير العمل والغرف وصفحات إعدادات الوكيل ومهاراته وMCP ومهامه المجدولة وقنواته وإضافاته. قورنت النصوص الظاهرة بملفات اللغة، ومُسحت القيم العربية غير المترجمة في ملفات الويب والخادم وCLI وiOS. المراجعة الحية لا تُنشئ حالات الخطأ أو رسائل كل مزوّد، لذا لا تعني زيارة كل حالة شرطية في التطبيق.
- استُبدلت «خطافات الويب» بـ«وجهات الإشعار» لأنها تصف فعل الشاشة: إرسال الأحداث إلى رابط خدمة خارجية. حُدّثت خريطة التنقل وترجمة iOS واختبارات الويب معها. استُبدلت تسميات المدد بصيغ عربية صحيحة للأعداد الأربعة.
- صارت شارات الأعداد الأخرى في قائمة المحادثات، الاستخدام، المهارات، البروفايلات، الحقول، الأداء، والسجلات بتسمية ثابتة قبل الرقم («الوكلاء: {count}» ونحوها) حتى لا تعرض جمعًا عربيًا خاطئًا عند ٠ أو ١ أو ٢.
- إشعارات الوارد القديمة قد تظهر بالإنجليزية رغم عربية الواجهة: الخادم يحفظ نصها بلغة حساب المستلِم عند إنشاء الإشعار (`packages/server/src/modules/notify/notices.ts`) ولا يعيد ترجمتها لاحقًا. لا تعيد هذه المراجعة كتابة سجل الإشعارات.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا تغيير في عقد الـAPI أو الأحداث داخل `packages/contracts`. تغيّر النص العربي لمصطلح `webhooks` في عقد التنقّل `docs/clients/navigation.json`، مع تحديث مقابله في الويب وiOS؛ Android يولّد تسمية التنقّل منه.

## الملفات والتأثير
- `packages/web/src/i18n/ar.json`: تحرير نصوص المحادثة، الحساب، الوكلاء، النماذج، المهام، الجدولة، سير العمل، الغرف، وربط حسابات المراسلة.
- `packages/web/src/i18n/en.json`: تسميات قدرات الوكيل ومفتاح رابط صفحة الوكلاء، للمحافظة على تكافؤ اللغتين.
- `packages/web/src/screens/NewChatScreen.tsx`: جعل نص عدم وجود وكيل جملة كاملة في كل موضع، مع رابط مستقل إلى صفحة الوكلاء حين يحق للمستخدم فتحها.
- `packages/web/src/shell/WorkspaceSwitcher.tsx` و`packages/web/src/ui/Select.tsx`: إخفاء تلميح مكرر فوق محدّد البروفايل، لأن اسمه ظاهر بجانبه؛ كان التلميح يغطي خيار البروفايل ويمنع النقر عليه في رحلة المتصفح.
- اختبارات الويب النصية والرحلات التي كانت تعتمد على التسميات القديمة.
- `docs/clients/navigation.json` و`apps/ios/CoreHub/i18n/ar.json` و`apps/android/app/src/main/res/values-ar/strings.xml`: توحيد عنوان وجهات الإشعار واسم المركز في الهاتف.
- `packages/web/src/settings/usage/ReportFilters.tsx`: مدد التقارير العربية الصحيحة بدل «7 يوم».
- `site/src/i18n.js` واختبارها: عنوان الصفحة، أزرار التحميل، إرشادات Windows وAndroid، والتمييز بين الوصول المحلي والوصول عن بُعد عند إنشاء حساب المالك.

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
$ pnpm --filter @corehub/site test
Test Files 2 passed (2); Tests 41 passed (41)
$ pnpm --filter @corehub/web exec playwright test e2e/zzz-settings-webhooks-privacy.spec.ts e2e/zzzzzz-webhook-events.spec.ts e2e/zzzzzz-usage-analytics.spec.ts
4 passed (13.5s), using installed Chrome; local Playwright Chromium was unavailable.
$ pnpm --filter @corehub/web exec playwright test e2e/zzzz-profiles-boards.spec.ts e2e/zzzzzz-usage-analytics.spec.ts
2 passed (10.7s), using installed Chrome after the final count-label changes.
$ pnpm i18n:check
i18n:check web: 2699 keys, ar/en in parity; server, CLI, desktop, iOS also in parity; OK
$ pnpm nav:check
nav:check OK — 38 destinations, 43 terms, all clients' routes complete
$ pnpm typecheck
exit 0
$ pnpm test --filter @corehub/web
Test Files 90 passed (90); Tests 1044 passed (1044)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm build
exit 0 (web, server, site, desktop and other workspace packages)
```
اختبار الطرفية خارج نطاق الترجمة ولم يُغيَّر كوده. بقي إخفاقًا محليًا يُذكر في طلب الدمج كي يتحقق منه CI.

## المخاطر والرجوع
تغيّرت التسميات التي تبحث عنها بعض اختبارات الواجهة، فحُدّثت توقعاتها. إخفاء تلميح محدّد البروفايل يزيل شرحًا مكررًا، لكن تبقى تسمية الحقل مرئية ومقروءة آليًا. لا يتغير عقد الـAPI أو منطق التشغيل؛ يتغيّر عنوان وجهة التنقّل العربية في العملاء. الرجوع بإعادة طلب الدمج.

### دمج `main` بعد #165 (twuijri، ٢٠٢٦-٠٩-٢٦)
تعارض ملفا الترجمة مع طلب الليلة #165؛ حُلّا مفتاحًا مفتاحًا: صياغة هذا الطلب حيث عدّلها، وإضافات #165 كما هي. حيث غيّر الطرفان المفتاح نفسه: `composer.placeholder` أخذ صياغة #165 («راسل الوكيل…»، قرار عائلة التصميم)، وتسميات القدرات العربية من هذا الطلب، والإنجليزية بصياغته مع حرف كبير أول كما قررت #165. بعد الحل: `pnpm i18n:check` سليم، واختبارات الويب 1356/1356، و`nav:check` سليم.

## التسليم والخطوة التالية
تحديث طلب الدمج #167 إلى main، وإغلاق issue #166 لأن ملاحظات صفحة التنزيل أصبحت تعديلات فعلية فيه. الدمج للمالك وحده.
- بعد الدمج فشل فحص «Web smoke journeys» في رحلتين تنتظران النص القديم: مكتبة المهارات («1 معدّلة» ← «المعدّلة: 1») والسجلات («Hermes · work» ← «هرمز · work»). حُدّث الاختباران على النص الجديد دون تغيير الترجمة.
