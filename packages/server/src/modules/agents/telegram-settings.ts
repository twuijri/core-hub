/**
 * Telegram's own settings in a Hermes profile: every user-facing option Hermes has for it, read
 * and written where Hermes reads it.
 *
 * The owner, 2026-09-24: «التليجرام فيه خصائص كثيره … يطلع ثينكينج … في اكثر من شغله». Hermes
 * reads these from three places, and the table below says which for each option — observed in
 * Hermes's source (MIT, `/opt/hermes`), not guessed:
 *
 * - the platform block, `platforms.telegram.<key>` in the profile's `config.yaml` (Hermes copies
 *   every key that is not one of its typed ones into the adapter's `extra`; a key already under
 *   `platforms.telegram.extra` wins over the same key beside it, and a root `telegram:` block wins
 *   over both — `gateway/config.py` §PlatformConfig.from_dict, `gateway/config_loader.py`);
 * - the profile's display settings, `display.platforms.telegram.<key>`, which fall back to the
 *   profile-wide `display.<key>` and then to Hermes's Telegram default
 *   (`gateway/display_config.py`) — written per platform here, so they change Telegram only;
 * - the profile's `.env` for the options Hermes reads from the environment first
 *   (`TELEGRAM_REQUIRE_MENTION`, `TELEGRAM_ALLOWED_USERS`, …): when a variable is already there
 *   the value is changed there, since it would win over the file anyway.
 *
 * `shared` options (speech-to-text, voice replies) are kept once for the profile, not for
 * Telegram, and change every channel there. The file is edited in place like the MCP and channel
 * blocks, comments and the rest of the document untouched.
 *
 * Left out on purpose, and why: transport tuning (HTTP pool sizes and timeouts, text/media batch
 * delays, fallback IP discovery, typing cooldown); webhook mode (needs a public HTTPS address and
 * a published port the hub's image does not open — long polling works everywhere); a local Bot
 * API server (`base_url`, `local_mode`); structured maps that need an editor of their own
 * (per-chat prompts and model overrides, DM and group topics, wake-word patterns, topic id lists);
 * generic gateway routing (`notice_delivery`, `reply_in_thread`, session-per-user). And keys the
 * Telegram adapter never reads (`reply_prefix`, `send_read_receipts`, `typing_status_text`), or
 * that do not exist for it (a formatting choice: Hermes always sends MarkdownV2; image types and
 * size limits are fixed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Scalar, isMap, parseDocument, type Document } from 'yaml';
import { CONFIG_FILE } from './mcp.js';
import { ChannelError, readEnv, writeEnvValue } from './channels.js';

export type SettingSection = 'access' | 'replies' | 'groups' | 'media' | 'advanced';
export type SettingKind = 'toggle' | 'select' | 'number' | 'text' | 'list';
type Value = boolean | string | number | string[];

interface OptionSpec {
  key: string;
  section: SettingSection;
  kind: SettingKind;
  /** Hermes's own default for Telegram. */
  fallback: Value | null;
  choices?: readonly string[];
  min?: number;
  max?: number;
  /** A list's items (chat ids may be negative, user ids may not). */
  item?: RegExp;
  shared?: boolean;
  /** Where Hermes reads it in `config.yaml`, highest precedence first; the last is where a new value goes. */
  yaml?: ReadonlyArray<readonly string[]>;
  /** The environment variable Hermes reads first, if any. */
  env?: string;
  /** Kept in `.env` only (Hermes has no file key the hub should write for it). */
  envOnly?: boolean;
  /** A profile-wide value this one falls back to while unset (`display.<key>`). */
  inherit?: readonly string[];
}

/** `platforms.telegram.<key>`, with the places that beat it first. */
const platform = (key: string) =>
  [
    ['telegram', key],
    ['platforms', 'telegram', 'extra', key],
    ['platforms', 'telegram', key],
  ] as const;
/** A key Hermes types itself (`enabled`, `reply_to_mode`, …): only the platform block counts. */
const typed = (key: string) => [['platforms', 'telegram', key]] as const;
const display = (key: string) => [['display', 'platforms', 'telegram', key]] as const;

const CHAT_ID = /^-?[0-9]{1,20}$/;
const USER_ID = /^[0-9]{1,20}$/;

export const TELEGRAM_OPTIONS: readonly OptionSpec[] = [
  // ------------------------------------------------ who may message the bot
  {
    key: 'allowed_users',
    section: 'access',
    kind: 'list',
    fallback: [],
    item: USER_ID,
    env: 'TELEGRAM_ALLOWED_USERS',
    envOnly: true,
  },
  {
    key: 'unauthorized_dm_behavior',
    section: 'access',
    kind: 'select',
    fallback: 'pair',
    choices: ['pair', 'ignore'],
    yaml: typed('unauthorized_dm_behavior'),
  },
  // ------------------------------------------------ replies
  {
    key: 'show_reasoning',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: display('show_reasoning'),
    inherit: ['display', 'show_reasoning'],
  },
  {
    key: 'reasoning_style',
    section: 'replies',
    kind: 'select',
    fallback: 'code',
    choices: ['code', 'blockquote', 'subtext'],
    yaml: display('reasoning_style'),
    inherit: ['display', 'reasoning_style'],
  },
  {
    key: 'tool_progress',
    section: 'replies',
    kind: 'select',
    fallback: 'off',
    choices: ['off', 'new', 'all', 'verbose'],
    yaml: display('tool_progress'),
    inherit: ['display', 'tool_progress'],
  },
  {
    key: 'cleanup_progress',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: display('cleanup_progress'),
    inherit: ['display', 'cleanup_progress'],
  },
  {
    key: 'streaming',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: display('streaming'),
    // Unset, Telegram follows the profile's top-level `streaming.enabled` (display.streaming is
    // the terminal's, not the gateway's).
    inherit: ['streaming', 'enabled'],
  },
  {
    key: 'reply_to_mode',
    section: 'replies',
    kind: 'select',
    fallback: 'first',
    choices: ['off', 'first', 'all'],
    yaml: typed('reply_to_mode'),
    env: 'TELEGRAM_REPLY_TO_MODE',
  },
  {
    key: 'reactions',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: platform('reactions'),
    env: 'TELEGRAM_REACTIONS',
  },
  {
    key: 'typing_indicator',
    section: 'replies',
    kind: 'toggle',
    fallback: true,
    yaml: typed('typing_indicator'),
  },
  {
    key: 'disable_link_previews',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: platform('disable_link_previews'),
  },
  {
    key: 'notifications',
    section: 'replies',
    kind: 'select',
    fallback: 'important',
    choices: ['important', 'all'],
    yaml: display('notifications'),
    env: 'HERMES_TELEGRAM_NOTIFICATIONS',
  },
  // ------------------------------------------------ groups
  {
    key: 'require_mention',
    section: 'groups',
    kind: 'toggle',
    fallback: false,
    yaml: platform('require_mention'),
    env: 'TELEGRAM_REQUIRE_MENTION',
  },
  {
    key: 'allowed_chats',
    section: 'groups',
    kind: 'list',
    fallback: [],
    item: CHAT_ID,
    yaml: platform('allowed_chats'),
    env: 'TELEGRAM_ALLOWED_CHATS',
  },
  {
    key: 'free_response_chats',
    section: 'groups',
    kind: 'list',
    fallback: [],
    item: CHAT_ID,
    yaml: platform('free_response_chats'),
    env: 'TELEGRAM_FREE_RESPONSE_CHATS',
  },
  {
    key: 'group_allowed_users',
    section: 'groups',
    kind: 'list',
    fallback: [],
    item: USER_ID,
    env: 'TELEGRAM_GROUP_ALLOWED_USERS',
    envOnly: true,
  },
  {
    key: 'observe_unmentioned_group_messages',
    section: 'groups',
    kind: 'toggle',
    fallback: false,
    yaml: platform('observe_unmentioned_group_messages'),
    env: 'TELEGRAM_OBSERVE_UNMENTIONED_GROUP_MESSAGES',
  },
  {
    key: 'guest_mode',
    section: 'groups',
    kind: 'toggle',
    fallback: false,
    yaml: platform('guest_mode'),
    env: 'TELEGRAM_GUEST_MODE',
  },
  {
    key: 'exclusive_bot_mentions',
    section: 'groups',
    kind: 'toggle',
    fallback: true,
    yaml: platform('exclusive_bot_mentions'),
    env: 'TELEGRAM_EXCLUSIVE_BOT_MENTIONS',
  },
  {
    key: 'allow_bots',
    section: 'groups',
    kind: 'select',
    fallback: 'none',
    // Hermes also knows `mentions`, which it treats as `all` on Telegram.
    choices: ['none', 'all'],
    yaml: platform('allow_bots'),
    env: 'TELEGRAM_ALLOW_BOTS',
  },
  // ------------------------------------------------ media and voice (the profile's, every channel)
  {
    key: 'stt_enabled',
    section: 'media',
    kind: 'toggle',
    fallback: true,
    shared: true,
    yaml: [['stt', 'enabled']],
  },
  {
    key: 'stt_echo_transcripts',
    section: 'media',
    kind: 'toggle',
    fallback: true,
    shared: true,
    yaml: [['stt', 'echo_transcripts']],
  },
  {
    key: 'voice_auto_tts',
    section: 'media',
    kind: 'toggle',
    fallback: false,
    shared: true,
    yaml: [['voice', 'auto_tts']],
  },
  // ------------------------------------------------ advanced
  {
    key: 'home_channel',
    section: 'advanced',
    kind: 'text',
    fallback: null,
    item: CHAT_ID,
    yaml: [['platforms', 'telegram', 'home_channel', 'chat_id']],
    env: 'TELEGRAM_HOME_CHANNEL',
  },
  {
    key: 'gateway_restart_notification',
    section: 'advanced',
    kind: 'toggle',
    fallback: true,
    yaml: typed('gateway_restart_notification'),
  },
  {
    key: 'command_menu_max',
    section: 'advanced',
    kind: 'number',
    fallback: 60,
    min: 1,
    max: 100,
    // Hermes reads this one at this exact path only.
    yaml: [['platforms', 'telegram', 'extra', 'command_menu', 'max_commands']],
  },
  {
    key: 'proxy_url',
    section: 'advanced',
    kind: 'text',
    fallback: null,
    yaml: platform('proxy_url'),
    env: 'TELEGRAM_PROXY',
  },
];

export interface ChannelSettingView {
  key: string;
  section: SettingSection;
  kind: SettingKind;
  value: Value | null;
  default: Value | null;
  choices: string[] | null;
  min: number | null;
  max: number | null;
  shared: boolean;
  source: 'config' | 'env' | null;
}

// ------------------------------------------------------------------ the file

function load(home: string): Document {
  const file = path.join(home, CONFIG_FILE);
  if (!existsSync(file)) return parseDocument('');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new ChannelError('config_unreadable');
  return doc;
}

function save(home: string, doc: Document): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, CONFIG_FILE), doc.toString(), 'utf8');
}

function plain(doc: Document, at: readonly string[]): unknown {
  const node = doc.getIn(at, false);
  if (node === undefined || node === null) return undefined;
  return typeof node === 'object' && 'toJSON' in node
    ? (node as { toJSON(): unknown }).toJSON()
    : node;
}

/** Creates every map on the way to `at`'s parent that is not a map yet. */
function ensureParents(doc: Document, at: readonly string[]): void {
  for (let depth = 1; depth < at.length; depth += 1) {
    const prefix = at.slice(0, depth);
    if (!isMap(doc.getIn(prefix, true))) doc.setIn(prefix, doc.createNode({}));
  }
}

/** YAML 1.1 (Hermes's PyYAML) reads a bare `off`, `on`, `yes`, `no` as booleans: those are quoted. */
const YAML11_BOOLEAN = /^(y|n|yes|no|on|off|true|false)$/i;

function quoted(value: string): Scalar {
  const node = new Scalar(value);
  node.type = Scalar.QUOTE_SINGLE;
  return node;
}

/**
 * A value as the file should hold it. Ids stay strings (`'-1001234567890'`, not a number PyYAML
 * would hand Hermes as an int), and a word YAML 1.1 reads as a boolean is quoted.
 */
function nodeFor(doc: Document, spec: OptionSpec, value: Value): unknown {
  if (Array.isArray(value)) return doc.createNode(value.map(quoted));
  if (typeof value === 'string' && (spec.item || YAML11_BOOLEAN.test(value))) return quoted(value);
  return value;
}

// ------------------------------------------------------------------ reading

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

/** A value as the option's kind has it, or `undefined` when it is not one. */
function coerce(spec: OptionSpec, raw: unknown): Value | undefined {
  if (raw === undefined || raw === null) return undefined;
  switch (spec.kind) {
    case 'toggle': {
      if (typeof raw === 'boolean') return raw;
      const text = String(raw).trim().toLowerCase();
      if (TRUTHY.has(text)) return true;
      if (FALSY.has(text)) return false;
      return undefined;
    }
    case 'select': {
      // A bare `off` in the file is read back as `false` (Hermes normalises it the same way).
      const text = raw === false ? 'off' : raw === true ? 'on' : String(raw).trim().toLowerCase();
      if (spec.key === 'allow_bots' && text === 'mentions') return 'all';
      return spec.choices?.includes(text) ? text : undefined;
    }
    case 'number': {
      const number = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isInteger(number) ? number : undefined;
    }
    case 'list': {
      const items = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
      return items.map((item) => item.trim()).filter(Boolean);
    }
    case 'text': {
      const text = String(raw).trim();
      return text === '' ? undefined : text;
    }
  }
}

function readOne(spec: OptionSpec, doc: Document, env: Record<string, string>): ChannelSettingView {
  let value: Value | undefined;
  let source: 'config' | 'env' | null = null;
  if (spec.env && env[spec.env] !== undefined) {
    value = coerce(spec, env[spec.env]);
    if (value !== undefined) source = 'env';
  }
  if (value === undefined && !spec.envOnly) {
    for (const at of spec.yaml ?? []) {
      value = coerce(spec, plain(doc, at));
      if (value !== undefined) {
        source = 'config';
        break;
      }
    }
  }
  const inherited = spec.inherit ? coerce(spec, plain(doc, spec.inherit)) : undefined;
  return {
    key: spec.key,
    section: spec.section,
    kind: spec.kind,
    value: value ?? null,
    default: inherited ?? spec.fallback,
    choices: spec.choices ? [...spec.choices] : null,
    min: spec.min ?? null,
    max: spec.max ?? null,
    shared: spec.shared === true,
    source,
  };
}

export function readTelegramSettings(home: string): ChannelSettingView[] {
  const doc = load(home);
  const env = readEnv(home);
  return TELEGRAM_OPTIONS.map((spec) => readOne(spec, doc, env));
}

// ------------------------------------------------------------------ writing

export class SettingError extends Error {
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'SettingError';
  }
}

/** `input` checked against the option, or a `SettingError` naming why not. `null` resets. */
function validate(spec: OptionSpec, input: unknown): Value | null {
  if (input === null) return null;
  const refuse = (reason: string): never => {
    throw new SettingError(spec.key, reason);
  };
  switch (spec.kind) {
    case 'toggle':
      return typeof input === 'boolean' ? input : refuse('boolean_expected');
    case 'select':
      return typeof input === 'string' && spec.choices?.includes(input)
        ? input
        : refuse('choice_invalid');
    case 'number':
      return typeof input === 'number' &&
        Number.isInteger(input) &&
        (spec.min === undefined || input >= spec.min) &&
        (spec.max === undefined || input <= spec.max)
        ? input
        : refuse('number_invalid');
    case 'text': {
      if (typeof input !== 'string') return refuse('text_expected');
      const text = input.trim();
      if (text.length > 500 || /[\r\n]/.test(text)) return refuse('text_invalid');
      if (text === '') return null;
      if (spec.item && !spec.item.test(text)) return refuse('item_invalid');
      if (spec.key === 'proxy_url' && !/^(https?|socks5h?):\/\/\S+$/i.test(text)) {
        return refuse('url_invalid');
      }
      return text;
    }
    case 'list': {
      if (!Array.isArray(input) || input.length > 100) return refuse('list_expected');
      const items = [...new Set(input.map((item) => String(item).trim()).filter(Boolean))];
      if (items.some((item) => (spec.item ? !spec.item.test(item) : item.includes(',')))) {
        return refuse('item_invalid');
      }
      return items;
    }
  }
}

function envText(value: Value): string {
  return Array.isArray(value) ? value.join(',') : String(value);
}

/**
 * Writes `values` (option key → value, `null` to go back to the default) into the profile's
 * files, all or nothing: every value is checked before anything is written.
 */
export function writeTelegramSettings(
  home: string,
  values: Record<string, unknown>,
): ChannelSettingView[] {
  const specs = new Map(TELEGRAM_OPTIONS.map((spec) => [spec.key, spec]));
  const planned: Array<[OptionSpec, Value | null]> = [];
  for (const [key, input] of Object.entries(values)) {
    const spec = specs.get(key);
    if (!spec) throw new SettingError(key, 'setting_unknown');
    planned.push([spec, validate(spec, input)]);
  }

  const doc = load(home);
  const env = readEnv(home);
  let fileChanged = false;
  for (const [spec, value] of planned) {
    const inEnv = spec.env !== undefined && env[spec.env] !== undefined;
    if (value === null) {
      // Back to the default: gone from the file and from `.env`.
      if (spec.env && inEnv) writeEnvValue(home, spec.env, null);
      for (const at of spec.yaml ?? []) {
        if (doc.hasIn(at)) {
          doc.deleteIn(at);
          fileChanged = true;
        }
      }
      if (spec.key === 'home_channel' && doc.hasIn(['platforms', 'telegram', 'home_channel'])) {
        doc.deleteIn(['platforms', 'telegram', 'home_channel']);
        fileChanged = true;
      }
      continue;
    }
    if (spec.envOnly || (spec.env && inEnv)) {
      // The variable would win over the file anyway: it is where the value lives.
      writeEnvValue(home, spec.env!, value === '' ? null : envText(value));
      continue;
    }
    const places = spec.yaml ?? [];
    const target = places.find((at) => doc.hasIn(at)) ?? places[places.length - 1]!;
    ensureParents(doc, target);
    if (spec.key === 'home_channel') {
      // Hermes's shape for it (`/sethome` writes the same): the platform is required.
      doc.setIn(['platforms', 'telegram', 'home_channel', 'platform'], 'telegram');
      if (!doc.hasIn(['platforms', 'telegram', 'home_channel', 'name'])) {
        doc.setIn(['platforms', 'telegram', 'home_channel', 'name'], 'Home');
      }
    }
    doc.setIn(target, nodeFor(doc, spec, value));
    fileChanged = true;
  }
  if (fileChanged) save(home, doc);
  return readTelegramSettings(home);
}
