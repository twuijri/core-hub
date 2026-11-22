/**
 * What the plugin's browser half says (the chat cards and the settings page), in Arabic and
 * English (AGENTS.md: every user-facing string in both). Kept apart from `i18n.ts`, which the
 * host half uses, so the browser bundle carries no host code. The product's name is passed in
 * (the build reads it from `@corehub/contracts`), never typed here.
 */

export type UiLanguage = 'en' | 'ar';

const en = {
  'chat.hermes.label': 'Hermes · {product}',
  'chat.hermes.thinking': 'Hermes is answering…',
  'chat.hermes.failed': 'Hermes did not answer',
  'chat.you': 'You',
  'chat.running': 'Working…',
  'chat.ok.link': 'Linked to {product}',
  'chat.fail.link': 'Linking failed',
  'chat.ok.unlink': 'Unlinked',
  'chat.ok.status': '{product} link',
  'chat.ok.models': '{product} models',
  'chat.ok.help': '{product} commands',
  'chat.ok': '{product}',
  'chat.fail': '{product}: not done',
  'chat.openSettings': 'Open {product} settings',
  'page.intro':
    'Link this harness to your {product} server, choose what the hub’s agents may use on this computer, and see what they did. The /corehub commands do the same.',
  'page.loading': 'Loading…',
  'page.error': 'The plugin did not answer: {reason}',
  'page.retry': 'Try again',
  'link.title': 'Link',
  'link.unlinked': 'This harness is not linked to a hub.',
  'link.paste': 'Pairing from {product}',
  'link.paste.hint':
    'In {product}, link a device and copy the pairing (the JSON or the corehub://pair link), then paste it here. It is used once and never saved.',
  'link.button': 'Link',
  'link.busy': 'Linking…',
  'link.hub': 'Hub',
  'link.user': 'User',
  'link.device': 'Device',
  'link.connection': 'Connection',
  'link.token': 'Token valid until',
  'link.models': 'Models',
  'link.models.count': '{count} models in the model picker',
  'link.models.refresh': 'Refresh models',
  'link.unlink': 'Unlink',
  'link.unlink.confirm':
    'Unlink from {hub}? The token is revoked on the hub and deleted from this computer.',
  'link.relink': 'Link again or to another hub',
  'conn.connected': 'Connected',
  'conn.connecting': 'Connecting…',
  'conn.offline': 'Offline',
  'conn.refused': 'Refused by the hub — link again',
  'conn.stopped': 'Stopped',
  'conn.unlinked': 'Not linked',
  'folders.title': 'Shared folders',
  'folders.hint':
    'The hub’s agents may use these folders on this computer: read-only unless you make one writable.',
  'folders.empty': 'No folder is shared.',
  'folders.writable': 'Writable',
  'folders.remove': 'Remove',
  'folders.pick': 'Choose folder…',
  'folders.path': 'Absolute folder path',
  'folders.add': 'Add',
  'folders.allowOpen': 'Let the hub’s agents open files (in shared folders) and web links here',
  'programs.title': 'Programs (MCP servers)',
  'programs.hint':
    'The MCP servers of this harness profile. Switch one on and pick the hub profiles it serves; you are asked before each first use.',
  'programs.empty': 'This harness profile has no MCP server.',
  'programs.on': 'Offer to the hub',
  'programs.noProfiles': 'Link to a hub first to pick its profiles.',
  'hermes.title': 'Hermes (/hermes)',
  'hermes.profile': 'Hub profile',
  'hermes.default': 'Your default profile',
  'screen.title': 'Screen tasks',
  'screen.toggle': 'Offer screen tasks to the hub (you are asked every time)',
  'screen.model': 'Model',
  'screen.model.auto': 'The first model the hub offers',
  'screen.available': 'Available on this computer.',
  'screen.unavailable': 'Not available on this computer: {why}.',
  'screen.why.platform': 'macOS only',
  'screen.why.disabled': 'switched off',
  'screen.why.cua': 'this harness has no Computer Use',
  'screen.why.unlinked': 'not linked',
  'language.title': 'Language',
  'language.auto': 'Automatic',
  'activity.title': 'Recent activity',
  'activity.empty': 'Nothing yet.',
  saved: 'Saved.',
  'save.failed': 'Not saved: {reason}',
  'chat.command': 'Command',
  'md.copy': 'Copy',
  'md.copied': 'Copied',
  'md.code': 'Code',
  'md.wrap': 'Wrap lines',
  'md.unwrap': 'Keep columns',
  'md.footnotes': 'Footnotes',
  cancel: 'Cancel',
  close: 'Close',
} as const;

export type UiKey = keyof typeof en;

const ar: Record<UiKey, string> = {
  'chat.hermes.label': 'هيرمس · {product}',
  'chat.hermes.thinking': 'هيرمس يكتب الرد…',
  'chat.hermes.failed': 'ما وصل رد من هيرمس',
  'chat.you': 'أنت',
  'chat.running': 'جارٍ التنفيذ…',
  'chat.ok.link': 'تم الربط مع {product}',
  'chat.fail.link': 'فشل الربط',
  'chat.ok.unlink': 'تم فك الربط',
  'chat.ok.status': 'ربط {product}',
  'chat.ok.models': 'موديلات {product}',
  'chat.ok.help': 'أوامر {product}',
  'chat.ok': '{product}',
  'chat.fail': '{product}: ما تم',
  'chat.openSettings': 'افتح إعدادات {product}',
  'page.intro':
    'اربط هذا الهارنس مع سيرفر {product}، واختر وش يقدر وكلاء الهب يستخدمون في هذا الجهاز، وشوف وش سوّوا. أوامر \u2066/corehub\u2069 تسوي نفس الشي.',
  'page.loading': 'جارٍ التحميل…',
  'page.error': 'الإضافة ما ردّت: {reason}',
  'page.retry': 'حاول مرة ثانية',
  'link.title': 'الربط',
  'link.unlinked': 'هذا الهارنس غير مربوط بهب.',
  'link.paste': 'كود الربط من {product}',
  'link.paste.hint':
    'في {product} اربط جهاز وانسخ كود الربط (\u2066JSON\u2069 أو رابط \u2066corehub://pair\u2069)، ثم الصقه هنا. يُستخدم مرة وحدة وما يُحفظ.',
  'link.button': 'اربط',
  'link.busy': 'جارٍ الربط…',
  'link.hub': 'الهب',
  'link.user': 'المستخدم',
  'link.device': 'الجهاز',
  'link.connection': 'الاتصال',
  'link.token': 'المفتاح صالح حتى',
  'link.models': 'الموديلات',
  'link.models.count': '{count} موديل في قائمة الموديلات',
  'link.models.refresh': 'حدّث الموديلات',
  'link.unlink': 'فك الربط',
  'link.unlink.confirm': 'تفك الربط مع {hub}؟ يُلغى المفتاح في الهب ويُحذف من هذا الجهاز.',
  'link.relink': 'اربط من جديد أو مع هب ثاني',
  'conn.connected': 'متصل',
  'conn.connecting': 'جارٍ الاتصال…',
  'conn.offline': 'غير متصل',
  'conn.refused': 'الهب رفض الجهاز — اربط من جديد',
  'conn.stopped': 'متوقف',
  'conn.unlinked': 'غير مربوط',
  'folders.title': 'المجلدات المشاركة',
  'folders.hint':
    'وكلاء الهب يقدرون يستخدمون هذه المجلدات في هذا الجهاز: للقراءة فقط إلا إذا سمحت بالكتابة.',
  'folders.empty': 'ما فيه مجلد مشارك.',
  'folders.writable': 'كتابة',
  'folders.remove': 'إزالة',
  'folders.pick': 'اختر مجلد…',
  'folders.path': 'المسار الكامل للمجلد',
  'folders.add': 'أضف',
  'folders.allowOpen': 'اسمح لوكلاء الهب يفتحون الملفات (في المجلدات المشاركة) وروابط الويب هنا',
  'programs.title': 'البرامج (خوادم \u2066MCP\u2069)',
  'programs.hint':
    'خوادم \u2066MCP\u2069 في بروفايل الهارنس هذا. شغّل اللي تبيه واختر بروفايلات الهب اللي يخدمها؛ ويُسأل قبل أول استخدام.',
  'programs.empty': 'بروفايل الهارنس هذا ما فيه خادم \u2066MCP\u2069.',
  'programs.on': 'اعرضه على الهب',
  'programs.noProfiles': 'اربط مع هب أولاً عشان تختار بروفايلاته.',
  'hermes.title': 'هيرمس (\u2066/hermes\u2069)',
  'hermes.profile': 'بروفايل الهب',
  'hermes.default': 'بروفايلك الافتراضي',
  'screen.title': 'مهام الشاشة',
  'screen.toggle': 'اعرض مهام الشاشة على الهب (يُسأل كل مرة)',
  'screen.model': 'الموديل',
  'screen.model.auto': 'أول موديل يعرضه الهب',
  'screen.available': 'متاحة في هذا الجهاز.',
  'screen.unavailable': 'غير متاحة في هذا الجهاز: {why}.',
  'screen.why.platform': 'للماك فقط',
  'screen.why.disabled': 'مطفية',
  'screen.why.cua': 'هذا الهارنس ما فيه \u2066Computer Use\u2069',
  'screen.why.unlinked': 'غير مربوط',
  'language.title': 'اللغة',
  'language.auto': 'تلقائي',
  'activity.title': 'آخر النشاط',
  'activity.empty': 'ما فيه شي بعد.',
  saved: 'انحفظ.',
  'save.failed': 'ما انحفظ: {reason}',
  'chat.command': 'الأمر',
  'md.copy': 'نسخ',
  'md.copied': 'تم النسخ',
  'md.code': 'كود',
  'md.wrap': 'لف الأسطر',
  'md.unwrap': 'بدون لف',
  'md.footnotes': 'الحواشي',
  cancel: 'إلغاء',
  close: 'إغلاق',
};

export const UI_CATALOGUES: Record<UiLanguage, Record<UiKey, string>> = { en, ar };

export type UiTranslate = (key: UiKey, vars?: Record<string, string | number>) => string;

export function uiTranslator(language: UiLanguage, product: string): UiTranslate {
  const catalogue = UI_CATALOGUES[language];
  return (key, vars = {}) =>
    catalogue[key].replace(/\{(\w+)\}/g, (whole, name: string) => {
      if (name === 'product') return product;
      const value = vars[name];
      return value === undefined ? whole : String(value);
    });
}

/** `auto` follows the browser's languages; anything else is taken as it is. */
export function uiLanguage(setting: string | undefined, browser: readonly string[]): UiLanguage {
  if (setting === 'ar' || setting === 'en') return setting;
  const first = browser.find((l) => /^(ar|en)\b/i.test(l)) ?? '';
  return first.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}
