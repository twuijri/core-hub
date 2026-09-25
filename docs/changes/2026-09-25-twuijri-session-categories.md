# تصنيفات المحادثات وتجميع القائمة
المسؤول: twuijri · الفرع: feat/session-categories · الحالة: review

## المشكلة والهدف
صف `sessions` في `docs/STATUS.md` كان يقول «only session categories are not built»: العمليات
الأربع `sessions.*Category` تجيب `501`، و`category_id` في تعديل المحادثة يُرفض بـ`501`. طلب
المالك تنظيم قائمة المحادثات:
- تصنيفات: إنشاء، إعادة تسمية، حذف، ترتيب، ونقل محادثة إليها أو منها؛ تظهر في القائمة مجموعاتٍ
  قابلة للطيّ فوق المحادثات غير المصنّفة، وحالة الطيّ محفوظة للمشاهد؛ النقل بالسحب إلى التصنيف
  أو من قائمة المحادثة «نقل إلى تصنيف»؛ بالعربية والإنجليزية.
- تجميع حسب المصدر: محادثات تيليجرام وواتساب وغيرها في مجموعات «تيليجرام» و«واتساب».
- البحث وفلتر «كل البروفايلات» (ADR 0016) يبقيان يعملان مع المجموعات.

## القرار والموافقات
المالك نائم؛ القرارات التالية **مقترحة — المالك يؤكد**، ومكتوبة في DECISIONS §53
(الأرقام حتى §52 مأخوذة في `main` وفي الطلبات المفتوحة #105–#118):
- **التصنيف للبروفايل لا للشخص.** التعليمات قالت «لكل شخص في كل بروفايل ما لم يقل العقد غير
  ذلك»، والعقد يقول غير ذلك: وصف `listCategories` كان «All categories of the workspace»،
  و`Session.category_id` حقل واحد على محادثة مشتركة بين كل من يدخل البروفايل. تصنيف لكل شخص
  يعني أن شخصين يصنّفان المحادثة نفسها يمسح أحدهما تصنيف الآخر. فصار التصنيف مشتركًا في
  البروفايل كمحادثاته، و`owner_id` من أنشأه. **الطيّ وحده للمشاهد** (في متصفحه).
- **النقل هو `sessions.update` / `bulkUpdate`** بـ`category_id`؛ تصنيف بروفايل آخر أو محذوف أو
  مختلق = `404 not_found` (`resource: session_category`) لا تجاهل صامت. `sessions.create` يتحقق
  كذلك. لا عملية «نقل» جديدة.
- **الترتيب `position` دائمًا `0…n-1`**: الإنشاء في الآخر أو في `position` المعطى، التعديل
  بـ`position` ينقله ويعيد ترقيم الباقي، الحذف يسدّ الفراغ. في الواجهة: «نقل لأعلى / لأسفل» من
  قائمة التصنيف.
- **الأسماء فريدة في البروفايل** (بعد القصّ ودون اعتبار حالة الأحرف): `409 conflict` في الإنشاء
  وإعادة التسمية (أُضيف `409` الموثّق لـ`updateCategory`)، وحد أقصى ١٠٠ تصنيف للبروفايل.
- **`session_count`** = المحادثات غير المؤرشفة فيه.
- **حذف التصنيف يُبقي محادثاته**: كل محادثة فيه (والمؤرشفة) تفقد تصنيفها ويُعلَن عنها بـ
  `session.updated`.
- **عبر البروفايلات**: `listCategories?profiles=all` (قاعدة `auth` تحدد البروفايلات)؛ في عرض
  «كل البروفايلات» تُعرض تصنيفات كل بروفايل بشارته، والمحادثة لا تُعرض عليها إلا تصنيفات
  بروفايلها، والسحب إلى تصنيف بروفايل آخر لا يفعل شيئًا.
- **الواجهة**: التصنيفات أولًا بترتيبها، ثم مجموعة لكل منصة (تيليجرام ثم واتساب ثم غيرهما)، ثم
  المحادثات بلا مجموعة بلا عنوان كما كانت. تصنيف اختاره الشخص يغلب المصدر. التصنيف الفارغ يظهر
  (مكان للإفلات) إلا أثناء البحث أو في «المؤرشفة». أثناء كتابة كلمة في الفلتر تظهر كل النتائج ولو
  كانت مجموعتها مطويّة. زر «تصنيف جديد» (أيقونة المجلد) بجانب حقل الفلتر، ويُنشأ في البروفايل
  الذي ضُيّقت عليه القائمة وإلا في بروفايل الشخص. نافذة «نقل إلى تصنيف» فيها «بلا تصنيف»
  و«تصنيف جديد…» (يُنشئ ثم ينقل).
- رُفض: حدث لحظي `session_category.*` (تصنيف أنشأه شخص آخر يظهر عند الجلب التالي، والقائمة
  تعيد جلب التصنيفات حين تذكر محادثةٌ تصنيفًا لا تعرفه)؛ اختيار اللون في الواجهة (الحقل موجود في
  العقد ويُحفظ، والواجهة لا تعرضه بعد).

**محادثات القنوات (المطلب ٢) — لم تُبنَ القراءة من Hermes، وهي الخطوة التالية.** ما وُجد:
- لا شيء في المركز يُنشئ محادثة `source: channel` اليوم: رسائل تيليجرام وواتساب يستقبلها
  `hermes gateway` ويحفظها في جلسات Hermes نفسه (`state.db` لكل بروفايل)، ولا تصل قائمة المركز.
  الواجهة الآن تجمّع أي محادثة `source: channel` حسب `channel` («تيليجرام»، «واتساب»، وغيرهما
  «القنوات: …») — جاهزة، لكنها فارغة حتى تصل هذه المحادثات.
- Hermes يعرضها قراءةً عبر خادمه الداخلي (`hermes serve`، ADR 0015) — قُرئ في مصدره MIT المثبّت
  `v2026.9.14`، `hermes_cli/web_routers/sessions.py`: `GET /api/sessions?profile=<p>&sources=telegram,whatsapp&order=recent`
  (حد ١٠٠، `offset`) و`GET /api/sessions/{id}/messages?profile=<p>` (حد ٥٠٠). يكفي ذلك لمجموعة
  «القنوات» للقراءة فقط: عمليتان جديدتان في العقد، منفذ في `sessions` يُركَّب من `agents` في
  `modules/index.ts`، وعارض نص للقراءة فقط. لم يُبنَ هنا لأنه عقد جديد وعمل خادم وواجهة بحجم
  هذه المهمة، ولا يمكن إثباته على Hermes الحقيقي هنا (لا Docker في هذه المهمة).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `sessions.listCategories`: وصف (للبروفايل، مشترك، معنى `session_count`) ومعامل `profiles=all`.
- `sessions.createCategory`: وصف (الموضع، الأسماء الفريدة، الحد، `409`).
- `sessions.updateCategory`: وصف معنى `position`، و`409` موثّق جديد.
- `sessions.deleteCategory`: وصف (المحادثات تبقى وتُعلَن).
- `SessionCreate.category_id` و`SessionPatch.category_id`: وصف (`404` لغير تصنيفات البروفايل).
- لا عمليات جديدة ولا مخططات جديدة ولا أحداث جديدة. DECISIONS §53.

## الملفات والتأثير
الخادم (`packages/server`):
- `modules/sessions/schema.ts` + `drizzle/0016_session_categories.sql`: جدول `session_categories`
  (فهرس فريد `(workspace, name_key)`، وفهرس `(workspace, position)`).
- `modules/sessions/categories.ts` (جديد): قواعد التصنيف كلها — القائمة (وعبر البروفايلات)،
  الإنشاء، التعديل، إعادة الترقيم، الحذف، والعدّ.
- `modules/sessions/service.ts`: `category_id` في الإنشاء والتعديل يُتحقق منه بدل `501`؛
  `deleteCategory` يحرر المحادثات ويعلن عنها.
- `modules/sessions/routes.ts`: المسارات الأربعة.
- `i18n/{ar,en}.json`: رسالتا `409`.
- اختبارات: `modules/sessions/categories.test.ts` (جديد)، `tests/contract/categories.contract.test.ts`
  (جديد)، وحُذف اختبار الـ`501` القديم من `sessions-api.test.ts`.

الويب (`packages/web`):
- `sessions/groups.ts` (جديد، دوال صافية): التجميع، قرار الإفلات، حفظ الطيّ.
- `sessions/categories.ts` (جديد): استعلامات التصنيفات وتعديلاتها.
- `sessions/SessionList.tsx`: المجموعات، رأس المجموعة (طيّ، عدد، شارة البروفايل، قائمة: إعادة
  تسمية، نقل لأعلى/لأسفل، حذف)، زر «تصنيف جديد»، نافذة «نقل إلى تصنيف»، السحب إلى رأس التصنيف.
- `hub/queries.ts`: `category_id` مسموح في تعديل المحادثة (سطر واحد).
- `styles/screens.css`: أنماط المجموعات (منطقية، والسهم يتبع اتجاه القراءة).
- `i18n/{ar,en}.json`: مفاتيح `sessions.categories.*` و`sessions.channels.*`.
- اختبارات: `tests/session-categories.test.tsx` (جديد)، و`e2e/zzzzzzz-session-categories.spec.ts`
  (جديد) مع لقطة `e2e/shots/session-categories-ar-light.png`.

الوثائق: `docs/contracts/DECISIONS.md` §53، `docs/domain/sessions.md` (جدول `session_category`)،
`docs/STATUS.md` (صف sessions ٣٢ من ٣٢، والعدد ٢١٠ من ٢٦٤).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، كلها عبر `mj-run`:

```
$ pnpm exec vitest run src/modules/sessions/categories.test.ts src/modules/sessions/sessions-api.test.ts   (packages/server)
 Test Files  2 passed (2)
      Tests  30 passed (30)

$ pnpm exec vitest run --project contract   (packages/server — contract.test.ts وكل ملفات العقد، ومنها الجديد)
 Test Files  5 passed (5)
      Tests  276 passed (276)

$ pnpm exec vitest run tests/unit/status.test.ts   (packages/server — ٢١٠ من ٢٦٤)
 Test Files  1 passed (1)
      Tests  1 passed (1)

$ pnpm exec vitest run tests/all-profiles.test.tsx tests/agents-top-level.test.tsx tests/session-categories.test.tsx tests/session-menu.test.tsx tests/navigation.parity.test.tsx tests/i18n.test.ts tests/logical-css.test.ts   (packages/web)
 Test Files  7 passed (7)
      Tests  220 passed (220)

$ pnpm build && PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzzz-session-categories.spec.ts
  ✓  1 [chromium] › e2e/zzzzzzz-session-categories.spec.ts:28:1 › 32. a category is made, a chat moved into it, and its collapse survives a reload (3.3s)
  1 passed (9.5s)
   (و--repeat-each=3 على الخادم نفسه: 3 passed — المحاولة الثانية تصنع «عملاء 2» لأن الاسم فريد)

$ pnpm typecheck        → exit 0
$ pnpm lint             → All matched files use Prettier code style! (exit 0)
$ pnpm i18n:check       → i18n:check  OK
$ pnpm nav:check        → nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contracts:check-clients → check-clients  OK — 285 client file(s) scanned, 176 contract path(s) known.
$ pnpm contracts:lint   → Your API description is valid. … contracts:lint  OK
```

الاختبارات الجديدة تفشل على الكود القديم: الخادم كان يجيب `501` على العمليات الأربع وعلى
`category_id`، والقائمة لم يكن فيها `session-group` ولا «نقل إلى تصنيف».

CI على GitHub: يُحدَّث بعد الدفع (انظر الخطوة التالية).

## المخاطر والرجوع
- رقم الترحيل `0016` يأخذه أيضًا #108 (`0016_usage_analytics`) و#110 (`0016_run_file_changes`):
  من يُدمج بعد الآخر يعيد توليد ترحيله برقم تالٍ (`pnpm db:generate`). الجدول جديد ولا يمس
  جداول أخرى.
- `SessionList.tsx` و`service.ts` و`routes.ts` تلمسها طلبات مفتوحة أخرى؛ التعديل هنا محصور
  (منطق التصنيف في ملفين جديدين).
- الرجوع: إرجاع الالتزامات؛ الجدول يبقى فارغًا بلا أثر، و`category_id` الموجود في المحادثات
  يُتجاهل في العرض (يظهر كمحادثة بلا تصنيف).

## التسليم والخطوة التالية
- طلب الدمج مفتوح للمراجعة؛ المالك يؤكد قرارات §53 (خاصة: التصنيف للبروفايل لا للشخص).
- الخطوة التالية المقترحة: مجموعة «القنوات» للقراءة فقط من جلسات Hermes (العمليتان
  والمصدر موصوفان أعلاه)، وإثباتها على Hermes الحقيقي في اختبار `*.real.test.ts`.
- لاحقًا: اختيار لون التصنيف في الواجهة.
