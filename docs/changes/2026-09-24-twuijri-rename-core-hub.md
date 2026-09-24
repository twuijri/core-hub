# المنتج اسمه Core Hub («كور هب»): الاسم والمعرّفات والوثائق، والأسماء القديمة تبقى تعمل
المسؤول: twuijri · الفرع: chore/rename-core-hub · الحالة: review

## المشكلة والهدف
قال المالك (٢٠٢٦-٠٩-٢٤): «وريبو المجلس نخليه هو كور هب ونغير كل شي الى كور هب داخليا وحتى الريد
مي»، ثم: «المجلس خلاص يختفي اسم المجلس ونخلي الامج اسمها core-hub».

المستودع صار `twuijri/core-hub`، والصورة تُنشر باسم `ghcr.io/twuijri/core-hub` لأن `release.yml` يسمّيها
باسم المستودع. لكن الكود والواجهة والوثائق كانت كلها تقول Majlis / «مجلس»: ٤٠٢ ملفًا و١١٢٠ سطرًا.
والهدف أن يختفي الاسم القديم، وأن تبقى الترقية بتبديل الصورة وحدها تعمل على `/data` موجود: مكدّس التست
عند المالك فيه إعدادات هرمز وجلسات متصفح وأرشيفات كُتبت بالأسماء القديمة.

## القرار والموافقات
قرار المالك أعلاه، ومكتوب في **ADR 0017** (يحلّ محلّ قرار الاسم في
`docs/changes/2026-09-23-twuijri-product-name.md`). الاسم: **Core Hub** بالإنجليزية و**«كور هب»**
بالعربية، وهو الاسم نفسه الذي استعمله تطبيق المالك الأقدم. **الاسم وحده مشترك**: لم يُفتح ذلك الكود ولم
يُنسخ منه شيء (ADR 0004).

ما تغيّر:
- **ما يقرؤه الناس**: `app.name` بالعربية والإنجليزية، عنوان الصفحة، شاشتا الدخول والتهيئة (العلامة
  `CoreHubMark`، وهي رسم المالك نفسه من #85 باسم جديد)، الشريط العلوي، نصوص الطرفية ومساعدتها، ما يعرّف
  به المركز نفسه في الإشعارات والبطاقات (`PRODUCT.name`)، و`meta.get`. وحيث كانت «المجلس» تعني «المركز»
  عمومًا في النصوص العربية صارت «المركز»، كما تقول الإنجليزية "the hub".
- **الشريط العلوي** يعرض اسم المنتج بلغة الشاشة: المركز يجيب اسمه بالإنجليزية، فالشاشة العربية تقول
  «كور هب»، والاسم الذي يضعه المالك بنفسه يظهر كما كتبه. (**مقترح — للمالك أن يؤكّد**.)
- **المعرّفات**: الحزم `@corehub/*`، الأمر `corehub`، المتغيّرات `COREHUB_*`، مفاتيح المتصفح
  `corehub.*`، مجلّد الطرفية `~/.config/corehub`، مجلّد ملفات التشغيل `.corehub/`، ترويسة الويبهوك
  `X-CoreHub-Signature`، نوع رمز الاقتران `corehub.pairing`، كتل مزوّدي هرمز `corehub-<slug>`،
  ومتغيّرات المفاتيح `COREHUB_PROVIDER_<SLUG>_API_KEY`، ومصدر جلسات هرمز `corehub`. الحاوية في Compose
  `core-hub` والصورة `ghcr.io/twuijri/core-hub:latest`، والحجم `hub-data` كما هو (لم يحمل الاسم قط).
  رموز التصميم صارت بالبادئة `ch` (`--ch-*`) بدل `mj` (**مقترح — للمالك أن يؤكّد**: `mj` اختصار مجلس).
  حزمة Swift المولّدة `CoreHubClient`، وKotlin `corehub-client` (الحزمة `hub.core.client` كما هي).
- **كل اسم قديم ما زال يُقرأ** (`LEGACY` في `packages/contracts/src/product.ts`)، ولا يُكتب:
  - متغيّرات `MAJLIS_*` تُقرأ إن لم يُضبط الاسم الجديد، والسجلّ يقول مرّة أي اسم يُغيَّر؛
  - الطرفية: الأمر `majlis` اسم بديل، و`~/.config/majlis/config.json` يُنقل عند أول قراءة، ورمز
    `majlis.pairing` مقبول؛
  - الويب ينقل مفاتيح `majlis.*` إلى `corehub.*` مرّة قبل أن يقرأ شيئًا: لا خروج ولا ضياع تفضيل؛
  - الرموز الموقّعة بالمُصدِر `majlis` مقبولة (الجديدة `corehub`): لا يخرج أحد؛
  - إعدادات هرمز: كتل `majlis-*` ما زالت للمركز، فكل كتابة تستبدلها بـ`corehub-*` **وتعيد كتابة كل قيمة
    تسمّيها** (`model.provider`، `fallback_model.provider`، …)، فبروفايل نموذجه
    `majlis-custom-cli-proxy-api` يبقى يجيب. و`.env` يفقد `MAJLIS_PROVIDER_*` وسطر العلامة القديم في
    الكتابة نفسها. يحدث هذا عند الإقلاع (`reconcile`) وعند كل حفظ؛
  - أرشيف بروفايل فيه `majlis-providers.json` (بصيغة `majlis-providers`) يُستورد.
- **ما لا يتغيّر عمدًا**: `STABLE.idNamespace = 'majlis'` بذرة المعرّفات المشتقّة (تغييرها يغيّر معرّف كل
  بروفايل بصمت). مراجع جلسات هرمز المخزّنة (`majlis-<id>`) تبقى كما يعرفها هرمز، والجديدة `corehub-<id>`.
  مجلّد `.majlis/` لتشغيل قديم يبقى مكانه، والتشغيلات الجديدة تكتب `.corehub/`.
- **ترويسة الويبهوك** غُيّرت بلا فترة إرسال للاسمين، بتوجيه المالك: الويبهوك لا يرسل إلا اختبارًا بعد.
  وكان وصف المخطط في العقد يقول `X-Hub-Signature` والمركز يرسل `X-Majlis-Signature`؛ الوصف الآن يسمّي
  ما يُرسل فعلًا.
- **وُجد أثناء العمل**: `MAJLIS_VERSION` الذي تختمه الصورة لم يكن يُقرأ أصلًا (لم يكن في `ENV_KEYS`)،
  فكان `/api/v1/meta` — بقراءة الكود، لا بتجربة صورة إصدار — يجيب نسخة `package.json` (`0.0.0`). الآن `COREHUB_VERSION` في `ENV_KEYS`، مع `MAJLIS_VERSION`
  بديلًا. وأُضيفت لصاقات OCI إلى الصورة (العنوان والمصدر والإصدار).
- **الوثائق**: `AGENTS.md` و`CONTRIBUTING.md` و`docs/*.md` ووثائق الـharness و`docs/clients/*` صارت
  Core Hub، مع قسم ترقية في `docs/DEPLOY.md` (§1a) وسطر في `docs/STATUS.md`. **`README.md` لم يُمسّ هنا**:
  كتبه المالك في طلب مستقل (#96) ودُمج في `main`، وهذا الفرع دمجه كما هو. سجلات `docs/changes/` وقرارات
  ADR السابقة تاريخ، فلم تُعدَّل.
- **في commit مستقل**: موافقة المالك على القرارات ١–٣ («صح»، ٢٠٢٦-٠٩-٢٤) سُجّلت في
  `docs/changes/2026-09-24-twuijri-agent-jobs-plugins.md`. سجلّ `schedule-run-options` (#95، مدموج) لا
  موافقة جديدة له بعد، فلم يُمسّ.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `openapi.yaml`: `info` (العنوان والوصف ورابط التواصل `github.com/twuijri/core-hub`)، أمثلة الأسماء،
  ووصف ترويسة توقيع الويبهوك (`X-CoreHub-Signature`، القرار §41). لا مسار ولا حقل ولا حالة أُضيفت أو حُذفت.
- `events/*.schema.json`: الـ`$id` تحت `https://github.com/twuijri/core-hub/blob/main/packages/contracts/events/`
  وعنوان المشترك «Core Hub realtime».
- `src/product.ts`: `PRODUCT` (`corehub`، `Core Hub`، `كور هب`)، `derived` الموسّع، `LEGACY` الجديد،
  `STABLE` = `idNamespace` وحده، و`readProductEnv`. مصدّرة من `@corehub/contracts`.
- `openapi-generator/{kotlin,swift}.yaml`: `corehub-client` و`CoreHubClient`.
- `docs/contracts/DECISIONS.md` §41.

## الملفات والتأثير
- إعادة التسمية الآلية (٣٣٣ ملفًا في أول commit): كل الحزم و`package.json` و`pnpm-lock.yaml` (أسماء
  الحزم فقط) وCI (`--filter @corehub/...` ووسم `core-hub:ci`) و`release.yml` (`COREHUB_VERSION`) و
  `Dockerfile` و`docker-compose.yml` والوثائق. `MajlisMark.tsx` → `CoreHubMark.tsx`.
- التوافق: `packages/server/src/app/{config,server}.ts` · `modules/auth/{tokens,profile-transfer}.ts` ·
  `modules/models/{catalogue,propagation,dotenv,service,index}.ts` · `modules/agents/{runner.ts,adapters/hermes-tui.ts,adapters/acp.ts}` ·
  `packages/cli/src/{legacy.ts (جديد),config.ts,context.ts,main.ts,commands/pair.ts}` و`package.json`
  (`bin.majlis`) · `packages/web/src/storage/legacy.ts` (جديد) و`main.tsx` و`shell/TopBar.tsx`.
- رموز التصميم: `mj` → `ch` في ٥١ ملفًا (commit مستقل).
- اختبارات جديدة: `server/tests/unit/product.test.ts` (مُعاد) و`config.test.ts` و
  `profile-transfer-providers.test.ts` و`src/modules/models/{propagation,models-api}.test.ts` و
  `cli/tests/legacy.test.ts` و`web/tests/{storage-legacy,topbar-name}.test.tsx` و
  `contracts/tests/product.test.ts` (مُعاد). لقطات e2e (١٠٢) تُظهر الاسم الجديد.
- الوثائق: `docs/adr/0017-product-named-core-hub.md` (جديد)، `docs/DEPLOY.md`، `docs/STATUS.md`،
  `AGENTS.md`، `docs/harness/README.md` (المستودع صار عامًا).
- **ما بقي من `majlis` في `git grep -i majlis`** (عدا `graphify-out/` و٦٠ سجلًا في `docs/changes/`)،
  وسبب كلٍّ:
  - تاريخ: ADR 0004 و0007 و0008 و0009 و0011 و0012 (الاثنان) و0013؛ و`docs/inspirations/hermes-studio.md`
    (يصف اسمًا داخليًا لمنتج آخر، نسخة المالك من Hermes Studio).
  - يشرح الاسم القديم: ADR 0017، `AGENTS.md`، `docs/DEPLOY.md` §1a، `docs/STATUS.md`، DECISIONS §41.
  - الأسماء القديمة المقبولة (`LEGACY`) والبذرة المجمّدة: `packages/contracts/src/product.ts`.
  - الكود الذي يقرؤها ويشرحها: `server/src/app/config.ts`، `auth/{tokens,profile-transfer}.ts`،
    `models/{catalogue,propagation,dotenv,service}.ts`، `agents/runner.ts` (تعليق)، `cli/src/{legacy,config,context}.ts`
    و`commands/pair.ts` و`package.json` (الاسم البديل) ونصّا التنبيه في `i18n/{ar,en}.json`،
    `web/src/storage/legacy.ts`.
  - اختبارات الهجرة: `contracts/tests/product.test.ts`، `server/tests/unit/{config,product,profile-transfer-providers}.test.ts`،
    `models/{propagation,models-api}.test.ts`، `cli/tests/legacy.test.ts`، `web/tests/storage-legacy.test.ts`.

## الفحوص (الأوامر ونواتجها الفعلية)
بعد دمج `origin/main` (#96)، كلها عبر `mj-run`:
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck                      → exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 265 client file(s) scanned, 172 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contract:test
      Tests  268 passed (268)
$ pnpm --filter @corehub/server test
 Test Files  98 passed | 14 skipped (112)
      Tests  1031 passed | 41 skipped (1072)
$ pnpm --filter @corehub/web test
 Test Files  52 passed (52)
      Tests  588 passed (588)
$ pnpm --filter @corehub/cli test
 Test Files  12 passed (12)
      Tests  73 passed (73)
$ pnpm --filter @corehub/contracts test
 Test Files  4 passed (4)
      Tests  19 passed (19)
$ pnpm --filter @corehub/ui-tokens test
      Tests  127 passed (127)
$ pnpm build                          → exit 0
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  44 passed (2.8m)
$ docker build -f packages/server/Dockerfile --build-arg COREHUB_VERSION=0.0.0-rename-check -t core-hub:rename-check .
Successfully tagged core-hub:rename-check
$ node scripts/image-sealed-check.mjs core-hub:rename-check
ok    the hub answers /api/v1/health
ok    hermes runs — Hermes Agent v0.21.3 (2026.9.14)
ok    the container changed nothing under /app or /opt/hermes
image:sealed-check  OK
$ docker run … -e COREHUB_VERSION= -e MAJLIS_VERSION=9.9.9-legacy core-hub:rename-check
{"ok":true,"server_version":"9.9.9-legacy","uptime_seconds":3}
{"name":"Core Hub","server_version":"9.9.9-legacy",…}
{"level":40,…,"service":"corehub","variables":["MAJLIS_VERSION"],"rename":["COREHUB_VERSION"],"msg":"config: read under the old Majlis name; rename these variables (ADR 0017)"}
```
- `pnpm test` من الجذر مرّة واحدة: قُتل خادم الاختبارات (`Killed`) في منتصفه؛ أُعيد كل حزمة وحدها
  (النواتج أعلاه). `pnpm contracts:generate` للعملاء الأصليين يحتاج Java، غير موجودة هنا: يشغّله CI.
- لصاقات OCI في `Dockerfile` أُضيفت **بعد** البناء المحلّي؛ بناؤها يثبت في CI.
- **الاختبارات الجديدة تسقط على الكود القديم**: بإيقاف `migrateLegacyProviders` سقط اختباران في
  `propagation.test.ts`، وبإيقاف امتلاك `MAJLIS_PROVIDER_*` سقط اختبار الإقلاع في `models-api.test.ts`
  (`expected '# managed by Core Hub — …' not to contain 'MAJLIS'`).

## المخاطر والرجوع
- **مكدّس التست عند المالك** (للتنفيذ عنده):
  - الصورة: `ghcr.io/twuijri/core-hub:<tag>` بدل `ghcr.io/twuijri/majlis`.
  - اسم الحاوية: `core-hub` في Compose المرجعي؛ تغييره اختياري، والحجم نفسه.
  - المتغيّرات: لا شيء يلزم. أي `MAJLIS_*` يعمل ويُنبَّه عنه في السجلّ.
  - أول إقلاع يعيد كتابة `config.yaml` و`.env` في منزل هرمز وكل بروفايل إلى الأسماء الجديدة، ويعيد تشغيل
    البوّابة مرّة.
- **صورة قديمة على `/data` جديد** (رجوع): الصورة القديمة لا تعرف `corehub-*` فتعاملها ككتل كتبها إنسان،
  وتكتب `majlis-*` بجانبها؛ لا يضيع شيء، لكن تبقى كتل مكرّرة حتى تُحذف باليد. والرموز الموقّعة `corehub`
  ترفضها الصورة القديمة: دخول مرّة. الرجوع إذن ممكن بكلفة دخول واحد وتنظيف `config.yaml`.
- الويبهوك: مستقبل يتحقّق من `X-Majlis-Signature` يتوقّف؛ لا مستقبل حقيقي اليوم.
- ملفّ الطرفية القديم يُنقل ويُحذف من مكانه (كي لا يبقى الرمز في موضعين).
- طلبات دمج مفتوحة أخرى (#97 وأي فرع أقدم) ستحتاج إعادة تسمية `@majlis/*` و`mj-` عند دمج `main`.
- الرجوع: استرجاع commits الفرع.

## التسليم والخطوة التالية
طلب دمج إلى `main` على `twuijri/core-hub`. التالي: بعد الدمج، صورة تست بالاسم الجديد عند طلب المالك،
وتجربة الترقية على مكدّس التست بتبديل الصورة وحدها.
