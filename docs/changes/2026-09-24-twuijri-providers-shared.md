# المزوّدون ومفاتيحهم ونماذجهم للمركز كله، واختيار النموذج لكل بروفايل
المسؤول: twuijri · الفرع: fix/providers-shared-across-profiles · الحالة: review

## المشكلة والهدف
قاعدة المالك وADR 0010: يُضاف المزوّد **مرة واحدة** ويرثه كل وكيل وكل بروفايل، بلا إدخال مفتاح لكل
بروفايل. وجد وكيل PR #83 (المحادثة في بروفايل هرمز الخاص بها) أن هذا ليس ما يحدث. تحققت من كل نقطة على
`main` بكتابة اختبارات فشلت عليه:

1. **المزوّدون كانوا لكل بروفايل** (صفوف `providers` و`models` و`secrets` مقيّدة بالبروفايل). بروفايل
   جديد بلا مزوّد ولا نموذج، فلا يسمّي الدور نموذجًا ويرفض هرمز. — صحيح (اختبار «lets a profile made
   after the provider run a turn…» فشل: `expected null to be 'llama-3.3-70b-versatile'`).
2. **الحفظ في أي بروفايل يكتب فوق بروفايل هرمز الافتراضي**: `propagate(scope)` كان يكتب حالة البروفايل
   الذي يحفظ فيه الشخص في `.env` و`config.yaml` في منزل هرمز الجذري وفي بيئة العملية؛ فنموذج هرمز
   الافتراضي صار نموذج آخر بروفايل حفظ، ومفاتيح البروفايلات الأخرى سقطت من بيئة العملية، وإعادة
   المطابقة عند الإقلاع تمرّ على كل البروفايلات فيفوز آخرها. — صحيح (اختبار «keeps the default
   profile's keys and model…» فشل).
3. **ما فعله #83**: نقاط المزوّدين (`providers:`) تُكتب في `config.yaml` كل بروفايل، والمفاتيح تصل عبر
   بيئة العملية. وجدت فوق ذلك عيبًا ثالثًا: هرمز يقرأ `.env` البروفايل **قبل** بيئة العملية
   (`agent/secret_scope.py` §get_secret في v2026.9.14)، وبروفايل منسوخ من `default` (`--clone-from`، وهي
   طريقة #83 لإنشاء البروفايل المفقود) يحمل نسخة من `.env` الجذري. فتغيير المفتاح في المركز لا يصل إليه،
   والمفتاح المحذوف يبقى يعمل فيه، ونسخ المفاتيح قابعة في مجلد البروفايل. — أثبته اختبار هرمز الحقيقي
   أدناه (البروفايل الضابط أرسل المفتاح القديم).
4. **حذف مزوّد لم يكن يزيل مفتاحه من `.env` الجذري**: الأسماء «المملوكة» كانت أسماء المفاتيح الحالية
   فقط. — صحيح.

## القرار والموافقات
- **المزوّدون والمفاتيح والنماذج للمركز** (DECISIONS §34، العقد عُدّل أولًا): قائمة واحدة، مخزّنة تحت
  البروفايل الافتراضي — موجود دائمًا ولا يُعاد تسميته ولا يُؤرشف — وكل عمليات المزوّدين تعمل عليها أيًّا
  كان `X-Hub-Profile`. إضافة المزوّد نفسه من بروفايل آخر `409 provider_exists`. `Provider.profile` دائمًا
  `default`. المفاتيح تبقى `[stored]`.
- **ما يبقى لكل بروفايل: الاختيارات.** النموذج الافتراضي والأدوار المساعدة واختيار مزوّد الكلام. ما لم
  يختره البروفايل يأتي من البروفايل الافتراضي، و`ModelDefaults.inherited` (جديد، اختياري) يسمّي ما ورثه.
  الحفظ في بروفايل يجعله اختياره؛ حفظ `null` يعيده إلى الوراثة. «أول نموذج افتراضي» الذي يضعه المركز
  بنفسه صار للبروفايل الافتراضي. — **مقترح، ينتظر تأكيد المالك**: الوراثة من البروفايل الافتراضي بدل
  أن يكون لكل بروفايل اختياره المستقل من الصفر.
- **هرمز**: منزله الجذري = بروفايله `default` = بروفايل المجلس الافتراضي: مفاتيح المركز ونموذج البروفايل
  الافتراضي، أيًّا كان من حفظ. البروفايل المسمّى: نقاط المزوّدين في `config.yaml` الخاص به، والمفاتيح من
  بيئة العملية (طريقة #83 كما هي)، و**تُزال أسماء مفاتيح المركز من `.env` الخاص به** (بقية سطوره كما
  هي) — فلا نسخ للمفاتيح في مجلدات البروفايلات، وتصدير #88 لا يجد فيها شيئًا منها. يحدث هذا مع كل حفظ،
  وبعد أن ينشئ المركز بروفايلًا مباشرة، وقبل كل دور في بروفايل مسمّى (`prepareRuntimeProfile` في منفذ
  `agents`)، فالبروفايل الذي يُنشأ لاحقًا — في المركز أو في هرمز أو عند أول استعمال — جاهز قبل أن يعمل.
- **الحذف يصل كل مكان**: أسماء المتغيرات المملوكة صارت كل اسم كتبه المركز لمزوّد عنده أو كان عنده
  (الصف المحذوف يبقى مؤرشفًا)، فالمفتاح المحذوف يُزال من `.env` الجذري. ونموذج افتراضي يشير إلى مزوّد
  محذوف لم يعد اختيارًا.
- **الترحيل** (`drizzle/0011_providers_shared.sql`، ترحيل بيانات مكتوب يدويًا): كل مزوّد حيّ في بروفايل
  حيّ ينتقل إلى البروفايل الافتراضي بمعرّفه نفسه. المزوّد نفسه (الـ slug نفسه) في أكثر من بروفايل:
  **يبقى صف البروفايل الافتراضي، وإلا صف أقدم بروفايل** (`created_at` ثم المعرّف)؛ الباقي يُؤرشف في
  مكانه بمفتاحه، ويُكتب لكل اختيار صف تدقيق `provider.merged` يسمّي البروفايلين. مفتاح عائلة الاعتماد: مفتاح
  أعلى بروفايل بالترتيب نفسه **عنده مفتاح**. النماذج التي ينقصها الصف الباقي تُنقل إليه؛ والنماذج
  الافتراضية واختيار الكلام تُوجَّه إليه. لا يُحذف شيء؛ صف محذوف أو مفتاح ممسوح في البروفايل الافتراضي
  يحمل الاسم نفسه يُعاد تسميته `<name>~<id>`. البروفايلات المؤرشفة لا تُمس. معرّف قديم (جلسة، تثبيت وكيل،
  فِرقة) يُحل عند القراءة إلى الصف الباقي بالـ slug نفسه. — قاعدة الاختيار **مقترحة، تنتظر تأكيد المالك**.
- رُفض: نسخة من كل مزوّد في كل بروفايل (هي إدخال المفتاح لكل بروفايل الذي رفضه ADR 0010)؛ عملية عامة
  جديدة بجانب `listProviders`؛ معرّف مساحة «مركز» وهمي.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `openapi.yaml`: وصف `models.listProviders` و`models.createProvider` و`models.getDefaults` و`Provider`
  (للمركز لا للبروفايل، و`profile` دائمًا `default`)؛ حقل جديد اختياري `ModelDefaults.inherited`.
- `docs/contracts/DECISIONS.md` §34.

## الملفات والتأثير
- `packages/server/src/modules/models/service.ts`: `hub()` (البروفايل الافتراضي، مخزّن)،
  `canonicalProvider` / `canonicalModel`، كل عمليات المزوّدين والنماذج والمفاتيح على القائمة الواحدة،
  `effectiveDefault` والوراثة في `getDefaults` / `defaultRefFor` / النموذج الذي يُسمّى لهرمز، وراثة
  اختيار الكلام، `propagate` بحالة البروفايل الافتراضي دائمًا، `ownedEnvNames`، `prepareProfile`.
- `packages/server/src/modules/models/propagation.ts`: `PropagationState.ownedEnv`.
- `packages/server/src/modules/models/index.ts`: `hubScope`، إعادة المطابقة عند الإقلاع مرة واحدة،
  `prepareRuntimeProfile` في المنفذ.
- `packages/server/src/modules/agents/ports.ts`، `agents/index.ts`: `prepareRuntimeProfile?` قبل دور
  البروفايل المسمّى.
- `packages/server/src/modules/index.ts`: تجهيز البروفايل بعد إنشائه في هرمز.
- `packages/server/src/modules/models/schema.ts`: تعليق الرأس.
- `packages/server/drizzle/0011_providers_shared.sql` + `meta/0011_snapshot.json` + `_journal.json`.
- الويب: `packages/web/src/models/ModelsScreen.tsx` (علامة «من البروفايل الافتراضي» على ما ورثه
  البروفايل)، `queries.ts` (الحفظ يُبطل بيانات النماذج في كل البروفايلات)، `i18n/ar.json` و`en.json`
  (نص «مشتركون بين كل البروفايلات» وتلميح الافتراضيات والعلامة).
- اختبارات: `models/providers-shared.test.ts` (6 جديدة)، `tests/unit/providers-shared-migration.test.ts`
  (2)، `agents/adapters/providers-shared.real.test.ts` (هرمز الحقيقي، 2)،
  `web/tests/models-screen.test.tsx` (+2)، `web/e2e/zzzzz-providers-shared.spec.ts` (رحلة جديدة) ولقطة
  `providers-shared-studio-ar-light.png` ولقطتا `design-models-*` (تغيّر النص).
- `docs/domain/models.md`، `docs/STATUS.md` (صف models).

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبارات الجديدة على كود `main` (ملفات `src` من `origin/main` مع ملفات الاختبار الجديدة):

```
$ npx vitest run --project unit src/modules/models/providers-shared.test.ts   (src من main)
     × lists a provider added in one profile, with its key and models, in every other
     × lets a profile made after the provider run a turn on it, with no setup in that profile
     × applies an edit or a removal made in one profile to every profile
     × uses the default profile's chat model in a profile that chose none, and its own once it chooses
     × keeps the default profile's keys and model when providers are saved in another profile
     × keeps the hub's keys out of a named profile's own .env, so a changed key is the key used
      Tests  6 failed (6)
$ npx vitest run tests/models-screen.test.tsx   (packages/web/src من main)
     × says the providers are shared by every profile, in both languages
     × marks a default this profile inherited from the default profile, and only that one
      Tests  2 failed | 21 passed (23)
```
اختبار الترحيل يفشل على `main` لأن الترحيل غير موجود فيه.

هرمز الحقيقي (مرة واحدة، بعد التأكد أن لا حاوية `majlis`/`sealed-check` لوكيل آخر تعمل؛ الصورة
`majlis:local` الموجودة، هرمز v2026.9.14): مزوّد يُضاف عبر واجهة المركز بمفتاح، ثم بروفايلان نسخة من
`default`، ثم يتغيّر المفتاح في المركز، ثم بروفايل من الصفر. عملية TUI واحدة والمفتاح في بيئتها فقط؛
النموذج المحلي يردّ بالمفتاح الذي وصله. النتيجة: البروفايل الجديد يجيب بالمفتاح الحالي بعد تجهيزه؛ البروفايل
الضابط غير المجهّز أرسل **المفتاح القديم** (يثبت أن `.env` البروفايل يغلب البيئة)، وبعد تجهيزه المفتاح
الحالي؛ والبروفايل الذي عرفه المركز عند الحفظ لم يعد فيه المفتاح وأرسل الحالي. (شُغّل من
`models/providers-shared.real.test.ts` ثم نُقل الملف إلى `agents/adapters/` لقاعدة الاستيراد دون تغيير
منطقه؛ لم يُعَد تشغيله بعد النقل، والـ typecheck يغطي الاستيرادات.)

```
$ MAJLIS_HERMES_IMAGE=majlis:local npx vitest run --maxWorkers=1 providers-shared.real
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  22.11s
```

كل أمر ثقيل عبر `mj-run` (عاملان لـ vitest، حد 7 GB)، بعد دمج `origin/main` (1be8486، PR #87؛ تعارض في
`DECISIONS.md` حُلّ بإبقاء §33 من `main` ثم §34):

```
$ pnpm lint                      -> exit 0 (All matched files use Prettier code style!)
$ pnpm typecheck                 -> exit 0
$ pnpm contracts:lint            -> contracts:lint  OK
$ pnpm contracts:check-clients   -> check-clients  OK — 243 client file(s) scanned, 167 contract path(s) known.
$ pnpm contract:test             -> Tests  255 passed (255)
$ pnpm i18n:check                -> i18n:check  OK
$ pnpm nav:check                 -> nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/server test
 Test Files  83 passed | 10 skipped (93)
      Tests  874 passed | 28 skipped (902)
$ pnpm --filter @majlis/web test
 Test Files  43 passed (43)
      Tests  542 passed (542)
$ pnpm build                     -> exit 0 (✓ built)
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  38 passed (2.5m)
  ✓ 38 e2e/zzzzz-providers-shared.spec.ts › one provider list for every profile › a provider added in a second profile is on the default profile too, …
```
لقطات الشاشة التي تغيّرت دون علاقة بهذه المهمة أُعيدت كما كانت.

## المخاطر والرجوع
- **تغيّر سلوك مرئي**: من كان عنده مزوّدات مختلفة في بروفايلات مختلفة يرى الآن قائمة واحدة، والعضو في
  بروفايل آخر يرى مزوّدي المركز كلهم (المفاتيح مخفية). المكرّرات تُؤرشف بمفاتيحها ولا تُحذف.
- **`.env` البروفايلات المسمّاة**: تُزال منها أسماء مفاتيح المركز. من وضع مفتاحًا بنفسه في `.env`
  بروفايل تحت اسم يملكه المركز (مثل `ANTHROPIC_API_KEY`) يفقده هناك ويعمل بمفتاح المركز. من يشغّل
  `hermes -p <profile>` في صدفة داخل الحاوية دون بيئة المركز لا يجد المفتاح في مجلد البروفايل.
- **الترحيل لا يُعاد عكسه تلقائيًا**: الرجوع عن الـ PR يعيد الكود، لكن الصفوف تبقى تحت البروفايل الافتراضي؛
  البروفايلات الأخرى تبدو فارغة حتى يُعاد إضافة مزوّداتها (الصفوف المؤرشفة وصفوف التدقيق `provider.merged`
  تقول ما كان فيها).
- لم يُغيَّر: الفِرَق (ensembles) تحفظ معرّف المزوّد كما هو، ويُحل المعرّف القديم عند القراءة فقط؛ سجلات
  الاستخدام تبقى بمعرّفاتها.

## التسليم والخطوة التالية
- PR إلى `main` للمراجعة (رابطه في رسالة التسليم). ينتظر تأكيد المالك على: الوراثة من البروفايل
  الافتراضي، وقاعدة اختيار المكرّر في الترحيل.
- PR #88 (تصدير البروفايل) يستعمل §33 أيضًا؛ من يُدمج ثانيًا يعيد الترقيم.
