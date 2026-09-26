# الإعدادات المحفوظة (Presets) والمراكز المرتبطة (ربط كور هب بكور هب آخر)
المسؤول: twuijri · الفرع: feat/presets-peers · الحالة: review

## المشكلة والهدف
بقيت في العقد تسع عمليات `501`: أربع للإعدادات المسبقة (`agents.listPresets`، `getPreset`، `deletePreset`،
`activatePreset`) وخمس لربط مركز بمركز (`devices.listPeers`، `requestPeer`، `updatePeer`، `deletePeer`،
`createPeerInvite`). أجّلها المالك في ٢٠٢٦-٠٩-٢٥ (§80): «خلها بعدين اخاف تفتحلنا ثغرات»، ثم رفع التأجيل في
٢٠٢٦-٠٩-٢٦: «كل اللي قلت لك خلها بعدين لا سوها ما عندي مشكلة». الهدف: بناؤهما والأمان أولًا، بمعنى عام مفيد
للإعدادات المسبقة (كانت لوكيل `dsh` غير موجود في الكتالوج)، ونسخة أولى صغيرة وآمنة للربط مع نموذج تهديد مكتوب.

## القرار والموافقات
كل ما يلي **مقترح — للمالك أن يؤكد** ما لم يسمّه المالك نفسه:

- **الإعدادات المحفوظة (§100):** حزمة باسم لإعدادات وكيل واحد في بروفايل واحد: نموذج المحادثة وسلسلة
  بدائله (أو «يرث» حين يرث البروفايل)، ونموذج الوكيل نفسه، والمهارات وخوادم MCP مفعّلة أو لا، وأقسام الإعدادات.
  **لا سرّ فيها أبدًا**: المزوّد بمعرّفه، والخادم باسمه دون إعداده، ويُحذف أي حقل نوعه `secret` وأي نص فيه
  مستخدم وكلمة مرور (مثل `http://user:pass@proxy`). الحفظ والتفعيل **عبر العمليات الموجودة نفسها وبصلاحيات
  المستدعي** (`models.setDefaults`، `agents.update`، `agents.updateSkill`، `agents.updateMcpServer`،
  `agents.updateSettings`)، فكل تحقق وحدث وإعادة تشغيل تحدث كما من الصفحات، ويُكتب فقط ما اختلف، وما اختفى منذ
  الحفظ يُذكر في `skipped` ويُطبَّق الباقي. القراءة لمن يقرأ الإعدادات، والكتابة للمالك والمشرف. عملية جديدة:
  `agents.createPreset`. الواجهة: بطاقة «الإعدادات المحفوظة» في صفحة إعدادات الوكيل.
- **المراكز المرتبطة (ADR 0026، §101):**
  - **الإقران بموافقة المالكين:** دعوة لمرة واحدة ١٠ دقائق (يُحفظ هاش الرمز فقط، ٥ دعوات مفتوحة كحد)، يحمل
    رابطها بصمة مفتاح المركز الداعي؛ المركز الآخر يرسل اسمه وعنوانه HTTPS ومفتاحه Ed25519 موقَّعًا بالمفتاح
    نفسه، ويرفض إن لم يطابق مفتاح الداعي البصمة؛ ثم يوافق مالك الداعي. الرفض = الحذف.
  - **كل نداء لاحق موقَّع** Ed25519 على الطريقة والمسار والوقت والـnonce وهاش الجسم ومعرّف المستلم؛ نافذة ٥
    دقائق، وnonce مخزّن في القاعدة (لا يُعاد بعد إعادة التشغيل)، والتوقيع يُفحص قبل تخزين الـnonce.
  - **HTTPS إلزامي** للدعوة ولعنوان الطرف، ولا تُتبع التحويلات. العناوين الخاصة (الشبكة المنزلية، Tailscale)
    مسموحة لأن المالك يوافق على كل ربط.
  - **ما يتيحه الربط في النسخة الأولى فقط:** قائمة الوكلاء المشارَكين (اسم ووصف، ومعرّف المشاركة لا معرّف
    الوكيل)، وسؤال واحد لوكيل مشارَك يجيبه «ضيف الطرف» عبر مسار الوكيل الخالي من الأدوات (`runner.ask`) على
    نموذج الوكيل في بروفايله: **بلا أدوات ولا ملفات ولا ذاكرة ولا محادثة**، خلال ١٢٠ ثانية و٢٠٠٠ رمز. ضيف الطرف
    ليس مستخدمًا ولا يملك رمزًا. لا شيء غير ذلك: لا ملفات ولا ذاكرة ولا مهام ولا مزوّدين ولا مفاتيح.
  - **التحكم:** تشغيل وإيقاف لكل طرف (يوقف الاتجاهين)، اسم، وحد الأسئلة في الساعة (افتراضي ٣٠)؛ مشاركة لكل وكيل
    في كل بروفايل **مطفأة افتراضيًا** وتسري على كل الأطراف المفعّلة (لا قوائم لكل طرف في هذه النسخة)؛ حدود ثابتة
    ٦٠ نداءً في الدقيقة لكل طرف و١٠ محاولات دعوة في الدقيقة لكل عنوان و٥٠ طرفًا؛ الحذف يُسقط المفتاح فورًا ثم
    يُبلَّغ الطرف الآخر.
  - **سجل تدقيق في الطرفين** (`peer_events`): الإقران والموافقة والتغيير والفصل وكل قائمة وسؤال داخل وخارج وكل
    نداء مرفوض بسببه؛ لا يُحفظ نص السؤال؛ يبقى بعد حذف الطرف.
  - **للمالك والمشرف فقط في الطرفين، بما فيه السؤال** (سؤال الأعضاء لاحقًا إن أراد المالك).
  - الواجهة: الإعدادات ← «المراكز المرتبطة» (الويب وسطح المكتب).
- لم تُلمس الهواتف (الوجهة `surfaces: web, desktop`).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- الإعدادات المحفوظة: `AgentPreset` بشكل جديد (`content` منظّم: `AgentPresetContent`)، و`AgentPresetWrite`،
  و`AgentPresetActivation`، و`AgentPresetPart`؛ عملية جديدة `agents.createPreset`؛ `activatePreset` تجيب
  `AgentPresetActivation`؛ حُذف `authorable` و`trust`/`is_default`/`broken`. كانت `501` ولا عميل يستخدمها.
- المراكز: `Peer` بشكل جديد، و`PeerPatch`، و`PeerInvite`، و`PeerEvent`، و`PeerShare`، و`PeerShareWrite`،
  و`PeerAgent`، و`PeerAsk`، و`PeerAnswer`، و`PeerJoin`، و`PeerJoined`؛ `requestPeer` صار `201 Peer` متزامنًا؛
  عمليات جديدة `devices.listPeerEvents`، `listPeerAgents`، `askPeerAgent`، `listPeerShares`، `setPeerShare`،
  والعمليات بين المراكز (`security: []`، موقّعة): `devices.peerJoin`، `peerNotice`، `peerAgents`، `peerAsk`.
- `events/common.schema.json`: تحديث `AgentPreset` و`AgentPresetContent` و`Peer`.
- المجموع: ٣٤٧ عملية، كلها مبنية (لا `501` باقية على هذا الفرع).

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml`، `packages/contracts/events/common.schema.json`.
- المركز: `packages/server/src/modules/agents/presets.ts` (+ اختبار)، `agents/schema.ts` (`agent_presets`)،
  `agents/index.ts` (تسجيل المسارات)، `agents/ports.ts` و`agents/runner.ts` (`maxTokens` اختياري لـ`ask`)؛
  `devices/peers.ts` و`devices/peer-crypto.ts` (+ اختبار بمركزين في العملية نفسها)، `devices/schema.ts`
  (`peer_identity`، `peers`، `peer_invites`، `peer_nonces`، `peer_shares`، `peer_events`)، `devices/index.ts`؛
  `modules/index.ts` (منافذ قائمة الوكلاء والسؤال الخالي من الأدوات)؛ الهجرة `drizzle/0031_presets_peers.sql`.
- الويب: `src/agents/PresetsCard.tsx`، `src/agents/AgentSettingsScreen.tsx` (سطر البطاقة)،
  `src/screens/LinkedHubsScreen.tsx`، `src/devices/peers.ts`، `src/navigation/routes.tsx`، `src/ui/icons.tsx`
  (`linked_hubs: network`) و`src/ui/lucide.generated.ts`، `src/i18n/{ar,en}.json`؛ اختبارات
  `tests/presets-card.test.tsx` و`tests/linked-hubs.test.tsx`.
- التوثيق: `docs/adr/0026-linked-hubs.md`، `docs/contracts/DECISIONS.md` (§100، §101، وملاحظة في §80)،
  `docs/STATUS.md`، `docs/contracts/COVERAGE.md`، `docs/clients/navigation.json` و`NAVIGATION.md`،
  `docs/domain/agents.md` و`devices.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run`، ما مسّه التغيير فقط (القواعد: الحزم الكاملة على CI):

```
$ pnpm contracts:lint
openapi.yaml: validated … You have 1 warning.   (التحذير نفسه موجود على الفرع الأساسي: مثال `program` في 7085)
contracts:lint  OK

$ pnpm --filter @corehub/contracts test
      Tests  45 passed (45)

$ pnpm contracts:check-clients
check-clients  OK — 713 client file(s) scanned, 250 contract path(s) known.

$ pnpm --filter @corehub/server typecheck    (بلا أخطاء)
$ pnpm --filter @corehub/web typecheck       (بلا أخطاء)

$ vitest run --project unit src/modules/agents/presets.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)

$ vitest run --project unit src/modules/devices/peers.test.ts
 Test Files  1 passed (1)
      Tests  9 passed (9)

$ vitest run --project contract tests/contract/contract.test.ts
      Tests  348 passed (348)

$ vitest run tests/presets-card.test.tsx
      Tests  2 passed (2)
$ vitest run tests/linked-hubs.test.tsx
      Tests  4 passed (4)
$ vitest run tests/lucide-icons.test.tsx tests/linked-hubs.test.tsx tests/presets-card.test.tsx tests/navigation.parity.test.tsx tests/settings-pages.test.tsx
      Tests  31 passed (31)

$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 39 destinations, 2 pre-auth screens (login, setup), 44 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm lint
All matched files use Prettier code style!

عدّ العمليات على مركز مُقلع (اختبار مؤقت لم يُحفظ):
TOTAL 347 STUBS 0 … "agents":[68,68] … "devices":[33,33]
```

اختبارات المركز تغطي: الحفظ والتفعيل والحذف، وعدم حفظ أي سرّ (لا في الجواب ولا في ملف القاعدة)، وما اختفى منذ
الحفظ يُذكر ويُطبَّق الباقي، والعضو لا يفعّل؛ والمراكز: الإقران بموافقة المالكين وبلاغ الموافقة الموقَّع،
الدعوة لمرة واحدة ولا تصلح بعد ١٠ دقائق، رفض بصمة لا تطابق وHTTP، رفض التوقيع المزوّر والإعادة والجسم المعدّل
والنداء القديم، رفض الوكيل غير المشارَك (والمجهول بالجواب نفسه)، حد الأسئلة في الساعة، الإيقاف في الاتجاهين،
الحذف يُسقط المفتاح ويُبلغ الطرف الآخر، وأن كل ذلك للمشرفين فقط؛ وسجل التدقيق في الطرفين بلا نص السؤال.
هذه الاختبارات تفشل على الشيفرة القديمة (كانت العمليات `501`).

CI على #165 (التشغيل 36215468721، الالتزام `27a51e63`):

```
✓ Lint, typecheck, contracts, client tests, build
✓ Server unit tests (shard 1/3, 2/3, 3/3)
✓ db:generate + db:migrate (SQLite and PostgreSQL)
✓ Docker image builds and answers /health
✓ Desktop app smoke
X Web smoke journeys: smoke 1 و8 فقط —
  strict mode violation: getByTestId('session-agent') resolved to 2 elements
```

فشل smoke 1 و8 ليس من هذه المهمة: معرّف `session-agent` صار في `SessionList.tsx` و`SessionAgent.tsx` معًا منذ
`3734137d` (مهمة عائلة التصميم)؛ تكرّر محليًا بالشيفرة نفسها. رحلة `zz-design` كانت تعدّ ثلاث صفحات إدارة
فصارت أربعًا بعد «المراكز المرتبطة» وأُصلحت هنا (نجحت محليًا وعلى CI).

## المخاطر والرجوع
- **سطح أمني جديد** (مسارات عامة بين المراكز): مغلق بلا توقيع صالح أو دعوة حية، ومحدود المعدل، ولا يتيح إلا
  أسماء الوكلاء المشارَكين وأجوبة بلا أدوات. خطر متبقٍ: بروكسي يعيد كتابة مسار `/api/v1` يكسر التوقيع؛ وفارق
  ساعة أكبر من ٥ دقائق يرفض النداءات (ويُسجَّل).
- الأجوبة تُوثَق عبر HTTPS للعنوان المحفوظ عند الإقران (توقيع الأجوبة لاحقًا إن لزم).
- عدّادات الحدود في الذاكرة: إعادة التشغيل تُصفّرها (لا تسمح بأكثر من الحد داخل الدقيقة/الساعة الواحدة للعملية).
- التفعيل يعيد تشغيل ما تطلبه الإعدادات عبر المسارات الموجودة؛ لا شيء يُكتب في `config.yaml` خارجها.
- الرجوع: استرجاع دمج الفرع؛ الهجرة `0031` تضيف جداول فقط ولا تمس غيرها.

## التسليم والخطوة التالية
- يُدمج في `night/2026-09-27` (#165) دون طلب دمج مستقل.
- للمالك أن يؤكد: معنى «الإعدادات المحفوظة» وأجزاؤها؛ ADR 0026 كله (السؤال بلا أدوات، المشاركة العامة لا لكل
  طرف، للمشرفين فقط، السماح بالعناوين الخاصة، الحدود الافتراضية).
- لاحقًا: سؤال الأعضاء، أداة «اسأل مركزًا مرتبطًا» داخل المحادثة، مشاركة لكل طرف، وصفحة الهواتف.
