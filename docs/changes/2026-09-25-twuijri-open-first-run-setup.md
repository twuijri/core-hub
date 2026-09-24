# التهيئة الأولى مفتوحة ساعةً بعد الإقلاع، واسترجاع المركز بـ COREHUB_RESET_OWNER
المسؤول: twuijri · الفرع: feat/open-first-run-setup · الحالة: review

## المشكلة والهدف
منذ ADR 0011 لا يُنشأ حساب المالك إلا برمز تهيئة يكتبه المركز في `<DATA_DIR>/setup-token.txt`
ويطبعه في سجلّه، وشاشة `/setup` تطلبه. قراءة الرمز من الطرفية أو السجلّ صعبة على كثير من الناس
(من يركّب من لوحة استضافة ولا يفتح طرفية). المالك (٢٠٢٦-٠٩-٢٥):
«ابي طريقة … التسجيل الاول مفتوح … اول ما تخلص حتى لو ثواني ولقطه بوت انت الي تتحكم تقدر تطفيه»،
وعن المدة: «ايه خله ساعة».

الهدف: تسجيل أول مفتوح بلا رمز لمدة محدودة بعد الإقلاع، والرمز احتياطٌ بعدها، وطريقة استرجاع
للمركز إن سبق إليه غريب.

## القرار والموافقات
قرار المالك أعلاه؛ التفاصيل في ADR 0019 (يحلّ محلّ قاعدة «الرمز فقط» في ADR 0011) وقرار العقد §45.

1. **النافذة المفتوحة:** إن بدأ المركز بلا مالك فالتهيئة مفتوحة `COREHUB_SETUP_OPEN_MINUTES` دقيقة
   (الافتراضي 60) من لحظة الإقلاع: `POST /auth/setup` ينشئ المالك باسم وكلمة مرور بلا رمز (والويب
   و`corehub setup` لا يطلبانه). بعدها يلزم الرمز كما كان. الرمز ما زال يُولَّد ويُكتب ويُطبع كل
   إقلاع بلا مالك. **إعادة التشغيل تفتح نافذة جديدة** فلا حاجة للطرفية.
2. **إعداد واحد:** `COREHUB_SETUP_OPEN_MINUTES=0` هو الوضع الصارم (الرمز فقط). لم أضف
   `COREHUB_SETUP_MODE`؛ رقم واحد يغني عن متغيرين قد يتناقضان. — مقترح، للمالك أن يؤكد.
3. **`meta.get`** يضيف `setup_open` و`setup_open_until`. لم أضف `needs_owner`: الحقل الموجود
   `setup_required` هو نفسه «يحتاج مالكًا» (صار يعني: لا يوجد صف بدور owner)، وحقلان بالمعنى نفسه
   جوابان لسؤال واحد. — مقترح، للمالك أن يؤكد.
4. **بعد وجود المالك** تُغلق التهيئة نهائيًا (`409`). حماية السباق صارت فعلية: «لا مالك بعد» يُفحص
   مرة ثانية داخل المعاملة التي تنشئ المالك، فتهيئتان في اللحظة نفسها تُنشئان مالكًا واحدًا والأخرى
   `409` (قبلها كان الفحص قبل المعاملة فقط، وكان يمكن نظريًا أن تنجح الاثنتان).
5. **الاسترجاع `COREHUB_RESET_OWNER=1` مع إعادة تشغيل:** يعطّل حساب/حسابات المالك **ويُنزلها إلى
   admin** ويلغي كل رموزها وجلساتها، ولا يحذف شيئًا؛ ويفتح التهيئة بنافذة جديدة؛ ويكتب في السجلّ
   تحذيرًا واضحًا بأرقام الحسابات. **الإنزال إلى admin إضافة مني**: صف المالك لا يغيّره أحد
   (`auth.owner_immutable`)، فبدونه لا يستطيع المالك الجديد إعادة تفعيل القديم أو حذفه من Users كما
   طلب المالك. — مقترح، للمالك أن يؤكد.
6. **مرة واحدة:** العلامة `<DATA_DIR>/owner-reset.json` (وقت الاسترجاع وأرقام الملاك المعطَّلين). ما
   دامت موجودة يُتجاهل المتغير (ويقول السجلّ ذلك)، فلا يُعاد الاسترجاع على المالك الجديد إن بقي المتغير
   في ملف compose. إقلاع بلا المتغير يحذف العلامة فيصلح استرجاع لاحق. العلامة تُكتب حتى لو لم يوجد
   مالك، كي لا يعيد متغيرٌ ضُبط في أول إقلاع ضبطَ المالك الذي سيُنشأ بعده. الطلب قال «مفتاحها رقم
   المالك الحالي»؛ مفتاح برقم المالك وحده كان سيعيد الاسترجاع على المالك الجديد (رقمه مختلف)، فجعلت
   المفتاح وجود العلامة والأرقام سجلًّا لما حدث. — مقترح، للمالك أن يؤكد.
7. **الحسابات الأخرى** تبقى كما هي، لكن الدخول يرجع `auth.setup_required` إلى أن يوجد المالك الجديد
   (المركز في وضع التهيئة). `HUB_ADMIN_PASSWORD` بلا تغيير (يعمل على مركز فارغ فقط).
8. **الشاشة:** في النافذة تقول «التسجيل مفتوح لأول شخص يفتح هذه الصفحة — أكمله الآن» مع الوقت
   المتبقي (عدّ تنازلي)، ولا حقل رمز. عند انتهاء العدّ تسأل المركز من جديد وتعرض حقل الرمز مع أين
   تجده وأن إعادة التشغيل تفتح التهيئة مجددًا. بالعربية والإنجليزية.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `Meta`: حقلان مطلوبان جديدان `setup_open` (boolean) و`setup_open_until` (date-time أو null)،
  ووصف `setup_required` صار «يحتاج مالكًا» صراحةً؛ المثالان (meta.get وجواب claim الاقتران) حُدّثا.
- `SetupRequest.token` لم يعد مطلوبًا؛ وصف `auth.completeSetup` وجوابه `401` حُدّثا.
- قرار العقد §45 في `docs/contracts/DECISIONS.md`.

## الملفات والتأثير
- الخادم: `app/config.ts` (المتغيران)، `app/routes.ts` و`app/server.ts` (حقول meta عبر
  `setupMetaFor`)، `modules/auth/setup.ts` (النافذة، `setupMeta`، فحص السباق داخل المعاملة،
  `resetOwnerOnBoot`/`ownerResetLog`)، `auth/index.ts` (ترتيب الإقلاع: bootstrap ← reset ← نافذة/رمز)،
  `auth/routes.ts` (الرمز اختياري داخل النافذة، `auth.setup_token_required`)، `auth/users.ts`
  (`setupRequired` = لا مالك)، `auth/context.ts` (`setupOpenUntil`)، `i18n/{ar,en}.json`.
- الطرفية: `commands/auth.ts` (لا يسأل عن الرمز في النافذة)، `i18n/{ar,en}.json`.
- الويب: `screens/SetupScreen.tsx`، `hub/queries.ts` (`useSetupWindow`)، `auth/context.tsx` (الرمز
  اختياري)، `i18n/{ar,en}.json`.
- الاختبارات: `auth/setup-window.test.ts` (جديد)، `auth/setup.test.ts` (صار على وضع الرمز فقط
  صراحةً)، `tests/unit/config.test.ts`، `tests/contract/auth.contract.test.ts`،
  `cli/tests/integration/setup.test.ts`، `web/tests/setup-screen.test.tsx`، `web/e2e/setup.spec.ts`
  ولقطتاها.
- الوثائق: ADR 0019 (جديد) وسطر الحالة في ADR 0011، `docs/DEPLOY.md` §1 و§2، `docs/STATUS.md`
  «First run»، `docs/ARCHITECTURE.md` (الثابت ٥)، `README.md`، `.env.example`، `docker-compose.yml`
  (يمرّر المتغيرين الاختياريين)، `packages/server/src/db/README.md`، `modules/auth/README.md`.
- ترقية المكدّسات القائمة: لا تغيير مطلوب؛ مركز له مالك لا يتأثر، والمتغيران اختياريان.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (عبر `mj-run`)، الملفات التي أضفتها أو غيّرتها فقط، والباقي في CI:

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck            # خرج بـ 0، بلا أخطاء

$ pnpm i18n:check
i18n:check  cli: 252 keys, ar/en in parity
i18n:check  web: 1301 keys, ar/en in parity
i18n:check  OK

$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 273 client file(s) scanned, 175 contract path(s) known.

$ (packages/server) vitest run src/modules/auth/setup-window.test.ts src/modules/auth/setup.test.ts \
    tests/unit/config.test.ts src/modules/auth/auth.test.ts tests/unit/http.test.ts \
    tests/contract/auth.contract.test.ts
 Test Files  6 passed (6)
      Tests  36 passed (36)

$ (packages/server) vitest run --project contract tests/contract/auth.contract.test.ts tests/contract/contract.test.ts
 Test Files  2 passed (2)
      Tests  266 passed (266)

$ (packages/cli) vitest run tests/integration/setup.test.ts
      Tests  5 passed (5)

$ (packages/web) vitest run tests/setup-screen.test.tsx
      Tests  6 passed (6)

$ pnpm build && PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/setup.spec.ts
  ✓  1 [chromium] › e2e/setup.spec.ts:19:3 › web smoke journeys (a hub with no owner) › 4. first run: inside the open window the owner is created with no token and signed in (897ms)
  1 passed (8.0s)
```

`pnpm change-record:check` ونتيجة CI تُضاف بعد الدفع.

## المخاطر والرجوع
- **تعرّض حقيقي لمدة ساعة** على نطاق عام: من يصل أولًا يصبح المالك. هذا ما قرّره المالك؛ الشاشة
  تقول ذلك وتطلب الإكمال الآن، والاسترجاع متاح. من يريد السلوك القديم يضبط
  `COREHUB_SETUP_OPEN_MINUTES=0`.
- الساعة محسوبة من ساعة الخادم، والعدّ التنازلي في المتصفح من ساعة الجهاز؛ فرق الساعتين يغيّر
  المعروض فقط، والخادم هو الحكم (وعند 401 تسأل الشاشة من جديد).
- بعد الاسترجاع وقبل المالك الجديد لا يدخل أحد (حتى المشرفون)؛ مقصود ومذكور في DEPLOY.
- الرجوع: revert لهذا الـPR يعيد «الرمز فقط». علامة `owner-reset.json` إن وُجدت لا يقرؤها الكود
  القديم، ولا ضرر منها.

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية؛ بلا دمج ولا صورة. بانتظار CI ثم مراجعة المالك وتأكيد البنود المعلَّمة
«مقترح» أعلاه (إعداد واحد بدل اثنين، عدم إضافة `needs_owner`، الإنزال إلى admin، مفتاح العلامة).
