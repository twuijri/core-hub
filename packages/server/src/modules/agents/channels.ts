/**
 * The messaging platforms an agent answers on: `config.yaml → platforms:`.
 *
 * Same file as the MCP servers and the same discipline — one node edited in place, the
 * rest of the document untouched (`mcp.ts` explains why in full).
 *
 * **The field list comes from the file, not from a table we wrote.** Hermes supports a
 * set of platforms that grows, each with its own keys, and a hub that shipped a form per
 * platform would be wrong for the next one and would drop the fields it had not heard of
 * when somebody saved. So a channel's fields are whatever keys are in its node, typed by
 * what they look like: a known credential name is a secret, a boolean is a switch, the
 * rest is text.
 *
 * **Seven platforms are exclusive**: one identity, one place. Telegram cannot be answered
 * by two agents at once because Telegram will not let two things long-poll one bot token,
 * so the list is marked rather than discovered by two agents fighting over it. The names
 * are the upstream adapters that take a platform lock — not a guess, and not extended by
 * guessing either.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isMap, parseDocument, type Document } from 'yaml';
import { CONFIG_FILE, STORED } from './mcp.js';
import { ChannelError, readEnv, writeEnvValue } from './profile-env.js';
import {
  PLATFORMS,
  credentialLink,
  credentialPlatform,
  credentialsPresent,
  unlinkCredentials,
  type PlatformSpec,
} from './channel-platforms.js';

export { ChannelError, readEnv, writeEnvValue };

const BLOCK = 'platforms';
const NAME = /^[a-z0-9_-]{1,40}$/;

/**
 * Platforms whose adapter holds a lock upstream: one agent may hold the identity.
 *
 * Derived from which `gateway/platforms/*.py` adapters acquire a platform lock — not from
 * a list somebody felt was right. Adding to it without checking there would make the hub
 * refuse something that works.
 */
export const EXCLUSIVE = [
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'signal',
  'weixin',
  'feishu',
] as const;

/** Key names that hold a credential inside a platform node (and inside its `extra`). */
const CREDENTIAL = new Set([
  'token',
  'bot_token',
  'app_token',
  'signing_secret',
  'app_secret',
  'client_secret',
  'access_token',
  'webhook_secret',
  'account_id',
  'phone_number_id',
  'app_id',
  'encrypt_key',
  'verification_token',
  'password',
  'secret',
  'api_key',
]);

export type FieldKind = 'secret' | 'boolean' | 'text';

export interface ChannelField {
  key: string;
  kind: FieldKind;
  /** `[stored]` for a credential that is set; the real value otherwise. */
  value: string | boolean | null;
}

/**
 * A platform that is linked rather than filled in: WhatsApp (a paired device — whether this
 * profile holds a session, and whose) and Telegram (a bot token — whether the profile has one,
 * and which bot).
 */
export interface ChannelLink {
  linked: boolean;
  accountId: string | null;
  accountName: string | null;
  accountPhone: string | null;
  /** Telegram: the bot's @username without the @. */
  accountUsername: string | null;
  /** WhatsApp: how Hermes uses the linked number (`whatsappMode`); null for every other platform. */
  mode: WhatsAppMode | null;
  /**
   * WhatsApp: the title of the header over the agent's replies in self-chat (`whatsappReplyTitle`);
   * null while the hub has not written one (Hermes's own header shows) and for every other platform.
   */
  replyTitle?: string | null;
}

export interface Channel {
  platform: string;
  enabled: boolean;
  /**
   * True once anything beyond `enabled` has been filled in — for WhatsApp, once a phone is
   * linked, because its identity is the bridge's session folder and not a field.
   */
  configured: boolean;
  exclusive: boolean;
  fields: ChannelField[];
  /** Set for WhatsApp (its session) and Telegram (its bot), read from the profile's own files. */
  link: ChannelLink | null;
}

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

function kindOf(key: string, value: unknown): FieldKind {
  if (CREDENTIAL.has(key)) return 'secret';
  if (typeof value === 'boolean') return 'boolean';
  return 'text';
}

/** Flatten `extra` into the field list, prefixed, so one form edits the whole node. */
function fieldsOf(node: Record<string, unknown>): ChannelField[] {
  const out: ChannelField[] = [];
  const add = (key: string, value: unknown, prefix = ''): void => {
    if (key === 'enabled') return; // The switch, not a field.
    const name = prefix ? `${prefix}.${key}` : key;
    const kind = kindOf(key, value);
    out.push({
      key: name,
      kind,
      value:
        kind === 'secret' && typeof value === 'string' && value !== ''
          ? STORED
          : typeof value === 'boolean' || typeof value === 'string'
            ? value
            : value === null || value === undefined
              ? null
              : JSON.stringify(value),
    });
  };
  for (const [key, value] of Object.entries(node)) {
    if (key === 'extra' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        add(inner, innerValue, 'extra');
      }
      continue;
    }
    add(key, value);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function listChannels(home: string): Channel[] {
  const block = load(home).toJS()?.[BLOCK] as Record<string, unknown> | undefined;
  const nodes: Record<string, Record<string, unknown>> = {};
  if (block && typeof block === 'object') {
    for (const [platform, node] of Object.entries(block)) {
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        nodes[platform] = node as Record<string, unknown>;
      }
    }
  }
  // WhatsApp needs no node to exist: Hermes's own pairing writes its switch to `.env`
  // (`WHATSAPP_ENABLED`) and its identity to the session folder. A profile paired that way
  // has a WhatsApp channel whether or not `config.yaml` names it.
  const whatsapp = whatsappLink(home);
  const env = readEnv(home);
  if (!nodes.whatsapp && (whatsapp.linked || env.WHATSAPP_ENABLED !== undefined)) {
    nodes.whatsapp = {};
  }
  // Telegram likewise: a bot token in `.env` is a Telegram channel whether or not the file
  // names it (Hermes enables the platform from the variable alone).
  const telegram = telegramLink(home, nodes.telegram, env);
  if (!nodes.telegram && telegram.linked) nodes.telegram = {};
  // And every platform linked by its variables (`channel-platforms.ts`).
  for (const spec of PLATFORMS) {
    if (spec.login === 'credentials' && !nodes[spec.platform] && credentialsPresent(spec, env)) {
      nodes[spec.platform] = {};
    }
  }
  return Object.entries(nodes)
    .map(([platform, node]) => {
      const fields = fieldsOf(node);
      if (platform === 'whatsapp') {
        return {
          platform,
          enabled: whatsappEnabled(node, env.WHATSAPP_ENABLED),
          configured: whatsapp.linked,
          exclusive: true,
          fields,
          link: {
            ...whatsapp,
            mode: whatsapp.linked ? whatsappMode(env) : null,
            replyTitle: whatsapp.linked ? whatsappReplyTitle(env) : null,
          },
        };
      }
      if (platform === 'telegram') {
        return {
          platform,
          enabled: telegramEnabled(node, env.TELEGRAM_BOT_TOKEN),
          configured: telegram.linked,
          exclusive: true,
          fields,
          link: telegram,
        };
      }
      // A node with nothing but `enabled` is a platform somebody turned on and never
      // told how to sign in; saying it is configured would be a lie the agent finds out.
      const filled = fields.some((field) => field.value !== null && field.value !== '');
      const spec = credentialPlatform(platform);
      if (spec) {
        const present = credentialsPresent(spec, env);
        const link = credentialLink(home, spec, env);
        // Signed in by hand in the file counts too (Hermes reads a `token` there); a setting does not.
        const signedIn = fields.some((field) => field.kind === 'secret' && field.value === STORED);
        return {
          platform,
          // Hermes's rule for a platform whose credentials are in the environment
          // (`gateway/config_env.py` §_enable_from_env): on unless the file says `enabled: false`.
          enabled: present ? node.enabled !== false : node.enabled !== false && signedIn,
          configured: present || signedIn,
          exclusive: spec.exclusive || (EXCLUSIVE as readonly string[]).includes(platform),
          fields,
          link: {
            linked: present || signedIn,
            accountId: link.accountId,
            accountName: link.accountName,
            accountPhone: null,
            accountUsername: link.accountUsername,
            mode: null,
          },
        };
      }
      return {
        platform,
        enabled: node.enabled !== false,
        configured: filled,
        exclusive: (EXCLUSIVE as readonly string[]).includes(platform),
        fields,
        link: null,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

/**
 * The channels a messaging gateway would actually serve in this profile: switched on and
 * able to sign in. A profile with none needs no gateway, and one is not started for it
 * (each is a Python process of about 200 MB).
 */
export function activeChannels(home: string): string[] {
  try {
    return listChannels(home)
      .filter((channel) => channel.enabled && channel.configured)
      .map((channel) => channel.platform);
  } catch {
    // A config.yaml nobody can parse is one Hermes cannot read either.
    return [];
  }
}

/**
 * Whether Hermes will start WhatsApp, by its own rule (`gateway/config_env.py` §_whatsapp):
 * `WHATSAPP_ENABLED=false` turns it off whatever the file says; `WHATSAPP_ENABLED=true` turns
 * it on unless the file says `enabled: false`; without the variable the file decides, and a
 * node that does not say `enabled: true` is off (`PlatformConfig.enabled` defaults to false).
 */
function whatsappEnabled(node: Record<string, unknown>, flag: string | undefined): boolean {
  const raw = (flag ?? '').trim().toLowerCase();
  if (['false', '0', 'no'].includes(raw)) return false;
  if (['true', '1', 'yes', 'on'].includes(raw)) return node.enabled !== false;
  return node.enabled === true;
}

// ------------------------------------------------------------------ WhatsApp session

/**
 * The folder Hermes keeps a profile's WhatsApp session in (`hermes_constants.get_hermes_dir
 * ("platforms/whatsapp/session", "whatsapp/session")`): the old `whatsapp/session` while it
 * still holds anything, else `platforms/whatsapp/session`.
 */
export function whatsappSessionDir(home: string): string {
  const legacy = path.join(home, 'whatsapp', 'session');
  return hasContent(legacy) ? legacy : path.join(home, 'platforms', 'whatsapp', 'session');
}

function hasContent(target: string): boolean {
  try {
    const info = statSync(target);
    return info.isDirectory() ? readdirSync(target).length > 0 : true;
  } catch {
    return false;
  }
}

/**
 * Whether a phone is linked in this profile, and whose, from the session's `creds.json` — the
 * same reading Hermes's onboarding does (`_whatsapp_linked_account_from_session`): the account
 * is under `me` (or `account`), its id is `id`/`jid`/`lid`, its name the first of `name`,
 * `verifiedName`, `notify`, `pushName`, and the phone is the digits before `@` and `:`.
 */
export function whatsappLink(home: string): ChannelLink {
  const file = path.join(whatsappSessionDir(home), 'creds.json');
  if (!existsSync(file)) return UNLINKED;
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
  } catch {
    // A session file the bridge is halfway through writing is still a linked session.
  }
  const candidates = [payload.me, payload.account, payload];
  const first = (keys: readonly string[]): string | null => {
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      for (const key of keys) {
        const value = (candidate as Record<string, unknown>)[key];
        const text = value === null || value === undefined ? '' : String(value).trim();
        if (text) return text;
      }
    }
    return null;
  };
  const accountId = first(['id', 'jid', 'lid']);
  const digits = accountId ? accountId.split('@')[0]!.split(':')[0]!.replace(/\D+/g, '') : '';
  return {
    linked: true,
    accountId,
    accountName: first(['name', 'verifiedName', 'notify', 'pushName']),
    accountPhone: digits || null,
    accountUsername: null,
    mode: null,
  };
}

const UNLINKED: ChannelLink = {
  linked: false,
  accountId: null,
  accountName: null,
  accountPhone: null,
  accountUsername: null,
  mode: null,
};

// ------------------------------------------------------------------ WhatsApp mode

/**
 * How Hermes uses a linked WhatsApp number — the profile's `WHATSAPP_MODE`, read by Hermes's
 * adapter and passed to its bridge (`plugins/platforms/whatsapp/adapter.py` §_bridge_env,
 * `scripts/whatsapp-bridge/bridge.js`; Hermes v2026.9.14, MIT), described here in our words:
 *
 * - `bot`: a number dedicated to the agent. Other people message it; with the DM policy
 *   `pairing` a sender nobody approved gets a pairing code. What the account owner types from
 *   the phone itself is dropped (it would be the agent's own number talking).
 * - `self-chat`: the person's own number. Only messages the account owner writes in their own
 *   "Message yourself" chat reach the agent, and it answers there with a short signature so the
 *   two sides can be told apart. Messages from anybody else are dropped by the bridge before
 *   Hermes sees them, so nobody else is answered or sent a pairing code.
 */
export const WHATSAPP_MODES = ['bot', 'self-chat'] as const;
export type WhatsAppMode = (typeof WHATSAPP_MODES)[number];

/** Hermes's rule: `bot` or `self-chat` as written; nothing written is `self-chat` (its default). */
export function whatsappMode(env: Record<string, string>): WhatsAppMode | null {
  const raw = (env.WHATSAPP_MODE ?? '').trim().toLowerCase();
  if (raw === '') return 'self-chat';
  return (WHATSAPP_MODES as readonly string[]).includes(raw) ? (raw as WhatsAppMode) : null;
}

/**
 * `WHATSAPP_ALLOWED_USERS` with the account owner in it. In `self-chat` the owner writes to
 * themselves, and Hermes's gateway still asks whether the sender may talk to the agent: an owner
 * missing from the list would be treated as a stranger and sent a pairing code in their own chat.
 * Hermes's own onboarding adds the linked number for the same reason
 * (`hermes_cli/web_routers/messaging.py` §apply_whatsapp_onboarding). Whoever else is on the list
 * stays, in the order written; `*` (everybody) already includes the owner.
 */
export function withAllowedOwner(existing: string | undefined, owner: string): string {
  const entries = (existing ?? '')
    .split(',')
    .map((entry) => entry.replace(/\s+/g, ''))
    .filter(Boolean);
  const bare = (entry: string) => entry.replace(/^\+/, '');
  if (entries.includes('*') || entries.some((entry) => bare(entry) === bare(owner))) {
    return entries.join(',');
  }
  return [...entries, owner].join(',');
}

/** The linked account as Hermes's allowlist names it: the phone's digits, else its id. */
export function whatsappOwner(link: ChannelLink): string | null {
  return link.accountPhone ?? link.accountId ?? null;
}

/**
 * Switches how the linked number is used. The phone stays linked; only `.env` changes. The
 * caller holds the gateway that serves the profile down while this runs and starts it again
 * (Hermes reads the mode when its bridge starts).
 */
export function setWhatsAppMode(home: string, mode: WhatsAppMode): Channel {
  if (!(WHATSAPP_MODES as readonly string[]).includes(mode)) {
    throw new ChannelError('channel_mode_invalid');
  }
  const link = whatsappLink(home);
  if (!link.linked) throw new ChannelError('channel_not_linked');
  writeEnvValue(home, 'WHATSAPP_MODE', mode);
  const owner = whatsappOwner(link);
  if (mode === 'self-chat' && owner) {
    writeEnvValue(
      home,
      'WHATSAPP_ALLOWED_USERS',
      withAllowedOwner(readEnv(home).WHATSAPP_ALLOWED_USERS, owner),
    );
  }
  const written = getChannel(home, 'whatsapp');
  if (!written) throw new ChannelError('channel_write_failed');
  return written;
}

// ------------------------------------------------------------------ WhatsApp reply header

/**
 * The header over the agent's replies in self-chat. The owner and the agent write from one number
 * there, so Hermes's WhatsApp bridge puts a header over every reply: its own is «☤ *Hermes Agent*»
 * over a rule, and `WHATSAPP_REPLY_PREFIX` in the profile's `.env` replaces it
 * (`gateway/platforms/whatsapp_common.py` §_effective_reply_prefix, `scripts/whatsapp-bridge/bridge.js`
 * §formatOutgoingMessage; Hermes v2026.9.14, MIT). A written `\n` is a line break to both. In `bot`
 * mode the bridge sends no header at all.
 *
 * The hub writes the same shape with another title: `*<title>*`, the rule, a line break. It never
 * writes an empty value: Hermes's Python side reads empty as "no header", but its adapter drops an
 * empty variable before starting the bridge, and the bridge then sends Hermes's own header (seen on
 * the real Hermes, `whatsapp-reply-header.real.test.ts`).
 */
export const REPLY_RULE = '────────────';
export const REPLY_TITLE_MAX = 64;

/** `WHATSAPP_REPLY_PREFIX` for a title, as `.env` holds it (the line breaks written `\n`). */
export function replyPrefixFor(title: string): string {
  return `*${title}*\\n${REPLY_RULE}\\n`;
}

/**
 * The title of the header the profile's replies carry, or null for Hermes's own — nothing written,
 * or an empty value (the bridge sends Hermes's header for that too). A prefix the hub did not write
 * reads as its text on one line.
 */
export function whatsappReplyTitle(env: Record<string, string>): string | null {
  const raw = env.WHATSAPP_REPLY_PREFIX;
  if (raw === undefined) return null;
  const text = raw.replace(/\\n/g, '\n');
  if (text.trim() === '') return null;
  const ours = /^\*([^\n]+)\*\n─+\n?$/.exec(text);
  if (ours) return ours[1]!;
  return text.replace(/─+/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

/** A title as a person typed it: one line, trimmed; null when there is nothing left or too much. */
export function cleanReplyTitle(title: string): string | null {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (clean === '' || [...clean].length > REPLY_TITLE_MAX) return null;
  return clean;
}

/** Writes the header's title. The caller has the gateway serving the profile follow. */
export function setWhatsAppReplyTitle(home: string, title: string): Channel {
  const clean = cleanReplyTitle(title);
  if (!clean) throw new ChannelError('channel_reply_title_invalid');
  if (!whatsappLink(home).linked) throw new ChannelError('channel_not_linked');
  writeEnvValue(home, 'WHATSAPP_REPLY_PREFIX', replyPrefixFor(clean));
  const written = getChannel(home, 'whatsapp');
  if (!written) throw new ChannelError('channel_write_failed');
  return written;
}

/**
 * The agent's name over its replies where nothing was written yet — when a number is linked or
 * switched to self-chat. What is already there (a title, or a value somebody wrote by hand) stays;
 * nothing is rewritten when the hub starts.
 */
export function defaultReplyTitle(home: string, agentName: string): void {
  if (readEnv(home).WHATSAPP_REPLY_PREFIX !== undefined) return;
  const clean = cleanReplyTitle(agentName);
  if (clean) writeEnvValue(home, 'WHATSAPP_REPLY_PREFIX', replyPrefixFor(clean));
}

// ------------------------------------------------------------------ Telegram bot

/**
 * The shape Hermes itself accepts for a bot token (`hermes_cli/setup_platforms.py`
 * §_TELEGRAM_BOT_TOKEN_RE): the bot's numeric id, a colon, and 30 or more URL-safe characters.
 */
export const TELEGRAM_TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;

/** The bot a linked token belongs to, as Telegram answered `getMe` when it was linked. */
export interface TelegramBot {
  id: string;
  username: string | null;
  name: string | null;
}

/**
 * Where the hub keeps what Telegram said about the profile's bot, beside the rest of Hermes's
 * per-platform state. Not Hermes's file and not read by Hermes: it only lets the page name the
 * bot without asking Telegram on every read.
 */
function telegramBotNote(home: string): string {
  return path.join(home, 'platforms', 'telegram', 'hub-bot.json');
}

/** The profile's bot token: `.env` first (Hermes's environment wins), then the file's `token`. */
export function telegramToken(
  home: string,
  node?: Record<string, unknown>,
  env: Record<string, string> = readEnv(home),
): string | null {
  const fromEnv = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  let block = node;
  if (block === undefined) {
    try {
      block = load(home).toJS()?.[BLOCK]?.telegram as Record<string, unknown> | undefined;
    } catch {
      block = undefined;
    }
  }
  const fromFile = typeof block?.token === 'string' ? block.token.trim() : '';
  return fromFile || null;
}

/**
 * Whether this profile has a bot, and which. The id is the token's own prefix, so a token
 * somebody replaced by hand is never named after the bot it replaced: the note is used only
 * while its id matches.
 */
export function telegramLink(
  home: string,
  node?: Record<string, unknown>,
  env: Record<string, string> = readEnv(home),
): ChannelLink {
  const token = telegramToken(home, node, env);
  if (!token) return UNLINKED;
  const id = token.split(':')[0] ?? '';
  let bot: Partial<TelegramBot> = {};
  try {
    const parsed = JSON.parse(readFileSync(telegramBotNote(home), 'utf8')) as Partial<TelegramBot>;
    if (parsed && String(parsed.id) === id) bot = parsed;
  } catch {
    // No note (linked by hand, or before the hub named bots): linked, name unknown.
  }
  return {
    linked: true,
    accountId: /^\d+$/.test(id) ? id : null,
    accountName: typeof bot.name === 'string' && bot.name ? bot.name : null,
    accountPhone: null,
    accountUsername: typeof bot.username === 'string' && bot.username ? bot.username : null,
    mode: null,
  };
}

/**
 * Hermes's rule for Telegram (`gateway/config_env.py`, `_Cred` + §_enable_from_env): a token in
 * the environment switches the platform on unless the file says `enabled: false`; without it the
 * file decides, and a node that does not say `enabled: true` is off.
 */
function telegramEnabled(node: Record<string, unknown>, envToken: string | undefined): boolean {
  if ((envToken ?? '').trim()) return node.enabled !== false;
  return node.enabled === true;
}

/**
 * Links a bot to this profile: the token into the profile's own `.env` (never the file, never a
 * client), the allowed users beside it when given, and the channel switched on with pairing for
 * unknown senders — Hermes's `unauthorized_dm_behavior: pair` for the platform, which also keeps
 * pairing on when an allowlist is set (Hermes would otherwise ignore strangers silently then).
 * A token written into `platforms.telegram.token` by hand is removed, so there is one.
 */
export function linkTelegram(
  home: string,
  input: { token: string; bot: TelegramBot; allowedUsers?: readonly string[] | undefined },
): Channel {
  writeEnvValue(home, 'TELEGRAM_BOT_TOKEN', input.token);
  if (input.allowedUsers !== undefined) {
    writeEnvValue(
      home,
      'TELEGRAM_ALLOWED_USERS',
      input.allowedUsers.length > 0 ? input.allowedUsers.join(',') : null,
    );
  }
  const doc = load(home);
  ensureMap(doc, [BLOCK, 'telegram']);
  if (doc.hasIn([BLOCK, 'telegram', 'token'])) doc.deleteIn([BLOCK, 'telegram', 'token']);
  doc.setIn([BLOCK, 'telegram', 'enabled'], true);
  doc.setIn([BLOCK, 'telegram', 'unauthorized_dm_behavior'], 'pair');
  save(home, doc);
  const note = telegramBotNote(home);
  mkdirSync(path.dirname(note), { recursive: true });
  writeFileSync(note, `${JSON.stringify(input.bot, null, 2)}\n`, { mode: 0o600 });
  const written = getChannel(home, 'telegram');
  if (!written) throw new ChannelError('channel_write_failed');
  return written;
}

/**
 * Forgets the bot in this profile: the token out of `.env` and the file, the note deleted, the
 * channel switched off. The allowed users and every setting stay, so linking again is linking
 * again. The bot itself still exists in Telegram; @BotFather deletes bots.
 */
export function unlinkTelegram(home: string): Channel {
  writeEnvValue(home, 'TELEGRAM_BOT_TOKEN', null);
  rmSync(telegramBotNote(home), { force: true });
  const doc = load(home);
  ensureMap(doc, [BLOCK, 'telegram']);
  if (doc.hasIn([BLOCK, 'telegram', 'token'])) doc.deleteIn([BLOCK, 'telegram', 'token']);
  doc.setIn([BLOCK, 'telegram', 'enabled'], false);
  save(home, doc);
  const written = getChannel(home, 'telegram');
  if (!written) throw new ChannelError('channel_write_failed');
  return written;
}

export function getChannel(home: string, platform: string): Channel | null {
  return listChannels(home).find((channel) => channel.platform === platform) ?? null;
}

export interface ChannelWrite {
  enabled?: boolean | undefined;
  /** Flat keys as the listing gave them, `extra.` prefixes included. */
  values?: Record<string, unknown> | undefined;
}

/** Create the node at `path` as a map when it is not one already. */
function ensureMap(doc: Document, path: Array<string>): void {
  if (isMap(doc.getIn(path, true))) return;
  doc.setIn(path, doc.createNode({}));
}

/** `extra.foo` → `['platforms', 'telegram', 'extra', 'foo']`. */
function pathFor(platform: string, key: string): Array<string> {
  return key.startsWith('extra.')
    ? [BLOCK, platform, 'extra', key.slice('extra.'.length)]
    : [BLOCK, platform, key];
}

/**
 * Write the keys that changed, one at a time.
 *
 * Replacing the whole node would work and would re-quote every value in it — `'9911'`
 * becoming `"9911"` for no reason anybody asked for. Editing the keys leaves the rest of
 * the node exactly as the person wrote it, which is the same promise the rest of the
 * document already gets.
 */
export function putChannel(home: string, platform: string, input: ChannelWrite): Channel {
  if (!NAME.test(platform)) throw new ChannelError('channel_name_invalid');
  const doc = load(home);
  const values = input.values ?? {};
  // A container has to exist as a real map before a key can be set inside it — a plain
  // `{}` is a scalar to this library, and descending into one throws.
  ensureMap(doc, [BLOCK, platform]);
  if (Object.keys(values).some((key) => key.startsWith('extra.')))
    ensureMap(doc, [BLOCK, platform, 'extra']);

  for (const [key, value] of Object.entries(values)) {
    // `[stored]` means "keep the one that is there": writing the mask would put the word
    // where the credential was and break the channel at the next start.
    if (value === STORED) continue;
    doc.setIn(pathFor(platform, key), value);
  }
  if (input.enabled !== undefined) doc.setIn([BLOCK, platform, 'enabled'], input.enabled);

  save(home, doc);
  // WhatsApp's switch has a second half in `.env`, and `WHATSAPP_ENABLED=false` there beats
  // the file (`whatsappEnabled`). Switching it on here must not be silently undone by it.
  if (platform === 'whatsapp' && input.enabled === true) {
    const flag = (readEnv(home).WHATSAPP_ENABLED ?? '').trim().toLowerCase();
    if (['false', '0', 'no'].includes(flag)) writeEnvValue(home, 'WHATSAPP_ENABLED', 'true');
  }
  const written = getChannel(home, platform);
  if (!written) throw new ChannelError('channel_write_failed');
  return written;
}

/**
 * Forget the identity, keep the platform.
 *
 * The credentials are removed and the channel is switched off; the node stays, because
 * the other settings a person tuned are not what they asked to clear.
 */
export function clearChannel(home: string, platform: string): Channel {
  if (!NAME.test(platform)) throw new ChannelError('channel_name_invalid');
  const doc = load(home);
  const existing = doc.toJS()?.[BLOCK]?.[platform] as Record<string, unknown> | undefined;
  if (!existing) throw new ChannelError('channel_not_found');

  for (const key of Object.keys(existing)) {
    if (CREDENTIAL.has(key)) doc.deleteIn([BLOCK, platform, key]);
  }
  const extra = existing.extra;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const key of Object.keys(extra as Record<string, unknown>)) {
      if (CREDENTIAL.has(key)) doc.deleteIn([BLOCK, platform, 'extra', key]);
    }
  }
  doc.setIn([BLOCK, platform, 'enabled'], false);

  save(home, doc);
  const written = getChannel(home, platform);
  if (!written) throw new ChannelError('channel_write_failed');
  return written;
}

/**
 * Forget a linked WhatsApp in this profile: the session folder is deleted (the phone's
 * identity lives there and nowhere else), the channel is switched off in both places Hermes
 * reads (`platforms.whatsapp.enabled: false`, and `WHATSAPP_ENABLED` removed from `.env`).
 * What the person tuned stays — the bridge port, the approved senders — so pairing again is
 * pairing again and not setting up from scratch.
 *
 * The caller stops whatever gateway runs the bridge first: a bridge still running holds the
 * session in memory and would write it back.
 */
export function unlinkWhatsApp(home: string): Channel {
  for (const dir of [
    path.join(home, 'whatsapp', 'session'),
    path.join(home, 'platforms', 'whatsapp', 'session'),
  ]) {
    rmSync(dir, { recursive: true, force: true });
  }
  const doc = load(home);
  ensureMap(doc, [BLOCK, 'whatsapp']);
  doc.setIn([BLOCK, 'whatsapp', 'enabled'], false);
  save(home, doc);
  writeEnvValue(home, 'WHATSAPP_ENABLED', null);
  const written = getChannel(home, 'whatsapp');
  if (!written) throw new ChannelError('channel_write_failed');
  return written;
}

// ------------------------------------------------------------------ linked by credentials

/**
 * Forgets a platform linked by its variables: they leave `.env` (`unlinkCredentials`), a
 * credential written into the file by hand leaves the file, and the channel is switched off. The
 * allowlist and the settings stay.
 */
export function unlinkPlatform(home: string, spec: PlatformSpec): Channel {
  unlinkCredentials(home, spec);
  const doc = load(home);
  const node = doc.toJS()?.[BLOCK]?.[spec.platform] as Record<string, unknown> | undefined;
  if (node) {
    for (const key of Object.keys(node)) {
      if (CREDENTIAL.has(key)) doc.deleteIn([BLOCK, spec.platform, key]);
    }
    const extra = node.extra;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      for (const key of Object.keys(extra as Record<string, unknown>)) {
        if (CREDENTIAL.has(key)) doc.deleteIn([BLOCK, spec.platform, 'extra', key]);
      }
    }
    save(home, doc);
  }
  const written = getChannel(home, spec.platform);
  if (!written) throw new ChannelError('channel_write_failed');
  return written;
}

// ------------------------------------------------------------------ bridge port

/** Hermes's WhatsApp bridge listens here unless told otherwise (`adapter.py`, `bridge_port`). */
export const WHATSAPP_BRIDGE_PORT = 3000;
/** Where the hub finds a port for a second profile's bridge. */
export const WHATSAPP_BRIDGE_PORTS = { first: 3001, last: 3999 } as const;

/** The port a profile's WhatsApp bridge would listen on: `extra.bridge_port`, then `bridge_port`. */
export function whatsappBridgePort(home: string): number {
  let node: Record<string, unknown> | undefined;
  try {
    node = load(home).toJS()?.[BLOCK]?.whatsapp as Record<string, unknown> | undefined;
  } catch {
    return WHATSAPP_BRIDGE_PORT;
  }
  const extra = node?.extra as Record<string, unknown> | undefined;
  const raw =
    (extra && typeof extra === 'object' ? extra.bridge_port : undefined) ?? node?.bridge_port;
  const port = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : WHATSAPP_BRIDGE_PORT;
}

/**
 * Gives `home`'s WhatsApp bridge a port no other profile's bridge uses, and returns it.
 *
 * Two gateways side by side each start their own bridge, and Hermes's bridge takes port 3000
 * unless told otherwise. On one port the second gateway either **adopts the first profile's
 * bridge** — answering one profile's contacts from the other's phone — or kills it to take the
 * port (`adapter.py` §_reuse_running_bridge, §_kill_port_process). So every profile but the
 * default gets its own `platforms.whatsapp.bridge_port`, written once and kept; one somebody
 * set by hand is kept as long as nobody else has it.
 */
export function ensureWhatsAppBridgePort(home: string, others: readonly string[]): number {
  const taken = new Set(others.map((other) => whatsappBridgePort(other)));
  taken.add(WHATSAPP_BRIDGE_PORT);
  const current = whatsappBridgePort(home);
  if (!taken.has(current)) return current;
  for (let port = WHATSAPP_BRIDGE_PORTS.first; port <= WHATSAPP_BRIDGE_PORTS.last; port += 1) {
    if (taken.has(port)) continue;
    const doc = load(home);
    ensureMap(doc, [BLOCK, 'whatsapp']);
    const extra = doc.getIn([BLOCK, 'whatsapp', 'extra']);
    if (isMap(extra) && extra.has('bridge_port'))
      doc.setIn([BLOCK, 'whatsapp', 'extra', 'bridge_port'], port);
    else doc.setIn([BLOCK, 'whatsapp', 'bridge_port'], port);
    save(home, doc);
    return port;
  }
  throw new ChannelError('no_bridge_port_free');
}
