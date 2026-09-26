# ويب هوك هرمز الواردة، والوسائط في المحادثة، ونماذج الصور خارج نافذة إضافة المزوّد
المسؤول: twuijri · الفرع: feat/hermes-webhooks-media (يُدمج في night/2026-09-27، PR #165) · الحالة: review

## المشكلة والهدف
ثلاثة بنود من قائمة الفجوات مع النسخة القديمة (B9 وB2) وبقية صغيرة:

1. **ويب هوك هرمز الواردة (W14)**: خدمة خارجية (GitHub، نموذج، سكربت) تشغّل الوكيل بموجّه. لهرمز مستقبِل لذلك،
   والمركز لم يكن عنده إلا الويب هوك الصادرة. المطلوب في صفحة «القنوات» للوكيل: إنشاء مسار بموجّه، عرض العنوان
   والسر مع زر نسخ، القائمة والحذف، واختبار بطلب محلي، وقول صريح إن الخدمات الخارجية تحتاج عنوانًا عامًا.
2. **الوسائط في المحادثة (W10)**: الفيديو والصوت الذي يصنعه الوكيل لم يكن يعمل في أي مكان، وملفات المحادثة وملفات
   العمل تُرسل كاملة بلا نطاقات بايت (المرفقات فقط كانت تدعمها). المطلوب: قراءة بالنطاق، ومشغّل فيديو وصوت في لوحة
   الملفات الجانبية وداخل الرد لأي صيغة يشغّلها المتصفح، والتقديم يعمل على ملف كبير.
3. **نافذة إضافة المزوّد**: منتقي النموذج الافتراضي كان يعرض نماذج الصور فقط (§87) لأن القائمة في تلك الخطوة بلا
   قدرات.

المصدر: هرمز نفسه (MIT) في الصورة، الوسم `v2026.9.14` — `gateway/platforms/webhook.py` و`hermes_cli/webhook.py`؛
قرئ سلوكه وكُتب بكلماتنا (ADR 0012). لم يُفتح شيء من agent-studio (ADR 0004)؛ قائمة الفجوات بالكلمات العادية فقط.

## القرار والموافقات
النطاق من طلب المالك لليلة. الاختيارات الجديدة **مقترحة — للمالك أن يؤكد** (DECISIONS §97 و§98، وتعديل §87):

1. **مسارات هرمز نفسه**: يكتب المركز المسار في `webhook_subscriptions.json` بشكل هرمز (سر عشوائي ٣٢ بايتًا، الملف
   0600)، ويشغّل مستقبِل البروفايل في `config.yaml` **مربوطًا بـ`127.0.0.1`** على منفذ خاص بالبروفايل (من 18650،
   لا يأخذه بروفايل آخر ولا شيء على الجهاز؛ المنفذ المكتوب يدويًا يبقى). البوابة تتبع كأي تغيير قناة (§85)، وحذف
   آخر مسار يطفئ المستقبِل. المسارات المكتوبة في `config.yaml` يدويًا تُعرض «من config.yaml» ولا تُحذف من هنا.
2. **المركز هو الباب العام**: `POST /api/v1/hermes-webhooks/<بروفايل>/<مسار>` بلا رمز دخول (السر هو الإذن، يتحقق منه
   هرمز)، يمرّر الجسم بايتًا ببايت مع ترويسات التوقيع والحدث إلى مستقبِل البروفايل على الجهاز نفسه، ويجيب بما أجاب؛
   رفض هرمز يعود في غلاف المركز بكلمات هرمز، ولا مستقبِل ← `503`. فلا منفذ جديد يُفتح على المضيف (ترقية Docker
   باستبدال الصورة وحدها تبقى تعمل)، والشرط الوحيد أن **عنوان المركز يصل إليه الإنترنت** — الصفحة تقوله دائمًا،
   وبتحذير حين تكون مفتوحة على عنوان خاص.
3. **الاختبار** يرسل ما يرسله `hermes webhook test` (حدث `test` موقّع بسر المسار) من المركز إلى المستقبِل: يشغّل الوكيل
   مرة بموجّه المسار، ويثبت المسار والمستقبِل لا العنوان العام.
4. **نطاق بايت واحد** على `sessions.readFile` و`knowledge.downloadWorkspaceFile` وعناوين البث: `206` مع
   `Content-Range`، ونطاق يبدأ بعد النهاية `416` مع `Content-Range: bytes */<الحجم>`، وغير ذلك يُتجاهل ويُرسل
   الملف كله (كما يسمح RFC 9110). المرفقات تبقى على سلوك §90.
5. **`video` و`audio` في `SessionFilePreview`** من الاسم (أو من النوع المخزّن لمرفق لا يقول اسمه شيئًا)، بحد 64
   غ.ب لأن المشغّل يقرأ نطاقًا بعد نطاق.
6. **تذاكر بث للملفات** (آلية §90 بنوع تذكرة ثانٍ): `sessions.createFileStream` و`knowledge.createWorkspaceFileStream`
   (للمالك والمشرف) بنفس شكل `AttachmentStream`، ويخدمها `knowledge.streamFile` بلا رمز دخول، ويفتح الملف من جديد
   بقواعد ملفات العمل في كل قراءة. تذكرة لملف واحد، ساعة، في الذاكرة، وتتوقف حين لا يعود صاحبها قادرًا على دخول
   البروفايل. تُعرض في الصفحة للفيديو والصوت والصور (غير SVG) وPDF فقط؛ الباقي تنزيل.
7. **الويب**: مشغّل `<video>`/`<audio>` في لوحة الملفات (لا تُقرأ البايتات إلى الصفحة؛ «تنزيل» من العنوان نفسه) وفي
   الرد لمرفق نوعه أو اسمه فيديو/صوت؛ صيغة لا يفكّها المتصفح ← الاسم في الرد وملاحظة مع «تنزيل» في اللوحة.
8. **قارئ يتوقف في المنتصف ليس خطأ**: رحلة المتصفح التي تقدّم التشغيل كشفت أن المركز **يسقط** حين يترك المشغّل بقية
   نطاق طلبه (Fastify يرسل خطأ بعد الترويسات فيرمي خارج العملية). المسار نفسه كان في بث المرفقات (§90) — أي فيديو
   طويل في رد كان قادرًا على إسقاط المركز. الإصلاح في `lib/route.ts` (`streamed`): رد أُرسل على نفسه يُنتظر ولا يصير
   اتصالٌ مغلق خطأً.
9. **§87 معدّل**: كل نموذج في جواب `models.probeProvider` يحمل `image_only` بالقاعدة نفسها، ومنتقي النافذة يتركه.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- جديد: `agents.listWebhooks`، `agents.createWebhook`، `agents.deleteWebhook`، `agents.testWebhook`،
  `agents.receiveWebhook` (عام، `x-scope: global`)؛ المخططات `HermesWebhook*` والمعامل `WebhookRouteName`.
- جديد: `sessions.createFileStream`، `knowledge.createWorkspaceFileStream`، `knowledge.streamFile` (عام)؛ المعامل
  `ByteRange` والرد `RangeNotSatisfiable`؛ `206` و`416` على `sessions.readFile` و`knowledge.downloadWorkspaceFile`.
- `SessionFilePreview` += `video`، `audio`. `ProviderProbeResult.models[].image_only` (اختياري).

## الملفات والتأثير
- الخادم: `lib/byte-range.ts` (جديد)، `lib/route.ts` (`streamed`)، `modules/agents/hermes-webhooks.ts` و
  `webhook-routes.ts` (جديدان) وسطر التسجيل في `agents/index.ts`، `modules/sessions/{files,service,routes,ports}.ts`،
  `modules/knowledge/{index,streams,workspace-files,workspace-files-routes}.ts`، `modules/models/service.ts`، i18n.
- الويب: `agents/WebhooksSection.tsx` و`agents/webhooks.ts` (جديدان)، `agents/AgentChannelsScreen.tsx` (المنصة
  `webhook` تخرج من قائمة البطاقات إلى القسم)، `chat/InlineMedia.tsx`، `chat/MessageView.tsx`،
  `files/FilePreviewPanel.tsx`، `models/AddProviderDialog.tsx`، `styles/chat.css`، i18n.
- الاختبارات: `tests/unit/media-ranges.test.ts`، `tests/unit/hermes-webhooks.test.ts`،
  `modules/agents/hermes-webhooks.real.test.ts`، اختبار في `models-api.test.ts`؛ الويب `channels-webhooks.test.tsx`،
  `media-player.test.tsx`، اختبار في `models-screen.test.tsx`، وتعديل `channels-picker.test.tsx`؛ رحلة
  `e2e/zzzzzzzzzz-chat-media.spec.ts` وسيناريو «نغمة طويلة» في `e2e/hub.ts`؛ لقطتان.
- الوثائق: DECISIONS §97 و§98 وتعديل §87، STATUS، COVERAGE.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (عبر `mj-run`)، بعد دمج `origin/night/2026-09-27`:

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck            → exit 0
$ pnpm contracts:lint
contracts:lint  validating 96 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 684 client file(s) scanned, 242 contract path(s) known.
$ pnpm i18n:check           → i18n:check  OK
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  390 passed (390)

# الخادم: ملفاتي وما حولها
$ vitest run tests/unit/media-ranges.test.ts tests/unit/hermes-webhooks.test.ts src/modules/models/models-api.test.ts \
    src/modules/sessions/files-api.test.ts src/modules/sessions/files.test.ts src/modules/knowledge/workspace-files-api.test.ts \
    src/modules/knowledge/workspace-files.test.ts src/modules/knowledge/attachments-api.test.ts tests/unit/device-helper.test.ts \
    src/modules/agents/channels.test.ts src/modules/agents/channels-gateway.routes.test.ts
 Test Files  11 passed (11)
      Tests  168 passed | 1 skipped (169)
# ردود ثنائية أخرى تمر بـ lib/route.ts
$ vitest run src/modules/models/speech-api.test.ts src/modules/updates src/modules/agents/avatar.routes.test.ts src/modules/sessions/trajectory-api.test.ts
 Test Files  4 passed (4)
      Tests  22 passed (22)

# هرمز الحقيقي في Docker (الصورة core-hub:morechannels، هرمز v2026.9.14)
$ COREHUB_HERMES_IMAGE=core-hub:morechannels vitest run src/modules/agents/hermes-webhooks.real.test.ts --reporter=verbose
 ✓ |unit| src/modules/agents/hermes-webhooks.real.test.ts > Hermes incoming webhooks (real Hermes gateway; set COREHUB_HERMES_IMAGE) > a signed POST to the hub reaches Hermes, which runs the agent with the route’s prompt 2519ms
      Tests  1 passed (1)
(الحاوية أُزيلت بعده: docker ps -a | grep corehub-webhooks → 0)

# الويب
$ vitest run tests/channels-webhooks.test.tsx tests/channels-picker.test.tsx tests/media-player.test.tsx \
    tests/models-screen.test.tsx tests/reply-files.test.tsx tests/file-preview.test.tsx
 Test Files  6 passed (6)
      Tests  73 passed (73)
$ vitest run tests/i18n.test.ts tests/logical-css.test.ts tests/navigation.parity.test.tsx
 Test Files  3 passed (3)
      Tests  301 passed (301)
$ pnpm --filter @corehub/web build && PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzzzzzz-chat-media.spec.ts e2e/zzzzzzzzz-reply-files.spec.ts e2e/zzzzzz-chat-files.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-chat-files.spec.ts:36:1 › 32. files a run wrote open beside the chat from the Files list and the tool card (3.3s)
  ✓  2 [chromium] › e2e/zzzzzzzzz-reply-files.spec.ts:28:1 › 35. the picture an agent left for the person is drawn on its reply (1.2s)
  ✓  3 [chromium] › e2e/zzzzzzzzzz-chat-media.spec.ts:27:1 › 36. a recording plays in the reply and seeks in the file panel, a byte range at a time (1.5s)
  3 passed (15.2s)
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzz-channels-discord.spec.ts e2e/zzzzz-channels-pairing.spec.ts e2e/zzzzz-channels-telegram.spec.ts
  3 passed (35.1s)
```

قبل الإصلاح في `lib/route.ts` فشلت رحلة 36 مرتين من ثلاث: سجل المركز في الرحلة
`Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client … wrap-thenable.js:75`
ثم `net::ERR_CONNECTION_REFUSED` لكل طلب بعده. بعده نجحت أربع مرات متتالية، واختبار الخادم «a player that stops
reading half-way» يفشل على الشيفرة القديمة بخمسة أخطاء غير ملتقطة ويمر الآن.

CI على #165 عند `2b03bb18`: فشل فحصان من هذه المهمة وأُصلحا —
- `status.test.ts` («the contract grew or shrank … expected 329 to be 337»): العدد في رأس STATUS صار
  **328 of 337**؛ محليًا `vitest run tests/unit/status.test.ts` → `Tests  1 passed (1)`.
- Android `ContractExamplesTest` («POST /agents/{agent_id}/webhooks/{route_name}/test (HermesWebhookTestResult):
  Serializer for class 'Any' is not found»): `HermesWebhookTestResult.body` صار `type: [object, 'null']` مع
  `additionalProperties: true` كبقية الكائنات الحرة في العقد. محليًا (JDK 17، `generate:native` ثم
  `./gradlew :app:testDebugUnitTest --tests hub.core.android.contract.ContractExamplesTest`):
  `BUILD SUCCESSFUL`، `tests="1" skipped="0" failures="0"`، `contract examples decoded: 271`.

## المخاطر والرجوع
- **الباب العام بلا رمز دخول**: الحماية سر المسار الذي يتحقق منه هرمز (HMAC)، مع حد ١ م.ب وحد المعدل عند هرمز. المستقبِل
  نفسه على `127.0.0.1` فلا يصل إليه أحد إلا عبر المركز. مسار بلا سر يتجاهله هرمز.
- **المنافذ 18650–18999** داخل الحاوية أو على الجهاز المحلي؛ يُتخطى المنفذ المشغول.
- `lib/route.ts` يمس كل رد ثنائي: الرد ما زال يُنتظر حتى ينتهي كما كان، والفرق أن الاتصال المغلق لا يصير خطأ.
- الرجوع: استرجاع دمج هذا الفرع؛ لا ترحيل قاعدة بيانات. ملفات هرمز التي كتبها (مسارات ومستقبِل) تبقى صالحة لهرمز نفسه.

## التسليم والخطوة التالية
- يُدمج في `night/2026-09-27` (PR #165)، لا طلب دمج مستقل.
- للمالك: تأكيد §97 (المركز بابًا عامًا، المنافذ، `deliver` = `log` أو قناة مشغّلة) و§98 (حد 64 غ.ب، أنواع العرض في
  الصفحة) وتعديل §87.
- لاحقًا: تحرير مسار موجود؛ المهارات والأحداث المرشِّحة الأعمق (`filter`) التي يدعمها هرمز؛ مشغّل الوسائط في صفحة
  «الملفات» (B20) والهواتف (B3/B4)؛ الملف الذي يسمّيه رد من مجلد العمل يفتح في اللوحة ويعمل هناك، ولا يُرسم داخل الرد.
