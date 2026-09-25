# وكلاء برمجة أكثر في الكتالوج، وسياسة تحديث لهم
المسؤول: twuijri · الفرع: feat/agents-catalog-more · الحالة: review

## المشكلة والهدف
الكتالوج المنسَّق (ADR 0006) فيه هرمز و«مباشر» وأربعة وكلاء برمجة فقط (Claude Code وCodex CLI
وGemini CLI وOpenCode). اقترح تقرير المراقب إضافة Pi، وأداة Grok من xAI، وأداة DeepSeek، والنظر في
Qwen Code وGoose وKimi. والهدف الثاني: الوكلاء تُثبَّت بإصدار مثبَّت (pin)، و`latest_version` كان هو
الـ pin نفسه، فلا يعرف المركز أبدًا أن للوكيل إصدارًا أحدث، ولا يستطيع أن يأخذه. المطلوب:
- إضافة وكلاء حقيقيين، رخصتهم متوافقة، يتكلمون ACP بأنفسهم أو عبر محوّل صيانته قائمة، بإصدار دقيق
  ورخصة وقدرات وعلامة لكل واحد، وتسجيل المرفوض وسببه.
- فحص دوري كل ست ساعات لإصدار أحدث (npm / PyPI) بلا تثبيت، وشارة «تحديث متاح»، وتحديث تلقائي اختياري
  لا يعمل إلا والوكيل خامل ويُمسك التشغيلات الجديدة أثناءه، مطفأ افتراضيًا؛ ويبقى الـ pin هو النسخة
  المختبرة، والواجهة تقول «أحدث من النسخة المختبرة».

## القرار والموافقات
المالك نائم؛ كل قرار هنا **مقترح — ينتظر تأكيد المالك** (DECISIONS §68).

**ما أُضيف** (تحقّقت من كل واحد على السجل نفسه وبتثبيت فعلي بأمر المركز ذاته
`npm install --global --prefix <dir> --no-fund --no-audit …` في مجلد مؤقت، ثم أرسلت `initialize` بـ ACP
على stdio وقرأت الرد):

| الوكيل | الحزمة والإصدار | الرخصة | ACP | الملاحظة |
| --- | --- | --- | --- | --- |
| Qwen Code | `@qwen-code/qwen-code@0.24.5` | Apache-2.0 | أصلي: `qwen --acp` | يرد بـ loadSession وMCP (http/sse) وطريقة مصادقة بمفتاح OpenAI |
| Kimi Code | `@moonshot-ai/kimi-code@2.1.1` | MIT | أصلي: `kimi acp` | خلف `kimi-cli` (Python) المؤرشف منذ 2026-09-22 |
| Pi | `@earendil-works/pi-coding-agent@0.87.1` + `pi-acp@0.0.34` | MIT / MIT | عبر المحوّل `pi-acp` (في سجل ACP) | الحزمة القديمة `@mariozechner/…` متوقفة؛ `pi-acp --version` لا يطبع شيئًا، ففحص الصحة يسأل `pi` |

- **Pi يحتاج حزمتين**، فصار لوصفة npm حقل `companions` (كل حزمة بإصدار دقيق، في مجلد الوكيل نفسه)، ولفحص
  الصحة حقل `binary` اختياري. و`pi-acp` يشغّل `pi` من PATH، فصار محوّل ACP يضع مجلد الوكيل **أولًا** في
  PATH الابن (`agentEnvironment`)، فيقود المحوّلُ الـ `pi` المثبَّت بجانبه لا غيره.
- القدرات من رد `initialize`: Qwen وKimi: `streaming, tools, approvals, mcp, resume`؛ Pi:
  `streaming, tools, resume` (لا موافقات — Pi لا يسأل بطبعه — ولا MCP لأن `pi-acp` لا يمرّره). لم أدّعِ
  `vision` لأي منها، كالمدخلات الموجودة.
- المفاتيح (ADR 0010): Pi يقرأ مفاتيح المزوّدين القياسية (من `docs/providers.md` عنده)؛ Qwen: OpenAI
  (يختار وضعه وحده) وAnthropic وGemini؛ **Kimi لا شيء** — يقرأ المفاتيح من `config.toml` أو `kimi login`
  فقط (من `env-vars.md` عنده)، فتمرير مفتاح لا يفيد؛ يدخل بحسابه حتى يصير عند المركز صنف اعتماد لـ Moonshot.
- العلامات: `qwen.svg` و`kimi.svg` و`pi.svg` («Pi Agent»، https://pi.dev) من `@lobehub/icons-static-svg`
  1.95.1 (MIT، نفس المصدر والإصدار الموجودين) في `ui/brand/marks.tsx`، والإشعار محدَّث.
- حارس الكتالوج صار أشد: إصدار **مستقر دقيق** `x.y.z` لكل حزمة ومرافقة (يرفض النطاق والوسم وما قبل
  الإصدار)، حزمة لا تُذكر مرتين، رخصة من قائمة مقبولة (`ACCEPTED_LICENCES`: MIT وApache-2.0 وBSD-2/3
  وISC ورخصة المركز) — الرخص الناسخة قرار للمالك لا لـ PR — وكل وكيل ACP له ملف تنفيذي.

**ما رُفض ولماذا:**
- **Grok Build (xAI)** — حقيقي، Apache-2.0، يدعم ACP (أُطلق 2026-05، v1.0 في 2026-08). لكنه يُثبَّت فقط
  بـ `curl -fsSL https://x.ai/cli/install.sh | bash` (ثنائي Rust)، بلا حزمة npm/PyPI، ومستودع
  `xai-org/grok-build` بلا إصدارات ولا وسوم. الكتالوج لا يثبّت إلا حزمة سجلّ بإصدار دقيق، ولا يشغّل سكربتًا
  من الشبكة. ويتطلب اشتراك SuperGrok / X Premium+ (أو `XAI_API_KEY`). يُعاد النظر عند حزمة أو إصدار
  موسوم بمجموع تحقق.
- **`@vibe-kit/grok-cli`** (MIT، 0.0.34) — ليس من xAI، آخر نشر 2025-11-27، ولا ACP.
- **DeepSeek Harness** (`@deepseek-ai/dsh`، MIT؛ محوّل ACP `@deepseek-ai/dsh-acp`، BSD-3-Clause) — حقيقي،
  لكن لا إصدار مستقر: وسم `latest` نفسه `0.1.5-rc.3` والمحوّل `0.0.1-rc.1`، والمشروع «معاينة للمطورين
  مع تغييرات كاسرة متوقعة». الحارس يرفض ما قبل الإصدار. يُعاد النظر عند أول إصدار مستقر.
- **Goose** (AAIF، Apache-2.0، v1.52.0، `goose acp` أصلي) — ثنائي Rust يوزَّع بإصدارات GitHub وسكربت
  تثبيت؛ حزمة npm `@aaif/goose` مجرد واجهة طرفية (`goose-tui`) تحتاج الثنائي. يُرفض حتى تكون للكتالوج
  وصفة «تنزيل ملف بمجموع تحقق مثبَّت» (مقترح لاحق).
- **Kimi CLI** (`kimi-cli` على PyPI، Apache-2.0) — مؤرشف 2026-09-22 و«سيتوقف عن العمل»؛ أُضيف خلفه Kimi Code.

**سياسة التحديث** (`modules/agents/update-policy.ts`):
- الـ pin هو **النسخة المختبرة**: التثبيت الجديد يأخذه بالضبط، والعقد يعرضه `install.pinned_version`.
- كل ست ساعات (أول مرة بعد دقيقتين من الإقلاع) وعند `check-update` يسأل المركز السجل — وسم `latest` في npm
  أو JSON في PyPI — عن أحدث إصدار **مستقر** لكل وكيل ثبّته هو، **بلا تثبيت**، ويسجّله `latest_version`
  (ولا يكون أقدم من الـ pin). ما قبل الإصدار المعلَّم `latest` لا يُعرض. سجلّ لا يرد يُفشل `check-update`
  (`service_unavailable`) بدل «لا تحديث»، والفحص الدوري يسجّله في السجل ويكمل.
- التحديث يثبّت ذلك **الإصدار الدقيق** `package@x.y.z`، أبدًا الوسم المتحرك؛ والمثبِّت يرفض أي قيمة غير
  إصدار مستقر قبل أن يبحث عن npm. المرافقة (`pi-acp`) تنتقل إلى أحدث إصدار مستقر لها، أو تبقى على
  الـ pin إن لم يرد السجل.
- `newer_than_tested`: المثبَّت (بيد المركز) أحدث من الـ pin. الواجهة: شارة «أحدث من النسخة المختبرة» على
  البطاقة، و«تحديث متاح: X — أحدث من النسخة المختبرة» حين يكون العرض بعد الـ pin، و«النسخة المختبرة: X»
  مع تنبيه في صفحة الإعدادات.
- **التحديث التلقائي** لكل وكيل (الحقل الموجود `auto_update`)، **مطفأ افتراضيًا**؛ لم أضف مفتاحًا عامًا
  (وكيل ينكسر لا يجب أن يوقف غيره). لا يبدأ إلا والوكيل بلا تشغيل جارٍ (`AgentRunner.busyFor`)، والمشغول
  يُعاد تجربته بعد عشر دقائق. يُسجَّل مهمةً تحت البروفايل الافتراضي، وفي التدقيق `system`.
- **الإمساك**: أثناء أي تحديث (`install_state = updating`) التشغيل المطلوب ينتظر انتهاءه (15 دقيقة على
  الأكثر، `AgentsService.settled`) بدل أن يبدأ على أداة تُستبدل؛ وبعده تُغلق جلسات الوكيل المفتوحة (الخامل
  فورًا، والمشغول عند نهاية دوره) فيبدأ الدور التالي الأداة الجديدة ويستأنف بمرجعه المخزَّن.
- التحديث اليدوي أثناء تشغيل جارٍ ما زال مسموحًا (خيار المالك)؛ الدور الجاري يكمل على العملية القديمة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `AgentInstall`: حقلان جديدان إلزاميان `pinned_version` (نص أو null) و`newer_than_tested` (منطقي)، مع
  أوصاف لـ `latest_version` و`update_available` و`auto_update`؛ الأمثلة الأربعة محدَّثة.
- `agents.upgrade` و`agents.checkUpdate`: أوصاف تقول إن التحديث إصدار دقيق، ونتيجة الفحص صارت
  `{ latest_version, pinned_version, update_available }`، وسجلّ لا يرد يُفشل المهمة.
- `events/common.schema.json` و`events/jobs/agent.updated.schema.json`: الحقلان نفسهما.
- DECISIONS §68 (مقترح).

## الملفات والتأثير
- `packages/server/src/modules/agents/catalog/{qwen-code,kimi-code,pi}.ts` (جديدة)، `catalog/index.ts`
  (التسجيل والحارس و`ACCEPTED_LICENCES`)، `catalog/types.ts` (`companions`، `health.binary`، `pinnedPackages`).
- `packages/server/src/modules/agents/update-policy.ts` (جديد): مقارنة الإصدارات، عميل npm/PyPI،
  `AgentUpdateChecker` (الفحص الدوري والتحديث التلقائي عند الخمول).
- `service.ts`: `checkUpdate` يسأل السجل، `updateTarget`، `recordLatest`، `autoUpgrade`، `settled`/`onSettled`،
  `latest_version` لا يُعاد إلى الـ pin عند الإقلاع. `runner.ts`: `busyFor`، الإمساك، `retireSessionsOf`.
  `installer.ts`: إصدارات دقيقة لكل حزمة، رفض غير المستقر، ملف فحص الصحة. `adapters/acp.ts`:
  `agentEnvironment`. `serialize.ts`: الحقلان. `index.ts`: التركيب وتوقيت الفحص وإيقافه عند الإغلاق.
- `packages/server/tests/unit/helpers.ts`: الاختبارات لا تسأل سجلًا ولا تسلّح المؤقّت افتراضيًا.
- الويب: `agents/versionNotes.ts` (جديد)، `AgentManagerScreen.tsx` (الشارات)، `AgentSettingsScreen.tsx`
  (النسخة المختبرة والتنبيه)، `ui/brand/marks.tsx` (ثلاث علامات)، `i18n/{ar,en}.json` (أربعة مفاتيح ونص
  التلميح).
- الاختبارات: `update-policy.test.ts` (جديد، 22)، `agents.test.ts` (الحارس والكتالوج وفحص غير المثبَّت)،
  `web/tests/agent-versions.test.tsx` (جديد)، `web/tests/agent-chips.test.tsx` (العلامات).
- الوثائق: `docs/domain/agents.md` (§Updates)، `docs/STATUS.md`، `THIRD-PARTY-NOTICES.md`، DECISIONS §68.
- الصورة لا تتغير: الوكلاء يُثبَّتون عند الطلب في مجلد البيانات. الشبكة: المركز يسأل `registry.npmjs.org`
  كل ست ساعات عن الوكلاء المثبَّتين فقط (لا شيء إن لم يُثبَّت شيء).

## الفحوص (الأوامر ونواتجها الفعلية)
تثبيت وتحقق ACP على جهاز التطوير (خارج الصورة، بأمر المركز ذاته):
```
$ pi/bin/pi --version; qwen/bin/qwen --version; kimi/bin/kimi --version
0.87.1
0.24.5
2.1.1
== pi/bin/pi-acp  (initialize)
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"pi-acp","title":"pi ACP adapter","version":"0.0.34"},...,"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":false,"sse":false},"promptCapabilities":{"image":true,...}}}}
== qwen/bin/qwen --acp  (initialize)
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"qwen-code","title":"Qwen Code","version":"0.24.5"},...,"mcpCapabilities":{"sse":true,"http":true},...}}
== kimi/bin/kimi acp  (initialize)
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,...,"mcpCapabilities":{"http":true,"sse":true},...}}}
```
المحلية (كلها عبر `mj-run`):
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck; echo "exit=$?"
exit=0
$ pnpm i18n:check
i18n:check  web: 1321 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contracts:lint
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 283 client file(s) scanned, 176 contract path(s) known.
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  274 passed (274)
$ vitest run runner.test.ts adapters/adapters.test.ts agents.test.ts update-policy.test.ts   (server)
 Test Files  4 passed (4)
      Tests  90 passed (90)
$ vitest run tests/agent-versions.test.tsx tests/agent-chips.test.tsx   (web)
 Test Files  2 passed (2)
      Tests  20 passed (20)
```
وبعد أن كشف CI أن رحلة Playwright رقم 6 تعدّ ست رقائق وكلاء (صارت تسعًا بالكتالوج الجديد) صحّحتها
وشغّلتها وحدها (مع لقطاتها الخمس المحدَّثة، وهي من صلب التغيير):
```
$ pnpm build   (exit=0)
$ PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test e2e/smoke.spec.ts -g "agent row gives up labels"
  ✓  1 [chromium] › e2e/smoke.spec.ts:205:3 › web smoke journeys › 6. the agent row gives up labels before options, then overflows into More (1.4s)
  1 passed (8.6s)
```
لم أشغّل مجموعات الخادم والويب وPlaywright كاملة محليًا (قاعدة السرعة)؛ CI يشغّلها. نتيجة CI في
«التسليم». لم أبنِ صورة Docker ولم أجرّب الوكلاء الجدد داخلها.

## المخاطر والرجوع
- **سياسة التحديث تغيّر معنى ADR 0006** («يثبّت هذا الإصدار بالضبط»): التثبيت الجديد ما زال بالـ pin، لكن
  التحديث قد يأخذ إصدارًا لم يُختبر. التحديث التلقائي مطفأ افتراضيًا، والواجهة تسمّي ذلك صراحة. إن رفض
  المالك: إرجاع `recordLatest` إلى الـ pin وحذف المؤقّت يعيد السلوك القديم، والحقلان في العقد يبقيان صادقين.
- الشبكة: المركز يتصل بـ npm كل ست ساعات (فقط إن كان وكيل مثبَّتًا). بلا شبكة: سطر تحذير في السجل، لا أكثر.
- `pi-acp` إصداره `0.0.x`، وPi لا يمرر MCP؛ Kimi يحتاج تسجيل دخول خاص به. لم يُجرَّب دور حقيقي لأي منها.
- الإمساك حدّه 15 دقيقة؛ بعده يرى التشغيل حالة الوكيل كما هي (يفشل إن لم يعد مثبَّتًا).
- الرجوع: revert لهذا الـ PR. لا ترحيل قاعدة بيانات؛ الوكلاء الجدد صفوف كتالوج تظهر «غير مثبَّت» وتختفي
  بالرجوع (صف يتيم لا يضر؛ الإقلاع يوافق الجدول مع الكتالوج).

## التسليم والخطوة التالية
- PR #140 إلى `main` بالإنجليزية. CI على الالتزام `e2e: the agent row holds nine catalog agents now`
  (التشغيل 36112056690) أخضر كله:
```
Lint, typecheck, contracts, tests, build | pass | 14m47s
Web smoke journeys (Playwright against the real hub) | pass | 5m19s
Docker image builds and answers /health | pass | 2m35s
db:generate + db:migrate (SQLite and PostgreSQL) | pass | 1m12s
PR adds or updates a change record | pass | 10s
PR leaves graphify-out/ to the code-map bot | pass | 10s
```
  (التشغيل الأول فشل في رحلة Playwright 6 فقط، بسبب عدد الرقائق؛ صُحّحت.)
- للمالك: تأكيد DECISIONS §68 (الـ pin خط أساس مختبر، التحديث بإصدار دقيق، التلقائي عند الخمول ومطفأ
  افتراضيًا، الإمساك 15 دقيقة، قائمة الرخص المقبولة)، وإضافة Qwen Code وKimi Code وPi، ورفض Grok Build
  وDeepSeek Harness وGoose مؤقتًا.
- لاحقًا: وصفة «تنزيل بمجموع تحقق» (تفتح Goose وGrok Build)، وصنف اعتماد Moonshot لـ Kimi، ودور حقيقي
  للوكلاء الجدد داخل الصورة.
