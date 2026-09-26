# اسم «Core Hub» بمسافة في ويندوز ولينكس أيضًا
المسؤول: twuijri · الفرع: fix/desktop-app-name-win-linux · الحالة: review

## المشكلة والهدف
بعد #163 صار تطبيق الماك `Core Hub.app`، وبقي في ويندوز `corehub.exe` في مجلد `corehub`، وفي لينكس
`/opt/Core Hub/corehub`. المالك: «ويندوز ولينكس ابيها بعد بمسافة». المطلوب «Core Hub» في كل ما يراه الشخص، مع ترقية
نظيفة من 1.1.1 (بلا `corehub.exe` ولا اختصارات قديمة باقية) وإعادة توجيه كل ما حفظ مسار الملف القديم، دون تغيير أسماء
ملفات الإصدار.

## القرار والموافقات
**ويندوز:** حذف `win.executableName`، فالملف `Core Hub.exe` ومجلد التثبيت الافتراضي `Programs\Core Hub` (اسم
electron-builder الافتراضي من productName). وMSIX يتبعه (`app\Core Hub.exe`؛ لا إرسال للمتجر بعد).
- **الترقية من 1.1.1:** NSIS يثبّت الترقية في المجلد المحفوظ في السجل (`Programs\corehub`)، وصفحة المجلد التفاعلية
  تضيف `\Core Hub` لمجلد لا يحمل الاسم فتصير `corehub\Core Hub`. `apps/desktop/scripts/installer.nsh`
  (`nsis.include`) يعيد توجيه التثبيت في `customCheckAppRunning` — داخل قسم التثبيت قبل أن يشغّل NSIS برنامج
  إزالة 1.1.1 — إلى `Programs\Core Hub` بجانب القديم (للحالتين `\corehub` و`\corehub\Core Hub`) ثم يشغّل الفحص
  الافتراضي كما هو. برنامج إزالة 1.1.1 (نفس appId، فيُشغَّل بـ `--updated`) يفرغ مجلده ويحذف اختصاراته، والمثبّت
  الجديد ينشئ اختصارات «Core Hub» إلى `Core Hub.exe` ومدخل إزالة واحدًا.
- **`corehub://`:** التطبيق يسجّله لنفسه عند كل تشغيل، لكن تسجيل 1.1.1 يشير إلى `corehub.exe` المحذوف حتى أول تشغيل؛
  `customInstall` يكتب نفس مفاتيح Electron إلى `Core Hub.exe` فورًا، و`customUnInstall` في إزالة حقيقية (لا ترقية)
  يحذفه إن كان ما زال يشير لهذه النسخة.
- **اختصارات الشخص نفسه** (تثبيت في شريط المهام أو قائمة ابدأ، نسخة على سطح المكتب، اختصار في Startup للفتح عند
  الدخول): لا يعرفها المثبّت. `src/shared/legacy-shortcuts.ts` + `src/main/legacy-shortcuts.ts`: عند التشغيل
  (ويندوز، نسخة مثبّتة، ليست المتجر) كل `.lnk` في تلك المجلدات يشير إلى `corehub.exe` غير موجود يُوجَّه إلى
  `process.execPath` (مع «Start in» والأيقونة)، ولا يُلمس غيره.
- **الدخول التلقائي/login item:** التطبيق لا يستخدم `setLoginItemSettings` ولا أي خيار فتح عند الدخول، فلا مسار
  محفوظ للترحيل؛ اختصار Startup اليدوي مغطّى أعلاه. **الـ tray** لا يحفظ مسارًا. **AppUserModelId** ثابت
  `com.twuijri.corehub`.

**لينكس:** `linux.executableName: 'core-hub'` — الأمر `/opt/Core Hub/core-hub` و`/usr/bin/core-hub`. اخترت
`core-hub` لا `Core Hub`: اسم أمر بمسافة (`/usr/bin/Core Hub`) يحتاج اقتباسًا في كل طرفية وسكربت، وelectron-builder
يقتبس `Exec` تلقائيًا بسبب مسافة المجلد (`Exec="/opt/Core Hub/core-hub" %U`). ما يراه الشخص: `Name=Core Hub` في
القائمة ومجلد `/opt/Core Hub`. يبقى `corehub` عمدًا:
- حزمة `.deb` `corehub`: أسماء حزم Debian لا تقبل المسافات ولا الأحرف الكبيرة.
- `corehub.desktop` (`desktopName`): Electron يأخذ منه صنف النافذة؛ قستُه تحت Xvfb: `WM_CLASS = "corehub",
  "corehub"` ويطابق `StartupWMClass=corehub`، فيجمع الـ dock النوافذ تحت المدخل المسمى «Core Hub». تغييره يكسر
  تثبيتات الـ dock الحالية وربط `corehub://` في `mimeapps.list`، ومعرّف سطح المكتب/‏app_id في Wayland لا يصلح بمسافة.

مقترح — للمالك أن يؤكد: اسم الأمر `core-hub` في لينكس، وإبقاء `corehub.desktop` وصنف النافذة `corehub`، ونقل الترقية من
مجلد `corehub` إلى `Core Hub`، وإعادة توجيه اختصارات الشخص إلى `Core Hub.exe` تلقائيًا.

**لم يتغيّر:** أسماء ملفات الإصدار (`Core-Hub-Setup-X-x64.exe`، `Core-Hub-X-arm64.dmg`، `corehub_X_amd64.deb`…)،
appId، بروتوكول `corehub://`، هوية MSIX، مجلد البيانات `<appData>/Core Hub`.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `apps/desktop/electron-builder.config.cjs`: `win.executableName` محذوف، `linux.executableName: 'core-hub'`،
  `nsis.include`.
- `apps/desktop/scripts/installer.nsh` (جديد): مجلد الترقية و`corehub://`.
- `apps/desktop/src/shared/legacy-shortcuts.ts`، `apps/desktop/src/main/legacy-shortcuts.ts` (جديدان)،
  `apps/desktop/src/main/index.ts`: إعادة توجيه الاختصارات.
- `apps/desktop/scripts/check-windows-package.mjs`، `apps/desktop/scripts/msix-smoke.ps1`: `Core Hub.exe`.
- `apps/desktop/scripts/nsis-upgrade-smoke.ps1` (جديد) و`.github/workflows/desktop.yml`: فحوص ويندوز ولينكس
  والترقية من إصدار v1.1.1 المنشور (أسماء الوظائف كما هي؛ مشروطة بوجود `installer.nsh` لبناء وسم قديم).
- `apps/desktop/tests/unit/app-name.test.ts`، `apps/desktop/tests/unit/legacy-shortcuts.test.ts`،
  `apps/desktop/tests/smoke/desktop.spec.ts` (تعليق المسار)، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
اختبارا الأسماء الجديدان يفشلان على إعداد #163:
```
$ git stash push electron-builder.config.cjs && npx vitest run tests/unit/app-name.test.ts
     × installs Core Hub.exe in a Core Hub folder on Windows 3ms
     × gives Linux a Core Hub menu entry, /opt/Core Hub and a core-hub command 2ms
      Tests  2 failed | 6 passed (8)
```
بعد التغيير (apps/desktop):
```
$ npx vitest run tests/unit
      Tests  128 passed (128)
$ pnpm --filter @corehub/desktop typecheck
tc=0
$ pnpm lint
All matched files use Prettier code style!
$ pnpm change-record:check
change-record  OK — 3 record(s) valid
```
صنف النافذة في Electron 44.4.5 (Xvfb، `desktopName: corehub.desktop`):
```
WM_CLASS(STRING) = "corehub", "corehub"
WM_NAME(UTF8_STRING) = "Core Hub"
```
CI: `desktop.yml` بـ workflow_dispatch على الفرع (run 36204985382، بعد دمج `night/2026-09-27`): الوظائف الثلاث
Installers (macos / ubuntu / windows) نجحت. ترقية ويندوز من مثبّت v1.1.1 المنشور (`nsis-upgrade-smoke.ps1`، من run
36204663876؛ الملف نفسه لم يتغيّر بعده):
```
ok: 1.1.1 installed C:\Users\runneradmin\AppData\Local\Programs\corehub\corehub.exe
ok: the app is C:\Users\runneradmin\AppData\Local\Programs\Core Hub\Core Hub.exe
ok: the old folder C:\Users\runneradmin\AppData\Local\Programs\corehub is gone
ok: no corehub.exe is left under C:\Users\runneradmin\AppData\Local\Programs
ok: the Start menu shortcut opens C:\Users\runneradmin\AppData\Local\Programs\Core Hub\Core Hub.exe
ok: the desktop shortcut opens C:\Users\runneradmin\AppData\Local\Programs\Core Hub\Core Hub.exe
ok: one uninstall entry (found 1)
ok: the uninstall entry is 'Core Hub 1.1.1' (Core Hub 1.1.1)
ok: the uninstall entry runs the new uninstaller ("C:\Users\runneradmin\AppData\Local\Programs\Core Hub\Uninstall Core Hub.exe" /currentuser)
ok: the next upgrade finds C:\Users\runneradmin\AppData\Local\Programs\Core Hub (…)
ok: corehub:// opens the new .exe before its first start ("C:\Users\runneradmin\AppData\Local\Programs\Core Hub\Core Hub.exe" "%1")
ok: the Startup shortcut still names corehub.exe before the app starts
ok: the Startup shortcut now opens C:\Users\runneradmin\AppData\Local\Programs\Core Hub\Core Hub.exe
ok: its Start in folder is C:\Users\runneradmin\AppData\Local\Programs\Core Hub
ok: the uninstall entry is gone
ok: C:\Users\runneradmin\AppData\Local\Programs\Core Hub\Core Hub.exe is gone
ok: corehub:// is unregistered
```
MSIX (`Executable="app\Core Hub.exe"`؛ الحزمة تخزّن الاسم `Core%20Hub.exe` كاسم جزء OPC، فقبله الفحص) ثبت وعمل في الوضع
المحلي: `Core Hub processes: 5`، `health: {"ok":true,"server_version":"1.1.1",…}`. ترقية لينكس من `.deb` 1.1.1 المنشور:
```
update-alternatives: using /opt/Core Hub/corehub to provide /usr/bin/corehub (corehub) in auto mode
Unpacking corehub (1.1.1) over (1.1.1) ...
update-alternatives: using /opt/Core Hub/core-hub to provide /usr/bin/core-hub (core-hub) in auto mode
ls: cannot access '/usr/bin/corehub': No such file or directory
lrwxrwxrwx  1 root root   26 … /usr/bin/core-hub -> /etc/alternatives/core-hub
Name=Core Hub
Exec="/opt/Core Hub/core-hub" %U
StartupWMClass=corehub
```
والماك كما في #163 (`Core Hub.app`، نافذة «Core Hub 1.1.1»).

## المخاطر والرجوع
- كود NSIS لا يُبنى إلا على ويندوز؛ مساره الصامت (`/S`) مختبر في CI من مثبّت 1.1.1 المنشور. المسار التفاعلي
  (`corehub\Core Hub`) مغطّى بنفس القاعدة لكنه غير مختبر آليًا.
- تثبيت شريط المهام: الـ `.lnk` يُحدَّث عند أول تشغيل، وقد يحتفظ Explorer بأيقونة قديمة حتى يُعاد تشغيله.
- لينكس: `/usr/bin/corehub` يختفي؛ من كتب الأمر في سكربت يستخدم `core-hub`.
- الرجوع: إعادة `win.executableName`/`linux.executableName` إلى `corehub` وحذف `nsis.include`.

## التسليم والخطوة التالية
يُدمج في `night/2026-09-27` (طلب الليلة #165)، بلا طلب دمج خاص ولا وسم.
