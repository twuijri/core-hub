# تطبيق سطح المكتب — المساعد المحلي (MCP) (الجزء ٣ من ٤)
المسؤول: twuijri · الفرع: feat/desktop-helper · الحالة: review

## المشكلة والهدف
ADR 0009 يعد بمساعد محلي صغير داخل التطبيق «يعرض الجهاز على المركز أدواتِ MCP … اختياري، مطفأ
افتراضيًا، ويُظهر ما يعرضه». المطلوب: مجلدات يسمح بها الشخص (قراءة وكتابة وعرض محصورة فيها)،
وفتح الملفات والتطبيقات، وشاشة صلاحيات تبيّن بالضبط ما هو معروض، مع وصف نموذج التهديد. قال
المالك قبل نومه:

> «كمل كل الشغل حتى لو تكمل تطبيق الديسك توب كامل … اي قرار تحتاجه مني اجله»

الفرع مبنيّ على `feat/desktop-local` (#113) المبني على #111.

## القرار والموافقات
كلها **مقترحة — تنتظر تأكيد المالك** (ADR 0022، وفيه نموذج التهديد كاملًا):

1. **خادم MCP داخل التطبيق** على `http://127.0.0.1:<منفذ>/mcp`، بنقل Streamable HTTP بإجابات
   JSON فقط. كتبته بنفسي بدل إضافة مكتبة، وتحققت من التوافق بعميل MCP الرسمي
   (`@modelcontextprotocol/sdk` 1.30.1، في مجلد مؤقت خارج المستودع): `initialize` و`tools/list`
   و`tools/call` عملت.
2. **مطفأ افتراضيًا**، وكل شيء بمفتاح منفصل يبدأ مطفأً: تشغيل المساعد، مشاركة كل مجلد، الكتابة
   في كل مجلد، فتح الملفات والروابط.
3. **الأدوات**: معرفة المجلدات المشارَكة، عرض محتوى مجلد، قراءة ملف نصي (١ MB حدًّا، نص فقط)؛
   الكتابة فقط حيث شورك المجلد للكتابة ولا تستبدل ملفًا إلا إذا طُلب؛ فتح ملف داخل مجلد مشارَك
   ببرنامجه، وفتح رابط http/https — فقط إن سُمح بالفتح. **لا** لقطات شاشة، ولا تحكم بالفأرة أو
   لوحة المفاتيح، ولا تشغيل أوامر أو تطبيقات عشوائية: ليست «بسيطة» بما يكفي لتكون آمنة الآن.
   «فتح التطبيقات» صار فتح ملف ببرنامجه الافتراضي.
4. **قاعدة المجلد**: يُستخدم المسار فقط إن كان — بعد حلّ كل رابط رمزي — داخل مجلد مشارَك؛ ملف
   جديد يُفحص عبر مجلده الأب المحلول؛ والمجلد الأخص يقرّر القراءة أو الكتابة.
5. **من يستطيع النداء**: 127.0.0.1 فقط، ومفتاح Bearer من 32 بايت عشوائية مع كل طلب (في ملف
   إعدادات التطبيق بصلاحية 0600، و«مفتاح جديد» يستبدله)، ويُرفض كل طلب فيه `Origin` (أي صفحة ويب)
   أو `Host` غير العنوان المحلي.
6. **شاشة الصلاحيات** في «هذا الجهاز»: الأدوات الحيّة كما يراها الوكيل، والمجلدات بصلاحياتها،
   والعنوان والمفتاح (مخفي مع نسخ)، وآخر ٥٠ نداءً (الوقت، الأداة، المسار، رُفض أم لا).
7. **لمن يعمل**: للمركز الذي على الحاسوب نفسه (الوضع المحلي)، وزر واحد يضيفه إلى خوادم MCP لهرمز
   باسم `this-computer` عبر العقد (`agents.createMcpServer`). مركز على خادم لا يصل إلى عنوان
   محلي، والشاشة تقول ذلك؛ خدمته تكون عبر طلبات الأجهزة في العقد (`devices.createRequest`) حين
   تُبنى في الخادم — لا بنفق من التطبيق.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. زر «إضافته إلى هرمز» يستخدم `agents.listMcpServers` و`agents.createMcpServer`
و`agents.updateMcpServer` الموجودة.

## الملفات والتأثير
- `apps/desktop/src/shared/helper.ts` (جديد): إعدادات المساعد وقاعدة المجلد.
- `apps/desktop/src/main/helper.ts` (جديد): الأدوات وخادم MCP وسجل الاستخدام.
- `apps/desktop/src/main/controller.ts` و`src/preload/index.ts` و`src/shared/{config,ipc}.ts`
  و`src/i18n/{ar,en}.json`.
- `packages/web/src/desktop/HelperSection.tsx` (جديد)، `desktop/bridge-types.ts`،
  `settings/ThisDeviceTab.tsx`، ملفا اللغة، والاختبار.
- `docs/adr/0022-desktop-local-helper.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!

$ pnpm contracts:check-clients
check-clients  OK — 321 client file(s) scanned, 176 contract path(s) known.

$ pnpm i18n:check
i18n:check  desktop: 78 keys, ar/en in parity
i18n:check  OK

$ pnpm --filter @corehub/desktop typecheck      (بلا أخطاء)
$ pnpm --filter @corehub/web exec tsc --noEmit -p tsconfig.test.json   (بلا أخطاء)

$ pnpm --filter @corehub/desktop test
 Test Files  7 passed (7)
      Tests  81 passed (81)

$ pnpm --filter @corehub/web exec vitest run tests/desktop-surface.test.tsx
      Tests  16 passed (16)

$ pnpm build && xvfb-run -a pnpm --filter @corehub/desktop test:smoke
Running 3 tests using 1 worker
  ✓  1 tests/smoke/desktop.spec.ts:49:1 › remote mode: connect, sign in, chat, This device (2.8s)
  ✓  2 tests/smoke/desktop.spec.ts:109:1 › pairing: a link from a signed-in device signs this computer in (1.6s)
  ✓  3 tests/smoke/desktop.spec.ts:144:1 › local mode: no Hermes found → the hub starts on this computer anyway → first-run setup (4.1s)
  3 passed (11.7s)
```
اختبارات المساعد تغطي: رابط رمزي داخل مجلد مشارَك يشير إلى خارجه (قراءة وكتابة مرفوضتان)،
و`..`، ومجلد للقراءة داخل مجلد للكتابة، والملف الثنائي، وعدم الاستبدال دون طلب، وأن الأدوات
تتبع الإعدادات فورًا، و401 بلا مفتاح، و403 مع `Origin`، و405 على GET، والتفاوض على نسخة
البروتوكول، والإشعارات (202)، والدفعات. اختبار الدخان الثالث يشغّل المساعد من الشاشة الحقيقية
ثم يناديه من خارج التطبيق: بمفتاح خاطئ 401، وبالصحيح ثلاث أدوات فقط (لا مجلد ولا فتح).
وفحص التوافق بعميل MCP الرسمي نجح (`Tests 1 passed`) ولم يُضف إلى المستودع.

CI على #115 — كلها ناجحة:
```
pass  Lint, typecheck, contracts, tests, build
pass  Desktop app smoke (Electron under Xvfb against the real hub)
pass  Web smoke journeys (Playwright against the real hub)
pass  Docker image builds and answers /health
pass  db:generate + db:migrate (SQLite and PostgreSQL)
pass  PR adds or updates a change record
pass  PR leaves graphify-out/ to the code-map bot
```

## المخاطر والرجوع
- وكيل مسموح له الكتابة في مجلد يستطيع كتابة أي شيء فيه؛ واستبدال ملف برابط بين الفحص والكتابة
  (من برنامج محلي يملك الكتابة أصلًا) غير ممنوع. مذكوران في ADR 0022.
- المفتاح يظهر في شاشة الصلاحيات (مخفيًّا حتى يُضغط «إظهار») وفي ملف الإعدادات 0600.
- الرجوع: المساعد مطفأ افتراضيًا؛ حذف `HelperSection` من الصفحة و`syncHelper` من المتحكّم يزيله.

## التسليم والخطوة التالية
- للمالك: تأكيد القرارات ١–٧، خاصة ٣ (لا لقطات شاشة ولا تحكم) و٧ (للوضع المحلي فقط الآن).
- التالي: الجزء ٤ — المثبّتات والتحقق من التحديثات.
