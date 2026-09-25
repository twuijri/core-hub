# وحدة الأجهزة وإشعارات Push
المسؤول: twuijri · الفرع: feat/devices-push · الحالة: review

## المشكلة والهدف
عمليات `devices` السبع عشرة كلها كانت 501، فلا شيء يستطيع أن يدفع إشعارًا إلى جوال أو حاسوب أو
متصفح، وساعات الهدوء كانت تُحفظ ولا تُسكت شيئًا. تطبيقات الجوال (#122/#125/#127، #120/#124/#128)
وسطح المكتب (#111–#116) تعود لذلك إلى الفحص الدوري (WorkManager كل ١٥ دقيقة، وBackground refresh في
iOS، و`notice.created` ما دام التطبيق مفتوحًا).

الهدف: سجل الأجهزة حسب العقد، وتوصيل ما يُكتب في صندوق الإشعارات إلى أجهزة الشخص عبر Web Push
(مفاتيح VAPID يولّدها المركز بنفسه) وFCM وAPNs، مع احترام مفتاح كل نوع وساعات الهدوء؛ وفي الويب:
قائمة الأجهزة، و«تفعيل إشعارات المتصفح»، وبطاقة حالة المرسِلات للمشرف.

## القرار والموافقات
كل ما يلي **مقترح — ينتظر تأكيد المالك** (قرار العقد §56):

1. **notify يقرر «هل»، وdevices يقرر «كيف».** الإشعار المكتوب في الوارد يُسلَّم لمنفذ الدفع إلا إذا كان
   مفتاح `push` لنوعه مطفأً أو كانت اللحظة داخل ساعات الهدوء. devices يرسله لكل جهاز مقترن للشخص عليه
   تسجيل دفع، ويردّ بنتيجة كل جهاز، وnotify يكتب صفًا في `notification_deliveries` لكل جهاز. لا تستورد
   إحدى الوحدتين الأخرى: جذر التركيب يعير المنفذ (و`auth` يستورد `devices` أصلًا، فيأخذ devices حرّاسه
   وإلغاء الرموز بالطريقة نفسها).
2. **جدول `push_credentials` انتقل من notify إلى devices** — الجدول نفسه، بلا ترحيل (تحققت بـ
   `pnpm db:generate`: «No schema changes»). لا ترحيل في هذا الفرع إطلاقًا.
3. **Web Push بلا أي حساب خارجي**: زوج مفاتيح P-256 يُصنع عند أول استعمال في
   `/data/keys/vapid.json` (0600) ولا يُدوَّر. التشفير RFC 8291 (`aes128gcm`) مكتوب من المواصفة ومطابق
   بايتًا ببايت لمثال الملحق A فيها؛ وVAPID حسب RFC 8292.
4. **FCM (HTTP v1) وAPNs (HTTP/2)** مبنيّان ومختبَران على خوادم مزيّفة، ومطفآن حتى يعطي المالك
   بيانات الاعتماد: من الإعدادات (مشفّرة بمفتاح البيانات، تُقرأ `[stored]`) أو من متغيرات البيئة التي
   تغلب الإعدادات. `listPushSenders` يسمّي ما ينقص كل واحد.
5. **الرمز لا يُنسى إلا حين تقول الخدمة إنه ميت** (Web Push 404/410، FCM `UNREGISTERED`، APNs 410).
   `BadDeviceToken` في APNs يُبلَّغ ولا يُمحى، لأنه ينتج أيضًا من بيئة أو Bundle ID خاطئ في إعدادات المركز.
6. **المتصفح جهاز**: `devices.register` (`POST /devices`) لعميل ليس تطبيقًا مقترنًا، بمفتاح `device_key`
   يحفظه؛ المفتاح نفسه = الصف نفسه. التطبيق المقترن يُرد بـ409، والمتصفح لا يأخذ مفتاح تطبيق مقترن.
7. **من يتصرف في الجهاز**: مالكه أو الجهاز نفسه أو المشرف (كان العقد يقول «الجهاز أو المشرف» في
   `update`)؛ جهاز غيرك يُرد بـ404 لا 403. تسجيل الدفع لجهاز مقترن برمزه هو فقط.
8. **تبويب «الأجهزة» صار لكل شخص** (أجهزته هو)، والمشرف يرى أجهزة الجميع وبطاقة المرسِلات؛ غيّرت
   ملاحظة `navigation.json` بذلك.
9. **ntfy مؤجَّل**: يحتاج قيمة جديدة في `push_provider` أي ترحيلًا، و`0016` محجوز في عدة طلبات مفتوحة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
عمليات جديدة (قرار §56):
- `devices.register` — `POST /devices` (جسم `DeviceRegistration`) → `201`/`200` `Device`، `409`.
- `devices.testPush` — `POST /devices/{device_id}/push/test` → `PushTestResult`، `409` بلا تسجيل.
- `devices.getPushConfig` — `GET /push/config` → `PushConfig { webpush_public_key, providers }`.
- `devices.listPushSenders` — `GET /push/senders` (مشرف) → `{ items: PushSender[] }`.
- `devices.setPushSender` / `devices.deletePushSender` — `PUT|DELETE /push/senders/{provider}` (مشرف).
- `notify.sendTestNotice` — `POST /notify/test-notice` → `201 Notice`، `409` إن أطفأ الشخص `system`.

تغييرات: وصف `devices.registerPush` و`409` له؛ وصف `PushRegistration.token` لكل مزوّد (ولـWeb Push
الاشتراك JSON) و`maxLength: 4096`؛ ملخص `devices.update` يضيف «مالكه». مخططات جديدة: `PushProvider`،
`PushConfig`، `PushSender`، `PushSenderUpdate`، `PushTestResult`. لا حدث جديد: `device.linked/updated/
unlinked/online/offline` و`notice.created` موجودة. المجموع 271 عملية، المنفّذ 219.

### ما يستدعيه تطبيقا الجوال وسطح المكتب للانتقال من الفحص الدوري إلى الدفع
هذا للمتابعة، ولم أعدّل كود التطبيقات في طلباتها.

**١) بعد الاقتران وكل تشغيل** — التطبيق يعرف `device.id` من ردّ `auth.claimPairing`:
```
GET  /api/v1/push/config                     (Bearer <app_token>)
→ { "webpush_public_key": "B…" | null, "providers": ["webpush", "fcm"?, "apns"?] }
```
سجّل الدفع فقط إن كان مزوّدك في `providers`؛ وإلا فاستمر في الفحص الدوري (وهو الحال الآن لأندرويد
وiOS حتى يعطي المالك بيانات FCM/APNs).

**٢) تسجيل الرمز (وتجديده كلما غيّره النظام):**
```
PUT /api/v1/devices/{device_id}/push         (Bearer <app_token> — رمز الجهاز نفسه فقط)
Android:  { "provider": "fcm",  "token": "<FCM registration token>", "locale": "ar" }
iOS:      { "provider": "apns", "token": "<APNs device token, hex>", "locale": "ar" }
Desktop (Electron, Web Push عبر Chromium):
          { "provider": "webpush",
            "token": "{\"endpoint\":\"https://…\",\"keys\":{\"p256dh\":\"…\",\"auth\":\"…\"}}" }
→ 200 { "provider": "fcm", "locale": "ar", "registered_at": "…" }
   409 sender_not_configured · 400 token لا يناسب المزوّد
```
إيقاف: `DELETE /api/v1/devices/{device_id}/push` → 204. تجربة: `POST /api/v1/devices/{device_id}/push/test`
→ `{ provider, status: "sent"|"failed", error }`.

**٣) الحمولة التي تصل (واحدة لكل العملاء):**
```
{ "type": "notice", "notice_id": "01J…", "kind": "run_completed|approval_requested|system|…",
  "title": "…", "body": "…"|null, "profile": "default", "resource": { "kind": "session", "id": "01J…" }|null }
```
- **FCM**: `message.notification { title, body }` و`message.data` نصوص: `type, kind, notice_id, profile,
  resource_kind, resource_id`؛ `android.priority` = `high` لطلب الإذن و`normal` لغيره؛
  `android.notification.channel_id = "notices"` و`tag = notice_id` (أنشئ القناة `notices` في التطبيق).
- **APNs**: `aps.alert { title, body }`، `sound: default`، `thread-id: <profile>`،
  `interruption-level: time-sensitive` لطلب الإذن و`active` لغيره، والحمولة أعلاه بجانب `aps`؛
  الترويسات `apns-push-type: alert`، `apns-collapse-id: <notice_id>`، `apns-topic: <bundle id>`.
- الضغط يفتح `resource` كما يفعل الوارد (`session` → المحادثة، `workflow_run` → الجدولة). وبعد الوصول
  يستطيع التطبيق أن يعلّم الإشعار مقروءًا بـ`notify.updateNotice` كالمعتاد.
- ما يُكتب مرة يصل مرة: التطبيق الذي يعرض أيضًا `notice.created` من المقبس يطابق `notice_id` حتى لا
  يعرضه مرتين.

**٤) آخر ظهور**: كل طلب برمز الجهاز يكتب `last_seen_at` (مرة في الدقيقة على الأكثر)، واتصال
`/rt/devices` يكتبه ويرسل `device.online`، وانقطاع آخر مقبس يرسل `device.offline`. لا حاجة لنبض.

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml`.
- الخادم — `packages/server/src/modules/devices/`: `index.ts` (المسارات، `createDevicesModule` بالمنافذ،
  `pushFor`، الحضور وآخر ظهور)، `push.ts` (`PushService`: المصادر env/الإعدادات، الحالة، الختم،
  الإرسال لكل الأجهزة)، `senders.ts` (Web Push وFCM وAPNs)، `webpush.ts` (VAPID وRFC 8291)،
  `schema.ts` (`push_credentials` هنا الآن)، `testing/fake-push.ts` (خدمات مزيّفة للاختبارات وe2e)،
  `push.test.ts`، `devices.test.ts`.
- `modules/notify/notices.ts` (`pushAllowed`، `recordPushDeliveries`، الدفع بعد الكتابة)، `notify/index.ts`
  (`sendTestNotice`، `registerNoticePush`، منفذ `createNotifier`)، `notify/schema.ts` (نُقل الجدول).
- `modules/index.ts` (تركيب devices ومنفذ الدفع)، `modules/auth/index.ts` (تصدير `revokeToken`)،
  `modules/models/index.ts` (`dataKeyRingFor`: حلقة مفتاح البيانات نفسها لا نسخة ثانية)،
  `app/config.ts` (متغيرات `COREHUB_PUSH_CONTACT` و`COREHUB_FCM_*` و`COREHUB_APNS_*`، اختيارية).
- اختبارات: `tests/unit/devices-push.test.ts`، `tests/contract/devices.contract.test.ts`،
  `tests/unit/config.test.ts`.
- الويب: `src/devices/` (`queries.ts`، `browserPush.ts`، `DevicesPanel.tsx`، `PushSendersCard.tsx` مع نموذج
  إعداد FCM/APNs)، `src/notify/BrowserPushSection.tsx`، `NotificationsTab.tsx` (مفتاح Push لكل نوع)،
  `screens/DeviceConnectionsScreen.tsx`، `public/push-sw.js` (عامل الخدمة)، ملفا اللغة،
  `tests/devices-push.test.tsx`، `e2e/zzzzzz-browser-push.spec.ts`، `e2e/hub.ts` (سطر `overrideDevices`)،
  لقطتان في `e2e/shots/`.
- الوثائق: `docs/STATUS.md`، `docs/contracts/DECISIONS.md` (§56)، `docs/contracts/COVERAGE.md`،
  `docs/domain/{devices,notify,README}.md`، `docs/DEPLOY.md`، `docs/clients/navigation.json` (الملاحظة).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، كل أمر عبر `mj-run`:
```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!
$ pnpm typecheck                         → exit 0
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 289 client file(s) scanned, 181 contract path(s) known.
$ pnpm i18n:check
i18n:check  web: 1384 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ DATA_DIR=… pnpm db:generate
No schema changes, nothing to migrate 😴
$ vitest run --project unit src/modules/devices src/modules/notify tests/unit/devices-push.test.ts \
    tests/unit/config.test.ts tests/unit/status.test.ts src/modules/auth/pairing.test.ts
 Test Files  9 passed (9)
      Tests  75 passed (75)
$ vitest run --project contract tests/contract/devices.contract.test.ts tests/contract/contract.test.ts \
    tests/contract/auth.contract.test.ts
 Test Files  3 passed (3)
      Tests  276 passed (276)
$ (web) vitest run tests/devices-push.test.tsx tests/notifications.test.tsx tests/i18n.test.ts \
    tests/logical-css.test.ts tests/navigation.parity.test.tsx tests/settings-pages.test.tsx
 Test Files  6 passed (6)
      Tests  212 passed (212)
$ pnpm build                              → exit 0 (✓ built in 945ms)
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzz-browser-push.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-browser-push.spec.ts:31:1 › a browser turns notifications on, and a test notice is pushed to it (1.2s)
  1 passed (7.4s)
```
ما تثبته الاختبارات: التشفير يطابق مثال RFC 8291 بالبايت، وتوقيع VAPID يُتحقق منه بالمفتاح العام؛ FCM
يوقّع JWT حساب الخدمة (يُتحقق منه بالمفتاح العام) ويعيد استعمال رمز الوصول، وAPNs يرسل على HTTP/2 برمز
مزوّد ES256 يُتحقق منه ويُعاد استعماله؛ السجل (تسجيل متصفح مرتين = صف واحد، إعادة تسمية، إلغاء ربط
يلغي رمز التطبيق فيُرد `/auth/me` بـ401، آخر ظهور، عزل أجهزة شخص عن آخر)؛ الدفع (مفتاح Push لكل نوع،
ساعات الهدوء حول الساعة الحالية، جهاز ملغى لا يصله شيء، اشتراك ميت يُنسى، عنوان خاص أو http يُرفض،
مرسل غير مُعدّ 409، رمز تطبيق مقترن لا يسجله غيره)؛ البيئة تغلب الإعدادات (409)؛ دفع حقيقي إلى FCM
مزيّف من البيئة وإلى APNs مزيّف من الإعدادات. كل هذه تسقط على الكود القديم (كل العمليات 501).

CI: يُضاف ناتجه بعد الدفع.

## المخاطر والرجوع
- **الرجوع**: revert للطلب. لا ترحيل؛ الجدول المنقول هو نفسه. `vapid.json` يبقى في `/data/keys` بلا أثر.
- الاشتراكات تُربط بمفتاح VAPID: حذف `/data/keys/vapid.json` يُبطل كل اشتراكات المتصفحات (يعيد الشخص
  التفعيل). لذلك لا يُدوَّر.
- حلقة مفتاح البيانات صارت مشتركة بين models وdevices عبر `dataKeyRingFor` بدل فتح نسخة ثانية.
- `online` يعرف المقابس الحية للأجهزة المقترنة فقط؛ المتصفح `online: false` دائمًا (لا مقبس له كجهاز).
- الدفع يُرسل بعد كتابة الإشعار دون انتظار (لا يبطئ الرد)؛ فشل الدفع لا يُفشل الإشعار ويُسجَّل.
- لم يُجرَّب على خدمة دفع حقيقية (Google/Mozilla/Apple) ولا على هاتف: كل ذلك على خوادم مزيّفة بالمواصفة.
- `e2e/hub.ts` يسمح لخادم التجربة بعناوين 127.0.0.1 للدفع (`overrideDevices`)؛ ذلك في خادم الاختبار فقط.

## التسليم والخطوة التالية
- **ما يجب أن يعطيه المالك لتشغيل FCM (أندرويد)**: ملف JSON لحساب خدمة Firebase (Firebase Console ←
  إعدادات المشروع ← حسابات الخدمة ← إنشاء مفتاح خاص)، لمشروع Firebase فيه تطبيق أندرويد بمعرّف حزمة
  التطبيق، ومعه `google-services.json` لبناء التطبيق. يُلصق في «اتصالات الأجهزة ← الأجهزة ← مرسِلات
  الإشعارات ← FCM ← إعداد» أو يُعطى في `COREHUB_FCM_SERVICE_ACCOUNT`.
- **ما يجب أن يعطيه لتشغيل APNs (آيفون)**: حساب Apple Developer مدفوع؛ مفتاح APNs (`.p8`) من
  Certificates, IDs & Profiles ← Keys مع **Key ID**؛ **Team ID**؛ **Bundle ID** لتطبيق iOS (مع قدرة Push
  Notifications مفعّلة فيه)؛ والبيئة (`production`، أو `sandbox` لنسخ Xcode التطويرية). تُدخل في النموذج
  نفسه أو في `COREHUB_APNS_KEY_ID` و`_TEAM_ID` و`_BUNDLE_ID` و`_KEY` و`_ENVIRONMENT`.
- متابعة: تحويل تطبيقات أندرويد/iOS/سطح المكتب إلى الدفع حسب القسم أعلاه؛ ntfy إن أراده المالك (يحتاج
  ترحيلًا)؛ طلبات القدرات (`device-requests`) والـrelay والأقران ما زالت 501.
