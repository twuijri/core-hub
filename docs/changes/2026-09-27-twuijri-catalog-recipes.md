# وصفات التثبيت بمجموع تحقق مثبّت (Goose وGrok Build) وتسجيل دخول الوكيل إلى حسابه (Kimi Code)
المسؤول: twuijri · الفرع: feat/catalog-recipes · الحالة: review

## المشكلة والهدف
كل وكلاء الكتالوج كانوا حزم npm. Goose وGrok Build يُوزَّعان ملفًا تنفيذيًا (Rust) لا حزمة npm، فلم يكن للمركز
طريق لتثبيتهما. وKimi Code لا يقرأ مفتاحًا من البيئة: يعمل بحسابه الخاص (`kimi login`)، ولم يكن في المركز ما
يسجّل دخوله. الدفعة B21 من قائمة الفجوات: وصفة تنزيل مثبّتة الإصدار ومجموع التحقق، وإدخالا Goose وGrok Build،
وتسجيل دخول Moonshot لـKimi Code.

## القرار والموافقات
DECISIONS §106 — **مقترح — للمالك أن يؤكد**:
- نوع تثبيت جديد `download`: ملف لكل منصة (`linux-x64`، `linux-arm64`، `darwin-x64`، `darwin-arm64`، `win32-x64`)،
  رابط `https` يحمل رقم الإصدار، وSHA-256 كامل، وطريقة التغليف (`raw` أو `gz` أو `tar.gz` مع مسار الملف داخل
  الأرشيف). المركز ينزّل ملف منصته إلى مجلد مؤقت بجوار مجلد الوكيل، **ويرفضه إن لم يطابق المجموع** قبل فكّ أو
  تشغيل أي شيء، ويأخذ الملف التنفيذي المسمّى فقط إلى `bin/`، ثم فقط يستبدل `<DATA_DIR>/agents/<id>`؛ فالتنزيل
  المرفوض لا يمسّ التثبيت السابق. داخل مجلد البيانات كما في ADR 0006، بلا تغيير في الصورة أو Compose.
- لا تحديث تلقائي لهذا النوع: الترقية طلب دمج يغيّر الإصدار وكل المجاميع معًا.
- تسجيل دخول الوكيل إلى حسابه (`agents.startSignIn`، `agents.getSignIn`، `install.sign_in`): المركز يشغّل أمر
  الدخول الخاص بالوكيل بكود الجهاز، ويعرض الرابط والرمز، ويتبع العملية. الوكيل يحفظ بيانات الدخول في مجلده؛ لا
  يمرّ رمز عبر المركز. للمشرفين فقط.
- منطقة Kimi هي `global` (kimi.ai)؛ حساب الصين (kimi.com) غير معروض — مقترح.

**ما أُضيف وما لم يُضف ولماذا:**
- **Goose 1.52.0** (Block، الآن في Agentic AI Foundation، المستودع `aaif-goose/goose`): Apache-2.0، يدعم ACP
  (`goose acp`). المجاميع هي التي ينشرها GitHub لملفات الإصدار، وتحققتُ منها بتنزيل كل ملف. يحتاج
  `GOOSE_PROVIDER` و`GOOSE_MODEL` (بدونهما يرفض ACP فتح جلسة — جرّبته)، فأُضيف ملفه `~/.config/goose/config.yaml`
  إلى صفحة ملفات الإعداد. ويندوز غير معروض (ينشر `.zip` فقط).
- **Grok Build 1.0.41** (xAI، المصدر `xai-org/grok-build`): Apache-2.0، يدعم ACP (`grok agent --no-leader stdio`)،
  ويقرأ `XAI_API_KEY`، وله دخول بكود الجهاز (`grok login --device-auth`) فأُضيف له تسجيل الدخول أيضًا. xAI ينشر
  الملف على `https://x.ai/cli/` لا على GitHub، **ولا ينشر مجموع تحقق**: حسبتُ SHA-256 للملفات الرسمية نفسها
  وطابقتُ كل ملف مع MD5 الذي يعلنه التخزين خلف ذلك الرابط. ويندوز غير معروض (ملف `.exe` مجرد). ملاحظة: الدخول
  بالحساب يتطلب اشتراك SuperGrok أو X Premium+، والبديل مفتاح xAI من صفحة النماذج.
- **Kimi Code**: `kimi login` تدفق كود جهاز يطبع الرابط والرمز ولا يحتاج متصفحًا على المركز (جرّبته على 2.1.1)،
  فدُعم بالطريقة نفسها. طريق المفتاح: كتلة مزوّد بـ`api_key` في `config.toml` من صفحة ملفات الإعداد.
- لم يُتخطَّ أي وكيل بسبب الترخيص: الاثنان Apache-2.0 وتوزيعهما يسمح بالتنزيل من الرابط الرسمي.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عمليتان جديدتان: `POST /agents/{agent_id}/sign-in` (`agents.startSignIn`) و
  `GET /agents/{agent_id}/sign-in/{sign_in_id}` (`agents.getSignIn`)، بجسم `ProviderSignIn` الموجود.
- `AgentInstall.sign_in` (منطقي اختياري)، ووصف `AgentInstall.package` يذكر أنه `null` لوكيل التنزيل.

## الملفات والتأثير
- `packages/server/src/modules/agents/catalog/types.ts`، `catalog/index.ts` — نوع `download`، `signIn`، وحارس الكتالوج
  (إصدار دقيق، `https`، الرابط يحمل الإصدار، SHA-256 كامل، مسار نسبي بلا `..`).
- `catalog/goose.ts`، `catalog/grok-build.ts` (جديدان)، `catalog/kimi-code.ts` (`signIn`).
- `download-install.ts` (جديد) و`installer.ts` — التنزيل والتحقق والفك والاستبدال.
- `agent-sign-in.ts` (جديد)، `index.ts` (المساران)، `serialize.ts` (`sign_in`)، `config-files.ts` (Goose، `yaml`).
- `packages/web/src/agents/AgentSignInCard.tsx` (جديد)، `AgentSettingsScreen.tsx`، `i18n/ar.json`، `i18n/en.json`.
- الاختبارات: `download-install.test.ts`، `agent-sign-in.test.ts`، `config-files.routes.test.ts`، `agents.test.ts`،
  `packages/web/tests/agent-sign-in.test.tsx`.
- `packages/web/e2e/smoke.spec.ts` (الرحلة 6: أحد عشر وكيلًا) ولقطات `e2e/shots/agents-*`.
- `docs/contracts/DECISIONS.md` (§106)، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run`، بعد دمج `origin/night/2026-09-27`:
```
pnpm typecheck                exit=0
pnpm lint                     exit=0   (eslint . && prettier --check . — All matched files use Prettier code style!)
pnpm i18n:check               exit=0   (web: 3169 keys, ar/en in parity … OK)
pnpm nav:check                exit=0
pnpm contracts:lint           exit=0   (Your API description is valid; 1 warning at 7405:21, not from this task)
pnpm contracts:check-clients  exit=0

vitest --project unit download-install.test.ts agent-sign-in.test.ts agents.test.ts
  update-policy.test.ts config-files.routes.test.ts tests/unit/status.test.ts
  Test Files  6 passed (6)   Tests  75 passed (75)
vitest --project contract tests/contract/contract.test.ts
  Test Files  1 passed (1)   Tests  352 passed (352)
web vitest tests/agent-sign-in.test.tsx tests/agent-versions.test.tsx tests/config-files.test.tsx
  Test Files  3 passed (3)   Tests  12 passed (12)
```
فحص Docker حقيقي على الصورة المبنية من هذا الفرع (`docker build -f packages/server/Dockerfile`، ثم حاوية على
منفذ محلي ومجلد بيانات مؤقت، ثم حُذفت الحاوية والمجلد والصورة):
```
POST /agents/{goose}/install      -> goose -> available 1.52.0 /data/agents/goose/bin/goose
POST /agents/{grok-build}/install -> grok-build -> available 1.0.41 /data/agents/grok-build/bin/grok  sign_in=True
goose acp  (initialize)                 -> {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,…
grok agent --no-leader stdio (initialize) -> {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,…
POST /agents/{kimi-code}/install  -> kimi-code -> available 2.1.1 sign_in=True
POST /agents/{grok-build}/sign-in -> HTTP201 {"status":"pending","verification_url":"https://accounts.x.ai/oauth2/device?user_code=<redacted>",…}
POST /agents/{kimi-code}/sign-in  -> HTTP201 {"status":"pending","verification_url":"https://www.kimi.ai/code/authorize_device?user_code=<redacted>",…}
GET  …/sign-in/{id} (both)        -> poll: pending
```
التحقق من المجاميع (تنزيل الملفات الرسمية بـ`sha256sum`؛ Goose يطابق `digest` في GitHub، وGrok يطابق MD5 التخزين):
```
4aee1f770b405c44194c0e9407df1fb06bda4c50eee935f0d8fd10731821cc5e  goose-x86_64-unknown-linux-gnu.tar.gz
ae602c4f6e9a785bf087da52c89908d4dc6aa605dcc17bf83293873f626d9c85  goose-aarch64-unknown-linux-gnu.tar.gz
9fb8f60f36b2b2545f5e163a68c54b83c62e5c8baae4914d7aea377623a44cf9  goose-x86_64-apple-darwin.tar.gz
7674b0124aab685c71f8782fb7e65bac100c736ce3de0c9d3bf46ba07910e412  goose-aarch64-apple-darwin.tar.gz
994114d7a4bf7a6cf459975d4e92f0c449ae6ccfaf2a35a69203db08f00bcd02  grok-1.0.41-linux-x86_64.gz
ddbcd9679841b62e9285bb9c57c76570cc7f9ccbbc2b5070f3d5bd5cad2d5c63  grok-1.0.41-linux-aarch64.gz
00cbf7af8f4df204668177a8149f4d222024ab98895220972009d55e417139ff  grok-1.0.41-macos-x86_64.gz
d6c9b5d1dfe3be5b01758b24e11acad377ee22aa7426ad5eb65332cf3a363447  grok-1.0.41-macos-aarch64.gz
```
أول تشغيل لـCI على #165 (الالتزام `2d9d6c84`): كل الفحوص نجحت ما عدا «Web smoke journeys»: الرحلة 6 كانت تعدّ تسعة وكلاء
في صف الاختيار، والكتالوج صار أحد عشر. عُدّل العدد (والتعليق) وأُعيدت لقطات الصف؛ ثم محليًا:
```
PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/smoke.spec.ts -g "agent row" --workers=1
  ✓  1 [chromium] › e2e/smoke.spec.ts:211:3 › web smoke journeys › 6. the agent row gives up labels before options, then overflows into More (1.6s)
  1 passed (11.8s)
```

## المخاطر والرجوع
- ملف Grok Build بلا مجموع رسمي: المجموع المثبّت من تنزيلنا للملف الرسمي؛ إن غيّر xAI الملف تحت الرقم نفسه يفشل
  التثبيت بـ`checksum_mismatch` (وهذا المقصود).
- `tar` من النظام يفك أرشيف Goose (موجود في الصورة وفي macOS ولينكس)؛ الأرشيف مطابق لمجموعه قبل الفك.
- تسجيل الدخول في الذاكرة: إعادة تشغيل المركز تنسى الجلسة المعلّقة (الاستعلام `404`)، ويُعاد البدء.
- الرجوع: استرجاع دمج هذا الفرع؛ مجلدا `goose` و`grok-build` في `<DATA_DIR>/agents` يبقيان ملفات يتيمة يزيلها
  المستخدم أو إلغاء التثبيت قبل الرجوع.

## التسليم والخطوة التالية
مدموج في `night/2026-09-27` (طلب #165). على المالك: تأكيد §106، ومنطقة Kimi `global`. لاحقًا: ويندوز للوكيلين إن
أردناه (فك `.zip` لـGoose، و`.exe` مجرد لـGrok)، وتعليمات Goose العامة (`.goosehints`) بعد التحقق منها.
