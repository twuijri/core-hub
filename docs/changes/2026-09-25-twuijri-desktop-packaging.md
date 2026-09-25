# تطبيق سطح المكتب — المثبّتات والتحقق من التحديثات (الجزء ٤ من ٤)
المسؤول: twuijri · الفرع: feat/desktop-packaging · الحالة: review

## المشكلة والهدف
آخر أجزاء تطبيق سطح المكتب: مثبّتات يُنزّلها الناس (AppImage وdeb على لينكس، dmg على ماك، nsis على
ويندوز عبر CI)، وتوقيع الكود يُترك مهمة موثّقة يقررها المالك، وتحقق من إصدارات GitHub لـ
`twuijri/core-hub` يعرض إشعارًا ورابط تنزيل دون تحديث صامت، مع قياس أحجام المثبّتات. قال المالك:

> «كمل كل الشغل حتى لو تكمل تطبيق الديسك توب كامل … اي قرار تحتاجه مني اجله»

وقاعدة الحجم (ROADMAP §Sizes): ما يُنزَّل يبقى في «مئات قليلة» من الـMB، والأقل أفضل. الفرع مبنيّ
على `feat/desktop-helper` (#115).

## القرار والموافقات
كلها **مقترحة — تنتظر تأكيد المالك** (ADR 0023):

1. **electron-builder 26**: AppImage وdeb (لينكس x64)، dmg لماك بمعالجات Apple فقط (arm64) — لا Intel لأن `argon2` 0.45 لا يأتي مبنيًّا لـ darwin-x64 فلن يعمل الوضع المحلي عليه (ظهر في أول تشغيل للسير في CI)، NSIS (ويندوز
   x64، لكل مستخدم، ويختار المجلد). الأمر `pnpm --filter @corehub/desktop package` بعد `pnpm build`.
2. **أرشيف التطبيق بلا node_modules** (العملية الرئيسية حزمة واحدة)، والمركز المضمَّن بجانبه في
   `resources/hub`، وخطاف `afterPack` يُبقي ملفات SQLite وargon2 الخاصة بنظام المثبّت فقط، ونصوص
   Chromium للعربية والإنجليزية فقط.
3. **CI يبني ولا ينشر**: `.github/workflows/desktop.yml` يعمل عند تغيّر `apps/desktop` (ويدويًا مع رقم
   إصدار)، يحفظ الملفات أثرًا للسير ١٤ يومًا، ويكتب الأحجام في ملخص السير، ويشغّل على لينكس اختبارات
   الدخان الثلاثة على **التطبيق المحزوم نفسه**. إرفاقها بإصدار GitHub خطوة المالك.
4. **توقيع الكود مهمة للمالك (TODO)**: لا Developer ID/توثيق من Apple ولا شهادة Authenticode لويندوز.
   المثبّتات غير الموقّعة تُفتح مع تحذير Gatekeeper/SmartScreen.
5. **التحقق من التحديثات**: يقرأ `api.github.com/repos/twuijri/core-hub/releases` دون رمز (لا يُرسل إلا
   رقم إصدار التطبيق في User-Agent)، وحده مرة في اليوم على الأكثر (مفتاح في «هذا الجهاز» يطفئه)، وكلما
   ضغط الشخص «تحقّق الآن». الإصدار يُحسب إن كان منشورًا وأحدث وفيه مثبّت لهذا النظام والمعمارية؛ والإصدارات
   التجريبية (قناة test) لا تُعرض إلا لتطبيق هو نفسه تجريبي — وكل إصدارات المستودع الآن تجريبية
   (`v0.1.0-alpha.*`). الجواب إشعار في «هذا الجهاز»، ومرة واحدة لكل إصدار من النظام، مع رابط المثبّت
   وملاحظات الإصدار. **لا ينزّل التطبيق شيئًا ولا يثبّته**.
6. رفضت electron-updater (تحديث صامت، ويحتاج توقيعًا على ماك) ورفّ التحديثات في المركز كمصدر وحيد
   (في الوضع المحلي المركز هو التطبيق نفسه)؛ الرفّ يمكن إضافته مصدرًا ثانيًا.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `apps/desktop/electron-builder.config.cjs`، `scripts/package.mjs`، `scripts/after-pack.cjs` (جديدة)،
  `package.json` (electron-builder، والاعتمادات كلها للتطوير، وبيانات الحزمة).
- `apps/desktop/src/shared/updates.ts` و`src/main/updates.ts` (جديدان)، وتعديل `controller.ts`
  و`preload/index.ts` و`shared/{config,ipc}.ts` وملفَي اللغة.
- `packages/web/src/desktop/UpdatesSection.tsx` (جديد)، `desktop/bridge-types.ts`،
  `settings/ThisDeviceTab.tsx`، ملفا اللغة، والاختبار.
- `.github/workflows/desktop.yml` (جديد)، `pnpm-workspace.yaml` (`electron-winstaller: false`)،
  `pnpm-lock.yaml`.
- `docs/adr/0023-desktop-installers-and-updates.md`، `docs/STATUS.md`، `apps/desktop/README.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!

$ pnpm contracts:check-clients
check-clients  OK — 326 client file(s) scanned, 176 contract path(s) known.

$ pnpm i18n:check
i18n:check  desktop: 80 keys, ar/en in parity
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web, desktop

$ pnpm --filter @corehub/desktop typecheck      desktop tc=0
$ pnpm --filter @corehub/web exec tsc (src + tests)   web tc=0, web test tc=0

$ pnpm --filter @corehub/desktop test
 Test Files  8 passed (8)
      Tests  94 passed (94)

$ pnpm --filter @corehub/web exec vitest run tests/desktop-surface.test.tsx
      Tests  18 passed (18)

$ pnpm build && xvfb-run -a pnpm --filter @corehub/desktop test:smoke
  ✓  1 … remote mode: connect, sign in, chat, This device (2.5s)
  ✓  2 … pairing: a link from a signed-in device signs this computer in (1.4s)
  ✓  3 … local mode: no Hermes found → the hub starts on this computer anyway → first-run setup (3.6s)
  3 passed (10.7s)

$ pnpm --filter @corehub/desktop package --linux
| Installer | Size |
|---|---|
| Core-Hub-0.0.0-x86_64.AppImage | 125.8 MB |
| corehub_0.0.0_amd64.deb | 99.9 MB |

$ COREHUB_DESKTOP_SMOKE_EXECUTABLE=…/release/linux-unpacked/corehub xvfb-run -a pnpm --filter @corehub/desktop test:smoke
  ✓  1 … remote mode: connect, sign in, chat, This device (2.8s)
  ✓  2 … pairing: a link from a signed-in device signs this computer in (1.3s)
  ✓  3 … local mode: no Hermes found → the hub starts on this computer anyway → first-run setup (3.4s)
  3 passed (10.6s)
```
الحجم قبل تقليم لغات Chromium كان 128.4 MB وAppImage و101.9 MB للـdeb. من 298 MB غير مضغوطة، 219 MB
ملف Electron التنفيذي وحده، وحصة التطبيق (الويب والعملية الرئيسية والمركز المضمَّن) نحو 16 MB.
وأحجام الأنظمة الثلاثة من سير «Desktop installers» في CI (التشغيل 36087111669):
```
| Core-Hub-Setup-0.0.0-x64.exe   | 105.5 MB |   (Windows, NSIS)
| Core-Hub-0.0.0-arm64.dmg       | 118.4 MB |   (macOS, Apple silicon)
| Core-Hub-0.0.0-x86_64.AppImage | 125.8 MB |   (Linux)
| corehub_0.0.0_amd64.deb        |  99.7 MB |   (Linux)
``` اختبارات التحديث لا تسأل GitHub (جلب مزيَّف)، والتطبيق
في اختبارات الدخان لا يتحقق وحده (`COREHUB_DESKTOP_NO_AUTO_UPDATE=1`).

CI على #116 — كلها ناجحة، ومنها المثبّتات الثلاثة، واختبار الدخان على تطبيق لينكس المحزوم:
```
pass  Installers (ubuntu-latest)     (AppImage + deb، ثم اختبارات الدخان الثلاثة على المحزوم)
pass  Installers (macos-latest)      (dmg arm64 — التشغيل الأول سقط: argon2 بلا darwin-x64، فصار arm64 فقط)
pass  Installers (windows-latest)    (NSIS x64)
pass  Lint, typecheck, contracts, tests, build
pass  Desktop app smoke (Electron under Xvfb against the real hub)
pass  Web smoke journeys (Playwright against the real hub)
pass  Docker image builds and answers /health
pass  db:generate + db:migrate (SQLite and PostgreSQL)
pass  PR adds or updates a change record
pass  PR leaves graphify-out/ to the code-map bot
```

## المخاطر والرجوع
- مثبّتات غير موقّعة: تحذير عند الفتح على ماك وويندوز حتى يقرر المالك التوقيع.
- حدود GitHub للطلبات دون رمز (٦٠ في الساعة لكل عنوان IP) أعلى بكثير من طلب يومي؛ إن رفض GitHub
  تقول الصفحة لماذا.
- الرجوع: حذف `desktop.yml` وقسم التحديثات؛ المتحكّم يتجاهل الإعداد.

## التسليم والخطوة التالية
- للمالك: تأكيد القرارات ١–٦، وقرار التوقيع (شهادتا Apple وWindows)، ومتى تُرفق المثبّتات بإصدارات
  `v0.1.0-alpha.*` (الإصدار نفسه لرقم الخادم، TEAM-RULES §6).
- بعد دمج الأجزاء الأربعة: ما بقي من «هذا الجهاز» (الصوت) ينتظر وحدة الصوت على سطح المكتب.
