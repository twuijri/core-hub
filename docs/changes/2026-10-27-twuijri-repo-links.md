# روابط المستودع وصفحة التحميل، والإصدارات في الشريط الجانبي و«حول»
المسؤول: twuijri · الفرع: feat/repo-links · الحالة: review

ينزل في 1.1.10 (ليس 1.1.9).

## المشكلة والهدف
المالك (٢٠٢٦-١٠-٢٧):
- «ابي جنب العلامة الاعدادات ابي شعار قيت هوب ابي اذا ضغط عليه الواحد يوديه للريبو».
- «ابي بالاباوت يكون فيه صفحة التحميل وصفحة الريبو الاساسية علشان الواحد ممكن ينسى الريبو»، على كل المنصات: الويب والديسكتوب والجوال.
- ثم: رقم الإصدار أسفل الشريط الجانبي كان يعرض نسخة المركز (v1.1.6-preview.46) وتطبيق الديسكتوب عنده أحدث، فاختلط عليه. المطلوب: الرقم يعرض نسخة هذا التطبيق، وعند المرور عليه نافذة صغيرة تعرض كل نسخة في سطر («تطبيق سطح المكتب: …» و«المركز: …» في الديسكتوب، و«المركز: …» وحدها في المتصفح)، تختفي فور خروج المؤشر. وفي «حول» على كل عميل: أول سطر نسخة هذا التطبيق، وبعده «المركز المتصل» فقط إذا فيه مركز متصل.

## القرار والموافقات
- الرابطان ثابت واحد في العقود: `PRODUCT_LINKS` في `packages/contracts/src/product.ts` (المستودع `https://github.com/twuijri/core-hub` وصفحة التحميل `https://twuijri.github.io/core-hub/`). iOS يولّده في `Generated/Product.swift` (`repositoryURL`، `downloadPageURL`)، وأندرويد في `generated.Product` (`REPOSITORY_URL`، `DOWNLOAD_PAGE_URL`). اختبار في العقود يربطهما بـ `PRODUCT.repository`.
- شعار GitHub هو مسار `mark-github` من Octicons (MIT) لأن Lucide أوقفت شعارات العلامات. الويب يرسمه من `GitHubMark.tsx`، والجوالان من أصل مطابق (SVG قالب في iOS، و vector في أندرويد). `scripts/github-mark.test.mjs` يتأكد أن المسار واحد في الثلاثة. الإشعار في `THIRD-PARTY-NOTICES.md`.
- **رقم الإصدار أسفل الشريط (ويب/ديسكتوب):** اخترت أن يعرض نسخة التطبيق نفسه داخل الديسكتوب (من جسر الديسكتوب `getState().appVersion`، لأن الصفحة في الوضع البعيد تأتي من المركز فـ `__APP_VERSION__` نسخة المركز)، ونسخة المركز في المتصفح (لأن المركز هو من يقدّم الصفحة، والمتصفح قد يحمل حزمة قديمة). هذا أقل ما يفاجئ: الرقم الظاهر هو رقم البرنامج الذي يستخدمه الشخص. النافذة تفتح فوراً بالمرور أو التركيز بلوحة المفاتيح، وتختفي فور الخروج أو Escape، بلا تأخير ولا تثبيت. في الشريط المطوي تظهر الأسطر نفسها في القائمة.
- **«حول»:** نسخة المركز موجودة أصلاً في `meta.get` (`server_version`)، فلا تغيير في العقد ولا في الخادم. الويب: «تطبيق سطح المكتب» أو «تطبيق الويب هذا» أولاً، ثم «المركز المتصل»؛ إذا فشل الوصول للمركز تبقى نسخة التطبيق وتظهر رسالة الخطأ. iOS وأندرويد: «إصدار التطبيق» (نسخة الحزمة) ثم «المركز المتصل» إذا ردّ المركز.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء في OpenAPI. إضافة ثابت `PRODUCT_LINKS` في `product.ts` وتصديره (إضافة فقط).

## الملفات والتأثير
- العقود: `packages/contracts/src/product.ts`، `src/index.ts`، `tests/product.test.ts`.
- الويب/الديسكتوب: `packages/web/src/ui/brand/GitHubMark.tsx`، `ui/index.ts`، `shell/Sidebar.tsx`، `shell/VersionLabel.tsx`، `settings/AboutTab.tsx`، `i18n/{en,ar}.json`، والاختبارات `tests/sidebar-rail.test.tsx`، `tests/settings-pages.test.tsx`، `tests/version-label.test.tsx`.
- iOS: `scripts/generate-swift.mjs` → `CoreHub/Generated/Product.swift`، `Resources/Assets.xcassets/GitHubMark.imageset`، `Theme/Icon.swift` (`GitHubMarkIcon`)، `Shell/SidebarView.swift` (زر المستودع جنب الإعدادات)، `Settings/Pages/AboutPage.swift`، `i18n/{en,ar}.json`، `CoreHubTests/AboutLinksTests.swift`.
- أندرويد: `app/build.gradle.kts` (توليد `Product`)، `res/drawable/github_mark.xml`، `ui/screens/Shell.kt` (زر المستودع جنب الإعدادات)، `ui/screens/settings/AboutPage.kt`، `i18n/{en,ar}.json`، `test/.../ui/AboutLinksTest.kt`.
- `scripts/github-mark.test.mjs`، `THIRD-PARTY-NOTICES.md`، `packages/web/e2e/zzzzzzzzzzz-design-family.spec.ts`.
- حُذف مفتاح `about.server_version` من الويب و iOS لأنه لم يعد مستخدماً (صار «المركز المتصل»).

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm typecheck                     → exit 0
$ pnpm i18n:check                    → i18n:check  OK (web, ios 2786 keys, android 2649 keys, ar/en in parity)
$ pnpm i18n:limits                   → i18n:limits  OK
$ pnpm contracts:check-clients       → check-clients  OK
$ node apps/ios/scripts/generate-swift.mjs --check → OK — every generated file matches its source
$ node --test scripts/github-mark.test.mjs → pass 1, fail 0
$ (packages/contracts) vitest run tests/product.test.ts → 8 passed
$ (packages/web) vitest run tests/version-label.test.tsx tests/settings-pages.test.tsx tests/sidebar-rail.test.tsx --maxWorkers=2 → 27 passed
$ eslint + prettier --check على الملفات المتغيّرة → نظيف
```
اختبارات iOS وأندرويد لم تُشغَّل محلياً (لا يوجد Xcode ولا JDK على هذا الجهاز)؛ تعمل على CI.

## المخاطر والرجوع
إضافات فقط، لا تغيير في واجهات الخادم. الرجوع بإرجاع هذا الـ PR.
حدود: موضع النافذة يُحسب من مكان الرقم عند فتحها (ثابتة على الشاشة)، ولم أجربها يدوياً في نافذة الديسكتوب الحقيقية؛ الاختبارات تغطي الفتح والإغلاق والأسطر.

CI الأول (f2ae6688): 16 نجح. فشل فحص سجل التغيير لأن سطر الرأس فيه زيادة، وتصلّح. وألغيت مهلة «Web smoke journeys» بعد 35 دقيقة: تثبيت الخطوط بـ apt أخذ 27 دقيقة، وكل اختبارات Playwright اللي اشتغلت (73) نجحت قبل الإلغاء.
CI الثاني (e21747c7): 17 نجح، وفشل اختبار واحد في Playwright هو `design-family`. قاعدته تقول إن كل أيقونة في تذييل الشريط مرسومة بخط Lucide على شبكة 24، وشعار GitHub شعار مصمت على شبكة 16. وسمته بـ `data-brand-mark="github"`، والقاعدة صارت تستثني الشعارات وتتأكد أن شعار GitHub موجود في التذييل.

## التسليم والخطوة التالية
مراجعة المالك ودمجه، وينزل مع 1.1.10 بعد إطلاق 1.1.9.
