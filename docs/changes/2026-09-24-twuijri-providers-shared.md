# المزوّد لكل البروفايلات أو لبروفايل واحد، واختيار النموذج لكل بروفايل
المسؤول: twuijri · الفرع: fix/providers-shared-across-profiles · الحالة: review

## المشكلة والهدف
قاعدة ADR 0010: يُضاف المزوّد **مرة واحدة** ويرثه كل وكيل. وجد وكيل PR #83 أن هذا لا يحدث، وتحققت
على `main` باختبارات فشلت عليه:

1. **المزوّدون كانوا لكل بروفايل فقط.** البروفايل الجديد يبدأ بلا مزوّد ولا نموذج، فيرفض هرمز أدواره.
2. **الحفظ في أي بروفايل كان يكتب فوق بروفايل هرمز الافتراضي.** مفاتيح البروفايل الذي حفظ ونموذجه
   كانت تُكتب في المنزل الجذري وفي بيئة العملية. وعند الإقلاع يفوز آخر بروفايل يمرّ عليه الكود.
3. **هرمز يقرأ `.env` البروفايل قبل بيئة العملية** (`agent/secret_scope.py` في v2026.9.14).
   بروفايل منسوخ من `default` يحمل نسخة من `.env` الجذري، فلا يصله تغيير المفتاح.
4. **حذف المزوّد لم يكن يزيل مفتاحه من `.env` الجذري.**

النسخة الأولى من هذا الـ PR جعلت القائمة واحدة للمركز كله. **رفضها المالك**: قد يكون لكل فريق اشتراكه
في بروفايله، مثل بروفايل التصميم وبروفايل المالية وكلٌّ بمفتاح OpenAI خاص. وقال المالك عن القائمة
الواحدة: «كذا بيدمجهم بحساب واحد وهي مشكله». وهرمز يدعم هذا بنفسه، فـ`.env` البروفايل يغلب بيئة
العملية.

## القرار والموافقات
قرارات المالك كما أقرّها واحدًا واحدًا (نقلها المنسّق في 2026-09-24):

1. **نطاقان.** زر «إضافة مزوّد» يسأل «لمن هذا المزوّد؟ / Who is this provider for?»:
   - «كل البروفايلات / All profiles»: الافتراضي، ويجعل المزوّد مشتركًا.
   - «هذا البروفايل فقط / This profile only»: للبروفايل المختار في الأعلى.
   - تحمل كل بطاقة في القائمة شارة «مشترك / Shared» أو «<البروفايل> فقط / <profile> only».
   - التعديل لا ينقل مزوّدًا بين النطاقين، فلا حقل `scope` في `updateProvider`.
2. **الحلّ.** إذا كان للبروفايل مزوّد خاص من النوع نفسه (الـ slug نفسه) غلب المشترك، وإلا استُعمل
   المشترك. البروفايل الفارغ الجديد يأخذ كل المزوّدين المشتركين ويعمل فورًا.
3. **المفاتيح.**
   - المفاتيح المشتركة تصل هرمز عبر بيئة العملية كما في #83.
   - مفاتيح البروفايل الخاصة تُكتب في `.env` بروفايله عند هرمز، فتغلب.
   - تعريف المزوّدات المخصّصة (`majlis-*`) يُكتب في كل بروفايل يستعملها، والجذر منها.
   - المفاتيح لا تعود للعميل (`[stored]`).
4. **النموذج الافتراضي لكل بروفايل.** البروفايل الذي لم يختر نموذجًا يرث اختيار البروفايل
   الافتراضي (المالك: «صح»). يسمّي `ModelDefaults.inherited` الأدوار الموروثة.
5. **النسخ.** البروفايل المنسوخ من آخر يأخذ مزوّدات المصدر الخاصة **مع مفاتيحها** («علشان لو الكي
   نسيته ما ابلش وينه»)، ويحذف المالك ما لا يريده.
6. **التصدير يسأل «مع المزوّدين / بدون المزوّدين».**
   - «بدون» هو الافتراضي، ولا مفاتيح في الملف كما كان.
   - «مع» يضيف `<profile>/majlis-providers.json`، وفيه مزوّدات البروفايل الخاصة والمشتركة التي يستعملها
     بمفاتيحها مكشوفة، ويحذّر الحوار من ذلك.
   - الاستيراد يجعل هذه المزوّدات خاصة بالبروفايل المستورد، ولا يسلّم الملف لهرمز أبدًا.
7. **الترحيل.** كل صف قديم يصبح مزوّدًا خاصًا لبروفايله في مكانه، بلا دمج. أُلغي ترحيل الدمج الذي كان
   في النسخة الأولى.

ما قرّرته أنا في التنفيذ (مقترح، ينتظر تأكيد المالك):
- **المزوّد المشترك يُخزَّن تحت البروفايل الافتراضي** (`providers.shared = 1`)، ومفتاحه باسم
  `shared-provider:<family>` حتى لا يصطدم بمفتاح خاص للبروفايل الافتراضي من العائلة نفسها.
- **هرمز يحمّل `.env` الجذري في بيئة العملية عند الإقلاع** (`hermes_cli/env_loader.py`
  §load_hermes_dotenv، مع `override=True`). لذلك لا يكتب المركز في `.env` البروفايل المسمّى إلا المتغيّر
  الذي تختلف قيمته عن قيمة الجذر، وهي ثلاث حالات:
  - مفتاح البروفايل الخاص.
  - المفتاح المشترك، إذا كان للبروفايل الافتراضي مفتاح خاص في مكانه.
  - قيمة فارغة تمنع البروفايل من مفتاح الافتراضي الخاص الذي لا يحقّ له.

  أثبت اختبار هرمز الحقيقي أن بروفايل المالية لا يستعمل مفتاح الافتراضي الخاص.
- **النموذج الموروث يُطابَق على المزوّد الذي يستعمله البروفايل.** يؤخذ النموذج نفسه عند المزوّد ذي
  الـ slug نفسه، فإن لم يوجد عند البروفايل لم يُورَّث. وكذلك معرّف مزوّد مشترك محفوظ في جلسة أو
  تثبيت يعمل على مزوّد البروفايل الخاص من الـ slug نفسه متى وُجد.
- **النسخ لا ينسخ اختيارات النموذج.** يأخذ البروفايل المنسوخ المزوّدات ونماذجها فقط، ويرث النموذج
  الافتراضي. لم يُطلب نسخ الاختيارات، ويمكن إضافته لاحقًا.
- **الفِرَق (ensembles) وسجلات الاستخدام لم تتغيّر.**

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- **الأنواع:**
  - `ProviderScope` (`all` | `profile`) جديد.
  - `ProviderCreate.scope` اختياري، وقيمته الافتراضية `all`.
  - `Provider.scope` مطلوب.
  - `ModelDefaults.inherited` اختياري.
  - `ProfileExport {providers}` جسم اختياري لـ`auth.exportProfile`.
- **الأوصاف:** `models.listProviders` و`createProvider` و`getDefaults` و`auth.exportProfile` و
  `importProfile`، مع `result.providers` في نتيجتي التصدير والاستيراد.
- **القرار:** `docs/contracts/DECISIONS.md` §37.

## الملفات والتأثير
- **الخادم `models`:**
  - `schema.ts`: عمود `shared`، وفهرس فريد جديد (`workspace`, `shared`, `slug`).
  - `store.ts`: قراءات حسب النطاق.
  - `service.ts`: النطاقان والحلّ، و`effectiveDefault`، و`prepareProfile`. وأيضًا نسخ المزوّدات الخاصة
    وتصديرها واستيرادها.
  - `catalogue.ts`: `secretNameOf(family, shared)`.
  - `serialize.ts`: `scope`.
  - `propagation.ts`: `ownedEnv`.
  - `index.ts`: `hubScope` و`profileWorkspace` و`prepareRuntimeProfile`، ومطابقة مرة واحدة عند الإقلاع.
- **الخادم `auth`:**
  - `profiles.ts`: `onProfileCreated`.
  - `routes.ts`: جسم التصدير، وإطلاق `onProfileCreated` بعد إنشاء البروفايل.
  - `profile-transfer.ts`: الملف `majlis-providers.json`، يُلحق عند التصدير ويُلتقط عند الاستيراد.
  - `profile-archive.ts`: قاعدتا `capture` و`append` في فلتر tar.
- **الخادم `agents`:** `ports.ts` و`index.ts`: تجهيز البروفايل قبل كل دور.
- **الخادم، الربط:** `modules/index.ts` يربط النسخ والتجهيز والاستيراد.
- **الترحيل:** `drizzle/0012_provider_scope.sql` مع لقطته (رقم 0011 أخذه #92).
- **الويب:**
  - `AddProviderDialog.tsx`: سؤال «لمن هذا المزوّد؟».
  - `ModelsScreen.tsx`: شارة النطاق، وعلامة «من البروفايل الافتراضي».
  - `queries.ts`: الإبطال في كل البروفايلات.
  - `people/ProfileTransfer.tsx` و`people/queries.ts`: «مع المزوّدين / بدون المزوّدين» والتحذير.
  - `i18n/ar.json` و`en.json`.
- **الاختبارات:**
  - `models/providers-shared.test.ts`: 12 اختبارًا، منها 5 للنطاقين.
  - `tests/unit/profile-transfer-providers.test.ts`: 3.
  - `tests/unit/provider-scope-migration.test.ts`: 1.
  - `agents/adapters/provider-scopes.real.test.ts`: هرمز الحقيقي، 3.
  - الويب: `models-screen.test.tsx` (+4) و`profile-transfer.test.tsx` (+2).
  - رحلة Playwright `e2e/zzzzz-providers-scopes.spec.ts`.
  - لقطات: `providers-scopes-studio-ar-light.png` و`profile-export-providers-ar-light.png` و
    `design-models-*`.
- **الوثائق:** `docs/domain/models.md` و`docs/STATUS.md` (صف models).

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبارات الجديدة على كود `main`، أي ملفات `src` من `origin/main` مع ملفات الاختبار الجديدة. نجح اختبار
واحد على `main` أصلًا لأنه حارس: «does not show a profile's own provider to another profile».

```
$ npx vitest run --project unit src/modules/models/providers-shared.test.ts tests/unit/profile-transfer-providers.test.ts tests/unit/provider-scope-migration.test.ts
     × carries no key and no providers file without being asked
     × with providers carries the profile's own and the shared ones it uses, keys and all
     × an import makes the providers the archive carried the new profile's own
     × keeps every existing provider as its own profile's, key included
     × lists a provider added in one profile, with its key and models, in every other
     × lets a profile made after the provider run a turn on it, with no setup in that profile
     × uses a profile's own key in that profile, and the shared key in every other
     × runs a turn on a profile's own provider when the turn names the shared one
     × does not let another profile fall back on the default profile's own key
     × gives a profile made as a copy its source's own providers, keys included
     … (14 failed | 1 passed)
$ npx vitest run tests/models-screen.test.tsx tests/profile-transfer.test.tsx   (packages/web/src من main)
     × asks with or without providers, sends none by default, and warns before sending keys
     × sends providers: false when the person keeps the default
     × says what shared and a profile's own mean, in both languages
     × marks a default this profile inherited from the default profile, and only that one
     × badges each provider shared or the profile's own
     × asks who a new provider is for, and offers a shared preset again as this profile's own
      Tests  6 failed | 25 passed (31)
```

**اختبار هرمز الحقيقي.** شرط التشغيل: `docker ps` لا يُظهر حاوية لوكيل البوابة (الموجود
`sanad-hermes` و`hermes-webui` و`dockhand` للمالك). الصورة المستعملة `majlis:local` (هرمز v2026.9.14).
- **الإعداد:** مزوّدات تُضاف عبر واجهة المركز: LM Studio مشترك، ثم LM Studio خاص بـDesign، ثم LiteLLM
  خاص بالافتراضي. تعمل عملية TUI واحدة ببيئة المركز، والنموذج المحلي يردّ بالمفتاح الذي وصله.
- **النتائج:**
  - Design يستعمل مفتاحه.
  - Finance والافتراضي يستعملان المشترك.
  - Finance لا يصل إلى مفتاح الافتراضي الخاص.
  - بروفايل من الصفر أُنشئ بعد ذلك يعمل بالمشترك بعد تجهيزه.
- **المحاولة الأولى** توقّفت في الإعداد قبل أي دور: `PermissionError` على `/hh/.env`، لأن المستخدم
  داخل الحاوية غير المستخدم على الجهاز. أضفت فتح صلاحيات الملفات قبل كل أمر هرمز في الاختبار نفسه،
  ثم نجحت المحاولة الثانية.

```
$ MAJLIS_HERMES_IMAGE=majlis:local npx vitest run --maxWorkers=1 provider-scopes.real
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  23.94s
```

**بقية الفحوص.** كل أمر ثقيل عبر `mj-run` (عاملان لـ vitest، وحد 7 GB)، بعد دمج `origin/main` (398cf02،
أي #88 و#89 و#91 و#92):
- في `DECISIONS.md` و`STATUS.md` أُخذت نسخة `main`، ثم أُضيف §37 وصف models.
- ترحيلي أُعيد توليده برقم `0012`.

```
$ pnpm lint                      -> All matched files use Prettier code style!
$ pnpm typecheck                 -> exit 0
$ pnpm contracts:lint            -> contracts:lint  OK
$ pnpm contracts:check-clients   -> check-clients  OK — 255 client file(s) scanned, 167 contract path(s) known.
$ pnpm contract:test             -> Tests  259 passed (259)
$ pnpm i18n:check                -> i18n:check  OK
$ pnpm nav:check                 -> nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/server test
 Test Files  92 passed | 13 skipped (105)
      Tests  957 passed | 38 skipped (995)
$ pnpm --filter @majlis/web test
 Test Files  47 passed (47)
      Tests  567 passed (567)
$ pnpm build                     -> exit 0 (✓ built)
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  42 passed (2.7m)
  ✓ 42 e2e/zzzzz-providers-scopes.spec.ts › providers for every profile, and a profile’s own › …
```
اللقطات التي تغيّرت دون علاقة بهذه المهمة أُعيدت كما كانت.

## المخاطر والرجوع
- **بعد الترحيل كل مزوّد قديم خاص ببروفايله.** المزوّد الذي أُضيف في البروفايل الافتراضي وحده لا يراه
  بروفايل آخر، والمطلوب إضافته مرة واحدة «لكل البروفايلات». هذا مقصود بقرار المالك (بياناته تجريبية).
- **`.env` البروفايلات المسمّاة يكتبه المركز للمتغيّرات التي يملكها** (أسماء مفاتيح مزوّدي المركز).
  - مفتاح وضعه أحد يدويًا تحت أحد هذه الأسماء يُستبدل بما يقرّره المركز.
  - القيمة الفارغة تمنع البروفايل من مفتاح الجذر، فالدور بلا مزوّد يفشل بكلمات هرمز («لا مفتاح») ولا
    يستعمل مفتاح غيره.
- **ملف التصدير «مع المزوّدين» فيه مفاتيح مكشوفة.** الحوار يحذّر، والافتراضي «بدون».
- **الرجوع:**
  - التراجع عن الـ PR يترك عمود `shared` في القاعدة ولا يستعمله أحد.
  - المزوّدات المشتركة تبدو عندها مزوّدات البروفايل الافتراضي وحده.

## التسليم والخطوة التالية
- **PR:** https://github.com/twuijri/core-hub/pull/90 إلى `main` للمراجعة.
- **ينتظر تأكيد المالك** على ما في «ما قرّرته أنا» أعلاه.
- **التنسيق مع وكيل بوابة القنوات:** الكاتب الوحيد لتعريفات المزوّدين `writeHermesProviders`، وتستدعيه
  `ModelsService.prepareProfile` لكل بروفايل. البوابة تحتاج `majlis-custom-…` في إعداد البروفايل الذي
  تعمل فيه، فالأفضل أن تستدعي `prepareProfile` قبل تشغيلها في البروفايل بدل نسخ المنطق.
