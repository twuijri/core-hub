# أيقونات التطبيقات من شعار كور هب (iOS وأندرويد وسطح المكتب والويب)
المسؤول: twuijri · الفرع: feat/app-icons · الحالة: review

## المشكلة والهدف
تطبيق iOS بلا أيقونة، وApp Store Connect يرفض أي بناء بلا أيقونة. أيقونة أندرويد وأيقونة
الإشعار كانتا شكل «محور» (حلقة وأربعة أذرع) لا علاقة له بشعار كور هب، وسطح المكتب يعطي
electron-builder صورة PNG واحدة ليحوّلها بنفسه، بلا `.icns` ولا `.ico`. الهدف: أيقونة حقيقية لكل
منصة من العلامة الموجودة (`CoreHubMark.tsx`، سجل `2026-09-24-twuijri-brand-mark.md`) وبألوان
`packages/ui-tokens`، بسكربت يُعاد تشغيله، بلا شعار جديد.

## القرار والموافقات
طلب المالك ضمن مهام الليلة. القرارات:
- **شكل الأيقونة هو شكل أيقونة المتصفح** الذي اعتمده المالك في سجل الشعار: العلامة بيضاء على
  لون `accent` الفاتح (`#0b6b5d`)، وعرض العلامة ٦٢٫٥٪ من المربّع (٢٠ من ٣٢ في أيقونة المتصفح).
- **مصدر واحد**: `scripts/icons/build-icons.mjs` يقرأ المسار من `CoreHubMark.tsx` والألوان من
  `tokens.json`، ويرسم بـresvg (`@resvg/resvg-js`، اعتماد تطوير في الجذر)، ويكتب PNG وICO وICNS
  بمرمّزات صغيرة داخله، فالمدخلات نفسها تعطي البايتات نفسها. `pnpm icons:build` يكتب، و
  `pnpm icons:build --check` يفشل إن اختلف ملف مُلتزَم عمّا يصنعه السكربت.
- **iOS**: `CoreHub/Resources/Assets.xcassets/AppIcon` بصورة واحدة ١٠٢٤ (RGB بلا قناة شفافية كما
  يطلب App Store)، ومعها مظهرا iOS 18: الداكن (العلامة بلون `accent` الداكن `#3fc2a1` على خلفية
  شفافة يملؤها النظام) والملوّن (أبيض على أسود، رمادي يلوّنه النظام). `project.yml` يضبط
  `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon` للتطبيق فقط؛ امتداد المشاركة بلا أيقونة.
- **أندرويد**: الحد الأدنى ٢٦، فالأيقونة التكيفية (`mipmap-anydpi-v26`) تكفي كل الأجهزة ولا حاجة إلى
  mipmaps نقطية قديمة. الواجهة الأمامية رسم متجه للعلامة (٤٥ من ٧٢ dp الظاهرة، داخل دائرة الأمان
  ٦٦ dp)، والخلفية `@color/icon_bg` (= `accent`)، والطبقة الأحادية هي الواجهة نفسها فتعمل الأيقونات
  المصبوغة. أيقونة الإشعار الصغيرة `ic_notice` هي العلامة بيضاء على شفاف (٢٠ من ٢٤ dp)، وهي التي
  تستعملها قناة `notices` أصلًا (`Notices.kt` بـ`setSmallIcon(R.drawable.ic_notice)`، ودفع FCM عبر
  `default_notification_icon` في المانيفست) فلم يتغير الربط. وصورة ٥١٢ لقائمة Play في
  `apps/android/store/icon-512.png`.
- **سطح المكتب**: `icon.icns` (شبكة آبل: مربّع مستدير ٨٢٤ من ١٠٢٤)، و`icon.ico` (١٦–٢٥٦؛ BMP حتى
  ١٢٨ وPNG لـ٢٥٦)، و`icons/NxN.png` للينكس، و`icon.png` ٥١٢ لنافذة التطبيق. تحت ٣٣ بكسل تُرسم
  العلامة وحدها بلون `accent` بلا مربّع، لأن المربّع يصغّرها حتى يختفي ثقبها. أيقونات الصينية
  (`tray-16/32` بالأخضر، و`trayTemplate` بالأسود لشريط ماك) أُعيد توليدها بالسكربت نفسه بالشكل
  نفسه الذي كانت عليه. `scripts/build.mjs` لا ينسخ `.icns` و`.ico` و`icons/` داخل التطبيق.
- **الويب**: أيقونة المتصفح المضمَّنة كما هي؛ أُضيف `apple-touch-icon.png` (١٨٠، معتم) ورابطه في
  `index.html` لشاشة iPhone الرئيسية. لا manifest ولا PWA (خارج النطاق).
- اقتراح — للمالك أن يؤكد: الأيقونة الملوّنة (tinted) أبيض على أسود معتم، والصغيرة على سطح المكتب
  علامة بلا مربّع.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `scripts/icons/build-icons.mjs` (جديد)، `package.json` (`icons:build` و`@resvg/resvg-js`)،
  `pnpm-lock.yaml`.
- iOS: `apps/ios/CoreHub/Resources/Assets.xcassets/**` (جديد)، `apps/ios/project.yml`،
  `apps/ios/CoreHubTests/AppIconTests.swift` (جديد: `CFBundleIcons` في Info.plist المبني يسمّي
  `AppIcon`، ولا يكتبه actool إلا إذا جمّع المجموعة)، `apps/ios/README.md`.
- أندرويد: `res/drawable/ic_launcher_foreground.xml` و`ic_notice.xml` (مولَّدان)،
  `apps/android/store/icon-512.png` (جديد).
- سطح المكتب: `apps/desktop/assets/**`، `electron-builder.config.cjs` (ماك `.icns`، ويندوز `.ico`،
  لينكس مجلد `icons`)، `scripts/build.mjs`، `README.md`.
- الويب: `packages/web/public/apple-touch-icon.png`، `index.html`،
  `tests/brand-mark.test.tsx` (رابط الأيقونة، وأيقونتا أندرويد ترسمان مسار العلامة نفسه).
- `docs/STATUS.md`، `docs/RELEASING.md`، وفهرس الليلة.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (كل أمر ثقيل عبر `mj-run`؛ أندرويد بـJDK 17 وSDK 35):

```
$ pnpm icons:build
icons: 23 files written
$ pnpm icons:build --check
icons: 23 files up to date
$ pnpm exec vitest run tests/brand-mark.test.tsx      # packages/web
      Tests  3 passed (3)
# على index.html وأيقونتي أندرويد القديمة:
 FAIL  … > is the favicon too, in white on the accent tile
AssertionError: expected '<!doctype html>…' to contain '<link rel="apple-touch-icon" href="/a…'
 FAIL  … > is the Android launcher and notification icon too
AssertionError: expected '<?xml version="1.0" encoding="utf-8"?…' to contain 'android:pathData="M230 0H665A230 230 …'
      Tests  2 failed | 1 passed (3)
$ ./gradlew --no-daemon --max-workers=2 assembleDebug lint
BUILD SUCCESSFUL in 37s
0 errors, 19 warnings        # لا تحذير عن الأيقونات
$ aapt2 dump badging app-debug.apk | grep icon
application: label='Core Hub' icon='res/mipmap-anydpi-v26/ic_launcher.xml'
$ aapt2 dump resources app-debug.apk | grep -E "ic_launcher|ic_notice|icon_bg"
    resource 0x7f03000f color/icon_bg
    resource 0x7f05001b drawable/ic_launcher_foreground
    resource 0x7f05001c drawable/ic_notice
    resource 0x7f090000 mipmap/ic_launcher
$ file apps/desktop/assets/icon.ico apps/desktop/assets/icon.icns
icon.ico:  MS Windows icon resource - 7 icons, 16x16, 32 bits/pixel, 24x24, 32 bits/pixel
icon.icns: Mac OS X icon, 38700 bytes, "icp4" type
# Pillow يقرأ الملفين: ico {16,24,32,48,64,128,256}، icns 16…512 بالحجمين 1x و2x
$ pnpm lint        # exit 0
All matched files use Prettier code style!
$ pnpm typecheck   # exit 0
```

**ما رأيته في الصور** (فتحتها بعارض الصور): `AppIcon.png` مربّع أخضر `#0b6b5d` ممتلئ حتى الحواف،
وفي وسطه حرف «C» أبيض مستدير الزوايا يفتح يمينًا، وفي داخله حلقة خضراء ومربّع أبيض صغير؛ العلامة
نحو ثلثي العرض. `AppIcon-dark.png` العلامة نفسها بالأخضر الفاتح `#3fc2a1` على شفاف. `icon.png`
لسطح المكتب مربّع أخضر مستدير الزوايا بهامش رفيع وفيه العلامة البيضاء. الأحجام الصغيرة (مكبّرة
للنظر): `tray-16` حرف C أخضر يُقرأ ثقبه وإن كان ناعم الحواف، `trayTemplate@2x` نفسه بالأسود، و٤٨
و٦٤ مربّع أخضر فيه C أبيض واضح. ورسمتُ ملفَّي أندرويد المتجهين من جديد (المسار والتحويل كما
في XML): العلامة البيضاء داخل دائرة الأمان ٦٦ dp على خلفية الأيقونة، وأيقونة الإشعار تملأ ٢٠ من
٢٤ dp.

CI على #144: يُضاف بعد الدمج في فرع الليلة.

## المخاطر والرجوع
- مظهرا iOS 18 الداكن والملوّن يحتاجان Xcode 16؛ على Xcode أقدم يتجاهلهما actool أو يحذّر.
- ملفات الأيقونات مولَّدة ومُلتزَمة؛ من يغيّر العلامة أو `accent` يشغّل `pnpm icons:build` ويلتزم
  الناتج (`--check` يكشف النسيان، ولم يُربط بـCI لأن هذه المهمة لا تلمس `.github/workflows`).
- الرجوع: استرجاع هذا الـcommit يعيد شكل «المحور» في أندرويد وتطبيق iOS بلا أيقونة.

## التسليم والخطوة التالية
يُدمج في `night/2026-09-26` (#144). بعده: تشغيل `ios-signed.yml` يدويًا على فرع الليلة (بلا رفع
وبلا حفظ ملفات) للتأكد من أن التصدير يمر بالأيقونة، ثم رفع TestFlight حين يقرر المالك.
