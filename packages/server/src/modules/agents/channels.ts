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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMap, parseDocument, type Document } from 'yaml';
import { CONFIG_FILE, STORED } from './mcp.js';

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
]);

export type FieldKind = 'secret' | 'boolean' | 'text';

export interface ChannelField {
  key: string;
  kind: FieldKind;
  /** `[stored]` for a credential that is set; the real value otherwise. */
  value: string | boolean | null;
}

export interface Channel {
  platform: string;
  enabled: boolean;
  /** True once anything beyond `enabled` has been filled in. */
  configured: boolean;
  exclusive: boolean;
  fields: ChannelField[];
}

export class ChannelError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ChannelError';
  }
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
  if (!block || typeof block !== 'object') return [];
  return Object.entries(block)
    .filter(([, node]) => node && typeof node === 'object')
    .map(([platform, node]) => {
      const fields = fieldsOf(node as Record<string, unknown>);
      return {
        platform,
        enabled: (node as { enabled?: unknown }).enabled !== false,
        // A node with nothing but `enabled` is a platform somebody turned on and never
        // told how to sign in; saying it is configured would be a lie the agent finds out.
        configured: fields.some((field) => field.value !== null && field.value !== ''),
        exclusive: (EXCLUSIVE as readonly string[]).includes(platform),
        fields,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
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
