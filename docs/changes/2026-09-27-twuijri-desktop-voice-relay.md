# صوت سطح المكتب، والوصول من خارج البيت لمركز الحاسوب
المسؤول: twuijri · الفرع: feat/desktop-voice-relay (يُدمج في night/2026-09-27، PR #165) · الحالة: review

## المشكلة والهدف
1. **الصوت (B11 في قائمة الفجوات):** تطبيق سطح المكتب كان يرفض الميكروفون لكل صفحة (معالج الأذونات يسمح
   بالإشعارات والحافظة فقط)، فالإملاء يفشل بـ«لم يُسمح للمتصفح باستخدام الميكروفون»، وفي Electron يوجد
   `webkitSpeechRecognition` بلا خدمة خلفه فيفشل الاحتياطي أيضًا. وصفحة «هذا الجهاز» تقول «الصوت ليس في تطبيق
   سطح المكتب بعد». المطلوب: الميكروفون مسموح (Electron + `NSMicrophoneUsageDescription` للماك)، الإملاء والقراءة
   بصوت عالٍ عبر المركز كالويب، قسم صوت مطوي داخل «هذا الجهاز» (حالة إذن الميكروفون وزر اختبار)، وعرض نقل
   `corehub.app` القديم إلى سلة المهملات على الماك مرة واحدة (اقتُرح في
   `docs/changes/2026-09-26-twuijri-desktop-app-name.md`).
2. **الوصول من خارج البيت (المرحّل):** `devices.getRelay` / `setRelay` كانتا `501` مؤجلتين (§80). المالك
   (٢٠٢٦-٠٩-٢٦): «كل اللي قلت لك خلها بعدين… سوها». السبب: من يشغّل التطبيق في الوضع المحلي بلا خادم يريد أن
   يصل جواله إلى مركزه من خارج البيت، بحسابه هو: نفق Cloudflare أو Tailscale.

لم يُفتح شيء من agent-studio (ADR 0004). المراجع العامة: مصدر cloudflared (Apache-2.0) للتحقق من `/ready`
وسطر «Updated to new configuration» ومتغيري `TUNNEL_TOKEN` و`TUNNEL_LOG_OUTPUT`، وقائمة SHA-256 المنشورة في
إصدار cloudflared 2026.9.3 على GitHub.

## القرار والموافقات
النطاق قرار المالك. ما يلي **مقترح — للمالك أن يؤكد** (DECISIONS §95):
- **أين يعمل:** مركز شغّله التطبيق (الوضع المحلي) فقط. المركز لا يشغّل شيئًا ولا يحفظ سرًّا؛ يسأل التطبيق عبر قناة
  IPC للعملية الابن، والتطبيق يعمل. أي مركز آخر يجيب `available: false` و`409 relay_unavailable` بدل `501`.
- **Cloudflare:** الشخص ينشئ النفق في لوحته ويعطيه اسمًا عامًا خدمته `http://localhost:<المنفذ>` ويلصق الرمز.
  الرمز مختوم بسلسلة مفاتيح النظام (`safeStorage`)، لا يُعاد ولا يُسجَّل؛ المركز يتحقق من شكله فقط ويمرّره مرة.
  يُنزَّل `cloudflared` عند أول استعمال من إصدارات Cloudflare على GitHub بنسخة مثبتة (2026.9.3) وبصمة SHA-256
  المنشورة لها — وأي ملف آخر يُرفض — ويُحفظ في `<بيانات التطبيق>/tools`، ويعمل بالرمز في `TUNNEL_TOKEN` لا في سطر
  الأوامر، و`--no-autoupdate`، واتصاله من `/ready` الخاص به، ومساراته من سجله (مع تنبيه إن أشار مسار إلى غير منفذ
  المركز)، وإعادة تشغيل بعد التوقف بمهلة متزايدة إلا لرمز ترفضه Cloudflare.
- **Tailscale:** إن كان الحاسوب على شبكة tailnet (عنوان في 100.64.0.0/10) يستمع التطبيق على ذلك العنوان فقط، بمنفذ
  المركز، ويمرّر الاتصال إلى المركز على الحلقة المحلية. اسم MagicDNS من `tailscale status --json` إن وُجد البرنامج.
- **منفذ ثابت:** مركز الوضع المحلي يطلب المنفذ الذي استعمله آخر مرة (`COREHUB_DESKTOP_PORT`) حتى تبقى خدمة النفق
  صحيحة؛ وإن كان مأخوذًا فأي منفذ، والصفحة تُظهر أن المسار يشير إلى مكان آخر.
- **الإقران:** ما دام الطريق مفتوحًا، كل إقران على ذلك المركز `relay` وعنوانه في الرمز `relay_url`؛ وطلب `relay` وهو
  مغلق ← `409 relay_not_connected`.
- **الأمان:** المركز يبقى بتسجيل دخوله؛ النفق يحمل منفذ المركز فقط؛ تحذير صريح قبل التشغيل بأن المركز يصبح قابلًا
  للوصول من الإنترنت عبر نفق الشخص نفسه؛ لا شيء يبدأ قبل أن يشغّله الشخص، ويتوقف مع المركز.
- **الميكروفون:** صوت فقط، لصفحة التطبيق فقط؛ على الماك يُسأل النظام ما دام «لم يُقرَّر»، وما رفضه النظام يبقى مرفوضًا
  (زر يفتح إعدادات الخصوصية). على الماك نص السؤال بالإنجليزية في `Info.plist` وبالعربية في
  `ar.lproj/InfoPlist.strings`، واستحقاق `com.apple.security.device.audio-input` للنسخة الموقّعة (بدونه تسجّل صمتًا).
  تطبيق سطح المكتب لا يرجع أبدًا إلى متعرّف المتصفح (لا خدمة خلفه في Electron).
- **`corehub.app` القديم:** يُعرض مرة واحدة فقط، إن كان في نفس مجلد `Core Hub.app` ومعرّف حزمته أحد معرّفات كور هب
  (`com.twuijri.corehub` أو `io.github.twuijri.corehub`) وليس هو التطبيق العامل؛ «انقلها إلى سلة المهملات» عبر
  `shell.trashItem` — لا حذف نهائي — و«أبقِها». لا يُسأل مرة أخرى بعد أي جواب.
- مرفوض: خدمة ترحيل نديرها (§80)؛ تضمين cloudflared في كل مثبّت؛ الرمز في سطر الأوامر؛ `tailscale serve` (يحتاج شهادات
  HTTPS مفعّلة في الشبكة ويغيّر إعدادات Tailscale عند الشخص).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `Relay`: حُذف `hub_id` ومسار `official`؛ أضيف `available` و`hub_port` و`token_set` و`tunnel_id` و`hostname`
  و`hostnames` (`hostname`, `service`, `matches`) و`tailnet` و`error` (قائمة مغلقة) و`error_detail`؛ `route` صار
  `cloudflare | tailscale | null`.
- `RelayUpdate` (جديد، جسم `setRelay`): `enabled`، `route`، `token` (للكتابة فقط)، `forget_token`، `hostname`؛
  و`setRelay` لم يعد يصدر `job.queued`، وأضيف `409` و`503`.
- `auth.createPairing`: وصف `hub_url` في الوضع المحلي مع الطريق المفتوح، و`409 relay_not_connected`؛ وصف
  `PairingConnection.relay`.
- DECISIONS §95 جديد، و§80 يشير إليه. العمليتان كانتا 501 ولا عميل يستعملهما، فلا عميل يتأثر.

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml`.
- المركز: `packages/server/src/modules/devices/outside.ts` (جديد: `RelayHost`، التحقق من الرمز واسم المضيف، مهلة
  ١٠ ثوانٍ ← `503`)، `devices/index.ts` (المساران)، `app/server.ts` (`BuildOptions.relayHost`، `HubState.relayHost`)،
  `auth/routes.ts` (الإقران). اختبار: `packages/server/tests/unit/devices-relay.test.ts`.
- سطح المكتب: `src/main/microphone.ts`، `legacy-mac-app.ts`، `cloudflared.ts`، `tunnel.ts`، `tailnet.ts`، `relay.ts`
  (جديدة)؛ `src/shared/relay.ts`، `hub-ipc.ts` (جديدة)؛ `controller.ts`، `local-hub.ts`، `hub/entry.ts`، `preload`،
  `shared/config.ts` (`relay`، `localHubPort`، `legacyAppAsked`)، `shared/ipc.ts`، `i18n`؛
  `electron-builder.config.cjs` (الاستحقاقات، `NSMicrophoneUsageDescription`، `ar.lproj`)،
  `assets/entitlements.mac.plist`، `assets/mac/ar.lproj/InfoPlist.strings`، `scripts/build.mjs` (تبقى خارج التطبيق).
  اختبارات: `microphone`، `legacy-mac-app`، `cloudflared` (خادم إصدارات مزيّف)، `tunnel` (cloudflared مزيّف
  `fixtures/fake-cloudflared.mjs`)، `relay`، و`local-hub` (IPC والمنفذ).
- الويب: `src/desktop/VoiceSection.tsx` و`OutsideAccessSection.tsx` (جديدان)، `settings/ThisDeviceTab.tsx`،
  `desktop/bridge-types.ts` (`voice`)، `voice/useDictation.ts`، `screens/DeviceConnectionsScreen.tsx` (سطر عنوان
  الطريق)، و`i18n` بالعربية والإنجليزية. اختبار: `tests/desktop-surface.test.tsx`.
- CI: `.github/workflows/desktop.yml` خطوة ماك تتحقق من `NSMicrophoneUsageDescription` و`ar.lproj/InfoPlist.strings`.
- الوثائق: `docs/contracts/DECISIONS.md` (§95)، `docs/STATUS.md` (العدّ 320، سطر devices، سطر سطح المكتب وحُذف
  «Not yet: voice»)، `docs/contracts/COVERAGE.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبارات الجديدة (كلها جديدة على سلوك لم يكن موجودًا؛ على الكود القديم تفشل لغياب الوحدات والمسارات — المساران
كانا `501`):
```
$ (packages/server) npx vitest run tests/unit/devices-relay.test.ts tests/unit/status.test.ts src/modules/auth/pairing.test.ts tests/unit/devices-push-relay.test.ts
 Test Files  4 passed (4)
      Tests  28 passed (28)
$ (apps/desktop) npx vitest run
 Test Files  18 passed (18)
      Tests  180 passed (180)
$ (packages/web) npx vitest run tests/desktop-surface.test.tsx
 Test Files  1 passed (1)
      Tests  28 passed (28)
$ (packages/web) npx vitest run device-cards devices-push speech-voice-picker voice-chunking voice-dictation voice-recorder
 Test Files  6 passed (6)
      Tests  45 passed (45)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 679 client file(s) scanned, 235 contract path(s) known.
$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  382 passed (382)
$ pnpm i18n:check
i18n:check  web: 2864 keys, ar/en in parity … desktop: 92 keys, ar/en in parity … OK
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop
```
تشغيل حقيقي للمركز المضمَّن المبني (`node scripts/build-hub.mjs` ثم `fork` لـ`hub.mjs` مع أب يجيب أسئلة الطريق كما
يفعل التطبيق، و`COREHUB_DESKTOP_PORT=47913`):
```
hub listening on 47913
GET /relay {"available":true,"enabled":false,"connected":false,"route":null,…}
PUT /relay 200 {"available":true,"enabled":true,"connected":true,"route":"cloudflare","relay_url":"https://hub.example.com","hub_port":47913,"token_set":true,…} token echoed: false
pairing relay https://hub.example.com
app saw [{"op":"get"},{"op":"set","change":{"enabled":true,"route":"cloudflare","token":"<token>","hostname":"hub.example.com"}}]
```
لم يُشغَّل محليًا: اختبار الدخان لسطح المكتب، والمثبّتات، وe2e الويب — يشغّلها CI على #165 (النتيجة أدناه حين تصل).

## المخاطر والرجوع
- **لم يُجرَّب على حقيقي:** لا نفق Cloudflare حقيقي، ولا tailnet حقيقية، ولا سؤال الميكروفون على ماك حقيقي، ولا نسخة
  ماك موقّعة بالاستحقاق الجديد. الخطوات أدناه للمالك.
- صيغة سجل cloudflared (سطر «Updated to new configuration» بـJSON) مأخوذة من مصدر 2026.9.3؛ إن تغيّرت في نسخة لاحقة
  تختفي قائمة المسارات فقط، والاتصال يبقى من `/ready`.
- **ملاحظة أمان قائمة من قبل (ليست من هذا التغيير):** المركز يعمل بـ`trustProxy: true`، فعنوان العميل يُقرأ من
  `X-Forwarded-For` الذي يستطيع العميل تزويره خلف نفق أو وكيل؛ قفل المحاولات بحسب العنوان يمكن تجاوزه هكذا. فتح الطريق
  يجعل هذا أهم. مقترح مهمة منفصلة: الثقة بالوكيل بقدر ما هو موجود فعلًا (مثل `CF-Connecting-IP` عبر cloudflared).
- الرجوع: استرجاع دمج هذا الفرع؛ الإعدادات الجديدة في `desktop.json` تُتجاهل في نسخة أقدم، و`cloudflared` المنزَّل
  يبقى في `tools/` ولا يُشغَّل.

## التسليم والخطوة التالية
دُمج في `night/2026-09-27` (#165). خطوات المالك لتجربة النفق (بعد تثبيت نسخة الاختبار في الوضع المحلي):
1. «الإعدادات ← هذا الجهاز ← الوصول من خارج البيت»، اختر «نفق Cloudflare»، وانسخ الخدمة `http://localhost:<المنفذ>`.
2. في Cloudflare: Zero Trust ← Networks ← Tunnels ← Create a tunnel ← Cloudflared، سمّه، ثم Public hostname على نطاقك
   (مثل `hub.example.com`) والخدمة ما نسخته.
3. من صفحة التثبيت انسخ النص الطويل بعد `--token` والصقه، واكتب اسم المضيف، ثم «شغّل». أول مرة ينزّل cloudflared
   (قرابة ٢٠–٥٠ م.ب).
4. حين تظهر «متصل» افتح «ربط الأجهزة» واقرن الجوال؛ الرمز يحمل `https://hub.example.com`. جرّب من شبكة الجوال لا
   الواي فاي.
5. Tailscale بديلًا: ثبّت Tailscale على الحاسوب والجوال بالحساب نفسه، اختر «Tailscale» ثم «شغّل» واقرن.
6. الصوت على الماك: «هذا الجهاز ← الصوت ← اختبر الميكروفون» يجب أن يُظهر سؤال النظام بالعربية مرة واحدة، ثم ما سمعه
   المركز. وإن كان `corehub.app` القديم في Applications يظهر سؤال نقله إلى سلة المهملات بعد ثوانٍ من الفتح.
