# عنوان العميل الحقيقي: `X-Forwarded-For` من البروكسي الموثوق فقط
المسؤول: twuijri · الفرع: fix/trust-proxy · الحالة: review

## المشكلة والهدف
وُجدت الليلة (٢٠٢٦-٠٩-٢٧): الخادم يشغّل Fastify بـ`trustProxy: true` في `packages/server/src/app/server.ts`، فيصدّق
ترويسة `X-Forwarded-For` من أي أحد، و`request.ip` هو أول عنوان في يسارها، أي ما يكتبه العميل نفسه. عميل على الإنترنت
يستطيع أن يرسل عنوانًا جديدًا مع كل محاولة فلا يصل أبدًا إلى قفل العنوان بعد خمس محاولات خاطئة (كلمة المرور، رموز
التطبيق، رمز الإقران، وكذلك إعداد التشغيل الأول). وفي الاتجاه المعاكس كان اتصال Socket.IO يحسب عنوان الطرف المباشر،
فكل من خلف البروكسي يتشارك عنوان البروكسي وأخطاء شخص واحد تقفل الجميع. الأمر أهم الآن مع الوصول من الخارج لمركز
الحاسوب عبر Cloudflare Tunnel وTailscale (§95).

الهدف: تُصدَّق الترويسة من بروكسي معروف فقط، والعميل هو أقصى عنوان على اليمين ليس بروكسي موثوقًا.

## القرار والموافقات
مقترح — للمالك أن يؤكد (DECISIONS §96):
- إعداد جديد `COREHUB_TRUST_PROXY` يُقرأ في `app/config.ts` فقط: قائمة عناوين/نطاقات CIDR مفصولة بفواصل، أو `false`
  (لا أحد)، أو عدد قفزات ١–١٠. أي قيمة أخرى توقف الخادم عند الإقلاع مع السبب.
- الافتراضي دون ضبط: `127.0.0.0/8`، `::1`، `10.0.0.0/8`، `172.16.0.0/12`، `192.168.0.0/16`، `fc00::/7` — يغطي
  Caddy/Traefik في شبكة Docker و`cloudflared` على الجهاز نفسه، فتعمل الحزم الحالية باستبدال الصورة فقط.
- دالة ثقة واحدة (`packages/server/src/lib/client-address.ts`) تُعطى لـFastify (`request.ip` و`request.host`
  و`request.protocol`) ولمصافحة Socket.IO، فيُحسب الفشل على العنوان نفسه في HTTP والمقبس، وسطر سجل التدقيق
  `terminal.opened` يسجّل العنوان نفسه.
- راجعت كل موضع يشتق عنوان العميل: القفل في تسجيل الدخول والإعداد الأول (`request.ip`)، رموز التطبيق في HTTP
  (`request.ip`) وفي المقبس (صار `socketAddressOf`)، الإقران (`request.ip`)، طرفية الويب (صار `socketAddressOf`).
  لا يوجد تحديد معدّل آخر بالعنوان، ولا يقرأ تسجيل مُرحّل الإشعارات ولا الـwebhooks عنوان العميل ولا أي ترويسة
  `X-Forwarded-*` / `X-Real-IP` / `CF-Connecting-IP` مباشرة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. قرار جديد في `docs/contracts/DECISIONS.md` §96 فقط.

## الملفات والتأثير
- `packages/server/src/lib/client-address.ts` (جديد): قاعدة الثقة، استخراج العنوان من السلسلة، وعنوان كل مقبس.
- `packages/server/src/app/config.ts`: `COREHUB_TRUST_PROXY` و`parseTrustProxy` و`HubConfig.trustProxy` (اختياري).
- `packages/server/src/app/server.ts`: `trustProxy: trust` بدل `true`.
- `packages/server/src/app/sockets.ts`: أول middleware في كل namespace يسجّل عنوان العميل بالقاعدة نفسها.
- `packages/server/src/modules/auth/sockets.ts`، `packages/server/src/modules/terminal/index.ts`: `socketAddressOf(socket)`
  بدل `socket.handshake.address`.
- `packages/server/tests/unit/trust-proxy.test.ts` (جديد)، `packages/server/tests/unit/config.test.ts`.
- `docs/DEPLOY.md` (صف في جدول المتغيرات و§3d: Caddy/Traefik/Cloudflare/بلا بروكسي)، `docs/contracts/DECISIONS.md`
  §96، `docs/STATUS.md` (سطر auth).

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبارات الجديدة تفشل على الكود القديم: أعدت `trustProxy: true` مؤقتًا في `server.ts` وشغّلت الملف:
```
     × ignores X-Forwarded-For from a client on the internet: a new address per try still locks 1503ms
     × believes a trusted proxy on the Docker network, and only its own right-most entry 1043ms
     × locks the real client behind the proxy, not the proxy nor everyone else 1045ms
     × with COREHUB_TRUST_PROXY=false, nobody is believed, not even loopback 973ms
     × with a list, only the proxies on it are believed 1079ms
     × a socket handshake counts the same address as HTTP does 781ms
      Tests  6 failed | 3 passed (9)
```
وبعد الإصلاح، ملفات الاختبار التي يمسّها التغيير (mj-run):
```
$ pnpm exec vitest run --project unit tests/unit/trust-proxy.test.ts tests/unit/config.test.ts tests/unit/realtime-auth.test.ts tests/unit/sockets.test.ts tests/unit/terminal.test.ts src/modules/auth/pairing.test.ts src/modules/auth/auth.test.ts
 Test Files  7 passed (7)
      Tests  50 passed (50)
```
```
$ pnpm lint
All matched files use Prettier code style!
lint exit: 0
$ pnpm typecheck
typecheck exit: 0
```
CI على طلب الليلة #165: يُسجَّل بعد الدفع.

## المخاطر والرجوع
- حزمة تنشر منفذ الخادم مباشرة بلا بروكسي: جهاز في الشبكة الخاصة نفسها ما زال يستطيع كتابة عنوانه؛ الحل
  `COREHUB_TRUST_PROXY=false` (موثّق في DEPLOY §3d).
- مسار Tailscale في تطبيق سطح المكتب (§95) تمرير TCP خام من loopback، والافتراضي يثق بـloopback، فجهاز في شبكة
  Tailscale الخاصة بالشخص يستطيع كتابة عنوانه أمام مركز الحاسوب. جعل ذلك التمرير يكتب `X-Forwarded-For` بنفسه متروك
  لاحقًا (خارج نطاق هذه المهمة، وهو في ملف مهمة أخرى الليلة).
- Cloudflare البرتقالية أمام Caddy/Traefik: بدون ضبط يُحسب عنوان حافة Cloudflare؛ الخطوات في DEPLOY §3d.
- الرجوع: استرجاع الدمج؛ أو مؤقتًا `COREHUB_TRUST_PROXY` بقائمة البروكسيات المطلوبة. لا ترحيل بيانات.

## التسليم والخطوة التالية
دُمج في `night/2026-09-27` (طلب #165)، بلا طلب دمج خاص. الخطوة التالية: تأكيد المالك للافتراضي، ثم متابعة مسار
Tailscale في سطح المكتب.
