# صفحتا «المهام المجدولة» و«الإضافات» للوكيل، ومهارات هرمز في مجلدات التصنيف
المسؤول: twuijri · الفرع: feat/agent-jobs-plugins · الحالة: review

## المشكلة والهدف
منذ #87 تعيش صفحات الوكيل تحت `/agents` بقائمة جانبية (المهارات · MCP · الذاكرة · المهام المجدولة ·
القنوات · الإضافات · الإعدادات). بقيت صفحتا **المهام المجدولة** و**الإضافات** صفحة مؤقتة، وكانت
`agents.listPlugins` و`agents.updatePlugin` في العقد ترجعان `501`. وهرمز لم يكن يعلن قدرة `plugins`،
فلم يكن سطر «الإضافات» يظهر أصلًا.

وصفحة **المهارات** لم تكن تعرض المهارات المحفوظة في مجلدات تصنيف (`skills/<category>/<name>/SKILL.md`)،
وهو المكان الذي يحفظ فيه هرمز مهاراته المدمجة. فبروفايل أنشأه هرمز ومعه عشرات المهارات كان يظهر فارغًا.

الهدف: الصفحتان تعملان على البروفايل المختار بكلمات هرمز، والمهارات المصنّفة تظهر بتصنيفها، ومهارات
هرمز المدمجة للقراءة فقط.

## القرار والموافقات
**ما قرأته في مصدر هرمز** (MIT، الوسم المثبّت `v2026.9.14`، `Hermes Agent v0.21.3`)، بكلماتنا:
- **الإضافات**: `hermes_cli/plugins_cmd.py` و`hermes_cli/subcommands/plugins.py` و
  `hermes_cli/web_routers/dashboard_ui.py`. الأمر `hermes plugins list --json` يعطي لكل إضافة الاسم
  والحالة (`enabled` أو `disabled` أو `not enabled`) والإصدار والوصف والمصدر (`bundled` أو `user` أو
  `git` أو `entrypoint` أو ملاحظة أصل مثل `catalog:<tier>@<sha>`). إضافات هرمز لا تعمل إلا إذا فُعّلت
  (قائمة سماح وقائمة منع في `config.yaml`، والمنع يغلب)، إلا منصّات المراسلة ومزوّدي النماذج المرفقة معه
  فتعمل حين تُستخدم. `enable` و`disable` و`remove` و`install <identifier>` أوامر في المنزل نفسه.
  `install` يجلب من الكتالوج أو رابط Git أو `owner/repo`، ويفحص، ويرفض ما سحبه الكتالوج.
- **مسارات لوحة هرمز للإضافات** (`/api/dashboard/plugins/hub` و`/api/dashboard/agent-plugins/...`)
  **لا تأخذ بروفايل**، بخلاف مساراتها للـMCP والمهارات والكرون. تقرأ وتكتب منزل اللوحة نفسها، وهو
  منزل البروفايل الافتراضي. لذلك لا تصل إلى بروفايل مسمّى أبدًا.
- **لوحة هرمز (kanban)** صفحة في لوحة هرمز، لا إضافة وكيل: `hermes plugins list` لا يذكرها. الصفحة
  تعرض ما هو موجود فعلًا، ولا تخترع سطرًا لها.
- **أسماء مكرّرة**: هرمز يشحن بعض الإضافات باسم واحد في تصنيفين (مثل `image_gen/xai` و`video_gen/xai`)،
  وقائمته تذكر الاسم مرتين، وأوامره تفهم الاسم على أنه الأول.
- **المهام**: «jobs» في هرمز هي مهام مجدوله (`/api/jobs` في خادم الـAPI، `cron/jobs.json`). وهي
  معروضة أصلًا في صفحة الجدولة. عمليات هرمز في الخلفية (`process_registry`) تعيش داخل محادثة وليس لها
  واجهة.
- **المهارات**: `tools/skills_tool.py` (§_find_all_skills و§_get_category_from_path) و
  `agent/skill_utils.py` (§iter_skill_index_files، §EXCLUDED_SKILL_DIRS) و`tools/skills_sync.py`
  و`hermes_cli/web_routers/skills.py`. المجلد تحت `skills/` بلا `SKILL.md` هو تصنيف، وكل مهارة تحته
  (بأي عمق) تتبعه، ووصفه في `DESCRIPTION.md`. هرمز يسجّل المهارات التي نسخها من حزمته في
  `skills/.bundled_manifest` (`name:hash`)، ويحدّثها منها ما دامت مطابقة. واجهته نفسها لا تسمح بتحرير
  أو حذف إلا المهارات التي ليست مدمجة ولا من المتجر.

القرارات (**مقترحة — للمالك أن يؤكّد**):
1. **«المهام المجدولة» لهرمز = مهام مجدوله في البروفايل المختار.** الصفحة هي قائمة صفحة الجدولة نفسها
   (`schedules.list` مع `profile` و`agent_id`)، مضيّقة على الوكيل، مع «شغّله الآن» والإيقاف والاستئناف
   والحذف بالعمليات نفسها، ورابط «افتح صفحة الجدولة» للإنشاء والتعديل. لا عملية جديدة ولا قائمة ثانية
   قد تخالف الأولى. زر «شغّله الآن» لجدولة ليست في مجدول هرمز معطّل بالقاعدة نفسها التي تتبعها صفحة
   الجدولة.
2. **«الإضافات» = ما يذكره هرمز في البروفايل المختار، بأمره `hermes plugins`** مع `HERMES_HOME` منزل
   ذلك البروفايل (لأن مسارات اللوحة لا تصل إلى البروفايلات المسمّاة). الحالة بكلمات هرمز الثلاث. التشغيل
   `enable --no-allow-tool-override` (لا يمنح الإضافة استبدال أدوات هرمز، ولا يمنح القدرات التي تطلبها؛
   هرمز يسأل عنها في الطرفية فقط، وبدون شخص أمامه يرفض). التثبيت مهمة `plugin_install` تثبّت الإضافة
   **مطفأة** (`--no-enable`)، والتشغيل خطوة ثانية مقصودة. الإزالة لما ثُبّت في البروفايل فقط، وما يشحنه
   هرمز يُطفأ ولا يُزال (`409 plugin_bundled`). الاسم المكرّر يظهر مرة (الذي تنفّذ عليه الأوامر) ومعه
   تنبيه. كل أمر يعمل وstdin مغلق، فأي سؤال يطرحه هرمز جوابه «لا».
3. **أُضيفت `plugins` إلى قدرات هرمز** في الكتالوج، فظهر سطر «الإضافات» في قائمته وشريحته.
4. **المهارات المصنّفة**: تظهر تحت تصنيفها ومعه وصف `DESCRIPTION.md`، والمسطّحة كما كانت. المهارة
   المسجّلة في `.bundled_manifest` مصدرها `builtin` وعليها شارة «مدمجة في هرمز»: تُفتح للقراءة وتُثبَّت،
   ولا مفتاح تشغيل ولا حفظ ولا حذف (والخادم يرفض بـ`409 skill_bundled`). السبب: هرمز يحدّث نسخته ما دامت
   مطابقة لحزمته، وتعديلها من هنا يفرّع نسخته بصمت. المهارة المصنّفة غير المدمجة تُحرَّر وتُطفأ وتُحذف
   في مكانها. المفتاح اسم مجلدها أينما كان، والمسطّحة تغلب المصنّفة عند تطابق الاسم.
5. **حيث لا يشغّل المركز هرمز بنفسه** كل عمليات الإضافات ترد `409 state_invalid` مع
   `hermes_not_supervised`، والصفحة تقول ذلك بجملة واضحة. وكيل ليس هرمز: `plugins_are_hermes_only`.

العقد: DECISIONS §36 (رقم §35 متروك لـ#90 الذي يستعمل §34 المأخوذ في `main`).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `agents.listPlugins` و`agents.updatePlugin`: وصف ما يفعلان الآن، و`409` لـ`listPlugins`.
- جديد: `agents.installPlugin` (`POST /agents/{agent_id}/plugins` → `202 JobAccepted`، والـ`identifier`
  لا يبدأ بـ`-` ولا فيه مسافة) و`agents.deletePlugin` (`DELETE /agents/{agent_id}/plugins/{plugin_key}` → `204`).
- `AgentPlugin`: `status` (`enabled` | `disabled` | `not_enabled`) و`removable`، ووصف للحقول التي لا
  يذكرها هرمز. `JobKind`: `plugin_install`.
- `agents.listSkills` وصف مجلدات التصنيف والمدمجة؛ `putSkill` و`updateSkill` و`deleteSkill` وصف
  `skill_bundled`، و`409` في `putSkill` و`updateSkill`. `SkillSource` وصف القيم الثلاث.
- العدّ: 254 عملية (كانت 252).

## الملفات والتأثير
- الخادم: `packages/server/src/modules/agents/hermes-plugins.ts` (جديد: الأمر، القراءة، التشغيل،
  الإزالة، مهمة التثبيت)، `index.ts` (المسارات الأربعة، `hermesCli` بجانب `hermesApi` ومنفذ للاختبار،
  رفض `skill_bundled`، تصنيفات المهارات بوصفها)، `skills.ts` (المشي في مجلدات التصنيف، `.bundled_manifest`،
  الكتابة في مكان المهارة)، `catalog/hermes.ts` (قدرة `plugins`)، `i18n/{ar,en}.json` (رسائل المهمة
  والتنبيه). `testing/fake-hermes-plugins.ts` جديد للاختبارات وخادم e2e.
- الويب: `agents/AgentJobsScreen.tsx` و`agents/AgentPluginsScreen.tsx` و`agents/plugins.ts` جديدة،
  `navigation/routes.tsx`، `agents/AgentSkillsScreen.tsx` (التصنيف ووصفه، المدمجة للقراءة)،
  `agents/toolErrors.ts`، `styles/screens.css` (`.skill-static`)، `i18n/{ar,en}.json`.
- e2e: `e2e/hub.ts` (أمر الإضافات المزيّف)، `e2e/zzz-agent-jobs-plugins.spec.ts` (الرحلة 28)، ولقطتان
  جديدتان `agent-jobs-ar-light.png` و`agent-plugins-ar-light.png`.
- الوثائق: `docs/STATUS.md` (سطر agents والعدّ)، `docs/contracts/DECISIONS.md` §36،
  `docs/clients/NAVIGATION.md` §4 القاعدة 8.

## الفحوص (الأوامر ونواتجها الفعلية)
كل الأوامر عبر `mj-run`.

الاختبار الحقيقي بصورة `majlis:local` (بُنيت مرة واحدة من هذا الفرع):
```
$ MAJLIS_HERMES_IMAGE=majlis:local pnpm exec vitest run src/modules/agents/hermes-plugins.real.test.ts --silent=false --reporter=verbose
 ✓ … Hermes makes a profile, with its built-in skills in category folders 553ms
category skills: 58 listed, 58 in categories, 58 built-in
 ✓ … lists Hermes's category skills as Hermes does: every one, its category, bundled or not 1134ms
warnings: deepinfra: Hermes lists more than one plugin by this name; … | fal: … | openrouter: … | xai: …
 ✓ … lists Hermes's plugins in Hermes's words, and switches one on in one profile only 5886ms
install output:
Warning: custom (unreviewed) source — not from the Hermes catalog.
Cloning file:///hh/plugin-src...
│ Location: /hh/profiles/work/plugins/majlis-probe │
Plugin installed but not enabled. Run `hermes plugins enable majlis-probe` to activate.
 ✓ … installs a plugin from a Git repository switched off, then removes it 3941ms
 ✓ … fails an install in Hermes's own words 967ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```
ما يثبته: هرمز أنشأ البروفايل `work` بمهاراته المدمجة في مجلدات تصنيف، والمركز سرد الـ58 كلها بتصنيفها،
وطابق `/api/skills?profile=work` من هرمز نفسه مهارةً مهارة في التصنيف وفي كونها مدمجة. قائمة الإضافات
جاءت من `hermes plugins list` (لا `kanban` فيها، لأنها صفحة في اللوحة)، وتشغيل `disk-cleanup` في `work`
لم يغيّر الافتراضي، والإزالة رُفضت للمدمجة، وإضافة من مستودع Git محلي ثُبّتت مطفأة ثم أُزيلت.

(تُكمل نواتج بقية الفحوص أدناه.)

## المخاطر والرجوع
- كل أمر إضافات يشغّل عملية `hermes` جديدة (قرابة ثانية). التشغيل والإزالة يقرآن القائمة قبل وبعد.
  مقبول لصفحة إعداد، ويمكن لاحقًا الانتقال إلى مسارات اللوحة إن صارت تأخذ بروفايلًا.
- الحقول التي لا يذكرها هرمز في قائمته (`provides_tools` وأمثالها) فارغة، والعقد يقول ذلك.
- مهارات منصّة أخرى (macOS مثلًا) تظهر في القائمة وهرمز لا يحمّلها على لينكس. لم أرشّحها.
- حالة المهارة من إطفاء هرمز نفسه (`skills.disabled` في `config.yaml`) لا تُقرأ بعد. الصفحة تعرف
  الإطفاء بإعادة التسمية فقط، كما كانت.
- «شغّله الآن» في صفحة الوكيل يتبع قاعدة صفحة الجدولة (معطّل لما ليس في مجدول هرمز). إذا صار المركز
  يشغّل جداوله، يتغيّر الموضعان معًا.
- الرجوع: revert للفرع. لا ترحيل بيانات، ولا ملفات يكتبها المركز غير ما يكتبه هرمز بأوامره.

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية. الخطوة التالية: تأكيد المالك للقرارات 1–4، ثم (إن أراد) قراءة
`skills.disabled` من إعداد هرمز، وترشيح مهارات المنصّات الأخرى.
