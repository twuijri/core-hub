# قنوات إصدار سطح المكتب: متجر مايكروسوفت (MSIX) وإصدار GitHub لكل وسم
المسؤول: twuijri · الفرع: feat/desktop-release-channels · الحالة: review

## المشكلة والهدف
وسم `v*` على main كان يبني الصورة والنسخ الموقّعة (أندرويد، iOS، ماك) ملفاتٍ في Actions فقط، ولا
يصنع إصدار GitHub؛ فلا مكان يحمّل منه الناس المثبّتات، وفحص التحديث في التطبيق يقرأ إصدارات GitHub
فلا يجد شيئًا. وويندوز له مثبّت `.exe` غير موقّع فقط، والمالك يريد أيضًا متجر مايكروسوفت.

الهدف: (١) حزمة MSIX لمتجر مايكروسوفت بهوية المنتج، لا تفحص التحديثات بنفسها، ويعمل فيها الوضع
المحلي؛ (٢) إصدار GitHub لكل وسم يحمل كل الملفات ويوسَم «latest»، مع تشغيل يدوي لوسم موجود (v1.1.0)؛
(٣) خطوات الرفع اليدوي الأول للمتجر ونصوص صفحته بالعربية والإنجليزية؛ (٤) ملاحظة SmartScreen للـ`.exe`.

## القرار والموافقات
قرارات المالك (٢٠٢٦-٠٩-٢٥): ويندوز بطريقتين — `.exe` غير موقّع على إصدار GitHub مع فحص التحديث
(«يكون بالريبو يقدر يحمله اي اكس اي»)، ومتجر مايكروسوفت بـMSIX يوقّعه المتجر. هوية المنتج في Partner
Center: `AbdulazizAltuwijri.CoreHub`، الناشر `CN=814A0A23-0E7E-4406-8883-4E483DF08BDA`، الاسم الظاهر
`Abdulaziz Altuwijri`، المعرّف `9MT62R5V3P5N`، العائلة `AbdulazizAltuwijri.CoreHub_ndbdgnrvvdj6j`.
لينكس AppImage و`.deb` غير موقّعين؛ ماك الـdmg الموثّق؛ أندرويد الـAPK الموقّع على الإصدار؛ iOS عبر
TestFlight فقط.

ما بُني عليه (ضمن التوجيه، مقترح — للمالك أن يؤكد):
- **علَم وقت البناء + حماية وقت التشغيل:** `COREHUB_CHANNEL=store` في التحزيم يختم `corehubChannel: store`
  في `package.json` داخل التطبيق؛ ويُعدّ التطبيق نفسه نسخة متجر أيضًا متى كان `process.windowsStore`
  صحيحًا (أي داخل أي حزمة MSIX)، فلا تفحص نسخة المتجر GitHub حتى لو غاب الختم. قسم التحديثات يقول
  «التحديثات تأتي من متجر مايكروسوفت» ويربط صفحة المتجر.
- **الـMSIX تشغيل تحزيم ثانٍ** على ويندوز (`--win appx`) لا هدف إضافي في التشغيل نفسه، لأن الختم يختلف
  بين النسختين. النسخة `X.Y.Z.0` (دالة `msixVersion`)، ولاحقة المعاينة تُحذف.
- **سير عمل واحد باعتماديات بين المهام (`publish-release.yml`) بدل `workflow_run`:** يستدعي
  `desktop.yml` (ويندوز ولينكس) و`desktop-signed.yml` و`android-signed.yml` كسير عمل قابل لإعادة
  الاستخدام، ثم مهمة أخيرة وحدها بصلاحية `contents: write`. لذلك أُزيل مشغّل الوسم من
  `desktop-signed.yml` و`android-signed.yml` (يعملان على الوسم عبره الآن)؛ `ios-signed.yml` و`release.yml`
  كما هما.
- **`versionCode` لأندرويد في الإصدار = رقم تشغيل *Publish release* + 1000** (بدل +100)، لأن عدّاد هذا
  السير يبدأ من 1 فيكون أصغر من بناءات يدوية سابقة فيرفض الهاتف التحديث.
- **لا ملفات `latest*.yml`:** التطبيق لا يستخدم electron-updater؛ فحصه يقرأ قائمة إصدارات GitHub ويختار
  المثبّت بالاسم. الأسماء في مكان واحد (`apps/desktop/scripts/release-assets.mjs`) واختبار يربطها
  بـ`artifactName` في electron-builder وبـ`assetFor`.
- **ملاحظات الإصدار:** عناوين طلبات الدمج منذ الوسم السابق من «generate release notes» في GitHub، حتى
  20 سطرًا، تحت عنوان إنجليزي مع جدول التنزيلات وخطوة SmartScreen.
- **v1.1.0 أقدم من هذا العمل:** تشغيل *Publish release* يدويًا بـ`tag=v1.1.0` يبني كود الوسم بسير عمل
  main، وكود v1.1.0 لا يعرف الـMSIX ولا قناة المتجر؛ فإصداره يخرج بلا `.msix` (خطوات الـMSIX تتخطّى
  إن لم يوجد `msix-smoke.ps1` في كود الوسم، والملاحظات تقول إن حزمة المتجر تبدأ بإصدار لاحق). لرفع
  المتجر يلزم إصدار بعد هذا التغيير (مثلًا 1.1.1).
- **الرفع للمتجر يدوي** في Partner Center؛ أتمتته (msstore CLI + تطبيق Entra) موثّقة لاحقًا ولم تُبنَ.
- **SignPath Foundation** خيار مجاني لتوقيع الـ`.exe` لاحقًا، مذكور في الوثائق والملاحظات فقط.
- **لوحات المتجر:** `build-icons.mjs` يصنع `apps/desktop/assets/appx` (StoreLogo وSquare44x44 وSmallTile
  وSquare150x150 وLargeTile وWide310x150 بمقاسات 100/200/400٪ ومقاسات شريط المهام)؛ بلا شاشة بداية
  (لا تظهر لتطبيقات سطح المكتب).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `apps/desktop/electron-builder.config.cjs`: قسم `appx` بهوية المتجر واللغتين والنسخة بلا رقم بناء
  واسم الملف `Core-Hub-${version}-${arch}.msix`.
- `apps/desktop/scripts/package.mjs`: `COREHUB_CHANNEL=store` يبني `--win appx --x64` ويختم القناة و`X.Y.Z`.
- `apps/desktop/scripts/release-assets.mjs` (+`.d.mts`) جديد: `msixVersion`، أسماء ملفات الإصدار،
  `collect` (يفشل إن نقص ملف)، `releaseNotes`، وسطر أوامر للسير.
- `apps/desktop/scripts/check-windows-package.mjs` جديد: يقرأ `package.json` من `app.asar` (القناة
  والنسخة) ويفحص بيان الـMSIX (الهوية، الناشر، `X.Y.Z.0`، اللغتان، `corehub://`، اللوحات، `runFullTrust`،
  المركز المضمَّن).
- `apps/desktop/scripts/msix-smoke.ps1` جديد: يوقّع نسخة بشهادة مؤقتة لنفس الناشر، يثبّتها، يتحقق أن
  العائلة = Partner Center، يشغّلها كتطبيق متجر في الوضع المحلي ويتحقق من `/api/v1/health` ومكان قاعدة
  البيانات، ثم يزيل الحزمة والشهادة.
- `apps/desktop/scripts/build.mjs`: لا ينسخ `assets/appx` داخل التطبيق.
- `apps/desktop/src/shared/updates.ts`: `UpdateChannel`، `updateChannel`، `checksGitHub`، `STORE_PAGE`.
- `apps/desktop/src/main/updates.ts`: `checkForUpdate` لا يسأل GitHub في قناة المتجر؛ `appChannel`.
- `apps/desktop/src/main/controller.ts`: لا فحص تلقائي ولا يدوي في قناة المتجر؛ حالة التحديثات تحمل
  `channel` وصفحة المتجر.
- `apps/desktop/src/main/index.ts`: داخل MSIX لا يضبط `AppUserModelId` ولا يسجّل البروتوكول بنفسه.
- `packages/web/src/desktop/UpdatesSection.tsx` و`bridge-types.ts`: عرض نسخة المتجر؛ مفتاحان في
  `packages/web/src/i18n/{ar,en}.json` (`desktop_updates.from_store`، `desktop_updates.store_page`).
- `scripts/icons/build-icons.mjs` و`apps/desktop/assets/appx/*` (28 صورة).
- `.github/workflows/desktop.yml`: `workflow_call` (ref، version، targets)؛ على ويندوز فحص قناة الـ`.exe`،
  تحزيم الـMSIX وفحصه وتشغيله؛ رفع `*.msix`؛ أسماء المهام كما هي.
- `.github/workflows/publish-release.yml` جديد؛ `desktop-signed.yml` و`android-signed.yml`: `workflow_call`
  بدل مشغّل الوسم، `BUILD_REF`، `--tag` لفحص النسخة، `+1000` لأندرويد في الإصدار.
- الاختبارات: `apps/desktop/tests/unit/release-assets.test.ts` جديد، `apps/desktop/tests/unit/updates.test.ts`،
  `packages/web/tests/desktop-surface.test.tsx`.
- الوثائق: `docs/RELEASING.md` (أين يُشحن كل نظام، إصدار GitHub، ويندوز والمتجر وحدود MSIX وخطوات
  Partner Center والأتمتة اللاحقة)، `docs/store/microsoft/listing-en.md` و`listing-ar.md`،
  `apps/desktop/README.md`، `docs/STATUS.md`.

### ما وُجد تحت MSIX (من تشغيل CI على ويندوز)
- الحزمة تُثبَّت بعائلة `AbdulazizAltuwijri.CoreHub_ndbdgnrvvdj6j` — مطابقة لـPartner Center (الهوية
  والناشر صحيحان).
- الوضع المحلي يعمل: المركز المضمَّن أجاب `/api/v1/health` بعد ثوانٍ (`{"ok":true,"server_version":"1.1.0"}`).
- كتابات `%APPDATA%\Core Hub` تُحوَّل إلى مجلد الحزمة
  (`%LOCALAPPDATA%\Packages\…\LocalCache\Roaming\Core Hub\local-hub\hub.sqlite`)، لا إلى مجلد التثبيت،
  ولا إلى `%APPDATA%` الحقيقي. **حذف تطبيق المتجر يحذف بيانات المركز المحلي.**
- لم يُجرَّب في CI (من سلوك MSIX الموثّق): Hermes المثبّت خارج التطبيق يُرى؛ أما «تثبيت Hermes» من داخل
  نسخة المتجر فيكتب في نسخ الحزمة الخاصة (الملفات وPATH في HKCU)، فيراه التطبيق ومركزه ولا تراه
  الطرفية، ويُحذف مع التطبيق. موثّق في RELEASING.md.
- حجم الـMSIX ‏154.6 MB مقابل 106.0 MB للـ`.exe` (ضغط makeappx أخف).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (عبر `mj-run`، بعد دمج origin/main):

```
$ pnpm lint
All matched files use Prettier code style!                                  → exit 0
$ pnpm typecheck                                                            → exit 0
$ pnpm i18n:check
i18n:check  OK
$ pnpm version:check
version: 1.1.0 everywhere (8 places)
$ node scripts/icons/build-icons.mjs --check
icons: 54 files up to date
$ pnpm --filter @corehub/desktop exec vitest run
 Test Files  9 passed (9)
      Tests  114 passed (114)
$ pnpm --filter @corehub/web exec vitest run tests/desktop-surface.test.tsx
 Test Files  1 passed (1)
      Tests  19 passed (19)
$ node apps/desktop/scripts/check-windows-package.mjs asar app.asar github 1.1.0   (asar مصنوع بـ@electron/asar وفيه corehubChannel=store)
asar: app.asar channel=store version=1.1.0
::error::app.asar: channel store, expected github                          → exit 1
```

CI — تشغيل يدوي لـ`desktop.yml` على الفرع (run 36180283979، الثلاث مهام success)، خطوات ويندوز:

```
| Core-Hub-Setup-1.1.0-x64.exe | 106.0 MB |
asar: app.asar channel=github version=1.1.0
| Core-Hub-1.1.0-x64.msix | 154.6 MB |
asar: app.asar channel=store version=1.1.0
msix: manifest 1.1.0.0, 28 tiles
Installed AbdulazizAltuwijri.CoreHub_1.1.0.0_x64__ndbdgnrvvdj6j
corehub processes: 5
health: {"ok":true,"server_version":"1.1.0","uptime_seconds":3}
hub.sqlite (package folder): C:\Users\runneradmin\AppData\Local\Packages\AbdulazizAltuwijri.CoreHub_ndbdgnrvvdj6j\LocalCache\Roaming\Core Hub\local-hub\hub.sqlite
hub.sqlite in the real %APPDATA%\Core Hub: False
```

CI على طلب الدمج: يُضاف بعد اكتماله.

`publish-release.yml` لم يُشغَّل (يعمل على وسم أو يدويًا فقط، وهذا للمالك).

## المخاطر والرجوع
- `publish-release.yml` لم يُجرَّب على وسم حقيقي؛ أول تشغيل هو إصدار المالك. `collect` يفشل قبل أي
  نشر إن نقص ملف، والإصدار يُنشأ أو يُحدَّث فقط في المهمة الأخيرة.
- إزالة مشغّل الوسم من `desktop-signed.yml` و`android-signed.yml`: إن فشل `publish-release.yml` قبل
  استدعائهما لا يُبنى الـdmg ولا الـAPK لذلك الوسم؛ يعاد بالتشغيل اليدوي لـ*Publish release*.
- الـMSIX غير موقّع؛ لا يثبّته الناس من الإصدار مباشرة (الملاحظات تقول ذلك).
- الرجوع: revert لهذا الدمج يعيد مشغّلات الوسم كما كانت ويزيل الـMSIX؛ لا بيانات ولا عقد تتأثر.

## التسليم والخطوة التالية
- المالك: دمج الطلب، ثم Actions → *Publish release* → Run workflow على main بـ`tag=v1.1.0` لإصدار v1.1.0
  (بلا `.msix`). لحزمة المتجر: إصدار 1.1.1 (رفع النسخة، `pnpm version:check --write`، دمج، وسم `v1.1.1`)
  ثم تنزيل `Core-Hub-1.1.1-x64.msix` من إصداره واتباع «The first Microsoft Store submission» في
  `docs/RELEASING.md`، مع رابط سياسة الخصوصية ولقطات الشاشة.
- لاحقًا باختيار المالك: توقيع الـ`.exe` عبر SignPath Foundation، وأتمتة رفع المتجر بـmsstore.
