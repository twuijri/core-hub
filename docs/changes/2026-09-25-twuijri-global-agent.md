# الوكيل العام وشريط الإجراءات المعلّقة
المسؤول: twuijri · الفرع: feat/global-agent · الحالة: review

## المشكلة والهدف
وجهة `global_agent` في خريطة التنقّل (`docs/clients/navigation.json`) كانت تعرض الصفحة المؤقتة:
«بلا مدخل قائمة؛ يُوصَل إليه من نتائج البحث ومن شريط الإجراءات المعلّقة» (NAVIGATION §4). ولم
يكن في الويب شريط إجراءات معلّقة أصلًا (#92 نبّه أنه لا شريط موافقات عامًّا في الويب بعد).

ما تقوله المستندات عن «الوكيل العام» قبل هذه المهمة:
- `Session.source` فيه القيمة `global_agent` (docs/domain/sessions.md، العقد).
- COVERAGE صف 36: الوكيل العام يُفتح من نتيجة بحث، ويقرأ `sessions.list (source=global_agent)`
  ثم صف المحادثة، و«الأرشفة مرفوضة بـ `409 state_invalid`»؛ ومثال `bulkUpdate` في العقد نصه
  «لا يمكن أرشفة جلسة الوكيل العام».
- صفحة البحث في الويب توجّه النتيجة ذات `source = global_agent` إلى `/global-agent`.
- لا عملية تُنشئ جلسة بهذا المصدر، ولا شيء يقول كم منها ولمن.

إذن المعنى بكلماتنا: **الوكيل العام محادثة واحدة دائمة مع الوكيل، ليست محادثة في القائمة،
يُوصَل إليها من البحث ومن شريط الإجراءات المعلّقة، ولا تُؤرشف.** المستندات لم تحسم العدد
والمالك، فحسمتهما هنا كاقتراح (تحت).

الهدف: بناء الصفحة، وبناء شريط الإجراءات المعلّقة، وربط المدخلين.

## القرار والموافقات
**مقترح — بانتظار تأكيد المالك** (DECISIONS §45):
1. **واحدة لكل شخص في كل بروفايل.** `sessions.openGlobalAgent` (`POST /sessions/global-agent`
   بجسم `{agent_id}`) يعيد محادثة المتصل في بروفايل الترويسة (`200`)، أو ينشئها أول مرة بالوكيل
   المعطى (`201`). الويب يعطيه أول وكيل مثبّت بترتيب الشخص (Hermes في مركز جديد). فتحتان أوليان
   متزامنتان تنتهيان إلى محادثة واحدة (تبقى الأقدم وتُحذف الأحدث).
2. **ليست في قائمة المحادثات ولا تُؤرشف.** الويب يستبعدها من القائمة، والبحث يجدها ويفتح
   صفحتها. أرشفتها `409 state_invalid` (`details.reason = global_agent`)؛ حذفها مسموح والفتح
   التالي ينشئ غيرها؛ والتفرّع منها محادثة `chat` عادية.
3. **لا صلاحيات عابرة للبروفايلات.** تعمل في بروفايلها كأي محادثة، بوكيله وأدواته. وكيل
   «يعمل عبر البروفايلات» يحتاج ADR خاصًّا.
4. **شريط الإجراءات المعلّقة** زرّ في الشريط العلوي لكل شاشة (ليس وجهة): عدد ما ينتظر الشخص —
   الموافقات وأسئلة الوكلاء وخطوات سير العمل في **كل بروفايل يدخله** (طلب `listApprovals` لكل
   بروفايل، على روح ADR 0016)، وللمشرف طلبات الاقتران (تيليجرام/واتساب) في بروفايله الحالي.
   الضغط يفتح ورقة: كل موافقة أو سؤال يُجاب فيها بالبطاقة نفسها التي في المحادثة، ولكل عنصر
   «افتحه في مكانه» (المحادثة، أو صفحة الوكيل العام، أو تشغيل سير العمل في الجدولة، أو صفحة قنوات
   الوكيل)، وفي أسفلها «اسأل الوكيل العام».

مرفوض: حقل `source` في `SessionCreate` (يسمح بعدد غير محدود ويحتاج قراءة ثم إنشاء بسباق)؛
و`sessions.list?source=global_agent` طريقًا للدخول (القائمة للبروفايل لا للشخص).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عملية جديدة `sessions.openGlobalAgent` — `POST /sessions/global-agent`، مخطط
  `GlobalAgentOpen {agent_id}`، ردود `200`/`201` (`Session`)، `400`، `401`، `404`، `422`،
  حدث `session.created`.
- وصف `sessions.update`: أرشفة جلسة الوكيل العام `409 state_invalid`.
- `docs/contracts/DECISIONS.md` §45، و`docs/contracts/COVERAGE.md` (صف شريط الإجراءات المعلّقة
  وصف 36).

## الملفات والتأثير
- الخادم: `packages/server/src/modules/sessions/{routes,service,store}.ts` — المسار،
  `openGlobalAgent`، رفض الأرشفة، مصدر التفرّع، `findGlobalAgent`. اختبار جديد
  `global-agent.test.ts`.
- الويب: `screens/GlobalAgentScreen.tsx` (الصفحة)، `shell/PendingActions.tsx` (الشريط والورقة)،
  `pending/pending.ts` (دمج العناصر ووجهاتها، دوال نقية)، `pending/queries.ts` (الاستعلامات
  والتحديث الحي)، `chat/ChatScreen.tsx` (تصدير `OpenSession` بعنوان ومقدّمة اختيارية)،
  `chat/anchor.ts` (`globalAgentHref`)، `screens/SearchScreen.tsx` (نتيجة الوكيل العام تحمل
  بروفايلها)، `sessions/SessionList.tsx` (استبعاده من القائمة)، `shell/TopBar.tsx`،
  `navigation/routes.tsx`، `ui/icons.tsx` (`IconInbox`)، `styles/screens.css`، ونصوص
  `i18n/{ar,en}.json` (`pending.*`، `global_agent.*`).
- اختبارات الويب: `tests/pending-actions.test.tsx`، و`e2e/zzzzzz-pending-actions.spec.ts`.
- مستندات: `docs/clients/NAVIGATION.md` §4، `docs/clients/navigation.json` (ملاحظة الوجهة)،
  `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًّا (كل الأوامر الثقيلة عبر `mj-run`):

```
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 281 client file(s) scanned, 176 contract path(s) known.
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  273 passed (273)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
(exit 0)
$ node scripts/i18n-check.mjs
i18n:check  web: 1312 keys, ar/en in parity
i18n:check  OK
$ node scripts/navigation-check.mjs
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ (packages/server) vitest run src/modules/sessions/global-agent.test.ts src/modules/sessions/sessions-api.test.ts
 Test Files  2 passed (2)
      Tests  24 passed (24)
$ (packages/web) vitest run tests/pending-actions.test.tsx tests/topbar-name.test.tsx tests/navigation.parity.test.tsx tests/i18n.test.ts tests/search-jump.test.tsx tests/all-profiles.test.tsx tests/approval-card.test.tsx
 Test Files  7 passed (7)
      Tests  50 passed (50)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzz-pending-actions.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-pending-actions.spec.ts:34:3 › pending actions and the global agent › 40. an approval waits in the bar, is answered there, and the bar leads to the global agent (1.8s)
  1 passed (9.1s)
```

الاختبارات الجديدة تسقط على الكود القديم: `POST /sessions/global-agent` كان `501`، ولم يكن في
الشريط العلوي `pending-actions`، وصفحة `/global-agent` كانت الصفحة المؤقتة.

CI: يُحدَّث بعد الدفع.

## المخاطر والرجوع
- **طلب لكل بروفايل** في كل شاشة (مع استطلاع كل دقيقة، والأحداث الحية هي الأساس): عند بروفايلات
  كثيرة تكثر الطلبات. إن ثقل ذلك فالحل `listApprovals?profiles=all` في العقد لاحقًا.
- **الاقتران** يُسأل عنه هرمز كل دقيقة للمشرف فقط؛ هرمز غير مُشرَف عليه يرد `409` فيُتجاهل.
- **عضو يرى محادثات البروفايل** (القائمة للبروفايل): محادثة الوكيل العام لعضو آخر تظهر في
  البحث لمن يبحث. هذا سلوك القائمة نفسه قبل هذه المهمة، لا جديد.
- رجوع: إلغاء الدمج يعيد الصفحة المؤقتة ويُسقط المسار؛ لا هجرة قاعدة بيانات (المصدر
  `global_agent` موجود في المخطط من قبل).

## التسليم والخطوة التالية
- ينتظر تأكيد المالك لـ DECISIONS §45 (واحدة لكل شخص في كل بروفايل، بلا صلاحيات عابرة).
- لاحقًا إن لزم: الغرف (`room_id`) لا صفحة لها في الويب بعد، فعنصرها يُجاب في الورقة بلا
  «افتحه في مكانه»؛ والموافقة على طلب الاقتران تتم من صفحة القنوات لا من الورقة.
