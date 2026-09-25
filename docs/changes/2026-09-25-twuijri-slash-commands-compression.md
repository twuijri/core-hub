# أوامر «/» في المحرّر، وضغط السياق مع عدّاد النافذة
المسؤول: twuijri · الفرع: feat/slash-commands-compression · الحالة: review

## المشكلة والهدف
تقرير مراقبة (بكلام عادي) يقول إن المنتج الأقدم فيه أوامر تبدأ بـ«/» في المحرّر، وضغط لسياق
المحادثة، وعدّاد يبيّن امتلاء نافذة النموذج. عندنا قبل هذه المهمة:
- حلقة صغيرة بجانب المايك تقدّر الامتلاء من رموز آخر دور مقابل نافذة الكتالوج، بلا تفاصيل ولا
  طريقة للضغط، ولا تقول إنها تقدير.
- `Session.context` في العقد، لكن الخادم يرجعه `null` دائمًا.
- `ProfileSettings.compression` مخزَّنة في قاعدة الخادم ولا تصل إلى Hermes أبدًا.
- لا أوامر «/» إطلاقًا: أي `/نص` يُرسَل رسالةً عادية.

قرأنا Hermes (MIT، الوسم v2026.9.14، `/opt/hermes` في الصورة) — لا كود Studio (ADR 0004):
- بوابة TUI فيها `session.compress` (يردّ بعدد الرسائل والرموز قبل وبعد، ويرسل
  `status.update` بنوع `compressing`)، و`session.steer` (نص يصل الوكيل بعد استدعاء الأداة التالي
  دون قطع الدور)، و`command.dispatch` الذي ينفّذ `/goal` و`/plan` و`/learn` واسم أي مهارة:
  يردّ إمّا بنص يُرسَل دورًا (`send`/`skill`) أو بمخرجات جاهزة (`exec`).
- مع كل دور مكتمل يرسل Hermes استهلاكه ومعه `context_used` و`context_max` و`context_estimated`.
- أثناء الدور يضغط Hermes وحده حين تمتلئ النافذة ويقول ذلك في `status.update` بنوع `compacting`.
- مفاتيح الضغط في `config.yaml` لكل بروفايل: `compression.enabled` و`threshold` و`target_ratio`
  و`protect_first_n` و`protect_last_n`، ونافذة النموذج `model.context_length`؛ وبوابة TUI تعيد
  قراءتها في بداية كل دور وتطبّقها على المحادثة الحيّة، فلا حاجة لإعادة تشغيل.

الهدف: أوامر «/» حقيقية من قدرات Hermes نفسه، وضغط يدوي وتلقائي يُرى، وعدّاد يقول مصدر رقمه.

## القرار والموافقات
**مقترح — بانتظار تأكيد المالك** (DECISIONS §57):
1. **الأمر يظهر فقط إن كان وكيل المحادثة يقدر عليه.** ست قدرات جديدة في `AgentCapability`:
   `compress`, `steer`, `goals`, `plans`, `learn`, `skill_commands` — لـ Hermes وحده في
   الكتالوج. أوامر الخادم `/new` و`/fork` و`/archive` و`/model` و`/clear-screen` لكل وكيل
   (عمليات موجودة أصلًا). أي `/نص` آخر رسالة عادية.
2. **`/goal` و`/plan` و`/learn` و`/skill <اسم>` رسائل.** تُخزَّن كما كُتبت، والمحوّل يعطيها
   لـ `command.dispatch` في Hermes؛ ما يردّه Hermes (نص يُرسَل، أو مخرجات) هو الدور. المحادثة
   تعرض ما كتبه الشخص لا النص الموسّع (قاعدة Hermes نفسها). اسم المهارة يُحوَّل كما يحوّله Hermes
   (أحرف صغيرة، `_` و المسافة إلى `-`).
3. **`sessions.compress`** (`POST /sessions/{id}/compress` بـ `{focus}` اختياري) بين الأدوار
   فقط (`409 already_running` مع دور حيّ أو في الطابور)، وعلى سلسلة أدوار المحادثة فرسالة تُرسَل
   أثناءه تنتظره. `context.compression` (`started`/`finished`/`failed`) ثم `context.updated`.
4. **`sessions.steerRun`** (`POST /sessions/{id}/runs/{run_id}/steer` بـ `{text}`) = `session.steer`؛
   لا يضيف شيئًا للمحادثة ولا يقطع الدور؛ `rejected` يعني أرسله رسالة عادية (سلوك Hermes نفسه).
   بلا دور جارٍ يرسل الويب النص رسالة عادية.
5. **العدّاد يقرأ عدّ Hermes نفسه** ويُحفظ على المحادثة (`metadata.context`، بلا هجرة)، فصار
   `Session.context` يجيب بعد إعادة التحميل. بلا تقرير من الوكيل يقدّر الويب من آخر دور مقابل
   نافذة الكتالوج، ويكتب «تقدير». `ContextUsage.estimated` جديد.
6. **الضغط التلقائي = إعدادات البروفايل نفسها مكتوبة في Hermes.** `ProfileSettings.compression`
   صارت تُقرأ من `config.yaml` للبروفايل وتُكتب فيه حيث يشغّل الخادم Hermes، ومعها
   `context_length` (تجاوز نافذة النموذج). كتابة لا يقبلها ملف Hermes تُرفض
   (`409 runtime_config_unwritable`) ولا تُخزَّن. البطاقة في صفحة إعدادات Hermes للبروفايل المختار.
7. **`/clear-screen`** يخفي ما على الشاشة حتى يطلب الشخص إظهاره («أظهرها»)؛ لا يحذف شيئًا.
   **`/model`** بلا اسم يفتح منتقي النموذج، وباسم يختاره.

مرفوض: جدول أوامر ينفّذه الخادم (`POST /sessions/{id}/commands`) — يصنع رسائل وأدوارًا لا تطابق
ما كتبه الشخص ويكرّر قرار Hermes؛ وقائمة `commands` منفصلة لكل وكيل بدل القدرات.

ملاحظة: التقرير ذكر `/skill` لـ«تحميل مهارة مسبقًا للرسالة التالية». Hermes يحمّل المهارة داخل
الرسالة نفسها (`/اسم-المهارة نص`)، فصار `/skill <اسم> <نص>` رسالة واحدة: المهارة والطلب معًا.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عمليتان جديدتان: `sessions.compress` (`SessionCompressRequest` → `SessionCompression`، ردود
  200/400/401/404/409/422) و`sessions.steerRun` (`RunSteerRequest` → `RunSteerResult`،
  200/400/401/404/409).
- حدث جديد `/rt/sessions · context.compression` (`events/sessions/context.compression.schema.json`)،
  ومضاف إلى `x-rt-events` لـ `sessions.createRun` و`sessions.compress`.
- `ContextUsage.estimated` (اختياري)، و`ProfileSettings.compression.context_length` (مطلوب،
  `null` = نافذة النموذج)، ووصف يربط الحقول بمفاتيح Hermes.
- `AgentCapability` + `compress`, `steer`, `goals`, `plans`, `learn`, `skill_commands`.
- `events/common.schema.json` ونسخ `ContextUsage` في أحداث الجلسة، و`events/README.md`.
- `docs/contracts/DECISIONS.md` §57 (§47–§51 مأخوذة في طلبات دمج مفتوحة #105–#117، فأخذتُ التالي الحرّ).

## الملفات والتأثير
- الخادم — المحوّل: `agents/adapters/hermes-tui.ts` (`commandTurn` لـ `/goal`/`/plan`/`/learn`/
  `/skill`، `compress`، `steer`، `status.update` → حدث ضغط، `context` من استهلاك كل دور)،
  `adapters/types.ts`، `agents/runner.ts` (`open` مشترك، `compress` يتحقق من القدرة، `steer`)،
  `agents/ports.ts`، `agents/schema.ts`، `agents/catalog/hermes.ts`.
- الخادم — الضغط في Hermes: `agents/hermes-compression.ts` (قراءة/كتابة المفاتيح مع إبقاء بقية
  الملف وتعليقاته)، `modules/index.ts` (منفذ `ProfileMirror`)، `auth/{profile-mirror,routes,
  schema,serialize,index}.ts`.
- الخادم — الجلسات: `sessions/{ports,service,routes,engine,run-reducer,mappers,realtime}.ts`،
  `sessions/testing/fake-runner.ts`.
- الويب: `chat/slashCommands.ts` (دوال نقية)، `chat/SlashMenu.tsx`، `chat/Composer.tsx`
  (القائمة، لوحة المفاتيح، تنفيذ الأمر)، `chat/useChatCommands.ts`، `chat/ContextRing.tsx`
  (العدّاد، التفاصيل، زر الضغط، `CompressionStatus`)، `chat/ChatScreen.tsx`،
  `chat/transcript.ts`، `realtime/envelope.ts`، `agents/CompressionSettingsCard.tsx`،
  `agents/AgentSettingsScreen.tsx`، `styles/chat.css`، `i18n/{ar,en}.json` (عربي وإنجليزي).
- e2e: `e2e/hub.ts` (سيناريو «املأ السياق» و`compress`)، `e2e/zzzzzz-slash-compress.spec.ts`.
- الاختبارات الجديدة: `hermes-tui-commands.test.ts` (بوابة مكتوبة بالسيناريو)،
  `hermes-tui-commands.real.test.ts` (Hermes الحقيقي)، `hermes-compression.test.ts`،
  `sessions-compress.test.ts`، `tests/unit/profile-compression.test.ts`،
  `web/tests/{slash-commands,context-meter}.test.tsx`؛ وتعديل توقّع في `outbox.test.ts`
  و`run-reducer.test.ts` (الحقل الجديد).
- `docs/STATUS.md`: 208 من 266، وصف الجلسات والبروفايلات والويب.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run` على هذا الفرع (2026-09-25):

```
$ pnpm contracts:lint
openapi.yaml: validated in 570ms
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 91 event schema file(s)
contracts:lint  OK

$ pnpm lint
All matched files use Prettier code style!

$ pnpm typecheck        (كل الحزم، بلا أخطاء)

$ pnpm i18n:check
i18n:check  web: 1364 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contracts:check-clients
check-clients  OK — 288 client file(s) scanned, 178 contract path(s) known.

$ vitest run src/modules/sessions/sessions-compress.test.ts
 Test Files  1 passed (1)      Tests  6 passed (6)
$ vitest run src/modules/agents/hermes-compression.test.ts src/modules/agents/adapters/hermes-tui-commands.test.ts
 Test Files  2 passed (2)      Tests  15 passed (15)   (ثم 10/10 للملف الثاني بعد إضافة تحويل اسم المهارة)
$ vitest run tests/unit/profile-compression.test.ts
 Test Files  1 passed (1)      Tests  4 passed (4)
$ vitest run tests/contract/contract.test.ts
 Test Files  1 passed (1)      Tests  267 passed (267)
$ vitest run runner, run-reducer, sessions-run, hermes-tui, adapters, agents, auth.contract
 Tests  1 failed | 113 passed (114)   ← توقّع run-reducer بلا الحقل الجديد؛ صُحّح:
$ vitest run src/modules/sessions/run-reducer.test.ts
 Tests  18 passed (18)
$ vitest run tests/unit/status.test.ts      (بعد تحديث STATUS: 208 من 266) — passed

$ COREHUB_HERMES_IMAGE=core-hub:channeldeps vitest run src/modules/agents/adapters/hermes-tui-commands.real.test.ts
 Test Files  1 passed (1)      Tests  3 passed (3)
   (Hermes الحقيقي v2026.9.14 من الصورة: النافذة المكتوبة 64000 هي ما يبلّغ عنه، /plan يصل
    النموذج كموجّه الخطة، /goal يجيب دون استدعاء النموذج، session.compress يردّ بالشكل المقروء)

$ web: vitest run tests/slash-commands.test.tsx tests/context-meter.test.tsx tests/outbox.test.ts tests/composer.test.tsx tests/transcript.test.ts
 Test Files  5 passed (5)      Tests  49 passed (49)   (slash-commands لاحقًا 10/10)

$ pnpm build && PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzz-slash-compress.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-slash-compress.spec.ts:24:1 › 32. / opens the commands, /compress shows its progress, and the meter drops (2.8s)
  1 passed (8.9s)
```

CI على طلب الدمج #118 (التشغيل 36087621283):

```
Docker image builds and answers /health                 pass  2m58s
Lint, typecheck, contracts, tests, build                pass  17m50s
PR adds or updates a change record                      pass  12s
PR leaves graphify-out/ to the code-map bot             pass  8s
Web smoke journeys (Playwright against the real hub)    pass  5m18s
db:generate + db:migrate (SQLite and PostgreSQL)        pass  1m32s
```

## المخاطر والرجوع
- الأوامر والضغط والتوجيه تعمل عبر بوابة TUI فقط. Hermes مُتاح عبر الشبكة فقط (بلا `hermes`
  بجانب الخادم) يردّ `409 state_invalid` (`command_unsupported`) بدل أن يتظاهر.
- `/goal` و`/plan` و`/learn` و`/skill` صارت أوامر لـ Hermes: رسالة تبدأ بها بالضبط لم تعد نصًّا
  للنموذج. أي `/كلمة` أخرى كما كانت.
- كتابة `compression.*` في `config.yaml` تلمس هذه المفاتيح فقط وتُبقي الباقي وتعليقاته؛ ملف غير
  صالح لا يُعاد كتابته. القيم المخزنة قبل اليوم في قاعدة الخادم لم تُكتب في Hermes؛ القراءة الآن
  من Hermes، فتظهر قيم Hermes الفعلية.
- عتبة Hermes ترتفع إلى 75٪ للنماذج التي نافذتها أقل من 512K مهما كُتب — مذكور في البطاقة.
- أثناء التشغيل المحلي أوقفتُ خطأً خادمي e2e كانا على المنفذين 8871/8872 لوكيل آخر
  (`corehub-wt-fallback`) ظنًّا أنهما من تشغيلي السابق؛ إن فشل له تشغيل e2e في تلك اللحظة فهذا سببه.
- الرجوع: إرجاع طلب الدمج. لا هجرة قاعدة بيانات؛ `metadata.context` حقل JSON يُتجاهل.

## التسليم والخطوة التالية
- المالك يؤكّد قرارات §57 (خصوصًا: أوامر Hermes كرسائل، و`/skill` داخل الرسالة نفسها، ومكان بطاقة
  الضغط في إعدادات Hermes).
- لاحقًا: عرض تفصيل النافذة حسب الفئة (`session.context_breakdown` في Hermes)، و`/btw` و`/queue`
  إن أرادها المالك، وربط `Session.context` لوكلاء غير Hermes إن أبلغوا عنه.
