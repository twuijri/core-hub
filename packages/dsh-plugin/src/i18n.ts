/**
 * What the plugin says to the person, in Arabic and English (AGENTS.md: every user-facing string
 * in both). The language follows the plugin's `language` setting; `auto` reads the harness
 * process's locale (`LC_ALL`, `LC_MESSAGES`, `LANG`), English when it says nothing.
 *
 * Product names come from `@corehub/contracts` (`{product}`), never a typed literal.
 */
import { PRODUCT_NAME, PRODUCT_NAME_AR } from './names.js';

export type Language = 'en' | 'ar';

const en = {
  'link.usage':
    'Usage: /{command} link <pairing JSON | {scheme}://pair?… link | hub-address pairing-id code>. Create the pairing in {product} (link a device).',
  'link.parse.empty': 'Paste the pairing from {product} after /{command} link.',
  'link.parse.json_invalid': 'That is not a {product} pairing code.',
  'link.parse.hub_invalid': 'That hub address is not valid (use https://host or http://host:port).',
  'link.parse.fields_missing': 'The pairing needs the hub address, the pairing id and the code.',
  'link.claiming': 'Linking to {hub}…',
  'link.done': 'Linked to {hub} as {user}. This computer is now a device of the hub.',
  'link.failed': 'Linking failed: {reason}',
  'link.claim.401': 'The code is wrong.',
  'link.claim.404': 'The pairing has expired. Create a new one in {product}.',
  'link.claim.409': 'That pairing was already used. Create a new one in {product}.',
  'link.claim.403': 'This account is disabled on the hub.',
  'models.ready': 'The hub’s models are in the model picker under “{product}” ({count}).',
  'models.none': 'The hub’s model entrance is on but offers you no model yet.',
  'models.off':
    'The hub’s model entrance for your own apps is off or closed to you ({detail}). An admin must switch it on in {product} (Settings → Models) before the harness can use the hub’s models.',
  'models.missing':
    'This hub has no model entrance for your own apps yet ({detail}). Update {product} on the server, then run /corehub models.',
  'models.unreachable': 'Could not reach the hub’s model entrance: {detail}',
  'models.refused':
    'The hub no longer accepts this computer’s token. Link again with /{command} link.',
  'models.not_written': 'The model list could not be written into this profile: {detail}',
  'status.unlinked': 'Not linked to a hub. Use /{command} link.',
  'status.linked': 'Linked to {hub} as {user} (device {device}).',
  'status.link': 'Device link: {status}{detail}.',
  'status.degraded':
    'The hub is older than this plugin and does not know “{what}” yet; it was left out of the report.',
  'status.token': 'Token valid until {expires}.',
  'status.folders': 'Shared folders: {folders}.',
  'status.folders_none': 'No folder is shared.',
  'status.settings':
    'Change the folders, programs, screen tasks and language on the harness’s Plugins page → {product} (Settings), or link and unlink there.',
  'status.programs': 'Programs on for the hub: {programs}.',
  'status.programs_none': 'No harness MCP server is switched on for the hub.',
  'status.screen_on': 'Screen tasks: available.',
  'status.screen_off': 'Screen tasks: not available on this computer ({why}).',
  'status.activity': 'Recent activity:',
  'status.file_open': 'Warning: the link file can be read by other users of this computer: {file}',
  'unlink.done': 'Unlinked from {hub}. The token was revoked and deleted from this computer.',
  'unlink.none': 'This harness is not linked to a hub.',
  'models.refreshing': 'Asking the hub for its models…',
  help: '/{command} link <pairing> — link this harness to {product}\n/{command} status — the link, the shared folders and programs, recent activity\n/{command} models — fetch the hub’s models again\n/{command} unlink — unlink and delete the token\n/{agentCommand} <message> — ask the hub’s agent',
  'agent.usage': 'Usage: /{agentCommand} <message>',
  'agent.not_linked': 'Not linked to a hub. Use /{command} link first.',
  'agent.no_agent': 'The hub has no agent in this profile to talk to.',
  'agent.waiting':
    'The hub’s agent is waiting for an approval. Answer it in {product}, then ask again here.',
  'agent.timeout':
    'The hub’s agent is still working. Its answer will be in the {product} conversation.',
  'agent.failed': 'The hub’s agent could not answer: {reason}',
  'agent.empty': '(The agent answered without text.)',
  'consent.title': '{product}',
  'consent.program':
    'The agent in {product} ({hub}, profile “{profile}”) wants to use the program “{program}” on this computer (tool: {tool}).',
  'consent.screen':
    'The agent in {product} ({hub}, profile “{profile}”) asks this computer to do a task on the screen{app}:\n\n{task}\n\nThe harness will control the screen until the task ends (at most {budget} s).',
  'consent.screen_app': ' in {app}',
  'consent.once': 'Allow once',
  'consent.allow': 'Allow',
  'consent.session': 'Allow for this session',
  'consent.deny': 'Deny',
  'screen.why.platform': 'macOS only',
  'screen.why.disabled': 'switched off in the settings',
  'screen.why.cua': 'this harness has no Computer Use',
  'screen.why.unlinked': 'not linked',
  'command.corehub': 'Link this harness to {product}, see the link, or unlink',
  'command.agent': 'Ask the {product} agent (Hermes) on the hub',
  'command.corehub.hint': 'link <pairing> | status | models | unlink',
  'command.agent.hint': 'message for the hub’s agent',
} as const;

export type Key = keyof typeof en;

const ar: Record<Key, string> = {
  'link.usage':
    'الاستخدام: ‎/{command} link‎ ثم كود الربط (‏JSON‏ أو رابط ‎{scheme}://pair‎ أو عنوان الهب ومعرّف الربط والكود). أنشئ الربط في {product} (ربط جهاز).',
  'link.parse.empty': 'الصق كود الربط من {product} بعد ‎/{command} link‎.',
  'link.parse.json_invalid': 'هذا ليس كود ربط من {product}.',
  'link.parse.hub_invalid': 'عنوان الهب غير صحيح (اكتبه مثل ‎https://host‎ أو ‎http://host:port‎).',
  'link.parse.fields_missing': 'الربط يحتاج عنوان الهب ومعرّف الربط والكود.',
  'link.claiming': 'جارٍ الربط مع ‎{hub}‎…',
  'link.done': 'تم الربط مع ‎{hub}‎ باسم {user}. هذا الجهاز صار من أجهزة الهب.',
  'link.failed': 'فشل الربط: {reason}',
  'link.claim.401': 'الكود غير صحيح.',
  'link.claim.404': 'انتهت صلاحية الربط. أنشئ ربطاً جديداً في {product}.',
  'link.claim.409': 'هذا الربط استُخدم من قبل. أنشئ ربطاً جديداً في {product}.',
  'link.claim.403': 'هذا الحساب معطّل في الهب.',
  'models.ready': 'موديلات الهب موجودة في قائمة الموديلات تحت «{product}» ({count}).',
  'models.none': 'باب موديلات الهب مفتوح، لكنه لا يعرض لك أي موديل بعد.',
  'models.off':
    'باب موديلات الهب لتطبيقاتك الخاصة مطفي أو مقفول عليك ({detail}). لازم مشرف يشغّله في {product} (الإعدادات ← الموديلات) قبل ما يقدر الهارنس يستخدم موديلات الهب.',
  'models.missing':
    'هذا الهب ما فيه باب موديلات لتطبيقاتك الخاصة بعد ({detail}). حدّث {product} في السيرفر، ثم شغّل ‎/corehub models‎.',
  'models.unreachable': 'ما قدرنا نوصل لباب موديلات الهب: {detail}',
  'models.refused': 'الهب ما عاد يقبل مفتاح هذا الجهاز. اربط من جديد بـ ‎/{command} link‎.',
  'models.not_written': 'ما قدرنا نكتب قائمة الموديلات في هذا البروفايل: {detail}',
  'status.unlinked': 'غير مربوط بهب. استخدم ‎/{command} link‎.',
  'status.linked': 'مربوط مع ‎{hub}‎ باسم {user} (الجهاز ‎{device}‎).',
  'status.link': 'اتصال الجهاز: {status}{detail}.',
  'status.degraded': 'الهب أقدم من هذه الإضافة وما يعرف «{what}» بعد، فتُرك من التقرير.',
  'status.token': 'المفتاح صالح حتى ‎{expires}‎.',
  'status.folders': 'المجلدات المشاركة: {folders}.',
  'status.folders_none': 'ما فيه مجلد مشارك.',
  'status.settings':
    'غيّر المجلدات والبرامج ومهام الشاشة واللغة من صفحة الإضافات في الهارنس ← {product} (الإعدادات)، ومنها تقدر تربط وتفك الربط.',
  'status.programs': 'البرامج المفتوحة للهب: {programs}.',
  'status.programs_none': 'ما فيه خادم ‏MCP‏ من الهارنس مفتوح للهب.',
  'status.screen_on': 'مهام الشاشة: متاحة.',
  'status.screen_off': 'مهام الشاشة: غير متاحة في هذا الجهاز ({why}).',
  'status.activity': 'آخر النشاط:',
  'status.file_open': 'تنبيه: ملف الربط يقدر يقرؤه مستخدمون آخرون في هذا الجهاز: ‎{file}‎',
  'unlink.done': 'تم فك الربط مع ‎{hub}‎. أُلغي المفتاح وحُذف من هذا الجهاز.',
  'unlink.none': 'هذا الهارنس غير مربوط بهب.',
  'models.refreshing': 'جارٍ طلب الموديلات من الهب…',
  help: '‎/{command} link‎ — ربط هذا الهارنس مع {product}\n‎/{command} status‎ — حالة الربط والمجلدات والبرامج وآخر النشاط\n‎/{command} models‎ — جلب موديلات الهب من جديد\n‎/{command} unlink‎ — فك الربط وحذف المفتاح\n‎/{agentCommand}‎ ثم رسالتك — اسأل وكيل الهب',
  'agent.usage': 'الاستخدام: ‎/{agentCommand}‎ ثم رسالتك',
  'agent.not_linked': 'غير مربوط بهب. استخدم ‎/{command} link‎ أولاً.',
  'agent.no_agent': 'ما فيه وكيل في هذا البروفايل في الهب نكلّمه.',
  'agent.waiting': 'وكيل الهب ينتظر موافقة. رد عليها في {product}، ثم اسأل هنا من جديد.',
  'agent.timeout': 'وكيل الهب ما زال يشتغل. جوابه بيكون في محادثة {product}.',
  'agent.failed': 'وكيل الهب ما قدر يجاوب: {reason}',
  'agent.empty': '(الوكيل جاوب بدون نص.)',
  'consent.title': '{product}',
  'consent.program':
    'الوكيل في {product} (‎{hub}‎، بروفايل «{profile}») يبي يستخدم البرنامج «{program}» في هذا الجهاز (الأداة: {tool}).',
  'consent.screen':
    'الوكيل في {product} (‎{hub}‎، بروفايل «{profile}») يطلب من هذا الجهاز مهمة على الشاشة{app}:\n\n{task}\n\nالهارنس بيتحكم بالشاشة لين تخلص المهمة (بحد أقصى {budget} ثانية).',
  'consent.screen_app': ' في {app}',
  'consent.once': 'اسمح مرة',
  'consent.allow': 'اسمح',
  'consent.session': 'اسمح لهذه الجلسة',
  'consent.deny': 'ارفض',
  'screen.why.platform': 'للماك فقط',
  'screen.why.disabled': 'مطفية في الإعدادات',
  'screen.why.cua': 'هذا الهارنس ما فيه ‏Computer Use‏',
  'screen.why.unlinked': 'غير مربوط',
  'command.corehub': 'اربط هذا الهارنس مع {product}، أو اعرض حالة الربط، أو فكّه',
  'command.agent': 'اسأل وكيل {product} (‏Hermes‏) في الهب',
  'command.corehub.hint': 'link <الربط> | status | models | unlink',
  'command.agent.hint': 'رسالتك لوكيل الهب',
};

export const CATALOGUES: Record<Language, Record<Key, string>> = { en, ar };

/** `auto`, or a code: the language the plugin speaks. */
export function pickLanguage(
  setting: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Language {
  const wanted = (
    setting && setting !== 'auto' ? setting : (env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '')
  )
    .toLowerCase()
    .slice(0, 2);
  return wanted === 'ar' ? 'ar' : 'en';
}

export type Translate = (key: Key, vars?: Record<string, string | number>) => string;

export function translator(language: Language): Translate {
  const catalogue = CATALOGUES[language];
  const product = language === 'ar' ? PRODUCT_NAME_AR : PRODUCT_NAME;
  return (key, vars = {}) =>
    catalogue[key].replace(/\{(\w+)\}/g, (whole, name: string) => {
      if (name === 'product') return product;
      const value = vars[name];
      return value === undefined ? whole : String(value);
    });
}
