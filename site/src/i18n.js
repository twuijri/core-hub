// @ts-check
// Every word on the download page, Arabic first and English beside it (tests/page.test.ts checks
// that both languages have the same keys and that the page uses no key missing here).
//
// index.html names a string with {{key}}; build.mjs writes the Arabic into dist/index.html so the
// page reads right before any script runs, and app.js swaps the language in place. Keys under
// `html.` hold our own trusted markup (<b>, <code>, <bdi>) and are set with innerHTML; every other
// string is plain text. Latin names and commands inside Arabic are isolated with <bdi> so the
// sentence keeps its order (docs/clients/DESIGN.md: content decides its own direction).

/** @typedef {'ar' | 'en'} Lang */

/** @type {Record<Lang, Record<string, string>>} */
export const STRINGS = {
  ar: {
    'meta.title': 'كور هب — التحميل',
    'meta.description':
      'حمّل كور هب على Windows وmacOS وLinux وAndroid، أو شغّل مركزك الخاص بصورة Docker واحدة.',
    'brand.name': 'كور هب',
    'nav.skip': 'تخطَّ إلى التحميل',
    'nav.downloads': 'التحميل',
    'nav.server': 'الخادم',
    'nav.source': 'GitHub',
    'lang.switch': 'English',
    'lang.switchLabel': 'Switch to English',
    'hero.eyebrow': 'مفتوح المصدر · تستضيفه بنفسك',
    'hero.title': 'وكلاؤك، كلهم في مكان واحد',
    'hero.lead':
      'شغّل كور هب على جهازك أو خادمك، واجمع محادثات وكلائك ومهامهم وجداولهم وسير عملهم في مكان واحد. افتحه من المتصفح أو الكمبيوتر أو الجوال.',
    'hero.for': 'حمّل كور هب على {platform}',
    'hero.soon': '{platform}: قريبًا',
    'hero.choose': 'اختر منصتك',
    'hero.all': 'كل المنصات',
    'release.loading': 'نبحث عن آخر إصدار…',
    'release.version': 'الإصدار {version}',
    'release.notes': 'ملاحظات الإصدار',
    'release.unavailable': 'تعذّر جلب تفاصيل آخر إصدار الآن، والملفات كلها في صفحة الإصدارات.',
    'release.page': 'صفحة الإصدارات',
    'downloads.title': 'التحميل',
    'downloads.lead': 'اختر منصتك وحمّل التطبيق من أحدث إصدار منشور على GitHub.',
    'platform.windows': 'Windows',
    'platform.macos': 'macOS',
    'platform.linux': 'Linux',
    'platform.android': 'Android',
    'platform.ios': 'iPhone و iPad',
    'badge.detected': 'جهازك',
    'req.windows': 'Windows 10 أو 11، ‏64 بت',
    'req.macos': 'لأجهزة Mac بمعالج Apple فقط، من M1 فما بعد',
    'req.linux': 'أنظمة 64 بت (x86_64)',
    'req.android': 'Android 8 أو أحدث',
    'req.ios': 'iOS 17 أو أحدث',
    'dl.windows': 'تحميل المثبّت',
    'dl.macos': 'تحميل لأجهزة Mac',
    'dl.appimage': 'تحميل نسخة التشغيل',
    'dl.deb': 'تحميل حزمة النظام',
    'dl.android': 'تحميل التطبيق',
    'dl.missing': 'من صفحة الإصدار',
    'store.open': 'افتح في المتجر',
    soon: 'قريبًا',
    'install.title': 'طريقة التثبيت',
    'html.install.windows':
      'مثبّت Windows غير موقّع حاليًا، وقد يعرض النظام تحذير <bdi>SmartScreen</bdi>. حمّله من <b>صفحة الإصدارات الرسمية</b> فقط، وتأكد من مصدر الرابط واسم الملف قبل تثبيته. إذا لم تكن واثقًا من مصدره، فانتظر النسخة المنشورة عبر <bdi>Microsoft Store</bdi>.',
    'html.install.macos':
      'افتح الملف واسحب <b><bdi>Core Hub</bdi></b> إلى مجلد التطبيقات. التطبيق موقّع ومعتمد من Apple. أجهزة Mac بمعالج Intel غير مدعومة.',
    'install.linux.appimage': 'AppImage: اجعله قابلًا للتشغيل ثم شغّله.',
    'install.linux.deb': 'حزمة deb على Debian و Ubuntu: ثبّتها بـ apt.',
    'html.install.linux.fuse':
      'إن لم يعمل AppImage على Ubuntu فثبّت <bdi><code>libfuse2</code></bdi> (أو <bdi><code>libfuse2t64</code></bdi> على 24.04).',
    'html.install.android':
      'افتح الملف بعد تحميله من صفحة الإصدارات الرسمية. إذا طلب Android إذن التثبيت من هذا المصدر، فعّله مؤقتًا وثبّت التطبيق، ثم أوقف الإذن من إعدادات الجهاز.',
    'install.ios': 'التطبيق يصل عبر App Store فقط، وسيظهر الرابط هنا حين يُنشر.',
    'server.eyebrow': 'الخادم',
    'server.title': 'شغّل مركزك الخاص',
    'server.lead':
      'تتصل التطبيقات بمركزك، سواء شغّلته على جهازك أو خادمك. تحتاج حاوية واحدة ومجلدًا للبيانات.',
    'server.image': 'صورة Docker',
    'server.arch': 'لمعالجات amd64 و arm64',
    'html.server.step1': 'احفظ هذا الملف باسم <bdi><code>docker-compose.yml</code></bdi>:',
    'server.step2': 'شغّله:',
    'html.server.step3':
      'خلال ساعة من التشغيل، افتح <bdi><code>http://localhost:8080</code></bdi> من جهاز التشغيل وأنشئ حساب المالك. للوصول من جهاز آخر، اضبط دومينًا واتصال <bdi>HTTPS</bdi> كما في دليل التشغيل. بعدها أضف مزوّد نماذج من صفحة النماذج.',
    'server.docs': 'دليل التشغيل الكامل',
    copy: 'نسخ',
    copied: 'نُسخ',
    'footer.privacy': 'سياسة الخصوصية',
    'footer.source': 'الكود المصدري',
    'footer.releases': 'كل الإصدارات',
    'footer.note':
      'هذه الصفحة بلا متتبّعات ولا ملفات تعريف ارتباط، ولا تسأل إلا GitHub عن آخر إصدار.',
    'footer.license': 'مفتوح المصدر بترخيص Apache 2.0.',
    noscript: 'الروابط المباشرة تحتاج JavaScript. الملفات كلها في صفحة الإصدارات على GitHub.',
  },
  en: {
    'meta.title': 'Core Hub — Download',
    'meta.description':
      'Download Core Hub for Windows, macOS, Linux and Android, or run your own hub from one Docker image.',
    'brand.name': 'Core Hub',
    'nav.skip': 'Skip to downloads',
    'nav.downloads': 'Download',
    'nav.server': 'Server',
    'nav.source': 'GitHub',
    'lang.switch': 'العربية',
    'lang.switchLabel': 'التبديل إلى العربية',
    'hero.eyebrow': 'Open source · Self-hosted',
    'hero.title': 'All your AI agents in one hub',
    'hero.lead':
      'Core Hub is a hub you run on your own machine: chat, tasks, schedules and workflows for every AI agent you use, from the browser, your computer and your phone.',
    'hero.for': 'Download for {platform}',
    'hero.soon': '{platform}: coming soon',
    'hero.choose': 'Choose your platform',
    'hero.all': 'All platforms',
    'release.loading': 'Finding the latest release…',
    'release.version': 'Version {version}',
    'release.notes': 'Release notes',
    'release.unavailable':
      'The latest release details could not be loaded right now; every file is on the releases page.',
    'release.page': 'Releases page',
    'downloads.title': 'Download',
    'downloads.lead': 'Choose your platform and download from the latest GitHub release.',
    'platform.windows': 'Windows',
    'platform.macos': 'macOS',
    'platform.linux': 'Linux',
    'platform.android': 'Android',
    'platform.ios': 'iPhone & iPad',
    'badge.detected': 'Your device',
    'req.windows': 'Windows 10 or 11, 64-bit',
    'req.macos': 'Apple silicon Macs only (M1 or later)',
    'req.linux': '64-bit systems (x86_64)',
    'req.android': 'Android 8 or later',
    'req.ios': 'iOS 17 or later',
    'dl.windows': 'Download the installer',
    'dl.macos': 'Download for Mac',
    'dl.appimage': 'Download AppImage',
    'dl.deb': 'Download .deb',
    'dl.android': 'Download the APK',
    'dl.missing': 'From the release page',
    'store.open': 'Open in the store',
    soon: 'Coming soon',
    'install.title': 'How to install',
    'html.install.windows':
      'The Windows installer is not code-signed yet and may trigger a <b>SmartScreen</b> warning. Download it only from the <b>official releases page</b> and check the link and filename before installing it. If you are unsure of its source, wait for the Microsoft Store version.',
    'html.install.macos':
      'Open the file and drag <b>Core Hub</b> into Applications. The app is signed and notarised by Apple. Intel Macs are not supported.',
    'install.linux.appimage': 'AppImage: make it executable, then run it.',
    'install.linux.deb': '.deb on Debian and Ubuntu: install it with apt.',
    'html.install.linux.fuse':
      'If the AppImage does not start on Ubuntu, install <code>libfuse2</code> (<code>libfuse2t64</code> on 24.04).',
    'html.install.android':
      'Open the file after downloading it from the official releases page. If Android asks to allow installs from this source, enable that permission temporarily, install the app, then turn the permission off in your device settings.',
    'install.ios':
      'The app ships through the App Store only; the link appears here as soon as it is live.',
    'server.eyebrow': 'The server',
    'server.title': 'Run your own hub',
    'server.lead':
      'The apps are windows onto your hub. The hub is one container and one data volume, on your computer or your server.',
    'server.image': 'Docker image',
    'server.arch': 'For amd64 and arm64',
    'html.server.step1': 'Save this as <code>docker-compose.yml</code>:',
    'server.step2': 'Start it:',
    'html.server.step3':
      'Within an hour, open <code>http://localhost:8080</code> on the host machine and create the owner account. For access from another device, set up a domain and HTTPS as described in the deployment guide. Then add a model provider on the Models screen.',
    'server.docs': 'Full deployment guide',
    copy: 'Copy',
    copied: 'Copied',
    'footer.privacy': 'Privacy policy',
    'footer.source': 'Source code',
    'footer.releases': 'All releases',
    'footer.note':
      'This page has no trackers and no cookies; it asks GitHub for the latest release and nothing else.',
    'footer.license': 'Open source under the Apache 2.0 license.',
    noscript: 'Direct links need JavaScript. Every file is on the GitHub releases page.',
  },
};

/**
 * A string in `lang`, with `{name}` placeholders filled.
 * @param {Lang} lang
 * @param {string} key
 * @param {Record<string, string>} [vars]
 */
export function t(lang, key, vars = {}) {
  const text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => vars[name] ?? m);
}
