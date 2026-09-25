# الوكلاء الفرعيون ولوحة «في الخلفية»
المسؤول: twuijri · الفرع: feat/subagents-background · الحالة: review

## المشكلة والهدف
سأل المالك (٢٠٢٦-٠٩-٢٥): «هل نقدر نسوي عندنا مثل كلود يبين الوكلاء الفرعيين الي يشتغلون» و«تاكد هل
هرمز يدعمها … وبعدين بنقدر نسويها مع كلود وكودكس وغيره». الهدف: (١) لوحة «الوكلاء الفرعيون» في كل
محادثة: ما فوّضه الوكيل، حيًّا، مع إيقاف وتوجيه وعرض حيث يسمح الوكيل؛ (٢) الشيء نفسه للوكلاء
البرمجيين عبر ACP بقدر ما يرسلونه؛ (٣) زر «في الخلفية» في الشريط العلوي يجمع كل ما يعمل للشخص عبر
بروفايلاته (محادثات، مهام، جدولات، سير عمل، أعمال، وكلاء فرعيون) مع «انتهت (n)» لآخر 24 ساعة.

**هل Hermes يدعمها؟ نعم** — قُرئ في مصدره (MIT) داخل الصورة، `/opt/hermes/src/tui_gateway` و
`tools/delegate_tool*.py`: أحداث `subagent.start` / `subagent.tool` / `subagent.complete` (و`thinking` و
`progress` و`spawn_requested` التي لا نعرضها)، واستدعاءات `subagent.list` / `subagent.interrupt` /
`subagent.steer` / `subagent.tail`. وثبت على Hermes حقيقي (أدناه) أن التفويض قد يعمل **بعد** انتهاء
الدور الذي أطلقه.

**الوكلاء عبر ACP** (قُرئت الحزم المثبّتة في الكتالوج، دون نقل): Claude Code (`claude-code-acp` 0.16.2)
يرسل أداة `Task` باسمها في `_meta.claudeCode.toolName` ووسائطها، وأدوات الوكيل الفرعي تصل مسطّحة بلا
معرّف أب ← **observe**. OpenCode يرسل أداة `task` (نوع `think`، و`subagent_type` في وسائطها لاحقًا) ←
**observe**. Gemini CLI يرسل وكلاءه أدوات `think` عادية بلا ما يميّزها ← **none**. Codex
(`codex-acp` 0.16.0): أحداث `spawn_agent` موجودة في Codex نفسه ولم نجد لها نقلًا في الجسر ← **none**.

## القرار والموافقات
موافقة المالك على الفكرة: السؤال نفسه. قرار العقد: **DECISIONS §56** (§47 أخذه #105 و#108 المفتوحان،
و§48 أخذه #106؛ يُعاد الترقيم عند الدمج إن لزم). المواصفة بكلماتنا:
`docs/inspirations/subagents-background.md`.

قرارات منتج جديدة — **مقترحة، والمالك يؤكد**:
- **الوكيل الفرعي يتبع المحادثة لا التشغيل**: Hermes قد يُبقيه يعمل بعد نهاية الدور (ثبت على Hermes
  حقيقي). `run_id` هو التشغيل الذي كان جاريًا حين بدأ فقط.
- **الدعم مُعلن لا مُخمَّن**: `Agent.subagents` = `full` (Hermes) / `observe` (Claude Code، OpenCode) /
  `none` (Gemini CLI، Codex، المباشر). الواجهة تعرض فقط ما يسمح به. لا تُنسب أداة لوكيل فرعي إلا إن
  قال البث ذلك (`ToolCall.subagent_id`)؛ رفضنا تخمين «ما جرى أثناء فتح Task» لأن Task متوازية تُخلط.
- **الحفظ بلا جدول جديد**: آخر 50 وكيلًا فرعيًا في `metadata.subagents` للجلسة (مع آخر 50 أداة لكل
  واحد)، فلا ترحيل يصطدم بترحيل #108. ما كان «يعمل» عند إعادة التشغيل يُقرأ `interrupted`.
- **لوحة «في الخلفية» هي عمل الشخص نفسه** عبر كل بروفايل يدخله: تشغيلاته، وما أطلقته جدولاته،
  وأعماله، ووكلاء محادثاته — لا عمل غيره في بروفايل مشترك. ما يعمل أولًا (الأقدم أولًا)، ثم «انتهت
  خلال آخر 24 ساعة» (الأحدث أولًا، 50 على الأكثر). خطوات سير العمل تظهر كتشغيل سير العمل نفسه.
- **إيقاف واحد لكل الأنواع** (`background.stop`): إيقاف المحادثة، أو إلغاء سير العمل، أو `jobs.cancel`
  للأعمال التي تتوقف فعلًا (تصدير، استيراد، اكتشاف، ربط قناة)، أو إيقاف الوكيل الفرعي. الوكيل الفرعي
  الذي انتهى قبل آخر تشغيل للمركز لا يظهر في «انتهت» هناك (يبقى في محادثته).
- **مكان اللوحة**: فوق المُلحِّن، مطوية إلى سطر، ولا تظهر إلا بعد أول تفويض. «افتح في المسار» يفتح
  تبويب المسار على خطوة الوكيل الفرعي (`?view=trajectory&step=subagent:<id>`) في مسار «الوكلاء الفرعيون».

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عمليات جديدة (sessions): `sessions.listSubagents` (`GET /sessions/{id}/subagents`)،
  `sessions.interruptSubagent`، `sessions.steerSubagent`، `sessions.tailSubagent`.
- عمليات جديدة (jobs): `background.list` (`GET /background`، `profiles=all`)، `background.stop`
  (`POST /background/{item_id}/stop`).
- أحداث جديدة على `/rt/sessions` (على مستوى البروفايل، تحمل `Subagent` كاملًا): `subagent.started`،
  `subagent.updated`، `subagent.completed`.
- مخططات جديدة: `Subagent`, `SubagentTool`, `SubagentStatus`, `SubagentSupport`, `SubagentList`,
  `SubagentSteer`, `SubagentSteerResult`, `SubagentTail`, `BackgroundItem`, `BackgroundKind`,
  `BackgroundStatus`, `BackgroundList`؛ ومعامل `SubagentId`.
- إضافات: `Agent.subagents`؛ `TrajectoryStepKind.subagent`، `TrajectoryLane.subagents`،
  `TrajectoryStep.subagent` (اختياري). `agent.updated` و`common.schema.json` حُدِّثا بالحقل الجديد.
- `events/README.md` (20 حدثًا في `/rt/sessions`)، `DECISIONS.md` §56، `COVERAGE.md` (المحادثة، وصف
  زر «في الخلفية»).

## الملفات والتأثير
الخادم (`packages/server`):
- `agents/adapters/subagents.ts` (جديد): مفردات «التقرير» الواحدة، وقراءة أحداث Hermes وأدوات ACP.
- `agents/adapters/hermes-tui.ts`: أحداث `subagent.*` تذهب لقناة المحادثة لا للدور؛ `list/interrupt/
  steer/tail` باستدعاءات Hermes نفسها باسم الجلسة الحيّة؛ من يعمل عند خروج البوابة يُختم `interrupted`.
- `agents/adapters/acp.ts`: تفويض `Task`/`task` يصير وكيلًا فرعيًا يبدأ وينتهي مع الأداة؛ أداة يقول
  جسرها معرّف أبيها تُنسب إليه.
- `agents/adapters/types.ts`، `agents/runner.ts`، `agents/ports.ts`: `AgentSession.subagents`، وتمرير
  التقارير بمعرّف جلسة المركز، و`subagents(sessionId)`.
- `agents/catalog/*.ts`، `agents/serialize.ts`، `agents/index.ts`: `subagents` لكل وكيل.
- `sessions/subagents.ts` (جديد): «دفتر» الوكلاء الفرعيين — الحالة الحيّة، الحفظ في metadata، الأحداث.
- `sessions/{service,engine,routes,ports,realtime,store,trajectory,index}.ts`، و`sessions/background.ts` (جديد).
- `audit/background.ts` (جديد) + `audit/{index,service}.ts`: `background.list/stop` ومصادر تسجّلها الوحدات.
- `schedules/{index,service}.ts`: تشغيلات سير العمل مصدرًا للوحة. `modules/index.ts`: التركيب.
- `sessions/testing/fake-runner.ts`: خطوات `subagent` وتحكّم `full`/`observe` في المشغّل المكتوب.
- اختبارات: `hermes-tui.test.ts`، `adapters.test.ts`، `sessions/subagents.test.ts`،
  `sessions/subagents-api.test.ts`، `audit/background.test.ts`، `hermes-subagents.real.test.ts` (جديد).

الويب (`packages/web`):
- `chat/SubagentsPanel.tsx` (جديد)، `subagents/{subagents,queries}.ts` (جديدة).
- `shell/BackgroundTasks.tsx` (جديد)، `background/{background,queries}.ts` (جديدة)، `shell/TopBar.tsx`.
- `chat/ChatScreen.tsx` (سطر اللوحة وفتح المسار على خطوة)، `chat/TrajectoryView.tsx`، `chat/trajectory.ts`.
- `realtime/envelope.ts`، `types.ts`، `ui/icons.tsx` (`IconActivity`)، `styles/{chat,screens}.css`،
  `i18n/{ar,en}.json` (`subagents.*`، `background.*`، ومسار ونوع جديدان في `trajectory`).
- `e2e/hub.ts` (سيناريو «وزّع العمل»)، `e2e/zzzzzz-subagents-background.spec.ts` (الرحلة 41) ولقطتاها،
  `tests/subagents-background.test.tsx`.

الوثائق: `docs/inspirations/{subagents-background.md,README.md,ADOPTION-BACKLOG.md}` (2.19)،
`docs/contracts/{DECISIONS.md,COVERAGE.md}`، `docs/STATUS.md` (212 من 270).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، ما يمسّه التغيير فقط (قاعدة السرعة)؛ الحزم الكاملة يشغّلها CI:
```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!
$ pnpm typecheck                     # exit=0 (كل الحزم)
$ pnpm contracts:lint
contracts:lint  validating 93 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 289 client file(s) scanned, 182 contract path(s) known.
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  280 passed (280)
$ pnpm i18n:check
i18n:check  web: 1368 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web

$ (server) vitest run --project unit hermes-tui.test.ts adapters.test.ts sessions/subagents.test.ts \
    sessions/subagents-api.test.ts audit/background.test.ts trajectory.test.ts trajectory-api.test.ts \
    agents.test.ts runner.test.ts tests/unit/status.test.ts
 Test Files  10 passed (10)
      Tests  115 passed (115)
$ (web) vitest run tests/subagents-background.test.tsx tests/trajectory.test.tsx tests/pending-actions.test.tsx \
    tests/topbar-name.test.tsx tests/ui-layer.test.ts tests/logical-css.test.ts tests/i18n.test.ts
 Test Files  7 passed (7)
      Tests  211 passed (211)

$ pnpm build                         # ✓ built in 770ms
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzz-subagents-background.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-subagents-background.spec.ts:27:1 › 41. subagents run, one is stopped, the other finishes, and the Background panel lists the run (3.5s)
  1 passed (9.7s)
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzz-chat-trajectory.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-chat-trajectory.spec.ts:26:1 › 31. the Trajectory tab follows a run, opens a step, filters, and downloads the log (3.7s)

# Hermes حقيقي (الصورة core-hub:channeldeps، نموذج مكتوب على المنفذ المحلي، حاوية --rm أُزيلت بعده):
$ COREHUB_HERMES_IMAGE=core-hub:channeldeps vitest run src/modules/agents/adapters/hermes-subagents.real.test.ts --reporter=verbose
model calls: other … delegate other … parent-done child parent-done
turn: tool.started tool.completed message.delta usage run.completed
subagent signals: [{"phase":"started","id":"sa-0-ed6fba21","depth":0,"goal":"CHILD-GOAL: say the word ready","model":"fake-1","toolCount":0,"acceptingSteer":true},{"phase":"completed","id":"sa-0-ed6fba21","depth":0,"goal":"CHILD-GOAL: say the word ready","model":"fake-1","toolCount":0,"status":"completed","summary":"ready","acceptingSteer":false}]
 ✓ … hears Hermes's delegation start and end on the conversation's own channel 14646ms
```
الاختبارات الجديدة تفشل على الكود القديم: كلها تستورد ما لم يكن موجودًا (`subagents.ts`،
`background.ts`، `SubagentsPanel`، `BackgroundTasks`، `session.subagents`)، والرحلة 41 تبحث عن
`subagents-panel` و`background-tasks` اللذين لم يكونا.

وُجد أثناء الرحلة وأُصلح: استدعاء `socket.connect()` مرتين لمساحة ما زالت تتصل (`/rt/jobs`) يرسل طلب
الاتصال مرتين فيقطع المركز الاتصال كله ويعيده بلا نهاية؛ الخطافان الجديدان يتصلان فقط إن لم يكن المقبس
متصلًا **ولا في طريقه** (`socket.active`).

**CI على #114**: الدفعة الأولى — كل الفحوص خضراء (Playwright كاملًا 5:21 مع الرحلة 41، ترحيل SQLite
وPostgreSQL، صورة Docker، اختبارات الخادم 108 ملفًا) إلا `pnpm test` للويب في `all-profiles.test.tsx`: بديل
الشبكة في ذلك الاختبار يجيب `/sessions/{id}/subagents` بشيء بلا `items`، فانكسر حساب «هل فيها ما يعمل».
الإصلاح: قائمة بلا `items` تُقرأ فارغة (`subagents/queries.ts`). بعده حزمة الويب كاملة محليًا 57/57 ملفًا
(638 اختبارًا)، والدفعة الثانية على CI خضراء كلها: `Lint, typecheck, contracts, tests, build` (17:49)،
`Web smoke journeys` (5:40)، `db:generate + db:migrate`، `Docker image builds and answers /health`،
`PR adds or updates a change record`، `PR leaves graphify-out/ to the code-map bot`.

## المخاطر والرجوع
- **Hermes عبر بوابة TUI فقط**: Hermes الخارجي (بلا بوابة TUI) لا يرسل تقارير، فتبقى اللوحة فارغة.
- **الإيقاف والتوجيه والذيل لم تُجرَّب على Hermes حقيقي** (تحتاج وكيلًا فرعيًا طويلًا مع نموذج مكتوب)؛
  مثبتة أمام بوابة TUI مكتوبة بإطارات Hermes نفسها. البدء والانتهاء مثبتان على Hermes حقيقي.
- **«انتهت» للوكلاء الفرعيين في لوحة الخلفية من ذاكرة العملية**: إعادة تشغيل المركز تُفرغها (تبقى في
  محادثاتها). التشغيلات والأعمال وسير العمل من قاعدة البيانات.
- **الحمل**: كل أداة لوكيل فرعي حدث `subagent.updated` على مستوى البروفايل؛ لوحة الخلفية تعيد القراءة
  مرة في الثانية على الأكثر، وكل 10 ثوانٍ ما دام فيها ما يعمل.
- **تعارض محتمل** مع #107 (شريط فشل التشغيل) و#106 (معاينة الملفات) في `ChatScreen.tsx`: سطر فوق
  المُلحِّن وثابتان للعنوان؛ يُحلّ عند الدمج.
- الرجوع: استرجاع الـ commits. لا ترحيل؛ `metadata.subagents` يُتجاهل إن رجع الكود.

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية للمراجعة. المالك يؤكد القرارات المقترحة أعلاه، ويجرّب تفويضًا حقيقيًا
(«وزّع هذا على وكلاء فرعيين») في بيئة التست: الإيقاف والتوجيه من اللوحة.
