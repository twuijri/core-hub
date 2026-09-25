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
      'حمّل كور هب لـ Windows و macOS و Linux و Android، أو شغّل مركزك الخاص بصورة Docker واحدة.',
    'brand.name': 'كور هب',
    'nav.skip': 'تخطَّ إلى التحميل',
    'nav.downloads': 'التحميل',
    'nav.server': 'الخادم',
    'nav.source': 'GitHub',
    'lang.switch': 'English',
    'lang.switchLabel': 'Switch to English',
    'hero.eyebrow': 'مفتوح المصدر · تستضيفه بنفسك',
    'hero.title': 'كل وكلائك في مركز واحد',
    'hero.lead':
      'كور هب مركز تشغّله على جهازك أنت: محادثة ومهام وجدولة وسير عمل لكل وكلاء الذكاء الاصطناعي، من المتصفح والكمبيوتر والجوال.',
    'hero.for': 'حمّل لـ {platform}',
    'hero.soon': '{platform}: قريبًا',
    'hero.choose': 'اختر منصتك',
    'hero.all': 'كل المنصات',
    'release.loading': 'نبحث عن آخر إصدار…',
    'release.version': 'الإصدار {version}',
    'release.notes': 'ملاحظات الإصدار',
    'release.unavailable': 'تعذّر جلب تفاصيل آخر إصدار الآن، والملفات كلها في صفحة الإصدارات.',
    'release.page': 'صفحة الإصدارات',
    'downloads.title': 'التحميل',
    'downloads.lead': 'نسخة واحدة لكل منصة، من آخر إصدار منشور على GitHub.',
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
    'dl.appimage': 'تحميل AppImage',
    'dl.deb': 'تحميل حزمة deb',
    'dl.android': 'تحميل التطبيق',
    'dl.missing': 'من صفحة الإصدار',
    'store.open': 'افتح في المتجر',
    soon: 'قريبًا',
    'install.title': 'طريقة التثبيت',
    'html.install.windows':
      'المثبّت غير موقّع بعد، فقد يعرض Windows رسالة <bdi>«Windows protected your PC»</bdi>. اضغط <b>مزيد من المعلومات</b> ثم <b>التشغيل على أي حال</b> (<bdi>More info → Run anyway</bdi>). نسخة Microsoft Store يوقّعها المتجر نفسه.',
    'html.install.macos':
      'افتح الملف واسحب <b><bdi>Core Hub</bdi></b> إلى مجلد التطبيقات. التطبيق موقّع ومعتمد من Apple. أجهزة Mac بمعالج Intel غير مدعومة.',
    'install.linux.appimage': 'AppImage: اجعله قابلًا للتشغيل ثم شغّله.',
    'install.linux.deb': 'حزمة deb على Debian و Ubuntu: ثبّتها بـ apt.',
    'html.install.linux.fuse':
      'إن لم يعمل AppImage على Ubuntu فثبّت <bdi><code>libfuse2</code></bdi> (أو <bdi><code>libfuse2t64</code></bdi> على 24.04).',
    'html.install.android':
      'افتح الملف بعد التحميل. سيطلب Android السماح بالتثبيت من هذا المصدر (المتصفح أو مدير الملفات): فعّل <b>السماح من هذا المصدر</b> ثم ارجع واضغط <b>تثبيت</b>.',
    'install.ios': 'التطبيق يصل عبر App Store فقط، وسيظهر الرابط هنا حين يُنشر.',
    'server.eyebrow': 'الخادم',
    'server.title': 'شغّل مركزك الخاص',
    'server.lead':
      'التطبيقات نوافذ على مركزك. المركز حاوية واحدة ومجلد بيانات واحد، على جهازك أو على خادمك.',
    'server.image': 'صورة Docker',
    'server.arch': 'لمعالجات amd64 و arm64',
    'html.server.step1': 'احفظ هذا الملف باسم <bdi><code>docker-compose.yml</code></bdi>:',
    'server.step2': 'شغّله:',
    'html.server.step3':
      'خلال ساعة من التشغيل افتح <bdi><code>http://&lt;host&gt;:8080</code></bdi> وأنشئ حساب المالك، ثم أضف مزوّد نماذج من صفحة النماذج.',
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
    'downloads.lead': 'One build per platform, from the latest release on GitHub.',
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
      'The installer is not code-signed yet, so Windows may say <b>“Windows protected your PC”</b>. Click <b>More info</b>, then <b>Run anyway</b>. The Microsoft Store version is signed by the Store.',
    'html.install.macos':
      'Open the file and drag <b>Core Hub</b> into Applications. The app is signed and notarised by Apple. Intel Macs are not supported.',
    'install.linux.appimage': 'AppImage: make it executable, then run it.',
    'install.linux.deb': '.deb on Debian and Ubuntu: install it with apt.',
    'html.install.linux.fuse':
      'If the AppImage does not start on Ubuntu, install <code>libfuse2</code> (<code>libfuse2t64</code> on 24.04).',
    'html.install.android':
      'Open the file once it has downloaded. Android asks you to allow installs from this source (your browser or file manager): turn on <b>Allow from this source</b>, go back and tap <b>Install</b>.',
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
      'Within an hour, open <code>http://&lt;host&gt;:8080</code> and create the owner account, then add a model provider on the Models screen.',
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
