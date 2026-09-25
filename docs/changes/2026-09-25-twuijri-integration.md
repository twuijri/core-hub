# دمج تكامل: طلبات الدمج المفتوحة في 2026-09-25 (#105–#142) في طلب واحد
المسؤول: twuijri · الفرع: integration/2026-09-25 · الحالة: review

## المشكلة والهدف
كانت هناك 38 طلب دمج مفتوحة على `main` (غير بوت خريطة الكود #81)، تتصادم في الملفات المشتركة
(`docs/STATUS.md` و`DECISIONS.md` والـOpenAPI وملفات اللغة و`ChatScreen.tsx`…) وفي الأرقام: عدة
طلبات أخذت أرقام القرارات نفسها (§47–§60) ورقم الترحيل نفسه (`0016`، و`0017` للغرف). دمجها واحدًا
واحدًا يعني حلّ التعارضات 38 مرة. الهدف: فرع تكامل واحد يدمج الكل بترتيب محدد، ويحفظ ميزة كل طلب كما
هي، ويعيد ترقيم القرارات والترحيلات تسلسليًا، فيدمجه المالك مرة واحدة فتُعلَّم كل الطلبات مدموجة.

## القرار والموافقات
- موافقة المالك على الحل: «ايه طبق الحل الاول» (2026-09-25).
- كل طلب دُمج بـ`git merge --no-ff` بالترتيب أدناه، ولم يُعَد تأسيس (rebase) أي فرع ولم يُعدَّل أي فرع
  طلب. رأس كل طلب أصبح سلفًا لفرع التكامل (تحقّقنا لكل الطلبات)، فيعلّمها GitHub مدموجة عند دمج هذا.
- **إعادة الترقيم كـ commit مستقل فوق رأس الطلب**: لكل طلب يحتاج إعادة ترقيم أُنشئ commit محلي
  «Renumber #N for the integration» فوق رأسه (لا يُدفع إلى فرع الطلب)، ثم دُمج هذا الـcommit. فيبقى رأس
  الطلب سلفًا، وتظهر إعادة الترقيم منفصلة قابلة للمراجعة، وتصل الطلبات المكدّسة (#126 فوق #121، و#136
  فوق #126، و#137/#138 فوق #135) بأرقام متطابقة دون تعارض.
- #105 دُمج في `main` (09:33Z) قبل البدء، فبنيتُ على `main` الحالي (`2044c35`، آخر قرار فيه §47)،
  وصار سطره في ترتيب الدمج بلا عمل.
- #141 (طرفية المالك) ثم #142 (مكتبة المهارات المضمّنة) أضافهما المنسّق في آخر الترتيب بعد البدء،
  بموافقة المالك عليهما.
- لم يُمَس فرع `test`، ولم تُنشر صور، ولا دمج تلقائي.

### ترتيب الدمج
#139، (#105 مدموج سلفًا)، #107، #106، #110، #108، #117، #109، #133، #112، #114، #118، #131، #119، #121،
#126، #136، #123، #129، #130، #132، #134، #140، #135، #137، #138، #111، #113، #115، #116، #122، #125،
#127، #120، #124، #128، #141، #142.

### جدول إعادة ترقيم القرارات (`docs/contracts/DECISIONS.md`)
`main` ينتهي عند §47 (#105). رُقّمت قرارات الطلبات بترتيب الدمج، وحُدّثت كل الإشارات في ملفات الطلب
نفسه (سجل التغيير، STATUS، أوصاف OpenAPI، التعليقات، الاختبارات، `navigation.json`).

| الطلب | الرقم في الطلب | الرقم النهائي |
|---|---|---|
| #106 ملفات المحادثة | §48 | §48 |
| #110 تغييرات الملفات لكل تشغيل | §49 | §49 |
| #108 الاستخدام وتحليلاته | §47 | §50 |
| #117 السجلات والأداء الحيّان | §51 | §51 |
| #109 محرر سير العمل | §48 | §52 |
| #133 حدود سير العمل والجداول الشائعة | §57 | §53 |
| #112 سلسلة البدائل | §49 | §54 |
| #112 الدخول بكود الجهاز | §50 | §55 |
| #114 الوكلاء الفرعيون ولوحة الخلفية | §49 | §56 |
| #118 أوامر `/` والضغط | §52 | §57 |
| #131 إعدادات Hermes | §56 | §58 |
| #119 أحداث الويبهوك | §53 | §59 |
| #121 (ومعه #126 و#136) فئات الجلسات | §54 | §60 |
| #126 (ومعه #136) محادثات القنوات | §55 | §61 |
| #136 «المتابعة في كور هب» | §58 | §62 |
| #123 الصوت | §55 | §63 |
| #129 منصات مراسلة أكثر | §56 | §64 |
| #130 ملفات البروفايل | §56 | §65 |
| #132 الأجهزة والإشعارات | §56 | §66 |
| #134 أدوات كور هب عبر MCP | §58 | §67 |
| #140 كتالوج الوكلاء والتحديث | §59 | §68 |
| #135 (ومعه #137 و#138) الغرف | §57 | §69 |
| #141 طرفية المالك | §60 | §70 |
| #142 مكتبة المهارات المضمّنة | §60 | §71 |

النتيجة: `DECISIONS.md` من §1 إلى §71 بلا فجوة ولا تكرار (عدا ترتيب §27/§26 الموجود في `main` قبلنا).
ملاحظات تاريخية داخل سجلات الطلبات مثل «§47–§51 مأخوذة في طلبات مفتوحة» تُركت كما هي لأنها تصف وقت
كتابتها.

### جدول إعادة ترقيم ترحيلات قاعدة البيانات (`packages/server/drizzle`)
`main` ينتهي عند `0015_run_timing`.

| الطلب | في الطلب | النهائي |
|---|---|---|
| #110 | `0016_run_file_changes` | `0016_run_file_changes` |
| #108 | `0016_usage_analytics` | `0017_usage_analytics` |
| #121 (و#126 و#136) | `0016_session_categories` | `0018_session_categories` |
| #134 | `0016_hub_tools` | `0019_hub_tools` |
| #135 (و#137 و#138) | `0017_rooms` | `0020_rooms` |

- نصّ SQL لكل ترحيل **بايتًا ببايت** كما في طلبه (بما فيها خطوة البيانات اليدوية في `0017_usage_analytics`
  التي تُدخل عدّاد `skill_uses`؛ ولذلك بقيت تعليقات SQL تذكر أرقام القرارات القديمة §47/§57).
- `meta/0017…0020_snapshot.json` أعاد drizzle-kit توليدها من المخطط المدمج عند كل دمج (بإزالة لقطة
  الطلب ثم `drizzle-kit generate --name`، ثم إعادة SQL الطلب نفسه)، فسلسلة `prevId` صحيحة وكل لقطة
  تطابق المخطط بعد ترحيلها. الفرق الوحيد بين SQL المولَّد وSQL الطلبات كان خطوة البيانات اليدوية.
- `_journal.json` أُعيد بناؤه بالترتيب؛ قيم `when` للإدخالات 0017–0020 جديدة ومتزايدة (القديمة لم تكن
  متزايدة بترتيب الدمج: `usage_analytics` < `run_file_changes` و`rooms` < `hub_tools`، وميغريتور SQLite
  في drizzle يتخطى ترحيلًا `when` أقدم من آخر مطبَّق).
- بعد كل الدمج `drizzle-kit generate` يقول «No schema changes».

### ADR
لا تكرار: `main` ينتهي عند 0019 (0017 هو ADR اسم كور هب، مدموج سلفًا)، والتطبيق المكتبي أضاف
0020–0023 بلا تصادم. لم يُعَد ترقيم أي ADR.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
اتحاد عقود الطلبات دون إضافة من عندي:
- `openapi.yaml`: دُمج بمستوى الكتل (كل مسار تحت `paths` وكل عنصر تحت كل قسم من `components` كتلة)،
  فكل عملية ومخطط من الطرفين حاضر. العدد النهائي 315 عملية؛ `redocly lint` ناجح.
- أحداث `events/`: `common.schema.json` بالاتحاد، و`events/README.md` صار «`/rt/sessions` — 21 events»
  (20 من طرف + حدث `context.compression` من #118؛ عدد ملفات المجلد 21).
- `scripts/generate-native.mjs`: الطرفان — Kotlin يقرأ `openapi.kotlin.yaml` المُعدّ (#122) وSwift يقرأ
  `openapi.swift.yaml` المُعدّ (#120).
- العملاء المولّدون غير محفوظين في المستودع؛ يولَّدون في `typecheck`/`build` (TS) وفي CI (Kotlin/Swift).

## الملفات والتأثير
### التعارضات وكيف حُلّت (بترتيب الدمج)
- **#107**: فقرة الويب في STATUS — الفقرتان معًا.
- **#106**: `ChatScreen.tsx` — #106 لفّ الشاشة بـ`SessionFilesProvider` (إعادة مسافات)، فطُبّق تغيير #107
  (الفشل تحت دوره `noticeFor`) على نسخة #106 مع تجاهل المسافات.
- **#110**: `MessageView.tsx` — خاصيتا `notice` (#107) و`changes` (#110) معًا.
- **#108**: عدّ العمليات في STATUS (حسابيًا: ours + theirs − base)، الترحيل (أعلاه).
- **#117**: `audit/index.ts` و`modules/index.ts` (منافذ التحليلات #108 ومنافذ الحيّ #117 معًا)،
  `SettingsScreen.tsx` (صفحتا الاستخدام من #108 + السجلات/الأداء الحيّة من #117)، `COVERAGE.md`
  (صفّا 11/13 من #117 و12/14 من #108)، `NAVIGATION.md`، OpenAPI.
- **#133**: `workflow-engine.ts` — نموذج الخطوة الخاص (#109) مع حدود التشغيل `control` (#133)؛ خطوة
  أوقفها حدّ تكون `cancelled` ومسارها `null`. `SchedulesScreen.tsx` — #109 وضع الصفحة داخل تبويبات
  (إعادة مسافات)، فطُبّق تغيير #133 (قائمة الجداول الشائعة والأوقات التالية) بتجاهل المسافات. فقرة
  STATUS: حُذفت جملة «محرر #109 غير مدموج» لأنه صار مدموجًا.
- **#112**: `ChatScreen.tsx` (`useRunHistory`)، `MessageView.tsx` (`FallbackNote` + `notice`)،
  `e2e/hub.ts` (خطوات `write` و`direct` معًا).
- **#114**: `acp.ts`، `hermes-tui.ts`، اختبارات المحوّلات (كتل `describe` الطرفين)، `sessions/service.ts`
  (`SubagentBook` + `hostEnv`)، `routes.ts` (مسارات الملفات والتغييرات + الوكلاء الفرعيين)،
  `trajectory.ts`، OpenAPI (`TrajectoryStep`)، `chat.css`/`screens.css` (إضافات الطرفين في آخر الملف).
- **#118**: `hermes-tui.ts` — حالتا `status.update` (ملاحظة البديل #112 والضغط #118) صارتا **حالة واحدة**
  (التكرار كان سيُسكت الضغط)؛ `runner.ts` — #118 نقل فتح الجلسة إلى `open()`، فنُقل إليه منطق #114
  (مراقبة الوكلاء الفرعيين و`unwatch`)؛ `sessions/ports.ts` — `compress`/`steer` داخل `AgentRunner`؛
  `realtime.ts` (`context.compression` + أحداث الوكلاء الفرعيين).
- **#121/#126/#136**: `sessions/service.ts` (الفئات + الوكلاء الفرعيون)، صفّ `sessions` في STATUS.
- **#123**: `models/index.ts` — صار `models.transcribe` (#123) وعمليات الدخول بكود الجهاز (#112) كلها
  منفّذة، فحُذفت كتلة «الفجوات» الفارغة؛ في `models-api.test.ts` حُذف اختبارا «501» كلاهما.
  `Composer.tsx` (أوامر `/` + الميكروفون)، `ChatScreen.tsx` (غلاف `VoiceProvider`).
- **#129**: استيرادات `agents/index.ts` (`channel-settings` بدل إعدادات تيليجرام + إعدادات Hermes).
- **#130**: `SettingsScreen.tsx`، اختبار تصميم الإعدادات (عدد الأدوات 9)، ترتيب `navigation.json`،
  `pnpm-lock.yaml` (أعيد توليده).
- **#132**: `config.ts` واختباره (متغيّرات الدفع + `COREHUB_TASK_AUTO_START_MAX`)، `notify/index.ts`.
- **#134**: `adapters.test.ts`، `agents/index.ts`، فقرة «لا شيء يبدأ تشغيلًا إلا…» في STATUS.
- **#140**: `runner.ts` (`readyRow` + `agentId` في الجلسة الحيّة داخل `open()`)، `agents/index.ts`
  (مدقّق التحديث + أدوات كور هب)، 4 لقطات شاشة (نسخة #140).
- **#135/#137/#138**: `modules/index.ts` (منافذ الغرف + التحليلات)، `sessions/realtime.ts`
  (`publish` للويبهوك + `tell` للغرف)، `SessionList.tsx`، `types.ts`، مشغّل المهام (`workingDir` من
  #105 + تقرير الغرفة من #138)، صفّ `tasks` في STATUS.
- **#111–#116**: ملفات اللغة، `SettingsScreen.tsx` (`this_device`)، `DeviceConnectionsScreen.tsx`.
- **#122/#125/#127 و#120/#124/#128**: فقرات Android/iOS في STATUS؛ `generate-native.mjs`.
- **#141**: `config.ts`، ملفات اللغة، `socket.ts`، `SettingsScreen.tsx`، `navigation.json`،
  `NAVIGATION.md`، `image-sealed-check.mjs`، `pnpm-lock.yaml` (أعيد توليده).
- **#142**: `agents/index.ts` (زرع مكتبة المهارات في `onReady` مع مزامنة أدوات كور هب ومدقّق التحديث)،
  `modules/index.ts`، لقطة صفحة المهارات (نسخة #142).
- ملفات اللغة (JSON) بدمج ثلاثي حسب المفاتيح؛ STATUS: صفوف الوحدات بعدّ حسابي ودمج نصي على مستوى
  الكلمات، والفقرات يدويًا؛ لقطات `e2e/shots` من الطلب الأحدث.

### إصلاحات أوجبها الجمع (commits مستقلة إلا حيث ذُكر)
1. `SettingsScreen.tsx`: حذف استيراد `AuditReport` الذي صار غير مستعمل بعد #108 و#117.
2. **تصادم مفاتيح اللغة**: #106 و#130 استعملا كلاهما مساحة المفاتيح `files` في لغات الويب بمفاتيح
   متداخلة ونصوص مختلفة، فأسقط الدمج مفاتيح #106. نُقلت مفاتيح #130 إلى `workspace_files` (في
   `workspace-files/*.tsx`)، وعادت مفاتيح #106 كما هي.
3. **Android وiOS**: #108 و#130 أضافا وجهتين (`skills_usage`، `files`) ولم يعرفهما التطبيقان. أُضيف
   مساراهما في `surfaceRoutes.android/ios`، وفي قوائم Android (`Screens`) وiOS (`DestinationID`،
   `NavigationMap`، المسارات، الأيقونات، ومفاتيح `nav.*`)؛ تُفتح على الويب في Android وصفحة البديل العامة
   (`PlaceholderScreen`) في iOS. وفي اختبار تكافؤ Android صُفّيت `settingsTools` بوجهات Android كما تُصفّى
   `settingsTabs`، لأن `terminal` (#141) للويب وحده.
4. داخل commit دمج #140: `subagents: 'none'` لكتالوجات Qwen Code وKimi Code وPi (حقل صار إلزاميًا
   مع #114، ولم يُتحقق أن بثّها يعلّم التفويض)، و`unwatch()` عند إغلاق جلسة عند التحديث (منطق #140)
   حتى لا تبقى تقارير الوكلاء الفرعيين لجلسة مغلقة.
5. اختبارات: بدائل `service` في `update-policy.test.ts` (#140) و`hub-tools.test.ts` (#134) تحتاج
   `providerSlugOf`/`fallbacksFor` التي يستدعيها المشغّل منذ #112؛ و`hermes-settings.test.ts` (#131)
   يتوقع الآن `NO_PROXY="…"` مقتبسًا لأن كاتب `.env` في #129 يقتبس القيم ذات المسافات عمدًا.
6. prettier على أربعة ملفات تركها الدمج بلا تنسيق.
8. لقطات drizzle: دمجا #126 و#137 (المكدّسان) حذفا لقطة سابقة (`0016_snapshot` ثم `0017_snapshot`) لأن
   commit إعادة الترقيم في الطلب «أعاد تسمية» لقطته؛ أُعيدتا في الدمج التالي/نفسه، وفحص يتحقق من سلسلة
   اللقطات والدفتر بعد كل دمج.
9. **تسريب ذاكرة ظهر مع الجمع**: كل هب يُبنى كان يسجّل مزوّد إحصاءات البروفايل (`registerWorkspaceStatsProvider`
   في `agents`) في مصفوفة على مستوى الوحدة ولا يُزال عند الإغلاق، فيبقى كل تطبيق مغلق حيًّا بمساراته
   ومخططاته (موجود في `main`: نحو 40 م.ب لكل هب؛ ومع مسارات الطلبات كلها نحو 65 م.ب). ملف
   `models-api.test.ts` يبني نحو 39 هبًا فنفدت ذاكرة الـheap في عامل vitest. الإصلاح: التسجيل يعيد دالة
   إلغاء، و`agents` يستدعيها في `onClose`؛ بعده يبقى الـheap ثابتًا (~140–200 م.ب بعد 6 هبات) — قيس بلقطات
   heap وبحث تنصيف (bisect) بين الدمجات: ظهر الانفجار عند دمج #130 (مسارات أكثر) لا بسببه.
10. **ترتيب الوكلاء الفرعيين** (#114): وكيلان أُبلغ عنهما في الملّي‌ثانية نفسها كان ترتيبهما في المسار يتبع
   ترتيب الانتهاء (القائمة ترتّب المنتهين بوقت الانتهاء)، ففشل اختبار #114 مرتين في التشغيل الكامل. صار
   `startedAt` لوكيل جديد أكبر بواحد على الأقل من آخر وكيل في المحادثة، فيبقى ترتيب الإبلاغ.
7. نصوص STATUS قديمة بعد الجمع: «الأجهزة 501» في Android/iOS الجزء 3 صارت «التطبيق لا يسجّل FCM/APNs
   بعد؛ مرسل الهب جاء مع وحدة الأجهزة».
- لم أغيّر سلوك أي ميزة؛ الإضافة الوحيدة بقرار مني هي `subagents: 'none'` للكتالوجات الثلاثة (مقترح —
  ينتظر تأكيد المالك)، ومسار خطوة سير عمل أوقفها حدّ = `null`.

### إصلاحات CI بعد الدفع الأول (دفعة واحدة)
أول تشغيل لـCI على الطلب فشل في ثلاث وظائف؛ كلها من الجمع لا من طلب بعينه:
11. **الوظيفة الرئيسية ألغيت عند 35 دقيقة** أثناء `pnpm test`: اختبارات الخادم وحدها تجاوزت 32 دقيقة
   (139 من 198 ملفًا)، واختباران تجاوزا مهلة 30 ث تحت الحمل. السبب المقيس: كل هب اختبار يحلّل
   `openapi.yaml` (نحو 24 ألف سطر بعد الجمع) خمس مرات عند الإقلاع (الخادم و`audit` و`notify` و`updates`)،
   فصار إقلاع الهب ~2.9 ث منها ~1.9 ث تحليل YAML (ملف تعريف CPU). الإصلاح في
   `packages/contracts/src/document.ts`: `loadOpenApiDocument` يحلّل الملف مرة ما دام لم يتغيّر
   (المسار + `mtime` + الحجم) ويعيد لكل مستدعٍ نسخة مستقلة (`structuredClone`)، فلا يتغيّر سلوك أي مستدعٍ.
   إقلاع الهب صار ~0.6 ث. وفي `ci.yml`: اختبارات وحدة الخادم انتقلت إلى وظيفة `server-tests` بثلاث
   شرائح (`vitest --shard=N/3`)، والوظيفة الأصلية صار اسمها «Lint, typecheck, contracts, client tests,
   build» ومهلتها 60 دقيقة وتشغّل اختبارات كل الحزم عدا الخادم، والفحص الإلزامي «Lint, typecheck,
   contracts, tests, build» صار وظيفة `gate` تحتاج الاثنتين وتعمل دائمًا (`if: always()`) وتفشل ما لم
   تنجحا معًا، فلا يتحوّل فشلٌ إلى «تخطٍّ» يُحسب نجاحًا. مهلة Playwright (7.5 من 35 دقيقة) بقيت.
12. **Android** (`client:compileKotlin`): `PendingWriteApplied.applied` (`type: boolean, const: true`) صار
   `enum class Applied(val value: Boolean) { TRUE("true") }` فلا يُترجم. وبعده ظهرت في الاختبارات ثلاثة
   أخطاء: (أ) `LivePerformance.host.memory_total_bytes: 16777216000` لا يسعه `Int` في Kotlin؛ (ب) مثال
   `Agent` في `ChatsListTest` ينقصه `pinned_version` و`newer_than_tested` و`subagents` الإلزامية الجديدة؛
   (ج) `logs` صارت `roles: ["admin"]` في `navigation.json` ولم يعرف `Screens.adminOnly` ذلك.
   الإصلاح في `scripts/kotlin-openapi.mjs` (نسخة Kotlin من العقد فقط، والمصدر لا يتغيّر): `plainBooleans`
   يُسقط تثبيت القيمة عن كل `boolean` فيبقى `Boolean`؛ `wideByteCounts` يجعل كل `integer` باسم `*_bytes`
   `int64` (`Long`)؛ `dropWebhooks` (انظر 13). وأُكمل مثال الاختبار، وأُضيفت `logs` إلى `adminOnly`.
13. **iOS** («Generate the Swift client»): `Tokens.swift` قديم (أدوار `chart-1..6` الجديدة في
   `tokens.json`) — أعيد توليده. ولأن محاكي iOS لم يعمل قط على الجمع، راجعتُ ما سيبنيه: (أ) نفس الثابت
   المنطقي صار `enum Applied: Bool` — لا يُترجم في Swift، ويعالجه `plainBooleans` نفسه؛ (ب) قسم `webhooks`
   في العقد (`webhook.hubEvent` بوسم `notify`) ولّد `NotifyAPI` حلّ محلّ الملف الذي فيه عمليات
   `notify.*` كلها («Duplicate file path» في سجل المولّد)، فيسقط استدعاء `NotifyAPI.notifyListWebhooks`
   وغيره في Android وiOS. `dropWebhooks` يُسقط `webhooks` من نسختي Kotlin وSwift (العميل لا يستدعيها؛
   نماذجها تبقى في `components`)؛ (ج) `logs` لغير المشرف كما في Android؛ (د) اختبار iOS يطابق كل
   `terms` بمفاتيح `nav.*`، و`terminal` (#141) لم يكن فيها — أُضيف بالعربية والإنجليزية بنص البيان.
   وقارنتُ عميل Swift المولّد بعميل آخر فرع iOS نجح في CI (`feat/ios-app-phone`): لا دالة ولا نموذج
   حُذف، وكل معامل أو حقل جديد في ما يستعمله التطبيق اختياري، ولا حالة enum جديدة في `switch` شامل.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها محليًا على رأس الفرع بعد دمج الطلبات الـ38 وكل الإصلاحات، عبر `mj-run` (سقف 10 ج.ب)، واحدًا
واحدًا؛ الاختبارات بـ`VITEST_MAX_WORKERS=3` (بستة عمّال تجاوز خادم الاختبار السقف)، وPlaywright بعامل واحد.

```
$ pnpm lint                      → eslint . && prettier --check . : All matched files use Prettier code style!  (rc=0)
$ pnpm typecheck                 → rc=0
$ pnpm contracts:lint            → openapi.yaml: validated … Your API description is valid.
                                   contracts:lint  validating 96 event schema file(s)
                                   contracts:lint  OK
$ pnpm contracts:check-clients   → check-clients  OK — 570 client file(s) scanned, 222 contract path(s) known.
$ pnpm contract:test             → Test Files  19 passed (19)
                                        Tests  364 passed (364)
$ pnpm i18n:check                → server 181 · cli 252 · web ar/en · desktop 80 · ios 279 keys — i18n:check  OK
$ pnpm nav:check                 → nav:check  OK — 37 destinations, 2 pre-auth screens (login, setup), 42 terms,
                                   ar/en complete, routes for web, ios, android, desktop
$ pnpm change-record:check       → (يُشغَّل بعد كتابة هذا القسم؛ نتيجته في وصف الطلب وفي CI)
$ pnpm test                      → cli/ui-tokens/contracts: 7+1+12 files passed
                                   server: Test Files 156 passed | 23 skipped (179) · Tests 1601 passed | 63 skipped
                                   (web وما بعده في تشغيل ثانٍ بعد إصلاح اختبار سطح سطح المكتب:)
                                   web: Test Files 85 passed (85) · Tests 993 passed (993)
                                   desktop: Test Files 8 passed (8) · Tests 94 passed (94)
$ pnpm build                     → rc=0 … desktop build: apps/desktop/dist/hub ready
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e --workers=1
                                 → 70 passed (4.4m)   (لقطات e2e المتغيّرة أُعيدت، لم تُضَف)
$ drizzle-kit generate           → No schema changes, nothing to migrate
عدّ العمليات من هب مُقلَع (منطق status.test.ts): COUNT 295 of 315  = السطر في STATUS
الترحيل على SQLite جديدة:        applied: 21 … fk check: []
ترقية قاعدة طُبّقت عليها ترحيلات main (0000–0015، 16 إدخالًا) → applied: 21, tables 69,
                                   skill_uses / session_categories / hub_tool_calls / room_handoff_chains موجودة, fk check: []
```
- Postgres: `db:migrate` مع `DATABASE_URL` لا يطبّق شيئًا (لا مجلد `drizzle/pg` في `main` ولا في أي طلب)
  ويقول ذلك؛ وظيفة CI «db:generate + db:migrate (SQLite and PostgreSQL)» تتحقق منه.
- Android وiOS (الدفعة الأولى): لم يُبنيا محليًا؛ مسارات `android.yml` و`ios.yml` تتغيّر في هذا الطلب
  (`apps/android/**`، `apps/ios/**`، `docs/clients/navigation.json`) فتعمل على الطلب؛ نتيجتها في CI.
- نتيجة CI على الطلب: تُضاف بعد انتهائها.

فحوص إصلاحات CI (11–13)، محليًا عبر `mj-run`، JDK 17 من `~/.local/opt/jdk17` وAndroid SDK محلي:
```
$ pnpm --filter @corehub/contracts generate:native   → contracts:generate:native  OK   (لا «Duplicate file path»)
  NotifyAPI.swift: 28 دالة notify* · Kotlin: 0 enum class بقيمة Boolean · LivePerformanceHost.memoryTotalBytes: kotlin.Long
$ node apps/ios/scripts/generate-swift.mjs --check  → generate-swift  OK — every generated file matches its source
$ (apps/android) ./gradlew --no-daemon --max-workers=2 assembleDebug test lint
                                     → BUILD SUCCESSFUL in 38s · unit tests 66, skipped 2, failures 0, errors 0
  (قبل الإصلاح: ContractExamplesTest وNavigationParityTest وChatsListTest فشلت)
إقلاع هب اختبار (testHub): قبل 2950 / 2916 / 2779 ms — بعد 1014 / 648 / 624 / 601 ms
$ vitest run --project unit devices-push models-api agents setup-window
                                     → Test Files  4 passed (4) · Tests 84 passed | 1 skipped (85) · 31.98s
  (في CI قبلها: devices-push 132 ث، models-api 397 ث، agents وsetup-window تجاوزا 30 ث)
$ pnpm --filter @corehub/contracts test → Test Files 7 passed (7) · Tests 38 passed (38)
$ pnpm lint                          → All matched files use Prettier code style! (exit 0)
$ pnpm typecheck                     → exit 0
$ pnpm i18n:check                    → i18n:check  ios: 280 keys, ar/en in parity · OK
$ pnpm nav:check                     → nav:check  OK — 37 destinations … routes for web, ios, android, desktop
$ pnpm contracts:lint                → contracts:lint  OK
$ pnpm contracts:check-clients       → check-clients  OK — 570 client file(s) scanned, 222 contract path(s) known.
```
- iOS لا يُبنى محليًا (لا Xcode)؛ محاكاة اختبارات التكافؤ في iOS (الوجهات، `adminOnly`، القوائم، المسارات،
  مفاتيح `nav.*`) بسكربت Python على المصادر لم تجد فرقًا بعد الإصلاح. النتيجة الفعلية في CI.

## المخاطر والرجوع
- إصلاحا 9 و10 يمسّان كود `main`/#114 لا كود الجمع وحده؛ كلاهما صغير ومحدد (انظر أعلاه).
- قاعدة المالك التجريبية: تحقّقتُ بقاعدة SQLite طُبّقت عليها ترحيلات `main` (0000–0015) ثم ترحيلات
  التكامل: طُبّقت 0016–0020 بالترتيب بلا خطأ ولا مخالفة مفاتيح أجنبية. لو كانت القاعدة التجريبية طبّقت
  ترحيلًا من فرع طلب (مثل `0016_usage_analytics` من بناء تجريبي) فسيعاد تطبيقه برقمه الجديد ويفشل؛
  لم يُبنَ شيء من هذه الطلبات على `test` حسب علمي.
- Android وiOS يُبنيان في CI فقط؛ عملاؤهما المولّدون من العقد المدمج قد يكشفون ما لا يظهر محليًا.
- الرجوع: `git revert -m 1` لدمج هذا الطلب يعيد `main` كما كان؛ فروع الطلبات لم تتغيّر.

## التسليم والخطوة التالية
- PR واحد إلى `main` بعنوان «Integration: merge the open PRs of 2026-09-25 (#105–#140)» (العنوان كما حدده
  المالك، ويضم أيضًا #141 و#142)؛ المالك يراجع
  ويدمج. دمجه يعلّم كل الطلبات المضمّنة مدموجة.
- بعد الدمج: إغلاق أي طلب لم يُعلَّم تلقائيًا (لا يُتوقع)، وبناء صورة `test` إن طلب المالك.
