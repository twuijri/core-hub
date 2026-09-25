# إعدادات هرمز الموجودة في هرمز وليست في كور هب: تُقرأ وتُكتب في ملفات البروفايل نفسها، ومراجعة ما يكتبه الوكيل في ذاكرته ومهاراته
المسؤول: twuijri · الفرع: feat/hermes-settings · الحالة: review

## المشكلة والهدف
صفحة «إعدادات Hermes» في كور هب تُبنى مما يعلنه المحوّل (ADR 0002). قبل هذه المهمة كانت تعرض
أربعة أقسام (`agent` و`memory` و`session` و`gateway`) **يخزّنها المركز في جدوله ولا يقرؤها شيء**:
حد دورات افتراضيه ٤٠ لم يره هرمز قط (افتراضي هرمز الحقيقي ٥٠٠ في محادثات المركز وبلا حد في القنوات)،
و«الموافقة على الكتابة» تعمل افتراضيًا (هرمز: متوقفة)، ووضع موافقات بقيم ليست قيم هرمز، وعنوان
بوابة. وفي إعدادات البروفايل `proxy` و`privacy.redact_pii` يخزّنهما المركز ولا يطبقهما شيء (#79).
وبطاقة الضغط التي أضافها #118 ما زالت في طلب دمج مفتوح، ولم تُلمس هنا.

الهدف: إعدادات هرمز الحقيقية، لكل بروفايل، مقروءة من ملفات هرمز ومكتوبة فيها (`config.yaml` مع
بقاء التعليقات كما يفعل #80، أو `.env`)، بعد قراءة مصدر هرمز (MIT، `/opt/hermes`، الإصدار
2026.9.14، `hermes_cli/config_defaults.py`):
1. وقت التشغيل: أقصى عدد للدورات، مهلة التشغيل، إلزام استخدام الأدوات، مستوى التفكير الافتراضي،
   وحدّا الذاكرة (٢٢٠٠ و١٣٧٥).
2. إعادة ضبط الجلسة تلقائيًا بعد خمول أو في ساعة محددة — إن كانت في هرمز.
3. وكيل الشبكة: HTTPS/HTTP وقائمة الاستثناء، وهل يؤثر على هرمز وحده أم على المركز أيضًا.
4. الخصوصية: `redact_pii` في هرمز، وحسم مصير حقل المركز الميت.
5. الموافقات: مراجعة ما يكتبه الوكيل في ذاكرته ومهاراته، وقائمة مراجعة في الويب بـ«موافقة» و«رفض».

## القرار والموافقات
المهمة من المنسّق نيابة عن المالك (والمالك نائم). القرارات التالية جديدة على المنتج، وكلها
**مقترحة — بانتظار تأكيد المالك** (DECISIONS §58):

- **نموذج المحوّل = مفاتيح هرمز نفسها في البروفايل المختار.** `agents.getSettings` و`agents.updateSettings`
  لهرمز يقرآن ويكتبان `config.yaml` الخاص بالبروفايل (تعديل في المكان: التعليقات والترتيب وكل مفتاح آخر
  يبقى، ولا يُعاد كتابة ملف لا يُقرأ) أو `.env` الخاص به. لا يخزّن المركز شيئًا. خمسة أقسام:
  - **وقت التشغيل** (`agent`): `agent.max_turns` (صفر = بلا حد؛ الفارغ = افتراضي هرمز «٥٠٠ في محادثات
    كور هب، وبلا حد في القنوات» — من `tui_gateway/server.py` `_cfg_max_turns(cfg, 500)` و`resolve_turn_limit`)،
    `agent.run_budget_seconds` (فارغ/صفر = بلا مهلة)، `agent.tool_use_enforcement` (تلقائي/دائمًا/أبدًا؛
    قائمة نماذج مكتوبة يدويًا تُعرض ولا تُكتب من النموذج)، `agent.reasoning_effort` (بلا تفكير … فائق؛ الفارغ =
    افتراضي النموذج).
  - **الذاكرة** (`memory`): `memory.memory_char_limit` (٢٢٠٠) و`memory.user_char_limit` (١٣٧٥) — الحدّان
    نفساهما اللذان تفرضهما صفحة الذاكرة.
  - **الموافقات** (`approvals`): `approvals.mode` (يدوي/ذكي/بلا موافقات، الافتراضي «ذكي») بدل حقل المركز
    الوهمي، و`memory.write_approval` و`skills.write_approval` (متوقفان افتراضيًا).
  - **وكيل الشبكة** (`network`): `HTTPS_PROXY` و`HTTP_PROXY` و`NO_PROXY` في `.env` البروفايل (ويُحذف
    الإملاء الصغير القديم حتى لا يبقى حيًا).
  - **الخصوصية** (`privacy`): `privacy.redact_pii`.
- **كل حقل بتسمية عربية وإنجليزية وشرح وافتراضي هرمز**، وكل قسم يقول متى يسري. إضافات اختيارية في
  العقد: `SettingsField.help` و`default` و`default_text`، و`Choice.labels`، و`SettingsSection.applies`
  (`next_message` | `restart`) و`note`.
- **متى يسري ما يُحفظ:** هرمز يقرأ هذه القيم حين يبني وكيل الجلسة، فالحفظ **يُقاعد بوابة TUI** كما يفعل
  تغيير المفاتيح: كل محادثة تأخذ القيم من رسالتها التالية، والدورة الجارية تكمل بقيمها. بوابة القنوات
  لبروفايل مسمّى يُعاد تشغيلها فورًا؛ بوابة البروفايل الافتراضي تنتظر «إعادة التشغيل» (القاعدة نفسها
  لتغيير القنوات). الصفحة تقول «حُفظ في إعدادات هرمز، ويسري من الرسالة التالية».
- **الوكيل (proxy) لهرمز وحده، لا للمركز.** طلبات المركز الخارجية (`fetch` في Node) لا تقرأ هذه
  المتغيرات. وهو على مستوى العملية: هرمز يحمّل `.env` في بيئته عند البدء، وبوابة TUI الواحدة تخدم كل
  البروفايلات من المجلد الجذري، فـ**وكيل البروفايل الافتراضي هو ما تستعمله كل محادثات المركز** وقنوات
  البروفايل الافتراضي، ووكيل البروفايل المسمّى يصل إلى قنواته ومهامه المجدولة فقط. الحفظ في البروفايل
  الافتراضي يشغّل «إعادة تشغيل» هرمز كمهمة (`restart_job_id`) حين يديره المركز؛ وفي المسمّى تُعاد بوابته.
  الصفحة تقول ذلك في ملاحظة القسم.
- **`redact_pii`: وُصل مفتاح صفحة الخصوصية بإعداد هرمز، وأُهمل حقل المركز.** مفتاح «إخفاء المعرّفات وأرقام
  الهواتف عن النموذج» في صفحة الخصوصية هو `privacy.redact_pii` في البروفايل (واتساب وتيليجرام وسيجنال
  وBlueBubbles، يُقرأ مع كل رسالة؛ محادثات المركز نفسه لا تحمل هذه المعرّفات). `ProfileSettings.privacy`
  و`ProfileSettings.proxy` في العقد صارا `deprecated` ولم يُحذفا — حذفهما كسر للعملاء المولَّدة بلا فائدة
  الآن؛ يُحذفان في إصدار عقد لاحق.
- **قائمة المراجعة:** هرمز مع تشغيل البوابة يحفظ كل كتابة معلّقة في `pending/<memory|skills>/<id>.json`.
  ثلاث عمليات جديدة: `agents.listPendingWrites` (قراءة الملفات)، `agents.approvePendingWrite` (هرمز نفسه
  يطبّقها بكوده — `apply_memory_pending` بمخزن من القرص أو `apply_skill_pending` — بمفسّر بايثون هرمز
  على مجلد البروفايل، كما يفعل `/memory approve` في بوابته؛ وما يرفضه هرمز يبقى في القائمة مع `409` بكلمات
  هرمز)، و`agents.rejectPendingWrite` (حذف السجل، وهو ما يفعله رفض هرمز). في الويب بطاقة «بانتظار
  المراجعة» أسفل صفحة إعدادات هرمز: النوع، المصدر (أثناء محادثة / مراجعة هرمز الذاتية)، الوقت، النص الجديد
  والقديم، وزرّا «موافقة» و«رفض». تُحدَّث كل ١٥ ثانية.
- **لم يُبنَ لأن هرمز لا يملكه:** إعادة ضبط الجلسة تلقائيًا بالخمول أو بالساعة. في 2026.9.14
  `SessionResetPolicy` نوع خامل «Gateway configuration and session lifecycle do not consume this datatype»،
  و`gateway/session_lifecycle.py` ينص أن الوقت لا يستبدل محادثة أبدًا.
- **مُحدِّد الموافقات في شريط الكتابة** يقرأ الآن `approvals.mode` الحقيقي لهرمز (يدوي/ذكي/بلا موافقات)،
  وحين لا يُكتب شيء يعرض افتراضي هرمز «ذكي» لا الخيار الأول.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- ثلاث عمليات جديدة: `agents.listPendingWrites` — `GET /agents/{agent_id}/pending-writes`،
  `agents.approvePendingWrite` — `POST /agents/{agent_id}/pending-writes/{write_kind}/{write_id}/approve`،
  `agents.rejectPendingWrite` — `DELETE /agents/{agent_id}/pending-writes/{write_kind}/{write_id}` (مشرف،
  بمعامل البروفايل). مخططات `PendingWrite` و`PendingWriteList` و`PendingWriteApplied`، ومعاملا
  `PendingWriteKind` و`PendingWriteId`.
- إضافات اختيارية: `SettingsField.help` و`default` و`default_text`، و`Choice.labels`،
  و`SettingsSection.applies` و`note`. وصف `agents.getSettings`/`updateSettings` ومثالاهما لأقسام هرمز
  الحقيقية، وإضافة `409` لهما.
- `ProfileSettings.proxy` و`ProfileSettings.privacy`: `deprecated: true` مع السبب.
- `docs/contracts/DECISIONS.md` §58، و`docs/contracts/COVERAGE.md` صفّا ١٠ و٣٣. STATUS: ‏209 من 267.

## الملفات والتأثير
- الخادم: `packages/server/src/modules/agents/hermes-settings.ts` (جديد: جدول الخيارات، القراءة والكتابة
  كلها أو لا شيء)، `hermes-pending-writes.ts` (جديد: القائمة والرفض والموافقة عبر بايثون هرمز)،
  `index.ts` (مسارا الإعدادات لهرمز، والمسارات الثلاثة، و`hermesPython`)، `hermes-runtime.ts`
  (`settingsChanged`)، `adapters/hermes.ts` (المحوّل لم يعد يعلن النموذج المخزّن)، `adapters/types.ts`
  (الحقول الاختيارية).
- الاختبارات: `hermes-settings.test.ts` (رحلة ذهاب وعودة لكل مفتاح، التعليقات، الإملاءات، الرفض)،
  `hermes-pending-writes.test.ts`، `hermes-settings.routes.test.ts` (لكل بروفايل، بتحقق مخطط العقد لكل
  رد)، `hermes-settings.real.test.ts` (هرمز الحقيقي)، وتحديث `agents.test.ts` و`adapters.test.ts`
  و`hermes-runtime.test.ts`.
- الويب: `src/agents/AgentSettingsScreen.tsx` (الشرح والافتراضي وملاحظة القسم ورسالة ما بعد الحفظ،
  والخيار الفارغ = افتراضي هرمز)، `src/agents/PendingWritesCard.tsx` (جديد)، `src/settings/PrivacyTab.tsx`
  (مفتاح `redact_pii` لهرمز)، `src/chat/useComposerControls.ts`، والنصوص في `src/i18n/{ar,en}.json`
  (`agents.*`، `agents.pending.*`، `composer.approval_mode/hint.manual|smart`، `privacy.redact_*`).
  الاختبارات: `tests/hermes-settings.test.tsx` (جديد)، وتعليق في `tests/webhooks-privacy.test.tsx`، ورحلة
  ‏25 في `e2e/zzz-settings-webhooks-privacy.spec.ts` (المفتاح الوحيد هو مفتاح هرمز) ولقطة `privacy-ar-light`.
  رحلة Playwright ‏45: `e2e/zzzzzz-hermes-settings.spec.ts` ولقطة `hermes-settings-ar-light`.
- الوثائق: `docs/STATUS.md`، `docs/contracts/DECISIONS.md`، `docs/contracts/COVERAGE.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
كل أمر ثقيل عبر `mj-run`، واحدًا بعد الآخر. محليًا شُغّل ما تمسّه المهمة فقط (قاعدة السرعة)؛ الحزم
الكاملة يشغّلها CI.
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck            # exit 0
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 284 client file(s) scanned, 179 contract path(s) known.
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  277 passed (277)
$ pnpm i18n:check
i18n:check  web: 1343 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ vitest run --project unit hermes-settings.test.ts hermes-pending-writes.test.ts hermes-settings.routes.test.ts agents.test.ts adapters/adapters.test.ts hermes-runtime.test.ts
 Test Files  6 passed (6)
      Tests  101 passed (101)
$ vitest run --project unit hermes-runtime.test.ts -t "settings changed"
      Tests  1 passed | 11 skipped (12)
$ vitest run --project unit tests/unit/status.test.ts      # بعد تحديث STATUS (كان يفشل: expected 264 to be 267)
      Tests  1 passed (1)
$ COREHUB_HERMES_IMAGE=core-hub:channeldeps vitest run --project unit --reporter=verbose hermes-settings.real.test.ts
 ✓ writes every setting where Hermes's own loaders read it back 418ms
 ✓ puts a value back to Hermes's default, as Hermes sees it 360ms
 ✓ with the gates on, Hermes stages its writes; the hub lists, approves and rejects them 1449ms
      Tests  3 passed (3)
$ docker run --rm --entrypoint sh core-hub:channeldeps -c '/opt/hermes/.venv/bin/hermes --version'
Hermes Agent v0.21.3 (2026.9.14)
$ (web) vitest run tests/hermes-settings.test.tsx tests/webhooks-privacy.test.tsx tests/composer.test.tsx
 Test Files  3 passed (3)
      Tests  40 passed (40)
$ pnpm build                # ✓ built
$ COREHUB_E2E_PORT=8841 COREHUB_E2E_SETUP_PORT=8842 PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzz-hermes-settings.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-hermes-settings.spec.ts:31:1 › 45. Hermes's settings: max turns and the proxy saved to Hermes's files and read back after a reload (1.1s)
  1 passed (7.4s)
$ pnpm change-record:check
change-record  OK — 1 record(s) valid
```
فحص هرمز الحقيقي: صورة `core-hub:channeldeps` (هرمز 2026.9.14) بلا شبكة، بمستخدم المضيف، وحاوية لكل
استدعاء تُحذف بعده (`--rm`، ولا حاويات متبقية). ما يُثبته: كل قيمة يكتبها المركز يقرؤها **محمّل هرمز نفسه**
(`load_config` + `resolve_turn_limit`، `resolve_reasoning_config`، `load_on_disk_store`،
`write_approval_enabled`، `_normalize_approval_mode`، و`load_hermes_dotenv` ثم `first_proxy_env_value`
و`should_bypass_proxy`)، والرجوع إلى الافتراضي يراه هرمز كذلك، ومع البوابتين تعمل أداة الذاكرة ومدير المهارات
في هرمز **يؤجّلان** الكتابة، والمركز يسردها ويوافق على واحدة من كل نوع (فتظهر في `memories/MEMORY.md`
و`skills/deploy-notes/SKILL.md`) ويرفض الثالثة. لم يُلمس هرمز المالك على المنفذ 8642.

نتيجة CI على #131: الدفعة الأولى فشلت في رحلة Playwright ‏25 (صفحة الخصوصية كانت تتوقع «لا مفتاح»؛ صار
فيها مفتاح هرمز عن قصد) — عُدّلت الرحلة لتتحقق أن المفتاح الوحيد هو `redact_pii` لهرمز، وأُعيد توليد لقطة
`privacy-ar-light`، وشُغّلت محليًا (`1 passed`). الدفعة التالية (run 36100813205):
```
Docker image builds and answers /health               pass
Lint, typecheck, contracts, tests, build              pass
PR adds or updates a change record                    pass
PR leaves graphify-out/ to the code-map bot           pass
Web smoke journeys (Playwright against the real hub)  pass
db:generate + db:migrate (SQLite and PostgreSQL)      pass
```

## المخاطر والرجوع
- **تغيير سلوك:** صفحة إعدادات هرمز لم تعد تعمل بلا مجلد هرمز (مركز بلا هرمز أصلًا يجيب `409 runtime_absent`
  بدل نموذج وهمي). والقيم المخزّنة سابقًا في جدول `agent_settings` لهرمز تُترك كما هي ولا تُقرأ (لم تُطبَّق قط).
- **مُحدِّد الموافقات في شريط الكتابة** يغيّر الآن `approvals.mode` في البروفايل كله (كان يغيّر قيمة لا يقرؤها
  أحد). «بلا موافقات» صار حقيقيًا، ولونه تحذيري كما كان.
- **حفظ وكيل الشبكة في البروفايل الافتراضي يعيد تشغيل هرمز** (مهمة)، فتنقطع دورة قناة جارية فيه. وقاعدة «وكيل
  الافتراضي لكل المحادثات» ناتجة عن بوابة TUI الواحدة؛ إن تغيّر ذلك تتغيّر الملاحظة.
- **الموافقة تحتاج هرمز مثبتًا بجانب المركز** (بايثونه)؛ هرمز خارجي: القائمة والرفض يعملان، والموافقة `409
  hermes_not_supervised`.
- التعارض مع #118 (بطاقة الضغط، مفتوح): كلاهما يمس `AgentSettingsScreen.tsx`؛ من يُدمج ثانيًا يحلّ التعارض.
- الرجوع: `git revert` لطلب الدمج. لا ترحيل قاعدة بيانات، والملفات التي كتبها المركز مفاتيح هرمز عادية.

## التسليم والخطوة التالية
- طلب الدمج بالإنجليزية على `twuijri/core-hub`؛ لا دمج ولا صورة.
- للمالك: تأكيد §58 (خصوصًا: وكيل البروفايل الافتراضي لكل المحادثات، وإهمال حقلي المركز بدل حذفهما، وإعادة
  التشغيل التلقائية عند حفظ الوكيل).
- لاحقًا: عدّ الكتابات المعلّقة في شريط الإجراءات المعلّقة؛ وحذف `ProfileSettings.proxy/privacy` في إصدار عقد
  لاحق؛ وربما بطاقة القائمة في صفحتي الذاكرة والمهارات أيضًا.
