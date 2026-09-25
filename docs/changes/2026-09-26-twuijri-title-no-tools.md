# تسمية المحادثة بلا أدوات، وحذف بقايا `AuditReport` في الويب
المسؤول: twuijri · الفرع: fix/title-no-tools-audit-cleanup · الحالة: review

## المشكلة والهدف
1. **تسمية المحادثة تعرض على النموذج كل الأدوات.** بعد أول رد يسأل الهب وكيل الجلسة «Name this
   conversation» (قرار العقد §26). الطلب كان يصل هرمز دورًا كاملًا ومعه أدوات البروفايل كلها (١٩ أداة في تشغيل
   حقيقي)، فنموذج حقيقي يستطيع أن يكتب ملفًا أو يرسل رسالة أو يرسم صورة وهو مطلوب منه عنوان فقط. المطلوب: طلب
   التسمية بلا أدوات، ولا يترك جلسة في سجل هرمز.
2. **بقايا بعد #117:** سجل «الأداء المباشر والسجلات» (#117، DECISIONS §51) ترك فرعي `logs`/`performance` في
   `packages/web/src/settings/AuditReport.tsx` حتى يُدمج #108. #108 مدموج في فرع التكامل؛ المطلوب حذف ما صار ميتًا
   أو مكرَّرًا مع أجزائه في العقد واختباراته، وإبقاء ما زال مستعملًا.

## القرار والموافقات
### ما رأيته في هرمز (ADR 0012؛ مصدره MIT في الصورة تحت `/opt/hermes/src`، الوسم v2026.9.14)
- **المسار اليوم:** `SessionNamer` → `runner.ask()` يفتح جلسة وكيل جديدة (`session.create` في بوابة الواجهة
  النصية TUI) ثم يرسل السؤال بـ`prompt.submit`. هذا دور وكيل كامل: هرمز يبني الوكيل بأدوات البروفايل ويعرضها كلها
  على النموذج. و`session.create` لا يكتب صفًّا في `state.db`، لكن أول `prompt.submit` يكتبه، فكل تسمية تركت في سجل
  هرمز جلسة مصدرها الهب.
- **ما يقدّمه هرمز لذلك:** طريقة `llm.oneshot` في بوابة TUI (`tui_gateway/methods_session.py`، وعقدها
  `LlmOneshotParams` في `tui_gateway/contracts/sessions.py`): «طلب نموذج واحد بلا حالة». تستدعي
  `agent/oneshot.py::run_oneshot` التي تبني رسالة نظام اختيارية ورسالة مستخدم وتنادي `call_llm` **بلا `tools`**، ولا
  تلمس سجل الجلسة ولا ذاكرة التخزين المؤقت للمطالبات. المعاملات: `instructions`، `input`، `task` (الافتراضي
  `title_generation`)، `max_tokens`، `temperature`، و`session_id`.
- **أي نموذج يجيب:** إن سُمّيت جلسة حيّة (`session_id`) «تُعير» نموذجها: مزوّدها ونموذجها وعنوانها ومفتاحها من وكيلها
  المبني (`_main_runtime_from_agent`). بلا جلسة يُستعمل مزوّد مهمة `title_generation` من إعداد الجذر — والطريقة ليست
  مقيّدة بالبروفايل (`@method` بلا `_profile_scoped`)، فبلا جلسة قد يجيب مزوّد بروفايل آخر.
- **متى يكون الوكيل جاهزًا:** `session.create` يعود فورًا ويبني الوكيل في الخلفية؛ عند اكتمال البناء يرسل هرمز حدث
  `session.info` للجلسة (`_announce_built_agent`)، أو `error` إن فشل. `llm.oneshot` لا ينتظر البناء: يقرأ
  `session["agent"]` كما هو، فمن يستعمل جلسة جديدة يجب أن ينتظر `session.info` أولًا.
- هرمز نفسه يسمّي جلساته بطريقة مماثلة (`agent/title_generator.py`: `call_llm` بلا أدوات، `max_tokens=64`).

### القرار (مقترح — للمالك أن يؤكّد)
1. **سؤال بلا أدوات من أي محوّل.** `runner.ask()` لم يعد يرسل دورًا إلى وكيل يملك أدوات. الترتيب:
   - **هرمز عبر TUI:** `llm.oneshot` مع `session_id`. إن كانت محادثة الجلسة نفسها مفتوحة (وهي كذلك عادةً، فالتسمية
     تأتي بعد الرد الأول مباشرة) تُعار هي: النموذج الذي تتكلم به المحادثة فعلًا، ولا وكيل جديد يُبنى. وإلا تُفتح
     جلسة مؤقتة في بروفايل المحادثة وعلى نموذجها، ويُنتظر `session.info`، ثم `llm.oneshot`، ثم تُغلق. لا
     `prompt.submit`، فلا صف في سجل هرمز.
   - **غير ذلك (هرمز خارجي عبر `/v1/runs`، أو وكيل ACP له أدواته، أو الوكيل المباشر):** السؤال يذهب مباشرة إلى نموذج
     المحادثة عبر المزوّد الذي يعرفه الهب (المحوّل المباشر `builtin`، ولا أدوات فيه أصلًا)، إن كان للاختيار مزوّد
     معروف (`providerId`).
   - وإلا لا يُسأل أحد، ويُسمّى العنوان من أول رسالة (`fallbackTitle`) كما يحدث اليوم عند الفشل.
2. **لا تغيير في العقد ولا في ما يراه الشخص:** العنوان نفسه، في الوقت نفسه، بالحدث نفسه (`session.updated`).
3. **أثر جانبي مقصود:** وكيل ACP (Claude Code، Codex…) لا يُسأل بعد اليوم عن العنوان بدور كامل؛ إن كان لنموذجه مزوّد
   يعرفه الهب سُئل النموذج مباشرة، وإلا سُمّيت المحادثة من أول رسالة. العنوان أبسط أحيانًا، ولا أداة تعمل بسببه.

### الجزء الثاني: `AuditReport`
- `packages/web/src/settings/AuditReport.tsx` لم يعد يستورده أي ملف منذ #108 و#117 (حُذف استيراده في سجل التكامل
  ٢٠٢٦-٠٩-٢٥)، ولم يبقَ فيه إلا فرعا `logs`/`performance` → **ميت، حُذف**. ومعه ما لم يستعمله غيره: سبعة مفاتيح ترجمة
  في `audit.*` (`no_entries`، `uptime`، `seconds`، `memory`، `node`، `no_samples`، `samples_n`) بالعربية والإنجليزية،
  وقاعدتا CSS ‏`.log-entry` و`.log-entry-time`. المفاتيح `audit.period`/`days`/`between` وغيرها باقية لأن صفحة
  الاستخدام تستعملها.
- **العقد والخادم باقيان كما هما:** `audit.getReport` بنوعيه `logs` و`performance` ما زال يستعمله تطبيق iOS
  (`apps/ios/CoreHub/Settings/ManagementPages.swift`، `AuditPage` → `AuditAPI.auditGetReport` من شاشتي السجلات والأداء
  في `SettingsScreen.swift`)، وسجل #117 نفسه أبقاه للعملاء الأقدم. حذفه يكسر iOS، ومجلد iOS خارج هذه المهمة. فلا
  تغيير في `packages/contracts` ولا توليد عملاء ولا حاجة لـ`contracts:check-clients`.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء في `packages/contracts`. فقرة جديدة تحت قرار التسمية في `docs/contracts/DECISIONS.md` (§26 «The hub names a
session, unless a person did»): السؤال بلا أدوات ولا يترك شيئًا في سجل الوكيل، والترتيب أعلاه. داخل الخادم:
`OneshotRequest` و`OneshotUnavailable`، و`AgentSession.oneshot?` و`AgentAdapter.oneshot?` (اختياريان).

## الملفات والتأثير
- الخادم: `packages/server/src/modules/agents/runner.ts` (`ask()` → `askToolFree()`، `ASK_MAX_TOKENS`)،
  `adapters/types.ts` (الأنواع أعلاه)، `adapters/hermes-tui.ts` (`HermesTuiSession.oneshot()` وانتظار بناء الوكيل
  عبر `session.info`/`error`)، `adapters/hermes.ts` (`oneshot()` بجلسة مؤقتة عبر TUI، و`OneshotUnavailable` بدونه)،
  `tests/container/fake-provider.mjs` (تعليق فقط).
- الاختبارات: `runner.test.ts` (أربعة اختبارات جديدة، وتعديل توقّع قديم كان يثبت أن السؤال يذهب دورًا عبر
  `/v1/runs` — صار يثبت العكس)، `adapters/hermes-tui.test.ts` (ثلاثة جديدة)، `adapters/hermes-oneshot.real.test.ts`
  (جديد، هرمز الحقيقي).
- الويب: حذف `packages/web/src/settings/AuditReport.tsx`؛ `src/i18n/ar.json` و`en.json` (سبعة مفاتيح)؛
  `src/styles/screens.css` (`.log-entry*`).
- التوثيق: `docs/contracts/DECISIONS.md` (§26)، `docs/STATUS.md` (سطر sessions)، فهرس الليلة.
- لا مساس بـ`apps/android` ولا `apps/ios` ولا `.github/workflows`.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`. هرمز الحقيقي: الصورة المحلية `core-hub:morechannels` (هرمز فيها مبني من v2026.9.14)، حاوية
`--rm` واحدة يشغّلها الاختبار ويزيلها؛ لم تُلمس حاويات المالك ولا المنفذ 8642.

الاختبارات الجديدة على الكود القديم (نسخة `runner.ts` من رأس الفرع قبل التغيير) — تفشل كلها لأن الوكيل أُعطي دورًا:
```
     × asks the agent’s own one-shot on the conversation’s profile and model, and hands it no turn 7ms
     × lends the open conversation when there is one, instead of opening another 1ms
     × asks the model straight from its provider when the agent has no one-shot, never the agent 1ms
     × falls back to the provider when the agent cannot do a one-shot here, and to nothing without one 1ms
AssertionError: expected 'hermes title' to be 'Streaming explained' // Object.is equality
AssertionError: expected 'acp title' to be 'builtin title' // Object.is equality
      Tests  4 failed | 26 skipped (30)
```
هرمز الحقيقي (`COREHUB_HERMES_IMAGE=core-hub:morechannels … vitest run src/modules/agents/adapters/hermes-oneshot.real.test.ts`):
سؤال التسمية وصل النموذج بلا `tools` وبرسالة مستخدم واحدة، و`session.list` لم يتغيّر؛ ودور محادثة عادي للمقارنة
عرض على النموذج **19 أداة** (العدد نفسه الذي رُصد في التشغيل الحقيقي) وخُزّن في `session.list`؛ ثم أعارت المحادثة
المفتوحة نموذجها لسؤال بلا أدوات.
```
 RUN  v5.0.1 /home/twuijri/project/corehub-wt-titlefix/packages/server

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  18:21:15
   Duration  15.16s (tests 99%, transform 1%)
```
الملفات التي لمستها (`vitest run runner.test.ts hermes-tui.test.ts hermes.test.ts naming.test.ts hermes-oneshot.real.test.ts`،
الأخير مُتخطّى بلا صورة):
```
 Test Files  4 passed | 1 skipped (5)
      Tests  79 passed | 2 skipped (81)
```
الويب (`vitest run tests/i18n.test.ts tests/logical-css.test.ts`):
```
 Test Files  2 passed (2)
      Tests  269 passed (269)
```
```
$ pnpm i18n:check
i18n:check  web: 2558 keys, ar/en in parity
i18n:check  ios: 280 keys, ar/en in parity
i18n:check  OK
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
exit=0
```
CI على #144 عند الالتزام `f04da52` (الدمج في `night/2026-09-26`) — كل الفحوص الـ17 نجحت، ومنها وحدات الخادم
بشظاياها الثلاث، ورحلات Playwright، وبناء أندرويد، ومحاكي iOS، وتوليد عميل Swift:
```
$ gh pr checks 144 --repo twuijri/core-hub | awk -F'\t' '{print $2}' | sort | uniq -c
     17 pass
```

## المخاطر والرجوع
- **انتظار بناء الوكيل:** الجلسة المؤقتة تنتظر `session.info`؛ إن ضاع الحدث (سباق نظري لو وصل قبل أن نربط الجلسة)
  ينتهي السؤال عند المهلة (٢٠ ث) ويُسمّى العنوان من أول رسالة — لا شيء أسوأ من اليوم عند الفشل.
- **كلفة:** الجلسة المؤقتة تبني وكيلًا (كما كان يحدث قبل)، لكنها نادرة: الغالب أن المحادثة مفتوحة فتُعار.
- **ACP:** عنوان أبسط حين لا يعرف الهب مزوّد النموذج (انظر القرار ٣).
- الرجوع: `git revert` للالتزام؛ لا ترحيل ولا تغيير عقد.

## التسليم والخطوة التالية
مدموج في `night/2026-09-26` (#144). للمالك: تأكيد القرار (السؤال بلا أدوات، والتراجع إلى المزوّد المباشر أو أول
رسالة لغير هرمز). مقترح لاحق: إن أراد المالك عناوين هرمز نفسه (`agent/title_generator.py` يسمّي جلساته بعد أول دور)
فقد تُقرأ من `session.list` بدل سؤال ثانٍ.
