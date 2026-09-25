# اسم تطبيق سطح المكتب «Core Hub» بمسافة
المسؤول: twuijri · الفرع: fix/desktop-app-name · الحالة: review

## المشكلة والهدف
في 1.1.1 على الماك تفتح نافذة الـ DMG بعنوان `corehub 1.1.1-arm64` والتطبيق داخلها اسمه `corehub.app`
(صغير وبلا مسافة). المالك: «تطبيق الماك ما فيه مسافة؟». المطلوب أن يرى الشخص «Core Hub» في كل مكان:
اسم الـ `.app` وعنوان نافذة الـ DMG وشريط القوائم والـ Dock، واختصار قائمة ابدأ ومدخل إلغاء التثبيت وعناوين
النوافذ في ويندوز، و`Name` في مدخل سطح المكتب على لينكس — دون نقل بيانات أحد ودون كسر التحديث.

السبب: `executableName: 'corehub'` في أعلى `apps/desktop/electron-builder.config.cjs`. electron-builder يجعل
`productFilename` منه لكل المنصات، فيسمّي به حزمة الماك (`corehub.app`) واسم مجلد الـ DMG
(`${productFilename} ${version}${arch}` = `corehub 1.1.1-arm64`). اختبار الوحدة الجديد يعيد إنتاج هذين الاسمين
بكود electron-builder نفسه من الإعداد القديم. أما `productName` فكان «Core Hub» أصلًا، ولذلك كانت أسماء ويندوز
الظاهرة (الاختصار: `shortcutName` = productName، ومدخل إلغاء التثبيت «Core Hub 1.1.1»، وعناوين النوافذ من
`app.name` في i18n) و`Name=Core Hub` في لينكس و`CFBundleName` في الماك (شريط القوائم) صحيحة من قبل.

## القرار والموافقات
إصلاح في مكان واحد، الإعداد:
- حذف `executableName` من أعلى الإعداد، فحزمة الماك `Core Hub.app`.
- `dmg.title: '${productName} ${version}'`، فالنافذة «Core Hub 1.1.1» (بلا `-arm64`).
- `win.executableName: 'corehub'` و`linux.executableName: 'corehub'` ليبقى الملف التنفيذي كما كان: `corehub.exe` في
  مجلد تثبيت `corehub` (فالتحديث يستبدل الملفات نفسها، وملف MSIX يبقى `app\corehub.exe` كما يفحصه
  `check-windows-package.mjs`)، و`/opt/Core Hub/corehub` في لينكس (مسار اختبار الدخان). حزمة `.deb` تبقى `corehub`.
- لم يتغيّر: `appId` `com.twuijri.corehub`، بروتوكول `corehub://`، هوية MSIX واسمها «Core Hub»، أسماء ملفات
  الإصدار (`Core-Hub-1.1.1-arm64.dmg` …) لأنها من `artifactName` لا من الاسم التنفيذي، فلا يتغيّر
  `release-assets.mjs` ولا `publish-release.yml` ولا صفحة التنزيل، ومدقق التحديث يختار الملف بامتداده كما كان.

**مجلد البيانات:** تحققت عمليًا أن Electron يسمّي `userData` من `productName` في `package.json` لا من اسم الحزمة أو
الملف التنفيذي؛ تشغيل Electron 44.4.5 بـ `package.json` فيه `productName: "Core Hub"` أعطى `~/.config/Core Hub`.
فـ 1.1.1 (`corehub.app`) كان يكتب أصلًا في `~/Library/Application Support/Core Hub` و`%APPDATA%\Core Hub`
و`~/.config/Core Hub` (ويؤكده `msix-smoke.ps1` الذي يبحث في `%APPDATA%\Core Hub`). إعادة التسمية لا تنقل شيئًا،
فلا حاجة لترحيل. ومع ذلك ثبّتُّ المجلد باسمه: `src/shared/user-data.ts` (`USER_DATA_FOLDER = 'Core Hub'`)
و`app.setPath('userData', …)` في `src/main/index.ts` قبل أي قراءة، حتى لا ينقله أي تغيير لاحق للاسم. المسار المثبّت
يساوي الافتراضي حرفيًا (تحققت أيضًا بتشغيل Electron)، و`COREHUB_DESKTOP_USER_DATA` يبقى يتقدّم عليه.

**`corehub.app` القديم:** التحديث على الماك رابط لملف الـ DMG يسحب منه الشخص `Core Hub.app` إلى Applications، فيبقى
`corehub.app` القديم بجانبه (نفس معرّف الحزمة ونفس مجلد البيانات، وقفل النسخة الواحدة يمنع تشغيلهما معًا). يمكن
للتطبيق لاحقًا أن يكتشفه (`/Applications/corehub.app` بنفس `CFBundleIdentifier` وهو يعمل من `Core Hub.app`) ويعرض
نقله إلى سلة المهملات (`shell.trashItem`، لا حذف نهائي). لم أبنه هنا لإبقاء الإصلاح صغيرًا؛ مقترح — للمالك أن يقرر.
حتى ذلك: يُحذف `corehub.app` يدويًا بعد تثبيت الجديد. في ويندوز مثبّت NSIS يستبدل التثبيت نفسه (نفس المجلد ونفس
الملف)، وفي لينكس `.deb` نفس الحزمة، وAppImage ملف جديد باسم الإصدار كما كان.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `apps/desktop/electron-builder.config.cjs`: ما سبق.
- `apps/desktop/src/shared/user-data.ts` (جديد) و`apps/desktop/src/main/index.ts`: تثبيت مجلد البيانات.
- `apps/desktop/tests/unit/app-name.test.ts` (جديد): الأسماء بكود electron-builder نفسه (`AppInfo`
  و`DmgTarget.computeVolumeName`): `Core Hub.app` ونافذة «Core Hub 1.1.1»، وإعادة إنتاج `corehub.app` /
  `corehub 1.1.1-arm64` من الإعداد القديم، و`corehub` لويندوز ولينكس، والمعرّفات والبروتوكول وMSIX بلا تغيير،
  ومجلد البيانات `<appData>/Core Hub` = `productName`.
- `.github/workflows/desktop.yml`: خطوتان بعد التحزيم (أسماء الوظائف كما هي): الماك يتحقق من `Core Hub.app`
  و`CFBundleName` ويركّب الـ DMG ويتحقق من `/Volumes/Core Hub <version>/Core Hub.app`؛ لينكس يتحقق من حزمة
  `corehub` و`Name=Core Hub` و`/opt/Core Hub/corehub`. مشروطتان بوجود `user-data.ts` حتى لا يفشل بناء وسم قديم
  عبر `publish-release.yml`.
- `docs/STATUS.md`: سطر عن الاسم ومجلد البيانات.

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبار الجديد على الإعداد القديم (قبل الإصلاح) يفشل:
```
$ git stash push electron-builder.config.cjs && npx vitest run tests/unit/app-name.test.ts
     × names the macOS bundle Core Hub.app and the DMG window "Core Hub 1.1.1" 4ms
     × keeps the Windows and Linux binaries named corehub 1ms
      Tests  2 failed | 5 passed (7)
```
بعد الإصلاح:
```
$ node -e "…new AppInfo(…) / DmgTarget.prototype.computeVolumeName…"
mac "Core Hub" Core Hub
win "corehub" Core Hub
linux "corehub" Core Hub
Core Hub 1.1.1
old corehub 1.1.1-arm64
$ npx vitest run tests/unit            (apps/desktop)
 Test Files  10 passed (10)
      Tests  121 passed (121)
$ pnpm --filter @corehub/desktop typecheck
typecheck exit 0
$ pnpm lint
All matched files use Prettier code style!
```
مجلد البيانات في Electron 44.4.5 (Linux، Xvfb):
```
name-at-start Core Hub | userData-at-start /home/twuijri/.config/Core Hub
default=/home/twuijri/.config/Core Hub
pinned=/home/twuijri/.config/Core Hub
same=true
```
CI على PR #163 (الالتزام الأول): كل الفحوص نجحت، ومنها Installers (macos-latest / ubuntu-latest / windows-latest).
من سجل `desktop.yml` (run 36201321308):
```
bundle: apps/desktop/release/mac-arm64/Core Hub.app
DMG window: /Volumes/Core Hub 1.1.1
Core Hub.app
  • building        target=DMG arch=arm64 file=release/Core-Hub-1.1.1-arm64.dmg
Name=Core Hub
Exec="/opt/Core Hub/corehub" %U
  • building        target=deb arch=x64 file=release/corehub_1.1.1_amd64.deb
  • building        target=nsis file=release\Core-Hub-Setup-1.1.1-x64.exe archs=x64 oneClick=false perMachine=false
  • building        target=AppX arch=x64 file=release\Core-Hub-1.1.1-x64.msix
  executablePath=release\win-unpacked\corehub.exe
```

## المخاطر والرجوع
- مستخدم ماك يبقى عنده `corehub.app` بجانب `Core Hub.app` حتى يحذفه؛ البيانات مشتركة ولا تضيع.
- رابط `corehub://` على الماك قد يفتحه Launch Services بأي النسختين ما دامت القديمة موجودة.
- البناء الموقّع (`desktop-signed.yml`) يجد الحزمة بـ `release/mac*/*.app` فلا يتأثر بالاسم.
- الرجوع: إعادة `executableName: 'corehub'` إلى أعلى الإعداد وحذف `dmg.title`؛ تثبيت مجلد البيانات يبقى آمنًا لأنه
  يساوي الافتراضي.

## التسليم والخطوة التالية
PR https://github.com/twuijri/core-hub/pull/163 إلى `main` بالإنجليزية، بلا دمج ولا وسم. بعد الدمج يظهر الاسم الجديد في الإصدار التالي. مقترح للمالك: عرض
نقل `corehub.app` القديم إلى سلة المهملات من داخل التطبيق.
