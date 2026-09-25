# خطافات الويب تستقبل أحداث الخادم فعلًا: طابور بمحاولات، وحقول البروفايلات والمحتوى والمحاولات، وعرض التسليمات
المسؤول: twuijri · الفرع: feat/webhooks-events · الحالة: review

## المشكلة والهدف
سجل PR #79 (`2026-09-24-twuijri-settings-webhooks-privacy.md`) قال: «الخطافات لا تُمرَّر إليها أحداث
بعد… التسليم الوحيد الذي يحدث هو التجريبي»، وترك `include_content` و`profiles` و`max_retries` خارج
النموذج لأنها لا أثر لها قبل التمرير. والهدف:
1. تمرير أحداث الخادم إلى الخطافات المشتركة فيها: انتهاء التشغيل أو فشله، طلب موافقة، نقل مهمة أو
   إسنادها، انتهاء تشغيل جدولة، انتهاء سير عمل أو انتظاره موافقة، إنشاء إشعار — موقَّعة (HMAC) بشكل
   حمولة من العقد، عبر طابور في الخلفية بمحاولات متباعدة أُسّيًا حتى `max_retries` ثم «توقّفت المحاولات»،
   مع فحص العنوان الخاص عند كل إرسال (إعادة ربط DNS) ومهلة لكل محاولة.
2. الحقول الثلاثة في النموذج بالعربية والإنجليزية: البروفايلات، تضمين نص الرسائل (مطفأ افتراضيًا)،
   عدد المحاولات.
3. عرض التسليمات: نوع الحدث، المحاولات، الحالة، رمز الرد، وقت المحاولة التالية، وزر «إعادة الإرسال» للفاشل.
4. الاختبارات: خادم بمستقبِل محلي حقيقي، عقد، ويب، ورحلة Playwright.

## القرار والموافقات
المهمة من المنسّق نيابة عن المالك (المالك نائم؛ القرارات أدناه **مقترحة — بانتظار تأكيد المالك**)،
ومدوّنة في `docs/contracts/DECISIONS.md` §52:

- **قائمة أحداث مختارة في العقد، لا كل أحداث الوقت الحقيقي.** `WebhookEventName` فيه ١٤ حدثًا (الستة
  المطلوبة وما يكمّلها: `run.cancelled` و`approval.resolved` و`task.created` و`schedule_run.failed`
  و`workflow_run.failed`)، ولكل حدث في `x-webhook-events` مصدره ووصفه بلغتين وحقول المحتوى. كانت
  `listWebhookEvents` تعرض كل اسم في `x-rt-events` (بما فيها `message.delta` و`member.typing`)؛
  صارت تعرض القائمة فقط، والخادم يرفض الاشتراك في غيرها (400). اسم قديم محفوظ لا يُرسَل أبدًا،
  والنموذج يسقطه عند الحفظ.
- **كيف يلتقط الخادم الأحداث:** كل مُرسِل وقت حقيقي (`createRealtime`، وطبقة الجلسات، و`emitToUser`)
  يسلّم الحدث بعد إرساله إلى «مستمعين» مسجّلين على خادم Socket.IO (`tapRealtime` في
  `lib/realtime.ts`)، والطابور في `notify` واحد منهم. فلا وحدة أخرى تعرف أن الخطافات موجودة، وأي حدث
  يُضاف إلى القائمة في العقد يُرسَل بلا تعديل في وحداته.
- **الحمولة `WebhookPayload`:** `{id, event, profile, occurred_at, content_included, data}`، و`data`
  هي حمولة حدث الوقت الحقيقي كما في `events/`. `id` ثابت عبر المحاولات وإعادة الإرسال ليتجاهل
  المستقبِل التكرار. الترويسات: `X-CoreHub-Signature` و`X-CoreHub-Event` و`X-CoreHub-Delivery`.
- **المحتوى مستبعد افتراضيًا:** الحقول التي يسردها العقد لكل حدث تُحذف (الرسالة الأخيرة للتشغيل، عنوان
  الموافقة ووصفها وأمرها وخياراتها وجوابها، عنوان المهمة ووصفها وملخصها وأسبابها، مخرجات الجدولة، مدخل
  سير العمل، عنوان الإشعار ونصه)، ويبقى المعرّفات والحالات والأوقات والاستهلاك.
- **البروفايلات:** قائمة فارغة = كل بروفايل يستطيع **منشئ الخطاف** دخوله، ويُتحقق من ذلك عند كل حدث؛
  وتسمية بروفايل لا يدخله الحافظ مرفوضة (`profile_not_allowed`).
- **المحاولات:** افتراضي ٥ (كان ٣ في الخادم)، بعد ٣٠ ث ثم ٦٠ ث ثم ١٢٠ ث… تتضاعف، وبحد أقصى ساعة بين
  محاولتين، ثم `dead`. «فشل» مع `next_attempt_at` = سيُعاد؛ «توقّفت المحاولات» = `dead`.
- **المهلة:** ١٠ ثوانٍ لكل محاولة، **ثابتة في الخادم لا حقلًا لكل خطاف**: الحقل يحتاج عمودًا وترحيلًا،
  وفرعان مفتوحان (#108 و#110) يأخذان الترحيل `0016` معًا، فترحيل ثالث يزيد تعارضهما. إن أراده المالك
  حقلًا فهو خطوة صغيرة لاحقة.
- **الأمان:** العنوان يُحلّ ويُفحص عند كل محاولة، والاتصال مثبّت على العنوان الذي فُحص (لا حلّ ثانٍ
  بين الفحص والاتصال)، والتحويلات (3xx) لا تُتبع وتُسجَّل فشلًا.
- **الطابور هو الجدول:** الحدث يكتب صفًّا `queued` لكل خطاف ويعود فورًا؛ مؤقّت واحد يرسل المستحق
  (عشرة في المرة). الصف «مستأجَر» أثناء الإرسال (يُدفع `next_attempt_at` بعد المهلة)، فإن توقف الخادم
  في منتصف الإرسال أُعيد بعد تشغيله، وما كان مستحقًا عند التوقف يُرسل بعد التشغيل.
- **إعادة الإرسال:** عملية جديدة `notify.redeliverWebhookDelivery` تنشئ تسليمًا جديدًا بالحمولة نفسها؛
  مسموحة للـ`dead` أو `failed` بلا محاولة قادمة فقط (409 غير ذلك).
- **التسليم التجريبي** يمر بالطريق نفسه مرة واحدة بلا محاولات، ويُرسَل حتى لخطاف موقوف لأن شخصًا ضغط
  الزر؛ وعنوان مرفوض عنده صار نتيجة «لم يُسلَّم: …» بدل فشل المهمة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- مخطط `WebhookEventName` (قائمة ١٤ حدثًا + `x-webhook-events`)، و`WebhookPayload`، وقسم
  `webhooks.hubEvent` في أعلى المستند يصف الطلب والترويسات الثلاث.
- `WebhookWrite.events` عناصره `WebhookEventName`؛ `max_retries` افتراضيه ٥ ووصفه؛ وصف
  `profiles` و`include_content` في `Webhook` و`WebhookWrite`.
- `WebhookDelivery.next_attempt_at` (إلزامي، قد يكون null) ووصف الحالات الأربع.
- عملية جديدة `notify.redeliverWebhookDelivery` — `POST /notify/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver`
  (مشرف) → `202 WebhookDelivery`، و`404`، و`409`.
- `derived.webhookEventHeader` و`derived.webhookDeliveryHeader` في `src/product.ts`.
- `docs/contracts/DECISIONS.md` §52، و`COVERAGE.md` (صف الخطافات)، والعدد في `STATUS.md`: ‏207 من 265،
  و`notify` ‏13 من 13.

## الملفات والتأثير
- الخادم: `src/lib/realtime.ts` (`tapRealtime` و`publishToTaps`)، `src/modules/sessions/realtime.ts`
  و`src/modules/auth/sockets.ts` (يسلّمان الحدث للمستمعين بعد إرساله)، و`src/modules/notify/`:
  `webhook-catalogue.ts` (القائمة من العقد وحذف المحتوى)، `webhook-send.ts` (محاولة HTTP واحدة: الفحص،
  الاتصال المثبّت، المهلة، رفض التحويل)، `webhook-queue.ts` (المطابقة والطابور والمحاولات والمؤقّت)،
  و`index.ts` (تركيب الطابور، `redeliver`، التسليم التجريبي، فحص البروفايلات، القائمة من العقد).
- الويب: `src/notify/webhooks.ts` (الأنواع، `useRedeliver`، `canRedeliver`، `clampRetries`، تحديث جدول
  التسليمات دوريًا)، `src/notify/WebhooksTab.tsx` (الحقول الثلاثة، الأحداث بجمل، شارتا البروفايلات
  والمحتوى، أعمدة المحاولات والمحاولة التالية وزر إعادة الإرسال)، والنصوص في `src/i18n/{ar,en}.json`.
- الاختبارات: `packages/server/tests/unit/webhook-events.test.ts` (١٥)، `packages/server/tests/contract/webhooks.contract.test.ts` (٤)،
  `packages/contracts/tests/webhook-events.test.ts` (٤)، `packages/web/tests/webhooks-privacy.test.tsx`
  (+٥ وتحديث ثلاثة)، ورحلة `packages/web/e2e/zzzzzz-webhook-events.spec.ts`، وتحديث الرحلة ٢٤
  (نص الملاحظة واسم مربع الحدث). اللقطات المحدّثة: `webhook-dialog-ar-light` و`webhooks-ar-light`
  و`webhooks-secret-ar-light` (النموذج تغيّر)؛ لقطة `privacy-ar-light` أُرجعت.
- التوثيق: `docs/STATUS.md`، `docs/contracts/DECISIONS.md`، `docs/contracts/COVERAGE.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
كل أمر ثقيل عبر `mj-run`، واحدًا بعد الآخر. محليًا شُغّل ما مسّه التغيير فقط؛ الحزم كاملة في CI.
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck            # exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 282 client file(s) scanned, 177 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contract:test
 Test Files  5 passed (5)
      Tests  279 passed (279)
$ pnpm --filter @corehub/contracts test
 Test Files  5 passed (5)
      Tests  23 passed (23)
$ vitest run --project unit src/modules/notify tests/unit/webhook-events.test.ts tests/unit/sockets.test.ts tests/unit/realtime-auth.test.ts src/modules/sessions/sessions-run.test.ts tests/unit/status.test.ts
 Test Files  8 passed (8)
      Tests  75 passed (75)
$ vitest run --project unit tests/unit/webhook-events.test.ts   # مع إيقاف queue.dispatch (بلا تمرير)
      Tests  10 failed | 5 passed (15)
$ pnpm --filter @corehub/web exec vitest run tests/webhooks-privacy.test.tsx
 Test Files  1 passed (1)
      Tests  19 passed (19)
$ pnpm build                # exit 0
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzz-settings-webhooks-privacy.spec.ts e2e/zzzzzz-webhook-events.spec.ts
  2 passed (الرحلتان ٢٤ و٢٥)، و1 failed: رابط «محادثة جديدة» غير موجود في صفحة الإعدادات
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzz-webhook-events.spec.ts   # بعد page.goto('/new')
  ✓  1 … webhooks: a scripted chat’s "run finished" reaches the receiver, signed, and is listed as delivered (2.0s)
  1 passed (8.2s)
```
الخمسة التي نجحت مع إيقاف التمرير هي: رفض اسم خارج القائمة، وعدم تمرير ما ليس فيها، والخطاف الموقوف،
وحساب التأخير، والتقاط ما كان مستحقًا عند التشغيل — وكلها لا تعتمد على الالتقاط.

CI: يُملأ بعد الدفع (انظر «التسليم»).

## المخاطر والرجوع
- `listWebhookEvents` صارت تعرض ١٤ حدثًا بدل كل الأسماء؛ خطاف محفوظ بأسماء أخرى يبقى ولا يُرسل له
  إلا ما في القائمة، وحفظه من النموذج يسقط الأسماء القديمة.
- كل حدث في القائمة يكلّف استعلامًا واحدًا على جدول الخطافات (صغير)؛ الأحداث خارج القائمة (مثل
  `message.delta`) لا تلمس قاعدة البيانات.
- المستمع لا يكسر الإرسال: خطأ فيه يُبتلع بعد وصول الحدث للمقابس.
- خلل معروف خارج النطاق: مسار نقل المهمة (`tasks.moveTask`) يرسل `task.moved` بـ`task` فقط، والمخطط
  يطلب `from` و`to` و`actor` أيضًا؛ الخطاف يستلمه كما هو.
- ملفات مشتركة: `STATUS.md` (سطر العدد)، ملفات اللغة، `DECISIONS.md` (§52 بعد §47–§51 في PRs مفتوحة).
- الرجوع: استرجاع الـcommits؛ لا ترحيل قاعدة بيانات (الأعمدة كانت موجودة: `next_attempt_at`…).

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية للمراجعة. على المالك أن يؤكد: (١) القائمة المختارة بدل كل الأحداث، (٢) حقول
المحتوى المحذوفة افتراضيًا، (٣) الافتراضي ٥ محاولات وجدول التأخير، (٤) المهلة الثابتة ١٠ ث بدل حقل،
(٥) البروفايلات الفارغة = كل ما يدخله المنشئ. الخطوة التالية المقترحة: إصلاح حمولة `task.moved` في
مسار النقل، ثم حقل مهلة لكل خطاف إن أراده المالك.
