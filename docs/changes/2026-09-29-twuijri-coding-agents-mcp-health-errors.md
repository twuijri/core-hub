# صفحة MCP للوكلاء البرمجيين، وتثبيت بلا `--version`، وخطأ الوكيل يقول السبب
المسؤول: twuijri · الفرع: fix/agent-mcp-page-state (يُدمج في batch/2026-09-29d) · الحالة: review

## المشكلة والهدف
على هب المالك (صورة اختبار من `main` ‏b21554d1 بعد #226):

1. **صفحة MCP** لـClaude Code تقول "That is not allowed in the current state." في قائمة الخوادم وفي بطاقة «أدوات كور هب»،
   مع أن الوكيل «متاح». والملاحظة الزرقاء تذكر هرمز.
2. **تثبيت Codex** ينتهي بـ«خطأ»: `error: unexpected argument '--version' found`.
3. **محادثة Goose** (مثبّت، بلا `config.yaml`) تنتهي بـ«Internal error (agent_error)»، وClaude Code بـ«Authentication required»،
   وبطاقتا الوكيلين تبدوان جاهزتين.
4. **منتقي النموذج** يقول «النموذج الافتراضي» ولا يقول أيّ نموذج.
5. طلب المالك **مسحاً** لما يمكن إدارته في كل وكيل ACP غير MCP وملفات الإعداد (بلا بناء).

**السبب الجذري للبند 1 (بالدليل):**
- عمليات MCP كلها (`agents.listMcpServers` وأخواتها) تمرّ بـ`toolHome()`، ومعها قراءة البطاقة `agents.getHubTools` تمرّ بـ`assertHermes()`.
  الاثنتان ترفضان أي وكيل غير هرمز بـ`409 state_invalid` و`skills_are_hermes_only`.
- في المقابل يعلن الكتالوج `mcp` لـClaude Code وCodex وGemini وGoose وغيرها، فالويب يعرض لها الصفحة.
- هذا ليس تراجعاً من #226. هو قائم منذ البداية، وظهر الآن لأن Claude Code صار «متاحاً» بعد #226.
- أعدت إنتاجه باختبار يقلع الهب كما عند المالك: الجسر مثبّت بتخطيط npm، وفحص الإصدار يجري في `onReady`.
  - هرمز: `200` في الوضعين managed وexternal.
  - كل وكيل غير هرمز: `409 skills_are_hermes_only` في القائمة وفي البطاقة.
- **ما قاله المالك «كل الوكلاء»:** ينطبق على كل الوكلاء البرمجيين. صفحة هرمز تعمل حين يكون لهرمز مجلد
  (runtime_absent وhermes_profile_absent لهما رسائلهما الخاصة، لا هذه الرسالة).
  لم أرَ هب المالك نفسه.

**البند 2:** فحص الصحة يشغّل `--version` لكل جسر، وcodex-acp يخرج بـ2 لأنه لا يعرف الخيار، فيصير الوكيل `failed`.
هذه الفئة نفسها التي عالجها #226 مع claude-code-acp.

**البند 3:** خطأ JSON-RPC من الوكيل كان يُختصر إلى `message` وحدها. تفاصيل `data` وstderr الجسر كانت تضيع.

## القرار والموافقات
مقترح — للمالك أن يؤكد (DECISIONS §138):

- **صفحة MCP لوكيل برمجي تحرّر ملفه هو.** الملف واحد لكل البروفايلات، مثل صفحة «ملفات الإعداد» (§78).
  - **Claude Code:** `mcpServers` في `~/.claude.json`، أو `$CLAUDE_CONFIG_DIR/.claude.json`.
    - الدليل: الجسر 0.16.2 يمرّر `settingSources: ["user","project","local"]`.
    - وفي `cli.js` المضمّن، خوادم نطاق user هي `mcpServers` في الإعداد العام، وتُقرأ عند كل جلسة.
    - Claude Code يعيد كتابة هذا الملف تحت قفل مجلد `<file>.lock` (proper-lockfile، يُعدّ قديماً بعد 10 ثوانٍ).
      المركز يأخذ القفل نفسه، ويعيد القراءة داخله، ويغيّر `mcpServers` فقط، ثم يستبدل الملف بإعادة تسمية.
  - **Gemini CLI وQwen Code:** `mcpServers` في `settings.json`.
    الملف الذي فيه تعليقات يُقرأ ولا يُعاد كتابته، والرد `400 config_has_comments`.
  - **الإيقاف:** لا مفتاح إيقاف لكل خادم في هذه الملفات. الخادم الموقوف يُخرج من ملف الوكيل ويحفظه المركز في
    `<DATA_DIR>/agent-mcp/<agent>.json` (0600) حتى يُعاد تشغيله.
  - **الأسرار:** تُعرض `[stored]` كما في هرمز.
  - **Test وOAuth ومرشّح الأدوات** لهرمز فقط، ولا تُعرض على صفحة وكيل برمجي.
  - **بقية الوكلاء** (Codex وGoose وOpenCode وKimi وGrok وPi) تجيب `409 mcp_not_managed`.
    الصفحة تقول إن خوادمهم في ملف إعداداتهم («ملفات الإعداد»)، بلا رسالة خطأ.
- **بطاقة «أدوات كور هب»** صارت على صفحة أي وكيل ACP، وإعداداتها للبروفايل.
  الوكيل البرمجي يأخذ الخادم في `session/new` (§67)، والبطاقة تقول إنها مشتركة.
- **الملاحظة الزرقاء** تسمّي الوكيل وملفه، وتقول إنه يقرؤها عند بدء المحادثة. لم تعد تذكر هرمز.
- **«مثبّت» تقرّره الملفات لا `--version`.**
  - نوع فحص جديد `installed` لا يشغّل شيئاً: الملف التنفيذي في `bin` الوكيل وقابل للتشغيل. يُستخدم لـClaude Code وCodex.
  - نسخة وكيل npm تُقرأ من `package.json` حزمته.
  - الفحص الذي يعمل ويرفض الخيار، أو يبلغ مهلته، لا يجعل الوكيل خطأ.
  - يفشل فقط ما لا يبدأ: خطأ spawn، أو الخروج بـ126/127، أو ملف غير قابل للتشغيل.
  - هذا يغيّر توقّع اختبار #226: الفحص المعلّق لم يعد `failed`.
- **خطأ الوكيل يقول السبب.**
  - رسالة الخطأ تحمل ما في `data`. وخطأ «Internal error» العاري يحمل آخر أسطر stderr الجسر.
  - الأسرار مقنّعة (`lib/redact-text.ts`)، والطول 600 حرف على الأكثر.
  - إشعار الفشل في الويب يعرف حالات كل وكيل ويضع إجراءً واحداً، وكلمات الوكيل تبقى تحته:
    - Goose ← ملفات إعداده.
    - Claude/Codex/Gemini/Qwen/OpenCode/Pi ← الإعدادات ← النماذج.
    - Kimi/Grok ← تسجيل دخولهما.
- **`Agent.credentials`** (اختياري، `ready`/`missing`، نص لا enum): البطاقة تقول «يحتاج مزوّدًا أو تسجيل دخول».
  - يُحسب لـClaude Code وCodex وGemini وQwen وGoose فقط، من متغيرات يقرؤها الوكيل أو ملف تسجيل دخوله.
  - Goose لا يُعدّ جاهزاً إلا بـ`GOOSE_PROVIDER`.
- **`Agent.agent_default_model`** (اختياري): النموذج الذي تسمّيه إعدادات الوكيل البرمجي نفسه.
  - المنتقي يقول «الافتراضي · <النموذج>»، أو «افتراضي الوكيل نفسه» حين لا يسمّي شيئاً.
  - لهرمز والوكيل المباشر: «الافتراضي · <default_model>».
- **المسح:** `docs/research/agent-features-2026-09.md`، بحث فقط ومع المصادر.
- مرفوض:
  - قائمة MCP يحفظها المركز ويمرّرها في `session/new`: قائمة ثانية لا يراها الوكيل حين يعمل يدوياً.
  - مصافحة ACP كفحص صحة: عملية لكل وكيل عند كل إقلاع.
  - `ErrorCode` جديد: التطبيقات القديمة لا تفكّه.
- **خارج هذا التغيير:** الهواتف ما زالت تقول «النموذج الافتراضي» ولا تعرض الشارة ولا إرشاد الفشل. تُترك لمتابعة لاحقة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- إضافات فقط: `Agent.credentials` و`Agent.agent_default_model`، وكلاهما اختياري ونصّي.
- أسباب جديدة في `details.reason`:
  - `mcp_not_managed` و`config_busy` و`tool_filter_is_hermes_only` (409).
  - `config_has_comments` (400).
- عمليات MCP وبطاقة الأدوات تجيب الآن حيث كانت ترفض.
- `pnpm contracts:compat`: لا كسر مقابل v1.1.5.

## الملفات والتأثير
- **خادم:**
  - `modules/agents/coding-agent-mcp.ts` (جديد)، و`mcp.ts` (تصدير mask/unmask/NAME).
  - `index.ts`: مسارات MCP للوكلاء البرمجيين، وبطاقة الأدوات، و`credentialProbe`.
  - `hub-tools/routes.ts`.
  - `catalog/types.ts` (نوع `installed`)، و`catalog/claude-code.ts` و`codex.ts`.
  - `installer.ts` (`installedVersion` وقاعدة الفحص)، و`adapters/host.ts` (`unstartable`).
  - `adapters/acp.ts` (`describeAcpError` وstderr والفحص)، و`lib/redact-text.ts`.
  - `agent-credentials.ts` و`agent-own-model.ts`، و`service.ts` و`serialize.ts`.
- **ويب:**
  - `agents/AgentMcpScreen.tsx` و`HubToolsCard.tsx` و`toolErrors.ts` و`AgentManagerScreen.tsx`.
  - `chat/RunFailureNotice.tsx` و`ChatScreen.tsx` و`Composer.tsx` و`useComposerControls.ts`، و`screens/NewChatScreen.tsx`.
  - i18n بالعربية والإنجليزية.
- **اختبارات جديدة:**
  - خادم: `coding-agent-mcp.routes.test.ts` (هب يقلع كما عند المالك: هرمز + Claude Code بتخطيط حزمة الجسر،
    و~/.claude.json، والقفل، وGemini بتعليقات، وmcp_not_managed، وcredentials)، و`installer-health.test.ts`
    (كل وكلاء الكتالوج ببرنامج يرفض `--version`)، و`agent-credentials.test.ts` و`agent-own-model.test.ts` و`adapters/acp-errors.test.ts`.
  - ويب: `agent-mcp-coding.test.tsx` و`agent-run-help.test.tsx` و`default-model-label.test.ts`.
  - معدّلة: `tests/unit/boot-slow-agents.test.ts` (القاعدة الجديدة)، و`agent-versions.test.tsx` (الشارة).
  - الاختبارات الجديدة للخادم تفشل على الكود القديم؛ جرّبت ذلك لـ`coding-agent-mcp.routes.test.ts` (5 من 5 تفشل).
- **وثائق:** `docs/contracts/DECISIONS.md` §138، و`docs/STATUS.md`، و`docs/research/agent-features-2026-09.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:compat
contracts:compat  OK — no breaking change against v1.1.5
$ pnpm contracts:check-clients
check-clients  OK — 1135 client file(s) scanned, 268 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 41 destinations, 2 pre-auth screens (login, setup), 47 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm typecheck
(exit 0)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm contract:test
 Test Files  20 passed (20)
      Tests  429 passed (429)
$ (server) vitest run coding-agent-mcp.routes installer-health agent-credentials agent-own-model acp-errors
    boot-slow-agents mcp mcp-last-test.routes hub-tools agents adapters runner
 Test Files  14 passed | 2 skipped (16)
      Tests  172 passed | 3 skipped (175)
$ (web) vitest run agent-mcp-coding agent-run-help default-model-label agent-versions run-failure-notice
    hub-tools-card mcp-tools mcp-oauth composer
 Test Files  9 passed (9)
      Tests  63 passed (63)
```
- **CI على #227 عند 10f700a1** فشل في «Web smoke journeys»: `pseudo-locales` ‏(ar-XB، الهاتف، `/agents`) وجد رأس بطاقة Claude Code
  يفيض (324px تحمل 329px)، بسبب شارة «يحتاج مزوّدًا أو تسجيل دخول» الثانية في الرأس. الإصلاح: صارت سطراً خاصاً (Notice) تحت الرأس.
- محلياً بعد الإصلاح:
```
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzzzzzzzzzzzzz-pseudo-locales.spec.ts --workers=1
  ✓  3 [chromium] › e2e/zzzzzzzzzzzzzzzzz-pseudo-locales.spec.ts:77:3 › ar-XB: every main screen fits at desktop and phone width (35.4s)
  5 passed (2.5m)
```
- **CI على #227 عند 24fc170f:** كل الفحوص ناجحة (Web smoke journeys، وServer unit tests 1–3/3، وReal Hermes suites،
  وiOS، وAndroid، وDocker، وTranslations fit their labels، وغيرها). «Upload the listing to App Store Connect» تُتخطّى كالعادة.

## المخاطر والرجوع
- **الكتابة في `~/.claude.json`** ملف حالة Claude Code.
  - الحماية: القفل نفسه، وإعادة القراءة داخله، والكتابة الذرّية، وعدم لمس غير `mcpServers`.
  - الرجوع: حذف الخادم من الصفحة، أو تعديل الملف يدوياً.
- **قاعدة الصحة الجديدة** قد تُظهر «متاح» لتثبيت معطوب يبدأ ثم ينهار.
  هذا مقصود: الخطأ يظهر عند المحادثة بسببه الحقيقي (البند 3).
- **`credentials`** استدلال من ملفات معروفة. عند الشك لا يقول شيئاً (غائب)، ولا يمنع التشغيل.
- لا ترحيل بيانات. الرجوع: revert للكوميتات.

## التسليم والخطوة التالية
- الكوميتات على `fix/agent-mcp-page-state`، ثم دُمجت في `batch/2026-09-29d` (PR #227).
- بعدها للمالك: سحب صورة الاختبار ثم تجربة ما يلي:
  - صفحة MCP لـClaude Code.
  - تثبيت Codex.
  - محادثة Goose بلا مزوّد.
- متابعات مقترحة:
  - الهواتف (الشارة، والإرشاد، واسم النموذج الافتراضي).
  - صفحة MCP لـCodex وOpenCode وKimi وGrok (صيغها مؤكَّدة في المسح).
  - صفحة Skills مشتركة (`~/.agents/skills`).
