/**
 * The messaging platforms the hub links for a Hermes profile, each declared once: the variables it
 * takes, whether the hub can ask the platform about them, how strangers are treated, its settings,
 * and where Hermes's library for it comes from.
 *
 * #97 built this for Telegram by hand; the owner then asked for «more messaging platforms, like
 * Telegram». Every entry below was observed in Hermes's own adapters (MIT, `/opt/hermes`, the
 * pinned v2026.9.14) and is written in our words, ADR 0012:
 *
 * - **the variables** are the ones Hermes's environment pass reads to switch a platform on
 *   (`gateway/config_env.py` §_ENV_STEPS, each `_Cred`), plus the ones its plugin declares
 *   (`plugins/platforms/<name>/plugin.yaml`, `requires_env` / `optional_env`). A platform switches
 *   on when its credentials are in the environment unless `config.yaml` says `enabled: false`;
 * - **strangers**: Hermes's gateway answers an unknown sender with a pairing code
 *   (`gateway/authz_mixin.py`), unless the adapter drops them before the gateway sees them.
 *   Discord's does (`_is_allowed_user`: nobody without an allowlist, a role or a channel) and so does
 *   Email's (`_sender_accepted`: only the allowlist, and Hermes defaults email to "ignore" anyway).
 *   Those two say `allowlist: true` and the dialog asks for the people up front;
 * - **packages**: `tools/lazy_deps.py` lists what Hermes downloads the first time a platform runs.
 *   Telegram's, Discord's and Slack's are in the image (`packages/server/Dockerfile`); Matrix's are
 *   not — they did not fit in the image-size budget (the change record has the numbers);
 *   Mattermost and Email need nothing beyond Hermes (aiohttp, the standard library).
 *
 * `full` platforms get a dialog, a check with the platform, a named linked state and settings;
 * `generic` ones get a form of their declared variables, stored unchecked.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMap, parseDocument, type Document } from 'yaml';
import { displayKey, homeKey, platformKey, typedKey, type OptionSpec } from './channel-settings.js';
import { CONFIG_FILE } from './mcp.js';
import { ChannelError, readEnv, writeEnvValue } from './profile-env.js';

export type CredentialKind = 'secret' | 'text' | 'url' | 'email' | 'host' | 'number';

export interface CredentialSpec {
  /** The environment variable Hermes reads. */
  key: string;
  kind: CredentialKind;
  required: boolean;
  /** The shape Hermes (or the platform) needs, checked before anything is asked or stored. */
  pattern?: RegExp;
}

export interface PlatformSpec {
  platform: string;
  label: string;
  support: 'full' | 'generic';
  login: 'qr' | 'token' | 'credentials';
  credentials: readonly CredentialSpec[];
  /** The allowlist variable `allowed_users` goes to, and the shape of one entry. */
  allowedUsers: { key: string; item: RegExp } | null;
  validates: boolean;
  /**
   * The hub switches pairing on when it links the platform (`unauthorized_dm_behavior: pair`), so a
   * stranger gets a code to approve. False where Hermes's adapter drops strangers, and for the
   * generic platforms, whose strangers are left to Hermes's own default.
   */
  pairs: boolean;
  /** Nobody gets in until the allowlist names them. */
  allowlist: boolean;
  exclusive: boolean;
  packages: 'image' | 'first_use' | 'none';
  /** Receives on a webhook: needs an address the internet can reach. */
  inbound: boolean;
  docsUrl: string | null;
  settings: readonly OptionSpec[] | null;
}

const secret = (key: string, required = true, pattern?: RegExp): CredentialSpec => ({
  key,
  kind: 'secret',
  required,
  ...(pattern ? { pattern } : {}),
});
const field = (
  key: string,
  kind: CredentialKind,
  required = true,
  pattern?: RegExp,
): CredentialSpec => ({ key, kind, required, ...(pattern ? { pattern } : {}) });

const HTTP_URL = /^https?:\/\/[^\s/]+(?::\d+)?(?:\/\S*)?$/i;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const PORT = /^[0-9]{1,5}$/;
const EMAIL = /^[^\s@,]{1,200}@[^\s@,]{1,200}$/;
/** An allowlist entry as a person types one: anything but a comma or white space. */
const ENTRY = /^[^,\s]{1,320}$/;
const DIGITS = /^[0-9]{1,20}$/;

// ------------------------------------------------------------------ settings, per platform

/**
 * The options every full platform has in common, keyed the same everywhere: show the model's
 * thinking and what the agent is doing (`display.platforms.<platform>.*`, Hermes's per-platform
 * default otherwise), and the home chat where scheduled results and notices go.
 */
function displayOptions(platform: string, toolProgress: string): OptionSpec[] {
  return [
    {
      key: 'show_reasoning',
      section: 'replies',
      kind: 'toggle',
      fallback: false,
      yaml: displayKey(platform, 'show_reasoning'),
      inherit: ['display', 'show_reasoning'],
    },
    {
      key: 'tool_progress',
      section: 'replies',
      kind: 'select',
      fallback: toolProgress,
      choices: ['off', 'new', 'all', 'verbose'],
      yaml: displayKey(platform, 'tool_progress'),
      inherit: ['display', 'tool_progress'],
    },
  ];
}

function homeOption(platform: string, env: string, item: RegExp = ENTRY): OptionSpec {
  return {
    key: 'home_channel',
    section: 'advanced',
    kind: 'text',
    fallback: null,
    item,
    yaml: homeKey(platform),
    env,
    home: true,
  };
}

function allowedOption(env: string, item: RegExp): OptionSpec {
  return {
    key: 'allowed_users',
    section: 'access',
    kind: 'list',
    fallback: [],
    item,
    env,
    envOnly: true,
  };
}

function strangersOption(platform: string): OptionSpec {
  return {
    key: 'unauthorized_dm_behavior',
    section: 'access',
    kind: 'select',
    fallback: 'pair',
    choices: ['pair', 'ignore'],
    yaml: typedKey(platform, 'unauthorized_dm_behavior'),
  };
}

/** A switch the adapter reads from its `extra` first, then its variable. */
function flag(
  platform: string,
  key: string,
  section: OptionSpec['section'],
  fallback: boolean,
  env?: string,
): OptionSpec {
  return {
    key,
    section,
    kind: 'toggle',
    fallback,
    yaml: platformKey(platform, key),
    ...(env ? { env } : {}),
    fileFirst: true,
  };
}

/** A list of channel or room ids the adapter reads from its `extra` first, then its variable. */
function ids(platform: string, key: string, env?: string): OptionSpec {
  return {
    key,
    section: 'groups',
    kind: 'list',
    fallback: [],
    item: ENTRY,
    yaml: platformKey(platform, key),
    ...(env ? { env } : {}),
    fileFirst: true,
  };
}

const DISCORD_OPTIONS: readonly OptionSpec[] = [
  allowedOption('DISCORD_ALLOWED_USERS', ENTRY),
  {
    key: 'allowed_roles',
    section: 'access',
    kind: 'list',
    fallback: [],
    item: DIGITS,
    env: 'DISCORD_ALLOWED_ROLES',
    envOnly: true,
  },
  ...displayOptions('discord', 'all'),
  {
    key: 'reply_to_mode',
    section: 'replies',
    kind: 'select',
    fallback: 'first',
    choices: ['off', 'first', 'all'],
    yaml: typedKey('discord', 'reply_to_mode'),
    env: 'DISCORD_REPLY_TO_MODE',
  },
  flag('discord', 'reactions', 'replies', true, 'DISCORD_REACTIONS'),
  flag('discord', 'require_mention', 'groups', true, 'DISCORD_REQUIRE_MENTION'),
  ids('discord', 'free_response_channels', 'DISCORD_FREE_RESPONSE_CHANNELS'),
  ids('discord', 'allowed_channels', 'DISCORD_ALLOWED_CHANNELS'),
  ids('discord', 'ignored_channels', 'DISCORD_IGNORED_CHANNELS'),
  flag('discord', 'auto_thread', 'groups', true, 'DISCORD_AUTO_THREAD'),
  flag('discord', 'thread_require_mention', 'groups', false, 'DISCORD_THREAD_REQUIRE_MENTION'),
  ids('discord', 'no_thread_channels', 'DISCORD_NO_THREAD_CHANNELS'),
  {
    key: 'allow_bots',
    section: 'groups',
    kind: 'select',
    fallback: 'none',
    choices: ['none', 'mentions', 'all'],
    yaml: platformKey('discord', 'allow_bots'),
    env: 'DISCORD_ALLOW_BOTS',
    fileFirst: true,
  },
  homeOption('discord', 'DISCORD_HOME_CHANNEL', DIGITS),
];

const SLACK_OPTIONS: readonly OptionSpec[] = [
  allowedOption('SLACK_ALLOWED_USERS', ENTRY),
  strangersOption('slack'),
  flag('slack', 'disable_dms', 'access', false, 'SLACK_DISABLE_DMS'),
  ...displayOptions('slack', 'off'),
  // Read from the adapter's `extra` only (no variable).
  flag('slack', 'reply_in_thread', 'replies', true),
  flag('slack', 'reply_broadcast', 'replies', false),
  flag('slack', 'reactions', 'replies', true, 'SLACK_REACTIONS'),
  flag('slack', 'require_mention', 'groups', true, 'SLACK_REQUIRE_MENTION'),
  flag('slack', 'thread_require_mention', 'groups', false, 'SLACK_THREAD_REQUIRE_MENTION'),
  flag('slack', 'strict_mention', 'groups', false, 'SLACK_STRICT_MENTION'),
  ids('slack', 'free_response_channels', 'SLACK_FREE_RESPONSE_CHANNELS'),
  ids('slack', 'allowed_channels', 'SLACK_ALLOWED_CHANNELS'),
  ids('slack', 'ignored_channels', 'SLACK_IGNORED_CHANNELS'),
  {
    key: 'allow_bots',
    section: 'groups',
    kind: 'select',
    fallback: 'none',
    choices: ['none', 'mentions', 'all'],
    yaml: platformKey('slack', 'allow_bots'),
    env: 'SLACK_ALLOW_BOTS',
    fileFirst: true,
  },
  homeOption('slack', 'SLACK_HOME_CHANNEL'),
];

const MATRIX_OPTIONS: readonly OptionSpec[] = [
  allowedOption('MATRIX_ALLOWED_USERS', ENTRY),
  strangersOption('matrix'),
  ...displayOptions('matrix', 'new'),
  flag('matrix', 'reactions', 'replies', true, 'MATRIX_REACTIONS'),
  flag('matrix', 'require_mention', 'groups', true, 'MATRIX_REQUIRE_MENTION'),
  ids('matrix', 'free_response_rooms', 'MATRIX_FREE_RESPONSE_ROOMS'),
  ids('matrix', 'allowed_rooms', 'MATRIX_ALLOWED_ROOMS'),
  flag('matrix', 'auto_thread', 'groups', true, 'MATRIX_AUTO_THREAD'),
  flag('matrix', 'dm_mention_threads', 'groups', false, 'MATRIX_DM_MENTION_THREADS'),
  homeOption('matrix', 'MATRIX_HOME_ROOM'),
  {
    key: 'e2ee_mode',
    section: 'advanced',
    kind: 'select',
    fallback: 'off',
    choices: ['off', 'optional', 'required'],
    yaml: platformKey('matrix', 'e2ee_mode'),
    env: 'MATRIX_E2EE_MODE',
    fileFirst: true,
  },
];

const MATTERMOST_OPTIONS: readonly OptionSpec[] = [
  allowedOption('MATTERMOST_ALLOWED_USERS', ENTRY),
  strangersOption('mattermost'),
  ...displayOptions('mattermost', 'new'),
  {
    key: 'reply_mode',
    section: 'replies',
    kind: 'select',
    fallback: 'off',
    choices: ['off', 'thread'],
    yaml: platformKey('mattermost', 'reply_mode'),
    env: 'MATTERMOST_REPLY_MODE',
    fileFirst: true,
  },
  flag('mattermost', 'require_mention', 'groups', true, 'MATTERMOST_REQUIRE_MENTION'),
  ids('mattermost', 'free_response_channels', 'MATTERMOST_FREE_RESPONSE_CHANNELS'),
  ids('mattermost', 'allowed_channels', 'MATTERMOST_ALLOWED_CHANNELS'),
  homeOption('mattermost', 'MATTERMOST_HOME_CHANNEL'),
];

const EMAIL_OPTIONS: readonly OptionSpec[] = [
  allowedOption('EMAIL_ALLOWED_USERS', EMAIL),
  // Hermes reads the opposite variable (`EMAIL_TRUST_FROM_HEADER`); the file's key is the clear one.
  flag('email', 'require_authenticated_sender', 'access', true),
  flag('email', 'skip_attachments', 'media', false),
  homeOption('email', 'EMAIL_HOME_ADDRESS', EMAIL),
  {
    key: 'poll_interval',
    section: 'advanced',
    kind: 'number',
    fallback: 15,
    min: 5,
    max: 3600,
    env: 'EMAIL_POLL_INTERVAL',
    envOnly: true,
  },
];

// ------------------------------------------------------------------ the catalog

const full = (
  spec: Omit<PlatformSpec, 'support' | 'login' | 'validates'> &
    Partial<Pick<PlatformSpec, 'login'>>,
): PlatformSpec => ({ support: 'full', login: 'credentials', validates: true, ...spec });

const generic = (
  spec: Pick<PlatformSpec, 'platform' | 'label' | 'credentials'> &
    Partial<Omit<PlatformSpec, 'platform' | 'label' | 'credentials'>>,
): PlatformSpec => ({
  support: 'generic',
  login: 'credentials',
  allowedUsers: null,
  validates: false,
  // The hub leaves strangers to Hermes's own default here: it does not know each one well enough.
  pairs: false,
  allowlist: false,
  exclusive: false,
  packages: 'none',
  inbound: false,
  docsUrl: null,
  settings: null,
  ...spec,
});

const allow = (key: string, item: RegExp = ENTRY) => ({ key, item });

export const PLATFORMS: readonly PlatformSpec[] = [
  // Telegram and WhatsApp link with flows of their own (`channels.ts`); listed so a client has
  // one place to learn every platform.
  full({
    platform: 'telegram',
    label: 'Telegram',
    login: 'token',
    credentials: [secret('TELEGRAM_BOT_TOKEN', true, /^\d+:[A-Za-z0-9_-]{30,}$/)],
    allowedUsers: allow('TELEGRAM_ALLOWED_USERS', DIGITS),
    pairs: true,
    allowlist: false,
    exclusive: true,
    packages: 'image',
    inbound: false,
    docsUrl: 'https://t.me/BotFather',
    settings: null, // `telegram-settings.ts`
  }),
  {
    platform: 'whatsapp',
    label: 'WhatsApp',
    support: 'full',
    login: 'qr',
    credentials: [],
    allowedUsers: null,
    validates: false,
    pairs: true,
    allowlist: false,
    exclusive: true,
    packages: 'image',
    inbound: false,
    docsUrl: null,
    settings: null,
  },
  full({
    platform: 'discord',
    label: 'Discord',
    credentials: [secret('DISCORD_BOT_TOKEN', true, /^[A-Za-z0-9._-]{50,100}$/)],
    allowedUsers: allow('DISCORD_ALLOWED_USERS'),
    pairs: false,
    allowlist: true,
    exclusive: true,
    packages: 'image',
    inbound: false,
    docsUrl: 'https://discord.com/developers/applications',
    settings: DISCORD_OPTIONS,
  }),
  full({
    platform: 'slack',
    label: 'Slack',
    credentials: [
      secret('SLACK_BOT_TOKEN', true, /^xoxb-[A-Za-z0-9-]{10,}$/),
      secret('SLACK_APP_TOKEN', true, /^xapp-[A-Za-z0-9-]{10,}$/),
    ],
    allowedUsers: allow('SLACK_ALLOWED_USERS'),
    pairs: true,
    allowlist: false,
    exclusive: true,
    packages: 'image',
    inbound: false,
    docsUrl: 'https://api.slack.com/apps',
    settings: SLACK_OPTIONS,
  }),
  full({
    platform: 'matrix',
    label: 'Matrix',
    credentials: [
      field('MATRIX_HOMESERVER', 'url', true, HTTP_URL),
      secret('MATRIX_ACCESS_TOKEN', true, /^\S{10,1000}$/),
    ],
    allowedUsers: allow('MATRIX_ALLOWED_USERS', /^@[^,\s:]{1,255}:[^,\s]{1,255}$/),
    pairs: true,
    allowlist: false,
    exclusive: false,
    packages: 'first_use',
    inbound: false,
    docsUrl: 'https://app.element.io',
    settings: MATRIX_OPTIONS,
  }),
  full({
    platform: 'mattermost',
    label: 'Mattermost',
    credentials: [
      field('MATTERMOST_URL', 'url', true, HTTP_URL),
      secret('MATTERMOST_TOKEN', true, /^[A-Za-z0-9]{10,100}$/),
    ],
    allowedUsers: allow('MATTERMOST_ALLOWED_USERS'),
    pairs: true,
    allowlist: false,
    exclusive: false,
    packages: 'none',
    inbound: false,
    docsUrl: null,
    settings: MATTERMOST_OPTIONS,
  }),
  full({
    platform: 'email',
    label: 'Email',
    credentials: [
      field('EMAIL_ADDRESS', 'email', true, EMAIL),
      secret('EMAIL_PASSWORD'),
      field('EMAIL_IMAP_HOST', 'host', true, HOST),
      field('EMAIL_IMAP_PORT', 'number', false, PORT),
      field('EMAIL_SMTP_HOST', 'host', true, HOST),
      field('EMAIL_SMTP_PORT', 'number', false, PORT),
    ],
    allowedUsers: allow('EMAIL_ALLOWED_USERS', EMAIL),
    pairs: false,
    allowlist: true,
    exclusive: false,
    packages: 'none',
    inbound: false,
    docsUrl: null,
    settings: EMAIL_OPTIONS,
  }),
  // ---- generic: a form of what Hermes reads, stored unchecked.
  generic({
    platform: 'signal',
    label: 'Signal',
    credentials: [field('SIGNAL_HTTP_URL', 'url', true, HTTP_URL), field('SIGNAL_ACCOUNT', 'text')],
    allowedUsers: allow('SIGNAL_ALLOWED_USERS'),
    exclusive: true,
  }),
  generic({
    platform: 'sms',
    label: 'SMS (Twilio)',
    credentials: [
      field('TWILIO_ACCOUNT_SID', 'text'),
      secret('TWILIO_AUTH_TOKEN'),
      field('TWILIO_PHONE_NUMBER', 'text'),
    ],
    allowedUsers: allow('SMS_ALLOWED_USERS'),
    inbound: true,
    docsUrl: 'https://console.twilio.com',
  }),
  generic({
    platform: 'feishu',
    label: 'Feishu / Lark',
    credentials: [
      field('FEISHU_APP_ID', 'text'),
      secret('FEISHU_APP_SECRET'),
      field('FEISHU_DOMAIN', 'text', false, /^(feishu|lark)$/),
    ],
    allowedUsers: allow('FEISHU_ALLOWED_USERS'),
    exclusive: true,
    packages: 'first_use',
  }),
  generic({
    platform: 'dingtalk',
    label: 'DingTalk',
    credentials: [field('DINGTALK_CLIENT_ID', 'text'), secret('DINGTALK_CLIENT_SECRET')],
    allowedUsers: allow('DINGTALK_ALLOWED_USERS'),
    packages: 'first_use',
  }),
  generic({
    platform: 'wecom',
    label: 'WeCom',
    credentials: [field('WECOM_BOT_ID', 'text'), secret('WECOM_SECRET')],
    allowedUsers: allow('WECOM_ALLOWED_USERS'),
  }),
  generic({
    platform: 'weixin',
    label: 'Weixin',
    credentials: [secret('WEIXIN_TOKEN'), field('WEIXIN_ACCOUNT_ID', 'text', false)],
    allowedUsers: allow('WEIXIN_ALLOWED_USERS'),
    exclusive: true,
  }),
  generic({
    platform: 'qqbot',
    label: 'QQ',
    credentials: [field('QQ_APP_ID', 'text'), secret('QQ_CLIENT_SECRET')],
    allowedUsers: allow('QQ_ALLOWED_USERS'),
  }),
  generic({
    platform: 'line',
    label: 'LINE',
    credentials: [
      secret('LINE_CHANNEL_ACCESS_TOKEN'),
      secret('LINE_CHANNEL_SECRET'),
      field('LINE_PUBLIC_URL', 'url', false, HTTP_URL),
    ],
    allowedUsers: allow('LINE_ALLOWED_USERS'),
    inbound: true,
    docsUrl: 'https://developers.line.biz/console/',
  }),
  generic({
    platform: 'google_chat',
    label: 'Google Chat',
    credentials: [
      secret('GOOGLE_CHAT_SERVICE_ACCOUNT_JSON'),
      field('GOOGLE_CHAT_PROJECT_ID', 'text', false),
      field('GOOGLE_CHAT_SUBSCRIPTION_NAME', 'text', false),
    ],
    allowedUsers: allow('GOOGLE_CHAT_ALLOWED_USERS', EMAIL),
    packages: 'first_use',
  }),
  generic({
    platform: 'teams',
    label: 'Microsoft Teams',
    credentials: [
      field('TEAMS_CLIENT_ID', 'text'),
      secret('TEAMS_CLIENT_SECRET'),
      field('TEAMS_TENANT_ID', 'text'),
    ],
    allowedUsers: allow('TEAMS_ALLOWED_USERS'),
    packages: 'first_use',
    inbound: true,
    docsUrl: 'https://dev.botframework.com',
  }),
  generic({
    platform: 'homeassistant',
    label: 'Home Assistant',
    credentials: [secret('HASS_TOKEN'), field('HASS_URL', 'url', false, HTTP_URL)],
  }),
  generic({
    platform: 'ntfy',
    label: 'ntfy',
    credentials: [
      field('NTFY_TOPIC', 'text'),
      field('NTFY_SERVER_URL', 'url', false, HTTP_URL),
      secret('NTFY_TOKEN', false),
    ],
    allowedUsers: allow('NTFY_ALLOWED_USERS'),
  }),
  generic({
    platform: 'irc',
    label: 'IRC',
    credentials: [
      field('IRC_SERVER', 'host', true, HOST),
      field('IRC_CHANNEL', 'text'),
      field('IRC_NICKNAME', 'text'),
      field('IRC_PORT', 'number', false, PORT),
      secret('IRC_NICKSERV_PASSWORD', false),
    ],
    allowedUsers: allow('IRC_ALLOWED_USERS'),
  }),
  generic({
    platform: 'bluebubbles',
    label: 'BlueBubbles (iMessage)',
    credentials: [
      field('BLUEBUBBLES_SERVER_URL', 'url', true, HTTP_URL),
      secret('BLUEBUBBLES_PASSWORD'),
    ],
    allowedUsers: allow('BLUEBUBBLES_ALLOWED_USERS'),
    inbound: true,
  }),
  generic({
    platform: 'whatsapp_cloud',
    label: 'WhatsApp Cloud API',
    credentials: [
      field('WHATSAPP_CLOUD_PHONE_NUMBER_ID', 'text'),
      secret('WHATSAPP_CLOUD_ACCESS_TOKEN'),
      secret('WHATSAPP_CLOUD_VERIFY_TOKEN', false),
      secret('WHATSAPP_CLOUD_APP_SECRET', false),
    ],
    allowedUsers: allow('WHATSAPP_CLOUD_ALLOWED_USERS'),
    inbound: true,
    docsUrl: 'https://developers.facebook.com/apps',
  }),
  generic({
    platform: 'simplex',
    label: 'SimpleX Chat',
    credentials: [field('SIMPLEX_WS_URL', 'url', true, /^wss?:\/\/\S+$/i)],
    allowedUsers: allow('SIMPLEX_ALLOWED_USERS'),
  }),
];

export function platformSpec(platform: string): PlatformSpec | null {
  return PLATFORMS.find((spec) => spec.platform === platform) ?? null;
}

/** Platforms linked here by their variables (`login: credentials`). */
export function credentialPlatform(platform: string): PlatformSpec | null {
  const spec = platformSpec(platform);
  return spec && spec.login === 'credentials' ? spec : null;
}

// ------------------------------------------------------------------ linked by credentials

/** What the platform said about the account when it was linked. */
export interface AccountIdentity {
  id: string | null;
  name: string | null;
  username: string | null;
}

export interface CredentialLink {
  linked: boolean;
  accountId: string | null;
  accountName: string | null;
  accountUsername: string | null;
}

/**
 * Where the hub keeps what the platform said about the account, beside Hermes's own per-platform
 * state. Not Hermes's file and not read by Hermes: it only lets the page name the account.
 */
function accountNote(home: string, platform: string): string {
  return path.join(home, 'platforms', platform, 'hub-account.json');
}

/**
 * The credentials the note belongs to, as a digest: a token somebody replaced by hand is never
 * named after the account it replaced (the note is used only while this matches).
 */
function fingerprint(spec: PlatformSpec, env: Record<string, string>): string {
  const material = spec.credentials
    .filter((credential) => credential.required)
    .map((credential) => `${credential.key}=${(env[credential.key] ?? '').trim()}`)
    .join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** Every required variable is in the profile's `.env`. */
export function credentialsPresent(spec: PlatformSpec, env: Record<string, string>): boolean {
  const required = spec.credentials.filter((credential) => credential.required);
  return (
    required.length > 0 && required.every((credential) => (env[credential.key] ?? '').trim() !== '')
  );
}

export function credentialLink(
  home: string,
  spec: PlatformSpec,
  env: Record<string, string> = readEnv(home),
): CredentialLink {
  if (!credentialsPresent(spec, env)) {
    return { linked: false, accountId: null, accountName: null, accountUsername: null };
  }
  let note: Partial<AccountIdentity & { fingerprint: string }> = {};
  try {
    const parsed = JSON.parse(
      readFileSync(accountNote(home, spec.platform), 'utf8'),
    ) as typeof note;
    if (parsed && parsed.fingerprint === fingerprint(spec, env)) note = parsed;
  } catch {
    // No note (linked by hand, or unchecked): linked, account unknown.
  }
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return {
    linked: true,
    accountId: text(note.id),
    accountName: text(note.name),
    accountUsername: text(note.username),
  };
}

/**
 * The input checked against the platform's declaration: every required variable given, every
 * given one of the right shape, nothing it does not declare. Returns the values to store (an
 * optional one left empty is `null`: removed).
 */
export function checkCredentials(
  spec: PlatformSpec,
  input: Record<string, unknown>,
): Record<string, string | null> {
  const known = new Map(spec.credentials.map((credential) => [credential.key, credential]));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new CredentialError(key, 'credential_unknown');
  }
  const out: Record<string, string | null> = {};
  for (const credential of spec.credentials) {
    const raw = input[credential.key];
    const value = typeof raw === 'string' ? raw.trim() : raw === undefined ? '' : null;
    if (value === null) throw new CredentialError(credential.key, 'credential_invalid');
    if (value === '') {
      if (credential.required) throw new CredentialError(credential.key, 'credential_missing');
      out[credential.key] = null;
      continue;
    }
    if (/[\r\n]/.test(value) && credential.kind !== 'secret') {
      throw new CredentialError(credential.key, 'credential_invalid');
    }
    if (credential.pattern && !credential.pattern.test(value)) {
      throw new CredentialError(credential.key, 'credential_invalid');
    }
    out[credential.key] = value;
  }
  return out;
}

export class CredentialError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'CredentialError';
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

function ensureNode(doc: Document, platform: string): void {
  if (!isMap(doc.getIn(['platforms'], true))) doc.setIn(['platforms'], doc.createNode({}));
  if (!isMap(doc.getIn(['platforms', platform], true))) {
    doc.setIn(['platforms', platform], doc.createNode({}));
  }
}

/**
 * Links `spec` in this profile: each variable into the profile's own `.env` (an optional one left
 * empty is removed), the allowlist beside them when given, the channel switched on — with pairing
 * for strangers where Hermes pairs, since Hermes would otherwise ignore them silently as soon as
 * an allowlist exists — and the account the platform named kept for the page.
 */
export function linkCredentials(
  home: string,
  spec: PlatformSpec,
  input: {
    values: Record<string, string | null>;
    allowedUsers?: readonly string[] | undefined;
    identity: AccountIdentity | null;
  },
): void {
  for (const [key, value] of Object.entries(input.values)) writeEnvValue(home, key, value);
  if (input.allowedUsers !== undefined && spec.allowedUsers) {
    writeEnvValue(
      home,
      spec.allowedUsers.key,
      input.allowedUsers.length > 0 ? input.allowedUsers.join(',') : null,
    );
  }
  const doc = load(home);
  ensureNode(doc, spec.platform);
  doc.setIn(['platforms', spec.platform, 'enabled'], true);
  if (spec.pairs) doc.setIn(['platforms', spec.platform, 'unauthorized_dm_behavior'], 'pair');
  save(home, doc);
  const note = accountNote(home, spec.platform);
  if (input.identity) {
    mkdirSync(path.dirname(note), { recursive: true });
    writeFileSync(
      note,
      `${JSON.stringify({ ...input.identity, fingerprint: fingerprint(spec, readEnv(home)) }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } else {
    rmSync(note, { force: true });
  }
}

/**
 * Forgets the account in this profile: every variable the platform declares out of `.env`, the
 * note deleted, the channel switched off. The allowlist and the settings stay, so linking again
 * is linking again.
 */
export function unlinkCredentials(home: string, spec: PlatformSpec): void {
  for (const credential of spec.credentials) writeEnvValue(home, credential.key, null);
  rmSync(accountNote(home, spec.platform), { force: true });
  const doc = load(home);
  ensureNode(doc, spec.platform);
  doc.setIn(['platforms', spec.platform, 'enabled'], false);
  save(home, doc);
}

/** The value that identifies the account, for the platforms one process may hold. */
export function identityValue(spec: PlatformSpec, env: Record<string, string>): string | null {
  const first = spec.credentials.find((credential) => credential.kind === 'secret');
  const value = first ? (env[first.key] ?? '').trim() : '';
  return value || null;
}
