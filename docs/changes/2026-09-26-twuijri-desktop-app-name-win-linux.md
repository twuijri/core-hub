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
```
صنف النافذة في Electron 44.4.5 (Xvfb، `desktopName: corehub.desktop`):
```
WM_CLASS(STRING) = "corehub", "corehub"
WM_NAME(UTF8_STRING) = "Core Hub"
```
CI: يُكمل بعد الدفع.

## المخاطر والرجوع
- كود NSIS لا يُبنى إلا على ويندوز؛ مساره الصامت (`/S`) مختبر في CI من مثبّت 1.1.1 المنشور. المسار التفاعلي
  (`corehub\Core Hub`) مغطّى بنفس القاعدة لكنه غير مختبر آليًا.
- تثبيت شريط المهام: الـ `.lnk` يُحدَّث عند أول تشغيل، وقد يحتفظ Explorer بأيقونة قديمة حتى يُعاد تشغيله.
- لينكس: `/usr/bin/corehub` يختفي؛ من كتب الأمر في سكربت يستخدم `core-hub`.
- الرجوع: إعادة `win.executableName`/`linux.executableName` إلى `corehub` وحذف `nsis.include`.

## التسليم والخطوة التالية
PR جديد إلى `main` بالإنجليزية، بلا دمج ولا وسم.
