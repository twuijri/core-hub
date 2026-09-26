# تطبيقات سطح المكتب تكتشف التحديث وتنزّله وتسأل قبل إعادة التشغيل
المسؤول: twuijri · الفرع: feat/desktop-updates · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٦): «خل الاندرويد والماك والويندوز واللينكس يكتشفون التحديث اذا نزل تحديث». هذا السجل
لنصف سطح المكتب (ويندوز وماك ولينكس)؛ أندرويد في فرع آخر (`feat/android-updates`، DECISIONS §108).

قبل هذا التغيير كان تطبيق سطح المكتب يسأل واجهة إصدارات GitHub مرة في اليوم ويعرض رابط المثبّت فقط (ADR 0023
§6)، ولا يُنزّل شيئًا. والإصدار لم يكن يحمل ملفات `latest*.yml` التي يقرؤها electron-updater، ولا ملف zip للماك.

الهدف: من الإصدار 1.1.3 يكتشف التطبيق الإصدار الجديد بنفسه — قرابة عشر ثوانٍ بعد التشغيل ثم كل ست ساعات — ثم:
- ويندوز `.exe` (NSIS) والماك وAppImage لينكس: ينزّله في الخلفية ويعرض «أعد التشغيل للتحديث / لاحقًا»، ولا يعيد
  التشغيل من تلقاء نفسه أبدًا؛ وإن لم يُعِد الشخص التشغيل يُثبَّت عند الإغلاق.
- `.deb` لينكس: يقول «كور هب X متاح» مع زر يفتح صفحة التنزيل https://twuijri.github.io/core-hub/ ولا يُنزّل شيئًا.
- نسخة متجر مايكروسوفت (MSIX): لا تبحث إطلاقًا؛ المتجر يحدّثها.

## القرار والموافقات
مقترح — للمالك أن يؤكد (DECISIONS §109، ويحلّ محل ADR 0023 §6 لهذه النسخ؛ أُضيفت ملاحظة في ADR 0023):
- **طريقة كل نسخة** (`updateMode` في `apps/desktop/src/shared/updates.ts`): `install` للـ`.exe` والماك وAppImage،
  `notify` للـ`.deb` وتشغيل التطوير وتطبيق مُغلَّف يُشغَّل من مجلده، `off` لنسخة المتجر. تُعرف AppImage بمتغير
  `APPIMAGE` الذي يضعه تشغيل AppImage، والـ`.deb` بملف `resources/package-type` الذي يكتبه electron-builder.
- **التثبيت** بمكتبة electron-updater (رخصة MIT، الإصدار 6.8.9 المقترن بـelectron-builder 26.15.x؛ 6.8.10 صدر اليوم
  نفسه فرفضه حدّ عمر الإصدار في pnpm ولم أتجاوزه)، بمزوّد GitHub على `twuijri/core-hub`، إصدارات مستقرة فقط، بلا
  رجوع لإصدار أقدم. يقرأ `latest*.yml` من github.com بلا رمز دخول، ويتحقق من SHA-512. الماك يتحدّث من zip للتطبيق
  نفسه الموقّع والموثَّق (Squirrel.Mac لا يقبل إلا zip ويتحقق من التوقيع)، والـdmg يبقى للتنزيل. `.exe` ويندوز غير
  موقّع فيُتحقق منه بـSHA-512 فقط.
- إن تعذّرت قراءة ملف التحديث (مثل إصدار 1.1.2 الذي لا يحمله) يسأل التطبيق واجهة الإصدارات، فإن وجد أحدث عرض
  «متاح» مع صفحة التنزيل.
- **الواجهة**: بطاقة عائمة في زاوية الصفحة بشكل الـtoast (السطح والحد والظل نفسها من ui-tokens) تبقى حتى يجيب
  الشخص — لا نافذة نظام خام. «لاحقًا» يخفيها لذلك الإصدار حتى يُشغَّل التطبيق من جديد. قسم «التحديثات» في
  الإعدادات ← هذا الجهاز يعرض التقدّم وزر إعادة التشغيل. إشعار النظام مرة لكل إصدار وفقط حين لا تكون نافذة التطبيق
  في الأمام. «البحث عن تحديثات…» في قائمة التطبيق (ماك) وقائمة المساعدة (ويندوز ولينكس) والأيقونة في شريط النظام؛
  ومع نافذة التطبيق يفتح «هذا الجهاز» ويعرض الجواب هناك، وعلى شاشة البداية (لا صفحة) يجيب بنافذة النظام.
- **المفتاح**: «البحث عن الإصدارات الجديدة تلقائيًا» في هذا الجهاز، محفوظ في `desktop.json` (`updates.auto`، مفعّل
  افتراضيًا).
- **الإصدار يحمل الآن** `latest.yml` و`latest-mac.yml` و`latest-linux.yml` وملفات blockmap إن وُجدت و
  `Core-Hub-X.Y.Z-arm64-mac.zip`. أسماء الملفات التي تذكرها ملفات التحديث هي أسماء ملفات الإصدار نفسها بالضبط؛
  `release-assets.mjs` يرفض النشر إن اختلفت، وخطوة بعد التغليف في `desktop.yml` و`desktop-signed.yml` تفحص ذلك فورًا.
  وسم أقدم من هذا التغيير يُنشر بلا ملفات تحديث (`--without=updates`).
- قرارات منتج جديدة (مقترحة): الفاصل ست ساعات بدل يوم؛ «لاحقًا» يخفي الإشعار حتى إعادة تشغيل التطبيق فقط؛ إشعار
  النظام حين لا تكون النافذة في الأمام؛ مكان «البحث عن تحديثات…» في القوائم.
- ترخيص: electron-updater وما يحزمه esbuild معه مسجّلة في `THIRD-PARTY-NOTICES.md` (مثل مكتبتي الطرفية)، لأن
  الحزمة تُدمج في `main.cjs` بلا ملفات الترخيص. بينها `sax` برخصة Blue Oak 1.0.0 (متساهلة).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. الجسر بين التطبيق والصفحة (`packages/web/src/desktop/bridge-types.ts`) زاد حقولًا اختيارية
(`mode`، `pending`، `downloadPage`، `dismissed`، `checking`) ودوال اختيارية (`restart`، `dismiss`، `onChange`).

## الملفات والتأثير
- `apps/desktop/src/shared/updates.ts`: `packagingOf` و`updateMode` والجدولة `scheduleUpdateChecks` (١٠ ثوانٍ ثم كل
  ٦ ساعات) و`DOWNLOAD_PAGE`؛ حُذف `checkIsDue` (فحص مرة في اليوم).
- `apps/desktop/src/main/auto-update.ts` (جديد): غلاف electron-updater (`AutoInstaller`).
- `apps/desktop/src/main/updates.ts`: `appPackaging` (يقرأ `package-type`).
- `apps/desktop/src/main/controller.ts`: الوضع والجدولة والإشعار وإعادة التشغيل والحوار من القائمة وقنوات IPC.
- `apps/desktop/src/main/menu.ts`، `src/shared/ipc.ts`، `src/preload/index.ts`، `src/i18n/{ar,en}.json`.
- `apps/desktop/electron-builder.config.cjs`: `publish` لمزوّد GitHub (مع `--publish never` كما كان)، وهدف zip للماك.
- `apps/desktop/scripts/release-assets.mjs` (+`.d.mts`): `updateAssets` و`readFeed` و`feedProblems` و`checkFeedsIn`
  وأمر `check-feeds`، و`collect` يجمع ملفات التحديث ويفحصها، وملاحظات الإصدار فيها فقرة «Updating».
- `.github/workflows/desktop.yml`، `desktop-signed.yml`، `publish-release.yml`: رفع ملفات التحديث وفحصها، وفحص توقيع
  zip الماك وختم التوثيق فيه.
- الويب: `packages/web/src/desktop/{updates.ts,UpdateNotice.tsx,UpdatesSection.tsx,bridge-types.ts}`،
  `src/shell/AppShell.tsx`، `src/styles/kit.css`، `src/i18n/{ar,en}.json`.
- الاختبارات: `apps/desktop/tests/unit/{updates,release-assets,menu}.test.ts`، `packages/web/tests/desktop-updates.test.tsx`.
- الوثائق: `docs/RELEASING.md`، `apps/desktop/README.md`، `docs/STATUS.md`، `docs/contracts/DECISIONS.md` §109،
  `docs/adr/0023-…`، `THIRD-PARTY-NOTICES.md`.
- `apps/android` لم يُلمس.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run`، لما لمسه التغيير فقط:

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm --filter @corehub/desktop typecheck
$ pnpm generate:ts && tsc -p tsconfig.json
contracts:generate:ts  wrote generated/ts/schema.ts
exit=0

$ (packages/web) pnpm typecheck
ui-tokens  wrote dist/tokens.css, dist/tokens.js, dist/tokens.d.ts
(exit 0, no errors)

$ pnpm i18n:check
i18n:check  server: 198 keys, ar/en in parity
i18n:check  cli: 252 keys, ar/en in parity
i18n:check  web: 3183 keys, ar/en in parity
i18n:check  desktop: 103 keys, ar/en in parity
i18n:check  ios: 681 keys, ar/en in parity
i18n:check  OK

$ (apps/desktop) vitest run tests/unit/updates.test.ts tests/unit/release-assets.test.ts tests/unit/menu.test.ts
 Test Files  3 passed (3)
      Tests  61 passed (61)

$ (packages/web) vitest run tests/desktop-updates.test.tsx tests/desktop-surface.test.tsx tests/i18n.test.ts tests/logical-css.test.ts tests/ui-layer.test.ts
 Test Files  5 passed (5)
      Tests  352 passed (352)

$ (site) vitest run tests/releases.test.ts
 Test Files  1 passed (1)
      Tests  31 passed (31)
```

تغليف لينكس الفعلي (AppImage و.deb) بالنسخة 1.1.3 على هذا الجهاز، ثم فحص ملف التحديث الناتج:

```
$ COREHUB_VERSION=1.1.3 pnpm --filter @corehub/desktop package --linux
  • building        target=AppImage arch=x64 file=release/Core-Hub-1.1.3-x86_64.AppImage
  • building embedded block map  file=release/Core-Hub-1.1.3-x86_64.AppImage
  • building        target=deb arch=x64 file=release/corehub_1.1.3_amd64.deb
  • adding autoupdate files for: deb  resourceDir=release/linux-unpacked/resources
| Core-Hub-1.1.3-x86_64.AppImage | 126.9 MB |
| corehub_1.1.3_amd64.deb | 100.6 MB |

$ cat release/latest-linux.yml
version: 1.1.3
files:
  - url: Core-Hub-1.1.3-x86_64.AppImage
    sha512: fdhhwnO+…
    size: 126917160
    blockMapSize: 133692
  - url: corehub_1.1.3_amd64.deb
    sha512: YM3HV0oT…
    size: 100556696
path: Core-Hub-1.1.3-x86_64.AppImage

$ cat release/linux-unpacked/resources/app-update.yml   (and the same inside the AppImage)
owner: twuijri
repo: core-hub
provider: github
releaseType: release
updaterCacheDirName: '@corehubdesktop-updater'

$ node scripts/release-assets.mjs check-feeds 1.1.3 release linux
update feed (linux): names only files the release carries
```

تشغيل التطبيق المُغلَّف تحت xvfb كما تعمل AppImage (`APPIMAGE` مضبوط، مجلد بيانات مؤقت) ٣٠ ثانية: بعد نحو ١٠ ثوانٍ
سأل GitHub، ووجد أحدث إصدار منشور (v1.1.2) بلا `latest-linux.yml` كما هو متوقع، فرجع إلى واجهة الإصدارات، وحُفظ
وقت الفحص:

```
Checking for update
Error: Error: Cannot find latest-linux.yml in the latest release artifacts (https://github.com/twuijri/core-hub/releases/download/v1.1.2/latest-linux.yml): HttpError: 404
    at async AutoInstaller.check (…/app.asar/dist/main.cjs:35397:22)
    at async DesktopController.installerCheck (…)
    at async DesktopController.autoCheckUpdates (…)
{'auto': True, 'lastCheckedAt': '2026-09-26T13:28:05.452Z', 'notified': None}
```
(ملاحظة صادقة: أول محاولة تشغيل التقطت جلسة Wayland لسطح المكتب فظهرت شاشة البداية نحو ٣٠ ثانية قبل أن تُغلق؛
أُعيد التشغيل على X11 داخل xvfb فقط.)

**لم يُجرَّب تحديث حقيقي**: لا يمكن محليًا، لأنه يحتاج إصدارين منشورين يحملان ملفات التحديث (1.1.3 ثم ما بعده)،
وتوقيع الماك. لم يُشغَّل تغليف الماك ولا ويندوز محليًا — يُبنيان في CI (`desktop.yml` على هذا الطلب).

CI على طلب الدمج #173 (الرأس `2f14624e`): كل الفحوص ناجحة — الخادم (٣ أجزاء)، الويب واختبارات Playwright، دخان
سطح المكتب تحت Xvfb، صورة Docker، الترحيلات، والمثبّتات على الأنظمة الثلاثة. وخطوة «Check the update feed» الجديدة
عملت فعلًا على كل نظام بملفات حقيقية بنت electron-builder:

```
Installers (macos-latest)   - url: Core-Hub-1.1.2-arm64-mac.zip / - url: Core-Hub-1.1.2-arm64.dmg
                            update feed (macos): names only files the release carries
Installers (ubuntu-latest)  - url: Core-Hub-1.1.2-x86_64.AppImage / - url: corehub_1.1.2_amd64.deb
                            update feed (linux): names only files the release carries
Installers (windows-latest) - url: Core-Hub-Setup-1.1.2-x64.exe
                            update feed (windows): names only files the release carries
```
(خطوة zip الماك الموقّع في `desktop-signed.yml` لا تعمل على طلب دمج؛ أول تشغيل لها مع وسم 1.1.3.)

## المخاطر والرجوع
- **نسخ 1.1.2 وما قبلها لا تملك المحدِّث**: يثبّت أصحابها 1.1.3 يدويًا مرة واحدة، ثم يتحدّث التطبيق بنفسه.
- أول تحديث حقيقي سيكون من 1.1.3 إلى الإصدار التالي؛ إن فشل ملف التحديث لسبب ما يرجع التطبيق إلى واجهة الإصدارات
  ويعرض رابط صفحة التنزيل، فلا يبقى الشخص بلا خبر.
- ويندوز غير موقّع: التحديث يُتحقق منه بـSHA-512 من ملف `latest.yml` المنشور على الإصدار نفسه؛ من يملك الكتابة على
  الإصدارات يملك التحديث (كما يملك المثبّت اليوم).
- ينشئ electron-updater ملف `.updaterId` (معرّف عشوائي) في مجلد بيانات التطبيق لتوزيع مرحلي لا نستخدمه.
- الرجوع: إرجاع هذا الدمج يعيد الفحص اليومي بالرابط؛ النسخ المثبّتة من 1.1.3 تبقى تتحدث من الإصدارات التي تحمل ملفات
  التحديث، ويُوقف ذلك نشرُ إصدار بلا ملفات تحديث (`--without=updates`) أو إطفاء المفتاح في هذا الجهاز.

## التسليم والخطوة التالية
- طلب الدمج إلى `main` (بالإنجليزية) — ينتظر مراجعة المالك ودمجه؛ لم يُدمج شيء ولم يُنشر إصدار.
- المطلوب من المالك: لا أسرار ولا إعدادات جديدة (الأسرار الحالية لتوقيع الماك كافية). بعد الدمج: وسم 1.1.3 عادي
  ينتج الإصدار بملفات التحديث؛ وتأكيد القرارات المقترحة في §109.
- بعد نشر الإصدار التالي لـ1.1.3: تجربة تحديث حقيقية على ويندوز وماك وAppImage، وتسجيل نتيجتها.
