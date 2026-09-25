/**
 * A messaging channel's own settings in a Hermes profile: read and written where Hermes reads
 * each one. The engine is the platform-neutral half of what #97 built for Telegram; each
 * platform's table of options lives with the platform (`telegram-settings.ts`,
 * `channel-platforms.ts`).
 *
 * Hermes reads a channel option from up to three places, and each option says which:
 *
 * - the platform block, `platforms.<platform>.<key>` in the profile's `config.yaml` (Hermes copies
 *   every key that is not one of its typed ones into the adapter's `extra`; a key already under
 *   `platforms.<platform>.extra` wins over the same key beside it, and a root `<platform>:` block
 *   wins over both — `gateway/config.py` §PlatformConfig.from_dict, `gateway/config_loader.py`);
 * - the profile's display settings, `display.platforms.<platform>.<key>`, which fall back to the
 *   profile-wide `display.<key>` and then to Hermes's default for the platform
 *   (`gateway/display_config.py`) — written per platform, so they change that platform only;
 * - the profile's `.env`, for the options Hermes reads from the environment.
 *
 * Which of the file and the environment wins depends on the adapter. Telegram's reads the
 * environment first (the default); Discord's, Slack's, Matrix's and Mattermost's read
 * the adapter's `extra` — the file — first (`fileFirst`), then the environment. For those the value
 * is written to the file and, when the variable is also in `.env`, there too, so the two never
 * disagree. `shared` options are kept once for the profile and change every channel there.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Scalar, isMap, parseDocument, type Document } from 'yaml';
import { CONFIG_FILE } from './mcp.js';
import { ChannelError, readEnv, writeEnvValue } from './profile-env.js';

export type SettingSection = 'access' | 'replies' | 'groups' | 'media' | 'advanced';
export type SettingKind = 'toggle' | 'select' | 'number' | 'text' | 'list';
export type SettingValue = boolean | string | number | string[];

export interface OptionSpec {
  key: string;
  section: SettingSection;
  kind: SettingKind;
  /** Hermes's own default for the platform. */
  fallback: SettingValue | null;
  choices?: readonly string[];
  /** Words Hermes accepts for a choice, read as the choice they mean (`mentions` → `all`). */
  aliases?: Readonly<Record<string, string>>;
  min?: number;
  max?: number;
  /** A list's items, or a text's shape. */
  item?: RegExp;
  /** A text that must be a proxy address. */
  url?: boolean;
  shared?: boolean;
  /** Where Hermes reads it in `config.yaml`, highest precedence first; the last is where a new value goes. */
  yaml?: ReadonlyArray<readonly string[]>;
  /** The environment variable Hermes reads, if any. */
  env?: string;
  /** Kept in `.env` only (Hermes has no file key the hub should write for it). */
  envOnly?: boolean;
  /** The adapter reads the file before the environment (see the header). */
  fileFirst?: boolean;
  /** A profile-wide value this one falls back to while unset (`display.<key>`). */
  inherit?: readonly string[];
  /** The platform's home chat: Hermes keeps it as `{platform, chat_id, name}`. */
  home?: boolean;
}

/** `platforms.<platform>.<key>`, with the places that beat it first. */
export const platformKey = (platform: string, key: string) =>
  [
    [platform, key],
    ['platforms', platform, 'extra', key],
    ['platforms', platform, key],
  ] as const;
/** A key Hermes types itself (`enabled`, `reply_to_mode`, …): only the platform block counts. */
export const typedKey = (platform: string, key: string) => [['platforms', platform, key]] as const;
/** A display setting for this platform alone. */
export const displayKey = (platform: string, key: string) =>
  [['display', 'platforms', platform, key]] as const;
/** The platform's home chat id. */
export const homeKey = (platform: string) =>
  [['platforms', platform, 'home_channel', 'chat_id']] as const;

export interface ChannelSettingView {
  key: string;
  section: SettingSection;
  kind: SettingKind;
  value: SettingValue | null;
  default: SettingValue | null;
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
function nodeFor(doc: Document, spec: OptionSpec, value: SettingValue): unknown {
  if (Array.isArray(value)) return doc.createNode(value.map(quoted));
  if (typeof value === 'string' && (spec.item || YAML11_BOOLEAN.test(value))) return quoted(value);
  return value;
}

// ------------------------------------------------------------------ reading

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

/** A value as the option's kind has it, or `undefined` when it is not one. */
function coerce(spec: OptionSpec, raw: unknown): SettingValue | undefined {
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
      const meant = spec.aliases?.[text] ?? text;
      return spec.choices?.includes(meant) ? meant : undefined;
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
  let value: SettingValue | undefined;
  let source: 'config' | 'env' | null = null;
  const fromEnv = () => {
    if (value === undefined && spec.env && env[spec.env] !== undefined) {
      value = coerce(spec, env[spec.env]);
      if (value !== undefined) source = 'env';
    }
  };
  const fromFile = () => {
    if (value !== undefined || spec.envOnly) return;
    for (const at of spec.yaml ?? []) {
      value = coerce(spec, plain(doc, at));
      if (value !== undefined) {
        source = 'config';
        return;
      }
    }
  };
  if (spec.fileFirst) {
    fromFile();
    fromEnv();
  } else {
    fromEnv();
    fromFile();
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

export function readChannelSettings(
  home: string,
  options: readonly OptionSpec[],
): ChannelSettingView[] {
  const doc = load(home);
  const env = readEnv(home);
  return options.map((spec) => readOne(spec, doc, env));
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
function validate(spec: OptionSpec, input: unknown): SettingValue | null {
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
      if (spec.url && !/^(https?|socks5h?):\/\/\S+$/i.test(text)) return refuse('url_invalid');
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

function envText(value: SettingValue): string {
  return Array.isArray(value) ? value.join(',') : String(value);
}

/**
 * Writes `values` (option key → value, `null` to go back to the default) into the profile's
 * files, all or nothing: every value is checked before anything is written.
 */
export function writeChannelSettings(
  home: string,
  platform: string,
  options: readonly OptionSpec[],
  values: Record<string, unknown>,
): ChannelSettingView[] {
  const specs = new Map(options.map((spec) => [spec.key, spec]));
  const planned: Array<[OptionSpec, SettingValue | null]> = [];
  for (const [key, input] of Object.entries(values)) {
    const spec = specs.get(key);
    if (!spec) throw new SettingError(key, 'setting_unknown');
    planned.push([spec, validate(spec, input)]);
  }

  const doc = load(home);
  const env = readEnv(home);
  const homeChannel = ['platforms', platform, 'home_channel'];
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
      if (spec.home && doc.hasIn(homeChannel)) {
        doc.deleteIn(homeChannel);
        fileChanged = true;
      }
      continue;
    }
    if (spec.envOnly || (spec.env && inEnv && !spec.fileFirst)) {
      // The variable would win over the file anyway: it is where the value lives.
      writeEnvValue(home, spec.env!, value === '' ? null : envText(value));
      continue;
    }
    // The file wins for this adapter; a variable beside it is kept in step so they never disagree.
    if (spec.env && inEnv) writeEnvValue(home, spec.env, envText(value));
    const places = spec.yaml ?? [];
    const target = places.find((at) => doc.hasIn(at)) ?? places[places.length - 1]!;
    ensureParents(doc, target);
    if (spec.home) {
      // Hermes's shape for it (`/sethome` writes the same): the platform is required.
      doc.setIn([...homeChannel, 'platform'], platform);
      if (!doc.hasIn([...homeChannel, 'name'])) doc.setIn([...homeChannel, 'name'], 'Home');
    }
    doc.setIn(target, nodeFor(doc, spec, value));
    fileChanged = true;
  }
  if (fileChanged) save(home, doc);
  return readChannelSettings(home, options);
}
