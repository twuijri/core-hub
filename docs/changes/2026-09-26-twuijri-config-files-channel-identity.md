# ملفات إعداد وكلاء البرمجة، وهوية مرسل القنوات لأدوات المركز، وتأجيل المرحّل والأقران
المسؤول: twuijri · الفرع: feat/config-files-channel-identity · الحالة: review

## المشكلة والهدف
بقيت من جرد ‎501‎ (`docs/changes/2026-09-26-twuijri-close-501-stubs.md`) أسئلة (ب) أجاب عنها المالك في 2026-09-25:

1. **ملفات إعداد الوكيل** — «تم»: صفحة ويب واحدة، للمشرفين فقط، لتحرير ملفات إعداد وكلاء البرمجة (مثل
   `CLAUDE.md` و`settings.json` لـClaude Code، وما يقابلها لبقية وكلاء الكتالوج مما يقرؤه كل وكيل فعلًا).
   مجموعة **واحدة مشتركة لكل البروفايلات** في بيت مستخدم المركز حيث يقرؤها الوكلاء. قائمة مسموح بها من المفاتيح
   لكل وكيل، لا مسارات حرة ولا صعود، فحص JSON قبل الحفظ، نسخة احتياطية من السابق، سجل تدقيق لكل كتابة، حدّ حجم.
2. **رسائل القنوات وأدوات المركز: الخيار (ب)** — «اوافق»: يربط الشخص هويته في تيليجرام و/أو واتساب بحسابه في
   المركز. رسالة من هوية مربوطة تعمل بصلاحيات صاحبها فتعمل أدوات المركز (MCP) باسمه؛ ومرسل غير مربوط **بلا أدوات
   المركز** ويبقى الوكيل يحادثه كاليوم. الربط يُثبَت ولا يُكتب (رمز لمرة واحدة يرسله الشخص إلى البوت من ذلك
   الحساب). فكّ الربط من إعدادات الشخص، والمشرف يرى الروابط ويزيلها.
3. **المرحّل (Relay)** — «يبقى في العقد، مؤجّلًا»: تطبيق سطح المكتب يعمل متصلًا بخادم أو محليًا، ومستخدم محلي بلا
   خادم قد يحتاج الهاتف من الخارج لاحقًا. الخيارات: نفق Cloudflare بحساب المستخدم، أو Tailscale. لا يُبنى.
4. **الإعدادات المسبقة والمراكز الأقران** — «خلها بعدين اخاف تفتحلنا ثغرات»: لا تُبنى ولا تُحذف؛ السبب سطح أمني.

## القرار والموافقات
**موافَق عليه من المالك** (كلماته أعلاه): بناء (1) و(2)، وتأجيل (3) و(4) مع إبقائها في العقد. سُجّلت في DECISIONS
§78 (ملفات الإعداد) و§79 (هوية المرسل) و§80 (المؤجَّلات). الرقم §77 أخذه طلب «منصة الربط» الذي دُمج قبل هذا.
ما يلي من التفاصيل اختياري أنا، **مقترح — للمالك أن يؤكّد**.

### ما رأيته قبل الكتابة (ADR 0012)
**وكلاء البرمجة** — من الحزم المثبّتة نفسها (نسخها المثبّتة في الكتالوج)، لا من الذاكرة:
| الوكيل | التعليمات | الإعدادات | متغيّر ينقل المجلد | الدليل |
|---|---|---|---|---|
| Claude Code (جسر ACP ‏0.16.2) | `~/.claude/CLAUDE.md` | `~/.claude/settings.json` (JSON صارم) | `CLAUDE_CONFIG_DIR` | `acp-agent.js`: ‏`settingSources: ["user", "project", "local"]` و`CLAUDE_CONFIG_DIR ?? ~/.claude`؛ أن مصدر `user` يقرأ `CLAUDE.md` سلوك موثّق لحزمة Anthropic (الحزمة نفسها لم تكن على القرص) |
| Codex (codex-acp ‏0.16.0) | `~/.codex/AGENTS.md` (و`AGENTS.override.md` يسبقه إن وُجد) | `~/.codex/config.toml` | `CODEX_HOME` | نصوص الملف التنفيذي: `CODEX_HOME…/.codex`، `agents_md.rs … AGENTS.override.md AGENTS.md` |
| Gemini CLI ‏0.60.0 | `~/.gemini/GEMINI.md` | `~/.gemini/settings.json` (تعليقات مسموحة) | `GEMINI_CLI_HOME` (يحلّ محلّ البيت) | `GEMINI_DIR = ".gemini"`، `DEFAULT_CONTEXT_FILENAME = "GEMINI.md"`، `strip-json-comments` |
| Qwen Code ‏0.24.5 | `~/.qwen/QWEN.md` (ويقرأ `AGENTS.md` أيضًا) | `~/.qwen/settings.json` (تعليقات مسموحة) | `QWEN_HOME` | `getGlobalQwenDir()`، `DEFAULT_CONTEXT_FILENAME = "QWEN.md"` |
| Kimi Code ‏2.1.1 | `~/.kimi-code/AGENTS.md` | `~/.kimi-code/config.toml` | `KIMI_CODE_HOME` | `resolveKimiHome … ".kimi-code"`، `# ~/.kimi-code/config.toml` — المجلد `.kimi-code` لا `.kimi` |
| Pi ‏0.87.1 | `~/.pi/agent/AGENTS.md` | `~/.pi/agent/settings.json` (JSON صارم) | `PI_CODING_AGENT_DIR` | `config.js`، `settings-manager.js`، `resource-loader.js` |
OpenCode: حزمته لم تكن على القرص فلم أتحقق، فلا يُعرض.

**هرمز** (MIT، الوسم v2026.9.14، `gateway/hooks.py` و`run_turn.py` و`run_inbound.py` و`tools/mcp_tool_config.py`
و`agent/secret_scope.py` و`plugins/platforms/telegram/adapter.py`)، بكلماتي:
- بوابة المراسلة تحمّل «خطافات» من `hooks/<اسم>/` في بيت البروفايل (`HOOK.yaml` بالأحداث، و`handler.py` فيه
  `handle(event_type, context)`) **عند بدئها**؛ فالخطاف الجديد يحتاج إعادة تشغيل البوابة.
- `agent:start` يُنتظر **قبل** أن يبدأ الوكيل الدور، ومعه المرسل كما سمّته المنصة (`platform`، `user_id`،
  `chat_type`، `session_id`)؛ `agent:end` بعده، و`agent:step` مع كل حلقة أدوات. فالمركز يعرف لمن الدور قبل أي أداة.
- أمر مائل يعرفه هرمز يطلق `command:<name>` **بعد** تحقّق هرمز من المرسل (الاقتران، قوائم المسموح)، والردّ
  `{decision: handled, message}` يجعل البوابة تجيب به وتتوقف. `/start` منها (وهرمز يتجاهله عادة)، ورابط
  تيليجرام `?start=<code>` يرسله.
- رقم المرسل هو نفسه الذي تستعمله قوائم هرمز: رقم مستخدم تيليجرام، ومعرّف محادثة واتساب.
- رؤوس MCP في `config.yaml` تُملأ `${VAR}` من `.env` البروفايل، وإلا من بيئة العملية (حين لا تعدّد بروفايلات).
- محوّل تيليجرام يقبل `platforms.telegram.extra.base_url` (خادم Bot API محلي) — وبه اختبرتُ البوابة الحقيقية.

### (1) ملفات الإعداد — DECISIONS §78
- **قائمة ثابتة لكل وكيل** بمفتاحين `instructions` و`settings` (الجدول أعلاه)، ولا مسار في أي طلب. يُحترم متغيّر
  الوكيل الذي ينقل مجلده من البيئة التي يعطيها المركز لوكلائه. قدرة جديدة `config_files` تقول إن للوكيل ملفات.
- **للمالك والمشرف فقط**، القراءة أيضًا (ملف الإعدادات قد يحمل مفاتيح).
- **الروابط**: يُتبع الرابط ما دام مساره الحقيقي داخل مجلد الوكيل أو البيت (مجلد dotfiles يعمل)؛ رابط يخرج
  (نحو `/data/keys` مثلًا) يُرفض قراءةً وكتابةً `409 symlink_outside`.
- **الكتابة**: `revision` (بصمة البايتات؛ `null` للإنشاء) وإلا `409 changed` ولا يُكتب شيء؛ JSON يُفحص (بتعليقات
  لـGemini وQwen فقط)؛ ‎1 MiB‎ حدًّا (`413`، و`415` لغير UTF-8)؛ نسخة احتياطية من السابق في
  `<DATA_DIR>/backups/agent-config/<agent>/<key>/` (أحدث عشر)؛ كتابة عبر ملف مؤقت ثم إعادة تسمية بالصلاحيات نفسها
  (`0600` للجديد)؛ حدث تدقيق `agent_config_file.written` بالبصمتين. TOML لا يُفحص (لا محلّل في المركز).
- **مقترح:** **بيت الصورة داخل المجلّد المحفوظ** — `HOME=/data/home` في الصورة (يُنشأ في أول تشغيل لمجلد قديم)،
  لأن `/home/hub` يضيع مع كل استبدال للحاوية، فكان التعديل سيضيع. ذاكرة npm المؤقتة تبقى خارجه
  (`NPM_CONFIG_CACHE=/tmp/.npm`). على سطح المكتب والتثبيت الأصلي البيت هو بيت الشخص، بلا تغيير.
- **الويب (مقترح):** «ملفات الإعداد» صفحة في قائمة الوكيل قبل «الإعدادات» (الويب وسطح المكتب لا الهواتف)، تبويب
  لكل ملف بمحرّر صفحة «الملفات» (Markdown بخط القراءة واتجاه كل سطر من محتواه، JSON وTOML من اليسار بخط ثابت
  العرض)، حفظ وتراجع، ورفض الملف المتغيّر مع «حمّل الملف الحالي»، وتنبيه أن الملفات مشتركة بين كل البروفايلات.

### (2) هوية مرسل القنوات — DECISIONS §79
- **الخطاف للمركز**: يُكتب بجانب كتلة `corehub` حين تُفعَّل الأدوات (`hooks/corehub/`، معلَّم، يُحذف عند الإطفاء،
  ويُعاد عند الإقلاع)، وتُعاد بوابة البروفايل ليحمّله. يكلّم `agents.hubChannelEvent` بمفتاح البروفايل نفسه
  مقروءًا من `.env` البروفايل الذي يسكنه.
- **الربط برمز لمرة واحدة**: `corehub_` وعشرة أحرف، عشر دقائق، مرة واحدة، رمز واحد لكل شخص، في الذاكرة ومُجزّأ.
  يرسله الشخص `/start <code>` من الحساب، فيربطه المركز ويجيب هرمز بلغة الشخص. حساب مربوط بغيره يُرفض ولا
  يُنتزع. تيليجرام وواتساب فقط.
- **مقترح: رابط واحد للمركز لا لكل بروفايل** — الشخص نفسه في كل بروفايل، وعضويته تحدّد أين يعمل؛ دور في بروفايل لا
  يدخله (أو وهو معطّل) لا يعمل باسم أحد (`hub_tools_sender_no_access`).
- **الدور عقد إيجار (lease)**: `turn_started` يفتحه للشخص (رمز تشغيل له في ذلك البروفايل كما في §67) أو لـ«لا أحد»
  مع السبب؛ `turn_ended` يغلقه؛ `turn_step` يبقيه؛ ربع ساعة صمت تنهيه.
- **مقترح: الاتصال يقول من أي عملية جاء** — رأس `X-Corehub-Origin: ${COREHUB_MCP_ORIGIN}` في الكتلة، والمركز يضع
  المتغيّر في كل عملية هرمز يشغّلها: `hub` لعملية محادثاته (ولوكيل البرمجة في `session/new`)، و`gateway` لكل بوابة
  مراسلة. فاتصال البوابة لا يُنسب إلا لأدوارها، واتصال عملية المركز لا يُنسب إلا لتشغيلاته. **هذا يسدّ ثغرة
  قائمة**: قبله، أداةٌ من دور قناة أثناء محادثة حيّة لشخص في الويب كانت تُنسب لذلك الشخص.
- **مقترح: يُرفض ولا يُخمَّن**: الغريب (`hub_tools_sender_not_linked`)، ومحادثة المجموعة لأن غير الشخص يوجّهونها
  أيضًا (`hub_tools_group_chat`)، ومرسلان مختلفان في بوابة واحدة في الوقت نفسه (`hub_tools_run_ambiguous`).
- **الإدارة**: الشخص يرى روابطه ويفكّها من الإعدادات ← الحساب («حسابات المراسلة»)، والمالك والمشرف يرون الكل
  ويزيلون من الإعدادات ← الأشخاص. جدول `channel_identities` (ترحيل `0025`) يُحذف مع صاحبه.

### (3) و(4) — DECISIONS §80
المرحّل باقٍ في العقد ‎501‎ ومؤجّل، وخياراه عند البناء: نفق Cloudflare بحساب الشخص أو Tailscale، لا خدمة نديرها.
الإعدادات المسبقة والأقران باقية ‎501‎ لا تُبنى ولا تُحذف، والسبب سطح أمني. وحُدّث STATUS بذلك.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `agents.listConfigFiles` / `getConfigFile` / `putConfigFile`: أوصاف، `x-roles: [owner, admin]` للثلاث، ردود `409`
  و`413` و`415`، أمثلة بمفتاح `instructions`، و`x-rt-events: []` للكتابة (لا يتغيّر الوكيل نفسه). `ConfigFile` صار
  موصوفًا، و`ConfigFileWrite.revision` **مطلوب** (`null` للإنشاء). `AgentCapability` تكسب `config_files`.
  كانت ‎501‎ ولا عميل يقرؤها، فالتغيير متوافق.
- جديد: `auth.listMyChannelIdentities`، `auth.createChannelLinkCode`، `auth.deleteMyChannelIdentity`،
  `auth.listChannelIdentities`، `auth.deleteChannelIdentity`، و`agents.hubChannelEvent`
  (`POST /hub-mcp/channel-events`)؛ مخططات `ChannelIdentityPlatform`، `ChannelIdentity`، `ChannelIdentityList`،
  `ChannelLinkCode`، `HubChannelEvent`، `HubChannelEventResult`. `agents.hubMcp` يكسب رأسًا اختياريًا
  `X-Corehub-Origin` ووصفًا لرموز الرفض الجديدة.
- العدد: 321 عملية، منها 310 مبنية (كان 301 من 315).

## الملفات والتأثير
- **العقد:** `packages/contracts/openapi.yaml`.
- **الخادم — ملفات الإعداد:** `packages/server/src/modules/agents/config-files.ts` (جديد)، `…/agents/index.ts`
  (المسارات الثلاثة، المخزن، إنشاء البيت، `gatewayChanged`)، `…/agents/schema.ts` و`…/catalog/{claude-code,codex,
  gemini-cli,qwen-code,kimi-code,pi}.ts` (قدرة `config_files`)، `…/agents/config-files.routes.test.ts` (جديد)،
  `packages/server/Dockerfile` (`HOME=/data/home`، `NPM_CONFIG_CACHE`).
- **الخادم — الهوية:** `…/auth/channel-identities.ts` (جديد)، `…/auth/{schema,context,index,routes}.ts`،
  `packages/server/drizzle/0025_channel_identities.sql` ولقطته وسجلّه، `…/agents/hub-tools/hook.ts` (جديد)،
  `…/hub-tools/{block,leases,service,routes}.ts`، `…/agents/hermes-runtime.ts` و`…/hermes-gateways.ts` (متغيّر
  المصدر)، `packages/server/src/i18n/{ar,en}.json`، `…/hub-tools/channel-identity.routes.test.ts` و
  `…/hub-tools/channel-identity.real.test.ts` (جديدان)، `…/hub-tools/hub-tools.routes.test.ts` (الرأس الجديد).
- **الويب:** `packages/web/src/agents/{AgentConfigFilesScreen.tsx,configFiles.ts}` (جديدان)،
  `packages/web/src/people/ChannelAccounts.tsx` (جديد)، `…/settings/AccountTab.tsx`، `…/people/UsersTab.tsx`،
  `…/navigation/routes.tsx`، `…/i18n/{ar,en}.json`، `packages/web/tests/config-files.test.tsx` (جديد)،
  `packages/web/tests/navigation.parity.test.tsx` (مسار بشرطة).
- **التنقّل:** `docs/clients/navigation.json` (الوجهة `agent_config_files`، المصطلح، المسار)،
  `docs/clients/NAVIGATION.md`؛ واختبارا تطابق أندرويد وiOS يحترمان `surfaces` في `agentLevel`
  (`apps/android/…/NavigationParityTest.kt`، `apps/ios/CoreHubTests/NavigationParityTests.swift`) — سطر لكلٍّ.
- **الوثائق:** `docs/contracts/DECISIONS.md` (§78، §79، §80)، `docs/STATUS.md`، `docs/domain/{agents,auth}.md`،
  `docs/DEPLOY.md` (`/data/home/`، النسخ الاحتياطية).

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`، محليًا، على ما مسّه التغيير؛ الحزم الكاملة يشغّلها CI.

الاختبارات الجديدة على **الشيفرة القديمة** (شجرة مؤقتة على `origin/main` مع ملفَي الاختبار فقط):
```
     × writes the hook beside the block when the tools go on, and removes it when they go off 1185ms
     × links an account proved with a one-time code, once, and never a second person 2ms
     × acts as the linked person for a gateway's call, and for nobody when the sender is a stranger 4ms
     × gives no tools to a group chat, to a person outside the profile, or after an unlink 2ms
     × lists Claude Code's two files, writes CLAUDE.md where the agent reads it, and reads it back 1231ms
     × refuses a stale revision, keeps a backup of what it replaces, and audits the write 767ms
     × validates JSON before saving — with comments only where the agent strips them 692ms
     × knows only its own keys, refuses a link out of the home, a file too large, and members 678ms
     × honours the agent's own variable that moves its folder 677ms
AssertionError: expected 501 to be 400 // Object.is equality
AssertionError: expected 501 to be 404 // Object.is equality
AssertionError: expected 'hub_tools_no_live_run' to be 'hub_tools_group_chat' // Object.is equality
      Tests  10 failed (10)
```

هرمز الحقيقي من الصورة (`core-hub:morechannels`، هرمز v2026.9.14): `hermes gateway run` بمحوّل تيليجرام الحقيقي
على Bot API مزيّف محلي، ونموذج مكتوب. `/start <code>` يربط الحساب 4242 ويجيب هرمز بكلمات المركز؛ دور 4242 ينشئ
مهمة باسم الشخص؛ دور 9999 (غير مربوط) يُرفض `hub_tools_sender_not_linked` **بينما للشخص محادثة حيّة في المركز** —
ولو لم يصل رأس `X-Corehub-Origin: gateway` لكان الرفض `hub_tools_run_ambiguous`. واختبار أدوات المركز الحقيقي
السابق (عبر TUI) ما زال ينجح بالرأس الجديد:
```
$ COREHUB_HERMES_IMAGE=core-hub:morechannels npx vitest run --project unit \
    src/modules/agents/hub-tools/channel-identity.real.test.ts src/modules/agents/hub-tools/hub-tools.real.test.ts
 Test Files  2 passed (2)
      Tests  3 passed (3)
$ docker ps -a --format '{{.Names}}' | grep corehub- || echo "no corehub containers left"
no corehub containers left
```

بعد دمج `origin/main` (الرأس `e11e6670`):
```
$ npx vitest run --project unit src/modules/agents/hub-tools src/modules/agents/config-files.routes.test.ts \
    src/modules/agents/mcp.test.ts src/modules/agents/hermes-gateways.test.ts src/modules/agents/hermes-runtime.test.ts \
    src/modules/agents/agents.test.ts src/modules/auth tests/unit/status.test.ts
 Test Files  18 passed | 3 skipped (21)
      Tests  155 passed | 4 skipped (159)

$ (packages/web) npx vitest run tests/config-files.test.tsx tests/navigation.parity.test.tsx tests/people.test.tsx \
    tests/hub-tools-card.test.tsx tests/i18n.test.ts tests/logical-css.test.ts tests/agents-top-level.test.tsx
 Test Files  7 passed (7)
      Tests  314 passed (314)

$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  370 passed (370)

$ pnpm contracts:lint            → contracts:lint  OK
$ pnpm contracts:check-clients   → check-clients  OK — 585 client file(s) scanned, 228 contract path(s) known.
$ pnpm i18n:check                → i18n:check  OK
$ pnpm nav:check                 → nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm lint                      → All matched files use Prettier code style!
$ pnpm typecheck                 → exit 0
$ DATA_DIR=$(mktemp -d) pnpm db:migrate
{"level":30,...,"msg":"db: migrations applied (sqlite)"}
$ DATA_DIR=$(mktemp -d) npx drizzle-kit generate   → No schema changes, nothing to migrate 😴
$ pnpm build                     → exit 0 (web built; desktop build: apps/desktop/dist/hub ready)
```
لم أشغّل محليًا: حزم الخادم والويب ورحلات Playwright كاملة، وبناء الصورة، وأندرويد وiOS — يشغّلها CI على طلب الدمج.

## المخاطر والرجوع
- **`HOME=/data/home` في الصورة** (مقترح): ما يكتبه وكلاء البرمجة في بيتهم صار يبقى بين الترقيات، وصدفة الطرفية
  للمالك بيتها هناك. الرجوع: حذف السطرين من `Dockerfile`؛ الملفات في `/data/home` تبقى بلا ضرر.
- **إعادة تشغيل البوابة**: أول إقلاع بعد الترقية يكتب الخطاف في كل بروفايل أدواته مفعّلة، فتُعاد بوابته مرة (والبوابة
  الافتراضية تُوقف وتعود). الرجوع: إطفاء أدوات المركز يحذف الخطاف والكتلة معًا.
- **الأمان**: الخطاف لا يرفع صلاحية أحد — مرسل غير مربوط يُعامل كما كان (بلا أدوات)، ودور المربوط يأخذ رمز تشغيل
  بصلاحيات عضو في بروفايل واحد كما في §67. ما زال الوكيل نفسه (بأدوات الطرفية) قادرًا على قراءة مفتاح البروفايل
  وتقليد الرأس، كما كان قبل هذا مع الكتلة؛ حدّه ما في §67 (لا مشرف، بروفايل واحد، شخص حيّ).
- **حدود معروفة**: مرسلان مختلفان في بوابة واحدة في اللحظة نفسها يُرفضان (لا يعلن هرمز أدواته في البوابة)؛ أمر
  `/start` أثناء انشغال الوكيل يتخطّى الخطافات فيجب إعادته؛ واتساب قد يسمّي الحساب `…@lid` بدل الرقم، فيُربط كما
  يسمّيه هرمز؛ TOML لا يُفحص قبل الحفظ؛ OpenCode بلا ملفات حتى يُتحقق منه.
- **الرجوع الكامل**: إعادة المسارات الثلاثة إلى ‎501‎ وحذف العمليات الست الجديدة؛ ترحيل عكسي يحذف `channel_identities`.

## التسليم والخطوة التالية
طلب دمج واحد إلى `main` بالإنجليزية، بلا دمج ولا دمج تلقائي. للمالك أن يؤكّد: §78 (بيت الصورة في المجلّد، شكل
الصفحة)، §79 (رابط واحد للمركز، رأس المصدر، رفض المجموعات والتزامن). بعدها: مجموعة `devices` و`usage` في أدوات
MCP، وOpenCode حين تُتحقق ملفاته.
