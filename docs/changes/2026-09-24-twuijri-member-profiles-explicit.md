# إصلاح أمني: العضو يدخل فقط البروفايلات التي أُعطيها صراحةً
المسؤول: twuijri · الفرع: fix/member-profiles-explicit · الحالة: review

## المشكلة والهدف
قال المالك (٢٠٢٦-٠٩-٢٤): «انا كنت فاتح يوزر fff لما فتحت بروفايل جديد اضافه لليوزر fff مع
انه مهب ادمن؟ المفروض ما يضيفه له بدون ما ادخل انا واضيفه له؟».

**السبب المؤكَّد** في `packages/server/src/modules/auth/workspace.ts`: القائمة الفارغة لعضوٍ
كانت تعني «كل البروفايلات» (تعليق `membershipIds`: «empty = every workspace, per the
contract»؛ `listWorkspacesFor` يعيد الكل؛ `canEnter` يقبل عند `allowed.length === 0`). فكل عضو
بلا صفوف في `workspace_members` كان يدخل كل بروفايل، **ومنها كل بروفايل يُنشأ لاحقًا**.

ولماذا لم يظهر ذلك للمالك: `presentUser` يعرض في `profiles` ما **يستطيع** المستخدم دخوله، لا
ما أُعطيه. فحين كان `default` وحده موجودًا ظهر `fff` في جدول المستخدمين «default» كأنه منحة
صريحة، ولم يظهر «كل البروفايلات» قطّ (الشاشة كانت تعرضه عند `profiles.length === 0` فقط).

**كيف يصل عضو إلى قائمة فارغة** قبل هذا الإصلاح:
- إنشاؤه من الواجهة البرمجية دون `profiles` (العقد كان يقول «Empty means every profile»).
- «إرجاع إلى عضو» لمشرف من قائمة صفّه: كان يرسل `{ role: 'member' }` وحده، والمشرف لا
  صفوف له، فيصير عضوًا يدخل كل شيء.
- أرشفة البروفايل الوحيد لعضو (تُحذف صفوفه) — فكان يصير عضوًا يدخل كل شيء.

**الهدف**: العضو يدخل البروفايلات الممنوحة له صراحةً فقط. لا منح ضمنيًا أبدًا — لا بإنشاء
بروفايل، ولا بقائمة فارغة. المالك والمشرف كما هما: يدخلان كل بروفايل.

## القرار والموافقات
- **القائمة الفارغة = لا بروفايل**. العضو يستطيع الدخول (تسجيل الدخول ينجح)، لكن
  `GET /profiles` يعيد قائمة فارغة، وكل طلب بـ`X-Hub-Profile` يُرفض `404 profile_not_found`
  مع `details.reason = no_profile_granted` ورسالة «لم يُعطَ حسابك أي بروفايل بعد. اطلب من
  المشرف…» (`workspaceRefusal` في `workspace.ts`). لم يُضَف رمز خطأ جديد: قائمة الرموز ثابتة في
  العقد، والسبب في `details`.
- **إنشاء عضو يتطلّب بروفايلًا واحدًا على الأقل** (`400 validation_failed`،
  `details.field = profiles`، `auth.member_needs_profile`). القاعدة تتبع `role`، فوُثّقت في
  الوصف ولم تُكتب `minItems`.
- **تحويل مشرف إلى عضو** يجب أن يحمل القائمة في الطلب نفسه (الرفض نفسه). في الواجهة: «إرجاع إلى
  عضو» صار يفتح حوار البروفايلات (فارغًا، والحفظ معطّل مع السبب) ويرسل
  `{ role: 'member', profiles }` معًا.
- **`PATCH` بـ`profiles: []` على عضو مسموح** ومعناه صريح: سحب كل البروفايلات. الواجهة لا
  تفعله (حوار البروفايلات لا يحفظ قائمة فارغة، والسبب ظاهر)، لكنه ليس تسريبًا بل أضيق حالة.
- **الأرشفة** تترك العضو الذي كان بروفايله الوحيد بلا بروفايل — لا «الكل». مُختبَر.
- **الترحيل** يحفظ وصول اليوم ولا يمنح المستقبل (انظر «الملفات»).
- **الواجهة**: جدول المستخدمين يعرض قائمة العضو الصريحة، أو «بلا بروفايل» لقائمة فارغة، و«كل
  البروفايلات» للمالك والمشرف وحدهما. والعضو بلا بروفايل يرى بعد الدخول صفحة واحدة: «لا بروفايل
  لك بعد… اطلب من المشرف» مع «تحقّق مرة أخرى» و«تسجيل الخروج» (`shell/ProfileGate.tsx`)، بدل
  واجهة مليئة بأخطاء «البروفايل غير موجود».
- **خارج النطاق عمدًا**: `Webhook.profiles` («Empty means every workspace») نطاق خطّاف لا
  صلاحية شخص، فلم يُمسّ.
- موافقة المالك مطلوبة للدمج؛ لا دمج تلقائي.

## العقد
`packages/contracts/openapi.yaml` (والمرآة `events/common.schema.json`): أوصاف فقط، لا تغيير
شكل:
- `User.profiles`: قائمة العضو هي ما مُنح صراحةً؛ الفارغة = لا بروفايل؛ `default_profile`
  يبقى `default` حينها والعملاء يقرّرون من `profiles`.
- `UserCreate.profiles`: حُذف «Empty means every profile»؛ مطلوب بواحد على الأقل حين
  `role: member`.
- `UserAdminPatch.profiles`: الفارغة تسحب الكل؛ تحويل مشرف إلى عضو يحمل القائمة.
- معامل `X-Hub-Profile`: الرفض و`details.reason = no_profile_granted`.
- `docs/contracts/DECISIONS.md` §29.

`pnpm contracts:generate` لم يترك فرقًا ملتزمًا (العملاء المولَّدون غير ملتزمين؛ Kotlin/Swift
لم تُولَّد محليًا لغياب Java).

## الملفات والتأثير
- الخادم: `modules/auth/workspace.ts` (`membershipIds`، `listWorkspacesFor`، `canEnter`،
  `workspaceRefusal` الجديدة، `resolveWorkspaceFor`؛ الأسماء والتواقيع القديمة كما هي)،
  `modules/auth/users.ts` (`createUser`، `updateUserAsAdmin`)، `modules/auth/routes.ts`
  (`workspaceFor`)، `src/i18n/{ar,en}.json`.
- **الترحيل** `drizzle/0010_member_profiles_explicit.sql` (+ `meta/0010_snapshot.json` و
  `_journal.json`): ترحيل بيانات مكتوب يدويًا (`drizzle-kit generate --custom`) كـ`0002`. يسجّل
  كل **عضو** ليس له أي صف في كل بروفايل **غير مؤرشف موجود وقت الترحيل**. الأعضاء ذوو القوائم
  الصريحة والمالك والمشرفون لا يُمسّون، والبروفايل المُنشأ بعده لا يُعطى لأحد. المعرّفات بشكل
  ULID تُصنع في SQL (لا تطبيق في ترحيل)، و`owner_id` هو مالك المجلس. يشمل العضو المعطَّل أيضًا
  (كان وصوله الضمني هو نفسه، ويعود كما كان إن فُعِّل).
  **PostgreSQL**: لا مجلّد `drizzle/pg` بعد (`src/db/README.md`)، فالترحيل على PostgreSQL لا
  يطبّق شيئًا اليوم لأي ترحيل؛ يوم يُولَّد المجلد يلزمه نظير هذا الملف.
- الويب: `people/UsersTab.tsx` (`WorkspacesCell`، `EditWorkspaces` بوضع `makeMember`)،
  `shell/ProfileGate.tsx` (جديد)، `app.tsx`، `i18n/{ar,en}.json`
  (`people.no_workspace`، `people.make_member_for`، `shell.no_profile_*`).
- الوثائق: `docs/domain/auth.md`، `docs/domain/DECISIONS.md` §19،
  `packages/server/src/modules/auth/README.md`، `docs/STATUS.md`، `docs/contracts/DECISIONS.md` §29.
- الاختبارات: `modules/auth/members.test.ts` (جديد)، `modules/auth/roles.test.ts`،
  `tests/unit/member-profiles-migration.test.ts` (جديد)، `web/tests/people.test.tsx`،
  `web/tests/profile-gate.test.tsx` (جديد)، `web/e2e/smoke.spec.ts` (الرحلة ١٣)، ولقطة
  `web/e2e/shots/no-profile-ar-light.png` (جديدة).

## الفحوص (الأوامر ونواتجها الفعلية)
**الاختبارات الجديدة تفشل على الكود القديم** (أُعيد `workspace.ts`/`users.ts`/`routes.ts`
وحُذف الترحيل مؤقتًا، ثم أُرجع كل شيء):
```
× enrolls empty-list members in the workspaces that exist now, and nobody else
× a member cannot be created with no profile: the list is required and explicit
× making an admin a member names their profiles in the same request
× a member whose list is empty signs in and enters nothing, with a reason
× archiving a member's only profile leaves them with none, not with every profile
FAIL roles.test.ts (member created with no list → expected 400)
Tests  5 failed | 2 passed | 7 skipped (14)

web (UsersTab القديم):
× names a member's explicit profiles, or "No profile" — never "Every profile"
× will not save a member's profiles as an empty list, and says why
× makes an admin a member only together with the profiles they may enter
Tests  3 failed | 14 passed (17)
```
ملاحظة صادقة: سيناريو المالك بقائمة صريحة (`fff` له `default` ثم يُنشأ بروفايل) كان يمرّ على
الكود القديم أيضًا — التسريب يحتاج قائمة فارغة، وهي ما تغطّيه الاختبارات الفاشلة أعلاه. بقي
الاختبار حارسًا للانحدار، ويتحقّق أيضًا أن جدول المستخدمين يسمّي `default` وحده بعد الإنشاء.
و`EditWorkspaces` كان يعطّل الحفظ على قائمة فارغة من قبل؛ الجديد فيه أن قائمة العضو صارت هي
الممنوحة فعلًا (كانت تُملأ بكل البروفايلات لعضو قائمته فارغة، فيثبّت الحفظ «الكل»).

بعد الإصلاح:
```
pnpm lint                     → All matched files use Prettier code style! (eslint نظيف)
pnpm typecheck                → exit 0
pnpm contracts:lint           → Your API description is valid. / contracts:lint OK
pnpm contracts:generate       → wrote generated/ts/schema.ts (Java غير موجود: Kotlin/Swift لم تُولَّد)
pnpm contracts:check-clients  → check-clients OK — 214 client file(s) scanned, 166 contract path(s) known.
pnpm --filter @majlis/contracts test → Tests 15 passed (15)
pnpm contract:test            → Test Files 2 passed (2) · Tests 254 passed (254)
pnpm i18n:check               → web: 817 keys, ar/en in parity · OK
pnpm nav:check                → OK — 34 destinations, 2 pre-auth screens, 38 terms
pnpm --filter @majlis/server test → Test Files 72 passed | 6 skipped (78) · Tests 750 passed | 18 skipped (768)
pnpm --filter @majlis/web test    → Test Files 35 passed (35) · Tests 452 passed (452)
pnpm db:generate              → No schema changes, nothing to migrate 😴 (لا فرق بعد الترحيل)
DATA_DIR=<tmp> pnpm db:migrate → db: migrations applied (sqlite) · __drizzle_migrations = 11
DATABASE_URL=postgres://…@localhost:55433/hub pnpm db:migrate (postgres:16-alpine في Docker)
  → "db: PostgreSQL migrations are not generated yet (drizzle/pg); nothing applied"
pnpm build                    → exit 0
PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e → 26 passed (1.8m) (بعد إضافة خطوة «nour» إلى الرحلة ١٣)
```
- **الرحلة ١٣** صارت تتحقّق: سارة أُضيفت بـ`default`، ثم أُنشئ «Labs»؛ صفّها يبقى `default`
  بلا `labs`؛ دخولها عبر الواجهة البرمجية يعطي `['default']` ويُرفض `X-Hub-Profile: labs`
  بـ404؛ ودخولها في المتصفح يعرض مبدّل البروفايل بخيار واحد بلا Labs. ثم عضو «nour» تُسحب كل
  بروفايلاته فيرى صفحة «لا بروفايل لك بعد» (لقطة `no-profile-ar-light.png`) وصفّه «بلا بروفايل»،
  ثم يُحذف كي لا تتأثّر الرحلات التالية.
- اللقطات الأخرى التي أعاد Playwright كتابتها أُرجعت كما كانت.
- **بعد إعادة القاعدة على `origin/main` (`90305f1`، فيه تغيير مبدّل البروفايل في الشريط)**
  أُعيد كل شيء: lint نظيف، typecheck exit 0، web 452/452، server 750 passed | 18 skipped،
  contract:test 254/254، check-clients وi18n وnav OK، `db:generate` بلا فرق، build exit 0،
  و`web:e2e` → 26 passed (1.7m).

## المخاطر والرجوع
- **من قد يتأثّر**: كل عضو كانت قائمته فارغة كان يدخل **كل** بروفايل، بما فيها ما أُنشئ بعده
  (محادثاته ووكلاؤه ومهامه وجداوله). بعد الترقية يحتفظ بما كان موجودًا يوم الترقية فقط؛ ما أُنشئ
  بين تسرّب الوصول واليوم يبقى ضمن قائمته لأنه كان موجودًا وقت الترحيل — **على المالك مراجعة
  قوائم الأعضاء بعد الترقية** وسحب ما لا يريده (مثل بروفايل أُنشئ بعد `fff`).
- عميل قديم يُنشئ عضوًا بلا `profiles` سيُرفض الآن بـ400 (مقصود).
- ترقيم الترحيل `0010`: إن دُمج قبله فرع آخر يضيف `0010` فلا بد من إعادة توليد هذا الترحيل
  برقم تالٍ قبل الدمج.
- الرجوع: الفرع وحده للكود. الترحيل يضيف صفوفًا فقط؛ الرجوع عنه لا يلزم (الصفوف صريحة وصحيحة
  تحت القاعدة القديمة أيضًا).

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية موسوم إصلاحًا أمنيًا: https://github.com/twuijri/majlis/pull/74 — الدمج للمالك. بعد الدمج: مراجعة قوائم الأعضاء
على المجلس الحي. متابعة مقترحة (خارج النطاق): إن فقد عضو البروفايل المخزَّن في جهازه وبقي له
غيره، يفتح الويب أول بروفايل ممنوح بدل صفحات «غير موجود».
