# مرحّل إشعارات كور هب على Cloudflare Workers
المسؤول: twuijri · الفرع: feat/push-relay · الحالة: review

## المشكلة والهدف
تطبيقا iOS (`com.twuijri.corehub`) وأندرويد للمالك: لا يصلهما إشعار إلا بمفتاح APNs من فريقه في Apple
وحساب خدمة FCM من مشروعه في Firebase. حتى الآن لا يدفع المركز إلى الهواتف إلا إذا لصق مشرفه هذين
المفتاحين فيه، أي أن يرسل المالك مفاتيحه لكل من يشغّل مركزًا. قال المالك: «لا ابيه جاهز للناس مهب كل مره
برسله لهم». المطلوب: مراكز الناس تدفع إلى الهواتف بلا أي إعداد، ومفاتيح المالك لا تخرج من يده أبدًا. وضعها
داخل الصورة مرفوض: أي أحد يستخرجها ويدفع لكل مستخدمي التطبيقات.

## القرار والموافقات
قرار المالك (٢٠٢٦-٠٩-٢٥): مرحّل مركزي يشغّله هو على Cloudflare Workers («ايه ابدا ونعتمد على Cloudflare
Workers») — مثل وسيط الإشعارات عند Bitwarden وHome Assistant وMattermost. التفصيل في
`docs/adr/0024-push-relay.md` وقرار العقد §81. ما يلي **مقترح — ينتظر تأكيد المالك**:

1. **المرحّل حزمة في مساحة العمل** `packages/push-relay` (`@corehub/push-relay`) لا `services/`: فيغطّيه
   lint وtypecheck واختبارات المستودع كلها دون إعداد جديد.
2. **التخزين D1** لا KV: الربط «الأول يفوز» يحتاج مفتاحًا أساسيًا ذريًا، والعدّادات تحتاج `INSERT … ON CONFLICT`،
   والـnonce يجب أن يُرفض من ثاني مرة في أي مكان؛ KV متأخّر الاتساق (حتى دقيقة)، وكتابة واحدة في الثانية
   للمفتاح، و١٠٠٠ كتابة يوميًا في الخطة المجانية. D1 مجانًا ١٠٠ ألف صف مكتوب يوميًا (≈ ٣٠ ألف دفعة).
3. **APNs من Worker**: APNs لا يقبل إلا HTTP/2، و`fetch` في Worker منشور يتفاوض على HTTP/2 معه (أبلغ عنه
   آخرون في الإنتاج؛ الفشل المعروف في `wrangler dev` على ماك فقط، workerd#4841). فلا مكتبة ولا مقبس TCP:
   `fetch` عادي ورمز ES256 موقّع بـWebCrypto. **لم نتحقق منه أمام Apple بعد** — لم يُنشر شيء؛ أول نشر
   للمالك هو التحقق (خطوة ٤ في README ثم إشعار تجريبي من مركز).
4. **سرّ المركز لا يُخزَّن أصلًا**: يُشتق `HMAC(HUB_SECRET_KEY, id + salt)` ولا يحفظ D1 إلا الـsalt، فنسخة من
   القاعدة وحدها لا توقّع شيئًا. (الطلب قال «مخزّن مجزّأ»؛ الـhash لا يتحقق به من HMAC، والاشتقاق أقوى.)
   عنوان IP لا يُحفظ إلا مجزّأً بمفتاح داخل عدّاد ساعة.
5. **الربط**: الأول يفوز؛ ينتقل الرمز إلى مركز آخر إذا (أ) أفلته مركزه — عند إلغاء التسجيل أو فصل الجهاز
   فورًا، وعبر `/v1/tokens/sync` حين تتغيّر مجموعة الرموز (كل مسارات التنظيف من سجل
   `2026-09-26-twuijri-push-cleanup-mobile-logs.md`، ومنها انتهاء الجلسة، تصل خلال دقيقة)، ومرة يوميًا على
   كل حال؛ أو (ب) أثبت الجهاز نفسه بتوقيع من مفتاح P-256 صنعه التطبيق مرة لكل تثبيت (الأحدث يفوز بنفس
   المفتاح فقط)؛ أو (ج) لم يُستعمل الربط ٣٠ يومًا. **التطبيقان لا يرسلان الإثبات بعد** (متابعة). الخطر
   الموثّق في ADR: مركز ما زال يعمل وتعرّف على الرمز أولًا يحتفظ به حتى يفلته أو تمضي ٣٠ يومًا، ومركز خبيث
   قد يسجّل مفتاحًا من اختراعه؛ الضرر: إشعارات ذلك الهاتف وحده من مركزه التالي.
6. **الحدود** (قيم `[vars]` قابلة للتغيير): ١٢٠ دفعة في الدقيقة و٥٠٠٠ في اليوم لكل مركز، ٦٠ ربطًا في الدقيقة،
   ٥ تسجيلات لكل عنوان في الساعة و٥٠٠ في اليوم. الطلب المرفوض لا يُحتسب. المالك يغيّر حدود مركز بعينه.
7. **الخصوصية**: المرحّل لا يخزّن ولا يسجّل أي عنوان أو نص أو بيانات أو رمز؛ سجلاته عدّادات فقط. الافتراضي
   إرسال العنوان والنص ليُقرأ الإشعار؛ **«الدفع الخاص»** (إعداد في المركز، مطفأ افتراضًا) يرسل «إشعار جديد في
   كور هب» / "New notice in Core Hub" ومعرّف الإشعار ونوعه فقط، والتطبيق يقرأ الباقي من مركزه.
8. **المركز**: يستعمل المرحّل لـFCM أو APNs حين لا بيانات اعتماد محلية لتلك المنصة؛ المحلية تفوز دائمًا
   (مركز المالك يبقي مفاتيحه إن شاء). العنوان مبني في الكود `DEFAULT_RELAY_URL`
   (`packages/server/src/modules/devices/relay.ts`) — **فارغ حتى ينشر المالك**، ثم يوضع فيه العنوان في طلب
   دمج — ويُستبدل بـ`COREHUB_PUSH_RELAY_URL`؛ `COREHUB_PUSH_RELAY=off` أو مفتاح المشرف يطفئه. يسجّل المركز
   نفسه عند أول حاجة ويحفظ السرّ مختومًا بمفتاح بياناته كبقية الأسرار.
9. **اسم المالك لا يُكتب في المستودع**: النطاق المفضّل للمالك يُعطى لسير النشر بمتغيّر المستودع
   `PUSH_RELAY_DOMAIN` أو بخانة عند التشغيل (قاعدة «لا أسماء خوادم المالك» في AGENTS.md).
10. **صلاحيات الرمز**: النشر يحتاج Workers Scripts: Edit وD1: Edit على الحساب، وWorkers Routes: Edit على
    المنطقة للنطاق المخصّص — وهي ما في رمز المالك الحالي. Workers KV غير مستعمل.

لم يُنشر شيء على Cloudflare ولم يُنشأ أي مورد؛ النشر للمالك.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
DECISIONS **§81**:
- `PUT /push/relay` (`devices.setPushRelay`، مالك/مشرف): `PushRelayUpdate {enabled?, private_push?}` ←
  `PushRelayStatus`.
- `PushSender.source` أُضيف له `relay`، و`PushSender.relay` (`PushRelayStatus` أو null، اختياري) على صفّي FCM
  وAPNs: `state` (ready، not_registered، unreachable، blocked، rate_limited، off، no_url)، `enabled`،
  `forced_off`، `private_push`، `url`، `hub_id`، `last_error`، `checked_at`.
- `PushRegistration.relay_proof` (اختياري، `PushRelayProof {key, signed_at, signature}`).
عملاء Kotlin وSwift يُولَّدون في CI (لا Java محليًا)؛ لا يستعمل أي تطبيق `PushSender`.

## الملفات والتأثير
- المرحّل (جديد): `packages/push-relay/` — `src/relay.ts` (المسارات، التوقيع، الربط، الحدود، الإدارة، cron)،
  `src/deliver.ts` (APNs وFCM)، `src/crypto.ts` (WebCrypto: JWT ES256/RS256، HMAC)، `src/env.ts`،
  `src/index.ts`، `migrations/0001_init.sql`، `wrangler.toml`، `README.md` (خطوات المالك)،
  `tests/harness.ts` و`tests/relay.test.ts` (٢٢ حالة).
- سير العمل: `.github/workflows/push-relay.yml` (اختبارات على كل PR يلمسه؛ نشر يدوي `workflow_dispatch` فقط).
- المركز: `modules/devices/relay.ts` (جديد)، `push.ts` (المرسِل عبر المرحّل، الحالة، المزامنة)، `index.ts`
  (الربط عند التسجيل، المزامنة عند إلغاء التسجيل والفصل، مؤقّت الدقيقة، `setPushRelay`)، `schema.ts` (جدول
  `push_relay`)، `senders.ts` (حقل `locale` اختياري في `PushMessage` فقط)، `testing/fake-relay.ts` (جديد)،
  `app/config.ts` (`COREHUB_PUSH_RELAY_URL`، `COREHUB_PUSH_RELAY`)، الترحيل `drizzle/0025_push_relay.sql`
  (+ اللقطة والسجل).
- الاختبارات: `tests/unit/devices-push-relay.test.ts` (جديد، ١٢ حالة)، `tests/unit/config.test.ts`،
  `tests/contract/devices.contract.test.ts`.
- الويب: مفتاح ترجمة واحد `devices.push.source.relay` (ar/en) فقط — بلا تغيير في الشاشات.
- الوثائق: `docs/adr/0024-push-relay.md`، `docs/contracts/DECISIONS.md` (§81)، `docs/domain/devices.md`،
  `docs/DEPLOY.md`، `docs/STATUS.md`، هذا السجل.

**ملاحظة لطلب `feat/device-cards`** (يعيد تصميم واجهة مرسِلي الدفع): الحالة معروضة في شكل قائمة المرسِلين
نفسه — `source: relay` وحقل `relay` على صفّي FCM وAPNs — وتغيير الإعداد بـ`PUT /push/relay`. المطلوب في
الواجهة: شارة «عبر مرحّل كور هب» (المفتاح موجود)، سطر حالة المرحّل (`relay.state` و`last_error`)، مفتاح
«الدفع الخاص» (`private_push`)، ومفتاح «استعمال المرحّل» (`enabled`، معطّل مع `forced_off`). وتعارض
الترحيل: الفرعان يأخذان `0025`؛ من يُدمج ثانيًا يعيد `pnpm db:generate` بعد دمج الآخر.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run`، بعد دمج `origin/main` (`fa17cd1a`):
```
$ pnpm --filter @corehub/push-relay test
 Test Files  1 passed (1)
      Tests  22 passed (22)
$ pnpm --filter @corehub/push-relay typecheck      → tsc --noEmit (exit 0)
$ vitest run --project unit tests/unit/devices-push-relay.test.ts tests/unit/devices-push.test.ts tests/unit/config.test.ts src/modules/devices tests/unit/hub-schedules-migration.test.ts tests/unit/provider-scope-migration.test.ts
 Test Files  7 passed (7)
      Tests  57 passed (57)
$ vitest run --project contract tests/contract/devices.contract.test.ts tests/contract/contract.test.ts
 Test Files  2 passed (2)
      Tests  318 passed (318)
$ pnpm typecheck                     → exit 0
$ pnpm lint                          → All matched files use Prettier code style!
$ pnpm contracts:lint                → Your API description is valid. (التحذير الوحيد في السطر 6625 قديم، موجود في main)
$ pnpm contracts:check-clients       → check-clients  OK — 584 client file(s) scanned, 223 contract path(s) known.
$ pnpm i18n:check                    → i18n:check  OK
$ pnpm nav:check                     → nav:check  OK — 37 destinations …
$ pnpm version:check                 → version: 1.1.0 everywhere (9 places)
$ pnpm db:generate                   → No schema changes, nothing to migrate
```
اختبارات المركز الجديدة تسقط على الكود القديم (أُرجع `push.ts` و`index.ts` إلى `origin/main` مؤقتًا):
```
     × offers FCM and APNs through the relay, registers on first need and binds the token
     × pushes a notice through the relay with the words, or privately with none
     … والـ١١ كلها ×   (Failed Tests 11)
```
مراجعة الفرق بعد فتح الطلب وجدت خطأً: `syncRelay` التي لا عمل لها (المرحّل مطفأ) كانت تترك وعدًا منتهيًا
عالقًا فلا تُزامن بعدها أبدًا. أُصلح، واختبار «syncs again after a sync that had nothing to do» يسقط على
النسخة السابقة وينجح الآن:
```
     × syncs again after a sync that had nothing to do      (قبل الإصلاح)
 Test Files  1 passed (1)
      Tests  12 passed (12)                                   (بعده، الملف كله)
```
اختبارات المرحّل تغطي: توقيع JWT (ES256 لـAPNs وRS256 لـFCM) بمفاتيح تُولَّد في الاختبار والتحقق منها
بالمفتاح العام، التخزين المؤقت وتجديد رمز APNs بعد ٥١ دقيقة ورمز FCM بعد 401، HMAC (بلا توقيع، توقيع خاطئ،
جسم مُعدَّل، إعادة nonce، طابع زمني قديم أو مستقبلي، مركز غير معروف)، الربط (الأول يفوز، الإفلات، الإثبات
بمفتاح الجهاز، رفض مفتاح آخر وإثبات أقدم وإثبات لا يتحقق، الاستيلاء بعد ٣٠ يومًا، sync)، الحدود (الدقيقة
واليوم و`retry-after`، الطلب المرفوض لا يُحتسب، حدود مركز بعينه)، التسجيل لكل عنوان، الحظر والإدارة،
تنظيف الرموز الميتة (APNs 410، FCM UNREGISTERED) وإبقاء غيرها (BadDeviceToken، INVALID_ARGUMENT للرسالة)،
وأن D1 والسجلات لا تحوي رمزًا ولا نصًا ولا سرًّا ولا عنوان IP.

CI على #150 عند `6dbb1108` (قبل هذا الإصلاح): كل الفحوص ناجحة إلا «Server unit tests (shard 2/3)»:
```
FAIL  tests/unit/status.test.ts > implements at least as many operations as docs/STATUS.md claims
AssertionError: the contract grew or shrank: update docs/STATUS.md: expected 315 to be 316
```
أُصلح بتحديث السطر الأول من `docs/STATUS.md` (302 من 316)، ونجح `status.test.ts` محليًا. النتيجة التالية
تُضاف أدناه.

## المخاطر والرجوع
- **الرجوع**: revert للفرع. الترحيل `0025` يضيف جدولًا فقط؛ نسخة أقدم تتجاهله.
- **لا أثر قبل النشر**: `DEFAULT_RELAY_URL` فارغ، فمركز بلا `COREHUB_PUSH_RELAY_URL` يبقى كما كان (FCM/APNs
  «غير مُعدّ»). الاختبارات القديمة كلها كما هي.
- APNs من Worker لم يُجرَّب أمام Apple (انظر القرار ٣). إن فشل، البديل الموثّق في ADR هو خادم صغير للمالك.
- نصوص الإشعار تمر عبر Cloudflare أثناء النقل ما لم يُفعَّل الدفع الخاص (كما تمر عبر Apple/Google أصلًا).
- `HUB_SECRET_KEY` لا يُغيَّر بعد النشر: تغييره يقطع كل المراكز المسجّلة (مكتوب في README).
- بناءات Xcode (sandbox) تعطي رموزًا يرفضها مرحّل `production` بـ`BadDeviceToken`؛ لا يُنسى الرمز بسببها.
- تعارض محتمل مع `feat/device-cards` في `push.ts` و`senders.ts` (تغييرات صغيرة متجاورة) وفي رقم الترحيل.

## التسليم والخطوة التالية
- خطوات المالك (مفصّلة في `packages/push-relay/README.md`): (١) متغيّر المستودع `PUSH_RELAY_DOMAIN` بالنطاق
  المختار (بلا سجل DNS عنده)، (٢) Actions → Push relay → Run workflow، (٣) `wrangler secret put` لمفاتيح APNs
  وFCM و`HUB_SECRET_KEY` و`ADMIN_TOKEN`، (٤) `curl https://<النطاق>/v1/health`، (٥) طلب دمج يضع العنوان في
  `DEFAULT_RELAY_URL`.
- متابعات: إثبات الجهاز في تطبيقي iOS وأندرويد (`relay_proof`)؛ واجهة المرحّل في طلب `feat/device-cards`.
