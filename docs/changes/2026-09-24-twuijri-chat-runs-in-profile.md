# المحادثة تعمل في بروفايل هرمز الخاص بها (المرحلة 3 من ADR 0014)
المسؤول: twuijri · الفرع: feat/chat-runs-in-profile · الحالة: review

## المشكلة والهدف
البروفايل في المجلس هو بروفايل هرمز (ADR 0014): إعداداته ونموذجه ومفاتيحه وذاكرته ومهاراته و`SOUL.md`.
لكن كل محادثة — في أي بروفايل — كانت تعمل في بروفايل هرمز الافتراضي، فذاكرة البروفايل «ب» وشخصيته
ومهاراته لا يراها وكيل «ب». وكان مجلد عمل الجلسة (`/data/workspaces/<profile>/…`) لا يصل إلى هرمز
أصلًا: أدوات هرمز تعمل في منزل هرمز الجذري.

الهدف: كل تشغيل لهرمز (دور محادثة، استئناف، تفرّع، تشغيل مهمة، خطوة سير عمل، سؤال العنوان، والأسئلة
والموافقات داخلها) يعمل في بروفايل جلسته، وفي مجلد جلسته.

## القرار والموافقات
ما قرأته في مصدر هرمز (MIT، من الصورة `/opt/hermes`، إصدار v2026.9.14) ووصفته بكلماتنا:
- **عملية واحدة تخدم كل البروفايلات.** `session.create` و`session.resume` في بوابة TUI يأخذان
  `profile`؛ هرمز يحفظ منزل البروفايل في سجل الجلسة ويربطه عند بناء الوكيل ومع كل دور
  (`_session_profile_runtime_scope`): `config.yaml` للبروفايل، و`.env` الخاص به فوق بيئة العملية،
  وسياسة الطرفية، و`SOUL.md` و`memories/` والمهارات، و`state.db` الخاص به. غياب `profile` يعني
  منزل العملية نفسه (`default`). بروفايل غير موجود يُرفض بخطأ 4064.
- **المفاتيح تصل كل بروفايل بلا نسخ.** بوابة TUI ليست «مُعدِّد بروفايلات» (`multiplex` معطّل فيها)،
  فقراءة السر تبحث في `.env` البروفايل ثم في بيئة العملية — والمجلس يضع مفاتيح المزوّدين في بيئة
  العملية أصلًا (ADR 0010). لا إدخال مفتاح لكل بروفايل.
- **الاستئناف في بروفايل يتبنّى المحادثات القديمة.** محادثة خزّنها مجلس أقدم في مخزن `default` لجلسة
  من البروفايل «ب» تُنقل إلى مخزن «ب» عند أول استئناف (`_resume_adopt_stranded` في هرمز نفسه).
- **النسخ من بروفايل آخر ينسخ الذاكرة في هذا الإصدار**: `--clone-from` ينسخ `config.yaml` و`.env`
  و`SOUL.md` والمهارات و`memories/MEMORY.md` و`USER.md` (ADR 0014 قال غير ذلك؛ أضفت ملاحظة إليه).

القرارات:
1. **عملية TUI واحدة لكل البروفايلات، لا عملية لكل بروفايل.** قست ذلك على هرمز الحقيقي (الصورة
   `majlis:local`): الحاوية **217 MiB** بعد دور في بروفايل واحد، و**224 MiB** بعد أدوار في ثلاثة
   بروفايلات. عملية لكل بروفايل كانت ستكلّف ~220 MiB لكل واحد، فلا حاجة لمشرف لكل بروفايل ولا
   لقاعدة خمول. الموجود (إعادة التشغيل عند تغيّر المفاتيح وإغلاق القديمة عند الفراغ) يبقى كما هو.
2. **اسم البروفايل = slug البروفايل في المجلس، و`default` للبروفايل الافتراضي في المجلس** (قاعدة ADR 0014 نفسها)، يُحسب في
   `agents` من `auth.findWorkspace` ويُمرَّر في `AgentTarget.profile`. لا يُرسل `profile` لـ`default`،
   فالسلك للبروفايل الافتراضي في المجلس هو نفسه كما كان.
3. **مجلد الجلسة يُمرَّر لهرمز** (`cwd` في `session.create`)، وعند الاستئناف إن قال هرمز إن الجلسة في
   مجلد آخر يُطلب `session.cwd.set` (بلا فشل للدور إن رفض). المجلد يبقى `/data/workspaces/<profile>/…`.
4. **بروفايل مفقود يُنشأ عند أول تشغيل، نسخةً من `default`** — مقترح، ينتظر تأكيد المالك. بروفايلات
   أُنشئت في المجلس قبل ADR 0014 ليس لها بروفايل هرمز، وبدون هذا كانت محادثاتها ستتوقف. النسخ من `default`
   (وهو البروفايل الذي كانت تعمل فيه حتى الآن) يُبقي نموذجها ومزوّديها وشخصيتها وذاكرتها كما كانت ثم
   تفترق. `hermes profile create <slug> --no-alias --clone-from default`، مرة واحدة حتى لو طلبه دوران
   معًا؛ الفشل يرفض الدور بـ`agent_unavailable` و`reason: hermes_profile_unavailable` مع جملة هرمز.
5. **نقاط المزوّدين (`providers:`) تُكتب في `config.yaml` كل بروفايل** مع كل حفظ للمزوّدين، بالقاعدة
   نفسها (مفاتيح المجلس `majlis-*` فقط، والباقي في الملف كما هو). دور في «ب» يسمّي `majlis-groq` يجده
   في إعداد «ب». المفاتيح لا تُنسخ، ونموذج البروفايل الافتراضي يبقى له (المجلس يسمّي النموذج في كل دور).
   لا إعادة تشغيل لذلك: الجلسة تقرأ إعداد بروفايلها عند فتحها.
6. **الوكيل `direct`** (وكيل المجلس نفسه): لا تغيير. إعداداته ونموذجه ومزوّده تُحل أصلًا لكل بروفايل
   (`agent_settings` و`model_default` مقيّدان بالبروفايل، `docs/domain/models.md`)، و`target.workspace`
   هو ما يمرّره لمنفذ `models` في كل دور.
7. **صفحات أدوات هرمز** (المهارات، MCP، الذاكرة، القنوات) صارت تعمل على منزل البروفايل المختار في
   PR #80 (دُمج في `main` أثناء هذه المهمة)، فاكتملت المرحلة 3 بهذا الـ PR. `profileOf` هنا يستعمل
   `hermesProfileName` من `profile-home.ts` (من #80) لتبقى القاعدة واحدة. **خارج النطاق**: هرمز
   المُتاح عبر الشبكة فقط (بلا `hermes` بجانب المجلس، أي بلا بوابة TUI) يبقى على `/v1/runs` في
   بروفايله الافتراضي.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. لا مسار ولا حدث جديد؛ رفض إنشاء البروفايل يستعمل `agent_unavailable` الموجود.

## الملفات والتأثير
- `packages/server/src/modules/agents/adapters/hermes-tui.ts`: `open()` يأخذ `profile` و`cwd`؛
  `profile` على `session.create` و`session.resume` (لا يُرسل لـ`default`)، `cwd` على الإنشاء، و
  `session.cwd.set` بعد استئناف في مجلد آخر.
- `packages/server/src/modules/agents/adapters/hermes.ts`: `ensureProfile` قبل فتح الجلسة، وتمرير
  `profile` و`cwd`.
- `packages/server/src/modules/agents/adapters/types.ts`: `AgentTarget.profile`.
- `packages/server/src/modules/agents/service.ts`: `profileOf` في الخيارات، و`targetFor` يضع `profile`.
- `packages/server/src/modules/agents/hermes-runtime.ts`: `ensureProfile(name)`، وتوثيق «عملية واحدة
  لكل البروفايلات» مع القياس.
- `packages/server/src/modules/agents/hermes-profiles.ts`: `namedHermesProfiles(home)` (القراءة نفسها،
  متزامنة، يستعملها `list()`).
- `packages/server/src/modules/agents/index.ts`: ربط `profileOf` و`ensureProfile`، وتصدير
  `namedHermesProfiles`.
- `packages/server/src/modules/models/service.ts`، `models/index.ts`: `HermesTarget.profileHomes`
  و`propagateToProfiles`.
- اختبارات: `hermes-tui.test.ts` (+3)، `hermes.test.ts` (+2)، `hermes-runtime.test.ts` (+4)،
  `agents.test.ts` (+1)، `models-api.test.ts` (+1)، و`adapters/hermes-profile.real.test.ts` (جديد،
  هرمز الحقيقي، 3).
- `docs/STATUS.md` (صف auth)، `docs/adr/0014-workspaces-are-hermes-profiles.md` (ملاحظة تقدّم في قسم
  المراحل، القرار كما هو).

## الفحوص (الأوامر ونواتجها الفعلية)
اختبار هرمز الحقيقي: صورة مبنية محليًا، عملية TUI واحدة، البروفايل `b` أنشأه هرمز، ولكل من `default`
و`b` حقيقة مميزة في `SOUL.md` و`memories/MEMORY.md`؛ نموذج OpenAI-compatible مبرمج على الجهاز يردّ
بالحقائق التي وصلته. المفتاح في بيئة العملية فقط. محادثة في `b` ترى حقائق `b` فقط، ومحادثة في `default`
حقائق `default` فقط، واستئناف `b` بمعرّفه المخزّن يبقى في `b`، و`state.db` لـ`b` في منزل `b`، وبروفايل
منسوخ من `default` (طريقة إنشاء البروفايل المفقود) يجيب.

القياس (الحاوية كلها، `docker stats` بعد كل دور): 217.1 MiB بعد دور في `b`، 220.2 بعد استئنافه،
220.4 بعد دور في `default`، 224.5 MiB بعد دور في بروفايل ثالث منسوخ.

الاختبارات الجديدة تفشل على كود `main` (نسخة مؤقتة من `main` مع ملفات الاختبار الجديدة فقط): 11
اختبار سلوك فشلت كلها، منها «opens a conversation in the workspace's own profile and working folder»،
«makes a missing profile once, as a copy of default…»، «names the workspace's Hermes profile on every run
target…»، «declares the endpoint in every Hermes profile's config too…».

كل أمر ثقيل عبر `mj-run` (عاملان لـ vitest، حد 7 GB)، بعد دمج `origin/main` (b21d31e):

```
$ pnpm lint                       -> exit 0  (All matched files use Prettier code style!)
$ pnpm typecheck                  -> exit 0
$ pnpm contracts:lint             -> contracts:lint  OK
$ pnpm contracts:check-clients    -> check-clients  OK — 231 client file(s) scanned, 167 contract path(s) known.
$ pnpm contract:test              -> Test Files  2 passed (2)   Tests  255 passed (255)
$ pnpm i18n:check                 -> i18n:check  OK
$ pnpm nav:check                  -> nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/server test
 Test Files  78 passed | 9 skipped (87)
      Tests  841 passed | 26 skipped (867)
$ pnpm --filter @majlis/web test
 Test Files  39 passed (39)
      Tests  502 passed (502)
$ pnpm build                      -> exit 0 (✓ built)
$ docker build -f packages/server/Dockerfile -t majlis:local .
Successfully tagged majlis:local
$ MAJLIS_HERMES_IMAGE=majlis:local npx vitest run --maxWorkers=1 hermes-profile.real hermes-tui.real hermes-profiles.real
 ✓ hermes-profiles.real > creates from scratch and as a copy, refuses an existing name, and lists both
 ✓ hermes-profile.real > a conversation in profile b reads b's soul and memory, and nobody else's
 ✓ hermes-profile.real > the same process serves the default profile with the default's soul and memory
 ✓ hermes-profile.real > a profile made as a copy of the default one — how a missing profile is made — answers
 ✓ hermes-tui.real > asks the question Hermes asks, and gives Hermes the answer chosen
 ✓ hermes-tui.real > asks a batch — the shape Hermes offers the model — and gives Hermes every answer
 ✓ hermes-tui.real > skips a question when the person skips it
 ✓ hermes-tui.real > takes a turn on the model the turn names, on this session only
 ✓ hermes-tui.real > continues the same conversation by its stored id
 Test Files  3 passed (3)
      Tests  9 passed (9)
```
لم يُشغَّل `web:e2e`: لم يتغيّر شيء في `packages/web`.

## المخاطر والرجوع
- **مجلد العمل تغيّر لجلسات هرمز**: كانت أدوات هرمز تعمل في منزل هرمز الجذري، والآن في مجلد الجلسة.
  هذا هو المقصود (ملفات الجلسة والمهام هناك)، لكنه تغيير سلوك مرئي.
- **ذاكرة البروفايل**: محادثات «ب» لم تعد ترى ذاكرة `default` — المقصود. بروفايل أُنشئ «من الصفر»
  ليس له نموذج في إعداده؛ إن لم يكن له مزوّدون في المجلس فلا يسمّي الدور نموذجًا ويرفض هرمز
  بكلماته. (المزوّدون في المجلس ما زالوا لكل بروفايل — `docs/domain/models.md` — وهذا خارج هذه المهمة.)
- **آخر حافظ يفوز** (موجود قبل هذا): حفظ مزوّدي بروفايل يكتب حالتها في منزل هرمز الجذري وبيئة العملية؛
  الآن نقاط المزوّدين تُكتب في كل بروفايل بالقاعدة نفسها.
- الرجوع: التراجع عن الـ PR يعيد كل المحادثات إلى `default`؛ المحادثات التي نقلها هرمز إلى مخزن
  بروفايل تبقى هناك (لا يعيدها هرمز إلى `default` تلقائيًا)، والبروفايلات التي أُنشئت عند الطلب تبقى.

## التسليم والخطوة التالية
- PR: https://github.com/twuijri/majlis/pull/83
- PR إلى `main` للمراجعة؛ القرار 4 (إنشاء البروفايل المفقود نسخةً من `default`) ينتظر تأكيد المالك.
- ملاحظة للمتابعة (مهمة مستقلة): صفحة الذاكرة تكتب `MEMORY.md` و`USER.md` في جذر منزل البروفايل،
  بينما يقرأ هرمز `memories/MEMORY.md` و`memories/USER.md` (`tools/memory_tool.py` §get_memory_dir؛
  أثبته الاختبار الحقيقي هنا: الحقيقة في `memories/MEMORY.md` وصلت النموذج).
