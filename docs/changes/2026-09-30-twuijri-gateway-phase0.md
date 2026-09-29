# المرحلة صفر من بوابة النماذج: قائمة سماح لبيئة الوكلاء، وجسور ACP الجديدة، ومهارات Claude Code
المسؤول: twuijri · الفرع: feat/gateway-phase0 (يُدمج في batch/2026-09-29d، PR #227) · الحالة: review

## المشكلة والهدف
وافق المالك (2026-09-29) على خطة بوابة النماذج (البحث في PR #228، `docs/research/model-gateway-2026-09.md`). الليلة المرحلة صفر فقط:

1. **ثغرة أمنية:** كل وكيل ACP يرث بيئة المركز كاملة (`agents/adapters/acp.ts` §`agentEnvironment` و`app/config.ts` §`readHostEnv`):
   رابط قاعدة البيانات وكلمة مرور المالك الأول ومفاتيح الإشعارات وأي سرّ وضعه المشغّل في الحاوية تصل إلى كل CLI خارجي وإلى سكربتات حزمه.
   وهرمز وnpm يرثان إعدادات المركز نفسها.
2. **جسرا ACP مهجوران على npm:** ‏`@zed-industries/claude-code-acp@0.16.2` و`@zed-industries/codex-acp@0.16.0`؛
   خلفاهما `@agentclientprotocol/claude-agent-acp` و`@agentclientprotocol/codex-acp`. المطلوب نقل التثبيت إليهما دون كسر أي تثبيت قائم.
3. **صفحة المهارات لـClaude Code** تجيب `409 skills_are_hermes_only` (من صنف مشكلة صفحة MCP في §138).

## القرار والموافقات
DECISIONS §139 (مقترح — بانتظار تأكيد المالك):

- **قائمة سماح لبيئة الوكيل البرمجي** (`adapters/child-env.ts`): أساس يحتاجه كل برنامج
  (`PATH` و`HOME` و`USER` و`LOGNAME` و`SHELL` و`TMPDIR` و`XDG_*` و`LANG` و`LANGUAGE` و`LC_*` و`TZ` و`TERM` و`COLORTERM`،
  متغيرات البروكسي بالحالتين، `SSL_CERT_FILE` و`SSL_CERT_DIR` و`NODE_EXTRA_CA_CERTS` و`REQUESTS_CA_BUNDLE` و`CURL_CA_BUNDLE`،
  ذاكرة npm وسجلّه، جلسة سطح المكتب `DISPLAY` و`WAYLAND_DISPLAY` و`XAUTHORITY` و`DBUS_SESSION_BUS_ADDRESS` و`SSH_AUTH_SOCK`،
  وما لا يقوم برنامج ويندوز بدونه)، + متغيرات مفاتيحه في الكتالوج (`credentials`)، + ما يقرؤه الوكيل موثّقًا (`hostEnv` جديد في مدخل الكتالوج).
  لا يمرّ أبدًا: `COREHUB_*` و`MAJLIS_*` و`HUB_*` و`DATABASE_*` و`TELEGRAM_*` و`DATA_DIR` و`PORT`، والكتالوج يرفض مدخلًا يطلبها.
  `NODE_OPTIONS` لا يمرّ. ما يعطيه المركز نفسه (مفاتيح البروفايل المشتركة، `env` إعدادات الوكيل) يُضاف فوقها كما كان.
  القائمة نفسها لتسجيل الدخول ولفحص `--version`.
- **لا برنامج يشغّله المركز يأخذ إعدادات المركز:** `HostEnv.inherited` = بيئة المضيف ناقص مفاتيح إعداد المركز (`ENV_KEYS` وأسماؤها القديمة).
  هرمز يبقى له كل ما سوى ذلك (رموز قنواته، مفاتيح المزوّدين، `HERMES_*`، `COREHUB_IMAGE_*` لسكربت المهارة) فلا ينكسر.
- **الجسران الجديدان:** ‏Claude Code → `@agentclientprotocol/claude-agent-acp` ‏0.84.0 (البرنامج `claude-agent-acp`)،
  Codex → `@agentclientprotocol/codex-acp` ‏2.0.0 (البرنامج `codex-acp`، ويثبّت `@openai/codex` بجانبه).
  حقل `legacy` في وصفة npm يسمّي الحزمة القديمة وبرنامجها. التثبيت القديم **يبقى يعمل بلا أي إجراء**: يُعثر على برنامجه باسمه القديم ويُشغَّل،
  ونسخته من `package.json` حزمته، فتعرض البطاقة التحديث (0.16.2 → 0.84.0). عند الضغط على «تحديث» (أو التحديث التلقائي):
  تُثبَّت الحزمة الجديدة في `<DATA_DIR>/agents/.<id>.next`، يُشغَّل `--version` منها (Node أقدم مما تحتاجه يفشل هنا)، ثم تُبدَّل المجلدات ويُفحص الوكيل؛
  أي فشل يترك التثبيت القديم كما كان. السبب: npm يرفض تثبيت الجديدة فوق القديمة في مكانها (كلتاهما تملك `bin/codex-acp`: ‏EEXIST — جرّبته).
  مجلد يبدأ بنقطة تحت `agents/` لا يدخل `PATH` أبدًا.
- **صفحة مهارات Claude Code** تدير `~/.claude/skills` (`$CLAUDE_CONFIG_DIR/skills`): عرض وقراءة وكتابة وتشغيل/إيقاف وتثبيت واستيراد وحذف،
  مجموعة واحدة لكل البروفايلات كصفحتي ملفات الإعداد وMCP. بلا مكتبة كور هب (لهرمز)، بلا مهارات مدمجة، بلا فلتر `platforms`،
  والإيقاف = إعادة تسمية `SKILL.md` إلى `SKILL.md.off` (Claude Code لا يحمّل إلا `SKILL.md`)، ولا يُكتب `config.yaml` في مجلده أبدًا.
  بقية الوكلاء غير هرمز تبقى `skills_are_hermes_only`، وعمليات المكتبة لهرمز فقط.
- مرفوض: قائمة منع للوكلاء (ما يضيفه المشغّل غدًا يتسرّب)، تمرير `GITHUB_TOKEN`/`GH_TOKEN` (سرّ؛ من أراده يضعه في `env` إعدادات الوكيل)،
  حذف القديم قبل تثبيت الجديد (فشل التثبيت يترك بلا وكيل)، صفحة `~/.agents/skills` المشتركة الآن، استدعاء `authenticate` لـCodex
  (يكتب المفتاح في `auth.json` الخاص به؛ يُقرَّر في عمل البوابة).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
وصف `agents.listSkills` فقط (نص): العمليات نفسها تخدم مجلد مهارات Claude Code، وبقية الوكلاء `skills_are_hermes_only`.
لا عملية ولا حقل ولا قيمة جديدة أو محذوفة؛ `library` كان اختياريًا أصلًا.

## الملفات والتأثير
- `packages/server/src/modules/agents/adapters/child-env.ts` (جديد): قائمة السماح والأسماء الممنوعة ومطابقة ويندوز غير الحساسة للحالة.
- `packages/server/src/modules/agents/catalog/provider-env.ts` (جديد): متغيرات المزوّدين لـGoose وOpenCode وPi.
- `packages/server/src/modules/agents/catalog/types.ts`: ‏`hostEnv` و`install.legacy` و`legacyPackages()` و`binaryNames()`.
- `packages/server/src/modules/agents/catalog/*.ts`: ‏`hostEnv` لكل وكيل ACP؛ Claude Code وCodex على الحزمتين الجديدتين مع `legacy`؛ `index.ts` يتحقق من `hostEnv` و`legacy`.
- `packages/server/src/modules/agents/adapters/acp.ts`: البيئة من قائمة السماح؛ الاكتشاف والفحص يجدان البرنامج القديم؛ فحص النسخة بالقائمة نفسها.
- `packages/server/src/modules/agents/installer.ts`: البحث بالاسمين، النسخة من الحزمة القديمة عند الحاجة، التحديث عبر مجلد جانبي وتبديل، بيئة npm بلا إعدادات المركز، `executablePath()`.
- `packages/server/src/modules/agents/service.ts`: المطابقة عند الإقلاع تسجّل البرنامج الموجود فعلًا.
- `packages/server/src/app/config.ts`: ‏`readHostEnv` يحذف مفاتيح إعداد المركز.
- `packages/server/src/modules/agents/index.ts`: تسجيل الدخول بالقائمة؛ عمليات المهارات لـClaude Code (`skillPlace`).
- `packages/server/src/modules/agents/skills.ts`: خيار `{ agent: 'plain' }`؛ `config-files.ts`: ‏`agentFolder()`؛ `agent-credentials.ts`: ‏`credentialVariables()` للاختبار.
- الاختبارات: `adapters/child-env.test.ts` و`bridge-rename.test.ts` و`claude-code-skills.routes.test.ts` و`acp-bridges.real.test.ts` (حقيقي، يُشغَّل عند الطلب) و`tests/unit/config.test.ts`.
- `packages/contracts/openapi.yaml` (وصف)، `docs/contracts/DECISIONS.md` §139، `docs/STATUS.md`.

التأثير على من يعمل الآن: ترقية بالصورة فقط. Claude Code وCodex المثبّتان يستمران بالحزمة القديمة حتى «تحديث».
من وضع مفتاحًا أو إعدادًا لوكيل في بيئة الحاوية يبقى يصله (كل ما يقرؤه الوكيل في قائمته). ما يُفقد عمدًا: أسرار المركز وما لا يخص الوكيل.

## الفحوص (الأوامر ونواتجها الفعلية)
التحقق بالحزم الحقيقية (npm، في `~/.cache/corehub-agent/acp-data`): تثبيت الجسر القديم، تشغيله بجلسة من محوّل المركز (Claude Code)،
تحديثه بمثبّت المركز إلى الجديد، ثم `initialize` و`session/new` ودورة كاملة مقابل مزوّد وهمي محلي (Anthropic Messages لـClaude Code،
OpenAI Responses لـCodex) عنوانه في البيئة فقط — ووصل المفتاح الذي سلّمه المركز إلى المزوّد:

```
$ COREHUB_REAL_ACP_BRIDGES=1 COREHUB_REAL_ACP_DATA=~/.cache/corehub-agent/acp-data \
    pnpm exec vitest run --project unit --maxWorkers=1 --reporter=verbose src/modules/agents/acp-bridges.real.test.ts
 ✓ |unit| src/modules/agents/acp-bridges.real.test.ts > the renamed ACP bridges, for real (COREHUB_REAL_ACP_BRIDGES=1) > claude-code: an old install is updated to the successor, which starts a session and reaches the provider 10365ms
 ✓ |unit| src/modules/agents/acp-bridges.real.test.ts > the renamed ACP bridges, for real (COREHUB_REAL_ACP_BRIDGES=1) > codex: an old install is updated to the successor, which starts a session and reaches the provider 9601ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

ملفات الاختبار التي لمسها التغيير والقريبة منه (`--maxWorkers=2`):

```
$ pnpm exec vitest run --project unit --maxWorkers=2 src/modules/agents/adapters src/modules/agents/agent-sign-in.test.ts \
    src/modules/agents/installer-health.test.ts src/modules/agents/hermes-runtime.test.ts src/modules/agents/hermes-processes.test.ts \
    src/modules/agents/agent-credentials.test.ts src/modules/agents/skills.test.ts src/modules/agents/skill-import.test.ts \
    src/modules/agents/bridge-rename.test.ts src/modules/agents/claude-code-skills.routes.test.ts \
    src/modules/agents/coding-agent-mcp.routes.test.ts src/modules/agents/config-files.routes.test.ts tests/unit/config.test.ts \
    tests/unit/boot-slow-agents.test.ts src/modules/agents/agents.test.ts src/modules/agents/download-install.test.ts
 Test Files  24 passed | 8 skipped (32)
      Tests  289 passed | 23 skipped (312)
$ pnpm contract:test
 Test Files  20 passed (20)
      Tests  429 passed (429)
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 1135 client file(s) scanned, 268 contract path(s) known.
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck      (exit 0)
```

الاختبارات الجديدة تفشل على الكود القديم: الوكيل الوهمي كان سيكتب `DATABASE_URL` و`HUB_ADMIN_PASSWORD` وغيرها في بيئته؛
التثبيت القديم `claude-code-acp` لم يكن يُعثر عليه باسم `claude-agent-acp`؛ صفحة مهارات Claude Code كانت `409`.
CI على PR #227 بعد دفع 226467f1 (run 36634514074): كل فحوص الخادم خضراء — وحدات الخادم (3 أجزاء)، هرمز الحقيقي (floor وpinned)،
صورة Docker و`/health`، سطح المكتب تحت Xvfb، رحلات الويب، Android، iOS، الترحيلات، سجل التغيير. الفحص الوحيد الأحمر
«Lint, typecheck, contracts, client tests, build» سببه `tests/logical-css.test.ts` في `schedules/workflows/WorkflowCanvas.tsx`
(`left-0` في السطرين 641 و737) — ملف محرّر سير العمل لوكيل آخر على الفرع نفسه، لم ألمسه:

```
FAIL tests/logical-css.test.ts > logical CSS properties only > schedules/workflows/WorkflowCanvas.tsx
AssertionError: expected [ '641: left-0', '737: left-0' ] to deeply equal []
```

## المخاطر والرجوع
- وكيل كان يعتمد على متغير في بيئة الحاوية ليس في قائمته لن يراه بعد الآن (مثل `GITHUB_TOKEN`). الحل: وضعه في `env` إعدادات الوكيل، أو إضافته إلى `hostEnv` في الكتالوج بطلب مراجَع.
- الجسر الجديد لـClaude Code يطلب Node ‏22 فأعلى (`engines`)؛ في الصورة Node ‏24. على سطح المكتب يُفحص `--version` قبل التبديل، فإن لم يعمل يبقى القديم ويقول التحديث السبب.
- codex-acp (القديم والجديد) يطلب تسجيل دخول عند `session/new` إذا لم يُعطَ إلا مفتاحًا — كما كان قبل هذا التغيير؛ يُعالج في عمل البوابة.
- لم يُجرَّب بعد على هب المالك ولا في صورة Docker.
- الرجوع: إرجاع الإيداعات؛ التثبيت المحدَّث بالحزمة الجديدة يعمل مع الكود القديم؟ لا — الكود القديم يبحث عن `claude-code-acp`، فالرجوع يتطلب «إعادة تثبيت» Claude Code من البطاقة. Codex يعمل (الاسم نفسه).

## التسليم والخطوة التالية
يُدمج في `batch/2026-09-29d` (PR #227). بعد تأكيد المالك: المرحلة 1 من البوابة (رمز المركز للوكيل، `ANTHROPIC_BASE_URL`/`CODEX_CONFIG` نحو البوابة)،
وصفحة `~/.agents/skills` المشتركة للوكلاء الآخرين.
