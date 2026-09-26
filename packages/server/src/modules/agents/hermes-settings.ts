/**
 * Hermes's own settings in a profile — the Hermes Settings page (ADR 0002: the adapter declares
 * the form, the client draws it), read and written **where Hermes reads each one**: the profile's
 * `config.yaml` (edited in place, comments and every other key kept, like the MCP and channel
 * blocks) or its `.env`. Contract decision §58.
 *
 * Until 2026-09-25 this page showed four sections the hub stored in its own table and nothing
 * read (a turn limit of 40 Hermes never saw, an approvals mode, a gateway URL). What is here now
 * was observed in Hermes's MIT source (`/opt/hermes`, v2026.9.14), not guessed:
 *
 * - **agent** — `agent.max_turns` (null: 500 in the TUI gateway the hub's conversations use,
 *   unlimited in a messaging gateway; `0`/`-1`/`"unlimited"` mean no limit —
 *   `hermes_cli/config.py` §resolve_turn_limit, `tui_gateway/server.py` `_cfg_max_turns(cfg, 500)`),
 *   `agent.run_budget_seconds` (wall-clock budget per run, off when unset or ≤ 0 —
 *   `agent/agent_init.py`), `agent.tool_use_enforcement` (`auto`, `true`, `false` or a list of
 *   model-name substrings) and `agent.reasoning_effort` (`none` or one of
 *   `hermes_constants.VALID_REASONING_EFFORTS`; a YAML `false` means none). All four are read
 *   when Hermes builds a session's agent.
 * - **memory** — `memory.memory_char_limit` (2200) and `memory.user_char_limit` (1375), the same
 *   budgets the Memory page enforces (`memory.ts`).
 * - **approvals** — `approvals.mode` (`manual`, `smart`, `off`; `smart` by default, a bare YAML
 *   `off` read as `false` — `tools/approval_context.py`), and `memory.write_approval` /
 *   `skills.write_approval`: with one on, the agent's writes wait under `pending/<kind>/` for
 *   review (`tools/write_approval.py`, `hermes-pending-writes.ts`).
 * - **network** — `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` in the profile's `.env`: Hermes loads
 *   that file into its process environment at start (`hermes_cli/env_loader.py`) and its model
 *   and tool clients read the proxy from there (`agent/process_bootstrap.py`,
 *   `agent/proxy_bypass.py`). Process-wide, so it needs a restart; and the one TUI gateway serves
 *   every profile from the root home, so the **default** profile's proxy is the one every
 *   conversation in the hub uses, while a named profile's reaches its own messaging gateway only.
 *   The hub's own outgoing requests (Node's `fetch`) never read it.
 * - **privacy** — `privacy.redact_pii`: on WhatsApp, Telegram, Signal and BlueBubbles, Hermes
 *   hashes user and chat ids and leaves phone numbers out of what the model is told; re-read on
 *   every message (`gateway/run_turn.py`). The hub's own conversations carry no such ids.
 *
 * Asked for and **not** here, because Hermes does not have it: an automatic session reset after
 * idle time or at an hour. `gateway.config.SessionResetPolicy` is kept only as an inert type for
 * plugins ("Gateway configuration and session lifecycle do not consume this datatype") and
 * `gateway/session_lifecycle.py` says "time never does" replace a conversation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Scalar, isMap, parseDocument, type Document } from 'yaml';
import { CONFIG_FILE } from './mcp.js';
import { readEnv, writeEnvValue } from './channels.js';
import type { SettingsChoice, SettingsField, SettingsSection } from './adapters/types.js';

type Text = { ar: string; en: string };
type Value = number | boolean | string;
export type HermesSectionKey = 'agent' | 'memory' | 'approvals' | 'network' | 'privacy';

interface ChoiceSpec {
  value: string;
  labels: Text;
  /** What the file holds for it. */
  file: unknown;
  /** Shown only while the file already holds it; never written from the form. */
  readOnly?: boolean;
}

interface OptionSpec {
  key: string;
  section: HermesSectionKey;
  kind: 'integer' | 'toggle' | 'choice' | 'text';
  label: Text;
  help: Text;
  /** Hermes's own default, the value while nothing is written; `null` = none (off). */
  fallback: Value | null;
  defaultText?: Text;
  min?: number;
  max?: number;
  choices?: readonly ChoiceSpec[];
  /** Where Hermes reads it in `config.yaml`, highest precedence first; the first is where it is written. */
  yaml?: ReadonlyArray<readonly string[]>;
  /** The environment variables Hermes reads, highest precedence first; the first is written. */
  env?: readonly string[];
  /** A text value's shape. */
  pattern?: RegExp;
  /** Reads what the file holds as the field's value; `undefined` when it is not one. */
  read?: (raw: unknown) => Value | undefined;
  /** What a value becomes in the file; `null` removes the key. */
  write?: (value: Value) => unknown;
}

const UNLIMITED = new Set(['none', 'null', 'unlimited', 'infinite', 'infinity', 'inf', '∞']);

function turnLimit(raw: unknown): Value | undefined {
  if (typeof raw === 'boolean' || raw === null || raw === undefined) return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
  const text = String(raw).trim().toLowerCase();
  if (text === '') return undefined;
  if (UNLIMITED.has(text)) return 0;
  const number = Number(text);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(0, Math.trunc(number));
}

function seconds(raw: unknown): Value | undefined {
  if (typeof raw === 'boolean' || raw === null || raw === undefined) return undefined;
  const number = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.round(number);
}

function positiveInteger(raw: unknown): Value | undefined {
  if (typeof raw === 'boolean' || raw === null || raw === undefined) return undefined;
  const number = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

const TRUTHY = new Set(['true', 'on', 'yes', '1']);
const FALSY = new Set(['false', 'off', 'no', '0']);

function flag(raw: unknown): Value | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim().toLowerCase();
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  return undefined;
}

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

const EFFORT_LABELS: Record<string, Text> = {
  none: { ar: 'بلا تفكير', en: 'No reasoning' },
  minimal: { ar: 'أدنى', en: 'Minimal' },
  low: { ar: 'منخفض', en: 'Low' },
  medium: { ar: 'متوسط', en: 'Medium' },
  high: { ar: 'عالٍ', en: 'High' },
  xhigh: { ar: 'عالٍ جدًا', en: 'Extra high' },
  max: { ar: 'الأقصى', en: 'Max' },
  ultra: { ar: 'فائق', en: 'Ultra' },
};

const PROXY_URL = /^(https?|socks[45]?h?):\/\/[^\s]+$/i;
const NO_PROXY = /^[A-Za-z0-9.*:_\-[\]/]+(\s*,\s*[A-Za-z0-9.*:_\-[\]/]+)*$/;

export const HERMES_SETTING_OPTIONS: readonly OptionSpec[] = [
  // ------------------------------------------------------------------ agent runtime
  {
    key: 'max_turns',
    section: 'agent',
    kind: 'integer',
    label: { ar: 'أقصى عدد للدورات في التشغيل', en: 'Max turns per run' },
    help: {
      ar: 'كم مرة يستدعي الوكيل النموذج (مع أدواته) لرسالة واحدة قبل أن يتوقف ويرد بما وصل إليه. صفر = بلا حد.',
      en: 'How many model calls (with their tools) the agent may make for one message before it stops and answers with what it has. 0 = no limit.',
    },
    fallback: null,
    defaultText: {
      ar: '500 في محادثات كور هب، وبلا حد في قنوات المراسلة',
      en: "500 in Core Hub's conversations, no limit on messaging channels",
    },
    min: 0,
    max: 100_000,
    yaml: [['agent', 'max_turns'], ['max_turns']],
    read: turnLimit,
  },
  {
    key: 'run_budget_seconds',
    section: 'agent',
    kind: 'integer',
    label: { ar: 'مهلة التشغيل (ثوانٍ)', en: 'Run time limit (seconds)' },
    help: {
      ar: 'أقصى وقت لتشغيل واحد. عند 80% منه يُطلب من الوكيل أن يختم عمله. فارغ أو صفر = بلا مهلة.',
      en: 'The longest one run may take. At 80% of it the agent is told to wrap up. Empty or 0 = no limit.',
    },
    fallback: null,
    defaultText: { ar: 'بلا مهلة', en: 'No limit' },
    min: 0,
    max: 86_400,
    yaml: [['agent', 'run_budget_seconds']],
    read: seconds,
  },
  {
    key: 'tool_use_enforcement',
    section: 'agent',
    kind: 'choice',
    label: { ar: 'إلزام استخدام الأدوات', en: 'Tool-use enforcement' },
    help: {
      ar: 'يطلب من النموذج أن يستدعي الأدوات بدل أن يصف ما سيفعله. «تلقائي» يطبقه على نماذج GPT وCodex فقط.',
      en: 'Tells the model to call its tools instead of describing what it would do. "Automatic" applies it to GPT and Codex models only.',
    },
    fallback: 'auto',
    choices: [
      { value: 'auto', labels: { ar: 'تلقائي', en: 'Automatic' }, file: 'auto' },
      { value: 'on', labels: { ar: 'دائمًا', en: 'Always' }, file: true },
      { value: 'off', labels: { ar: 'أبدًا', en: 'Never' }, file: false },
      {
        value: 'custom',
        labels: {
          ar: 'قائمة نماذج في config.yaml',
          en: 'A list of models in config.yaml',
        },
        file: null,
        readOnly: true,
      },
    ],
    yaml: [['agent', 'tool_use_enforcement']],
    read: (raw) => {
      if (Array.isArray(raw)) return 'custom';
      if (typeof raw === 'string' && raw.trim().toLowerCase() === 'auto') return 'auto';
      const on = flag(raw);
      return on === undefined ? undefined : on ? 'on' : 'off';
    },
  },
  {
    key: 'reasoning_effort',
    section: 'agent',
    kind: 'choice',
    label: { ar: 'مستوى التفكير الافتراضي', en: 'Default reasoning effort' },
    help: {
      ar: 'ما يستخدمه الوكيل حين لا تختار المحادثة مستوى من شريط الكتابة، لنماذج التفكير.',
      en: 'What the agent uses when a conversation does not pick one in the composer, for models that reason.',
    },
    fallback: null,
    defaultText: { ar: 'افتراضي النموذج', en: "The model's own" },
    choices: ['none', ...EFFORTS].map((value) => ({
      value,
      labels: EFFORT_LABELS[value]!,
      file: value,
    })),
    yaml: [['agent', 'reasoning_effort']],
    read: (raw) => {
      if (raw === false) return 'none';
      if (raw === null || raw === undefined || raw === true) return undefined;
      const text = String(raw).trim().toLowerCase();
      if (text === 'false' || text === 'disabled' || text === 'none') return 'none';
      return (EFFORTS as readonly string[]).includes(text) ? text : undefined;
    },
  },
  // ------------------------------------------------------------------ memory
  {
    key: 'memory_char_limit',
    section: 'memory',
    kind: 'integer',
    label: { ar: 'حد ذاكرة الوكيل (حروف)', en: "Agent's memory limit (characters)" },
    help: {
      ar: 'أقصى طول لملاحظات الوكيل الدائمة (MEMORY.md)، وتُحقن في كل رسالة. نحو 800 رمز عند 2200.',
      en: "The longest the agent's standing notes (MEMORY.md) may grow; they go into every message. About 800 tokens at 2200.",
    },
    fallback: 2200,
    min: 100,
    max: 100_000,
    yaml: [['memory', 'memory_char_limit']],
    read: positiveInteger,
  },
  {
    key: 'user_char_limit',
    section: 'memory',
    kind: 'integer',
    label: { ar: 'حد ما يعرفه عنك (حروف)', en: 'Limit of what it knows about you (characters)' },
    help: {
      ar: 'أقصى طول لما يحفظه الوكيل عن الشخص (USER.md). نحو 500 رمز عند 1375.',
      en: 'The longest what the agent keeps about the person (USER.md) may grow. About 500 tokens at 1375.',
    },
    fallback: 1375,
    min: 100,
    max: 100_000,
    yaml: [['memory', 'user_char_limit']],
    read: positiveInteger,
  },
  // ------------------------------------------------------------------ approvals
  {
    key: 'approvals_mode',
    section: 'approvals',
    kind: 'choice',
    label: { ar: 'الموافقة على الأوامر الخطرة', en: 'Approval of dangerous commands' },
    help: {
      ar: '«يدوي»: يُسأل الشخص عن كل أمر خطر. «ذكي»: نموذج مساعد يمرّر الآمن ويسأل عن الباقي. «بلا موافقات»: تُنفَّذ دون سؤال، عدا ما يمنعه هرمز دائمًا.',
      en: '"Manual": the person is asked about every dangerous command. "Smart": a helper model lets the safe ones through and asks about the rest. "Off": they run without asking, except what Hermes always blocks.',
    },
    fallback: 'smart',
    choices: [
      { value: 'manual', labels: { ar: 'يدوي', en: 'Manual' }, file: 'manual' },
      { value: 'smart', labels: { ar: 'ذكي', en: 'Smart' }, file: 'smart' },
      { value: 'off', labels: { ar: 'بلا موافقات', en: 'Off' }, file: 'off' },
    ],
    yaml: [['approvals', 'mode']],
    read: (raw) => {
      if (raw === false) return 'off';
      if (raw === true) return 'manual';
      if (typeof raw !== 'string') return undefined;
      const text = raw.trim().toLowerCase();
      return ['manual', 'smart', 'off'].includes(text) ? text : undefined;
    },
  },
  {
    key: 'memory_write_approval',
    section: 'approvals',
    kind: 'toggle',
    label: {
      ar: 'مراجعة ما يكتبه الوكيل في ذاكرته',
      en: 'Review what the agent writes to its memory',
    },
    help: {
      ar: 'حين يعمل، لا يُحفظ ما يضيفه الوكيل إلى ذاكرته حتى يوافق عليه أحد من قائمة «بانتظار المراجعة».',
      en: 'When on, what the agent adds to its memory is not saved until someone approves it in "Waiting for review".',
    },
    fallback: false,
    yaml: [['memory', 'write_approval']],
    read: flag,
  },
  {
    key: 'skills_write_approval',
    section: 'approvals',
    kind: 'toggle',
    label: {
      ar: 'مراجعة ما يكتبه الوكيل في مهاراته',
      en: 'Review what the agent writes to its skills',
    },
    help: {
      ar: 'حين يعمل، لا تُنشأ مهارة ولا تُعدَّل حتى يوافق عليها أحد من قائمة «بانتظار المراجعة».',
      en: 'When on, no skill is created or changed until someone approves it in "Waiting for review".',
    },
    fallback: false,
    yaml: [['skills', 'write_approval']],
    read: flag,
  },
  // ------------------------------------------------------------------ network
  {
    key: 'https_proxy',
    section: 'network',
    kind: 'text',
    label: { ar: 'وكيل HTTPS', en: 'HTTPS proxy' },
    help: {
      ar: 'عنوان الوكيل لطلبات هرمز الخارجية المشفرة، مثل http://proxy.local:3128 أو socks5://…',
      en: "The proxy for Hermes's outgoing encrypted requests, like http://proxy.local:3128 or socks5://…",
    },
    fallback: null,
    defaultText: { ar: 'بلا وكيل', en: 'No proxy' },
    env: ['HTTPS_PROXY', 'https_proxy'],
    pattern: PROXY_URL,
  },
  {
    key: 'http_proxy',
    section: 'network',
    kind: 'text',
    label: { ar: 'وكيل HTTP', en: 'HTTP proxy' },
    help: {
      ar: 'للطلبات غير المشفرة؛ ويُستعمل للمشفرة أيضًا حين يُترك وكيل HTTPS فارغًا.',
      en: 'For plain requests; also used for encrypted ones while the HTTPS proxy is empty.',
    },
    fallback: null,
    defaultText: { ar: 'بلا وكيل', en: 'No proxy' },
    env: ['HTTP_PROXY', 'http_proxy'],
    pattern: PROXY_URL,
  },
  {
    key: 'no_proxy',
    section: 'network',
    kind: 'text',
    label: { ar: 'بلا وكيل لهذه العناوين', en: 'Bypass the proxy for' },
    help: {
      ar: 'عناوين تُطلب مباشرة، مفصولة بفواصل: localhost,127.0.0.1,.internal',
      en: 'Hosts reached directly, separated by commas: localhost,127.0.0.1,.internal',
    },
    fallback: null,
    env: ['NO_PROXY', 'no_proxy'],
    pattern: NO_PROXY,
  },
  // ------------------------------------------------------------------ privacy
  {
    key: 'redact_pii',
    section: 'privacy',
    kind: 'toggle',
    label: {
      ar: 'إخفاء المعرّفات وأرقام الهواتف عن النموذج',
      en: 'Hide ids and phone numbers from the model',
    },
    help: {
      ar: 'في واتساب وتيليجرام وسيجنال وBlueBubbles: تُستبدل معرّفات الأشخاص والمحادثات برموز، ولا تصل أرقام الهواتف إلى النموذج.',
      en: "On WhatsApp, Telegram, Signal and BlueBubbles: people's and chats' ids are replaced by hashes, and phone numbers never reach the model.",
    },
    fallback: false,
    yaml: [['privacy', 'redact_pii']],
    read: flag,
  },
];

interface SectionSpec {
  key: HermesSectionKey;
  title: Text;
  applies: 'next_message' | 'restart';
  note: (isDefault: boolean) => Text;
}

const NEXT_MESSAGE: Text = {
  ar: 'تسري من الرسالة التالية في محادثات كور هب، وفي قنوات هذا البروفايل بعد إعادة تشغيل بوابته (يعيد كور هب تشغيل بوابة البروفايل المسمّى بنفسه؛ بوابة البروفايل الافتراضي عند «إعادة التشغيل»).',
  en: "Applies from the next message in Core Hub's conversations, and on this profile's channels once its gateway restarts (Core Hub restarts a named profile's gateway itself; the default profile's at Restart).",
};

const SECTIONS: readonly SectionSpec[] = [
  {
    key: 'agent',
    title: { ar: 'وقت التشغيل', en: 'Agent runtime' },
    applies: 'next_message',
    note: () => NEXT_MESSAGE,
  },
  {
    key: 'memory',
    title: { ar: 'الذاكرة', en: 'Memory' },
    applies: 'next_message',
    note: () => NEXT_MESSAGE,
  },
  {
    key: 'approvals',
    title: { ar: 'الموافقات', en: 'Approvals' },
    applies: 'next_message',
    note: () => NEXT_MESSAGE,
  },
  {
    key: 'network',
    title: { ar: 'وكيل الشبكة', en: 'Network proxy' },
    applies: 'restart',
    note: (isDefault) =>
      isDefault
        ? {
            ar: 'لهرمز وحده، لا لكور هب نفسه. وكيل البروفايل الافتراضي يستعمله هرمز في كل محادثات كور هب (عملية واحدة تخدم كل البروفايلات) وفي قنوات البروفايل الافتراضي. الحفظ يعيد تشغيل هرمز.',
            en: "For Hermes only, not Core Hub itself. The default profile's proxy is what Hermes uses in every Core Hub conversation (one process serves every profile) and on the default profile's channels. Saving restarts Hermes.",
          }
        : {
            ar: 'لهرمز وحده، لا لكور هب نفسه. وكيل هذا البروفايل يصل إلى قنواته ومهامه المجدولة (بوابته الخاصة، يعيد كور هب تشغيلها عند الحفظ). محادثات كور هب تستعمل وكيل البروفايل الافتراضي.',
            en: "For Hermes only, not Core Hub itself. This profile's proxy reaches its channels and scheduled jobs (its own gateway, which Core Hub restarts on save). Core Hub's conversations use the default profile's proxy.",
          },
  },
  {
    key: 'privacy',
    title: { ar: 'الخصوصية', en: 'Privacy' },
    applies: 'next_message',
    note: () => ({
      ar: 'في قنوات المراسلة فقط، من الرسالة التالية. محادثات كور هب لا تحمل هذه المعرّفات.',
      en: "On messaging channels only, from the next message. Core Hub's own conversations carry no such ids.",
    }),
  },
];

export const HERMES_SECTION_KEYS: readonly HermesSectionKey[] = SECTIONS.map((s) => s.key);

// ------------------------------------------------------------------ the file

export class HermesSettingError extends Error {
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'HermesSettingError';
  }
}

function load(home: string): Document {
  const file = path.join(home, CONFIG_FILE);
  if (!existsSync(file)) return parseDocument('');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  // A config we cannot parse is a config we must not rewrite.
  if (doc.errors.length > 0) throw new HermesSettingError('config.yaml', 'config_unreadable');
  return doc;
}

function save(home: string, doc: Document): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, CONFIG_FILE), doc.toString(), 'utf8');
}

function plain(doc: Document, at: readonly string[]): unknown {
  // A path through a scalar (`agent: 3`) is not a path; `getIn` would throw.
  for (let depth = 1; depth < at.length; depth += 1) {
    const parent = doc.getIn(at.slice(0, depth), true);
    if (parent !== undefined && !isMap(parent)) return undefined;
  }
  const node = doc.getIn(at, false);
  if (node === undefined || node === null) return undefined;
  return typeof node === 'object' && 'toJSON' in node
    ? (node as { toJSON(): unknown }).toJSON()
    : node;
}

function ensureParents(doc: Document, at: readonly string[]): void {
  for (let depth = 1; depth < at.length; depth += 1) {
    const prefix = at.slice(0, depth);
    if (!isMap(doc.getIn(prefix, true))) doc.setIn(prefix, doc.createNode({}));
  }
}

/** YAML 1.1 (Hermes's PyYAML) reads a bare `off`, `on`, `yes`, `no` as booleans: those are quoted. */
function fileNode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const node = new Scalar(value);
  if (/^(y|n|yes|no|on|off|true|false|null|~)$/i.test(value)) node.type = Scalar.QUOTE_SINGLE;
  return node;
}

// ------------------------------------------------------------------ reading

function readOne(spec: OptionSpec, doc: Document, env: Record<string, string>): Value | null {
  for (const name of spec.env ?? []) {
    const raw = env[name];
    if (raw !== undefined && raw.trim() !== '') return raw.trim();
  }
  for (const at of spec.yaml ?? []) {
    const raw = plain(doc, at);
    if (raw === undefined) continue;
    const value = spec.read ? spec.read(raw) : typeof raw === 'string' ? raw : undefined;
    if (value !== undefined) return value;
  }
  return null;
}

function fieldOf(spec: OptionSpec, value: Value | null): SettingsField {
  const options: SettingsChoice[] = (spec.choices ?? [])
    .filter((choice) => !choice.readOnly || choice.value === value)
    .map((choice) => ({ value: choice.value, label: choice.labels.en, labels: choice.labels }));
  return {
    key: spec.key,
    label: spec.label,
    kind: spec.kind,
    value,
    options,
    min: spec.min ?? null,
    max: spec.max ?? null,
    hint: null,
    help: spec.help,
    default: spec.fallback,
    default_text: spec.defaultText ?? null,
  };
}

/** Every section of the Hermes Settings page, as the profile's files say now. */
export function readHermesSettings(home: string, isDefault: boolean): SettingsSection[] {
  const doc = load(home);
  const env = readEnv(home);
  return SECTIONS.map((section) => ({
    key: section.key,
    title: section.title,
    restart_required: section.applies === 'restart',
    applies: section.applies,
    note: section.note(isDefault),
    fields: HERMES_SETTING_OPTIONS.filter((spec) => spec.section === section.key).map((spec) =>
      fieldOf(spec, readOne(spec, doc, env)),
    ),
  }));
}

// ------------------------------------------------------------------ writing

/** `input` checked against the option; `null` (or empty text) puts it back to Hermes's default. */
function validate(spec: OptionSpec, input: unknown): Value | null {
  if (input === null) return null;
  const refuse = (reason: string): never => {
    throw new HermesSettingError(spec.key, reason);
  };
  switch (spec.kind) {
    case 'toggle':
      return typeof input === 'boolean' ? input : refuse('boolean_expected');
    case 'integer': {
      if (typeof input !== 'number' || !Number.isInteger(input)) return refuse('integer_expected');
      if (
        (spec.min !== undefined && input < spec.min) ||
        (spec.max !== undefined && input > spec.max)
      )
        return refuse('out_of_range');
      // A run time limit of 0 is "no limit", which is what an absent key already means.
      if (spec.key === 'run_budget_seconds' && input === 0) return null;
      return input;
    }
    case 'choice': {
      if (input === '') return null;
      const choice = spec.choices?.find((candidate) => candidate.value === input);
      return choice && !choice.readOnly ? choice.value : refuse('choice_invalid');
    }
    case 'text': {
      if (typeof input !== 'string') return refuse('text_expected');
      const text = input.trim();
      if (text === '') return null;
      if (text.length > 1000 || /[\r\n]/.test(text)) return refuse('text_invalid');
      if (spec.pattern && !spec.pattern.test(text)) return refuse('format_invalid');
      return text;
    }
  }
}

function fileValue(spec: OptionSpec, value: Value): unknown {
  if (spec.write) return spec.write(value);
  if (spec.kind === 'choice') {
    return spec.choices?.find((choice) => choice.value === value)?.file ?? value;
  }
  return value;
}

/**
 * Writes one section's `values` (field key → value, `null` for Hermes's default) into the
 * profile's files, all or nothing: every value is checked before anything is written. Returns
 * the section as the files say afterwards.
 */
export function writeHermesSettings(
  home: string,
  isDefault: boolean,
  section: string,
  values: Record<string, unknown>,
): SettingsSection {
  if (!(HERMES_SECTION_KEYS as readonly string[]).includes(section)) {
    throw new HermesSettingError(section, 'section_unknown');
  }
  const planned: Array<[OptionSpec, Value | null]> = [];
  for (const [key, input] of Object.entries(values)) {
    const spec = HERMES_SETTING_OPTIONS.find(
      (candidate) => candidate.key === key && candidate.section === section,
    );
    if (!spec) throw new HermesSettingError(key, 'setting_unknown');
    planned.push([spec, validate(spec, input)]);
  }

  const doc = load(home);
  let fileChanged = false;
  for (const [spec, value] of planned) {
    if (spec.env) {
      const [primary, ...others] = spec.env;
      writeEnvValue(home, primary!, value === null ? null : String(value));
      // Another spelling left behind would still be read by somebody: it goes.
      for (const other of others) writeEnvValue(home, other, null);
      continue;
    }
    const places = spec.yaml ?? [];
    if (value === null) {
      for (const at of places) {
        if (plain(doc, at) !== undefined) {
          doc.deleteIn(at);
          fileChanged = true;
        }
      }
      continue;
    }
    const target = places[0]!;
    // A legacy spelling Hermes reads after the first one would come back on the next reset.
    for (const at of places.slice(1)) {
      if (plain(doc, at) !== undefined) doc.deleteIn(at);
    }
    ensureParents(doc, target);
    doc.setIn(target, fileNode(fileValue(spec, value)));
    fileChanged = true;
  }
  if (fileChanged) save(home, doc);
  return readHermesSettings(home, isDefault).find((candidate) => candidate.key === section)!;
}
