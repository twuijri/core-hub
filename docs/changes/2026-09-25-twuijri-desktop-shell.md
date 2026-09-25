# تطبيق سطح المكتب — الغلاف والوضع البعيد (الجزء ١ من ٤)
المسؤول: twuijri · الفرع: feat/desktop-app · الحالة: review

## المشكلة والهدف
المرحلة الثالثة في `docs/ROADMAP.md` تطلب `apps/desktop`: عميل الويب داخل غلاف، بوضعين
(ADR 0009)، دون أن يحمل هرمز. لم يكن في المستودع شيء منه. قال المالك قبل أن ينام:

> «كمل كل الشغل حتى لو تكمل تطبيق الديسك توب كامل … اي قرار تحتاجه مني اجله»

فهذا الجزء الأول من أربعة: اختيار الغلاف، وشاشة التشغيل الأول، والوضع البعيد كاملًا
(عنوان المركز أو رابط ربط)، وحالة النافذة، وشريط النظام والقوائم، وإشعارات النظام، وروابط
`corehub://`، والنسخة الواحدة، وتبويب «هذا الجهاز»، بالعربية والإنجليزية، مع اختبارات
ووظيفة CI. الأجزاء التالية: الوضع المحلي، ثم المساعد المحلي (MCP)، ثم الحزم والتحقق من
التحديثات.

## القرار والموافقات
كل قرار هنا **مقترح — ينتظر تأكيد المالك** (كان نائمًا وطلب تأجيل أسئلته):

1. **Electron لا Tauri** (ADR 0020). المقاس على هذا الجهاز: وقت تشغيل Electron 44.4.5 مضغوطًا
   بـ xz ‏91.8 MB (ملف التنزيل zip ‏123 MB)، وملف Node 24 الذي يحتاجه Tauri بجانبه للوضع المحلي
   29.9 MB. Tauri لم يُقَس (لا أدوات Rust على الجهاز). السبب: الوضع المحلي يحتاج Node في
   الحالتين، ومحرك رسم واحد (Chromium) هو نفسه الذي تُختبر به واجهة الويب والعربية، بدل ثلاثة
   محركات. الثمن نحو 55–65 MB إضافية، داخل قاعدة المالك («مئات قليلة»).
2. **التطبيق يحمل عميل الويب نفسه** ويقدّمه من عنوان محلي خاص به (`127.0.0.1` ومنفذ يُحفظ
   بين التشغيلات) ويمرّر `/api` و`/rt` — الطلبات وSSE وWebSocket — إلى المركز. عميل الويب لم
   يتغيّر في طريقة اتصاله، ولا يحتاج أي مركز إلى CORS، ولا يعبر رمز الدخول بين أصلين. يُرفض كل
   طلب ليس `Host` فيه هذا العنوان (حماية من DNS rebinding).
3. **لكل مركز مخزن منفصل** (`persist:hub-<بصمة العنوان>`): دخولك إلى مركز لا يصل إلى غيره،
   وتبديل المركز أو الوضع يُبقي بيانات كلٍّ في مكانها (ADR 0009).
4. **الربط من الحاسوب برابط لا بمسح QR**: الحاسوب لا يمسح شاشته، فصارت بطاقة الربط في «اتصالات
   الأجهزة» تعرض رابط `corehub://pair?…` مع زر نسخ؛ فتحه على الحاسوب يطلب تأكيدًا ثم يربط، أو
   يُلصق في شاشة التشغيل الأول (يُقبل كذلك نص QR نفسه). المسح بالكاميرا مؤجَّل.
5. **رابط `corehub://connect` لا يتصل وحده**: يملأ العنوان فقط، والشخص يضغط «اتصال» — حتى لا
   يوجّه رابطٌ من الخارج التطبيق إلى مركز غريب يطلب كلمة المرور.
6. **سطح `desktop` يرث مسارات الويب** في `navigation.json` (`"$extends": "web"`) ويضيف
   `this_device` فقط؛ `nav:check` يحلّ الوراثة كما يحلّها العميل، فأي وجهة جديدة تُضاف مرة واحدة.
7. **«هذا الجهاز»**: وضع الاتصال، وعنوان المركز وحالته، وتغيير الاتصال، وإصدار التطبيق، والنظام،
   ومفتاح «استمر في العمل عند إغلاق النافذة». الصوت (الإدخال الصوتي ولغة الإملاء والردود
   المنطوقة) غير مبني ويقول الصفحة ذلك صراحة بدل مفاتيح لا تعمل.
8. **إغلاق النافذة يُبقي التطبيق في شريط النظام** افتراضيًا حيث يوجد شريط؛ حيث لا يوجد يُنهي
   الإغلاقُ التطبيق، والصفحة تقول ذلك.
9. **لا يسجّل التطبيق مخطط `corehub://` في النظام إلا وهو مثبَّت** (لا في التطوير ولا الاختبار)،
   حتى لا يغيّر تشغيلٌ تجريبي معالجات الروابط على جهاز أحد.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. التطبيق يستخدم العميل المولَّد (`meta.get` و`auth.claimPairing`)؛ `check-clients` يفحص
`apps/*` ولا يجد مسارًا مكتوبًا باليد.

## الملفات والتأثير
- `apps/desktop/` (جديد): `src/main` (العملية الرئيسية، الوكيل المحلي `proxy.ts`، القوائم،
  الإعدادات)، `src/preload` (الجسر)، `src/renderer` (شاشة التشغيل الأول)، `src/shared` (منطق صافٍ
  مختبَر)، `src/i18n/{ar,en}.json`، `assets/` (أيقونات مرسومة من `docs/assets/core-hub-mark-light.svg`)،
  `scripts/build.mjs` و`scripts/electron-install.mjs`، `tests/unit` و`tests/smoke`، `README.md`.
- `packages/web`: `src/desktop/` (نوع الجسر وكشف السطح وتسليم جلسة الربط وتأثيرات النافذة)،
  `settings/ThisDeviceTab.tsx`، `navigation/manifest.ts` (السطح يُكشف وقت التشغيل)، `main.tsx`،
  `notify/queries.ts` و`NotificationsTab.tsx` (`noticeTarget` مشتركة، والإشعار يصل إلى النظام)،
  `shell/Sidebar.tsx`، `screens/DeviceConnectionsScreen.tsx` (رابط الربط)، ملفا اللغة، واختبار
  `tests/desktop-surface.test.tsx`. في المتصفح لا يتغيّر شيء: كل ما سبق لا يعمل بلا الجسر.
- `docs/clients/navigation.json` و`scripts/navigation-check.mjs`: سطح `desktop`.
- `pnpm-workspace.yaml`: `electron: false` في `allowBuilds` (لا يُنزَّل وقت التشغيل في كل تثبيت).
- `.github/workflows/ci.yml`: وظيفة `desktop` (بناء + اختبار الدخان تحت Xvfb).
- `docs/adr/0020-desktop-shell-electron.md`، `docs/STATUS.md`، `.gitignore`، `.prettierignore`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm contracts:check-clients
check-clients  OK — 309 client file(s) scanned, 176 contract path(s) known.

$ pnpm i18n:check
i18n:check  desktop: 64 keys, ar/en in parity
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web, desktop

$ pnpm --filter @corehub/desktop typecheck      (tsc للعملية الرئيسية ثم للنافذة والجسر: بلا أخطاء)
$ pnpm --filter @corehub/web typecheck          (بلا أخطاء)

$ pnpm --filter @corehub/desktop test
 Test Files  4 passed (4)
      Tests  52 passed (52)

$ pnpm --filter @corehub/web exec vitest run tests/desktop-surface.test.tsx tests/navigation.parity.test.tsx \
    tests/notifications.test.tsx tests/agents-top-level.test.tsx tests/schedule-runs.test.tsx \
    tests/ui-layer.test.ts tests/settings-pages.test.tsx
 Test Files  7 passed (7)
      Tests  61 passed (61)

$ pnpm build && xvfb-run -a pnpm --filter @corehub/desktop test:smoke
Running 2 tests using 1 worker
  ✓  1 tests/smoke/desktop.spec.ts:37:1 › remote mode: connect, sign in, chat, This device (2.8s)
  ✓  2 tests/smoke/desktop.spec.ts:97:1 › pairing: a link from a signed-in device signs this computer in (1.5s)
  2 passed (7.5s)
```
وأن `nav:check` يسقط إن نقص مسار على سطح المكتب جُرِّب يدويًا بحذف `this_device`:
`error  surfaceRoutes.desktop: destination "this_device" has no route`.

اختبار الدخان يشغّل التطبيق الفعلي (Electron) على مركز حقيقي (خادم e2e بمشغّل وكيل مكتوب):
عنوان خاطئ يُرفض بالعربية، ثم الاتصال، ثم تسجيل الدخول، ثم رسالة يعود ردّها متدفقًا عبر
WebSocket من خلال الأصل المحلي، ثم «هذا الجهاز» يعرض المركز، ثم «تغيير الاتصال» يعيد إلى شاشة
التشغيل الأول والعنوان محفوظ؛ والاختبار الثاني يربط حاسوبًا ثانيًا برابط الربط فيدخل بلا كلمة
مرور، والمركز يقول `claimed`.

CI على #111 (التشغيل 36083937801) — كلها ناجحة:
```
pass  Lint, typecheck, contracts, tests, build              17m57s
pass  Desktop app smoke (Electron under Xvfb against the real hub)   1m26s
pass  Web smoke journeys (Playwright against the real hub)  5m23s
pass  Docker image builds and answers /health                3m26s
pass  db:generate + db:migrate (SQLite and PostgreSQL)       1m3s
pass  PR adds or updates a change record                    11s
pass  PR leaves graphify-out/ to the code-map bot           9s
```

## المخاطر والرجوع
- حجم المثبّت (Chromium) نحو 95–110 MB مضغوطًا؛ يُقاس فعليًا في الجزء ٤.
- الأصل المحلي يمرّر الطلبات كما هي ولا يضيف رمزًا؛ عملية أخرى على الجهاز تستطيع الوصول إلى
  المركز عبره كما تستطيع مباشرة، لا أكثر.
- عند إنهاء التطبيق: التنظيف يجري في `before-quit` لأن Electron بعد `will-quit` لا يشغّل مؤقتات
  Node (رأيته: الإنهاء كان يعلق ١٨ ثانية).
- الرجوع: حذف `apps/desktop` ووظيفة `desktop` من CI؛ تغييرات الويب لا تعمل في المتصفح أصلًا،
  و`surfaceRoutes.desktop` يُحذف مع تعديل `nav:check`.

## التسليم والخطوة التالية
- للمالك: تأكيد القرارات ١–٩ أعلاه (أهمها Electron، والربط بالرابط بدل الكاميرا).
- التالي على الفرع نفسه: الجزء ٢ — الوضع المحلي (المركز المضمَّن، كشف هرمز، «ثبّت هرمز» بمثبّته
  الرسمي).
