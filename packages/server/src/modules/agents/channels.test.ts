/**
 * Channels are the other block of the same file. The tests are about what the file still
 * says afterwards, and about a credential that must not come back.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanReplyTitle,
  replyPrefixFor,
  whatsappReplyTitle,
  ChannelError,
  activeChannels,
  clearChannel,
  ensureWhatsAppBridgePort,
  getChannel,
  linkTelegram,
  listChannels,
  putChannel,
  readEnv,
  setWhatsAppMode,
  unlinkTelegram,
  unlinkWhatsApp,
  whatsappBridgePort,
  whatsappMode,
  withAllowedOwner,
  writeEnvValue,
} from './channels.js';
import { STORED } from './mcp.js';

const homes: string[] = [];
function home(config?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-channels-'));
  homes.push(dir);
  if (config !== undefined) writeFileSync(path.join(dir, 'config.yaml'), config, 'utf8');
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const read = (dir: string) => readFileSync(path.join(dir, 'config.yaml'), 'utf8');

const CONFIG = `# hermes
mcp_servers:
  studio-api:
    command: node

platforms:
  telegram:
    enabled: true
    token: 1234:secret-bot-token
    require_mention: false
    extra:
      allowed_chat_id: '9911'
      webhook_secret: hush
  webhook:
    enabled: true
    extra: '{}'
`;

describe('reading the block', () => {
  it('lists the platforms in the file, and says which are exclusive', () => {
    const channels = listChannels(home(CONFIG));
    expect(channels.map((c) => c.platform)).toEqual(['telegram', 'webhook']);
    // One identity, one place: Telegram will not let two things poll one bot token.
    expect(channels.find((c) => c.platform === 'telegram')?.exclusive).toBe(true);
    expect(channels.find((c) => c.platform === 'webhook')?.exclusive).toBe(false);
  });

  it('takes the fields from the file rather than from a form we wrote', () => {
    // Hermes's platform list grows; a form per platform would be wrong for the next one.
    const telegram = getChannel(home(CONFIG), 'telegram');
    expect(telegram?.fields.map((f) => f.key)).toEqual([
      'extra.allowed_chat_id',
      'extra.webhook_secret',
      'require_mention',
      'token',
    ]);
  });

  it('types a field by what it looks like', () => {
    const telegram = getChannel(home(CONFIG), 'telegram');
    const byKey = Object.fromEntries((telegram?.fields ?? []).map((f) => [f.key, f]));
    expect(byKey.token?.kind).toBe('secret');
    expect(byKey.require_mention?.kind).toBe('boolean');
    expect(byKey['extra.allowed_chat_id']?.kind).toBe('text');
  });

  it('never hands back a credential, including one nested in `extra`', () => {
    const telegram = getChannel(home(CONFIG), 'telegram');
    const byKey = Object.fromEntries((telegram?.fields ?? []).map((f) => [f.key, f]));
    expect(byKey.token?.value).toBe(STORED);
    expect(byKey['extra.webhook_secret']?.value).toBe(STORED);
    expect(byKey['extra.allowed_chat_id']?.value).toBe('9911');
  });

  it('does not call a platform configured when all it has is a switch', () => {
    // Saying it is configured is a lie the agent finds out at the worst moment.
    const dir = home('platforms:\n  discord:\n    enabled: true\n');
    expect(listChannels(dir)[0]?.configured).toBe(false);
  });

  it('says nothing when the file has no platforms at all', () => {
    expect(listChannels(home('mcp_servers: {}\n'))).toEqual([]);
    expect(listChannels(home())).toEqual([]);
  });

  it('refuses to touch a config it cannot parse', () => {
    expect(() => listChannels(home('platforms:\n  x: [oops\n'))).toThrow(ChannelError);
  });
});

describe('writing one back', () => {
  it('leaves the comment, the MCP block and the other platform alone', () => {
    const dir = home(CONFIG);
    putChannel(dir, 'telegram', { values: { require_mention: true } });
    const text = read(dir);
    expect(text).toContain('# hermes');
    expect(text).toContain('mcp_servers:');
    expect(text).toContain('webhook:');
    expect(text).toContain('require_mention: true');
  });

  it('does not write the mask into the file', () => {
    const dir = home(CONFIG);
    const telegram = getChannel(dir, 'telegram');
    const values = Object.fromEntries((telegram?.fields ?? []).map((f) => [f.key, f.value]));
    putChannel(dir, 'telegram', { values });
    expect(read(dir)).toContain('token: 1234:secret-bot-token');
    expect(read(dir)).toContain('webhook_secret: hush');
    expect(read(dir)).not.toContain(STORED);
  });

  it('takes a credential the person did retype', () => {
    const dir = home(CONFIG);
    putChannel(dir, 'telegram', { values: { token: '9999:new-token' } });
    expect(read(dir)).toContain('token: 9999:new-token');
  });

  it('turns one off without forgetting how to sign in', () => {
    const dir = home(CONFIG);
    const channel = putChannel(dir, 'telegram', { enabled: false });
    expect(channel.enabled).toBe(false);
    expect(read(dir)).toContain('token: 1234:secret-bot-token');
  });

  it('adds a platform the file did not have', () => {
    const dir = home(CONFIG);
    putChannel(dir, 'discord', { enabled: true, values: { bot_token: 'abc' } });
    expect(listChannels(dir).map((c) => c.platform)).toContain('discord');
  });

  it('writes into `extra` where the key came from, and leaves its quoting alone', () => {
    // Replacing the whole node would re-quote every value in it for no reason anybody
    // asked for.
    const dir = home(CONFIG);
    putChannel(dir, 'telegram', { values: { 'extra.allowed_chat_id': '7722' } });
    const text = read(dir);
    expect(text).toContain("allowed_chat_id: '7722'");
    expect(text).toContain('require_mention: false');
  });
});

describe('clearing one', () => {
  it('forgets the identity and keeps the settings', () => {
    // The other things a person tuned are not what they asked to clear.
    const dir = home(CONFIG);
    const channel = clearChannel(dir, 'telegram');
    expect(channel.enabled).toBe(false);
    const text = read(dir);
    expect(text).not.toContain('1234:secret-bot-token');
    expect(text).not.toContain('hush');
    expect(text).toContain('require_mention: false');
    expect(text).toContain("allowed_chat_id: '9911'");
  });

  it('says so when there is no such platform', () => {
    expect(() => clearChannel(home(CONFIG), 'ghost')).toThrow(/not_found/);
  });
});

/** What Hermes's own pairing leaves in a profile: the switch in `.env`, the phone in the session. */
function paired(
  dir: string,
  creds: unknown = { me: { id: '966500000000:7@s.whatsapp.net', name: 'مكتب' } },
) {
  writeFileSync(
    path.join(dir, '.env'),
    '# keys\nOPENAI_API_KEY=sk-x\nWHATSAPP_ENABLED=true\nWHATSAPP_MODE=bot\nWHATSAPP_DM_POLICY=pairing\n',
  );
  const session = path.join(dir, 'platforms', 'whatsapp', 'session');
  mkdirSync(session, { recursive: true });
  writeFileSync(path.join(session, 'creds.json'), JSON.stringify(creds));
}

describe('WhatsApp, whose identity is a session and not a field', () => {
  it('is listed as linked and on after Hermes paired it, with the account it knows', () => {
    // The owner's screenshot: "not configured", "0 fields", switched off — after a pairing
    // that had worked. Hermes wrote the switch to `.env` and the phone to the session folder.
    const dir = home('platforms:\n  whatsapp:\n    enabled: true\n');
    paired(dir);
    const whatsapp = getChannel(dir, 'whatsapp');
    expect(whatsapp).toMatchObject({
      enabled: true,
      configured: true,
      exclusive: true,
      link: {
        linked: true,
        accountId: '966500000000:7@s.whatsapp.net',
        accountName: 'مكتب',
        accountPhone: '966500000000',
      },
    });
    expect(activeChannels(dir)).toEqual(['whatsapp']);
  });

  it('is listed even when config.yaml never names it', () => {
    const dir = home('');
    paired(dir);
    expect(listChannels(dir).map((c) => [c.platform, c.enabled, c.configured])).toEqual([
      ['whatsapp', true, true],
    ]);
  });

  it("follows Hermes's rule for the switch: `.env` false wins, the file's false beats `.env` true", () => {
    const off = home('platforms:\n  whatsapp:\n    enabled: false\n');
    paired(off);
    expect(getChannel(off, 'whatsapp')?.enabled).toBe(false);
    const envOff = home('platforms:\n  whatsapp:\n    enabled: true\n');
    paired(envOff);
    writeEnvValue(envOff, 'WHATSAPP_ENABLED', 'false');
    expect(getChannel(envOff, 'whatsapp')?.enabled).toBe(false);
    // Switching it on from the page undoes the `.env` false too, or it would stay off.
    expect(putChannel(envOff, 'whatsapp', { enabled: true }).enabled).toBe(true);
    expect(readEnv(envOff).WHATSAPP_ENABLED).toBe('true');
  });

  it('is not linked without a session, and a gateway has nothing to serve then', () => {
    const dir = home('');
    writeFileSync(path.join(dir, '.env'), 'WHATSAPP_ENABLED=true\n');
    expect(getChannel(dir, 'whatsapp')).toMatchObject({
      enabled: true,
      configured: false,
      link: { linked: false, accountPhone: null },
    });
    expect(activeChannels(dir)).toEqual([]);
  });

  it('reads the older session folder while it still holds the session', () => {
    const dir = home('');
    const legacy = path.join(dir, 'whatsapp', 'session');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      path.join(legacy, 'creds.json'),
      JSON.stringify({ me: { id: '15551234567@s.whatsapp.net' } }),
    );
    expect(getChannel(dir, 'whatsapp')?.link).toMatchObject({
      linked: true,
      accountPhone: '15551234567',
    });
  });

  it('unlinks: the session is gone, the channel is off in both places, the rest is kept', () => {
    const dir = home('platforms:\n  whatsapp:\n    enabled: true\n    bridge_port: 3004\n');
    paired(dir);
    const after = unlinkWhatsApp(dir);
    expect(after).toMatchObject({ enabled: false, configured: false, link: { linked: false } });
    expect(existsSync(path.join(dir, 'platforms', 'whatsapp', 'session'))).toBe(false);
    expect(readEnv(dir)).toEqual({
      OPENAI_API_KEY: 'sk-x',
      WHATSAPP_MODE: 'bot',
      WHATSAPP_DM_POLICY: 'pairing',
    });
    expect(read(dir)).toContain('bridge_port: 3004');
    expect(activeChannels(dir)).toEqual([]);
  });
});

describe("WhatsApp's mode: a number for the agent, or the person's own", () => {
  it("reads Hermes's rule: as written, `self-chat` when nothing is, null for a word it does not know", () => {
    expect(whatsappMode({ WHATSAPP_MODE: 'bot' })).toBe('bot');
    expect(whatsappMode({ WHATSAPP_MODE: ' Self-Chat ' })).toBe('self-chat');
    expect(whatsappMode({})).toBe('self-chat');
    expect(whatsappMode({ WHATSAPP_MODE: 'personal' })).toBeNull();
  });

  it('is on the linked channel, and only there', () => {
    const dir = home('');
    paired(dir);
    expect(getChannel(dir, 'whatsapp')?.link?.mode).toBe('bot');
    const unlinked = home('');
    writeFileSync(path.join(unlinked, '.env'), 'WHATSAPP_ENABLED=true\nWHATSAPP_MODE=bot\n');
    expect(getChannel(unlinked, 'whatsapp')?.link?.mode).toBeNull();
  });

  it('puts the owner on the allowlist once, keeping everyone already there', () => {
    expect(withAllowedOwner(undefined, '966500000000')).toBe('966500000000');
    expect(withAllowedOwner('15551234567, 966522222222', '966500000000')).toBe(
      '15551234567,966522222222,966500000000',
    );
    expect(withAllowedOwner('+966500000000', '966500000000')).toBe('+966500000000');
    expect(withAllowedOwner('*', '966500000000')).toBe('*');
  });

  it('switches to self-chat with the owner allowed, and back to bot, the phone still linked', () => {
    const dir = home('platforms:\n  whatsapp:\n    enabled: true\n');
    paired(dir);
    writeEnvValue(dir, 'WHATSAPP_ALLOWED_USERS', '15551234567');
    const personal = setWhatsAppMode(dir, 'self-chat');
    expect(personal).toMatchObject({
      enabled: true,
      configured: true,
      link: { linked: true, mode: 'self-chat', accountPhone: '966500000000' },
    });
    expect(readEnv(dir)).toMatchObject({
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_MODE: 'self-chat',
      WHATSAPP_DM_POLICY: 'pairing',
      WHATSAPP_ALLOWED_USERS: '15551234567,966500000000',
      OPENAI_API_KEY: 'sk-x',
    });
    expect(setWhatsAppMode(dir, 'bot').link).toMatchObject({ linked: true, mode: 'bot' });
    expect(readEnv(dir).WHATSAPP_MODE).toBe('bot');
  });

  it('refuses a profile with no linked phone, and a mode Hermes does not have', () => {
    expect(() => setWhatsAppMode(home(''), 'self-chat')).toThrow(/channel_not_linked/);
    const dir = home('');
    paired(dir);
    expect(() => setWhatsAppMode(dir, 'personal' as 'bot')).toThrow(/channel_mode_invalid/);
    expect(readEnv(dir).WHATSAPP_MODE).toBe('bot');
  });
});

describe('Telegram, whose identity is a bot token', () => {
  const TOKEN = '7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
  const BOT = { id: '7012345678', username: 'office_helper_bot', name: 'Office' };

  it('is listed from a token in `.env` alone, on unless the file says `enabled: false`', () => {
    const dir = home('# keep me\n');
    writeEnvValue(dir, 'TELEGRAM_BOT_TOKEN', TOKEN);
    expect(getChannel(dir, 'telegram')).toMatchObject({
      enabled: true,
      configured: true,
      link: { linked: true, accountId: '7012345678', accountUsername: null },
    });
    writeFileSync(path.join(dir, 'config.yaml'), 'platforms:\n  telegram:\n    enabled: false\n');
    expect(getChannel(dir, 'telegram')?.enabled).toBe(false);
    expect(activeChannels(dir)).toEqual([]);
  });

  it('links: the token in `.env` only, the switch and pairing in the file, comments kept', () => {
    const dir = home(
      '# hermes\nplatforms:\n  telegram:\n    token: 1:old\n    require_mention: true\n',
    );
    const channel = linkTelegram(dir, { token: TOKEN, bot: BOT, allowedUsers: ['1', '2'] });
    expect(channel).toMatchObject({
      enabled: true,
      configured: true,
      link: { accountName: 'Office', accountUsername: 'office_helper_bot' },
    });
    expect(readEnv(dir)).toMatchObject({
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_ALLOWED_USERS: '1,2',
    });
    const text = read(dir);
    expect(text).toContain('# hermes');
    expect(text).toContain('require_mention: true');
    expect(text).toContain('unauthorized_dm_behavior: pair');
    expect(text).not.toContain('1:old');
    expect(activeChannels(dir)).toEqual(['telegram']);
  });

  it('does not name a bot the token no longer belongs to', () => {
    const dir = home();
    linkTelegram(dir, { token: TOKEN, bot: BOT });
    writeEnvValue(dir, 'TELEGRAM_BOT_TOKEN', '7099999999:AAFfffffffffffffffffffffffffffffffffff');
    expect(getChannel(dir, 'telegram')?.link).toMatchObject({
      accountId: '7099999999',
      accountUsername: null,
      accountName: null,
    });
  });

  it('unlinks: the token and the note are gone, the channel is off, the allowlist stays', () => {
    const dir = home();
    linkTelegram(dir, { token: TOKEN, bot: BOT, allowedUsers: ['1'] });
    const channel = unlinkTelegram(dir);
    expect(channel).toMatchObject({ enabled: false, configured: false, link: { linked: false } });
    expect(readEnv(dir).TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(readEnv(dir).TELEGRAM_ALLOWED_USERS).toBe('1');
    expect(existsSync(path.join(dir, 'platforms', 'telegram', 'hub-bot.json'))).toBe(false);
  });
});

describe('the WhatsApp bridge port', () => {
  it("is Hermes's 3000 until a profile says otherwise", () => {
    expect(whatsappBridgePort(home(''))).toBe(3000);
    expect(
      whatsappBridgePort(home('platforms:\n  whatsapp:\n    extra:\n      bridge_port: 3100\n')),
    ).toBe(3100);
  });

  it('is handed out once per profile, never one another profile has', () => {
    const root = home('');
    const a = home('');
    const b = home('platforms:\n  whatsapp:\n    bridge_port: 3001\n');
    expect(ensureWhatsAppBridgePort(a, [root, b])).toBe(3002);
    expect(read(a)).toContain('bridge_port: 3002');
    // Kept on the next start.
    expect(ensureWhatsAppBridgePort(a, [root, b])).toBe(3002);
    // One set by hand is kept while nobody else has it.
    expect(ensureWhatsAppBridgePort(b, [root, a])).toBe(3001);
  });
});

describe('the profile .env', () => {
  it('changes one variable and leaves every other line as it was', () => {
    const dir = home('');
    writeFileSync(path.join(dir, '.env'), '# mine\nexport A=1\nB="two words"\n');
    writeEnvValue(dir, 'C', '3');
    writeEnvValue(dir, 'A', null);
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe('# mine\nB="two words"\nC=3\n');
    expect(readEnv(dir)).toEqual({ B: 'two words', C: '3' });
  });
});

describe("WhatsApp's reply header", () => {
  it('is written in Hermes’s shape and read back as its title', () => {
    expect(replyPrefixFor('سارة')).toBe('*سارة*\\n────────────\\n');
    expect(whatsappReplyTitle({ WHATSAPP_REPLY_PREFIX: replyPrefixFor('Office bot') })).toBe(
      'Office bot',
    );
  });

  it('reads nothing written, and an empty value, as Hermes’s own header', () => {
    expect(whatsappReplyTitle({})).toBeNull();
    // Hermes's adapter drops an empty value before its bridge starts: the bridge's header shows.
    expect(whatsappReplyTitle({ WHATSAPP_REPLY_PREFIX: '' })).toBeNull();
    expect(whatsappReplyTitle({ WHATSAPP_REPLY_PREFIX: '\\n' })).toBeNull();
  });

  it('reads a prefix written by hand as its text on one line', () => {
    expect(whatsappReplyTitle({ WHATSAPP_REPLY_PREFIX: '🤖 Office:\\n' })).toBe('🤖 Office:');
  });

  it('takes one trimmed line of at most 64 characters', () => {
    expect(cleanReplyTitle('  a \n b ')).toBe('a b');
    expect(cleanReplyTitle('   ')).toBeNull();
    expect(cleanReplyTitle('x'.repeat(64))).toHaveLength(64);
    expect(cleanReplyTitle('x'.repeat(65))).toBeNull();
  });
});
