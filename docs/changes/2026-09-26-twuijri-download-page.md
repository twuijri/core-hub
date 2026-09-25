# صفحة التحميل على GitHub Pages
المسؤول: twuijri · الفرع: feat/download-page · الحالة: review

## المشكلة والهدف
طلب المالك (2026-09-26): «سو صفحة تحميل تصميمها حلو وحطها داخل القيت هب ويكون فيه كل شي».
لا توجد اليوم صفحة واحدة يُرسَل رابطها لمن يريد التطبيق؛ الملفات في صفحة إصدار GitHub بأسماء
فيها رقم النسخة، ولا شيء يشرح أي ملف لأي جهاز ولا كيف يُثبَّت. الهدف صفحة ثابتة جميلة على
https://twuijri.github.io/core-hub/ تعطي كل منصة ملفها من آخر إصدار دائمًا، وتعرض المتاجر
«قريبًا» خلف مفاتيح، وفيها قسم «شغّل مركزك الخاص».

## القرار والموافقات
- **صفحة ثابتة بلا أداة بناء** في `site/` (HTML وCSS ووحدات ES)، وحزمة مساحة عمل `@corehub/site`
  حتى يشغّل CI اختبارها وبناءها مع الباقي (`pnpm -r test` و`pnpm -r build`). `build.mjs` يكتب
  النص العربي في `dist/index.html` (فتُقرأ الصفحة صحيحة قبل أي سكربت)، ويضع أيقونات Lucide
  (`lucide-static` 1.48.0، مجموعة أيقونات التطبيقات نفسها) مضمّنة، وينسخ `tokens.css` من
  `packages/ui-tokens` وعلامة كور هب من `docs/assets` وأيقونة اللمس من `packages/web/public`.
- **روابط حديثة دائمًا بلا إعادة نشر لكل إصدار**: المتصفح يسأل
  `GET /repos/twuijri/core-hub/releases/latest` ويختار كل ملف بنمط اسمه (`site/src/releases.js`).
  المصدر الواحد للأسماء هو `apps/desktop/scripts/release-assets.mjs`؛ لا يمكن استيراده في المتصفح
  (يستورد `node:fs`)، فاختبار `site/tests/releases.test.ts` يطابق كل نمط مع أسمائه لثلاث نسخ
  ومع إصدار v1.1.1 الحقيقي (مثبّت في `tests/fixtures/release-v1.1.1.json` من الـAPI). ملف MSIX
  مستبعد عمدًا: Windows لا يثبّته قبل توقيع المتجر.
- **لا روابط مكسورة**: رابط التحميل يُقبل فقط إن بدأ بـ
  `https://github.com/twuijri/core-hub/releases/download/`. إن تعذّر الـAPI (بلا اتصال، أو تجاوز
  حد ٦٠ طلبًا في الساعة) تشير كل الأزرار إلى صفحة الإصدارات وتظهر ملاحظة، وإن غاب ملف من الإصدار
  يشير زره إلى صفحة ذلك الإصدار. الجواب الناجح يُحفظ عشر دقائق في `sessionStorage`.
- **مفاتيح المتاجر** في `site/src/config.js`: الزر رابط فقط إذا `enabled: true` و`url` يبدأ بـ
  `https://`، وإلا «قريبًا» بلا رابط. Microsoft Store رابطه جاهز
  (`https://apps.microsoft.com/detail/9MT62R5V3P5N`)، وGoogle Play رابطه من `applicationId`
  (`com.twuijri.corehub`)، وApp Store رابطه فارغ حتى يعطيه App Store Connect. الثلاثة مطفأة.
- **اكتشاف النظام** (`detectPlatform`): Android قبل Linux، وiPad الذي يطلب نسخة سطح المكتب
  (Macintosh مع لمس) يُعدّ iPhone/iPad، وChromeOS بلا تمييز. بطاقة جهاز الزائر تتقدّم وتتّسع،
  والزر الكبير يعطي ملفها مباشرة مع الاسم والحجم.
- **العربية أولًا** مع زر English (يُحفظ الاختيار في `localStorage`، و`?lang=en` يفرضه)، واتجاه
  RTL بخصائص منطقية فقط، والأسماء اللاتينية داخل الجمل العربية معزولة بـ`<bdi>`، والأوامر
  والشيفرة `dir="ltr"`. الفاتح والداكن من النظام عبر `tokens.css` نفسه.
- **بلا متتبّعات ولا سكربتات خارجية**: سياسة CSP في الصفحة (`default-src 'none'`،
  `script-src 'self'`، `connect-src https://api.github.com`)، ولا خطوط خارجية. `page.test.ts`
  يتحقق من ذلك ومن تطابق مفاتيح العربية والإنجليزية.
- **النشر**: `.github/workflows/pages.yml` عند دفع إلى `main` يمسّ `site/**` (أو الرموز أو العلامة
  أو الملف نفسه) أو يدويًا؛ مهمة بناء بصلاحية `contents: read` ومهمة نشر وحدها بـ`pages: write`
  و`id-token: write` عبر `actions/upload-pages-artifact@v4` و`actions/deploy-pages@v4`.
- مقترح — للمالك أن يؤكد: نص البطل «كل وكلائك في مركز واحد»، ومتطلبات الأنظمة المكتوبة
  (Windows 10/11 ‏64 بت، Mac بمعالج Apple، Linux x86_64، Android 8+ من `minSdk = 26`، iOS 17+ من
  `project.yml`).
- لم أغيّر إعدادات المستودع ولم أفعّل Pages؛ خطوة المالك مكتوبة في `docs/RELEASING.md`.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- جديد: `site/` (`package.json`، `build.mjs`، `serve.mjs` للمعاينة المحلية، `tsconfig.json`،
  `vitest.config.ts`، `src/{index.html,styles.css,app.js,config.js,i18n.js,releases.js}`،
  `tests/{releases,page}.test.ts`، `tests/fixtures/release-v1.1.1.json`).
- جديد: `.github/workflows/pages.yml`. لم يتغير اسم أي مهمة موجودة.
- `pnpm-workspace.yaml` (+`site`)، `pnpm-lock.yaml` (مدخل `site` فقط)، `eslint.config.js` (كتلة
  متغيرات المتصفح لـ`site/src`).
- `README.md` (رابط التحميل أعلى الصفحة)، `docs/RELEASING.md` (قسم «The download page»: كيف تعمل،
  المفاتيح، خطوة المالك، النطاق المخصّص الاختياري)، `docs/STATUS.md` (بند صفحة التحميل).
- CI: `pnpm -r build` صار يبني `site/dist` أيضًا (أقل من ثانية)، و`pnpm -r test` يشغّل ٤١ اختبارًا
  جديدًا.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (عبر `mj-run`):
```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ pnpm version:check
version: 1.1.1 everywhere (10 places)
$ pnpm --filter @corehub/site typecheck
$ tsc --noEmit -p tsconfig.json
$ pnpm --filter @corehub/site test
 Test Files  2 passed (2)
      Tests  41 passed (41)
$ pnpm --filter "@corehub/site..." build
site: built site/dist
$ pnpm i18n:check
i18n:check  OK
```
الاختبار يلتقط إعادة التسمية: غيّرت نمط `.deb` مؤقتًا إلى `^core-hub_` ففشل:
```
     × each download matches exactly its own file in 1.1.1 7ms
     × each download matches exactly its own file in 1.2.0 1ms
     × each download matches exactly its own file in 10.20.30 1ms
     × picks every download from the real v1.1.1 release (GET /releases/latest, 2026-09-26) 1ms
     × turns the API answer into the page’s downloads, sizes and links 1ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯
```
خطوات `pages.yml` نفسها في نسخة نظيفة من الفرع (تثبيت مُرشَّح ثم اختبار ثم بناء):
```
$ pnpm install --frozen-lockfile --filter "@corehub/site..."
Done in 982ms using pnpm v12.5.1
$ pnpm --filter @corehub/site test
      Tests  41 passed (41)
$ pnpm --filter "@corehub/site..." build
site: built site/dist
```
الصفحة في Chrome بلا واجهة على خادم محلي (`site/serve.mjs`) ومع الـAPI الحقيقي (إصدار v1.1.1):
```
download-ar-dark   (UA Windows) dir=rtl, cta=.../v1.1.1/Core-Hub-Setup-1.1.1-x64.exe "حمّل لـ Windows … 101 MB",
                   status "الإصدار 1.1.1 · 26 سبتمبر 2026", detected=[windows], stores كلها no-href, scrollW=1280/1280
download-en-light  (UA Mac) dir=ltr, cta=.../Core-Hub-1.1.1-arm64.dmg "Download for macOS … 112 MB", detected=[macos]
download-ar-mobile-light (Android 390px) cta=.../Core-Hub-1.1.1-android.apk · 3.1 MB, detected=[android], scrollW=390/390
errors: []
fallback (api.github.com → 403): الملاحظة ظاهرة، كل الأزرار → https://github.com/twuijri/core-hub/releases/latest؛
زر اللغة → lang=en dir=ltr، رابط الخصوصية → docs/privacy.md
```
أول لقطة للجوال كشفت تمريرًا أفقيًا (513 من 390) من كتلة الشيفرة داخل الشبكة؛ أصلحته بـ
`minmax(0, 1fr)` وأعدت القياس (390/390). وجملة «(M1 أو أحدث)» كانت تنقلب في RTL فأعدت صياغتها.

CI على الـPR: يُحدَّث بعد الدفع.

## المخاطر والرجوع
- حد الـAPI غير الموثّق ٦٠ طلبًا في الساعة لكل عنوان IP؛ بعده تعمل الصفحة بالرجوع إلى صفحة
  الإصدارات، والتخزين عشر دقائق يخفّف التكرار.
- `/releases/latest` يتجاهل الإصدارات التجريبية والمسودات؛ هذا المقصود.
- النشر الأول يفشل حتى يختار المالك مصدر Pages «GitHub Actions»؛ لا أثر على بقية CI.
- الرجوع: حذف `site/` و`pages.yml` وإرجاع سطر `pnpm-workspace.yaml`، وإيقاف Pages من الإعدادات.

## التسليم والخطوة التالية
- المالك: Settings → Pages → Source: «GitHub Actions»، ثم Actions → Download page → Run workflow
  (التفاصيل والنطاق المخصص في `docs/RELEASING.md`).
- عند اعتماد قائمة Microsoft Store: `microsoftStore.enabled = true` في `site/src/config.js`؛
  وكذلك Google Play، وApp Store بعد وضع رابطه.
